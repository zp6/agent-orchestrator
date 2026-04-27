/**
 * `orch variant-duplicates` — Variant-pair dispatch duplication report (issue #1270)
 *
 * Lists (repo, issue, variant-A, variant-B, count) pairs where both pool
 * siblings hit the "already-in-review" guard within a single dispatch window,
 * producing redundant guard tasks.
 *
 * Usage:
 *   orch variant-duplicates                  # last 24 hours
 *   orch variant-duplicates --hours 48       # last 48 hours
 *   orch variant-duplicates --json           # raw JSON output
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import {
  getVariantDuplicatesPayload,
  DEFAULT_WINDOW_HOURS,
  MAX_WINDOW_HOURS,
} from "../../reviewer/variant-deduplication.js";

function formatRelative(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

export function registerVariantDuplicatesCommand(program: Command): void {
  program
    .command("variant-duplicates")
    .description(
      "List (repo, issue, variant-A, variant-B, count) pairs where both Claude/Codex " +
      "pool siblings hit the already-in-review guard within the same dispatch window.",
    )
    .option(
      "--hours <n>",
      `Look-back window in hours (default: ${DEFAULT_WINDOW_HOURS}, max: ${MAX_WINDOW_HOURS})`,
      String(DEFAULT_WINDOW_HOURS),
    )
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { hours?: string; json?: boolean }) => {
      const windowHours = Math.min(
        Math.max(parseInt(opts.hours ?? String(DEFAULT_WINDOW_HOURS), 10) || DEFAULT_WINDOW_HOURS, 1),
        MAX_WINDOW_HOURS,
      );

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

      let payload;
      try {
        payload = getVariantDuplicatesPayload(store, windowHours);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(chalk.bold(`\n◆ Variant-Pair Dispatch Duplicates — Last ${windowHours}h\n`));
      console.log(
        chalk.dim(
          `  Issues where both Claude and Codex pool siblings hit the "already-in-review"\n` +
          `  guard within a 2-hour window, producing redundant guard tasks.\n`,
        ),
      );

      if (payload.total_pairs === 0) {
        console.log(chalk.green("  ✓  No variant-pair guard collisions in this window.\n"));
        return;
      }

      console.log(
        chalk.yellow(
          `  ${payload.total_pairs} issue(s) triggered dual-variant guard hits → ` +
          `${payload.total_redundant_tasks} redundant guard tasks\n`,
        ),
      );

      // Header row
      const COL_REF   = 38;
      const COL_VA    = 26;
      const COL_VB    = 26;
      const COL_EVTS  = 8;
      const COL_WASTE = 8;
      const COL_LAST  = 12;

      const header =
        chalk.dim("Issue".padEnd(COL_REF)) +
        chalk.dim("Variant A".padEnd(COL_VA)) +
        chalk.dim("Variant B".padEnd(COL_VB)) +
        chalk.dim("Events".padStart(COL_EVTS)) +
        chalk.dim("Wasted".padStart(COL_WASTE)) +
        chalk.dim("  Last seen".padEnd(COL_LAST));
      console.log("  " + header);
      console.log("  " + chalk.dim("─".repeat(COL_REF + COL_VA + COL_VB + COL_EVTS + COL_WASTE + COL_LAST + 2)));

      for (const pair of payload.pairs) {
        const evtColor = pair.event_count >= 5 ? chalk.red : pair.event_count >= 2 ? chalk.yellow : chalk.dim;
        console.log(
          "  " +
          chalk.cyan(pair.source_ref.padEnd(COL_REF)) +
          pair.variant_a.padEnd(COL_VA) +
          pair.variant_b.padEnd(COL_VB) +
          evtColor(String(pair.event_count).padStart(COL_EVTS)) +
          chalk.dim(String(pair.redundant_tasks).padStart(COL_WASTE)) +
          chalk.dim(("  " + formatRelative(pair.last_seen)).padEnd(COL_LAST)),
        );
      }

      console.log();
      console.log(
        chalk.dim(
          `  ${payload.total_pairs} pair(s) · ${payload.total_redundant_tasks} redundant guard tasks in window\n` +
          `  Run \`orch variant-duplicates --hours 168\` for a 7-day view,\n` +
          `  or \`orch variant-duplicates --json\` for machine-readable output.\n`,
        ),
      );
    });
}
