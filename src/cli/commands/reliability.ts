import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type AgentReliabilityScore } from "../../state/store.js";

/**
 * Format reliability score with color coding:
 * - Green: 90–100 (excellent)
 * - Yellow: 70–89 (good, watchlist)
 * - Red: <70 (at-risk / critical)
 */
export function formatReliabilityScore(score: number): string {
  const s = Math.round(score);
  if (score >= 90) return chalk.green(s);
  if (score >= 70) return chalk.yellow(s);
  return chalk.red(s);
}

/**
 * Format trend direction with icon and color.
 */
export function formatTrendIcon(trend: AgentReliabilityScore["trend"]): string {
  switch (trend) {
    case "improving":         return chalk.green("↑");
    case "stable":            return chalk.cyan("→");
    case "declining":         return chalk.red("↓");
    case "insufficient_data": return chalk.dim("?");
  }
}

/**
 * Generate a simple ASCII sparkline (7 characters) representing trend.
 * This is a placeholder — in production, would call getAgentReliabilityTrend()
 * and render actual daily scores as: ▁ ▂ ▃ ▄ ▅ ▆ ▇ █
 */
export function formatSparkline(trend: AgentReliabilityScore["trend"]): string {
  const bars = "▁▂▃▄▅▆▇█";
  if (trend === "improving") {
    return bars.substring(2); // Show ascending trend
  }
  if (trend === "declining") {
    return bars.split("").reverse().join("").substring(2); // Show descending
  }
  // Stable: middle range
  return "▄▄▄▄▄▄▄▄".substring(0, 7);
}

/**
 * Format a percentage for antibody rate: "95%" or "—" if null.
 */
export function formatAntibodyRate(rate: number | null): string {
  if (rate === null) return chalk.dim("—");
  const pct = Math.round(rate * 100);
  if (pct >= 90) return chalk.green(`${pct}%`);
  if (pct >= 70) return chalk.yellow(`${pct}%`);
  return chalk.red(`${pct}%`);
}

/**
 * Format iteration cost: "1.5 rounds" or "—" if null.
 */
export function formatIterationCost(cost: number | null): string {
  if (cost === null) return chalk.dim("—");
  if (cost <= 1.0) return chalk.green(cost.toFixed(1));
  if (cost <= 1.5) return chalk.yellow(cost.toFixed(1));
  return chalk.red(cost.toFixed(1));
}

export function registerReliabilityCommand(program: Command): void {
  program
    .command("reliability")
    .description("Per-agent unified reliability score (0–100): crash frequency, iteration cost, antibody hit rate")
    .option("-d, --days <n>", "Lookback window in days", "30")
    .option("--json", "Output raw JSON instead of a formatted table")
    .option("--detail", "Show detailed component breakdown per agent")
    .action((opts: { days: string; json?: boolean; detail?: boolean }) => {
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

      let scores: AgentReliabilityScore[];
      try {
        scores = store.getAgentReliabilityScores(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(scores, null, 2));
        return;
      }

      console.log(chalk.bold(`\n● Agent Reliability Scores — last ${days} day${days === 1 ? "" : "s"}\n`));

      if (scores.length === 0) {
        console.log(chalk.dim("  No task data in this window. Dispatch some tasks first."));
        console.log();
        return;
      }

      // Summary header
      const COL = {
        agent:      30,
        score:       6,
        trend:       4,
        sparkline:   8,
        crashes:     8,
        iteration:  10,
        antibody:    8,
      };

      const summaryHeader = [
        "Agent".padEnd(COL.agent),
        "Score".padStart(COL.score),
        "Trend".padStart(COL.trend),
        "7d ▁▂▃".padEnd(COL.sparkline),
        "Crashes".padStart(COL.crashes),
        "Iter Avg".padStart(COL.iteration),
        "Approval".padStart(COL.antibody),
      ].join("  ");

      const separator = "─".repeat(summaryHeader.length);

      console.log(chalk.dim("  " + summaryHeader));
      console.log(chalk.dim("  " + separator));

      for (const score of scores) {
        const line = [
          chalk.cyan(score.agent_name.padEnd(COL.agent)),
          formatReliabilityScore(score.reliability_score).padStart(COL.score),
          formatTrendIcon(score.trend).padStart(COL.trend),
          chalk.dim(formatSparkline(score.trend).padEnd(COL.sparkline)),
          String(score.consecutive_failures).padStart(COL.crashes),
          formatIterationCost(score.avg_iteration_cost).padStart(COL.iteration),
          formatAntibodyRate(score.antibody_hit_rate).padStart(COL.antibody),
        ].join("  ");
        console.log("  " + line);
      }

      console.log(chalk.dim("  " + separator));

      // Summary footer
      const avgScore = scores.reduce((s, r) => s + r.reliability_score, 0) / scores.length;
      const healthyCount = scores.filter((s) => s.reliability_score >= 90).length;
      const riskCount = scores.filter((s) => s.reliability_score < 70).length;

      const footerLine = [
        chalk.bold(`All agents (avg: ${Math.round(avgScore)})`).padEnd(COL.agent),
        formatReliabilityScore(avgScore).padStart(COL.score),
        `${healthyCount} healthy`.padStart(COL.trend + COL.sparkline + 2),
        chalk.red(`${riskCount} at-risk`).padStart(COL.crashes + 2),
        chalk.dim("—").padStart(COL.iteration),
        chalk.dim("—").padStart(COL.antibody),
      ].join("  ");
      console.log("  " + footerLine);

      console.log();

      // Optional detailed breakdown
      if (opts.detail) {
        console.log(chalk.bold("\n● Component Breakdown\n"));

        for (const score of scores) {
          const crashStatus =
            score.consecutive_failures === 0
              ? chalk.green("✓ healthy")
              : chalk.red(`✗ ${score.consecutive_failures} consecutive failures`);

          const iterationStatus =
            score.avg_iteration_cost === null
              ? chalk.dim("—")
              : score.avg_iteration_cost <= 1.0
                ? chalk.green(`✓ ${score.avg_iteration_cost.toFixed(1)} rounds/PR (no feedback)`)
                : score.avg_iteration_cost <= 1.5
                  ? chalk.yellow(`~ ${score.avg_iteration_cost.toFixed(1)} rounds/PR (occasional feedback)`)
                  : chalk.red(`✗ ${score.avg_iteration_cost.toFixed(1)} rounds/PR (frequent feedback)`);

          const antibodyStatus =
            score.antibody_hit_rate === null
              ? chalk.dim("—")
              : score.antibody_hit_rate >= 0.9
                ? chalk.green(`✓ ${Math.round(score.antibody_hit_rate * 100)}% approval rate`)
                : score.antibody_hit_rate >= 0.7
                  ? chalk.yellow(`~ ${Math.round(score.antibody_hit_rate * 100)}% approval rate`)
                  : chalk.red(`✗ ${Math.round(score.antibody_hit_rate * 100)}% approval rate`);

          console.log(`  ${chalk.bold(score.agent_name)}`);
          console.log(`    Crash frequency:    ${crashStatus}`);
          console.log(`    Iteration cost:     ${iterationStatus}`);
          console.log(`    Antibody hit rate:  ${antibodyStatus}`);
          console.log(`    Trend:              ${score.trend}`);
          console.log();
        }
      }

      console.log(chalk.dim(`  Run \`orch reliability --days 90\` for a wider window, or \`--detail\` for component breakdown.`));
      console.log();
    });
}
