/**
 * Marginal approvals feed — `/api/marginal-approvals` API payload builder.
 *
 * Surfaces approved tasks whose quality score falls in the 0.60–0.79 "marginal"
 * band — tasks that cleared the auto-approval gate but carry elevated risk.
 * Operators can use this feed to:
 *
 *   - Review marginal approvals in one place before they accumulate technical debt
 *   - Spot per-agent patterns (e.g. one agent consistently scoring 0.62–0.68)
 *   - Trigger targeted re-dispatch with coaching when the marginal_reason reveals
 *     a fixable gap
 *   - Compare trends over time via the `days` window parameter
 *
 * Score band reference:
 *
 *   < 0.60:       Hard floor — normally blocked or operator-overridden (bypass-audit)
 *   0.60–0.79:    Marginal   — auto-approved but risky (this feed)
 *   0.80+:        Healthy    — comfortable approval
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getMarginalApprovalsFeed } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/marginal-approvals', (req, res) => {
 *     res.json(getMarginalApprovalsFeed(store, {
 *       days:  req.query.days  ? Number(req.query.days)  : undefined,
 *       limit: req.query.limit ? Number(req.query.limit) : undefined,
 *     }));
 *   });
 *
 * Telegram `/marginal-approvals [days] [limit]` command uses
 * `formatMarginalApprovalsForTelegram()`.
 *
 * Issue #502.
 */

import type {
  IMarginalApprovalsFeedStore,
  IMarginalApprovalsTrendStore,
  MarginalApprovalDayBucket,
} from "../state/types.js";
import type { Task } from "../state/types.js";
import { parseDimensionsFromNotes, extractPrUrl } from "../telegram/command-handler.js";
import type { ParsedDimensions } from "../telegram/command-handler.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Lower bound of the marginal approval band (inclusive).
 * Tasks with score ≥ this threshold and < MARGINAL_APPROVALS_CEILING are
 * classified as marginal.
 */
export const MARGINAL_APPROVALS_FLOOR = 0.60;

/**
 * Upper bound of the marginal approval band (inclusive).
 * Matches MARGINAL_APPROVAL_HIGH in verifier.ts.
 */
export const MARGINAL_APPROVALS_CEILING = 0.79;

/** Default lookback window in days. */
export const MARGINAL_APPROVALS_DEFAULT_DAYS = 14;

/** Default result cap. */
export const MARGINAL_APPROVALS_DEFAULT_LIMIT = 50;

/** Default lookback window in days for the trend endpoint. */
export const MARGINAL_APPROVALS_TREND_DEFAULT_DAYS = 30;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One approved task in the marginal approvals feed.
 */
export interface MarginalApprovalEntry {
  /** Full ULID task identifier. */
  task_id: string;
  /** First 8 chars of task_id — used for display and operator commands. */
  task_id_short: string;
  /** Task title. */
  title: string;
  /** Agent that completed the task, or null if unassigned. */
  agent_name: string | null;
  /** Task type: 'implementation' | 'research' | 'housekeeping'. */
  task_type: string;
  /**
   * Verified quality score (0–1).
   * Always in [MARGINAL_APPROVALS_FLOOR, MARGINAL_APPROVALS_CEILING].
   */
  quality_score: number;
  /**
   * Per-dimension score breakdown parsed from verification_notes.
   * Null when no recognisable breakdown was found in the notes.
   */
  dimensions: ParsedDimensions | null;
  /**
   * One-sentence explanation of why the score did not reach 0.80, extracted
   * from the LLM's marginal_reason field in the verification notes.
   * Null when the notes did not include a marginal_reason.
   */
  marginal_reason: string | null;
  /**
   * A short coaching directive synthesised from `marginal_reason` and the
   * weakest dimension(s), ready to inject into a re-dispatch prompt.
   * Null only when both `marginal_reason` is absent and no dimensions were
   * parsed.
   *
   * Example: "Focus on improving test_coverage (currently 55%) and fix the
   * missing error handling described in the marginal_reason."
   */
  coaching_prompt: string | null;
  /**
   * Source reference (e.g. "owner/repo#123" for a GitHub issue).
   * Null when no source_ref was recorded.
   */
  source_ref: string | null;
  /**
   * Extracted GitHub PR URL, or null when none could be determined.
   */
  pr_url: string | null;
  /**
   * ISO-8601 timestamp of when the task was last updated (i.e. when it was
   * approved, for approved tasks).
   */
  approved_at: string;
}

