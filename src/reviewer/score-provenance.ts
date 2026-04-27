/**
 * Score Provenance — `/api/score-provenance/:task_id` endpoint + default-fallback guard.
 *
 * Addresses the root cause of score-0 silent approvals (rapartlu/agent-dashboard#584):
 * when the verifier LLM response is malformed and the score silently defaults to 0,
 * the resulting `VerificationResult` is indistinguishable from a legitimately scored 0.
 *
 * This module introduces `ScoreSource` tracking so the quality gate can distinguish:
 *
 *   - `'llm_parse'`       — score came from a successful JSON parse of an LLM response
 *   - `'default_fallback'`— score defaulted to 0 because the LLM response was unparseable
 *   - `'operator_override'`— score was explicitly set by a human operator
 *
 * Tasks with `score_source='default_fallback'` MUST NOT be auto-approved — they signal
 * an infrastructure problem (LLM response format regression, context overflow, etc.)
 * not a quality judgment.
 *
 * ## DB migration
 *
 * Run `SCORE_PROVENANCE_MIGRATION_SQL` once against `state.db` to add the column:
 *
 *   import { SCORE_PROVENANCE_MIGRATION_SQL } from 'claude-orchestrator-reviewer';
 *   db.exec(SCORE_PROVENANCE_MIGRATION_SQL);
 *
 * ## REST endpoint
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getScoreProvenancePayload, parseScoreProvenanceParams } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/score-provenance/:task_id', (req, res) => {
 *     const params = parseScoreProvenanceParams(req.params);
 *     if (!params.task_id) { res.status(400).json({ error: 'task_id required' }); return; }
 *     res.json(getScoreProvenancePayload(store, params.task_id));
 *   });
 *
 * Issue #483 — part of coordinated change 01KQ2A192RZWVVRJ1FF3J3FA0Q.
 */

import { createLogger } from "../service/logger.js";
import type { VerificationResultRecord } from "../state/types.js";

// ── Logger ────────────────────────────────────────────────────────────────────

