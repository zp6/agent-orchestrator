import type { Command } from "commander";
import chalk from "chalk";
import {
  StateStore,
  type AgentTimeoutAnalytics,
  type TimeoutAnalytics,
} from "../../state/store.js";
import { formatDuration } from "./metrics.js";

/** Color a timeout-rate percentage: green <5%, yellow <20%, red >=20%. */
export function colorTimeoutRate(pct: number | null): string {
  if (pct === null) return chalk.dim("—");
  const s = `${Math.round(pct)}%`;
  if (pct === 0) return chalk.green(s);
  if (pct < 5) return chalk.green(s);
  if (pct < 20) return chalk.yellow(s);
  return chalk.red(s);
}

/** Format a suggested timeout as "Nm" (minutes) or "—". */
export function formatSuggestedTimeout(ms: number | null): string {
  if (ms === null) return chalk.dim("—");
  const minutes = Math.round(ms / 60000);
  return `${minutes}m`;
}

/**
 * Build a human-readable recommendations list from per-agent analytics.
 * Only emits a recommendation for agents that have timed out or whose
 * suggested timeout differs meaningfully from the 10-minute default.
 */
export function buildRecommendations(
  agents: AgentTimeoutAnalytics[],
): string[] {
  return agents
    .filter((a) => a.timed_out_tasks > 0 || a.suggested_timeout_ms !== null)
    .map((a) => {
      const suggestedMin = a.suggested_timeout_ms
        ? Math.round(a.suggested_timeout_ms / 60000)
        : null;

      if (a.timed_out_tasks === 0) {
        return (
          `${chalk.cyan(a.agent_name)}: ` +
          `no timeouts in window; ` +
          (suggestedMin !== null
            ? `p95 duration suggests ${suggestedMin}m timeout`
            : `insufficient completed tasks to recommend a timeout`)
        );
      }

      const rateStr =
        a.timeout_rate_pct !== null
          ? `${Math.round(a.timeout_rate_pct)}% timeout rate`
          : "unknown timeout rate";

      if (suggestedMin !== null) {
        return (
          `${chalk.cyan(a.agent_name)}: ${rateStr} — ` +
          `set ${chalk.bold("timeout_ms: " + a.suggested_timeout_ms)} ` +
          `(${suggestedMin}m) in agents.yaml based on p95 + 20% buffer`
        );
      }

      return (
        `${chalk.cyan(a.agent_name)}: ${rateStr} — ` +
        `no completed tasks to compute p95; consider raising timeout_ms`
      );
    });
}

export function registerTimeoutsCommand(program: Command): void {
  program
    .command("timeouts")
    .description(
      "Timeout analytics: which tasks time out most, how long tasks really take, and suggested timeout_ms per agent",
    )
    .option("-d, --days <n>", "Rolling window in days", "7")
    .option("--json", "Output raw JSON instead of formatted tables")
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

      let data: TimeoutAnalytics;
      try {
        data = store.getTimeoutAnalytics(days);
      } finally {
        store.close();
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      // ── Header ──────────────────────────────────────────────────────────
      console.log(
        chalk.bold(
          `\n● Timeout Analytics — last ${days} day${days === 1 ? "" : "s"}\n`,
        ),
      );

      if (data.total_tasks === 0) {
        console.log(
          chalk.dim("  No task data in this window. Dispatch some tasks first."),
        );
        console.log();
        return;
      }

      // ── Per-agent table ─────────────────────────────────────────────────
      const COL = {
        agent: 34,
        total: 7,
        timeouts: 10,
        rate: 7,
        avg: 10,
        p95: 10,
        suggested: 10,
      };

      const header = [
        "Agent".padEnd(COL.agent),
        "Total".padStart(COL.total),
        "Timeouts".padStart(COL.timeouts),
        "Rate".padStart(COL.rate),
        "Avg Time".padStart(COL.avg),
        "p95 Time".padStart(COL.p95),
        "Suggested".padStart(COL.suggested),
      ].join("  ");

      const separator = "─".repeat(header.length);

      console.log(chalk.dim("  " + header));
      console.log(chalk.dim("  " + separator));

      for (const a of data.per_agent) {
        const line = [
          chalk.cyan(a.agent_name.padEnd(COL.agent)),
          String(a.total_tasks).padStart(COL.total),
          (a.timed_out_tasks > 0
            ? chalk.yellow(String(a.timed_out_tasks))
            : chalk.dim("0")
          ).padStart(COL.timeouts),
          colorTimeoutRate(a.timeout_rate_pct).padStart(COL.rate),
          formatDuration(a.avg_duration_ms).padStart(COL.avg),
          formatDuration(a.p95_duration_ms).padStart(COL.p95),
          chalk.bold(formatSuggestedTimeout(a.suggested_timeout_ms)).padStart(
            COL.suggested,
          ),
        ].join("  ");
        console.log("  " + line);
      }
      console.log(chalk.dim("  " + separator));
      console.log();

      // ── Timed-out task list ──────────────────────────────────────────────
      if (data.timeout_tasks.length === 0) {
        console.log(chalk.green("  No timeouts in this window."));
      } else {
        const plural = data.total_timed_out === 1 ? "task" : "tasks";
        console.log(
          chalk.bold(
            `  Timed-out ${plural} (retry_count > 0) — ${data.total_timed_out} in window:\n`,
          ),
        );

        const TCOL = {
          id: 12,
          agent: 34,
          retries: 9,
          duration: 10,
          title: 0, // fills remainder
        };

        const thead = [
          "Task ID".padEnd(TCOL.id),
          "Agent".padEnd(TCOL.agent),
          "Retries".padStart(TCOL.retries),
          "Duration".padStart(TCOL.duration),
          "  Title",
        ].join("  ");

        console.log(chalk.dim("  " + thead));
        console.log(chalk.dim("  " + "─".repeat(thead.length)));

        for (const t of data.timeout_tasks) {
          const title =
            t.title.length > 60 ? t.title.slice(0, 57) + "…" : t.title;
          const line = [
            chalk.dim(t.id.slice(0, TCOL.id - 1).padEnd(TCOL.id)),
            chalk.cyan(t.agent_name.slice(0, TCOL.agent - 1).padEnd(TCOL.agent)),
            String(t.retry_count).padStart(TCOL.retries),
            formatDuration(t.duration_ms).padStart(TCOL.duration),
            "  " + chalk.dim(title),
          ].join("  ");
          console.log("  " + line);
        }
        console.log();
      }

      // ── Recommendations ──────────────────────────────────────────────────
      const recommendations = buildRecommendations(data.per_agent);
      if (recommendations.length > 0) {
        console.log(chalk.bold("  Recommendations:\n"));
        for (const rec of recommendations) {
          console.log("  • " + rec);
        }
        console.log();
        console.log(
          chalk.dim(
            "  Set timeout_ms per agent in agents.yaml under docker.timeout_ms.",
          ),
        );
      }

      console.log();
      console.log(
        chalk.dim(
          `  Run \`orch timeouts --days 30\` for a wider window, or \`--json\` for machine-readable output.`,
        ),
      );
      console.log();
    });
}
