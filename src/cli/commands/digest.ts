import type { Command } from "commander";
import { execSync } from "node:child_process";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { loadConfig } from "../../config/schema.js";
import { formatScore, formatPct, colorFailPct } from "./metrics.js";

/** Parse a duration string like "7d" or "30d" into days. Returns null on invalid input. */
function parseDays(str: string): number | null {
  const m = /^(\d+)d$/.exec(str.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 0 ? n : null;
}

/** Fetch merged PR count for a repo in the last N days using `gh pr list`. */
function fetchMergedPRCount(repo: string, days: number): number {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // gh pr list only supports --search which allows date filtering
    const output = execSync(
      `gh pr list --repo ${repo} --state merged --limit 200 --json number,mergedAt --jq '[.[] | select(.mergedAt >= "${since}")] | length'`,
      { timeout: 8000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    const n = parseInt(output, 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

/** Fetch top recently-closed GitHub issues (by title) for a repo in the last N days. */
function fetchTopClosedIssues(repo: string, days: number, limit = 3): Array<{ number: number; title: string }> {
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const output = execSync(
      `gh issue list --repo ${repo} --state closed --limit 50 --json number,title,closedAt --jq '[.[] | select(.closedAt >= "${since}")] | sort_by(.closedAt) | reverse | .[:${limit}] | .[] | [.number, .title] | @tsv'`,
      { timeout: 8000, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return null;
      const number = parseInt(line.slice(0, tab), 10);
      const title = line.slice(tab + 1).trim();
      return isNaN(number) ? null : { number, title };
    }).filter((x): x is { number: number; title: string } => x !== null);
  } catch {
    return [];
  }
}

interface DigestRow {
  agentName: string;
  repo: string;
  tasksCompleted: number;
  tasksFailed: number;
  tasksTotal: number;
  mergedPRs: number;
  avgQualityScore: number | null;
  revisionRate: number | null;
  failPct: number | null;
}

interface DigestOutput {
  window_days: number;
  generated_at: string;
  fleet: {
    total_tasks_completed: number;
    total_tasks_failed: number;
    total_merged_prs: number;
    avg_quality_score: number | null;
    avg_revision_rate: number | null;
  };
  agents: Array<{
    agent: string;
    repo: string;
    tasks_completed: number;
    tasks_failed: number;
    tasks_total: number;
    merged_prs: number;
    avg_quality_score: number | null;
    revision_rate: number | null;
    fail_pct: number | null;
  }>;
  top_issues: Array<{
    repo: string;
    number: number;
    title: string;
  }>;
}

export function registerDigestCommand(program: Command): void {
  program
    .command("digest")
    .description("Fleet activity summary: tasks shipped, PRs merged, quality scores, and top issues closed")
    .option("--last <window>", "Time window: e.g. 7d (default) or 30d", "7d")
    .option("--json", "Output raw JSON instead of a formatted table")
    .action((opts: { last: string; json?: boolean }) => {
      const days = parseDays(opts.last);
      if (days === null) {
        console.error(chalk.red(`Error: --last must be a duration like "7d" or "30d", got: ${opts.last}`));
        process.exit(1);
      }

      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(program.opts().config);
      } catch (err) {
        console.error(chalk.red("Could not load config:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(chalk.red("Could not open state database:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      let windowedMetrics: ReturnType<typeof store.getWindowedAgentMetrics>;
      let healthSummaries: ReturnType<typeof store.getAgentHealthSummary>;
      try {
        windowedMetrics = store.getWindowedAgentMetrics(days);
        healthSummaries = store.getAgentHealthSummary();
      } finally {
        store.close();
      }

      // Build a map of agent → repo from config
      const agentRepos = new Map<string, string>();
      for (const [name, agent] of Object.entries(config.agents)) {
        if (agent.github) agentRepos.set(name, agent.github);
      }

      // Build a map of agent → revision_rate from health summaries
      const revisionRates = new Map<string, number | null>();
      for (const h of healthSummaries) {
        revisionRates.set(h.agent_name, h.revision_rate);
      }

      // Merge windowed metrics with repo info — limit to known agents in config
      const agentNames = new Set(Object.keys(config.agents));
      const rows: DigestRow[] = windowedMetrics
        .filter((m) => agentNames.has(m.agent_name))
        .map((m) => ({
          agentName: m.agent_name,
          repo: agentRepos.get(m.agent_name) ?? "",
          tasksCompleted: m.done,
          tasksFailed: m.failed,
          tasksTotal: m.total,
          mergedPRs: 0, // filled below
          avgQualityScore: m.avg_quality_score,
          revisionRate: revisionRates.get(m.agent_name) ?? null,
          failPct: m.fail_pct,
        }));

      // Fetch merged PR counts in parallel (sync but fast: 1 gh call per agent)
      const topIssuesByRepo: Array<{ repo: string; number: number; title: string }> = [];

      for (const row of rows) {
        if (row.repo) {
          row.mergedPRs = fetchMergedPRCount(row.repo, days);
        }
      }

      // Fetch top closed issues for all repos (up to 3 per agent, deduplicated)
      const seenIssues = new Set<string>();
      for (const row of rows) {
        if (!row.repo) continue;
        const issues = fetchTopClosedIssues(row.repo, days, 3);
        for (const issue of issues) {
          const key = `${row.repo}#${issue.number}`;
          if (!seenIssues.has(key)) {
            seenIssues.add(key);
            topIssuesByRepo.push({ repo: row.repo, ...issue });
          }
        }
      }
      // Limit to top 3 overall (first 3 from sorted by repo order)
      const topIssues = topIssuesByRepo.slice(0, 3);

      // Fleet totals
      const totalDone = rows.reduce((s, r) => s + r.tasksCompleted, 0);
      const totalFailed = rows.reduce((s, r) => s + r.tasksFailed, 0);
      const totalMerged = rows.reduce((s, r) => s + r.mergedPRs, 0);
      const qualityScores = rows.map((r) => r.avgQualityScore).filter((s): s is number => s !== null);
      const avgQuality = qualityScores.length > 0
        ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
        : null;
      const revRates = rows.map((r) => r.revisionRate).filter((r): r is number => r !== null);
      const avgRevision = revRates.length > 0
        ? revRates.reduce((a, b) => a + b, 0) / revRates.length
        : null;

      if (opts.json) {
        const output: DigestOutput = {
          window_days: days,
          generated_at: new Date().toISOString(),
          fleet: {
            total_tasks_completed: totalDone,
            total_tasks_failed: totalFailed,
            total_merged_prs: totalMerged,
            avg_quality_score: avgQuality,
            avg_revision_rate: avgRevision,
          },
          agents: rows.map((r) => ({
            agent: r.agentName,
            repo: r.repo,
            tasks_completed: r.tasksCompleted,
            tasks_failed: r.tasksFailed,
            tasks_total: r.tasksTotal,
            merged_prs: r.mergedPRs,
            avg_quality_score: r.avgQualityScore,
            revision_rate: r.revisionRate,
            fail_pct: r.failPct,
          })),
          top_issues: topIssues,
        };
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // ── Human-readable output ─────────────────────────────────────────────

      const label = days === 1 ? "last 24 hours" : `last ${days} days`;
      console.log(chalk.bold(`\n● Fleet Digest — ${label}\n`));

      // Fleet-wide summary line
      console.log(
        `  ${chalk.bold(String(totalDone))} tasks completed  ·  ` +
        `${chalk.bold(String(totalMerged))} PRs merged  ·  ` +
        `${totalFailed > 0 ? chalk.red(String(totalFailed) + " failed") : chalk.green("0 failed")}  ·  ` +
        `quality ${formatScore(avgQuality)}` +
        (avgRevision !== null ? `  ·  revision rate ${formatPct(avgRevision * 100)}` : ""),
      );
      console.log();

      if (rows.length === 0) {
        console.log(chalk.dim("  No agent activity in this window."));
        console.log();
        return;
      }

      // Per-agent table
      const COL = {
        agent:    32,
        done:      5,
        prs:       4,
        failPct:   7,
        revRate:   8,
        quality:   9,
      };

      const header = [
        "Agent".padEnd(COL.agent),
        "Done".padStart(COL.done),
        "PRs".padStart(COL.prs),
        "Fail%".padStart(COL.failPct),
        "RevRate".padStart(COL.revRate),
        "Quality".padStart(COL.quality),
      ].join("  ");

      const separator = "─".repeat(header.length);
      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + separator));

      for (const row of rows) {
        const line = [
          chalk.cyan(row.agentName.padEnd(COL.agent)),
          chalk.green(String(row.tasksCompleted).padStart(COL.done)),
          (row.mergedPRs > 0 ? chalk.green(String(row.mergedPRs)) : chalk.dim("0")).padStart(COL.prs),
          colorFailPct(row.failPct).padStart(COL.failPct),
          formatPct(row.revisionRate !== null ? row.revisionRate * 100 : null).padStart(COL.revRate),
          formatScore(row.avgQualityScore).padStart(COL.quality),
        ].join("  ");
        console.log("  " + line);
      }

      // Footer totals
      const totalAll = rows.reduce((s, r) => s + r.tasksTotal, 0);
      const globalFailPct = totalAll > 0 ? (totalFailed / totalAll) * 100 : null;
      console.log(chalk.dim("  " + separator));
      const footer = [
        chalk.bold("All agents").padEnd(COL.agent),
        chalk.bold(chalk.green(String(totalDone))).padStart(COL.done),
        chalk.bold(String(totalMerged)).padStart(COL.prs),
        colorFailPct(globalFailPct).padStart(COL.failPct),
        formatPct(avgRevision !== null ? avgRevision * 100 : null).padStart(COL.revRate),
        formatScore(avgQuality).padStart(COL.quality),
      ].join("  ");
      console.log("  " + footer);

      // Top issues closed
      if (topIssues.length > 0) {
        console.log();
        console.log(chalk.bold("  Top issues closed:"));
        for (const issue of topIssues) {
          const repoShort = issue.repo.split("/")[1] ?? issue.repo;
          const titleTrunc = issue.title.length > 60 ? issue.title.slice(0, 59) + "…" : issue.title;
          console.log(
            `    ${chalk.cyan(`#${issue.number}`)}  ${titleTrunc}  ${chalk.dim(`(${repoShort})`)}`,
          );
        }
      }

      console.log();
      console.log(chalk.dim(`  Run \`orch digest --last 30d\` for a wider window, or \`--json\` for machine-readable output.`));
      console.log();
    });
}
