import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { PRReviewer } from "claude-orchestrator-reviewer";
import { StateStore, type MergeQueueEntry } from "../../state/store.js";
import { execSync } from "node:child_process";

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Review open PRs on agent repos")
    .argument("[repo]", "Specific repo (owner/repo) to review, or all agent repos if omitted")
    .option("-n, --pr <number>", "Review a specific PR number (requires repo)")
    .option("--dry-run", "Show what would be reviewed without taking action")
    .option("--queue", "Show the current merge queue instead of reviewing PRs")
    .action(async (repo?: string, opts?: { pr?: string; dryRun?: boolean; queue?: boolean }) => {
      const config = loadConfig(program.opts().config);

      // --queue: display the merge queue and exit
      if (opts?.queue) {
        const store = new StateStore();
        const entries = store.getMergeQueue(repo);
        if (entries.length === 0) {
          console.log(chalk.dim(repo ? `No queued PRs for ${repo}.` : "Merge queue is empty."));
          return;
        }
        console.log(chalk.bold(`\n🔀 Merge Queue${repo ? ` — ${repo}` : ""}\n`));
        printMergeQueue(entries);
        return;
      }

      const store = new StateStore();
      const reviewer = new PRReviewer(config, store);

      if (repo && opts?.pr) {
        // Review a specific PR
        console.log(chalk.dim(`Reviewing ${repo}#${opts.pr}...\n`));
        const result = await reviewer.reviewPR(repo, parseInt(opts.pr, 10));
        printResult(repo, parseInt(opts.pr, 10), result);
        return;
      }

      // Review all open PRs across agent repos
      const repos = repo
        ? [{ name: "specified", repo }]
        : Object.entries(config.agents)
            .filter(([, a]) => a.github)
            .map(([name, a]) => ({ name, repo: a.github! }));

      if (repos.length === 0) {
        console.log(chalk.dim("No agent repos configured with github field."));
        return;
      }

      let totalReviewed = 0;

      for (const { name, repo: repoName } of repos) {
        const label = repo ? repoName : `${name} (${repoName})`;

        if (opts?.dryRun) {
          try {
            const prs = JSON.parse(
              execSync(
                `gh pr list --repo ${repoName} --state open --json number,title`,
                { encoding: "utf-8", timeout: 15000 },
              ),
            ) as Array<{ number: number; title: string }>;

            if (prs.length > 0) {
              console.log(chalk.bold(`\n${label}: ${prs.length} open PR(s)`));
              for (const pr of prs) {
                console.log(`  #${pr.number}: ${pr.title}`);
              }
              totalReviewed += prs.length;
            }
          } catch {
            // Skip repos we can't access
          }
          continue;
        }

        console.log(chalk.dim(`\nReviewing ${label}...`));
        try {
          const results = await reviewer.reviewOpenPRs(repoName);
          for (const { prNumber, result } of results) {
            printResult(repoName, prNumber, result);
            totalReviewed++;
          }
          if (results.length === 0) {
            console.log(chalk.dim("  No open PRs."));
          }
        } catch (err) {
          console.error(chalk.red(`  Error: ${err instanceof Error ? err.message : err}`));
        }
      }

      if (totalReviewed === 0 && !opts?.dryRun) {
        console.log(chalk.dim("\nNo open PRs to review."));
      }
    });
}

function printResult(repo: string, prNumber: number, result: { decision: string; comment: string; reason: string }): void {
  const color = result.decision === "approve" ? chalk.green :
    result.decision === "request-changes" ? chalk.yellow : chalk.red;
  console.log(`  ${color(result.decision.padEnd(16))} ${repo}#${prNumber}`);
  console.log(`    ${chalk.dim(result.reason)}`);
}

function printMergeQueue(entries: MergeQueueEntry[]): void {
  // Group by repo for cleaner output
  const byRepo = new Map<string, MergeQueueEntry[]>();
  for (const e of entries) {
    const list = byRepo.get(e.repo) ?? [];
    list.push(e);
    byRepo.set(e.repo, list);
  }

  for (const [repo, repoEntries] of byRepo) {
    console.log(chalk.bold(`  ${repo}`));
    for (const entry of repoEntries) {
      const statusColor =
        entry.status === "merging" ? chalk.cyan :
        entry.status === "queued"  ? chalk.green :
        entry.status === "merged"  ? chalk.dim :
        chalk.red;

      const posLabel = entry.status === "merging" ? "merging" : `#${entry.position + 1}`;
      const enqueuedAgo = formatAgo(entry.enqueued_at);
      console.log(
        `    ${statusColor(posLabel.padEnd(8))} PR #${entry.pr_number}  ${chalk.dim(entry.branch)}  ${chalk.dim(`(queued ${enqueuedAgo})`)}`,
      );
    }
    console.log();
  }
}

function formatAgo(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
