/**
 * `orch dispatch-hang-watch` — Dispatch hang suppression monitor (issue #1374)
 *
 * Shows source_refs currently meeting the chronic-dispatch-hang threshold:
 * source_refs where >= N tasks have failed or been retried within the last M
 * hours, indicating the dispatch is repeatedly timing out the daemon.
 *
 * These source_refs are suppressed by the pre-dispatch validator until the
 * failure count drops below threshold (naturally, via time window expiry) or
 * an operator manually investigates and resets.
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type SourceRefHangSuppression,
  type SourceRefHangStats,
} from "../../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default suppression threshold — matches pre-dispatch-validator default. */
const DEFAULT_THRESHOLD = 3;

/** Default window in hours — matches pre-dispatch-validator default. */
const DEFAULT_WINDOW_HOURS = 24;

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorRetryCount(n: number): string {
  if (n === 0) return chalk.green(String(n));
  if (n <= 1) return chalk.yellow(String(n));
  return chalk.red(String(n));
}

function colorFailedCount(failed: number, total: number, threshold: number): string {
  const s = `${failed}/${total}`;
  if (failed >= threshold) return chalk.red(s);
  if (failed > 0) return chalk.yellow(s);
  return chalk.green(s);
}

function formatAge(iso: string | null): string {
  if (!iso) return chalk.dim("—");
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return chalk.dim(`${mins}m ago`);
  const hrs = (diffMs / 3600000).toFixed(1);
  return chalk.dim(`${hrs}h ago`);
}

function printSuppressedTable(
  items: SourceRefHangSuppression[],
  threshold: number,
): void {
  if (items.length === 0) {
    console.log(chalk.green("  ✓  No source_refs are currently hang-suppressed.\n"));
    return;
  }

  const header = [
    "Source ref".padEnd(48),
    "Failed/Total".padEnd(14),
    "Max retry".padEnd(11),
    "First seen".padEnd(14),
    "Last seen",
  ].join("  ");
  const sep = "─".repeat(header.length + 2);

  console.log(chalk.dim("  " + header));
  console.log(chalk.dim("  " + sep));

  for (const item of items) {
    const s: SourceRefHangStats = item.stats;
    const ref = chalk.cyan(s.source_ref.padEnd(48));
    const failed = colorFailedCount(s.failed_or_retried_count, s.total_tasks, threshold).padEnd(14);
    const maxRetry = colorRetryCount(s.max_retry_count).padEnd(11);
    const first = formatAge(s.oldest_at).padEnd(14);
    const last = formatAge(s.newest_at);
    console.log(`  ${ref}  ${failed}  ${maxRetry}  ${first}  ${last}`);
  }

  console.log(chalk.dim("  " + sep));
}

// ── Command registration ───────────────────────────────────────────────────────

export function registerDispatchHangWatchCommand(program: Command): void {
  program
    .command("dispatch-hang-watch")
    .description(
      "Show source_refs suppressed by the dispatch-hang antibody (issue #1374)"
    )
    .option("-t, --threshold <n>", "Failure count threshold for suppression", String(DEFAULT_THRESHOLD))
    .option("-w, --window <hours>", "Rolling window in hours", String(DEFAULT_WINDOW_HOURS))
    .option("-l, --limit <n>", "Max rows to show", "50")
    .option("--check <source-ref>", "Check a specific source_ref")
    .option("--json", "Output raw JSON")
    .action((opts: {
      threshold: string;
      window: string;
      limit: string;
      check?: string;
      json?: boolean;
    }) => {
      const threshold = Math.max(1, parseInt(opts.threshold, 10) || DEFAULT_THRESHOLD);
      const windowHours = Math.max(1, parseInt(opts.window, 10) || DEFAULT_WINDOW_HOURS);
      const limit = Math.max(1, parseInt(opts.limit, 10) || 50);

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

      try {
        // ── Single source_ref check ──────────────────────────────────────────
        if (opts.check) {
          const result = store.checkSourceRefHangSuppression(
            opts.check,
            threshold,
            windowHours,
          );

          if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }

          console.log(chalk.bold(`\n◆ Dispatch-Hang Check: ${opts.check}\n`));

          if (result.suppressed) {
            console.log(chalk.red(`  ⛔ SUPPRESSED\n`));
            console.log(chalk.dim(`  ${result.reason}\n`));
          } else {
            console.log(chalk.green(`  ✓  NOT suppressed\n`));
            console.log(chalk.dim(`  ${result.reason}\n`));
          }

          const s = result.stats;
          console.log(`  Total tasks (${windowHours}h window): ${s.total_tasks}`);
          console.log(`  Failed/retried:                    ${colorFailedCount(s.failed_or_retried_count, s.total_tasks, threshold)}`);
          console.log(`  Max retry_count seen:              ${colorRetryCount(s.max_retry_count)}`);
          console.log(`  First task in window:              ${formatAge(s.oldest_at)}`);
          console.log(`  Most recent task:                  ${formatAge(s.newest_at)}`);
          console.log();
          return;
        }

        // ── Full list ────────────────────────────────────────────────────────
        const suppressed = store.getHangSuppressedSourceRefs(threshold, windowHours, limit);

        if (opts.json) {
          console.log(JSON.stringify(suppressed, null, 2));
          return;
        }

        console.log(chalk.bold("\n◆ Dispatch-Hang Watch — Suppressed Source Refs\n"));
        console.log(
          chalk.dim(
            `  Suppression threshold: ${threshold} failed/retried tasks in last ${windowHours}h.\n` +
            "  These source_refs are blocked by the pre-dispatch validator.\n" +
            "  Suppression lifts automatically once the window expires.\n"
          )
        );

        printSuppressedTable(suppressed, threshold);

        if (suppressed.length > 0) {
          console.log(
            chalk.yellow(
              `  ⚠  ${suppressed.length} source_ref(s) suppressed. ` +
              "Operator: investigate root cause before tasks re-enter the queue.\n"
            )
          );
        }

        console.log(
          chalk.dim(
            `  Check a specific ref: orch dispatch-hang-watch --check "owner/repo#N"\n` +
            `  Adjust threshold:     orch dispatch-hang-watch --threshold ${threshold} --window ${windowHours}\n`
          )
        );
      } finally {
        store.close();
      }
    });
}
