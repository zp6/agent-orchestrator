/**
 * Triage schema failure rate per-agent health report (issue #409).
 *
 * ## Problem
 *
 * Operators have no visibility into which agents fail triage schema compliance
 * most often, which fields are most commonly missing, or whether coaching
 * iterations are actually reducing failure rates over time.
 *
 * ## Solution
 *
 * Expose a `/triage-health [agent]` Telegram command and a
 * `/api/triage-health` endpoint payload that returns:
 *
 *   - Per-agent triage pass/fail rate
 *   - Most common missing/malformed fields
 *   - Revision count per triage cycle
 *   - 7-day trend (current window vs. prior 7-day window)
 *
 * Operators can answer "is coaching working?" without manually reading PR history.
 *
 * ## Architecture
 *
 * `getTriageHealthPayload(store, agentName?)` — pure function.  Queries the
 * state store for housekeeping tasks, buckets them by agent, computes pass/fail
 * rates, field-miss frequencies, and revision counts.  Returns a
 * `TriageHealthReport` suitable for both JSON API responses and Telegram
 * formatting.
 *
 * `formatTriageHealthForTelegram(report, agentFilter?)` — formats a
 * `TriageHealthReport` as a Telegram Markdown message.
 *
 * Both functions are pure / synchronous — no I/O, easy to unit-test.
 */

import type { Task } from "../state/types.js";
import { TRIAGE_REQUIRED_FIELDS } from "./verifier.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Lookback window for the "current" triage health bucket (days). */
export const TRIAGE_HEALTH_CURRENT_DAYS = 7;

/** Lookback window for the "prior" triage health bucket used for trend (days). */
export const TRIAGE_HEALTH_PRIOR_DAYS = 14;

/** Pass threshold — tasks with quality_score >= this value count as "passed". */
export const TRIAGE_PASS_THRESHOLD = 0.80;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Stats for a single agent over one time window. */
export interface AgentTriagePeriodStats {
  /** Number of triage tasks completed in the window. */
  total: number;
  /** Number that passed schema compliance (score ≥ 0.80). */
  passed: number;
  /** Number that failed (score < 0.80 or explicit rejection). */
  failed: number;
  /** Pass rate 0–1 (null when total === 0). */
  pass_rate: number | null;
  /** Total revision rounds across all tasks in this window. */
  total_revisions: number;
  /** Average revisions per triage task (null when total === 0). */
  avg_revisions_per_task: number | null;
  /** Field miss frequencies, sorted desc by count. */
  missing_fields: Array<{ field: string; count: number }>;
}

/** Per-agent triage health entry for the report. */
export interface AgentTriageHealthEntry {
  /** Agent name. */
  agent_name: string;
  /** Stats for the most recent TRIAGE_HEALTH_CURRENT_DAYS days. */
  current: AgentTriagePeriodStats;
  /**
   * Stats for the window TRIAGE_HEALTH_CURRENT_DAYS..TRIAGE_HEALTH_PRIOR_DAYS days ago.
   * Used to compute the trend.  Null when no data in that window.
   */
  prior: AgentTriagePeriodStats | null;
  /**
   * Trend vs. prior period:
   * - `improving` — pass_rate increased by > 0.05
   * - `degrading`  — pass_rate decreased by > 0.05
   * - `stable`     — change < 0.05 (or insufficient data)
   */
  trend: "improving" | "degrading" | "stable";
  /**
   * Most recent failing task IDs (up to 3), newest first.
   * Surfaces to operators so they can drill in without navigating the full task log.
   */
  recent_failures: string[];
}

/** Full triage health report. */
export interface TriageHealthReport {
  /** ISO timestamp when the report was generated. */
  generated_at: string;
  /** Current window size (days). */
  current_window_days: number;
  /** Prior window size (days). */
  prior_window_days: number;
  /** Per-agent entries, sorted by current pass_rate ascending (worst agents first). */
  agents: AgentTriageHealthEntry[];
  /**
   * Fleet-level summary across ALL agents in the current window.
   */
  fleet: AgentTriagePeriodStats;
}

