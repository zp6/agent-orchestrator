/**
 * CLI command: orch marginal-score-tasks (issue #597)
 *
 * Displays the marginal-score task panel — tasks whose quality scores fall
 * in a configurable "marginal" range (default 0.5–0.75), along with a
 * per-day trend sparkline and per-agent breakdown.  Operators can use this
 * to identify agents or task types that consistently produce borderline
 * quality output and trigger a re-dispatch for individual tasks.
 *
 * Usage:
 *   orch marginal-score-tasks [--days N] [--min-score X] [--max-score Y]
 *                             [--agent <name>] [--limit N] [--offset N] [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type MarginalScoreTasksResult,
} from "../../state/store.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function scoreColour(score: number): string {
  const pct = (score * 100).toFixed(0).padStart(3);
  if (score >= 0.7) return chalk.yellow(`${pct}%`);
  if (score >= 0.6) return chalk.dim(`${pct}%`);
  return chalk.red(`${pct}%`);
}

function statusColour(status: string): string {
  if (status === "done") return chalk.green(status.padEnd(12));
  if (status === "failed") return chalk.red(status.padEnd(12));
  if (status === "in_progress") return chalk.cyan(status.padEnd(12));
  return chalk.dim(status.padEnd(12));
}

/** Render a simple ASCII sparkline from daily counts. */
function sparkline(trend: Array<{ day: string; count: number }>): string {
  if (trend.length === 0) return chalk.dim("no data");
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...trend.map((t) => t.count), 1);
  const line = trend
    .map((t) => {
      const idx = Math.min(bars.length - 1, Math.floor((t.count / max) * bars.length));
      return chalk.cyan(bars[idx]);
    })
    .join("");
  return line;
}

function formatRow(task: MarginalScoreTasksResult["tasks"][number]): string {
  const ts = task.created_at.slice(0, 16).replace("T", " ");
  const shortId = task.id.slice(-8);
  const title =
    task.title.length > 42
      ? task.title.slice(0, 39) + "..."
      : task.title.padEnd(42);
  const agent = (task.agent_name ?? "—").padEnd(30);
  const score = scoreColour(task.quality_score);
  const status = statusColour(task.status);

  return (
    `  ${chalk.dim(ts)}  ${chalk.bold(shortId)}  ${score}  ${status}` +
    `  ${chalk.dim(agent.slice(0, 30).padEnd(30))}  ${title}`
  );
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerMarginalScoreTasksCommand(program: Command): void {
  program
    .command("marginal-score-tasks")
    .description(
      "Marginal-score task panel: tasks in the borderline quality range with trend and per-agent breakdown",
    )
    .option("--days <n>", "Look-back window in days (default 30, max 90)", "30")
    .option(
      "--min-score <x>",
      "Lower bound of marginal range inclusive (default 0.5)",
      "0.5",
    )
    .option(
      "--max-score <y>",
      "Upper bound of marginal range exclusive (default 0.75)",
      "0.75",
    )
    .option("--agent <name>", "Filter to a specific agent")
    .option("--limit <n>", "Max tasks to display (default 50, max 200)", "50")
    .option("--offset <n>", "Pagination offset (default 0)", "0")
    .option("--json", "Output raw JSON instead of formatted table")
    .action(
      (opts: {
        days: string;
        minScore: string;
        maxScore: string;
        agent?: string;
        limit: string;
        offset: string;
        json?: boolean;
      }) => {
        const days = Math.min(90, Math.max(1, parseInt(opts.days, 10) || 30));
        const minScore = Math.max(0, Math.min(1, parseFloat(opts.minScore) || 0.5));
        const maxScore = Math.max(0, Math.min(1, parseFloat(opts.maxScore) || 0.75));
        const limit = Math.min(200, Math.max(1, parseInt(opts.limit, 10) || 50));
        const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
        const agent = opts.agent ?? null;

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
          const result = store.getMarginalScoreTasks(
            days,
            minScore,
            maxScore,
            agent,
            limit,
            offset,
          );

          if (opts.json) {
            console.log(
              JSON.stringify(
                {
                  days,
                  min_score: minScore,
                  max_score: maxScore,
                  agent,
                  limit,
                  offset,
                  ...result,
                },
                null,
                2,
              ),
            );
            return;
          }

          // ── Header ───────────────────────────────────────────────────────────
          const rangeStr = `${(minScore * 100).toFixed(0)}–${(maxScore * 100).toFixed(0)}%`;
          const agentStr = agent ? ` · agent: ${agent}` : "";
          console.log(
            chalk.bold(
              `\n📊  Marginal-Score Tasks — last ${days} day(s) · score range ${rangeStr}${agentStr}\n`,
            ),
          );
          console.log(
            chalk.dim(
              "  Tasks whose quality score fell in the marginal range.\n" +
                "  Use `orch marginal-score-tasks --json` to access re-dispatch IDs.\n",
            ),
          );

          // ── Trend sparkline ──────────────────────────────────────────────────
          if (result.trend.length > 0) {
            console.log(
              `  ${chalk.bold("Trend:")} ${sparkline(result.trend)}  ` +
                chalk.dim(
                  `(${result.trend[0]?.day ?? ""} → ${result.trend[result.trend.length - 1]?.day ?? ""})`,
                ),
            );
            console.log();
          }

          // ── Per-agent breakdown ──────────────────────────────────────────────
          if (result.per_agent.length > 0) {
            console.log(chalk.bold("  Per-agent:"));
            for (const row of result.per_agent) {
              const avgStr = (row.avg_score * 100).toFixed(1).padStart(5);
              console.log(
                `    ${row.agent_name.padEnd(32)}  ${chalk.bold(String(row.count).padStart(4))} task(s)  avg: ${scoreColour(row.avg_score)}`,
              );
              void avgStr; // suppress unused-var warning; score colour already includes it
            }
            console.log();
          }

          // ── Summary ──────────────────────────────────────────────────────────
          const avgStr =
            result.avg_score != null
              ? scoreColour(result.avg_score)
              : chalk.dim("n/a");
          const pageEnd = offset + result.tasks.length;
          console.log(
            chalk.bold("  Summary:"),
            `${chalk.bold(String(result.total))} marginal task(s) total`,
            `— avg score: ${avgStr}`,
            result.total > pageEnd
              ? chalk.dim(`— showing ${offset + 1}–${pageEnd} of ${result.total}`)
              : "",
          );
          console.log();

          if (result.tasks.length === 0) {
            console.log(
              chalk.dim(
                "  No tasks in the marginal score range for this window.\n",
              ),
            );
            return;
          }

          // ── Task table ───────────────────────────────────────────────────────
          console.log(
            chalk.dim(
              `  ${"Timestamp".padEnd(18)} ${"Task ID ".padEnd(10)} ${"Scr".padEnd(5)} ` +
                `${"Status".padEnd(14)} ${"Agent".padEnd(32)} Title`,
            ),
          );
          console.log(chalk.dim("  " + "─".repeat(110)));

          for (const task of result.tasks) {
            console.log(formatRow(task));
          }

          console.log();

          // ── Redispatch hint ──────────────────────────────────────────────────
          if (result.tasks.length > 0) {
            console.log(
              chalk.dim(
                `  Re-dispatch via HTTP: POST /marginal-score-tasks/<id>/redispatch\n` +
                  `  Or use the dashboard panel to trigger re-dispatch from the UI.\n`,
              ),
            );
          }
        } finally {
          store.close();
        }
      },
    );
}
