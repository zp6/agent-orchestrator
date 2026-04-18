import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

const ALERT_THRESHOLD = 0.30;

/** Format a ratio as a colored percentage string. */
function formatRatioPct(ratio: number): string {
  const pct = `${Math.round(ratio * 100)}%`;
  if (ratio > ALERT_THRESHOLD) return chalk.red.bold(pct);
  if (ratio > 0.15) return chalk.yellow(pct);
  return chalk.green(pct);
}

export function registerReviewSaturationCommand(program: Command): void {
  program
    .command("review-saturation")
    .description(
      "Fleet health: ratio of 'already-in-review' dedup responses over a rolling window",
    )
    .option(
      "-w, --window <hours>",
      "Rolling look-back window in hours",
      "1",
    )
    .option("--json", "Output raw JSON instead of a formatted table")
    .action((opts: { window: string; json?: boolean }) => {
      const windowHours = parseFloat(opts.window);
      if (isNaN(windowHours) || windowHours <= 0) {
        console.error(chalk.red("Error: --window must be a positive number"));
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

      let data: ReturnType<StateStore["getAlreadyInReviewSaturation"]>;
      try {
        data = store.getAlreadyInReviewSaturation(windowHours);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify({ ...data, threshold: ALERT_THRESHOLD }, null, 2));
        return;
      }

      const windowLabel = windowHours === 1 ? "1 hour" : `${windowHours} hours`;
      console.log(chalk.bold(`\n● Already-in-Review Saturation — last ${windowLabel}\n`));

      // Fleet summary
      const pct = Math.round(data.ratio * 100);
      const statusIcon = data.ratio > ALERT_THRESHOLD ? "⚠ " : "✓ ";
      const statusLabel = data.ratio > ALERT_THRESHOLD
        ? chalk.red.bold(`${statusIcon}HIGH — above ${Math.round(ALERT_THRESHOLD * 100)}% alert threshold`)
        : chalk.green(`${statusIcon}OK`);

      console.log(`  Fleet ratio : ${formatRatioPct(data.ratio)}  (${data.alreadyInReview} of ${data.total} done tasks)`);
      console.log(`  Status      : ${statusLabel}`);
      console.log(`  Threshold   : ${Math.round(ALERT_THRESHOLD * 100)}%`);
      console.log();

      if (data.total === 0) {
        console.log(chalk.dim("  No completed tasks found in this window.\n"));
        return;
      }

      if (data.perAgent.length === 0) {
        console.log(chalk.dim("  No per-agent breakdown available.\n"));
        return;
      }

      // Per-agent breakdown
      console.log(chalk.bold("  Per-agent breakdown:\n"));

      const colWidths = { agent: 32, ratio: 8, count: 24 };
      const header = [
        "Agent".padEnd(colWidths.agent),
        "Ratio".padStart(colWidths.ratio),
        "Already-in-review / Total".padStart(colWidths.count),
      ].join("  ");
      console.log(chalk.dim(`  ${header}`));
      console.log(chalk.dim(`  ${"─".repeat(header.length)}`));

      for (const row of data.perAgent) {
        const name = row.agent_name.length > colWidths.agent
          ? row.agent_name.slice(0, colWidths.agent - 1) + "…"
          : row.agent_name.padEnd(colWidths.agent);
        const ratio = formatRatioPct(row.ratio).padStart(colWidths.ratio);
        const counts = `${row.alreadyInReview} / ${row.total}`.padStart(colWidths.count);
        console.log(`  ${name}  ${ratio}  ${counts}`);
      }
      console.log();

      if (data.ratio > ALERT_THRESHOLD) {
        console.log(
          chalk.yellow(
            `  Tip: A high ratio often means PR throughput has fallen behind issue intake,\n` +
            `  or the dispatch dedup check is not filtering duplicates early enough.\n` +
            `  Review recent dispatch decisions with \`orch decisions\` or check open PRs per agent.\n`,
          ),
        );
      }
    });
}
