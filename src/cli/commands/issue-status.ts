import type { Command } from "commander";
import chalk from "chalk";
import { execSync } from "node:child_process";
import { StateStore, type Task } from "../../state/store.js";
import { loadConfig, type OrchestratorConfig } from "../../config/schema.js";
import { findExistingPRsForIssue, type LinkedPR } from "../../triggers/github.js";

/**
 * A similar open issue found via keyword overlap matching.
 */
export interface SimilarIssue {
  number: number;
  title: string;
  url: string;
  /** Keyword overlap score in range [0, 1] */
  overlapScore: number;
}

/**
 * Result of `orch issue status <N>` — a consolidated view of a GitHub issue's
 * dispatch state, linked PRs, and task history.
 *
 * Designed for both CLI rendering and Telegram display.
 */
export interface IssueStatusResult {
  repo: string;
  issueNumber: number;
  /** GitHub issue state: "open" or "closed" */
  issueState: "open" | "closed" | "unknown";
  issueTitle: string | null;
  /** Open or merged PRs that reference this issue */
  linkedPRs: LinkedPR[];
  /** All top-level tasks dispatched for this issue, most recent first */
  tasks: Array<{
    id: string;
    status: string;
    agent: string | null;
    title: string;
    verificationStatus: string | null;
    qualityScore: number | null;
    retryCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
  /** Summary line for quick display */
  summary: string;
  /** Other open issues that share >60% keyword overlap — potential duplicates */
  similarIssues: SimilarIssue[];
}

/**
 * Fetch the full issue status by querying GitHub and the local state DB.
 *
 * Exported so it can be reused from the Telegram handler without going
 * through the CLI.
 */
export async function getIssueStatus(
  repo: string,
  issueNumber: number,
  store: StateStore,
): Promise<IssueStatusResult> {
  // 1. Fetch issue state from GitHub (title + body for overlap detection)
  let issueState: "open" | "closed" | "unknown" = "unknown";
  let issueTitle: string | null = null;
  let issueBody: string | null = null;
  try {
    const raw = execSync(
      `gh issue view ${issueNumber} --repo ${repo} --json state,title,body`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const parsed = JSON.parse(raw.trim()) as { state: string; title: string; body: string };
    issueState = parsed.state.toLowerCase() === "open" ? "open" : "closed";
    issueTitle = parsed.title;
    issueBody = parsed.body ?? null;
  } catch {
    // If gh fails, continue with unknown state
  }

  // 2. Find linked PRs (open + recently merged)
  const linkedPRs = findExistingPRsForIssue(repo, issueNumber);

  // 3. Query state DB for all tasks dispatched for this issue
  const sourceRef = `${repo}#${issueNumber}`;
  const allTasks = store.findAllTasksBySourceRef(sourceRef);

  const tasks = allTasks.map((t: Task) => ({
    id: t.id,
    status: t.status,
    agent: t.agent_name,
    title: t.title,
    verificationStatus: t.verification_status,
    qualityScore: t.quality_score,
    retryCount: t.retry_count,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  }));

  // 4. Find similar open issues via keyword overlap (only when issue is open)
  const similarIssues: SimilarIssue[] =
    issueState === "open"
      ? findSimilarIssues(repo, issueNumber, issueTitle ?? "", issueBody ?? "")
      : [];

  // 5. Build summary line
  const summary = buildSummaryLine(issueState, issueTitle, linkedPRs, allTasks);

  return {
    repo,
    issueNumber,
    issueState,
    issueTitle,
    linkedPRs,
    tasks,
    summary,
    similarIssues,
  };
}

// ---------------------------------------------------------------------------
// Keyword overlap / similar issue detection
// ---------------------------------------------------------------------------

/**
 * Common English stop words to exclude from keyword matching.
 * Keeping this list tight to avoid stripping domain-relevant words.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "should", "could", "may", "might", "shall", "can", "it", "its", "this",
  "that", "these", "those", "i", "we", "you", "he", "she", "they", "not",
  "as", "if", "so", "than", "then", "when", "where", "how", "what", "which",
  "who", "all", "each", "more", "also", "into", "up", "out", "about",
]);

/**
 * Tokenise text into a set of meaningful keywords.
 * Lowercases, strips punctuation, and removes stop words + short tokens.
 */
function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w)),
  );
}

/**
 * Compute Jaccard similarity between two keyword sets.
 * Returns a value in [0, 1].
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fetch other open issues from GitHub and return any that share >60% keyword
 * overlap with the given issue (title + body combined).
 *
 * Exported for testing.
 */
