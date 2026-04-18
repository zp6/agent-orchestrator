/**
 * Score integrity audit module (issue #263).
 *
 * Provides:
 *  - Score bucket breakdown: count of approved tasks per score range
 *  - Violation list: approved tasks below the enforcement threshold
 *  - Gate status: whether the score enforcement threshold is currently active
 *
 * The enforcement threshold (0.60) is the same floor used by StateStore.updateTask()
 * and insertVerificationResult() — tasks below this value cannot be written as
 * 'approved' by the write-path guard.  This audit module reads from the tasks
 * table to surface any gaps or historic records from before the guard was added.
 */

import type Database from "better-sqlite3";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum quality_score required for an approved task.
 * Mirrors StateStore.SUB_THRESHOLD_REJECTION_LIMIT (0.60).
 */
export const DEFAULT_MIN_SCORE = 0.60;

/** Score buckets used for the breakdown histogram. */
export const SCORE_BUCKETS = [
  { label: "0.00–0.59", min: 0,    max: 0.59 },
  { label: "0.60–0.74", min: 0.60, max: 0.74 },
  { label: "0.75–0.79", min: 0.75, max: 0.79 },
  { label: "0.80+",     min: 0.80, max: 1.0  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScoreBucketCount {
  label: string;
  min: number;
  max: number;
  count: number;
  /** Percentage of total approved tasks (0–100, rounded to 1 dp). */
  pct: number;
}

export interface ViolationEntry {
  task_id: string;
  agent: string | null;
  quality_score: number;
  approved_at: string;   // ISO timestamp (updated_at from tasks table)
  score_explanation: string | null;  // verification_notes content
}

export interface ScoreIntegrityReport {
  /** The minimum quality_score threshold being enforced. */
  min_score_threshold: number;
  /** Whether the score gate is currently active. */
  enforcement_active: boolean;
  total_approved: number;
  /** Number of approved tasks whose quality_score is below min_score_threshold. */
  total_violations: number;
  buckets: ScoreBucketCount[];
  /** Approved tasks below the threshold, ordered by quality_score ascending. */
  violations: ViolationEntry[];
  generated_at: string;
}

// ── Raw DB row type ───────────────────────────────────────────────────────────

interface ApprovedTaskRow {
  id: string;
  agent_name: string | null;
  quality_score: number;
  updated_at: string;
  verification_notes: string | null;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Check whether the score enforcement gate is currently active.
 *
 * The gate is active when the write-path guard in StateStore.updateTask() and
 * insertVerificationResult() is present (which it always is in this codebase).
 * This function returns a static true; it exists so callers can feature-flag
 * the panel via this exported function without coupling to internal store fields.
 */
export function isEnforcementActive(): boolean {
  return true;
}

/**
 * Query the state DB for the approved-task score distribution.
 *
 * @param db        - A better-sqlite3 Database instance (may be the StateStore's
 *                    internal db — cast with `(store as any).db` if needed, or
 *                    open the DB file directly for read-only auditing).
 * @param opts.days      - Look-back window in calendar days (default: 30).
 * @param opts.minScore  - Override the enforcement threshold (default: 0.60).
 */
export function getScoreIntegrityReport(
  db: Database.Database,
  opts: { days?: number; minScore?: number } = {},
): ScoreIntegrityReport {
  const days = opts.days ?? 30;
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;

  // Fetch all approved tasks with a non-null quality_score in the window.
  const rows = db
    .prepare<[number], ApprovedTaskRow>(
      `SELECT
         id,
         agent_name,
         quality_score,
         updated_at,
         verification_notes
       FROM tasks
       WHERE verification_status = 'approved'
         AND quality_score IS NOT NULL
         AND updated_at >= datetime('now', '-' || ? || ' days')
       ORDER BY quality_score ASC`,
    )
    .all(days);

  const total = rows.length;

  // ── Bucket computation ────────────────────────────────────────────────────
  const buckets: ScoreBucketCount[] = SCORE_BUCKETS.map((b) => {
    const count = rows.filter(
      (r) => r.quality_score >= b.min && r.quality_score <= b.max,
    ).length;
    const pct = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;
    return { label: b.label, min: b.min, max: b.max, count, pct };
  });

  // ── Violation list ────────────────────────────────────────────────────────
  const violations: ViolationEntry[] = rows
    .filter((r) => r.quality_score < minScore)
    .map((r) => ({
      task_id: r.id,
      agent: r.agent_name,
      quality_score: r.quality_score,
      approved_at: r.updated_at,
      score_explanation: r.verification_notes,
    }));

  return {
    min_score_threshold: minScore,
    enforcement_active: isEnforcementActive(),
    total_approved: total,
    total_violations: violations.length,
    buckets,
    violations,
    generated_at: new Date().toISOString(),
  };
}
