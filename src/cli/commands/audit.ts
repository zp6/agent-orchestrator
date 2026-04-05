/**
 * `orch audit` — issue-to-PR traceability gap report.
 *
 * Surfaces three gap classes across all configured agent repos:
 *   1. Orphan issues  — open issues with no linked branch or PR, age > N days
 *   2. Zombie issues  — merged PRs whose source issues are still open
 *   3. Unlinked PRs   — open PRs missing a "Closes #N" reference
 *
 * Each item includes a one-line suggested fix.
 *
 * Exit codes:
 *   0 — no gaps found (clean)
 *   1 — one or more gaps found
 *   2 — usage or config error
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import {
  auditAll,
  type AuditResult,
  type AuditGap,
  type AuditRepoResult,
} from "../../orchestrator/auditor.js";

export function registerAuditCommand(program: Command): void {
  program
    .command("audit")
    .description(
      "Issue-to-PR traceability gap report: orphan issues, zombie issues, and unlinked PRs",
    )
    .option(
      "--min-age <days>",
      "Minimum age in days for orphan-issue reporting (default: 7)",
      (v: string) => parseInt(v, 10),
      7,
    )
    .option("--repo <owner/repo>", "Limit audit to a specific repo")
    .option("--agent <name>", "Limit audit to a specific agent")
    .option("--json", "Output raw JSON instead of the human-readable report")
    .action(
      async (opts: {
        minAge: number;
        repo?: string;
        agent?: string;
        json?: boolean;
      }) => {
        let config;
        try {
          config = loadConfig(program.opts().config);
        } catch (err) {
          console.error(
            chalk.red(`\nFailed to load config: ${err instanceof Error ? err.message : err}\n`),
          );
          process.exit(2);
          return;
        }

        // Filter agents by --repo or --agent flags.
        let agents = config.agents;
        if (opts.agent) {
          const a = agents[opts.agent];
          if (!a) {
            console.error(chalk.red(`\nUnknown agent: ${opts.agent}\n`));
            process.exit(2);
            return;
          }
          agents = { [opts.agent]: a };
        } else if (opts.repo) {
          agents = Object.fromEntries(
            Object.entries(agents).filter(([, a]) => a.github === opts.repo),
          );
          if (Object.keys(agents).length === 0) {
            console.error(chalk.red(`\nNo agent configured for repo: ${opts.repo}\n`));
            process.exit(2);
            return;
          }
        }

        if (!opts.json) {
          console.log(chalk.bold(`\n🔍 orch audit  (min-age: ${opts.minAge}d)\n`));
        }

        const result = auditAll(agents, { minAgeDays: opts.minAge });

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(result.totalGaps > 0 ? 1 : 0);
          return;
        }

        printReport(result);

        if (result.totalGaps === 0) {
          process.exit(0);
        } else {
          process.exit(1);
        }
      },
    );
}

// ── Human-readable output ─────────────────────────────────────────────────────

function printReport(result: AuditResult): void {
  const { repos, totalGaps, orphanIssues, zombieIssues, unlinkedPRs, elapsedMs } = result;

  if (repos.length === 0) {
    console.log(chalk.dim("No agent repos configured with github field.\n"));
    return;
  }

  let hasOutput = false;

  for (const repoResult of repos) {
    if (repoResult.error) {
      console.log(
        chalk.yellow(`  ⚠  ${repoResult.agent} (${repoResult.repo}): ${repoResult.error}`),
      );
      hasOutput = true;
      continue;
    }

    if (repoResult.gaps.length === 0) continue;

    hasOutput = true;
    printRepoSection(repoResult);
  }

  if (!hasOutput || totalGaps === 0) {
    console.log(chalk.green("✅  No traceability gaps found across all repos.\n"));
    return;
  }

  // Summary line
  console.log(chalk.dim("─".repeat(70)));
  const parts: string[] = [];
  if (orphanIssues > 0)
    parts.push(chalk.yellow(`${orphanIssues} orphan issue${orphanIssues > 1 ? "s" : ""}`));
  if (zombieIssues > 0)
    parts.push(chalk.red(`${zombieIssues} zombie issue${zombieIssues > 1 ? "s" : ""}`));
  if (unlinkedPRs > 0)
    parts.push(chalk.magenta(`${unlinkedPRs} unlinked PR${unlinkedPRs > 1 ? "s" : ""}`));
  console.log(`\n  ${parts.join("  ·  ")}  ${chalk.dim(`(${elapsedMs}ms)`)}\n`);
}

function printRepoSection(repoResult: AuditRepoResult): void {
  const { repo, agent, gaps } = repoResult;
  console.log(chalk.bold(`\n● ${agent}  ${chalk.dim(repo)}`));

  const orphans = gaps.filter((g): g is Extract<AuditGap, { kind: "orphan-issue" }> =>
    g.kind === "orphan-issue",
  );
  const zombies = gaps.filter((g): g is Extract<AuditGap, { kind: "zombie-issue" }> =>
    g.kind === "zombie-issue",
  );
  const unlinked = gaps.filter((g): g is Extract<AuditGap, { kind: "unlinked-pr" }> =>
    g.kind === "unlinked-pr",
  );

  if (orphans.length > 0) {
    console.log(chalk.yellow(`\n  ⚠  Orphan issues (open, no linked PR or branch)\n`));
    for (const gap of orphans) {
      console.log(
        `    ${chalk.cyan(`#${gap.issueNumber}`)}  ${gap.title.length > 55 ? gap.title.slice(0, 54) + "…" : gap.title}  ${chalk.dim(`(${gap.ageDays}d old)`)}`,
      );
      console.log(`       ${chalk.dim("↳")} ${chalk.dim(gap.fix)}`);
    }
  }

  if (zombies.length > 0) {
    console.log(chalk.red(`\n  🧟  Zombie issues (merged PR exists, issue still open)\n`));
    for (const gap of zombies) {
      console.log(
        `    ${chalk.cyan(`#${gap.issueNumber}`)}  ${gap.title.length > 55 ? gap.title.slice(0, 54) + "…" : gap.title}  ${chalk.dim(`(merged in PR #${gap.mergedPrNumber})`)}`,
      );
      console.log(`       ${chalk.dim("↳")} ${chalk.dim(gap.fix)}`);
    }
  }

  if (unlinked.length > 0) {
    console.log(chalk.magenta(`\n  🔗  Unlinked PRs (missing "Closes #N" in body)\n`));
    for (const gap of unlinked) {
      console.log(
        `    ${chalk.cyan(`#${gap.prNumber}`)}  ${gap.title.length > 55 ? gap.title.slice(0, 54) + "…" : gap.title}`,
      );
      console.log(`       ${chalk.dim("↳")} ${chalk.dim(gap.fix)}`);
    }
  }
}
