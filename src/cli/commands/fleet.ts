import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type FleetProviderMetrics } from "../../state/store.js";
import { formatDuration, formatScore } from "./metrics.js";

/** Format a percentage as "82%" or "—" if null. */
function formatPct(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${Math.round(pct)}%`;
  if (pct >= 80) return chalk.green(s);
  if (pct >= 60) return chalk.yellow(s);
  return chalk.red(s);
}

/** Format token count with K/M suffix. */
function formatTokens(n: number): string {
  if (n === 0) return chalk.dim("0");
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

/** Provider display label and color. */
function providerLabel(provider: string): string {
  switch (provider) {
    case "claude": return chalk.cyan("Claude (Anthropic)");
    case "openai": return chalk.yellow("Codex (OpenAI)");
    default:       return chalk.dim(provider);
  }
}

export function registerFleetCommand(program: Command): void {
  program
    .command("fleet")
    .description("Side-by-side Claude vs Codex fleet performance comparison")
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
        console.error(
          chalk.red("Could not open state database:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      let rows: FleetProviderMetrics[];
      try {
        rows = store.getFleetComparisonMetrics(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      console.log(chalk.bold(`\n● Fleet Comparison — last ${days} day${days === 1 ? "" : "s"}\n`));

      if (rows.length === 0) {
        console.log(chalk.dim("  No task data in this window. Dispatch some tasks first."));
        console.log();
        return;
      }

      // ── Column layout ──────────────────────────────────────────────────────
      const COL = {
        provider:  22,
        agents:     7,
        done:       6,
        total:      7,
        success:    9,
        quality:    9,
        duration:  10,
        tokens:     9,
      };

      const header = [
        "Provider".padEnd(COL.provider),
        "Agents".padStart(COL.agents),
        "Done".padStart(COL.done),
        "Total".padStart(COL.total),
        "Success%".padStart(COL.success),
        "Quality".padStart(COL.quality),
        "Avg Time".padStart(COL.duration),
        "Tokens".padStart(COL.tokens),
      ].join("  ");

      const separator = "─".repeat(header.length);

      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + separator));

      for (const row of rows) {
        const line = [
          providerLabel(row.provider).padEnd(COL.provider + 10), // +10 for ANSI codes
          String(row.agent_count).padStart(COL.agents),
          chalk.green(String(row.done)).padStart(COL.done + 10),
          String(row.total_tasks).padStart(COL.total),
          formatPct(row.success_rate_pct).padStart(COL.success + 10),
          formatScore(row.avg_quality_score).padStart(COL.quality + 10),
          formatDuration(row.avg_duration_ms).padStart(COL.duration + 10),
          formatTokens(row.total_tokens).padStart(COL.tokens),
        ].join("  ");
        console.log("  " + line);
      }

      console.log(chalk.dim("  " + separator));
      console.log();

      // ── Delta summary if we have both Claude and Codex ─────────────────────
      const claude = rows.find((r) => r.provider === "claude");
      const codex  = rows.find((r) => r.provider === "openai");

      if (claude && codex) {
        console.log(chalk.bold("  ● Head-to-head\n"));

        const totalDone = (claude.done + codex.done) || 1;
        const claudeShare = Math.round((claude.done / totalDone) * 100);
        const codexShare  = 100 - claudeShare;

        console.log(
          `  Tasks completed:  ${chalk.cyan(`Claude ${claudeShare}%`)}  vs  ${chalk.yellow(`Codex ${codexShare}%`)}`,
        );

        if (claude.avg_quality_score !== null && codex.avg_quality_score !== null) {
          const diff = claude.avg_quality_score - codex.avg_quality_score;
          const winner = diff > 0 ? chalk.cyan("Claude") : diff < 0 ? chalk.yellow("Codex") : "Tied";
          const absDiff = Math.abs(diff).toFixed(2);
          console.log(`  Quality leader:   ${winner} (+${absDiff})`);
        }

        if (claude.avg_duration_ms !== null && codex.avg_duration_ms !== null) {
          const diff = claude.avg_duration_ms - codex.avg_duration_ms;
          const faster = diff < 0 ? chalk.cyan("Claude") : diff > 0 ? chalk.yellow("Codex") : "Tied";
          const absDiff = Math.round(Math.abs(diff) / 1000);
          console.log(`  Faster provider:  ${faster} (${absDiff}s)`);
        }

        if (claude.total_tokens > 0 || codex.total_tokens > 0) {
          const totalTokens = (claude.total_tokens + codex.total_tokens) || 1;
          const claudeTokenShare = Math.round((claude.total_tokens / totalTokens) * 100);
          const codexTokenShare  = 100 - claudeTokenShare;
          console.log(
            `  Token share:      ${chalk.cyan(`Claude ${claudeTokenShare}%`)}  vs  ${chalk.yellow(`Codex ${codexTokenShare}%`)}`,
          );
        }

        console.log();
      }

      console.log(
        chalk.dim(
          `  Run \`orch fleet --days 30\` for a wider window, or \`--json\` for machine-readable output.`,
        ),
      );
      console.log();
    });
}
