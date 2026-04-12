import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

export function registerPRResetCommand(program: Command): void {
  program
    .command("pr-reset")
    .description("Clear a PR's escalation record so the reviewer re-reviews it next cycle")
    .argument("<repo>", "Repository (e.g. rapartlu/agent-orchestrator)")
    .argument("<pr_number>", "PR number")
    .option("--all", "Clear ALL escalated PR reviews across all repos")
    .action((repo: string, prNumberStr: string, opts: { all?: boolean }) => {
      const store = new StateStore();

      try {
        if (opts.all) {
          const count = store.clearAllEscalatedPRReviews();
          if (count === 0) {
            console.log(chalk.yellow("No escalated PR reviews found."));
          } else {
            console.log(chalk.green(`✓ Cleared ${count} escalated PR review(s)`));
            console.log(chalk.dim("The reviewer will re-review these PRs on the next cycle."));
          }
          return;
        }

        const prNumber = parseInt(prNumberStr, 10);
        if (isNaN(prNumber)) {
          console.error(chalk.red(`Invalid PR number: ${prNumberStr}`));
          process.exit(1);
        }

        const count = store.clearPRReviewEscalation(repo, prNumber);
        if (count === 0) {
          console.log(chalk.yellow(`No escalated review found for ${repo}#${prNumber}.`));
          // Show what reviews exist
          const reviews = store.getPRReviews(repo, prNumber);
          if (reviews.length > 0) {
            console.log(chalk.dim(`  Existing reviews: ${reviews.map((r) => `${r.decision} (${r.created_at.slice(0, 16)})`).join(", ")}`));
          }
        } else {
          console.log(chalk.green(`✓ Cleared escalation for ${repo}#${prNumber}`));
          console.log(chalk.dim("The reviewer will re-review this PR on the next cycle."));
        }
      } finally {
        store.close();
      }
    });
}
