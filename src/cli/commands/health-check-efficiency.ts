/**
 * `orch health-check-efficiency` — Health Check Efficiency Panel (issue #749)
 *
 * Shows the false-positive rate for health check dispatches over the last 7 days
 * (configurable).  A "false positive" is a health-check escalation task that was
 * auto-resolved by the daemon because the agent recovered without any agent
 * action being required.
 *
 * Operators can use this panel to verify that the grace-period fix (#739) and
 * dedup fix (#731) are working: the false-positive rate should trend downward
 * after those fixes shipped.
 *
 * Data sourced from the lifecycle audit trail (tasks table, source_ref =
 * 'health-check-fail:<agent>').
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type HealthCheckEfficiencyDay,
  type HealthCheckEfficiencyMetrics,
} from "../../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Width of the inline bar charts. */
const BAR_WIDTH = 20;

/**
 * False-positive rates at or above this threshold are flagged yellow.
 * Matches the ~30% capacity impact noted in task #730.
 */
const WARN_THRESHOLD_PCT = 20;

/** False-positive rates at or above this threshold are flagged red. */
const CRIT_THRESHOLD_PCT = 40;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Colour a false-positive rate: green = healthy, yellow = warn, red = critical. */
function colorFpRate(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${pct.toFixed(1)}%`;
  if (pct >= CRIT_THRESHOLD_PCT) return chalk.red(s);
  if (pct >= WARN_THRESHOLD_PCT) return chalk.yellow(s);
  return chalk.green(s);
}

/** Render a horizontal bar proportional to the false-positive rate. */
function renderFpBar(pct: number | null, width = BAR_WIDTH): string {
  if (pct === null) return chalk.dim("─".repeat(width));
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (pct >= CRIT_THRESHOLD_PCT) return chalk.red(bar);
  if (pct >= WARN_THRESHOLD_PCT) return chalk.yellow(bar);
  return chalk.green(bar);
}

/**
 * Compute a simple trend direction over a series of false-positive rates.
 * Uses least-squares slope sign: rising → "worsening", falling → "improving",
 * flat → "stable".  Returns "n/a" when there are fewer than 3 data points.
 */
function trendLabel(rates: number[]): string {
  if (rates.length < 3) return chalk.dim("? n/a (not enough data)");

  const n = rates.length;
  const sumX = (n * (n - 1)) / 2;
  const sumX2 = rates.reduce((s, _, i) => s + i * i, 0);
  const sumY = rates.reduce((a, b) => a + b, 0);
  const sumXY = rates.reduce((s, v, i) => s + i * v, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (Math.abs(slope) < 0.5) return chalk.cyan("→ stable");
  if (slope > 0) return chalk.red("↑ worsening (more false positives)");
  return chalk.green("↓ improving (fewer false positives)");
}

/** Format a per-day row for the trend table. */
function formatDayRow(d: HealthCheckEfficiencyDay): string {
  const bar = renderFpBar(d.false_positive_rate_pct);
  const rate = colorFpRate(d.false_positive_rate_pct).padStart(8);
  const fp = String(d.false_positives).padStart(8);
  const total = String(d.total_dispatches).padStart(8);
  return `  ${chalk.dim(d.date)}  ${bar}  ${rate}  ${fp}  ${total}`;
}

/** Print the efficiency panel for a given window. */
function printPanel(label: string, data: HealthCheckEfficiencyMetrics): void {
  console.log(chalk.bold(`\n● ${label}`));

  if (data.daily.length === 0) {
    console.log(
      chalk.dim(
        "  No health check dispatches recorded in this window.\n" +
          "  This is expected if no agents have had health check failures recently.\n" +
          "  (Source: tasks with source_ref = 'health-check-fail:<agent>')"
      )
    );
    return;
  }

  const header = [
    "Date      ",
    " ".repeat(BAR_WIDTH),
    "  FP Rate",
    "False+ve",
    "   Total",
  ].join("  ");
  const sep = "─".repeat(header.length + 2);

  console.log(chalk.dim("  " + header));
  console.log(chalk.dim("  " + sep));

  for (const day of data.daily) {
    console.log(formatDayRow(day));
  }

  console.log(chalk.dim("  " + sep));

  const avgRate =
    data.avg_false_positive_rate_pct !== null
      ? colorFpRate(data.avg_false_positive_rate_pct)
      : chalk.dim("—");

  console.log(
    `  ${"Avg false-positive rate:".padEnd(28)} ${avgRate}   ` +
      chalk.dim(`(${data.total_false_positives} auto-resolved / ${data.total_dispatches} total)`)
  );

  const nonNullRates = data.daily
    .map((d) => d.false_positive_rate_pct)
    .filter((v): v is number => v !== null);
  console.log(`  ${"Trend:".padEnd(28)} ${trendLabel(nonNullRates)}`);
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerHealthCheckEfficiencyCommand(program: Command): void {
  program
    .command("health-check-efficiency")
    .description(
      "Show health check efficiency panel: false-positive rate trend over last 7 days"
    )
    .option("-d, --days <n>", "Number of days to show (default: 7)", "7")
    .option("--json", "Output raw JSON instead of formatted tables")
    .action((opts: { days: string; json?: boolean }) => {
      const days = Math.max(1, parseInt(opts.days, 10) || 7);

      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(
          chalk.red("Could not open state database:"),
          err instanceof Error ? err.message : String(err)
        );
        process.exit(1);
      }

      let data: HealthCheckEfficiencyMetrics;
      try {
        data = store.getHealthCheckEfficiencyMetrics(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.bold("\n◆ Health Check Efficiency — False Positive Rate\n"));
      console.log(
        chalk.dim(
          "  Tracks health-check escalation tasks that self-resolved without agent action.\n" +
            "  A falling false-positive rate confirms the grace-period (#739) and dedup (#731)\n" +
            "  fixes are reducing unnecessary dispatches.\n"
        )
      );
      console.log(
        chalk.dim(
          "  False positive = task created with source_ref 'health-check-fail:<agent>'\n" +
            "  that was auto-resolved by the daemon (agent recovered without intervention).\n"
        )
      );

      printPanel(`Last ${days} days`, data);

      const rate = data.avg_false_positive_rate_pct;
      if (data.total_dispatches === 0) {
        console.log(
          chalk.dim(
            "\n  No health check dispatches in this window — nothing to measure yet.\n" +
              "  Dispatches appear here when an agent fails its health check and an\n" +
              "  escalation task is created (after the grace period expires).\n"
          )
        );
      } else if (rate === null) {
        console.log(chalk.dim("\n  Could not compute average false-positive rate.\n"));
      } else if (rate >= CRIT_THRESHOLD_PCT) {
        console.log(
          chalk.red(
            `\n  ⚠  High false-positive rate (${rate.toFixed(1)}%). ` +
              "Many health check escalations are self-resolving — verify grace period\n" +
              "  config (HEALTH_GRACE_PERIOD_MS) and dedup logic are applied correctly.\n"
          )
        );
      } else if (rate >= WARN_THRESHOLD_PCT) {
        console.log(
          chalk.yellow(
            `\n  ⚠  Elevated false-positive rate (${rate.toFixed(1)}%). ` +
              "Monitor over the next few cycles.\n"
          )
        );
      } else {
        console.log(
          chalk.green(
            `\n  ✓  False-positive rate is healthy (${rate.toFixed(1)}%). ` +
              "Grace period and dedup fixes are working correctly.\n"
          )
        );
      }

      console.log(
        chalk.dim(
          "  Run `orch health-check-efficiency --json` for machine-readable output.\n" +
            "  Run `orch health-check-efficiency --days 30` for a longer trend window.\n"
        )
      );
    });
}
