/**
 * Score-Bypass Violation Report — `/api/score-violations` API payload builder.
 *
 * Lists all tasks approved below the configurable quality threshold (default
 * 0.80) in a rolling window, grouped by agent, showing score, dimension
 * breakdown, and marginal_reason badge. Enables operators to answer "which
 * agents are consistently slipping through quality gates?" without digging
 * through logs.
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getScoreViolationsPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/score-violations', (req, res) => {
 *     res.json(getScoreViolationsPayload(store, {
 *       threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
 *       days: req.query.days ? Number(req.query.days) : undefined,
 *       agent: req.query.agent as string | undefined,
 *     }));
 *   });
 *
 * Telegram command uses `formatScoreViolationsForTelegram()`.
 *
 * Issue #356.
 */

import type { IScoreViolationsStore } from "../state/types.js";
import type { Task } from "../state/types.js";
import { parseDimensionsFromNotes, extractPrUrl } from "../telegram/command-handler.js";
import type { ParsedDimensions } from "../telegram/command-handler.js";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Default score threshold below which an approved task is considered a
 * "violation". Set at 0.80 — the boundary between comfortable and marginal.
 */
export const SCORE_VIOLATIONS_DEFAULT_THRESHOLD = 0.80;

/** Default lookback window in days. */
export const SCORE_VIOLATIONS_DEFAULT_DAYS = 7;

/** Default result cap. */
export const SCORE_VIOLATIONS_DEFAULT_LIMIT = 100;

/** Score buckets for grouping violations. */
export const SCORE_BUCKETS = [
  { label: "critical", min: 0, max: 0.50, color: "red" },
  { label: "low", min: 0.50, max: 0.60, color: "orange" },
  { label: "marginal", min: 0.60, max: 0.75, color: "yellow" },
  { label: "borderline", min: 0.75, max: 0.80, color: "blue" },
] as const;

export type ScoreBucket = (typeof SCORE_BUCKETS)[number]["label"];

// ── Types ────────────────────────────────────────────────────────────────────

/** One approved task that violated the quality threshold. */
export interface ScoreViolationEntry {
  /** Full ULID task identifier. */
  task_id: string;
  /** Short (8-char) prefix for display. */
  task_id_short: string;
  /** Task title. */
  title: string;
  /** Agent that completed the task. */
  agent_name: string | null;
  /** Task type: implementation | research | housekeeping. */
  task_type: string;
  /** Verified quality score (0-1). Always < threshold. */
  quality_score: number;
  /** Score bucket classification. */
  bucket: ScoreBucket;
  /**
   * Per-dimension score breakdown parsed from verification_notes.
   * Null when notes did not contain a recognisable breakdown.
   */
  dimensions: ParsedDimensions | null;
  /** The weakest dimension name, or null if no breakdown available. */
  weakest_dimension: string | null;
  /** Source reference (e.g. "owner/repo#123"). */
  source_ref: string | null;
  /** Extracted GitHub PR URL, or null. */
  pr_url: string | null;
  /** LLM-generated explanation for why the score is low. */
  quality_explanation: string | null;
  /** Marginal approval reason badge, if present. */
  marginal_reason: string | null;
  /** Bypass reason if floor was overridden. */
  bypass_reason: string | null;
  /** When the task was approved. */
  approved_at: string;
}

/** Per-agent summary of violations. */
export interface ScoreViolationAgentSummary {
  agent_name: string;
  /** Total violations for this agent. */
  count: number;
  /** Mean quality_score across violations. */
  avg_score: number;
  /** Lowest quality_score for this agent. */
  min_score: number;
  /** Count per score bucket. */
  buckets: Record<ScoreBucket, number>;
}

/** Per-bucket summary for the report. */
export interface ScoreBucketSummary {
  label: ScoreBucket;
  count: number;
  /** Fraction of total violations in this bucket. */
  pct: number;
}

