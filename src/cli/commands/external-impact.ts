/**
 * `orch external-impact` — External-Impact Ratio Widget (issue #1372)
 *
 * Shows what fraction of fleet dispatch work over the last N days targeted
 * external-facing repos (revenue, product, user-facing) versus the fleet's
 * own internal infrastructure repos.
 *
 * A 7-day ratio below 30% triggers the navel-gazing alert, meaning the fleet
 * is spending more than 70% of cycles on internal housekeeping instead of
 * work that moves OKRs.
 *
 * This is Layer 1 of the anti-navel-gazing controls re-implemented from
 * issue #1262 (reverted by #1348).
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type ExternalImpactDay,
  type ExternalImpactRatioResult,
} from "../../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Bar chart width in characters. */
const BAR_WIDTH = 20;

/** Ratio at or above this threshold is healthy (green). */
const HEALTHY_THRESHOLD_PCT = 30;

/** Ratio below this threshold is a warning (yellow). */
const WARN_THRESHOLD_PCT = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Colour a ratio percentage: red < 30 < yellow < 50 < green. */
function colorRatio(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${pct.toFixed(1)}%`;
  if (pct < HEALTHY_THRESHOLD_PCT) return chalk.red(s);
  if (pct < WARN_THRESHOLD_PCT) return chalk.yellow(s);
  return chalk.green(s);
}

/** Render a split bar: external (green) / internal (red). */
function renderSplitBar(pct: number | null, width = BAR_WIDTH): string {
  if (pct === null) return chalk.dim("─".repeat(width));
  const externalFilled = Math.min(Math.round((pct / 100) * width), width);
  const internalFilled = width - externalFilled;
  const bar =
    chalk.green("█".repeat(externalFilled)) +
    chalk.red("░".repeat(internalFilled));
  return bar;
}

/** Format a per-day row for the trend table. */
function formatDayRow(d: ExternalImpactDay): string {
  const bar = renderSplitBar(d.ratio_pct);
  const ratio = colorRatio(d.ratio_pct).padStart(8);
  const ext = chalk.green(String(d.external).padStart(5));
  const int_ = chalk.red(String(d.internal).padStart(5));
  return `  ${chalk.dim(d.date)}  ${bar}  ${ratio}  ${ext} ext  ${int_} int`;
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerExternalImpactCommand(program: Command): void {
  program
    .command("external-impact")
    .description(
      "Show external-impact ratio: % of work targeting external repos vs fleet-internal infra"
    )
    .option("-d, --days <n>", "Rolling window in days", "7")
    .option("--json", "Output raw JSON instead of formatted table")
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

      let result: ExternalImpactRatioResult;
      try {
        result = store.getExternalImpactRatio(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold("\n◆ External-Impact Ratio — Anti-Navel-Gazing Monitor\n"));
      console.log(
        chalk.dim(
          "  Tracks what fraction of fleet work targets external-facing repos vs\n" +
          "  the fleet's own infrastructure (rapartlu/agent-*). Alert fires when\n" +
          "  ratio drops below 30% over a 7-day window.\n"
        )
      );

      // Summary section
      console.log(chalk.bold(`● Last ${days} days`));
      console.log();

      if (result.total_tasks === 0) {
        console.log(chalk.dim("  No tasks recorded in this window yet.\n"));
        return;
      }

      const ratioStr = colorRatio(result.ratio_pct);
      const bar = renderSplitBar(result.ratio_pct);
      console.log(
        `  ${bar}  ${ratioStr} external   ` +
        chalk.dim(`(${result.external_tasks} ext / ${result.total_tasks} total)`)
      );
      console.log();

      // Status verdict
      if (result.alert) {
        console.log(
          chalk.red.bold(
            `  🚨 NAVEL-GAZING ALERT: external-impact ratio is ${result.ratio_pct?.toFixed(1)}%.\n` +
            "     The fleet is spending >70% of cycles on internal housekeeping.\n" +
            "     Pause internal work and route next dispatches to OKR-tagged issues."
          )
        );
      } else if (result.ratio_pct !== null && result.ratio_pct < WARN_THRESHOLD_PCT) {
        console.log(
          chalk.yellow(
            `  ⚠  Ratio is below 50% (${result.ratio_pct.toFixed(1)}%). ` +
            "Consider prioritising more external-facing work."
          )
        );
      } else {
        console.log(
          chalk.green(
            `  ✓  External-impact ratio is healthy (${result.ratio_pct?.toFixed(1)}%).`
          )
        );
      }

      console.log();

      // Daily sparkline
      if (result.daily.length > 0) {
        console.log(chalk.bold("● Daily breakdown"));
        console.log();

        const header = [
          "Date      ",
          " ".repeat(BAR_WIDTH),
          "   Ratio",
          "   Ext",
          "   Int",
        ].join("  ");
        const sep = "─".repeat(header.length + 2);
        console.log(chalk.dim("  " + header));
        console.log(chalk.dim("  " + sep));

        for (const day of result.daily) {
          console.log(formatDayRow(day));
        }

        console.log(chalk.dim("  " + sep));
        console.log();
      }

      // Breakdown summary
      console.log(
        chalk.dim("  Classification: external = source_ref NOT in rapartlu/agent-* repos\n") +
        chalk.dim("  Internal = no source_ref OR source_ref in rapartlu/agent-* (fleet infra)\n") +
        chalk.dim("  Run `orch external-impact --json` for machine-readable output.\n") +
        chalk.dim("  Alert threshold: ratio_pct < 30 over a 7-day window.\n")
      );
    });
}