export function findSimilarIssues(
  repo: string,
  targetIssueNumber: number,
  targetTitle: string,
  targetBody: string,
  overlapThreshold = 0.6,
): SimilarIssue[] {
  const targetTokens = tokenise(`${targetTitle} ${targetBody}`);
  if (targetTokens.size === 0) return [];

  let openIssues: Array<{ number: number; title: string; body: string }> = [];
  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --state open --json number,title,body --limit 200`,
      { encoding: "utf-8", timeout: 20000 },
    );
    openIssues = JSON.parse(raw.trim()) as typeof openIssues;
  } catch {
    // If gh fails, skip similar-issue detection silently
    return [];
  }

  const similar: SimilarIssue[] = [];
  for (const issue of openIssues) {
    if (issue.number === targetIssueNumber) continue;
    const candidateTokens = tokenise(`${issue.title} ${issue.body ?? ""}`);
    const score = jaccardSimilarity(targetTokens, candidateTokens);
    if (score >= overlapThreshold) {
      similar.push({
        number: issue.number,
        title: issue.title,
        url: `https://github.com/${repo}/issues/${issue.number}`,
        overlapScore: score,
      });
    }
  }

  // Sort by overlap score descending
  similar.sort((a, b) => b.overlapScore - a.overlapScore);
  return similar;
}

function buildSummaryLine(
  issueState: string,
  issueTitle: string | null,
  linkedPRs: LinkedPR[],
  tasks: Task[],
): string {
  const parts: string[] = [];

  if (issueState === "closed") {
    parts.push("Issue is CLOSED");
  } else if (issueState === "open") {
    parts.push("Issue is OPEN");
  } else {
    parts.push("Issue state unknown");
  }

  const openPRs = linkedPRs.filter((pr) => pr.state === "open");
  const mergedPRs = linkedPRs.filter((pr) => pr.state === "merged");
  if (openPRs.length > 0) {
    parts.push(`has open PR #${openPRs.map((p) => p.number).join(", #")}`);
  }
  if (mergedPRs.length > 0) {
    parts.push(`has merged PR #${mergedPRs.map((p) => p.number).join(", #")}`);
  }

  const activeTasks = tasks.filter((t) =>
    ["pending", "planning", "dispatched", "in_progress"].includes(t.status),
  );
  if (activeTasks.length > 0) {
    parts.push(`${activeTasks.length} active task(s)`);
  }

  if (tasks.length === 0 && linkedPRs.length === 0) {
    parts.push("never dispatched");
  }

  return parts.join(" · ");
}

/**
 * Format the issue status result for CLI (human-readable, coloured output).
 */
function printIssueStatus(result: IssueStatusResult): void {
  const stateColor =
    result.issueState === "open"
      ? chalk.green
      : result.issueState === "closed"
        ? chalk.red
        : chalk.yellow;

  console.log(
    chalk.bold(
      `\n  Issue #${result.issueNumber} on ${chalk.cyan(result.repo)}`,
    ),
  );
  if (result.issueTitle) {
    console.log(`  ${chalk.dim(result.issueTitle)}`);
  }
  console.log(`  State: ${stateColor(result.issueState.toUpperCase())}\n`);

  // Linked PRs
  if (result.linkedPRs.length > 0) {
    console.log(chalk.bold("  Linked PRs:"));
    for (const pr of result.linkedPRs) {
      const stateIcon =
        pr.state === "open"
          ? pr.isDraft
            ? chalk.yellow("📝 draft")
            : chalk.green("🟢 open")
          : chalk.magenta("✅ merged");
      console.log(
        `    #${pr.number} ${stateIcon}  ${pr.title.slice(0, 60)}`,
      );
      console.log(`    ${chalk.dim(pr.url)}`);
    }
    console.log();
  } else {
    console.log(chalk.dim("  No linked PRs found.\n"));
  }

  // Task history
  if (result.tasks.length > 0) {
    console.log(chalk.bold("  Task history:"));
    for (const task of result.tasks) {
      const statusColor: Record<string, (s: string) => string> = {
        pending: chalk.yellow,
        planning: chalk.magenta,
        dispatched: chalk.blue,
        in_progress: chalk.cyan,
        done: chalk.green,
        failed: chalk.red,
        escalated: chalk.red,
      };
      const colorFn = statusColor[task.status] ?? chalk.white;
      const verif =
        task.verificationStatus === "approved"
          ? chalk.green(" ✓ approved")
          : task.verificationStatus === "rejected"
            ? chalk.red(" ✗ rejected")
            : "";
      const score =
        task.qualityScore !== null
          ? chalk.dim(` (score: ${task.qualityScore.toFixed(2)})`)
          : "";
      const retry = task.retryCount > 0 ? chalk.yellow(` retry×${task.retryCount}`) : "";
      const agent = task.agent ? chalk.dim(` → ${task.agent}`) : "";
      const age = formatAge(task.createdAt);

      console.log(
        `    ${chalk.dim(task.id.slice(0, 10))}  ${colorFn(task.status.padEnd(12))}${agent}${verif}${score}${retry}  ${chalk.dim(age)}`,
      );
      console.log(`    ${chalk.dim(task.title.slice(0, 70))}`);
    }
    console.log();
  } else {
    console.log(chalk.dim("  No tasks dispatched for this issue.\n"));
  }

  // Similar open issues warning
  if (result.similarIssues.length > 0) {
    console.log(
      chalk.bold.yellow(
        `  ⚠️  Similar open issues (potential duplicates):`,
      ),
    );
    for (const sim of result.similarIssues) {
      const pct = Math.round(sim.overlapScore * 100);
      console.log(
        `    #${sim.number}  ${chalk.yellow(`${pct}% overlap`)}  ${sim.title.slice(0, 60)}`,
      );
      console.log(`    ${chalk.dim(sim.url)}`);
    }
    console.log();
  }

  // Summary
  console.log(`  ${chalk.bold("Summary:")} ${result.summary}\n`);
}

