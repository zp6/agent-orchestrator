/**
 * `orch supervisor-log` — Live Supervisor Decision Feed (issue #523)
 *
 * Displays the last N supervisor decisions in a compact, dashboard-friendly
 * format.  With `--watch` the panel auto-refreshes every `--interval` seconds
 * so operators can monitor the orchestrator in real time without tailing log
 * files or running repeated CLI queries.
 *
 * Each row shows:
 *   - Wall-clock timestamp (HH:MM:SS)
 *   - Outcome badge: DISPATCHED / SKIPPED / FAILED / NONE / UNHANDLED
 *   - Agent selected (or —)
 *   - Issue references (e.g. owner/repo#42)
 *   - Human-readable rationale from the supervisor LLM
 *   - Hard gates that fired, if any
 *
 * Acceptance criteria: operators can see the last 20 supervisor decisions
 * immediately, without querying logs or ad-hoc CLI invocations.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import type { SupervisorDecisionRecord, DispatchRationale } from "../../state/store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A decision row ready for terminal rendering. */
export interface FormattedDecision {
  /** HH:MM:SS from created_at */
  timestamp: string;
  /** Coloured outcome badge text */
  outcomeBadge: string;
  /** Raw outcome string */
  outcome: string;
  /** Agent name or "—" */
  agent: string;
  /** Joined issue refs, e.g. "owner/repo#42, owner/repo#43" or "—" */
  issueRefs: string;
  /** Short human-readable rationale (LLM reasoning or fallback to reason) */
  rationale: string;
  /** Hard-gate lines, e.g. ["issue already closed", "agent busy"] */
  hardGates: string[];
  /** Structured rationale metadata if available */
  rationaleMeta: string | null;
  /** Task ID (first 10 chars) or null */
  taskId: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure formatting helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert an ISO timestamp to a short HH:MM:SS wall-clock string.
 * Uses local time so the feed is easy to correlate with events operators
 * can see on screen.
 */
export function formatTimestamp(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "??:??:??";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Return a coloured, fixed-width outcome badge for terminal display.
 *
 * Fixed widths keep columns aligned even when outcomes differ:
 *   DISPATCHED (10)  SKIPPED (7)  FAILED (6)  NONE (4)  UNHANDLED (9)
 * We pad to 10 chars so the column never shifts.
 */
export function formatOutcomeBadge(outcome: string): string {
  const label = outcome.toUpperCase().padEnd(10);
  switch (outcome) {
    case "dispatched":
      return chalk.green(label);
    case "skipped":
      return chalk.yellow(label);
    case "failed":
      return chalk.red(label);
    case "none":
      return chalk.dim(label);
    case "unhandled":
      return chalk.magenta(label);
    default:
      return chalk.white(label);
  }
}

/**
 * Parse the `rationale` JSON column and produce a compact meta string like:
 *   "issue=open  pr=none  idle=12m  conf=0.85"
 * Returns null when rationale is absent or unparseable.
 */
export function formatRationaleMeta(rationaleJson: string | null): string | null {
  if (!rationaleJson) return null;
  let r: DispatchRationale;
  try {
    r = JSON.parse(rationaleJson) as DispatchRationale;
  } catch {
    return null;
  }

  const parts: string[] = [];

  if (r.issue_state_at_dispatch) {
    parts.push(`issue=${r.issue_state_at_dispatch}`);
  }
  if (r.existing_pr_check_result) {
    parts.push(`pr=${r.existing_pr_check_result}`);
  }
  if (r.agent_idle_duration_ms !== null && r.agent_idle_duration_ms !== undefined) {
    const minutes = Math.round(r.agent_idle_duration_ms / 60_000);
    parts.push(`idle=${minutes}m`);
  }
  if (r.confidence_score !== null && r.confidence_score !== undefined) {
    parts.push(`conf=${r.confidence_score.toFixed(2)}`);
  }

  if (parts.length === 0) return null;

  // Also return the LLM reasoning so callers can access it
  return parts.join("  ");
}

/**
 * Extract the short human-readable rationale for a decision.
 * Prefers the LLM reasoning from the structured rationale column; falls
 * back to the unstructured `reason` field.
 */
export function extractRationale(record: SupervisorDecisionRecord): string {
  if (record.rationale) {
    try {
      const r = JSON.parse(record.rationale) as DispatchRationale;
      if (r.llm_reasoning) return r.llm_reasoning;
    } catch {
      // fall through to reason
    }
  }
  return record.reason;
}

/**
 * Convert a raw `SupervisorDecisionRecord` into a `FormattedDecision` ready
 * for terminal rendering or JSON serialisation.
 *
 * This is the core pure function for the supervisor log panel.
 */
export function formatDecision(record: SupervisorDecisionRecord): FormattedDecision {
  return {
    timestamp: formatTimestamp(record.created_at),
    outcomeBadge: formatOutcomeBadge(record.outcome),
    outcome: record.outcome,
    agent: record.agent_name ?? "—",
    issueRefs:
      record.issue_refs.length > 0 ? record.issue_refs.join(", ") : "—",
    rationale: extractRationale(record).slice(0, 120),
    hardGates: record.hard_gates,
    rationaleMeta: formatRationaleMeta(record.rationale),
    taskId: record.task_id ? record.task_id.slice(0, 10) : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal rendering
// ─────────────────────────────────────────────────────────────────────────────

const HEADER = chalk.bold("Supervisor Decision Log");

/**
 * Render the full supervisor log panel as a multi-line string.
 *
 * @param decisions  Formatted decisions, newest first.
 * @param liveMode   Whether the panel is in auto-refresh mode.
 * @param intervalSec  Refresh interval when in live mode.
 */
export function renderPanel(
  decisions: FormattedDecision[],
  liveMode: boolean,
  intervalSec: number,
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  const liveTag = liveMode
    ? chalk.green(`● live  [${intervalSec}s]`)
    : chalk.dim("snapshot");
  const timestamp = chalk.dim(new Date().toLocaleTimeString());
  lines.push(`${HEADER}  ${liveTag}  ${timestamp}`);
  lines.push(chalk.dim("─".repeat(72)));

  // ── Column header ────────────────────────────────────────────────────────
  lines.push(
    chalk.dim(
      "  TIME      OUTCOME     AGENT                  ISSUES",
    ),
  );
  lines.push(chalk.dim("─".repeat(72)));

  if (decisions.length === 0) {
    lines.push(chalk.dim("  No supervisor decisions recorded yet."));
    lines.push("");
    return lines.join("\n");
  }

  // ── Rows ─────────────────────────────────────────────────────────────────
  for (const d of decisions) {
    const agentCol = d.agent.padEnd(22);
    const issueCol = d.issueRefs.slice(0, 30);

    // Primary row
    lines.push(
      `  ${chalk.dim(d.timestamp)}  ${d.outcomeBadge}  ${chalk.cyan(agentCol)}  ${chalk.blue(issueCol)}`,
    );

    // Rationale line
    const rationalePrefix = chalk.dim("           rationale: ");
    lines.push(`${rationalePrefix}${d.rationale}`);

    // Meta line (structured fields from rationale JSON)
    if (d.rationaleMeta) {
      lines.push(`           ${chalk.dim(d.rationaleMeta)}`);
    }

    // Hard gates
    for (const gate of d.hardGates) {
      lines.push(`           ${chalk.yellow("⛔ gate:")} ${chalk.yellow(gate)}`);
    }

    // Task ID
    if (d.taskId) {
      lines.push(`           ${chalk.dim(`task: ${d.taskId}`)}`);
    }

    lines.push(chalk.dim("  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·"));
  }

  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Command registration
// ─────────────────────────────────────────────────────────────────────────────

/** How many decisions to show by default. */
const DEFAULT_LIMIT = 20;

/** Default auto-refresh interval in seconds. */
const DEFAULT_INTERVAL_SEC = 5;

export function registerSupervisorLogCommand(program: Command): void {
  program
    .command("supervisor-log")
    .alias("sl")
    .description(
      "Live supervisor decision feed — shows recent dispatch decisions with rationale and gate info",
    )
    .option(
      "-n, --limit <n>",
      `Number of decisions to display (default: ${DEFAULT_LIMIT})`,
      String(DEFAULT_LIMIT),
    )
    .option(
      "--watch",
      `Auto-refresh the panel every --interval seconds`,
    )
    .option(
      "--interval <seconds>",
      `Refresh interval for --watch mode (default: ${DEFAULT_INTERVAL_SEC})`,
      String(DEFAULT_INTERVAL_SEC),
    )
    .option("--json", "Output decisions as JSON instead of the terminal panel")
    .action(
      async (opts: {
        limit: string;
        watch?: boolean;
        interval: string;
        json?: boolean;
      }) => {
        const limit = Math.max(1, parseInt(opts.limit, 10) || DEFAULT_LIMIT);
        const intervalSec = Math.max(1, parseInt(opts.interval, 10) || DEFAULT_INTERVAL_SEC);
        const liveMode = opts.watch ?? false;

        const store = new StateStore();

        /** Render one frame of the panel. */
        const render = () => {
          const records = store.getRecentSupervisorDecisions(limit);

          if (opts.json) {
            // JSON output: one object with a `decisions` array
            const formatted = records.map((r) => ({
              id: r.id,
              created_at: r.created_at,
              outcome: r.outcome,
              action: r.action,
              agent_name: r.agent_name,
              reason: r.reason,
              rationale: r.rationale ? (() => {
                try { return JSON.parse(r.rationale!); } catch { return r.rationale; }
              })() : null,
              issue_refs: r.issue_refs,
              hard_gates: r.hard_gates,
              task_id: r.task_id,
            }));
            console.log(JSON.stringify({ decisions: formatted, count: formatted.length }, null, 2));
            return;
          }

          const formatted = records.map(formatDecision);

          if (liveMode) {
            // Clear terminal and move cursor to top
            process.stdout.write("\x1B[2J\x1B[H");
          }
          process.stdout.write(renderPanel(formatted, liveMode, intervalSec));
        };

        render();

        if (!liveMode || opts.json) {
          store.close();
          return;
        }

        // Auto-refresh loop — runs until the user hits Ctrl+C
        const timer = setInterval(render, intervalSec * 1000);

        const cleanup = () => {
          clearInterval(timer);
          store.close();
          process.stdout.write("\n");
          process.exit(0);
        };

        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);
      },
    );
}
