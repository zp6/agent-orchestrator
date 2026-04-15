/**
 * `orch health-checks` — Health Check Storm Effectiveness Panel (issue #743)
 *
 * Shows, over a rolling 24 h window, how many health check evaluations were:
 *   - dispatched (escalation task created)
 *   - suppressed by grace period (#730: agent recovered before 5 min grace expired)
 *   - suppressed by dedup gate (#731: one-active-incident gate fired)
 *
 * The panel also shows the pre-fix baseline (45 % of task capacity consumed by
 * health check storms) so operators can confirm the three fixes are working:
 *   - Grace period suppression (#730)
 *   - One-active-incident gate (#731)
 *   - Extended probe window (#728)
 *
 * Data is sourced from the health_check_events table (populated since the
 * daemon started recording events after these fixes shipped).
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type HealthCheckStormMetrics,
  type HealthCheckStormHour,
} from "../../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Pre-fix baseline: health check storms consumed ~45 % of task capacity. */
const BASELINE_DISPATCH_RATE_PCT = 45;

/** Current dispatch rate above this threshold warrants a warning. */
const WARN_THRESHOLD_PCT = 20;

/** Current dispatch rate above this threshold warrants a critical alert. */
const CRIT_THRESHOLD_PCT = 35;

/** Width of the inline stacked bar charts. */
const BAR_WIDTH = 36;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Render a stacked horizontal bar for a single hour bucket.
 * Dispatched = red, grace-period-suppressed = green, dedup-gate-suppressed = cyan.
 */
function renderStackedBar(row: HealthCheckStormHour, width = BAR_WIDTH): string {
  const total = row.total_evaluated;
  if (total === 0) return chalk.dim("─".repeat(width));

  const dispatchedCols = Math.round((row.dispatched / total) * width);
  const graceCols = Math.round((row.grace_period_suppressed / total) * width);
  const dedupCols = width - dispatchedCols - graceCols;

  return (
    chalk.red("█".repeat(dispatchedCols)) +
    chalk.green("█".repeat(Math.max(0, graceCols))) +
    chalk.cyan("█".repeat(Math.max(0, dedupCols)))
  );
}

