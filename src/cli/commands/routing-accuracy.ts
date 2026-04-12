/**
 * `orch routing-accuracy` — Routing Accuracy Drill-Down (issue #683)
 *
 * Shows which task types are being misrouted and why: for every
 * (task_type × agent) combination in the rolling window it displays the
 * average quality score, the routing-method breakdown, and — where a
 * better-performing agent exists for the same task type — the score gap
 * and a misrouting flag.
 *
 * Usage:
 *   orch routing-accuracy              # last 30 days, formatted table
 *   orch routing-accuracy --days 7     # 7-day window
 *   orch routing-accuracy --type impl  # filter to a specific task type
 *   orch routing-accuracy --misrouted  # show only misrouted rows
 *   orch routing-accuracy --json       # machine-readable JSON
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type RoutingDrillDownRow,
  type RoutingAccuracyDrillDown,
} from "../../state/store.js";
import { formatScore } from "./metrics.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Score gap above which a row is highlighted as misrouted (mirrors store constant). */
const GAP_THRESHOLD = StateStore.MISROUTING_GAP_THRESHOLD;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Colour a score gap: green (0), yellow (small gap), red (≥ threshold). */
function colorGap(gap: number | null): string {
  if (gap === null) return chalk.dim("—");
  const s = `+${(gap * 100).toFixed(0)}%`;
  if (gap >= GAP_THRESHOLD) return chalk.red(s);
  if (gap > 0) return chalk.yellow(s);
  return chalk.green("best");
}

/** Render the route-method breakdown as a compact string, e.g. "det:8 llm:2". */
function routeBreakdown(row: RoutingDrillDownRow): string {
  const parts: string[] = [];
  if (row.det_count > 0) parts.push(chalk.cyan(`det:${row.det_count}`));
  if (row.llm_count > 0) parts.push(chalk.blue(`llm:${row.llm_count}`));
  if (row.exp_count > 0) parts.push(chalk.dim(`exp:${row.exp_count}`));
  return parts.length > 0 ? parts.join(" ") : chalk.dim("—");
}

/** Format avg_confidence as "0.78" or "—" if null. */
function fmtConf(c: number | null): string {
  if (c === null) return chalk.dim("—");
  const s = c.toFixed(2);
  if (c >= 0.8) return chalk.green(s);
  if (c >= 0.5) return chalk.yellow(s);
  return chalk.red(s);
}

/**
 * Build a human-readable misrouting reason from a flagged row.
 *
 * The "reason" explains what likely caused the mismatch so the operator
 * knows which knob to turn:
 *  - Low deterministic confidence → tuning router keywords/capabilities
 *  - High LLM-route share         → LLM may be guessing; add explicit topics
 *  - No confidence signal         → explicit overrides are masking the gap
 */
function misroutingReason(row: RoutingDrillDownRow): string {
  const reasons: string[] = [];

  // Confidence signal
  if (row.avg_confidence !== null && row.avg_confidence < 0.5) {
    reasons.push(`low router confidence (avg ${row.avg_confidence.toFixed(2)}) — add topic/capability keywords for "${row.task_type}" tasks to agents.yaml`);
  }

  // Route-method signal
  const total = row.total_routed;
  const llmFrac = total > 0 ? row.llm_count / total : 0;
  const expFrac = total > 0 ? row.exp_count / total : 0;

  if (llmFrac > 0.5) {
    reasons.push(`${Math.round(llmFrac * 100)}% of routes used LLM fallback — deterministic rules did not match; review owns_topics/capabilities for ${row.agent_name}`);
  }

  if (expFrac > 0.5) {
    reasons.push(`${Math.round(expFrac * 100)}% were explicit overrides — score gap may reflect domain mismatch rather than router error`);
  }

  // Score-gap signal (always present for misrouted rows)
  if (row.best_agent_for_type && row.score_gap !== null) {
    reasons.push(
      `${row.best_agent_for_type} scores ${(row.score_gap * 100).toFixed(0)}pp higher on "${row.task_type}" — consider adding "${row.task_type}" to its owns_topics`,
    );
  }

  return reasons.length > 0
    ? reasons.join("; ")
    : "score gap exceeds threshold — investigate agent capabilities for this task type";
}

// ── Section printers ──────────────────────────────────────────────────────────

