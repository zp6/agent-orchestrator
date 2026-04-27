/**
 * CLI command: orch anomalies (issue #1207)
 *
 * Displays the persistent anomaly feed — score anomaly observations that have
 * recurred across multiple verification cycles, populated by the verifier
 * (parse-failure guard) and improvement detector.
 *
 * Usage:
 *   orch anomalies [--days N] [--min-cycles N] [--agent <name>] [--limit N] [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function cycleCountColour(count: number): string {
  const s = String(count).padStart(4);
  if (count >= 10) return chalk.red(s);
  if (count >= 5)  return chalk.yellow(s);
  return chalk.cyan(s);
}

function anomalyTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    parse_failure:      "parse-failure",
    score_zero:         "score-zero",
    low_score:          "low-score",
    verification_fail:  "verify-fail",
    revision_loop:      "revision-loop",
  };
  return labels[type] ?? type;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatRow(a: {
  task_id: string;
  agent: string;
  anomaly_type: string;
  cycle_count: number;
  first_seen: string;
  last_seen: string;
}): string {
  const shortId    = chalk.bold(a.task_id.slice(-12).padEnd(12));
  const agent      = chalk.dim((a.agent ?? "—").slice(0, 30).padEnd(30));
  const typeLabel  = anomalyTypeLabel(a.anomaly_type).padEnd(16);
  const cycles     = cycleCountColour(a.cycle_count);
  const lastSeen   = formatRelativeTime(a.last_seen).padEnd(12);

  return `  ${shortId}  ${agent}  ${typeLabel}  ${cycles}x  ${lastSeen}`;
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerAnomaliesCommand(program: Command): void {
  program
    .command("anomalies")
    .description("Persistent anomaly feed: recurring score anomaly observations by agent and type")
    .option("--days <n>",       "Look-back window in days (default 30, max 90)", "30")
    .option("--min-cycles <n>", "Minimum recurrence count to include (default 1)", "1")
    .option("--agent <name>",   "Filter to a specific agent")
    .option("--limit <n>",      "Max results to display (default 200, max 500)", "200")
    .option("--json",           "Output raw JSON instead of formatted table")
    .action(
      (opts: {
        days: string;
        minCycles: string;
        agent?: string;
        limit: string;
        json?: boolean;
      }) => {
        const days      = Math.min(90,  Math.max(1, parseInt(opts.days,      10) || 30));
        const minCycles = Math.max(1,               parseInt(opts.minCycles, 10) || 1);
        const limit     = Math.min(500, Math.max(1, parseInt(opts.limit,     10) || 200));
        const agent     = opts.agent ?? null;

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
          const anomalies = store.getPersistentAnomaliesPayload(days, minCycles, agent, limit);

          if (opts.json) {
            console.log(JSON.stringify({ days, min_cycles: minCycles, agent, limit, total: anomalies.length, anomalies }, null, 2));
            return;
          }

          // ── Header ─────────────────────────────────────────────────────────
          const agentStr     = agent ? ` · agent: ${agent}` : "";
          const minCyclesStr = minCycles > 1 ? ` · min recurrences: ${minCycles}` : "";
          console.log(
            chalk.bold(`\n🔍  Persistent Anomalies — last ${days} day(s)${agentStr}${minCyclesStr}\n`),
          );
          console.log(
            chalk.dim(
              "  Score anomaly observations that have recurred across multiple verification cycles.\n" +
              "  Cycle count = number of times the anomaly was observed for this task.\n",
            ),
          );

          if (anomalies.length === 0) {
            console.log(chalk.dim("  No persistent anomalies found for this window.\n"));
            return;
          }

          // ── Per-agent summary ──────────────────────────────────────────────
          const byAgent = new Map<string, number>();
          const byType  = new Map<string, number>();
          for (const a of anomalies) {
            byAgent.set(a.agent, (byAgent.get(a.agent) ?? 0) + 1);
            byType.set(a.anomaly_type, (byType.get(a.anomaly_type) ?? 0) + 1);
          }

          if (byAgent.size > 1) {
            console.log(chalk.bold("  Per-agent:"));
            for (const [name, count] of [...byAgent.entries()].sort((a, b) => b[1] - a[1])) {
              console.log(`    ${name.padEnd(34)}  ${chalk.bold(String(count).padStart(4))} anomal${count === 1 ? "y" : "ies"}`);
            }
            console.log();
          }

          if (byType.size > 1) {
            console.log(chalk.bold("  By type:"));
            for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
              console.log(`    ${anomalyTypeLabel(type).padEnd(18)}  ${chalk.bold(String(count).padStart(4))}`);
            }
            console.log();
          }

          // ── Summary ────────────────────────────────────────────────────────
          console.log(
            chalk.bold("  Summary:"),
            `${chalk.bold(String(anomalies.length))} anomal${anomalies.length === 1 ? "y" : "ies"} found`,
          );
          console.log();

          // ── Table ──────────────────────────────────────────────────────────
          console.log(
            chalk.dim(
              `  ${"Task ID".padEnd(14)} ${"Agent".padEnd(32)} ${"Type".padEnd(18)} ${"Cnt".padEnd(6)} ${"Last seen".padEnd(14)}`,
            ),
          );
          console.log(chalk.dim("  " + "─".repeat(85)));

          for (const anomaly of anomalies) {
            console.log(formatRow(anomaly));
          }

          console.log();
          console.log(
            chalk.dim(
              `  Filter by agent:  orch anomalies --agent <name>\n` +
              `  Show recurring:   orch anomalies --min-cycles 2\n` +
              `  Machine output:   orch anomalies --json\n`,
            ),
          );
        } finally {
          store.close();
        }
      },
    );
}
