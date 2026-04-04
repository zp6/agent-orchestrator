import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { PRLister } from "../../orchestrator/pr-lister.js";
import type { PRRow } from "../../orchestrator/pr-lister.js";
import { formatAge } from "../../orchestrator/pr-lister.js";

function formatReviewStatus(status: PRRow["reviewStatus"]): string {
  switch (status) {
    case "approved":
      return chalk.green("approved");
    case "changes-requested":
      return chalk.yellow("changes-req");
    case "pending":
      return chalk.dim("pending");
  }
}

function formatMergeable(mergeable: PRRow["mergeable"]): string {
  switch (mergeable) {
    case "yes":
      return chalk.green("yes");
    case "conflict":
      return chalk.red("conflict");
    case "no":
      return chalk.red("no");
    case "unknown":
      return chalk.dim("unknown");
  }
}

function printTable(rows: PRRow[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("No open PRs found."));
    return;
  }

  // Compute column widths
  const repoWidth = Math.max(4, ...rows.map((r) => r.repo.length));
  const titleWidth = Math.min(50, Math.max(5, ...rows.map((r) => r.title.length)));

  const header =
    chalk.bold("REPO".padEnd(repoWidth)) +
    "  " +
    chalk.bold("PR#".padEnd(5)) +
    "  " +
    chalk.bold("TITLE".padEnd(titleWidth)) +
    "  " +
    chalk.bold("AGE".padEnd(6)) +
    "  " +
    chalk.bold("REVIEW".padEnd(12)) +
    "  " +
    chalk.bold("MERGE".padEnd(8)) +
    "  " +
    chalk.bold("ISSUE");

  console.log(header);
  console.log(chalk.dim("─".repeat(repoWidth + titleWidth + 55)));

  for (const row of rows) {
    const title =
      row.title.length > titleWidth ? row.title.slice(0, titleWidth - 1) + "…" : row.title;

    const line =
      row.repo.padEnd(repoWidth) +
      "  " +
      chalk.cyan(`#${row.number}`.padEnd(5)) +
      "  " +
      title.padEnd(titleWidth) +
      "  " +
      formatAge(row.ageDays).padEnd(6) +
      "  " +
      formatReviewStatus(row.reviewStatus).padEnd(12) +
      "  " +
      formatMergeable(row.mergeable).padEnd(8) +
      "  " +
      chalk.dim(row.linkedIssue);

    console.log(line);
  }
}

export function registerPRsCommand(program: Command): void {
  program
    .command("prs")
    .description("List all open PRs across agent repos with status")
    .option("--stale", "Show only PRs older than 3 days")
    .option("--conflicts", "Show only PRs with merge conflicts")
    .option("--repo <repo>", "Limit to a specific repo (owner/repo)")
    .action((opts: { stale?: boolean; conflicts?: boolean; repo?: string }) => {
      const config = loadConfig(program.opts().config);
      const lister = new PRLister(config);

      const { rows, hasConflicts } = lister.listAll(opts);

      printTable(rows);

      // Summary line
      if (rows.length > 0) {
        const conflictCount = rows.filter((r) => r.mergeable === "conflict").length;
        const staleCount = rows.filter((r) => r.ageDays >= 3).length;
        const parts: string[] = [`${rows.length} open PR(s)`];
        if (conflictCount > 0) parts.push(chalk.red(`${conflictCount} conflict(s)`));
        if (staleCount > 0) parts.push(chalk.yellow(`${staleCount} stale (≥3d)`));
        console.log(chalk.dim("\n" + parts.join(" · ")));
      }

      // Exit non-zero if any conflict PRs exist (across full set, not just filtered view)
      if (hasConflicts) {
        process.exit(1);
      }
    });
}
