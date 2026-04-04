import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { PRLister } from "../../orchestrator/pr-lister.js";
import type { PRRow } from "../../orchestrator/pr-lister.js";
import { formatAge, formatStaleDays } from "../../orchestrator/pr-lister.js";

function formatReviewStatus(status: PRRow["reviewStatus"], width = 0): string {
  const plain =
    status === "approved" ? "approved" : status === "changes-requested" ? "changes-req" : "pending";
  const padded = plain.padEnd(width);
  switch (status) {
    case "approved":
      return chalk.green(padded);
    case "changes-requested":
      return chalk.yellow(padded);
    case "pending":
      return chalk.dim(padded);
  }
}

function formatCIStatus(ciStatus: PRRow["ciStatus"], width = 0): string {
  const plain =
    ciStatus === "passing"
      ? "✓ pass"
      : ciStatus === "failing"
        ? "✗ fail"
        : ciStatus === "pending"
          ? "… pending"
          : "—";
  const padded = plain.padEnd(width);
  switch (ciStatus) {
    case "passing":
      return chalk.green(padded);
    case "failing":
      return chalk.red(padded);
    case "pending":
      return chalk.yellow(padded);
    case "none":
      return chalk.dim(padded);
  }
}

function formatConflict(mergeable: PRRow["mergeable"], width = 0): string {
  const plain =
    mergeable === "yes"
      ? "clean"
      : mergeable === "conflict"
        ? "conflict"
        : mergeable === "no"
          ? "no"
          : "unknown";
  const padded = plain.padEnd(width);
  switch (mergeable) {
    case "yes":
      return chalk.green(padded);
    case "conflict":
      return chalk.red(padded);
    case "no":
      return chalk.red(padded);
    case "unknown":
      return chalk.dim(padded);
  }
}

function formatStale(staleDays: number, width = 0): string {
  const label = formatStaleDays(staleDays);
  const padded = label.padEnd(width);
  if (staleDays > 7) return chalk.red(padded);
  if (staleDays >= 3) return chalk.yellow(padded);
  return chalk.dim(padded);
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
    chalk.bold("STALE".padEnd(6)) +
    "  " +
    chalk.bold("REVIEW".padEnd(12)) +
    "  " +
    chalk.bold("CI".padEnd(10)) +
    "  " +
    chalk.bold("CONFLICT".padEnd(9)) +
    "  " +
    chalk.bold("ISSUE");

  console.log(header);
  console.log(chalk.dim("─".repeat(repoWidth + titleWidth + 76)));

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
      formatStale(row.staleDays, 6) +
      "  " +
      formatReviewStatus(row.reviewStatus, 12) +
      "  " +
      formatCIStatus(row.ciStatus, 10) +
      "  " +
      formatConflict(row.mergeable, 9) +
      "  " +
      chalk.dim(row.linkedIssue);

    console.log(line);
  }
}

export function registerPRsCommand(program: Command): void {
  program
    .command("prs")
    .description("List all open PRs across agent repos with CI, review, and merge readiness")
    .option("--stale", "Show only PRs not pushed to in ≥3 days")
    .option("--stale-days <days>", "Show only PRs not pushed to in ≥N days", parseInt)
    .option("--conflicts", "Show only PRs with merge conflicts (alias: --conflict)")
    .option("--conflict", "Show only PRs with merge conflicts")
    .option("--ci-failed", "Show only PRs with failing CI checks")
    .option("--repo <repo>", "Limit to a specific repo (owner/repo)")
    .action(
      (opts: {
        stale?: boolean;
        staleDays?: number;
        conflicts?: boolean;
        conflict?: boolean;
        ciFailed?: boolean;
        repo?: string;
      }) => {
        const config = loadConfig(program.opts().config);
        const lister = new PRLister(config);

        const { rows, hasConflicts } = lister.listAll(opts);

        printTable(rows);

        // Summary line
        if (rows.length > 0) {
          const conflictCount = rows.filter((r) => r.mergeable === "conflict").length;
          const staleCount = rows.filter((r) => r.staleDays >= 3).length;
          const ciFailCount = rows.filter((r) => r.ciStatus === "failing").length;
          const parts: string[] = [`${rows.length} open PR(s)`];
          if (conflictCount > 0) parts.push(chalk.red(`${conflictCount} conflict(s)`));
          if (ciFailCount > 0) parts.push(chalk.red(`${ciFailCount} CI failing`));
          if (staleCount > 0) parts.push(chalk.yellow(`${staleCount} stale (≥3d since push)`));
          console.log(chalk.dim("\n" + parts.join(" · ")));
        }

        // Exit non-zero if any conflict PRs exist (across full set, not just filtered view)
        if (hasConflicts) {
          process.exit(1);
        }
      },
    );
}