/**
 * Print the full drill-down table grouped by task type.
 * Each task type gets a header row showing the best agent, followed by
 * one line per agent that handled tasks of that type.
 */
function printDrillDownTable(report: RoutingAccuracyDrillDown, filterType?: string): void {
  const { rows, days } = report;

  // Group rows by task_type
  const byType = new Map<string, RoutingDrillDownRow[]>();
  for (const row of rows) {
    if (filterType && !row.task_type.toLowerCase().includes(filterType.toLowerCase())) continue;
    const bucket = byType.get(row.task_type) ?? [];
    bucket.push(row);
    byType.set(row.task_type, bucket);
  }

  if (byType.size === 0) {
    console.log(chalk.dim("  No routing data in this window."));
    console.log();
    return;
  }

  // Column widths
  const COL = {
    agent:   32,
    total:    7,
    scored:   7,
    quality: 10,
    conf:     8,
    methods: 18,
    gap:      9,
  };

  const header = [
    "Agent".padEnd(COL.agent),
    "Total".padStart(COL.total),
    "Scored".padStart(COL.scored),
    "Quality".padStart(COL.quality),
    "Conf".padStart(COL.conf),
    "Methods".padEnd(COL.methods),
    "Gap".padStart(COL.gap),
  ].join("  ");
  const separator = "─".repeat(header.length);

  for (const [taskType, typeRows] of byType) {
    // Sort: best (highest score) first, then by name
    const sorted = [...typeRows].sort((a, b) => {
      const sa = a.avg_quality_score ?? -1;
      const sb = b.avg_quality_score ?? -1;
      return sb - sa;
    });

    const hasMisrouting = sorted.some((r) => r.misrouted);
    const typeLabel = hasMisrouting
      ? chalk.red(`⚠  ${taskType}`)
      : chalk.bold(taskType);

    console.log(`\n  ${typeLabel}  ${chalk.dim(`(${days}d window)`)}`);
    console.log(chalk.dim("  " + header));
    console.log(chalk.dim("  " + separator));

    for (const row of sorted) {
      const isBest = row.best_agent_for_type === null; // null means this IS the best
      const agentLabel = isBest
        ? chalk.green("★ " + row.agent_name.padEnd(COL.agent - 2))
        : (row.misrouted
            ? chalk.red("  " + row.agent_name.padEnd(COL.agent - 2))
            : chalk.cyan("  " + row.agent_name.padEnd(COL.agent - 2)));

      const line = [
        agentLabel,
        String(row.total_routed).padStart(COL.total),
        String(row.scored).padStart(COL.scored),
        formatScore(row.avg_quality_score).padStart(COL.quality),
        fmtConf(row.avg_confidence).padStart(COL.conf),
        routeBreakdown(row).padEnd(COL.methods),
        colorGap(row.score_gap).padStart(COL.gap),
      ].join("  ");

      console.log("  " + line);
    }

    console.log(chalk.dim("  " + separator));
  }
}

/**
 * Print the misrouting summary section: one bullet per flagged task type
 * with the specific reasons and suggested fixes.
 */
function printMisroutingSummary(report: RoutingAccuracyDrillDown, filterType?: string): void {
  const { rows, misrouted_task_types } = report;

  const flaggedTypes = misrouted_task_types.filter(
    (t) => !filterType || t.toLowerCase().includes(filterType.toLowerCase()),
  );

  if (flaggedTypes.length === 0) {
    console.log(
      chalk.green("  ✓  No misrouting detected — all task types are routed to high-scoring agents.\n"),
    );
    return;
  }

  console.log(
    chalk.bold(`\n● Misrouting Analysis  `) +
    chalk.dim(`(score gap ≥ ${(GAP_THRESHOLD * 100).toFixed(0)}pp)\n`),
  );

  for (const taskType of flaggedTypes) {
    const typeRows = rows.filter((r) => r.task_type === taskType);
    const misroutedRows = typeRows.filter((r) => r.misrouted);
    const bestRow = typeRows.find((r) => r.best_agent_for_type === null);

    console.log(
      chalk.red(`  ▶ ${taskType}`) +
      (bestRow && bestRow.avg_quality_score !== null
        ? chalk.dim(` — best agent: ${bestRow.agent_name} (${formatScore(bestRow.avg_quality_score)})`)
        : ""),
    );

    for (const row of misroutedRows) {
      console.log(
        chalk.yellow(`    • ${row.agent_name}`) +
        chalk.dim(` (${row.total_routed} tasks, score ${formatScore(row.avg_quality_score)})`),
      );
      const reason = misroutingReason(row);
      // Wrap long reason lines at 90 chars
      const words = reason.split(" ");
      let line = "      → ";
      for (const word of words) {
        if (line.length + word.length > 92) {
          console.log(chalk.dim(line));
          line = "        " + word + " ";
        } else {
          line += word + " ";
        }
      }
      if (line.trim().length > 2) console.log(chalk.dim(line.trimEnd()));
      console.log();
    }
  }
}

