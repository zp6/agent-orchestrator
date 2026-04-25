/**
 * Standup Quality Trend — `standup_quality_history` persistence + `/standup-quality` Telegram command.
 *
 * Tracks per-agent standup verification scores over time so operators can detect
 * quality drift before it triggers revision cycles.  Addresses rapartlu/agent-dashboard#591
 * where a standup scoring 0.52 was silently approved with no operator-visible trend.
 *
 * ## DB migration
 *
 * Run `STANDUP_QUALITY_MIGRATION_SQL` once against `state.db`:
 *
 *   import { STANDUP_QUALITY_MIGRATION_SQL } from 'claude-orchestrator-reviewer';
 *   db.exec(STANDUP_QUALITY_MIGRATION_SQL);
 *
 * ## Telegram command
 *
 *   /standup-quality [agent] [days]
 *
 *   Examples:
 *     /standup-quality                     → all agents, last 7 days
 *     /standup-quality claude-agent-x      → one agent, last 7 days
 *     /standup-quality claude-agent-x 14   → one agent, last 14 days
 *     /standup-quality 14                  → all agents, last 14 days
 *
 * ## Integration point
 *
 * Call `recordStandupQualityScore()` from the verifier callback whenever a standup
 * task (task_type === "standup") completes verification:
 *
 *   import { recordStandupQualityScore } from 'claude-orchestrator-reviewer';
 *   recordStandupQualityScore(store, result.agent_id, result.score, actionItemCount, result.task_id);
 *
 * Issue #498 — part of coordinated change 01KQ2XDXASF4CF1C0GP4E1K8XJ.
 */

import { createLogger } from "../service/logger.js";

// ── Logger ────────────────────────────────────────────────────────────────────

const log = createLogger("standup-quality-trend");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * SQLite DDL to create the `standup_quality_history` table.
 * Safe to run multiple times — uses `CREATE TABLE IF NOT EXISTS`.
 */
export const STANDUP_QUALITY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS standup_quality_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  date TEXT NOT NULL,
  score REAL NOT NULL,
  action_item_count INTEGER NOT NULL DEFAULT 0,
  task_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_standup_quality_agent_date
  ON standup_quality_history (agent_id, date DESC);
