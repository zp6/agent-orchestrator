import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

/**
 * CLI command: `orch standup-quality`
 *
 * Sub-commands:
 *   orch standup-quality backfill   Backfill standup_quality_history from historical tasks
 */
export function registerStandupQualityCommand(program: Command): void {
  const sq = program
    .command("standup-quality")
    .description("Standup quality history management");

  // ── backfill ───────────────────────────────────────────────────────────────

  sq.command("backfill")
    .description(
      "Backfill standup_quality_history from historical verified standup tasks (idempotent)",
    )
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      const store = new StateStore();
      const inserted = store.backfillStandupQualityHistory();

      if (opts.json) {
        console.log(JSON.stringify({ inserted }, null, 2));
        return;
      }

      if (inserted === 0) {
        console.log(
          chalk.green("✓") +
            " Backfill complete — no new rows (table already up to date or no historical standup tasks found)",
        );
      } else {
        console.log(
          chalk.green("✓") +
            ` Backfill complete — inserted ${chalk.cyan(String(inserted))} row${inserted === 1 ? "" : "s"} into standup_quality_history`,
        );
      }
    });
}
