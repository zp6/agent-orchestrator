import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { PRReviewer } from "../../orchestrator/pr-reviewer.js";

export function registerReviewCommand(program: Command): void {
  program
    .command("review")
    .description("Review open PRs on agent repos")
    .argument("[repo]", "Specific repo (owner/repo) to review, or all agent repos if omitted")
    .option("-n, --pr <number>", "Review a specific PR number (requires repo)")
    .option("--dry-run", "Show what would be reviewed without taking action")
    .action(async (repo?: string, opts?: { pr?: string; dryRun?: boolean }) => {
      const config = loadConfig(program.opts().config);
      const reviewer = new PRReviewer(config);

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
              require("child_process").execSync(
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