/** Options for `getScoreViolationsPayload()`. */
export interface ScoreViolationsOptions {
  /** Score ceiling (exclusive). Default: 0.80. */
  threshold?: number;
  /** Lookback window in days. Default: 7. */
  days?: number;
  /** Maximum entries to return. Default: 100. */
  limit?: number;
  /** Filter by agent name (case-insensitive substring match). */
  agent?: string;
}

/** Full payload returned by `getScoreViolationsPayload()`. */
export interface ScoreViolationsPayload {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** Score ceiling used for filtering. */
  threshold: number;
  /** Lookback window in days. */
  days: number;
  /** Total violations found. */
  total: number;
  /** Count per score bucket. */
  by_bucket: ScoreBucketSummary[];
  /** Per-agent breakdown, sorted by count descending. */
  per_agent: ScoreViolationAgentSummary[];
  /** Individual violation entries, sorted by score ascending. */
  violations: ScoreViolationEntry[];
  /** Applied agent filter, or null if not filtering. */
  agent_filter: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classifyBucket(score: number): ScoreBucket {
  for (const bucket of SCORE_BUCKETS) {
    if (score >= bucket.min && score < bucket.max) return bucket.label;
  }
  return "borderline"; // fallback for 0.75-0.80
}

function findWeakestDimension(dims: ParsedDimensions | null): string | null {
  if (!dims) return null;
  const entries: Array<[string, number | null]> = [
    ["correctness", dims.correctness],
    ["completeness", dims.completeness],
    ["test_coverage", dims.test_coverage],
    ["code_quality", dims.code_quality],
  ];
  let weakest: string | null = null;
  let weakestScore = Infinity;
  for (const [name, score] of entries) {
    if (score !== null && score < weakestScore) {
      weakest = name;
      weakestScore = score;
    }
  }
  return weakest;
}

function extractMarginalReason(task: Task): string | null {
  // Check verification_notes for marginal_reason patterns
  const notes = task.verification_notes ?? "";
  const match = /marginal[_\s]*reason[:\s]*([^\n]+)/i.exec(notes);
  if (match) return match[1]!.trim();

  // Check quality_explanation
  const explanation = task.quality_explanation ?? "";
  const explMatch = /marginal[_\s]*reason[:\s]*([^\n]+)/i.exec(explanation);
  if (explMatch) return explMatch[1]!.trim();

  return null;
}

function buildViolationEntry(task: Task): ScoreViolationEntry {
  const dims = parseDimensionsFromNotes(task.verification_notes);
  return {
    task_id: task.id,
    task_id_short: task.id.slice(0, 8),
    title: task.title,
    agent_name: task.agent_name ?? null,
    task_type: task.task_type,
    quality_score: task.quality_score!,
    bucket: classifyBucket(task.quality_score!),
    dimensions: dims,
    weakest_dimension: findWeakestDimension(dims),
    source_ref: task.source_ref ?? null,
    pr_url: extractPrUrl(task),
    quality_explanation: task.quality_explanation ?? null,
    marginal_reason: extractMarginalReason(task),
    bypass_reason: task.bypass_reason ?? null,
    approved_at: task.updated_at,
  };
}

function buildPerAgentSummary(violations: ScoreViolationEntry[]): ScoreViolationAgentSummary[] {
  const byAgent = new Map<string, {
    count: number;
    sum: number;
    min: number;
    buckets: Record<ScoreBucket, number>;
  }>();

  for (const v of violations) {
    const name = v.agent_name ?? "(unassigned)";
    const entry = byAgent.get(name) ?? {
      count: 0, sum: 0, min: Infinity,
      buckets: { critical: 0, low: 0, marginal: 0, borderline: 0 },
    };
    entry.count += 1;
    entry.sum += v.quality_score;
    entry.min = Math.min(entry.min, v.quality_score);
    entry.buckets[v.bucket] += 1;
    byAgent.set(name, entry);
  }

  return Array.from(byAgent.entries())
    .map(([agent_name, { count, sum, min, buckets }]) => ({
      agent_name,
      count,
      avg_score: count > 0 ? sum / count : 0,
      min_score: min === Infinity ? 0 : min,
      buckets,
    }))
    .sort((a, b) => b.count - a.count || a.agent_name.localeCompare(b.agent_name));
}

function buildBucketSummary(violations: ScoreViolationEntry[]): ScoreBucketSummary[] {
  const counts: Record<ScoreBucket, number> = { critical: 0, low: 0, marginal: 0, borderline: 0 };
  for (const v of violations) {
    counts[v.bucket] += 1;
  }
  const total = violations.length || 1;
  return SCORE_BUCKETS.map((b) => ({
    label: b.label,
    count: counts[b.label],
    pct: counts[b.label] / total,
  }));
}

// ── Main payload builder ─────────────────────────────────────────────────────

/**
 * Build the score-bypass violation report payload.
 *
 * Queries the store for all approved tasks with quality_score < `threshold`
 * within the last `days` days, ordered by score ascending (worst first).
 * Optionally filtered by agent name.
 *
 * @param store  A live IScoreViolationsStore instance (satisfied by StateStore).
 * @param opts   Optional configuration overrides.
 * @returns      The full violation report payload.
 */
export function getScoreViolationsPayload(
  store: IScoreViolationsStore,
  opts: ScoreViolationsOptions = {},
): ScoreViolationsPayload {
  const threshold = Number.isFinite(opts.threshold) && (opts.threshold ?? 0) > 0
    ? (opts.threshold ?? SCORE_VIOLATIONS_DEFAULT_THRESHOLD)
    : SCORE_VIOLATIONS_DEFAULT_THRESHOLD;

  const days = Number.isFinite(opts.days) && (opts.days ?? 0) >= 1
    ? Math.floor(opts.days ?? SCORE_VIOLATIONS_DEFAULT_DAYS)
    : SCORE_VIOLATIONS_DEFAULT_DAYS;

  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1
    ? Math.floor(opts.limit ?? SCORE_VIOLATIONS_DEFAULT_LIMIT)
    : SCORE_VIOLATIONS_DEFAULT_LIMIT;

  const agentFilter = opts.agent?.trim() || null;

  const rawTasks = store.getScoreViolationTasks(threshold, days, limit);

  // Apply agent filter if specified
  const filteredTasks = agentFilter
    ? rawTasks.filter((t) =>
        (t.agent_name ?? "").toLowerCase().includes(agentFilter.toLowerCase()),
      )
    : rawTasks;

  const violations = filteredTasks.map(buildViolationEntry);

  return {
    generated_at: new Date().toISOString(),
    threshold,
    days,
    total: violations.length,
    by_bucket: buildBucketSummary(violations),
    per_agent: buildPerAgentSummary(violations),
    violations,
    agent_filter: agentFilter,
  };
}

// ── Telegram formatter ───────────────────────────────────────────────────────

/**
 * Format a `ScoreViolationsPayload` as a Telegram message.
 *
 * @param payload     The payload from `getScoreViolationsPayload()`.
 * @param maxTasks    Maximum number of individual violations to show. Default: 10.
 * @param dashboardUrl  Optional dashboard base URL for clickthrough.
 */
export function formatScoreViolationsForTelegram(
  payload: ScoreViolationsPayload,
  maxTasks = 10,
  dashboardUrl?: string,
): string {
  const lines: string[] = [];
  const thresholdPct = Math.round(payload.threshold * 100);
  const headerIcon = payload.total === 0 ? "\u2705" : "\u26A0\uFE0F";

  lines.push(`${headerIcon} *Score-Bypass Violations* (< ${thresholdPct}%, last ${payload.days}d)`);
  lines.push(``);

  if (payload.total === 0) {
    lines.push(`_No approved tasks below ${thresholdPct}% in the last ${payload.days} days._`);
    lines.push(`All recent approvals meet the quality bar.`);
    return lines.join("\n");
  }

  lines.push(`_${payload.total} approved task${payload.total === 1 ? "" : "s"} scored below ${thresholdPct}%_`);
  if (payload.agent_filter) {
    lines.push(`_Filtered by agent: ${payload.agent_filter}_`);
  }
  lines.push(``);

  // Bucket breakdown
  const nonEmpty = payload.by_bucket.filter((b) => b.count > 0);
  if (nonEmpty.length > 0) {
    lines.push(`*By severity:*`);
    const bucketIcons: Record<ScoreBucket, string> = {
      critical: "\u{1F534}",
      low: "\u{1F7E0}",
      marginal: "\u{1F7E1}",
      borderline: "\u{1F535}",
    };
    for (const b of nonEmpty) {
      lines.push(`  ${bucketIcons[b.label]} ${b.label}: ${b.count} (${Math.round(b.pct * 100)}%)`);
    }
    lines.push(``);
  }

  // Per-agent summary
  if (payload.per_agent.length > 0) {
    lines.push(`*By agent:*`);
    for (const a of payload.per_agent.slice(0, 5)) {
      const avgPct = (a.avg_score * 100).toFixed(0);
      const minPct = (a.min_score * 100).toFixed(0);
      lines.push(
        `  \`${a.agent_name}\` \u2014 ${a.count} task${a.count === 1 ? "" : "s"} \u00B7 avg ${avgPct}% \u00B7 min ${minPct}%`,
      );
    }
    if (payload.per_agent.length > 5) {
      lines.push(`  _\u2026and ${payload.per_agent.length - 5} more agents_`);
    }
    lines.push(``);
  }

  // Individual violations
  lines.push(`*Violations (lowest first):*`);
  const shown = payload.violations.slice(0, maxTasks);
  for (const v of shown) {
    const scorePct = (v.quality_score * 100).toFixed(0);
    const agent = v.agent_name ?? "unassigned";
    const bucketIcons: Record<ScoreBucket, string> = {
      critical: "\u{1F534}",
      low: "\u{1F7E0}",
      marginal: "\u{1F7E1}",
      borderline: "\u{1F535}",
    };
    const icon = bucketIcons[v.bucket];

    lines.push(``);
    lines.push(`${icon} \`${v.task_id_short}\` *${scorePct}%* _(${agent})_`);
    lines.push(`  ${v.title.slice(0, 60)}${v.title.length > 60 ? "\u2026" : ""}`);

    // Dimension breakdown
    if (v.dimensions) {
      const fmt = (val: number | null) => val !== null ? `${(val * 100).toFixed(0)}` : "n/a";
      const mark = (val: number | null) => (val !== null && val >= 0.80 ? "\u2713" : "\u2717");
      lines.push(
        `  \`${mark(v.dimensions.correctness)}Corr:${fmt(v.dimensions.correctness)} ${mark(v.dimensions.completeness)}Comp:${fmt(v.dimensions.completeness)} ${mark(v.dimensions.test_coverage)}Test:${fmt(v.dimensions.test_coverage)} ${mark(v.dimensions.code_quality)}Code:${fmt(v.dimensions.code_quality)}\``,
      );
    }

    // Badges
    const badges: string[] = [];
    if (v.marginal_reason) badges.push(`marginal: ${v.marginal_reason.slice(0, 40)}`);
    if (v.bypass_reason) badges.push(`bypass: ${v.bypass_reason}`);
    if (v.weakest_dimension) badges.push(`weakest: ${v.weakest_dimension}`);
    if (badges.length > 0) {
      lines.push(`  _${badges.join(" | ")}_`);
    }

    if (v.pr_url) {
      lines.push(`  [PR](${v.pr_url})`);
    } else if (v.source_ref) {
      lines.push(`  Ref: \`${v.source_ref}\``);
    }
  }

  if (payload.violations.length > maxTasks) {
    lines.push(``);
    lines.push(`_\u2026and ${payload.violations.length - maxTasks} more_`);
  }

  if (dashboardUrl) {
    lines.push(``);
    lines.push(`[View full report](${dashboardUrl}/score-violations)`);
  }

  return lines.join("\n");
}