const log = createLogger("score-provenance");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * SQLite migration SQL that adds `score_source` to `verification_results`.
 * Safe to run multiple times — uses ADD COLUMN IF NOT EXISTS semantics via
 * a DO-NOTHING clause for SQLite (which doesn't support IF NOT EXISTS on columns).
 *
 * Callers should wrap in a try/catch and ignore "duplicate column" errors, which
 * SQLite surfaces as `table verification_results already has a column named score_source`.
 */
export const SCORE_PROVENANCE_MIGRATION_SQL = `
ALTER TABLE verification_results ADD COLUMN score_source TEXT DEFAULT 'llm_parse';
`.trim();

/**
 * Well-known sentinel note set by `parseResponse` on parse failure.
 * Used to detect `default_fallback` provenance in legacy records that
 * pre-date the `score_source` column.
 */
export const PARSE_FAILURE_NOTES_SENTINEL = "Failed to parse verification response";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Where a verification score originated.
 *
 * - `'llm_parse'`        — score came from a successful JSON parse of an LLM response
 * - `'default_fallback'` — score defaulted to 0 because the LLM response was unparseable
 * - `'operator_override'`— score was set explicitly by a human operator via `/approve`
 */
export type ScoreSource = "llm_parse" | "default_fallback" | "operator_override";

/**
 * The score provenance payload returned by `GET /api/score-provenance/:task_id`.
 */
export interface ScoreProvenancePayload {
  /** ISO-8601 timestamp of payload generation. */
  generated_at: string;
  /** Task ID queried. */
  task_id: string;
  /**
   * The most-recent verification record for the task, or null when not found.
   */
  record: ScoreProvenanceRecord | null;
}

/**
 * Score provenance for a single verified task.
 */
export interface ScoreProvenanceRecord {
  /** Task ULID. */
  task_id: string;
  /** Quality score from the verifier (0–1). */
  score: number;
  /** Whether the task was approved. */
  approved: boolean;
  /**
   * Score source — where the score originated.
   * `'default_fallback'` means the LLM response was unparseable; the score is unreliable.
   */
  score_source: ScoreSource;
  /** Agent that completed the task. */
  agent_id: string;
  /** ISO-8601 UTC timestamp of the verification event. */
  timestamp: string;
  /** The min_score threshold at verification time. */
  threshold: number;
  /** Whether this task should be blocked from auto-approval due to provenance. */
  should_block_auto_approval: boolean;
  /** Human-readable reason for blocking, if applicable. */
  block_reason: string | null;
}

/**
 * Minimal store interface for the score provenance endpoint.
 * Implemented by `StateStore`.
 */
export interface IScoreProvenanceStore {
  /**
   * Return the most recent `verification_results` record for the given task ID,
   * or null when no record exists.
   */
  getLatestVerificationRecord(taskId: string): VerificationResultRecord | null;
}

// ── Guard logic ───────────────────────────────────────────────────────────────

/**
 * Derive the `ScoreSource` for a `VerificationResultRecord`.
 *
 * Priority:
 * 1. If `record.score_source` is already populated (post-migration), use it.
 * 2. If `record.bypass_reason === 'operator_override'`, return `'operator_override'`.
 * 3. If `record.rejection_reason` contains the parse-failure sentinel, return `'default_fallback'`.
 * 4. Default to `'llm_parse'`.
 */
export function deriveScoreSource(
  record: VerificationResultRecord & { score_source?: string | null },
): ScoreSource {
  if (record.score_source === "default_fallback") return "default_fallback";
  if (record.score_source === "operator_override") return "operator_override";
  if (record.score_source === "llm_parse") return "llm_parse";

  // Legacy fallback — infer from well-known fields
  if (record.bypass_reason === "operator_override") return "operator_override";
  if (
    typeof record.rejection_reason === "string" &&
    record.rejection_reason.includes(PARSE_FAILURE_NOTES_SENTINEL)
  ) {
    return "default_fallback";
  }
  return "llm_parse";
}

/**
 * Returns `true` when a verification record should block auto-approval because
 * its score came from a fallback (parse failure) rather than a genuine LLM judgment.
 *
 * A `default_fallback` score is structurally meaningless — it is always 0 and
 * reflects an infrastructure failure, not a quality signal.  Auto-approving
 * a `default_fallback` score-0 result silently hides verifier failures.
 */
export function shouldBlockDefaultFallbackApproval(
  record: VerificationResultRecord & { score_source?: string | null },
): boolean {
  return deriveScoreSource(record) === "default_fallback";
}

// ── Payload builder ───────────────────────────────────────────────────────────

/**
 * Build the `GET /api/score-provenance/:task_id` response payload.
 */
export function getScoreProvenancePayload(
  store: IScoreProvenanceStore,
  taskId: string,
): ScoreProvenancePayload {
  const generated_at = new Date().toISOString();

  if (!taskId || typeof taskId !== "string" || !taskId.trim()) {
    log.warn("getScoreProvenancePayload called with empty task_id");
    return { generated_at, task_id: taskId ?? "", record: null };
  }

  let raw: (VerificationResultRecord & { score_source?: string | null }) | null = null;
  try {
    raw = store.getLatestVerificationRecord(taskId) as
      | (VerificationResultRecord & { score_source?: string | null })
      | null;
  } catch (err) {
    log.error("Failed to fetch verification record", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!raw) {
    return { generated_at, task_id: taskId, record: null };
  }

  const scoreSource = deriveScoreSource(raw);
  const shouldBlock = scoreSource === "default_fallback";
  const blockReason = shouldBlock
    ? "Score is a default fallback (0) from a parse failure — not a genuine quality judgment. Tasks with score_source='default_fallback' must not be auto-approved."
    : null;

  const record: ScoreProvenanceRecord = {
    task_id: raw.task_id,
    score: raw.score,
    approved: raw.first_pass === 1,
    score_source: scoreSource,
    agent_id: raw.agent_id,
    timestamp: raw.timestamp,
    threshold: raw.threshold,
    should_block_auto_approval: shouldBlock,
    block_reason: blockReason,
  };

  return { generated_at, task_id: taskId, record };
}

// ── Parameter parser ──────────────────────────────────────────────────────────

/**
 * Parse and validate URL parameters for `GET /api/score-provenance/:task_id`.
 * Returns `{ task_id }` — `task_id` is null when the input is missing or empty.
 */
export function parseScoreProvenanceParams(
  params: Record<string, string | undefined>,
): { task_id: string | null } {
  const raw = params["task_id"];
  if (typeof raw !== "string" || !raw.trim()) {
    return { task_id: null };
  }
  return { task_id: raw.trim() };
}

// ── Telegram formatter ────────────────────────────────────────────────────────

/**
 * Format a score provenance record for Telegram display.
 * Returns a concise single-line or multi-line string suitable for a bot message.
 */
export function formatScoreProvenanceForTelegram(payload: ScoreProvenancePayload): string {
  if (!payload.record) {
    return `🔍 Score Provenance: <code>${payload.task_id.slice(0, 8)}</code> — no verification record found`;
  }
  const { record } = payload;
  const sourceEmoji =
    record.score_source === "default_fallback"
      ? "🚨"
      : record.score_source === "operator_override"
        ? "👤"
        : "🤖";
  const sourceLabel =
    record.score_source === "default_fallback"
      ? "parse-failure fallback (UNRELIABLE)"
      : record.score_source === "operator_override"
        ? "operator override"
        : "LLM parse";

  const lines: string[] = [
    `${sourceEmoji} <b>Score Provenance</b>`,
    `Task: <code>${record.task_id.slice(0, 10)}</code>`,
    `Score: <b>${(record.score * 100).toFixed(0)}%</b> via ${sourceLabel}`,
    `Agent: ${record.agent_id}`,
    `Approved: ${record.approved ? "✅" : "❌"}`,
  ];

  if (record.should_block_auto_approval) {
    lines.push(`⛔ <b>Auto-approval blocked:</b> ${record.block_reason}`);
  }

  return lines.join("\n");
}
