/**
 * Low-score approved task feed — `/api/low-score-approved` API payload builder.
 *
 * Surfaces approved tasks whose quality score fell below the 0.75 "comfortable
 * approval" threshold so operators can audit risky approvals before they cause
 * downstream issues.
 *
 * The 0.75 threshold sits above the hard floor (0.60) and captures the entire
 * "marginal" band — tasks that passed the gate but carry elevated risk:
 *
 *   < 0.60: normally blocked (needs_operator_review) or operator-overridden
 *   0.60–0.74: auto-approved despite being in the warning band
 *   ≥ 0.75: comfortable approval (not surfaced by this feed)
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getLowScoreApprovedFeed } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/low-score-approved', (req, res) => {
 *     res.json(getLowScoreApprovedFeed(store, {
 *       threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
 *       limit: req.query.limit ? Number(req.query.limit) : undefined,
 *     }));
 *   });
 *
 * Telegram `/low-score` command uses `formatLowScoreFeedForTelegram()`.
 *
 * Issue #278.
 */

import type { ILowScoreFeedStore } from "../state/types.js";
import type { Task } from "../state/types.js";
import { parseDimensionsFromNotes, extractPrUrl } from "../telegram/command-handler.js";
import type { ParsedDimensions } from "../telegram/command-handler.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Score below which an approved task is considered "marginal" and surfaced
 * by the low-score feed.  Set at 0.75 — the boundary between the yellow
 * (warning) and green (healthy) bands in the fleet health sparkline.
 *
 * Operators should review all approved tasks below this threshold before
 * their PRs are merged, as they carry elevated downstream risk.
 */
export const LOW_SCORE_FEED_THRESHOLD = 0.75;

/** Default result cap for the feed. */
export const LOW_SCORE_FEED_DEFAULT_LIMIT = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One approved task in the low-score feed.
 */
export interface LowScoreFeedEntry {
  /** Full ULID task identifier. */
  task_id: string;
  /** First 8 chars of task_id — used for display and operator commands. */
  task_id_short: string;
  /** Task title (from the tasks table). */
  title: string;
  /** Agent that completed the task, or null if unassigned. */
  agent_name: string | null;
  /** Task type: 'implementation' | 'research' | 'housekeeping'. */
  task_type: string;
  /** Verified quality score (0–1). Always < threshold. */
  quality_score: number;
  /**
   * Per-dimension score breakdown parsed from verification_notes.
   * Null when the notes field did not contain a recognisable breakdown.
   */
  dimensions: ParsedDimensions | null;
  /**
   * Source reference (e.g. "owner/repo#123" for a GitHub issue).
   * Null when no source_ref was recorded.
   */
  source_ref: string | null;
  /**
   * Extracted GitHub PR URL, or null when the source_ref is not a PR ref
   * or no source_ref is present.
   */
  pr_url: string | null;
  /**
   * ISO-8601 timestamp of when the task was last updated (i.e. when it was
   * approved, for approved tasks).
   */
  approved_at: string;
}

/** Options for `getLowScoreApprovedFeed()`. */
export interface LowScoreFeedOptions {
  /**
   * Score ceiling — tasks with quality_score < threshold are included.
   * Default: 0.75 (LOW_SCORE_FEED_THRESHOLD).
   */
  threshold?: number;
  /**
   * Maximum number of entries to return.
   * Default: 50 (LOW_SCORE_FEED_DEFAULT_LIMIT).
   */
  limit?: number;
}

/** Per-agent summary in the feed payload. */
export interface LowScoreFeedAgentSummary {
  agent_name: string;
  count: number;
  /** Mean quality_score across this agent's low-score approved tasks. */
  avg_score: number;
  /** Lowest quality_score recorded for this agent in the feed. */
  min_score: number;
}

/**
 * Full low-score approved task feed payload returned by
 * `getLowScoreApprovedFeed()`.
 */