/** Colour a dispatch rate: green = healthy, yellow = warn, red = critical. */
function colorRate(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${pct.toFixed(1)}%`;
  if (pct >= CRIT_THRESHOLD_PCT) return chalk.red(s);
  if (pct >= WARN_THRESHOLD_PCT) return chalk.yellow(s);
  return chalk.green(s);
}

/** Format a per-hour row for the trend table. */
function formatHourRow(row: HealthCheckStormHour): string {
  const bar = renderStackedBar(row);
  const dispPct =
    row.total_evaluated > 0
      ? ((row.dispatched / row.total_evaluated) * 100).toFixed(0)
      : "0";
  const label = `${String(row.dispatched).padStart(3)}d ${String(row.grace_period_suppressed).padStart(3)}g ${String(row.dedup_gate_suppressed).padStart(3)}x`;
  return `  ${chalk.dim(row.hour)}  ${bar}  ${String(dispPct).padStart(4)}%  ${chalk.dim(label)}`;
}

/** Print a compact summary row (totals across all hours). */
function printTotalsRow(m: HealthCheckStormMetrics): void {
  const rate = colorRate(m.dispatch_rate_pct);
  const baseline = chalk.dim(`baseline: ${BASELINE_DISPATCH_RATE_PCT}%`);
  console.log(
    `  ${"Total dispatched:".padEnd(26)} ${String(m.total_dispatched).padStart(5)}  ${rate}  ${baseline}`,
  );
  console.log(
    `  ${"Grace-period suppressed:".padEnd(26)} ${String(m.total_grace_period_suppressed).padStart(5)}  ${chalk.green("fix #730")}`,
  );
  console.log(
    `  ${"Dedup-gate suppressed:".padEnd(26)} ${String(m.total_dedup_gate_suppressed).padStart(5)}  ${chalk.cyan("fix #731")}`,
  );
  console.log(
    `  ${"Total evaluated:".padEnd(26)} ${String(m.total_evaluated).padStart(5)}`,
  );
}

/** Emit the verdict line based on the current dispatch rate vs. baseline. */
function printVerdict(m: HealthCheckStormMetrics): void {
  if (m.total_evaluated === 0) {
    console.log(
      chalk.dim(
        "\n  No health check events recorded yet in this window.\n" +
          "  Events accumulate as agents hit health check failures.\n" +
          "  The table will populate automatically as the daemon runs.\n",
      ),
    );
    return;
  }

  const rate = m.dispatch_rate_pct ?? 0;
  const savings = m.total_grace_period_suppressed + m.total_dedup_gate_suppressed;
  const savingsPct =
    m.total_evaluated > 0 ? ((savings / m.total_evaluated) * 100).toFixed(1) : "0.0";

  if (rate >= CRIT_THRESHOLD_PCT) {
    console.log(
      chalk.red(
        `\n  ⚠  Dispatch rate ${rate.toFixed(1)}% is near the pre-fix baseline (${BASELINE_DISPATCH_RATE_PCT}%).\n` +
          "  Check that the grace-period (#730) and dedup (#731) fixes are deployed\n" +
          "  and that HEALTH_GRACE_PERIOD_MS is set correctly in daemon.ts.\n",
      ),
    );
  } else if (rate >= WARN_THRESHOLD_PCT) {
    console.log(
      chalk.yellow(
        `\n  ⚠  Dispatch rate ${rate.toFixed(1)}% — above the green threshold (${WARN_THRESHOLD_PCT}%). Monitor.\n` +
          `  Storm fixes are suppressing ${savingsPct}% of evaluations. Watch for a new wave.\n`,
      ),
    );
  } else {
    console.log(
      chalk.green(
        `\n  ✓  Dispatch rate ${rate.toFixed(1)}% — well below pre-fix baseline (${BASELINE_DISPATCH_RATE_PCT}%).\n` +
          `  Storm fixes suppressed ${savingsPct}% of health check evaluations.\n` +
          "  Grace-period (#730), dedup gate (#731), and probe window (#728) are working.\n",
      ),
    );
  }
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerHealthChecksCommand(program: Command): void {
  program
    .command("health-checks")
    .description(
      "Show health check storm effectiveness panel: dispatched vs. suppressed by fix #728/#730/#731",
    )
    .option(
      "-w, --window <hours>",
      "Rolling window in hours (default: 24)",
      "24",
    )
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { window: string; json?: boolean }) => {
      const windowHours = Math.max(1, parseInt(opts.window, 10) || 24);

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

      let metrics: HealthCheckStormMetrics;
      try {
        metrics = store.getHealthCheckStormMetrics(windowHours);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(metrics, null, 2));
        return;
      }

      console.log(chalk.bold("\n◆ Health Check Storm Effectiveness Panel\n"));
      console.log(
        chalk.dim(
          "  Tracks three mutually exclusive outcomes for every health check evaluation:\n" +
            `  ${chalk.red("█")} dispatched          — escalation task created (grace period expired, gate open)\n` +
            `  ${chalk.green("█")} grace-suppressed    — agent self-recovered within 5 min grace period (fix #730)\n` +
            `  ${chalk.cyan("█")} dedup-suppressed    — duplicate call blocked by one-active-incident gate (fix #731)\n` +
            `\n  Pre-fix baseline: ${BASELINE_DISPATCH_RATE_PCT}% of task capacity consumed by health check storms.\n`,
        ),
      );

      if (metrics.hourly.length > 0) {
        const header = [
          "Hour              ",
          " ".repeat(BAR_WIDTH),
          " Disp%",
          "  d=dispatched g=grace x=dedup",
        ].join("  ");
        const sep = "─".repeat(header.length + 2);

        console.log(chalk.dim("  " + header));
        console.log(chalk.dim("  " + sep));

        for (const row of metrics.hourly) {
          console.log(formatHourRow(row));
        }

        console.log(chalk.dim("  " + sep));
      } else {
        console.log(
          chalk.dim(
            `  No health check events in the last ${windowHours} hour(s).\n`,
          ),
        );
      }

      console.log();
      printTotalsRow(metrics);
      printVerdict(metrics);

      console.log(
        chalk.dim(
          "  Run `orch health-checks --json` for machine-readable output.\n" +
            "  Run `orch health-checks --window 168` for a 7-day window.\n" +
            "  Run `orch health-check-efficiency` for the false-positive rate panel.\n",
        ),
      );
    });
}
