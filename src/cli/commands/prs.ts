import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { PRLister } from "../../orchestrator/pr-lister.js";
import type { PRRow } from "../../orchestrator/pr-lister.js";
import { formatAge, formatStaleDays } from "../../orchestrator/pr-lister.js";

function formatMergeReady(mergeReady: PRRow["mergeReady"], width = 0): string {
  const labels: Record<PRRow["mergeReady"], string> = {
    ready: "✓ ready",
    conflict: "✗ conflict",
    "ci-failing": "✗ CI fail",
    "changes-requested": "✗ changes",
    "needs-review": "· review",
    stale: "· stale",
  };
  const plain = labels[mergeReady];
  const padded = plain.padEnd(width);
  switch (mergeReady) {
    case "ready":
      return chalk.green(padded);
    case "conflict":
    case "ci-failing":
    case "changes-requested":
      return chalk.red(padded);
    case "needs-review":
    case "stale":
      return chalk.yellow(padded);
  }
}

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

function formatEscalated(escalated: boolean, width = 0): string {
  const label = escalated ? "⚑ human" : "";
  const padded = label.padEnd(width);
  return escalated ? chalk.magenta(padded) : chalk.dim("·".padEnd(width));
}

function printTable(rows: PRRow[]): void {
  if (rows.length === 0) {
    console.log(chalk.dim("No open PRs found."));
    return;
  }

  // Compute column widths
  const agentWidth = Math.max(5, ...rows.map((r) => (r.agent || r.repo).length));
  const titleWidth = Math.min(50, Math.max(5, ...rows.map((r) => r.title.length)));
  // READY column: longest label is "✗ conflict" (10 chars) or "✗ changes" (9 chars)
  const readyWidth = 10;
  // ESCALATED column: "⚑ human" (7 chars visible)
  const escalatedWidth = 7;

  const header =
    chalk.bold("AGENT".padEnd(agentWidth)) +
    "  " +
    chalk.bold("PR#".padEnd(5)) +
    "  " +
    chalk.bold("TITLE".padEnd(titleWidth)) +
    "  " +
    chalk.bold("READY".padEnd(readyWidth)) +
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
    chalk.bold("ESCALATED".padEnd(escalatedWidth)) +
    "  " +
    chalk.bold("ISSUE");

  console.log(header);
  console.log(chalk.dim("─".repeat(agentWidth + titleWidth + readyWidth + escalatedWidth + 94)));

  for (const row of rows) {
    const agentLabel = row.agent || row.repo;
    const title =
      row.title.length > titleWidth ? row.title.slice(0, titleWidth - 1) + "…" : row.title;

    const line =
      agentLabel.padEnd(agentWidth) +
      "  " +
      chalk.cyan(`#${row.number}`.padEnd(5)) +
      "  " +
      title.padEnd(titleWidth) +
      "  " +
      formatMergeReady(row.mergeReady, readyWidth) +
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
      formatEscalated(row.escalated, escalatedWidth) +
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
    .option("--agent <name>", "Limit to a specific agent by name (e.g. cheese-hater)")
    .option("--blocked", "Show only PRs that are not ready to merge")
    .option(
      "--needs-action",
      "Show only PRs requiring immediate attention: changes-requested, merge conflict, or escalated to human",
    )
    .action(
      (opts: {
        stale?: boolean;
        staleDays?: number;
        conflicts?: boolean;
        conflict?: boolean;
        ciFailed?: boolean;
        repo?: string;
        agent?: string;
        blocked?: boolean;
        needsAction?: boolean;
      }) => {
        const config = loadConfig(program.opts().config);
        const lister = new PRLister(config);

        const { rows: rawRows, hasConflicts } = lister.listAll(opts);
        const rows = opts.blocked ? rawRows.filter((r) => r.mergeReady !== "ready") : rawRows;

        printTable(rows);

        // Summary line (always computed against displayed rows)
        if (rows.length > 0) {
          const readyCount = rows.filter((r) => r.mergeReady === "ready").length;
          const conflictCount = rows.filter((r) => r.mergeable === "conflict").length;
          const staleCount = rows.filter((r) => r.staleDays >= 3).length;
          const ciFailCount = rows.filter((r) => r.ciStatus === "failing").length;
          const escalatedCount = rows.filter((r) => r.escalated).length;
          const changesRequestedCount = rows.filter((r) => r.mergeReady === "changes-requested").length;
          const parts: string[] = [`${rows.length} open PR(s)`];
          if (readyCount > 0) parts.push(chalk.green(`${readyCount} ready`));
          if (conflictCount > 0) parts.push(chalk.red(`${conflictCount} conflict(s)`));
          if (ciFailCount > 0) parts.push(chalk.red(`${ciFailCount} CI failing`));
          if (changesRequestedCount > 0) parts.push(chalk.red(`${changesRequestedCount} changes-requested`));
          if (escalatedCount > 0) parts.push(chalk.magenta(`${escalatedCount} escalated`));
          if (staleCount > 0) parts.push(chalk.yellow(`${staleCount} stale (≥3d since push)`));
          console.log(chalk.dim("\n" + parts.join(" · ")));
        }

        // Hint when --needs-action would narrow the list further
        if (!opts.needsAction && !opts.blocked) {
          const actionCount = rows.filter(
            (r) => r.mergeReady === "changes-requested" || r.mergeable === "conflict" || r.escalated,
          ).length;
          if (actionCount > 0) {
            console.log(
              chalk.dim(`\nTip: run with --needs-action to see only the ${actionCount} PR(s) requiring immediate attention.`),
            );
          }
        }

        // Exit non-zero if any conflict PRs exist (across full set, not just filtered view)
        if (hasConflicts) {
          process.exit(1);
        }
      },
    );
}
