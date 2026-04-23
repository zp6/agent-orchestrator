/**
 * CLI command: orch failure-interceptions (issue #1086)
 *
 * Displays the failure interception panel — tasks that triggered the
 * pre-dispatch similarity filter, their lessons-injected count, model upgrade
 * suggestions, and whether the interception helped the task pass verification.
 *
 * Usage:
 *   orch failure-interceptions [--days N] [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type FailureInterceptionEntry } from "../../state/store.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function outcomeColour(outcome: string | null): string {
  if (outcome === null) return chalk.dim("pending  ");
  if (outcome === "passed") return chalk.green("passed   ");
  return chalk.red("failed   ");
}

function similarityBar(score: number): string {
  const pct = Math.round(score * 100);
  const color =
    score >= 0.80 ? chalk.red : score >= 0.70 ? chalk.yellow : chalk.cyan;
  return color(`${String(pct).padStart(3)}%`);
}

function formatRow(entry: FailureInterceptionEntry): string {
  const ts = entry.created_at.slice(0, 16).replace("T", " ");
  const shortId = entry.task_id.slice(-8);
  const sim = similarityBar(entry.similarity_score);
  const lessons = String(entry.lessons_injected).padEnd(7);
  const modelUp = entry.model_upgraded ? chalk.yellow("yes") : chalk.dim("no ");
  const outcome = outcomeColour(entry.final_outcome);

  return (
    `  ${chalk.dim(ts)}  ${chalk.bold(shortId)}  ${sim}  ${lessons}  ${modelUp}  ${outcome}`
  );
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerFailureInterceptionsCommand(program: Command): void {
  program
    .command("failure-interceptions")
    .description("Failure interception panel: pre-dispatch similarity filter hits and outcomes")
    .option("--days <n>", "Look-back window in days", "7")
    .option("--json", "Output raw JSON instead of formatted table")
    .action((opts: { days: string; json?: boolean }) => {
      const days = Math.max(1, parseInt(opts.days, 10) || 7);

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

      try {
        const entries = store.getFailureInterceptions(200, days);
        const stats = store.getFailureInterceptionStats(days);

        if (opts.json) {
          console.log(JSON.stringify({ stats, entries }, null, 2));
          return;
        }

        console.log(chalk.bold(`\n🛡  Failure Interceptions — last ${days} day(s)\n`));
        console.log(
          chalk.dim(
            "  Tasks where the pre-dispatch similarity filter matched recent failures\n" +
            "  and injected failure lessons to prevent repeating the same mistakes.\n",
          ),
        );

        if (entries.length === 0) {
          console.log(
            chalk.dim(
              "  No interceptions recorded yet.\n" +
              "  Entries appear once similarity >= 0.6 against recent failed tasks.",
            ),
          );
          console.log();
          return;
        }

        // Header
        console.log(
          chalk.dim(
            `  ${"Timestamp".padEnd(18)} ${"Task ID ".padEnd(10)} ${"Sim".padEnd(5)} ` +
            `${"Lessons".padEnd(9)} ${"Model↑".padEnd(8)} ${"Outcome"}`,
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(80)));

        for (const entry of entries) {
          console.log(formatRow(entry));
        }

        console.log();

        // Summary line
        const prevPct =
          stats.prevention_rate > 0
            ? `${(stats.prevention_rate * 100).toFixed(1)}%`
            : "n/a";
        const avgSim =
          stats.avg_similarity > 0
            ? `${(stats.avg_similarity * 100).toFixed(0)}%`
            : "n/a";

        console.log(
          chalk.bold("  Summary:"),
          `${chalk.bold(String(stats.total))} interception(s) in ${days}d`,
          `— avg similarity: ${chalk.cyan(avgSim)}`,
          `— prevention rate: ${chalk.green(prevPct)}`,
          `— model upgrades suggested: ${chalk.yellow(String(stats.model_upgrades))}`,
        );
        console.log();
      } finally {
        store.close();
      }
    });
}
