/**
 * `orch dispatch-efficiency` — Dispatch Waste Rate Widget (issue #517)
 *
 * Shows the % of dispatch attempts that were blocked by the issue-state cache
 * (stale/closed issues, issues with existing PRs) over rolling 7-day and 30-day
 * windows.  Operators can use this to verify the cache is working and that the
 * waste rate is trending down since the cache was deployed.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type DispatchWasteDay, type DispatchWasteMetrics, type DispatchWasteHour, type DispatchWasteMetrics24h, type PRDetectionStrategyBreakdown } from "../../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Width of the inline bar charts. */
const BAR_WIDTH = 20;

/** Waste rates at or above this threshold are flagged yellow. */
const WARN_THRESHOLD_PCT = 15;

/** Waste rates at or above this threshold are flagged red. */
const CRIT_THRESHOLD_PCT = 30;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Colour a waste-rate percentage: green < warn < yellow < crit < red. */
function colorWasteRate(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${pct.toFixed(1)}%`;
  if (pct >= CRIT_THRESHOLD_PCT) return chalk.red(s);
  if (pct >= WARN_THRESHOLD_PCT) return chalk.yellow(s);
  return chalk.green(s);
}

/**
 * Render a horizontal bar for a waste-rate value.
 * 0% = all empty  •  100% = all filled
 */
function renderWasteBar(pct: number | null, width = BAR_WIDTH): string {
  if (pct === null) return chalk.dim("─".repeat(width));
  const filled = Math.min(Math.round((pct / 100) * width), width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  if (pct >= CRIT_THRESHOLD_PCT) return chalk.red(bar);
  if (pct >= WARN_THRESHOLD_PCT) return chalk.yellow(bar);
  return chalk.green(bar);
}

/**
 * Compute a simple trend direction over a series of waste-rate values.
 * Uses a linear regression slope sign: rising → "worse", falling → "better",
 * flat → "stable".  Returns "n/a" when there are fewer than 3 data points.
 */
function trendLabel(rates: number[]): string {
  if (rates.length < 3) return chalk.dim("? n/a (not enough data)");

  // Least-squares slope
  const n = rates.length;
  const sumX = (n * (n - 1)) / 2; // 0+1+…+(n-1)
  const sumX2 = rates.reduce((s, _, i) => s + i * i, 0);
  const sumY = rates.reduce((a, b) => a + b, 0);
  const sumXY = rates.reduce((s, v, i) => s + i * v, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  if (Math.abs(slope) < 0.5) return chalk.cyan("→ stable");
  if (slope > 0) return chalk.red("↑ worsening (more waste)");
  return chalk.green("↓ improving (less waste)");
}

/** Format a per-day row for the trend table. */
function formatDayRow(d: DispatchWasteDay): string {
  const bar = renderWasteBar(d.waste_rate_pct);
  const rate = colorWasteRate(d.waste_rate_pct).padStart(8);
  const stale = String(d.stale_prevented).padStart(7);
  const total = String(d.dispatches_total).padStart(7);
  return `  ${chalk.dim(d.date)}  ${bar}  ${rate}  ${stale}  ${total}`;
}

/** Format a per-hour row for the 24h trend table. */
function formatHourRow(h: DispatchWasteHour): string {
  const bar = renderWasteBar(h.waste_rate_pct);
  const rate = colorWasteRate(h.waste_rate_pct).padStart(8);
  const stale = String(h.stale_prevented).padStart(7);
  const total = String(h.dispatches_total).padStart(7);
  return `  ${chalk.dim(h.hour)}  ${bar}  ${rate}  ${stale}  ${total}`;
}

/** Print a full window section (header + day rows + summary). */
function printWindow(label: string, data: DispatchWasteMetrics): void {
  console.log(chalk.bold(`\n● ${label}`));

  if (data.daily.length === 0) {
    console.log(chalk.dim("  No daemon cycles recorded in this window yet."));
    return;
  }

  const header = [
    "Date      ",
    " ".repeat(BAR_WIDTH),
    "   Rate",
    " Blocked",
    "   Total",
  ].join("  ");
  const sep = "─".repeat(header.length + 2);

  console.log(chalk.dim("  " + header));
  console.log(chalk.dim("  " + sep));

  for (const day of data.daily) {
    console.log(formatDayRow(day));
  }

  console.log(chalk.dim("  " + sep));

  // Summary line
  const avgRate = data.avg_waste_rate_pct !== null
    ? colorWasteRate(data.avg_waste_rate_pct)
    : chalk.dim("—");
  console.log(
    `  ${"Avg waste rate:".padEnd(28)} ${avgRate}   ` +
    `${chalk.dim(`(${data.total_stale_prevented} blocked / ${data.total_dispatches} total)`)}`
  );

  // Trend
  const nonNullRates = data.daily
    .map((d) => d.waste_rate_pct)
    .filter((v): v is number => v !== null);
  console.log(`  ${"Trend:".padEnd(28)} ${trendLabel(nonNullRates)}`);
}

/** Print the 24h rolling window section. */
function printWindow24h(data: DispatchWasteMetrics24h): void {
  console.log(chalk.bold(`\n● Last 24 hours (hourly breakdown)`));

  if (data.hourly.length === 0) {
    console.log(chalk.dim("  No daemon cycles recorded in the last 24 hours yet."));
    return;
  }

  const header = [
    "Hour              ",
    " ".repeat(BAR_WIDTH),
    "   Rate",
    " Blocked",
    "   Total",
  ].join("  ");
  const sep = "─".repeat(header.length + 2);

  console.log(chalk.dim("  " + header));
  console.log(chalk.dim("  " + sep));

  // Only show last 8 hours to keep output concise; use --json for full data
  const displayed = data.hourly.slice(-8);
  if (data.hourly.length > 8) {
    console.log(chalk.dim(`  … (${data.hourly.length - 8} earlier hours omitted — use --json for full data)`));
  }
  for (const h of displayed) {
    console.log(formatHourRow(h));
  }

  console.log(chalk.dim("  " + sep));

  const avgRate = data.avg_waste_rate_pct !== null
    ? colorWasteRate(data.avg_waste_rate_pct)
    : chalk.dim("—");
  const peakRate = data.peak_waste_rate_pct !== null
    ? colorWasteRate(data.peak_waste_rate_pct)
    : chalk.dim("—");
  console.log(
    `  ${"Avg waste rate (24h):".padEnd(28)} ${avgRate}   ` +
    `${chalk.dim(`(${data.total_stale_prevented} blocked / ${data.total_dispatches} total)`)}`
  );
  console.log(
    `  ${"Peak hourly waste rate:".padEnd(28)} ${peakRate}`
  );
}

/**
 * Print the PR detection strategy breakdown (issue #1179).
 * Shows how many blocks were caught by each detection path so operators can
 * judge whether the body-keyword fallback fires in practice.
 */
function printStrategyBreakdown(data: PRDetectionStrategyBreakdown): void {
  console.log(chalk.bold(`\n● PR Detection Strategy Breakdown (last ${data.days} days)`));
  console.log(
    chalk.dim(
      "  Shows which detection path identified the blocking PR for each dispatch block.\n" +
      "  If body_keyword > 0, the search-index lag is a real operational problem.\n"
    )
  );

  if (data.total === 0) {
    console.log(chalk.dim("  No PR-blocked dispatches recorded in this window yet."));
    return;
  }

  const rows: Array<[string, number, string]> = [
    ["search_index", data.search_index, "GitHub search API (primary, scalable)"],
    ["branch_name ", data.branch_name,  "Branch-name pattern (REST paginated fallback)"],
    ["body_keyword", data.body_keyword, "Closing keyword in PR body (cross-variant dedup)"],
  ];
  if (data.unknown > 0) {
    rows.push(["unknown     ", data.unknown, "Recorded before strategy tracking was added"]);
  }

  const maxCount = Math.max(...rows.map((r) => r[1]), 1);

  for (const [label, count, desc] of rows) {
    const pct = data.total > 0 ? (count / data.total) * 100 : 0;
    const barFilled = Math.round((count / maxCount) * 16);
    const bar = "█".repeat(barFilled) + "░".repeat(16 - barFilled);
    const countStr = String(count).padStart(4);
    const pctStr = `${pct.toFixed(0)}%`.padStart(4);
    const highlight = label.trim() === "body_keyword" && count > 0 ? chalk.yellow : chalk.dim;
    console.log(
      `  ${chalk.cyan(label)}  ${highlight(bar)}  ${countStr} ${chalk.dim(`(${pctStr})`)}  ${chalk.dim(desc)}`
    );
  }

  console.log();
  console.log(
    `  ${"Total PR-blocked dispatches:".padEnd(32)} ${chalk.bold(String(data.total))}`
  );

  if (data.body_keyword > 0) {
    console.log(
      chalk.yellow(
        `\n  ⚠  body_keyword fired ${data.body_keyword}× — search-index lag is real. ` +
        "Consider a distributed lock (e.g. Redis) if this rate keeps climbing.\n"
      )
    );
  } else {
    console.log(
      chalk.green(
        "\n  ✓  body_keyword has not fired — search-index lag is theoretical in practice.\n"
      )
    );
  }
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerDispatchEfficiencyCommand(program: Command): void {
  program
    .command("dispatch-efficiency")
    .description(
      "Show dispatch waste-rate widget: % of dispatches blocked by the issue-state cache"
    )
    .option("--json", "Output raw JSON instead of formatted tables")
    .action((opts: { json?: boolean }) => {
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

      let data24h: DispatchWasteMetrics24h;
      let data7: DispatchWasteMetrics;
      let strategyBreakdown: PRDetectionStrategyBreakdown;
      try {
        data24h = store.getDispatchWasteMetrics24h();
        data7 = store.getDispatchWasteMetrics(7);
        strategyBreakdown = store.getPRDetectionStrategyBreakdown(7);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify({ "24h": data24h, "7d": data7, strategy_breakdown: strategyBreakdown }, null, 2));
        return;
      }

      console.log(chalk.bold("\n◆ Dispatch Efficiency — Issue-State Cache Waste Rate\n"));
      console.log(
        chalk.dim(
          "  Tracks dispatches blocked by the issue-state cache (closed issues, existing PRs).\n" +
          "  A falling waste rate confirms the cache is reducing wasted agent cycles.\n"
        )
      );

      printWindow24h(data24h);
      printWindow("Last 7 days", data7);
      printStrategyBreakdown(strategyBreakdown);

      // Overall health note
      const rate = data7.avg_waste_rate_pct;
      if (rate === null) {
        console.log(
          chalk.dim(
            "\n  No waste-rate data yet — the daemon needs at least one full cycle to record metrics.\n" +
            "  Ensure `staleDispatchesPrevented` is passed to `recordCycleEnd()` in the daemon loop.\n"
          )
        );
      } else if (rate >= CRIT_THRESHOLD_PCT) {
        console.log(
          chalk.red(
            `\n  ⚠  High waste rate detected (${rate.toFixed(1)}%). ` +
            "Check TTL cache settings or whether the issue-state cache is being populated correctly.\n"
          )
        );
      } else if (rate >= WARN_THRESHOLD_PCT) {
        console.log(
          chalk.yellow(
            `\n  ⚠  Elevated waste rate (${rate.toFixed(1)}%). ` +
            "Monitor over the next few cycles.\n"
          )
        );
      } else {
        console.log(
          chalk.green(
            `\n  ✓  Waste rate is healthy (${rate.toFixed(1)}%). Cache is functioning correctly.\n`
          )
        );
      }

      console.log(
        chalk.dim(
          "  Run `orch dispatch-efficiency --json` for machine-readable output.\n" +
          "  Telegram alerts fire when the waste rate exceeds 15% in any 1h window.\n"
        )
      );
    });
}