export interface LowScoreFeed {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /**
   * Score ceiling used to filter tasks.
   * Tasks with quality_score < threshold appear in this feed.
   */
  threshold: number;
  /** Total number of matching approved tasks (after applying limit). */
  total: number;
  /**
   * Number of tasks in the score band [0.60, threshold) —
   * auto-approved despite being in the warning band.
   */
  auto_approved_marginal: number;
  /**
   * Number of tasks with score < 0.60 that were nonetheless approved
   * (operator override or floor bypass).
   */
  below_floor_approved: number;
  /** Approved tasks with quality_score < threshold, ordered by score ascending. */
  tasks: LowScoreFeedEntry[];
  /**
   * Per-agent summary: count and average score, sorted by count descending.
   * Helps operators identify which agents are producing the most marginal approvals.
   */
  per_agent: LowScoreFeedAgentSummary[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFeedEntry(task: Task): LowScoreFeedEntry {
  return {
    task_id: task.id,
    task_id_short: task.id.slice(0, 8),
    title: task.title,
    agent_name: task.agent_name ?? null,
    task_type: task.task_type,
    quality_score: task.quality_score!,
    dimensions: parseDimensionsFromNotes(task.verification_notes),
    source_ref: task.source_ref ?? null,
    pr_url: extractPrUrl(task),
    approved_at: task.updated_at,
  };
}

function buildPerAgentSummary(tasks: LowScoreFeedEntry[]): LowScoreFeedAgentSummary[] {
  const byAgent = new Map<string, { count: number; sum: number; min: number }>();

  for (const t of tasks) {
    const name = t.agent_name ?? "(unassigned)";
    const entry = byAgent.get(name) ?? { count: 0, sum: 0, min: Infinity };
    entry.count += 1;
    entry.sum += t.quality_score;
    entry.min = Math.min(entry.min, t.quality_score);
    byAgent.set(name, entry);
  }

  return Array.from(byAgent.entries())
    .map(([agent_name, { count, sum, min }]) => ({
      agent_name,
      count,
      avg_score: sum / count,
      min_score: min,
    }))
    .sort((a, b) => b.count - a.count || a.agent_name.localeCompare(b.agent_name));
}

// ── Main payload builder ───────────────────────────────────────────────────────

/**
 * Build the low-score approved task feed payload.
 *
 * Queries the store for all approved tasks with quality_score < `threshold`
 * (default 0.75), ordered from lowest to highest score so the riskiest
 * approvals appear first.
 *
 * @param store      A live ILowScoreFeedStore instance (satisfied by StateStore).
 * @param opts       Optional configuration overrides.
 * @returns          The full feed payload.
 */
export function getLowScoreApprovedFeed(
  store: ILowScoreFeedStore,
  opts: LowScoreFeedOptions = {},
): LowScoreFeed {
  const threshold = Number.isFinite(opts.threshold) && (opts.threshold ?? 0) > 0
    ? (opts.threshold ?? LOW_SCORE_FEED_THRESHOLD)
    : LOW_SCORE_FEED_THRESHOLD;

  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1
    ? Math.floor(opts.limit ?? LOW_SCORE_FEED_DEFAULT_LIMIT)
    : LOW_SCORE_FEED_DEFAULT_LIMIT;

  const rawTasks = store.getLowScoreApprovedTasks(threshold, limit);
  const tasks = rawTasks.map(buildFeedEntry);

  const APPROVAL_FLOOR = 0.60;
  let autoApprovedMarginal = 0;
  let belowFloorApproved = 0;

  for (const t of tasks) {
    if (t.quality_score < APPROVAL_FLOOR) {
      belowFloorApproved += 1;
    } else {
      autoApprovedMarginal += 1;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    threshold,
    total: tasks.length,
    auto_approved_marginal: autoApprovedMarginal,
    below_floor_approved: belowFloorApproved,
    tasks,
    per_agent: buildPerAgentSummary(tasks),
  };
}

// ── Telegram formatter ─────────────────────────────────────────────────────────

/**
 * Format a `LowScoreFeed` as a Telegram Markdown message for the
 * `/low-score` bot command.
 *
 * Output sections:
 *   1. Header: feed summary (total, threshold, breakdown counts)
 *   2. Per-agent summary table
 *   3. Task list (up to `maxTasks`, richest first: riskiest score at top)
 *
 * @param feed      The feed payload from `getLowScoreApprovedFeed()`.
 * @param maxTasks  Maximum number of task entries to show. Default: 10.
 * @param dashboardUrl  Optional dashboard base URL for clickthrough.
 */
export function formatLowScoreFeedForTelegram(
  feed: LowScoreFeed,
  maxTasks = 10,
  dashboardUrl?: string,
): string {
  const lines: string[] = [];

  // ── Header ────────────────────────────────────────────────────────────────
  const thresholdPct = Math.round(feed.threshold * 100);
  const headerIcon = feed.total === 0 ? "✅" : "⚠️";

  lines.push(`${headerIcon} *Low-Score Approved Tasks* (< ${thresholdPct}%)`);
  lines.push(``);

  if (feed.total === 0) {
    lines.push(`_No approved tasks below the ${thresholdPct}% threshold._`);
    lines.push(`All recent approvals meet the quality bar.`);
    return lines.join("\n");
  }

  lines.push(`_${feed.total} approved task${feed.total === 1 ? "" : "s"} scored below ${thresholdPct}%_`);
  lines.push(``);

  // ── Breakdown ─────────────────────────────────────────────────────────────
  const FLOOR_PCT = 60;
  lines.push(`*Breakdown:*`);
  lines.push(`  • Auto-approved marginal (${FLOOR_PCT}–${thresholdPct - 1}%): ${feed.auto_approved_marginal}`);
  lines.push(`  • Below-floor approved (< ${FLOOR_PCT}%): ${feed.below_floor_approved}`);
  lines.push(``);

  // ── Per-agent summary ────────────────────────────────────────────────────
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

  // ── Task list ────────────────────────────────────────────────────────────
  lines.push(`*Tasks (lowest score first):*`);

  const shown = feed.tasks.slice(0, maxTasks);
  for (const t of shown) {
    const scorePct = (t.quality_score * 100).toFixed(0);
    const agent = t.agent_name ?? "unassigned";
    const scoreIcon = t.quality_score < 0.60 ? "🔴" : "🟡";

    lines.push(``);
    lines.push(`${scoreIcon} \`${t.task_id_short}\` *${scorePct}%* _(${agent})_`);
    lines.push(`  ${t.title.slice(0, 60)}${t.title.length > 60 ? "…" : ""}`);
    lines.push(`  Type: ${t.task_type}`);

    // Per-dimension breakdown
    const d = t.dimensions;
    if (d) {
      const fmt = (v: number | null) =>
        v != null ? `${(v * 100).toFixed(0)}` : "n/a";
      const mark = (v: number | null) => (v != null && v >= 0.80 ? "✓" : "✗");
      lines.push(
        `  \`${mark(d.correctness)}Corr:${fmt(d.correctness)} ${mark(d.completeness)}Comp:${fmt(d.completeness)} ${mark(d.test_coverage)}Test:${fmt(d.test_coverage)} ${mark(d.code_quality)}Code:${fmt(d.code_quality)}\``,
      );
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

  // ── Dashboard link ────────────────────────────────────────────────────────
  if (dashboardUrl) {
    lines.push(``);
    lines.push(`[View full feed](${dashboardUrl}/low-score-approved)`);
  }

  return lines.join("\n");
}
