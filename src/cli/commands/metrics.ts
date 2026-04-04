import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type WindowedAgentMetrics } from "../../state/store.js";

/** Format milliseconds as a human-readable duration: "2m 34s", "1h 12m", etc. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return chalk.dim("—");
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

/** Format a percentage as "34%" or "—" if null. */
export function formatPct(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  return `${Math.round(pct)}%`;
}

/** Format a quality score as "0.87" or "—" if null. */
export function formatScore(score: number | null): string {
  if (score === null) return chalk.dim("—");
  const s = score.toFixed(2);
  if (score >= 0.9) return chalk.green(s);
  if (score >= 0.7) return chalk.yellow(s);
  return chalk.red(s);
}

/** Color a fail % value: green if 0, yellow if <20%, red otherwise. */
export function colorFailPct(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${Math.round(pct)}%`;
  if (pct === 0) return chalk.green(s);
  if (pct < 20) return chalk.yellow(s);
  return chalk.red(s);
}

/** Color a rejection % value: green if 0, yellow if <30%, red otherwise. */
export function colorRejectionPct(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${Math.round(pct)}%`;
  if (pct === 0) return chalk.green(s);
  if (pct < 30) return chalk.yellow(s);
  return chalk.red(s);
}

/** Format a trend direction as a short colored symbol + label. */
export function formatTrend(direction: WindowedAgentMetrics["trend"]): string {
  switch (direction) {
    case "improving":      return chalk.green("↑ improving");
    case "declining":      return chalk.red("↓ declining");
    case "stable":         return chalk.cyan("→ stable");
    case "insufficient_data": return chalk.dim("? n/a");
  }
}

export function registerMetricsCommand(program: Command): void {
  program
    .command("metrics")
    .description("Per-agent productivity and quality metrics for the last N days")
    .option("-d, --days <n>", "Rolling window in days", "7")
    .option("--json", "Output raw JSON instead of a formatted table")
    .action((opts: { days: string; json?: boolean }) => {
      const days = parseInt(opts.days, 10);
      if (isNaN(days) || days < 1) {
        console.error(chalk.red("Error: --days must be a positive integer"));
        process.exit(1);
      }

      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(chalk.red("Could not open state database:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      let rows: WindowedAgentMetrics[];
      try {
        rows = store.getWindowedAgentMetrics(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      console.log(chalk.bold(`\n● Agent Metrics — last ${days} day${days === 1 ? "" : "s"}\n`));

      if (rows.length === 0) {
        console.log(chalk.dim("  No task data in this window. Dispatch some tasks first."));
        console.log();
        return;
      }

      // Column widths
      const COL = {
        agent:    32,
        done:      6,
        total:     7,
        failPct:   7,
        rejPct:    9,
        quality:   9,
        duration: 10,
        trend:    14,
      };

      const header = [
        "Agent".padEnd(COL.agent),
        "Done".padStart(COL.done),
        "Total".padStart(COL.total),
        "Fail%".padStart(COL.failPct),
        "Reject%".padStart(COL.rejPct),
        "Quality".padStart(COL.quality),
        "Avg Time".padStart(COL.duration),
        "Trend",
      ].join("  ");

      const separator = "─".repeat(header.length);

      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + separator));

      for (const row of rows) {
        const line = [
          chalk.cyan(row.agent_name.padEnd(COL.agent)),
          chalk.green(String(row.done).padStart(COL.done)),
          String(row.total).padStart(COL.total),
          colorFailPct(row.fail_pct).padStart(COL.failPct),
          colorRejectionPct(row.rejection_pct).padStart(COL.rejPct),
          formatScore(row.avg_quality_score).padStart(COL.quality),
          formatDuration(row.avg_duration_ms).padStart(COL.duration),
          formatTrend(row.trend),
        ].join("  ");
        console.log("  " + line);
      }

      // Summary footer
      const totalDone = rows.reduce((s, r) => s + r.done, 0);
      const totalAll = rows.reduce((s, r) => s + r.total, 0);
      const totalFailed = rows.reduce((s, r) => s + r.failed, 0);
      const qualityScores = rows.map((r) => r.avg_quality_score).filter((s): s is number => s !== null);
      const globalQuality = qualityScores.length > 0
        ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
        : null;

      console.log(chalk.dim("  " + separator));

      const footerLine = [
        chalk.bold("All agents").padEnd(COL.agent),
        chalk.green(chalk.bold(String(totalDone))).padStart(COL.done),
        String(totalAll).padStart(COL.total),
        colorFailPct(totalAll > 0 ? (totalFailed / totalAll) * 100 : null).padStart(COL.failPct),
        chalk.dim("—").padStart(COL.rejPct),
        formatScore(globalQuality).padStart(COL.quality),
        chalk.dim("—").padStart(COL.duration),
        chalk.dim(""),
      ].join("  ");
      console.log("  " + footerLine);

      console.log();
      console.log(chalk.dim(`  Run \`orch metrics --days 30\` for a wider window, or \`--json\` for machine-readable output.`));
      console.log();
    });
}
