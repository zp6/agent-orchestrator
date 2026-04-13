/**
 * `orch cost` — PR iteration cost leaderboard (issue #763).
 *
 * Shows the top-N most expensive GitHub issues by cumulative revision count,
 * color-coded by agent, filterable by date range and agent name.
 *
 * Usage:
 *   orch cost                         # top 10 issues, last 30 days
 *   orch cost --days 7                # last 7 days
 *   orch cost --limit 20              # top 20
 *   orch cost --agent claude-proxy    # filter to one agent
 *   orch cost --ceiling 2             # highlight issues >= 2 revisions
 *   orch cost --json                  # machine-readable output
 *
 * Exit codes:
 *   0 — normal (even if over-budget issues exist)
 *   1 — database or config error
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

// ── Constants ──────────────────────────────────────────────────────────────

export const DEFAULT_CEILING = 3;
export const DEFAULT_LIMIT = 10;
export const DEFAULT_DAYS = 30;

// ── Per-agent color palette (cycles through these if more agents than colors)

const AGENT_COLORS: Array<(s: string) => string> = [
  chalk.cyan,
  chalk.magenta,
  chalk.blue,
  chalk.yellow,
  chalk.green,
  chalk.red,
];

// ── Helpers ────────────────────────────────────────────────────────────────

/** Assign a deterministic chalk color to an agent name. */
export function agentColor(agentName: string | null, colorMap: Map<string, (s: string) => string>): (s: string) => string {
  if (!agentName) return chalk.dim;
  if (colorMap.has(agentName)) return colorMap.get(agentName)!;
  const color = AGENT_COLORS[colorMap.size % AGENT_COLORS.length];
  colorMap.set(agentName, color);
  return color;
}

/** Render a revision count with color coding relative to the budget ceiling. */
export function colorRevisions(count: number, ceiling: number): string {
  if (count > ceiling) return chalk.red.bold(String(count));
  if (count === ceiling) return chalk.yellow(String(count));
  return chalk.green(String(count));
}

/** Format an ISO timestamp as a compact "YYYY-MM-DD" date string. */
export function formatDate(iso: string): string {
  return iso.split("T")[0] ?? iso.slice(0, 10);
}

/** Format a quality score (0–1) as a compact colored string. */
export function formatScore(score: number | null): string {
  if (score === null) return chalk.dim("  —  ");
  const s = score.toFixed(2);
  if (score >= 0.9) return chalk.green(s);
  if (score >= 0.7) return chalk.yellow(s);
  return chalk.red(s);
}

// ── CLI registration ────────────────────────────────────────────────────────