/**
 * Format an ISO timestamp as a human-readable relative time.
 */
function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

/**
 * Format the issue status result for Telegram (plain text with emoji).
 */
export function formatIssueStatusTelegram(result: IssueStatusResult): string {
  const stateIcon = result.issueState === "open" ? "🟢" : result.issueState === "closed" ? "🔴" : "❓";
  const lines: string[] = [];

  lines.push(`${stateIcon} *Issue #${result.issueNumber}* (${result.issueState})`);
  if (result.issueTitle) {
    lines.push(result.issueTitle);
  }
  lines.push("");

  if (result.linkedPRs.length > 0) {
    lines.push("*PRs:*");
    for (const pr of result.linkedPRs) {
      const icon = pr.state === "open" ? (pr.isDraft ? "📝" : "🟢") : "✅";
      lines.push(`  ${icon} #${pr.number} ${pr.title.slice(0, 50)}`);
    }
    lines.push("");
  }

  if (result.tasks.length > 0) {
    lines.push(`*Tasks:* (${result.tasks.length} total)`);
    // Show last 5 tasks
    for (const task of result.tasks.slice(0, 5)) {
      const icon =
        task.status === "done" ? "✅" :
        task.status === "failed" ? "❌" :
        task.status === "escalated" ? "🚨" :
        ["pending", "planning", "dispatched", "in_progress"].includes(task.status) ? "🔵" : "⚪";
      const agent = task.agent ? ` → ${task.agent.replace("claude-", "")}` : "";
      lines.push(`  ${icon} ${task.status}${agent} (${formatAge(task.createdAt)})`);
    }
    if (result.tasks.length > 5) {
      lines.push(`  ... and ${result.tasks.length - 5} more`);
    }
    lines.push("");
  }

  if (result.similarIssues.length > 0) {
    lines.push("⚠️ *Similar open issues (potential duplicates):*");
    for (const sim of result.similarIssues) {
      const pct = Math.round(sim.overlapScore * 100);
      lines.push(`  • #${sim.number} (${pct}% overlap) ${sim.title.slice(0, 50)}`);
      lines.push(`    ${sim.url}`);
    }
    lines.push("");
  }

  lines.push(result.summary);
  return lines.join("\n");
}

/**
 * Resolve which repo to query for a given issue number.
 *
 * If --repo is provided, use it directly. Otherwise, try each repo in the
 * config until we find one where the issue exists.
 */
async function resolveRepo(
  issueNumber: number,
  explicitRepo: string | undefined,
  config: OrchestratorConfig | undefined,
): Promise<string | null> {
  if (explicitRepo) return explicitRepo;

  if (!config) return null;

  // Try each unique repo from config
  const repos = [
    ...new Set(
      Object.values(config.agents)
        .map((a) => a.github)
        .filter(Boolean),
    ),
  ] as string[];

  for (const repo of repos) {
    try {
      const raw = execSync(
        `gh issue view ${issueNumber} --repo ${repo} --json number -q .number`,
        { encoding: "utf-8", timeout: 10000 },
      );
      if (raw.trim() === String(issueNumber)) return repo;
    } catch {
      // Issue not found in this repo, try next
    }
  }

  return null;
}

/**
 * Register `orch issue status <N>` command.
 */
export function registerIssueStatusCommand(program: Command): void {
  const issueCmd = program
    .command("issue")
    .description("GitHub issue inspection commands");

  issueCmd
    .command("status")
    .description(
      "Pre-dispatch inspection: show issue state, linked PRs, and task history",
    )
    .argument("<number>", "GitHub issue number")
    .option(
      "--repo <owner/repo>",
      "GitHub repository (auto-detected from config if omitted)",
    )
    .option("--json", "Output raw JSON instead of the human-readable report")
    .action(
      async (
        numberArg: string,
        opts: { repo?: string; json?: boolean },
      ) => {
        const issueNumber = parseInt(numberArg, 10);
        if (isNaN(issueNumber) || issueNumber <= 0) {
          console.error(chalk.red("Error: issue number must be a positive integer."));
          process.exit(2);
        }

        let config: OrchestratorConfig | undefined;
        try {
          config = loadConfig(program.opts().config);
        } catch {
          // Config optional — needed only for repo auto-detection
        }

        const repo = await resolveRepo(issueNumber, opts.repo, config);
        if (!repo) {
          console.error(
            chalk.red(
              `Error: could not determine repo for issue #${issueNumber}. Use --repo <owner/repo>.`,
            ),
          );
          process.exit(2);
        }

        const store = new StateStore();
        try {
          const result = await getIssueStatus(repo, issueNumber, store);

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            printIssueStatus(result);
          }
        } finally {
          store.close();
        }
      },
    );
}