// ── Trend types ───────────────────────────────────────────────────────────────

/** Options for `getMarginalApprovalsTrend()`. */
export interface MarginalApprovalsTrendOptions {
  /**
   * Number of calendar days to cover.
   * Default: 30 (MARGINAL_APPROVALS_TREND_DEFAULT_DAYS).
   */
  days?: number;
}

/**
 * Full trend payload returned by `getMarginalApprovalsTrend()`.
 * Intended for `/api/marginal-approvals/trend`.
 */
export interface MarginalApprovalsTrend {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** Number of calendar days covered. */
  days: number;
  /** Total marginal approvals across the entire window. */
  total: number;
  /**
   * Simple linear trend direction derived from comparing the first and second
   * halves of the window.
   *
   *   "improving"  — second half has fewer marginal approvals than first half
   *   "worsening"  — second half has more marginal approvals
   *   "stable"     — within ±10% or both halves are zero
   */
  trend_direction: "improving" | "worsening" | "stable";
  /**
   * Daily time-series points, one per calendar day in the window.
   * Includes days with zero approvals so the x-axis is continuous.
   */
  daily: MarginalApprovalDayBucket[];
}

/** Options for `getMarginalApprovalsFeed()`. */
export interface MarginalApprovalsOptions {
  /**
   * Lookback window in days.
   * Tasks updated before `now - days` are excluded.
   * Default: 14 (MARGINAL_APPROVALS_DEFAULT_DAYS).
   * Pass 0 to disable the time filter and return all-time data.
   */
  days?: number;
  /**
   * Maximum number of entries to return.
   * Default: 50 (MARGINAL_APPROVALS_DEFAULT_LIMIT).
   */
  limit?: number;
}

/** Per-agent summary in the feed payload. */
export interface MarginalApprovalAgentSummary {
  /** Agent name, or "(unassigned)" for tasks with no agent. */
  agent_name: string;
  /** Number of marginal approvals for this agent in the window. */
  count: number;
  /** Mean quality_score across this agent's marginal approvals. */
  avg_score: number;
  /** Lowest quality_score recorded for this agent in the feed. */
  min_score: number;
  /**
   * Fraction of this agent's entries that include a marginal_reason.
   * 1.0 = all entries have a reason; 0.0 = none do.
   */
  marginal_reason_coverage: number;
}

/**
 * Full marginal approvals feed payload returned by `getMarginalApprovalsFeed()`.
 */