/**
 * Print a one-line summary header showing counts of misrouted vs. total types.
 */
function printHeader(report: RoutingAccuracyDrillDown): void {
  const totalTypes = new Set(report.rows.map((r) => r.task_type)).size;
  const misroutedCount = report.misrouted_task_types.length;
  const totalAgents = new Set(report.rows.map((r) => r.agent_name)).size;
  const totalTasks = report.rows.reduce((s, r) => s + r.total_routed, 0);

  const healthStatus =
    misroutedCount === 0
      ? chalk.green("● healthy")
      : misroutedCount === 1
        ? chalk.yellow(`⚠  1 task type misrouted`)
        : chalk.red(`⚠  ${misroutedCount} task types misrouted`);

  console.log(
    chalk.bold(`\n◆ Routing Accuracy Drill-Down`) +
    `  ${healthStatus}`,
  );
  console.log(
    chalk.dim(
      `  ${totalTasks} routed tasks · ${totalAgents} agents · ` +
      `${totalTypes} task types · last ${report.days} days\n`,
    ),
  );
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerRoutingAccuracyCommand(program: Command): void {
  program
    .command("routing-accuracy")
    .description(
      "Drill-down: per-task-type routing accuracy, misrouting flags, and fix suggestions",
    )
    .option("-d, --days <n>", "Rolling window in days", "30")
    .option("-t, --type <keyword>", "Filter to task types containing this keyword")
    .option("-m, --misrouted", "Show only misrouted rows and analysis")
    .option("--json", "Output raw JSON instead of formatted tables")
    .action(
      (opts: { days: string; type?: string; misrouted?: boolean; json?: boolean }) => {
        const days = parseInt(opts.days, 10);
        if (isNaN(days) || days < 1) {
          console.error(chalk.red("Error: --days must be a positive integer"));
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

        let report: RoutingAccuracyDrillDown;
        try {
          report = store.getRoutingAccuracyDrillDown(days);
        } finally {
          store.close();
        }

        if (opts.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }

        if (report.rows.length === 0) {
          console.log(chalk.bold("\n◆ Routing Accuracy Drill-Down\n"));
          console.log(
            chalk.dim(
              "  No routing outcome data in this window.\n" +
              "  Dispatch some tasks first — routing decisions are recorded automatically.\n",
            ),
          );
          return;
        }

        // ── Header ────────────────────────────────────────────────────────────
        printHeader(report);

        // ── Drill-down table ──────────────────────────────────────────────────
        if (!opts.misrouted) {
          console.log(chalk.bold("● Task-Type × Agent Matrix\n"));
          console.log(
            chalk.dim(
              "  ★ = best agent for task type   ⚠ = score gap ≥ " +
              `${(GAP_THRESHOLD * 100).toFixed(0)}pp (potential misrouting)\n` +
              "  det = deterministic router   llm = LLM fallback   exp = explicit override\n",
            ),
          );
          printDrillDownTable(report, opts.type);
        }

        // ── Misrouting summary ────────────────────────────────────────────────
        printMisroutingSummary(report, opts.type);

        // ── Footer ────────────────────────────────────────────────────────────
        console.log(
          chalk.dim(
            "  Fix misrouting: add owns_topics/capabilities to agents.yaml for the best agent,\n" +
            "  or use `orch dispatch --agent <name>` to route explicitly until the rules are tuned.\n" +
            "  Run `orch routing-accuracy --misrouted` to see only problem areas, or --json for scripting.\n",
          ),
        );
      },
    );
}