/** Minimal store interface needed by this module. */
export interface ITriageHealthStore {
  listTasks(opts: { limit?: number }): Task[];
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Parse field miss patterns from a task's result / verification_notes text.
 *
 * The verifier writes messages like:
 *   "TRIAGE SCHEMA VIOLATION: Missing required fields: priority_reordering"
 *   "Missing required fields: duplicates_checked, outcome_summary"
 *
 * Returns the set of required fields mentioned as missing.
 */
function extractMissingFields(task: Task): string[] {
  const text = [task.result, task.verification_notes, task.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const found: string[] = [];
  if (text.includes("missing") || text.includes("schema violation")) {
    for (const field of TRIAGE_REQUIRED_FIELDS) {
      if (text.includes(field.toLowerCase())) {
        found.push(field);
      }
    }
  }
  return found;
}

/**
 * Estimate the number of revision rounds for a task.
 *
 * We infer this from the verification_notes text: each mention of
 * "revision" or "attempt" increments the count.  Falls back to checking
 * if verification_status === 'needs_revision' (count = 1) or
 * status === 'done' and quality_score was present (count = 0).
 *
 * This is an approximation — the state.db does not store a revision_count
 * column on tasks.
 */
function estimateRevisions(task: Task): number {
  const text = [task.result, task.verification_notes]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const revisionMatches = text.match(/revision|attempt\s*\d+|retry/g);
  if (revisionMatches && revisionMatches.length > 0) {
    return revisionMatches.length;
  }
  if (task.verification_status === "needs_revision") return 1;
  return 0;
}

/**
 * Decide whether a triage task passed.
 *
 * A task counts as "passed" when:
 *  - It has a quality_score >= TRIAGE_PASS_THRESHOLD, OR
 *  - Its verification_status === "approved" and no quality_score was recorded.
 *
 * A task counts as "failed" when:
 *  - quality_score < TRIAGE_PASS_THRESHOLD, OR
 *  - verification_status === "rejected" | "needs_revision".
 *
 * Tasks with neither score nor terminal verification status are excluded.
 */
function triageTaskPassed(task: Task): boolean | null {
  if (typeof task.quality_score === "number") {
    return task.quality_score >= TRIAGE_PASS_THRESHOLD;
  }
  if (task.verification_status === "approved") return true;
  if (
    task.verification_status === "rejected" ||
    task.verification_status === "needs_revision"
  ) {
    return false;
  }
  return null; // inconclusive — exclude from stats
}

/**
 * Build period stats for a list of scored triage tasks.
 */
function buildPeriodStats(tasks: Task[]): AgentTriagePeriodStats {
  const scoredTasks = tasks.filter((t) => triageTaskPassed(t) !== null);
  const total = scoredTasks.length;

  if (total === 0) {
    return {
      total: 0,
      passed: 0,
      failed: 0,
      pass_rate: null,
      total_revisions: 0,
      avg_revisions_per_task: null,
      missing_fields: [],
    };
  }

  const passed = scoredTasks.filter((t) => triageTaskPassed(t) === true).length;
  const failed = total - passed;
  const pass_rate = passed / total;

  const totalRevisions = scoredTasks.reduce(
    (sum, t) => sum + estimateRevisions(t),
    0,
  );

  const fieldCounts = new Map<string, number>();
  for (const task of scoredTasks.filter((t) => triageTaskPassed(t) === false)) {
    for (const field of extractMissingFields(task)) {
      fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
    }
  }

  const missing_fields = Array.from(fieldCounts.entries())
    .map(([field, count]) => ({ field, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total,
    passed,
    failed,
    pass_rate,
    total_revisions: totalRevisions,
    avg_revisions_per_task: totalRevisions / total,
    missing_fields,
  };
}

/**
 * Determine trend from prior to current pass_rate.
 *
 * "improving": current > prior + 0.05
 * "degrading":  current < prior - 0.05
 * "stable":     |current - prior| <= 0.05, or insufficient data
 */
function computeTrend(
  current: AgentTriagePeriodStats,
  prior: AgentTriagePeriodStats | null,
): "improving" | "degrading" | "stable" {
  if (
    current.pass_rate === null ||
    prior === null ||
    prior.pass_rate === null
  ) {
    return "stable";
  }
  const delta = current.pass_rate - prior.pass_rate;
  if (delta > 0.05) return "improving";
  if (delta < -0.05) return "degrading";
  return "stable";
}

/**
 * Build a `TriageHealthReport` from the live state store.
 *
 * @param store      State store (only `listTasks` is required).
 * @param agentName  Optional: filter to a single agent.  When omitted, all
 *                   agents with at least one housekeeping task are included.
 * @param nowMs      Optional: current time in ms (default: Date.now()). Used
 *                   for window bucketing in tests.
 */
export function getTriageHealthPayload(
  store: ITriageHealthStore,
  agentName?: string | null,
  nowMs: number = Date.now(),
): TriageHealthReport {
  const allTasks = store.listTasks({ limit: 2000 });

  // Filter to housekeeping tasks that are in a terminal state.
  const triageTasks = allTasks.filter(
    (t) =>
      t.task_type === "housekeeping" &&
      (t.status === "done" || t.status === "failed" || t.status === "escalated") &&
      (!agentName || t.agent_name === agentName),
  );

  // Bucket tasks into current window (0–7d) and prior window (7–14d).
  const currentCutoff = new Date(nowMs - TRIAGE_HEALTH_CURRENT_DAYS * 86_400_000).toISOString();
  const priorCutoff = new Date(nowMs - TRIAGE_HEALTH_PRIOR_DAYS * 86_400_000).toISOString();

  // Group tasks by agent.
  const byAgent = new Map<string, Task[]>();
  for (const t of triageTasks) {
    const key = t.agent_name ?? "unknown";
    const list = byAgent.get(key) ?? [];
    list.push(t);
    byAgent.set(key, list);
  }

  const agentEntries: AgentTriageHealthEntry[] = [];

  for (const [name, tasks] of byAgent) {
    // Use created_at if available (tasks don't always have it in the base type,
    // so we cast through unknown to access it gracefully).
    const getTaskDate = (t: Task): string | null => {
      const raw = t as unknown as Record<string, unknown>;
      return (typeof raw["created_at"] === "string" ? raw["created_at"] : null);
    };

    const currentTasks = tasks.filter((t) => {
      const date = getTaskDate(t);
      return date !== null && date >= currentCutoff;
    });

    const priorTasks = tasks.filter((t) => {
      const date = getTaskDate(t);
      return date !== null && date >= priorCutoff && date < currentCutoff;
    });

    const current = buildPeriodStats(currentTasks);
    const prior = priorTasks.length > 0 ? buildPeriodStats(priorTasks) : null;
    const trend = computeTrend(current, prior);

    // Collect recent failure task IDs (newest first, up to 3).
    const recentFailures = tasks
      .filter((t) => triageTaskPassed(t) === false)
      .sort((a, b) => {
        const da = (getTaskDate(a) ?? "").localeCompare(getTaskDate(b) ?? "");
        return -da;
      })
      .slice(0, 3)
      .map((t) => t.id);

    agentEntries.push({
      agent_name: name,
      current,
      prior,
      trend,
      recent_failures: recentFailures,
    });
  }

  // Sort worst first (lowest pass_rate, null treated as worst).
  agentEntries.sort((a, b) => {
    const ar = a.current.pass_rate ?? -1;
    const br = b.current.pass_rate ?? -1;
    return ar - br;
  });

  // Compute fleet-level stats across all agents in current window.
  const currentTasksAll = triageTasks.filter((t) => {
    const raw = t as unknown as Record<string, unknown>;
    const date = typeof raw["created_at"] === "string" ? raw["created_at"] : null;
    return date !== null && date >= currentCutoff;
  });
  const fleet = buildPeriodStats(currentTasksAll);

  return {
    generated_at: new Date(nowMs).toISOString(),
    current_window_days: TRIAGE_HEALTH_CURRENT_DAYS,
    prior_window_days: TRIAGE_HEALTH_PRIOR_DAYS,
    agents: agentEntries,
    fleet,
  };
}

// ── Telegram formatting ───────────────────────────────────────────────────────

const TREND_ICON: Record<string, string> = {
  improving: "📈",
  degrading: "📉",
  stable: "➡️",
};

function formatPassRate(r: number | null): string {
  if (r === null) return "—";
  return `${Math.round(r * 100)}%`;
}

function formatPeriodStats(stats: AgentTriagePeriodStats, label: string): string {
  const passRate = formatPassRate(stats.pass_rate);
  const revisions =
    stats.avg_revisions_per_task !== null
      ? `${stats.avg_revisions_per_task.toFixed(1)} rev/task`
      : "0 rev/task";

  const line = `${label}: ${passRate} pass (${stats.passed}/${stats.total}) · ${revisions}`;

  if (stats.missing_fields.length > 0) {
    const top = stats.missing_fields
      .slice(0, 3)
      .map((f) => `${f.field}(${f.count}×)`)
      .join(", ");
    return `${line}\n  Missing fields: ${top}`;
  }
  return line;
}

/**
 * Format a `TriageHealthReport` as a Telegram Markdown message.
 *
 * @param report       The report to format.
 * @param agentFilter  Optional: when set, show only this agent's entry.
 */
export function formatTriageHealthForTelegram(
  report: TriageHealthReport,
  agentFilter?: string | null,
): string {
  const lines: string[] = [];

  lines.push(`🏥 *Triage Health* — last ${report.current_window_days}d vs prior ${report.prior_window_days - report.current_window_days}d`, ``);

  // Fleet summary
  const fleet = report.fleet;
  if (fleet.total > 0) {
    lines.push(
      `*Fleet* (all agents, last ${report.current_window_days}d)`,
      `Pass rate: ${formatPassRate(fleet.pass_rate)} (${fleet.passed}/${fleet.total})`,
      `Avg revisions/task: ${fleet.avg_revisions_per_task?.toFixed(1) ?? "0"}`,
    );
    if (fleet.missing_fields.length > 0) {
      const top = fleet.missing_fields
        .slice(0, 3)
        .map((f) => `${f.field}(${f.count}×)`)
        .join(", ");
      lines.push(`Most missed fields: ${top}`);
    }
    lines.push(``);
  }

  const filtered = agentFilter
    ? report.agents.filter((a) => a.agent_name === agentFilter)
    : report.agents;

  if (filtered.length === 0) {
    if (agentFilter) {
      lines.push(`_No triage data found for \`${agentFilter}\`._`);
    } else {
      lines.push(`_No triage tasks found in this window._`);
    }
    return lines.join("\n");
  }

  for (const entry of filtered) {
    const trend = TREND_ICON[entry.trend] ?? "➡️";
    const currentPassRate = formatPassRate(entry.current.pass_rate);

    lines.push(
      `*${entry.agent_name}* ${trend}`,
      formatPeriodStats(entry.current, `Current (${report.current_window_days}d)`),
    );

    if (entry.prior !== null && entry.prior.total > 0) {
      lines.push(
        formatPeriodStats(
          entry.prior,
          `Prior (${report.prior_window_days - report.current_window_days}d)`,
        ),
      );
    } else {
      lines.push(`Prior window: no data`);
    }

    const trendText = entry.trend === "stable"
      ? `Stable at ${currentPassRate}`
      : entry.trend === "improving"
      ? `Improving → ${currentPassRate}`
      : `⚠️ Degrading → ${currentPassRate}`;
    lines.push(`Trend: ${trendText}`);

    if (entry.recent_failures.length > 0) {
      lines.push(
        `Recent failures: ${entry.recent_failures.map((id) => `\`${id.slice(0, 10)}\``).join(", ")}`,
      );
    }

    lines.push(``);
  }

  lines.push(`_Generated ${new Date(report.generated_at).toISOString().replace("T", " ").slice(0, 19)} UTC_`);

  return lines.join("\n").trimEnd();
}
