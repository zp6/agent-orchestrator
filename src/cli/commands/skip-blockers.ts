/**
 * `orch skip-blockers` — Top dispatch skip blockers this week (issue #787)
 *
 * Aggregates skip reasons from the supervisor_decisions table over a rolling
 * 7-day window and shows the top repeat blockers with counts, affected agents,
 * and sample issue refs.  Any reason that has exceeded the systemic threshold
 * is highlighted and marked as a blocker.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { SYSTEMIC_SKIP_THRESHOLD, SKIP_PATTERN_WINDOW_DAYS } from "../../orchestrator/skip-pattern-aggregator.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function colorCount(count: number): string {
  if (count >= SYSTEMIC_SKIP_THRESHOLD * 3) return chalk.red(String(count));
  if (count >= SYSTEMIC_SKIP_THRESHOLD) return chalk.yellow(String(count));
  return chalk.dim(String(count));
}

function formatRelativeTime(iso: string): string {
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

// ── Command registration ───────────────────────────────────────────────────────

export function registerSkipBlockersCommand(program: Command): void {
  program
    .command("skip-blockers")
    .description(
      `Show top dispatch skip blockers over the last ${SKIP_PATTERN_WINDOW_DAYS} days. ` +
      `Reasons with >=${SYSTEMIC_SKIP_THRESHOLD} skips are flagged as systemic blockers.`
    )
    .option("--json", "Output raw JSON instead of formatted tables")
    .option(
      "--window <days>",
      `Rolling window in days (default: ${SKIP_PATTERN_WINDOW_DAYS})`,
      String(SKIP_PATTERN_WINDOW_DAYS),
    )
    .option(
      "--limit <n>",
      "Maximum number of reasons to show (default: 20)",
      "20",
    )
    .action((opts: { json?: boolean; window?: string; limit?: string }) => {
      const windowDays = Math.max(1, parseInt(opts.window ?? String(SKIP_PATTERN_WINDOW_DAYS), 10));
      const limit = Math.max(1, parseInt(opts.limit ?? "20", 10));

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

      let patterns;
      let activeKeys: Set<string>;
      try {
        patterns = store.getSkipPatterns(windowDays).slice(0, limit);
        activeKeys = store.getActiveSkipPatternIssueKeys();
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(
          { window_days: windowDays, patterns, active_issue_keys: [...activeKeys] },
          null,
          2,
        ));
        return;
      }

      console.log(chalk.bold(`\n◆ Top Dispatch Skip Blockers — Last ${windowDays} Days\n`));
      console.log(
        chalk.dim(
          `  Skips where reason appears >=${SYSTEMIC_SKIP_THRESHOLD}x in the window are flagged as systemic blockers.\n` +
          `  Run \`orch decisions --outcome skipped\` to see individual skip decisions.\n`
        )
      );

      if (patterns.length === 0) {
        console.log(chalk.dim("  No skipped dispatches recorded in this window.\n"));
        return;
      }

      let systemicCount = 0;

      for (const row of patterns) {
        const isSystemic = row.skip_count >= SYSTEMIC_SKIP_THRESHOLD;
        const hasIssue = activeKeys.size > 0; // simplified indicator

        if (isSystemic) systemicCount++;

        const badge = isSystemic
          ? chalk.bgRed.white(" BLOCKER ")
          : chalk.bgGray.white(" ok      ");

        const count = colorCount(row.skip_count).padStart(isSystemic ? 8 : 8);

        console.log(`  ${badge}  ${count}x  ${chalk.bold(row.reason)}`);

        if (row.affected_agents.length > 0) {
          console.log(`           ${chalk.dim("agents:")} ${row.affected_agents.join(", ")}`);
        }
        if (row.sample_issue_refs.length > 0) {
          console.log(`           ${chalk.dim("refs:  ")} ${row.sample_issue_refs.slice(0, 5).join(", ")}`);
        }
        console.log(
          `           ${chalk.dim("window:")} ${formatRelativeTime(row.first_seen)} → ${formatRelativeTime(row.last_seen)}`
        );
        console.log();
      }

      // Summary line
      const totalSkips = patterns.reduce((s, p) => s + p.skip_count, 0);
      console.log(chalk.dim(`  ${patterns.length} distinct skip reasons · ${totalSkips} total skips in window`));

      if (systemicCount > 0) {
        console.log(
          chalk.yellow(
            `\n  ⚠  ${systemicCount} systemic blocker(s) detected. ` +
            `Run \`orch skip-blockers --json\` to get machine-readable output, ` +
            `or check GitHub for auto-created blocker issues.\n`
          )
        );
      } else {
        console.log(chalk.green("\n  ✓  No systemic blockers above threshold.\n"));
      }

      console.log(
        chalk.dim(`  Run \`orch skip-blockers --window 30\` for a 30-day view.\n`)
      );
    });
}