export interface MarginalApprovalsFeed {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** Lookback window used (days). 0 means all-time. */
  days: number;
  /** Total number of matching tasks (after applying limit). */
  total: number;
  /**
   * Tasks at the bottom of the marginal band (score in [0.60, 0.69]).
   * These carry the highest risk among marginal approvals.
   */
  low_marginal_count: number;
  /**
   * Tasks at the top of the marginal band (score in [0.70, 0.79]).
   * Closer to the healthy zone — lower risk.
   */
  high_marginal_count: number;
  /**
   * Fraction of tasks that include an extracted marginal_reason.
   * Low coverage (<0.5) indicates verifier prompts may need tuning.
   */
  marginal_reason_coverage: number;
  /**
   * Marginal approved tasks, ordered from lowest to highest score so the
   * riskiest approvals appear first.
   */
  tasks: MarginalApprovalEntry[];
  /**
   * Per-agent summary sorted by count descending.
   * Helps operators identify which agents accumulate the most marginal approvals.
   */
  per_agent: MarginalApprovalAgentSummary[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract marginal_reason from verification_notes.
 *
 * The verifier stores the marginal_reason inside the JSON-serialised
 * verification_notes blob (e.g. `"marginal_reason": "Missing error handling …"`).
 * This helper parses it out with a regex that handles both JSON and plain-text
 * note formats.
 */
function extractMarginalReason(task: Task): string | null {
  if (!task.verification_notes) return null;

  // Match JSON: "marginal_reason": "some text"
  const jsonMatch = task.verification_notes.match(
    /["']?marginal[_\s]*reason["']?\s*:\s*["']([^"'\n}{]+)["']/i,
  );
  if (jsonMatch?.[1]) {
    return jsonMatch[1].trim();
  }

  // Match plain-text: marginal_reason: some text
  const plainMatch = task.verification_notes.match(
    /marginal[_\s]*reason\s*:\s*([^\n"}{]+)/i,
  );
  if (plainMatch?.[1]) {
    return plainMatch[1].trim().replace(/[",]+$/, "");
  }

  return null;
}

/**
 * Build a short coaching directive for re-dispatch from marginal_reason and
 * dimension gaps.  The result is injected by the dashboard's re-dispatch button
 * into the task prompt so the agent knows exactly what to fix.
 */
function buildCoachingPrompt(
  marginalReason: string | null,
  dimensions: ParsedDimensions | null,
): string | null {
  const parts: string[] = [];

  if (marginalReason) {
    parts.push(`Address the quality gap: ${marginalReason}`);
  }

  if (dimensions) {
    const weak: string[] = [];
    const entries: Array<[string, number | null]> = [
      ["correctness", dimensions.correctness],
      ["completeness", dimensions.completeness],
      ["test_coverage", dimensions.test_coverage],
      ["code_quality", dimensions.code_quality],
    ];
    for (const [dim, val] of entries) {
      if (val !== null && val < 0.80) {
        weak.push(`${dim} (${(val * 100).toFixed(0)}%)`);
      }
    }
    if (weak.length > 0) {
      parts.push(`Improve the following dimensions: ${weak.join(", ")}.`);
    }
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

function buildFeedEntry(task: Task): MarginalApprovalEntry {
  const dimensions = parseDimensionsFromNotes(task.verification_notes);
  const marginalReason = extractMarginalReason(task);
  return {
    task_id: task.id,
    task_id_short: task.id.slice(0, 8),
    title: task.title,
    agent_name: task.agent_name ?? null,
    task_type: task.task_type,
    quality_score: task.quality_score!,
    dimensions,
    marginal_reason: marginalReason,
    coaching_prompt: buildCoachingPrompt(marginalReason, dimensions),
    source_ref: task.source_ref ?? null,
    pr_url: extractPrUrl(task),
    approved_at: task.updated_at,
  };
}

function buildPerAgentSummary(entries: MarginalApprovalEntry[]): MarginalApprovalAgentSummary[] {
  const byAgent = new Map<string, {
    count: number;
    sum: number;
    min: number;
    reasonCount: number;
  }>();

  for (const e of entries) {
    const name = e.agent_name ?? "(unassigned)";
    const rec = byAgent.get(name) ?? { count: 0, sum: 0, min: Infinity, reasonCount: 0 };
    rec.count += 1;
    rec.sum += e.quality_score;
    rec.min = Math.min(rec.min, e.quality_score);
    if (e.marginal_reason !== null) rec.reasonCount += 1;
    byAgent.set(name, rec);
  }

  return Array.from(byAgent.entries())
    .map(([agent_name, { count, sum, min, reasonCount }]) => ({
      agent_name,
      count,
      avg_score: sum / count,
      min_score: min,
      marginal_reason_coverage: count > 0 ? reasonCount / count : 0,
    }))
    .sort((a, b) => b.count - a.count || a.agent_name.localeCompare(b.agent_name));
}

// ── Main payload builder ───────────────────────────────────────────────────────

/**
 * Build the marginal approvals feed payload.
 *
 * Queries the store for approved tasks with quality_score in
 * [MARGINAL_APPROVALS_FLOOR, MARGINAL_APPROVALS_CEILING] within the given
 * time window, ordered from lowest to highest score (riskiest first).
 *
 * @param store  A live IMarginalApprovalsFeedStore instance (satisfied by StateStore).
 * @param opts   Optional configuration overrides.
 * @returns      The full feed payload.
 */
export function getMarginalApprovalsFeed(
  store: IMarginalApprovalsFeedStore,
  opts: MarginalApprovalsOptions = {},
): MarginalApprovalsFeed {
  const days = Number.isFinite(opts.days) && (opts.days ?? -1) >= 0
    ? (opts.days ?? MARGINAL_APPROVALS_DEFAULT_DAYS)
    : MARGINAL_APPROVALS_DEFAULT_DAYS;

  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1
    ? Math.floor(opts.limit ?? MARGINAL_APPROVALS_DEFAULT_LIMIT)
    : MARGINAL_APPROVALS_DEFAULT_LIMIT;

  const rawTasks = store.getMarginalApprovedTasks(days, limit);
  const entries = rawTasks.map(buildFeedEntry);

  const LOW_MARGINAL_CEILING = 0.70;
  let lowMarginalCount = 0;
  let highMarginalCount = 0;
  let withReasonCount = 0;

  for (const e of entries) {
    if (e.quality_score < LOW_MARGINAL_CEILING) {
      lowMarginalCount += 1;
    } else {
      highMarginalCount += 1;
    }
    if (e.marginal_reason !== null) withReasonCount += 1;
  }

  const marginalReasonCoverage = entries.length > 0 ? withReasonCount / entries.length : 0;

  return {
    generated_at: new Date().toISOString(),
    days,
    total: entries.length,
    low_marginal_count: lowMarginalCount,
    high_marginal_count: highMarginalCount,
    marginal_reason_coverage: marginalReasonCoverage,
    tasks: entries,
    per_agent: buildPerAgentSummary(entries),
  };
}

// ── Trend builder ─────────────────────────────────────────────────────────────

/**
 * Build the marginal approvals trend payload for `/api/marginal-approvals/trend`.
 *
 * Returns a continuous day-by-day time series over the requested window,
 * including zero-count days, plus a simple trend direction derived from
 * comparing the first and second halves of the window.
 *
 * @param store  A live IMarginalApprovalsTrendStore (satisfied by StateStore).
 * @param opts   Optional configuration overrides.
 */
export function getMarginalApprovalsTrend(
  store: IMarginalApprovalsTrendStore,
  opts: MarginalApprovalsTrendOptions = {},
): MarginalApprovalsTrend {
  const days = Number.isFinite(opts.days) && (opts.days ?? 0) >= 1
    ? Math.floor(opts.days ?? MARGINAL_APPROVALS_TREND_DEFAULT_DAYS)
    : MARGINAL_APPROVALS_TREND_DEFAULT_DAYS;

  const daily = store.getMarginalApprovalsDailyTrend(days);
  const total = daily.reduce((sum, d) => sum + d.count, 0);

  // Compare first half vs second half to derive a simple trend direction.
  const mid = Math.floor(daily.length / 2);
  const firstHalf = daily.slice(0, mid).reduce((s, d) => s + d.count, 0);
  const secondHalf = daily.slice(mid).reduce((s, d) => s + d.count, 0);

  let trend_direction: MarginalApprovalsTrend["trend_direction"] = "stable";
  if (firstHalf === 0 && secondHalf === 0) {
    trend_direction = "stable";
  } else if (firstHalf === 0) {
    trend_direction = "worsening";
  } else {
    const delta = (secondHalf - firstHalf) / firstHalf;
    if (delta < -0.10) {
      trend_direction = "improving";
    } else if (delta > 0.10) {
      trend_direction = "worsening";
    }
  }

  return {
    generated_at: new Date().toISOString(),
    days,
    total,
    trend_direction,
    daily,
  };
}

// ── Telegram formatter ─────────────────────────────────────────────────────────

/**
 * Format a `MarginalApprovalsFeed` as a Telegram Markdown message for the
 * `/marginal-approvals` bot command.
 *
 * Output sections:
 *   1. Header with summary counts
 *   2. Per-agent breakdown table
 *   3. Task list (up to `maxTasks` entries, riskiest first)
 *   4. Optional dashboard deep-link
 *
 * @param feed         The feed payload from `getMarginalApprovalsFeed()`.
 * @param maxTasks     Maximum number of task entries to show. Default: 10.
 * @param dashboardUrl Optional dashboard base URL for clickthrough.
 */
export function formatMarginalApprovalsForTelegram(
  feed: MarginalApprovalsFeed,
  maxTasks = 10,
  dashboardUrl?: string,
): string {
  const lines: string[] = [];
  const windowLabel = feed.days === 0 ? "all time" : `last ${feed.days}d`;

  // ── Header ─────────────────────────────────────────────────────────────────
  const headerIcon = feed.total === 0 ? "✅" : "🟡";
  lines.push(`${headerIcon} *Marginal Approvals* (60–79%) — ${windowLabel}`);
  lines.push(``);

  if (feed.total === 0) {
    lines.push(`_No marginal approvals in the ${windowLabel} window._`);
    lines.push(`All recent approvals are either healthy (≥80%) or flagged elsewhere.`);
    return lines.join("\n");
  }

  lines.push(
    `_${feed.total} task${feed.total === 1 ? "" : "s"} approved in the marginal band_`,
  );
  lines.push(``);

  // ── Band breakdown ─────────────────────────────────────────────────────────
  lines.push(`*Score bands:*`);
  lines.push(`  • Low marginal (60–69%): ${feed.low_marginal_count} 🔴`);
  lines.push(`  • High marginal (70–79%): ${feed.high_marginal_count} 🟡`);

  const coveragePct = Math.round(feed.marginal_reason_coverage * 100);
  const coverageIcon = coveragePct >= 80 ? "✓" : coveragePct >= 50 ? "~" : "✗";
  lines.push(
    `  • Reason coverage: ${coveragePct}% ${coverageIcon} _(${feed.tasks.filter(t => t.marginal_reason !== null).length}/${feed.total} have marginal_reason)_`,
  );
  lines.push(``);

  // ── Per-agent summary ─────────────────────────────────────────────────────
  if (feed.per_agent.length > 0) {
    lines.push(`*By agent:*`);
    for (const a of feed.per_agent) {
      const avgPct = (a.avg_score * 100).toFixed(0);
      const minPct = (a.min_score * 100).toFixed(0);
      lines.push(
        `  \`${a.agent_name}\` — ${a.count} task${a.count === 1 ? "" : "s"} · avg ${avgPct}% · min ${minPct}%`,
      );
    }
    lines.push(``);
  }

  // ── Task list ──────────────────────────────────────────────────────────────
  lines.push(`*Tasks (lowest score first):*`);

  const shown = feed.tasks.slice(0, maxTasks);
  for (const t of shown) {
    const scorePct = (t.quality_score * 100).toFixed(0);
    const agent = t.agent_name ?? "unassigned";
    const scoreIcon = t.quality_score < 0.70 ? "🔴" : "🟡";

    lines.push(``);
    lines.push(`${scoreIcon} \`${t.task_id_short}\` *${scorePct}%* _(${agent})_`);
    lines.push(`  ${t.title.slice(0, 60)}${t.title.length > 60 ? "…" : ""}`);
    lines.push(`  Type: ${t.task_type}`);

    // Per-dimension breakdown
    const d = t.dimensions;
    if (d) {
      const fmt = (v: number | null) => (v != null ? `${(v * 100).toFixed(0)}` : "n/a");
      const mark = (v: number | null) => (v != null && v >= 0.80 ? "✓" : "✗");
      lines.push(
        `  \`${mark(d.correctness)}Corr:${fmt(d.correctness)} ${mark(d.completeness)}Comp:${fmt(d.completeness)} ${mark(d.test_coverage)}Test:${fmt(d.test_coverage)} ${mark(d.code_quality)}Code:${fmt(d.code_quality)}\``,
      );
    }

    // Marginal reason (coaching insight)
    if (t.marginal_reason) {
      const reason = t.marginal_reason.slice(0, 80);
      lines.push(`  💬 _${reason}${t.marginal_reason.length > 80 ? "…" : ""}_`);
    }

    // PR or source link
    if (t.pr_url) {
      lines.push(`  [PR](${t.pr_url})`);
    } else if (t.source_ref) {
      lines.push(`  Ref: \`${t.source_ref}\``);
    }
  }

  if (feed.tasks.length > maxTasks) {
    lines.push(``);
    lines.push(`_…and ${feed.tasks.length - maxTasks} more_`);
  }

  // ── Dashboard link ─────────────────────────────────────────────────────────
  if (dashboardUrl) {
    lines.push(``);
    lines.push(`[View full panel](${dashboardUrl}/marginal-approvals)`);
  }

  return lines.join("\n");
}