export function registerCostCommand(program: Command): void {
  program
    .command("cost")
    .description(
      "PR iteration cost leaderboard — top issues by revision count, color-coded by agent",
    )
    .option("-d, --days <n>", "Look-back window in days (0 = all-time)", String(DEFAULT_DAYS))
    .option("-l, --limit <n>", "Max issues to show", String(DEFAULT_LIMIT))
    .option("-a, --agent <name>", "Filter to a specific agent")
    .option(
      "--ceiling <n>",
      `Revision count considered over budget (highlighted in red, default ${DEFAULT_CEILING})`,
      String(DEFAULT_CEILING),
    )
    .option("--json", "Output raw JSON instead of a formatted table")
    .action(
      (opts: {
        days: string;
        limit: string;
        agent?: string;
        ceiling: string;
        json?: boolean;
      }) => {
        const days = parseInt(opts.days, 10);
        const limit = parseInt(opts.limit, 10);
        const ceiling = parseInt(opts.ceiling, 10);

        if (isNaN(days) || days < 0) {
          console.error(chalk.red("Error: --days must be a non-negative integer"));
          process.exit(1);
        }
        if (isNaN(limit) || limit < 1) {
          console.error(chalk.red("Error: --limit must be a positive integer"));
          process.exit(1);
        }
        if (isNaN(ceiling) || ceiling < 1) {
          console.error(chalk.red("Error: --ceiling must be a positive integer"));
          process.exit(1);
        }

        let store: StateStore;
        try {
          store = new StateStore();
        } catch (err) {
          console.error(
            chalk.red("Could not open state database:"),
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }

        const rows = store.getIterationCostLeaderboard(limit, days, opts.agent);

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        printCostLeaderboard(rows, { days, limit, ceiling, agentFilter: opts.agent });
      },
    );
}

// ── Output formatting ───────────────────────────────────────────────────────

interface PrintOpts {
  days: number;
  limit: number;
  ceiling: number;
  agentFilter?: string;
}

export function printCostLeaderboard(
  rows: Array<{
    source_ref: string;
    total_revisions: number;
    task_count: number;
    agent_name: string | null;
    labels: string[];
    avg_quality_score: number | null;
    last_updated_at: string;
  }>,
  opts: PrintOpts,
): void {
  const { days, ceiling, agentFilter } = opts;

  // Header
  const windowLabel = days === 0 ? "all time" : `last ${days} days`;
  const agentLabel = agentFilter ? ` · agent: ${agentFilter}` : "";
  console.log();
  console.log(
    chalk.bold.white("  PR Iteration Cost Leaderboard") +
      chalk.dim(` — ${windowLabel}${agentLabel}`),
  );
  console.log(
    chalk.dim("  Ranks GitHub issues by total revision cycles (higher = more expensive)\n"),
  );

  if (rows.length === 0) {
    console.log(chalk.dim("  No issues with revision cycles found in this window.\n"));
    return;
  }

  // Build color map for agents seen in results
  const colorMap = new Map<string, (s: string) => string>();
  for (const row of rows) {
    if (row.agent_name) agentColor(row.agent_name, colorMap);
  }

  // Column widths
  const refWidth = Math.min(
    Math.max(...rows.map((r) => r.source_ref.length), 12),
    50,
  );
  const agentWidth = Math.min(
    Math.max(...rows.map((r) => (r.agent_name ?? "—").length), 10),
    30,
  );

  // Table header
  const header = [
    chalk.dim("  #"),
    chalk.dim("Source Ref".padEnd(refWidth)),
    chalk.dim("Revisions"),
    chalk.dim("Tasks"),
    chalk.dim("Quality"),
    chalk.dim("Agent".padEnd(agentWidth)),
    chalk.dim("Updated"),
  ].join("  ");
  console.log(header);
  console.log(chalk.dim("  " + "─".repeat(header.length - 2)));

  // Table rows
  rows.forEach((row, idx) => {
    const color = agentColor(row.agent_name, colorMap);
    const rank = chalk.dim(`${String(idx + 1).padStart(2)}.`);
    const ref = row.source_ref.length > refWidth
      ? `…${row.source_ref.slice(-(refWidth - 1))}`
      : row.source_ref.padEnd(refWidth);
    const revisions = colorRevisions(row.total_revisions, ceiling).padStart(9);
    const tasks = chalk.dim(String(row.task_count).padStart(5));
    const quality = formatScore(row.avg_quality_score).padStart(7);
    const agent = color((row.agent_name ?? "—").padEnd(agentWidth));
    const updated = chalk.dim(formatDate(row.last_updated_at));

    console.log(`  ${rank}  ${ref}  ${revisions}  ${tasks}  ${quality}  ${agent}  ${updated}`);
  });

  // Summary line
  const overBudget = rows.filter((r) => r.total_revisions > ceiling);
  console.log();
  if (overBudget.length > 0) {
    console.log(
      chalk.red(`  ⚠  ${overBudget.length} issue(s) over the revision budget`) +
        chalk.dim(` (ceiling: ${ceiling})`),
    );
    for (const issue of overBudget) {
      const color = agentColor(issue.agent_name, colorMap);
      console.log(
        `     ${chalk.dim("•")} ${issue.source_ref}` +
          ` — ${colorRevisions(issue.total_revisions, ceiling)} revisions` +
          ` (${color(issue.agent_name ?? "no agent")})`,
      );
    }
  } else {
    console.log(
      chalk.green(`  ✓  All issues within revision budget`) +
        chalk.dim(` (ceiling: ${ceiling})`),
    );
  }
  console.log();
}