`.trim();

/**
 * Default look-back window in days for the quality trend query.
 */
export const STANDUP_QUALITY_DEFAULT_DAYS = 7;

/**
 * Maximum look-back window accepted by the command parser.
 */
export const STANDUP_QUALITY_MAX_DAYS = 90;

/**
 * Quality score threshold below which a standup is considered "low quality".
 * Three consecutive low-quality standups triggers the `is_degrading` flag.
 */
export const STANDUP_LOW_SCORE_THRESHOLD = 0.7;

/**
 * Number of consecutive low-quality standups that triggers `is_degrading`.
 */
export const STANDUP_DEGRADATION_STREAK = 3;

// ── Sparkline helpers ─────────────────────────────────────────────────────────

/** Sparkline characters from lowest (▁) to highest (█) quality. */
const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";

/**
 * Convert a score (0–1) to a sparkline character.
 */
function scoreToSparkChar(score: number): string {
  const clamped = Math.max(0, Math.min(1, score));
  const idx = Math.min(
    SPARKLINE_CHARS.length - 1,
    Math.floor(clamped * SPARKLINE_CHARS.length),
  );
  return SPARKLINE_CHARS[idx];
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single standup quality record stored in `standup_quality_history`.
 */
export interface StandupQualityRecord {
  /** Auto-increment row ID (undefined before insert). */
  id?: number;
  /** Agent whose standup was verified. */
  agent_id: string;
  /** Calendar date of the standup ("YYYY-MM-DD"). */
  date: string;
  /** Quality score from the verifier (0–1). */
  score: number;
  /** Number of action items in this standup. */
  action_item_count: number;
  /** Task ID of the standup verification event. */
  task_id: string;
  /** ISO-8601 UTC timestamp of the insert. */
  recorded_at: string;
}

/**
 * Trend payload returned by `getStandupQualityTrend()` for the Telegram command.
 */
export interface StandupQualityTrendPayload {
  /** ISO-8601 timestamp of payload generation. */
  generated_at: string;
  /**
   * Agent ID filter applied, or null when all agents are included.
   */
  agent_id: string | null;
  /** Look-back window in days. */
  window_days: number;
  /** Records in the window, sorted by date ascending. */
  records: StandupQualityRecord[];
  /**
   * Average score across all records in the window.
   * Null when there are no records.
   */
  avg_score: number | null;
  /**
   * Number of consecutive most-recent standups that all scored below
   * `STANDUP_LOW_SCORE_THRESHOLD`.  0 when the most recent standup scored ≥ threshold.
   */
  low_score_streak: number;
  /**
   * True when `low_score_streak >= STANDUP_DEGRADATION_STREAK` —
   * signals that the agent's standup quality has been consistently poor.
   */
  is_degrading: boolean;
}

/**
 * Parsed command arguments for `/standup-quality [agent] [days]`.
 */
export interface StandupQualityParams {
  /** Agent ID filter, or null when not specified. */
  agent_id: string | null;
  /** Look-back window in days (1–90, default 7). */
  days: number;
}

/**
 * Minimal store interface consumed by standup quality trend functions.
 * Implemented by `StateStore`.
 */
export interface IStandupQualityStore {
  /**
   * Persist one standup quality record.
   * Fire-and-forget — callers should swallow errors from this method.
   */
  recordStandupQualityScore(record: Omit<StandupQualityRecord, "id">): void;

  /**
   * Return standup quality records filtered by agent and lower-bound timestamp.
   *
   * @param agentId - Agent ID filter; null/undefined to return all agents.
   * @param since   - ISO-8601 lower bound on `recorded_at`. Omit for no lower bound.
   * @returns Records sorted by `recorded_at` ascending.
   */
  getStandupQualityRecords(
    agentId?: string | null,
    since?: string,
  ): StandupQualityRecord[];
}

// ── Core logic ────────────────────────────────────────────────────────────────

/**
 * Record a standup quality score to `standup_quality_history`.
 *
 * Call this from the verifier callback when a standup task completes.
 *
 * @param store            - Store implementing `IStandupQualityStore`.
 * @param agentId          - Agent whose standup was verified.
 * @param score            - Quality score (0–1) from the verifier.
 * @param actionItemCount  - Number of action items in the standup.
 * @param taskId           - Task ID of the verification event.
 */
export function recordStandupQualityScore(
  store: IStandupQualityStore,
  agentId: string,
  score: number,
  actionItemCount: number,
  taskId: string,
): void {
  const now = new Date();
  const date = now.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const recorded_at = now.toISOString();

  try {
    store.recordStandupQualityScore({
      agent_id: agentId,
      date,
      score: Math.max(0, Math.min(1, score)),
      action_item_count: Math.max(0, Math.round(actionItemCount)),
      task_id: taskId,
      recorded_at,
    });
    log.info("Standup quality score recorded", { agentId, score, actionItemCount, taskId });
  } catch (err) {
    log.error("Failed to record standup quality score", {
      agentId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Compute the number of consecutive trailing standups all scoring below threshold.
 * Works backwards through the records (most recent last) until a record ≥ threshold is found.
 */
function computeLowScoreStreak(records: StandupQualityRecord[]): number {
  let streak = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].score < STANDUP_LOW_SCORE_THRESHOLD) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

/**
 * Build the standup quality trend payload for a given agent and window.
 *
 * @param store   - Store implementing `IStandupQualityStore`.
 * @param agentId - Agent ID filter (null = all agents).
 * @param days    - Look-back window in days (default 7, clamped to 1–90).
 */
export function getStandupQualityTrend(
  store: IStandupQualityStore,
  agentId?: string | null,
  days: number = STANDUP_QUALITY_DEFAULT_DAYS,
): StandupQualityTrendPayload {
  const generated_at = new Date().toISOString();
  const window_days = Math.max(1, Math.min(STANDUP_QUALITY_MAX_DAYS, Math.round(days)));
  const since = new Date(Date.now() - window_days * 24 * 60 * 60 * 1000).toISOString();
  const effectiveAgentId = agentId && agentId.trim() ? agentId.trim() : null;

  let records: StandupQualityRecord[] = [];
  try {
    records = store.getStandupQualityRecords(effectiveAgentId, since);
  } catch (err) {
    log.error("getStandupQualityTrend: store query failed", {
      agentId: effectiveAgentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const avg_score =
    records.length > 0
      ? Math.round((records.reduce((s, r) => s + r.score, 0) / records.length) * 1000) / 1000
      : null;

  const low_score_streak = computeLowScoreStreak(records);
  const is_degrading = low_score_streak >= STANDUP_DEGRADATION_STREAK;

  if (is_degrading) {
    log.warn("Standup quality degradation detected", {
      agentId: effectiveAgentId,
      low_score_streak,
      window_days,
    });
  }

  return {
    generated_at,
    agent_id: effectiveAgentId,
    window_days,
    records,
    avg_score,
    low_score_streak,
    is_degrading,
  };
}

// ── Parameter parser ──────────────────────────────────────────────────────────

/**
 * Parse arguments for the `/standup-quality [agent] [days]` Telegram command.
 *
 * Accepts:
 *   (empty)              → all agents, 7 days
 *   "14"                 → all agents, 14 days
 *   "claude-agent-x"     → claude-agent-x, 7 days
 *   "claude-agent-x 14"  → claude-agent-x, 14 days
 *   "14 claude-agent-x"  → claude-agent-x, 14 days  (order-independent)
 */
export function parseStandupQualityParams(args: string): StandupQualityParams {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  let agent_id: string | null = null;
  let days = STANDUP_QUALITY_DEFAULT_DAYS;

  for (const part of parts) {
    const num = parseInt(part, 10);
    if (Number.isFinite(num) && String(num) === part.trim()) {
      days = Math.max(1, Math.min(STANDUP_QUALITY_MAX_DAYS, num));
    } else {
      agent_id = part;
    }
  }

  return { agent_id, days };
}

// ── Telegram formatter ────────────────────────────────────────────────────────

/**
 * Format a standup quality trend payload for Telegram display.
 *
 * Output includes:
 * - Header with agent filter and window
 * - Sparkline of recent scores (oldest → newest, left → right)
 * - Average score badge
 * - Degradation warning when `is_degrading` is true
 */
export function formatStandupQualityForTelegram(payload: StandupQualityTrendPayload): string {
  const agentLabel = payload.agent_id ?? "all agents";
  const titleEmoji = payload.is_degrading ? "🔴" : "📊";
  const header = `${titleEmoji} <b>Standup Quality</b> — ${agentLabel} (${payload.window_days}d)`;

  if (payload.records.length === 0) {
    return `${header}\nNo standup records in window.`;
  }

  // Build sparkline (oldest left, newest right)
  const sparkline = payload.records.map((r) => scoreToSparkChar(r.score)).join("");

  // Score badge
  const avgPct = payload.avg_score !== null ? `${(payload.avg_score * 100).toFixed(0)}%` : "—";
  const avgEmoji =
    payload.avg_score === null
      ? "❓"
      : payload.avg_score >= 0.8
        ? "✅"
        : payload.avg_score >= 0.7
          ? "⚠️"
          : "🔴";

  const lines: string[] = [
    header,
    `<code>${sparkline}</code>  ${avgEmoji} avg <b>${avgPct}</b>  (${payload.records.length} standups)`,
  ];

  if (payload.is_degrading) {
    lines.push(
      `⚠️ <b>Degradation alert:</b> last ${payload.low_score_streak} standups all scored below ${(STANDUP_LOW_SCORE_THRESHOLD * 100).toFixed(0)}% — consider proactive coaching.`,
    );
  } else if (payload.low_score_streak > 0) {
    lines.push(
      `⚠️ ${payload.low_score_streak} recent standup(s) scored below ${(STANDUP_LOW_SCORE_THRESHOLD * 100).toFixed(0)}%.`,
    );
  }

  return lines.join("\n");
}
