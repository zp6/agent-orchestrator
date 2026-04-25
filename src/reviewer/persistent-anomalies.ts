/**
 * Persistent Anomaly Tracker — detect and surface quality anomalies that
 * recur across ≥2 consecutive analysis cycles without remediation.
 *
 * Addresses the silent-recurrence problem in rapartlu/agent-dashboard#584:
 * score-0 approvals (or any quality anomaly) appearing in the same state
 * across multiple orchestrator analysis batches receive no escalation —
 * they silently repeat forever.
 *
 * ## How it works
 *
 * Each time the improvement detector or quality-anomaly scanner runs, callers
 * invoke `recordAnomalyObservation()` for each detected anomaly. Observations
 * are stored in the `score_anomaly_observations` SQLite table.
 *
 * `getPersistentAnomalies(store, { minCycles: 2 })` returns all tasks that
 * have been observed in anomaly state in ≥2 distinct analysis cycles —
 * indicating the problem has not been resolved between passes.
 *
 * `getPersistentAnomaliesPayload()` builds a REST payload for
 * `/api/persistent-anomalies`.  `formatPersistentAnomaliesForTelegram()`
 * formats the payload for the daily supervisor Telegram digest.
 *
 * ## DB migration
 *
 * Run `PERSISTENT_ANOMALIES_MIGRATION_SQL` once against `state.db`:
 *
 *   import { PERSISTENT_ANOMALIES_MIGRATION_SQL } from 'claude-orchestrator-reviewer';
 *   db.exec(PERSISTENT_ANOMALIES_MIGRATION_SQL);
 *
 * ## REST endpoint
 *
 *   import { getPersistentAnomaliesPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/persistent-anomalies', (req, res) => {
 *     res.json(getPersistentAnomaliesPayload(store, {
 *       minCycles: req.query.min_cycles ? Number(req.query.min_cycles) : 2,
 *       days:      req.query.days      ? Number(req.query.days)       : 7,
 *     }));
 *   });
 *
 * ## Calling from the improvement detector
 *
 *   import { recordAnomalyObservation } from 'claude-orchestrator-reviewer';
 *
 *   // At the start of each analysis run, generate a cycle_id (e.g. ULID or ISO date):
 *   const cycleId = new Date().toISOString().slice(0, 16); // "2026-04-25T09:00"
 *   for (const anomaly of detectedAnomalies) {
 *     recordAnomalyObservation(store, { task_id: anomaly.task_id, cycle_id: cycleId, ... });
 *   }
 *
 * Issue #483 — part of coordinated change 01KQ2A192RZWVVRJ1FF3J3FA0Q.
 */

import { createLogger } from "../service/logger.js";

// ── Logger ────────────────────────────────────────────────────────────────────

const log = createLogger("persistent-anomalies");

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default number of distinct analysis cycles before an anomaly is "persistent". */
export const DEFAULT_MIN_CYCLES = 2;

/** Default lookback window in days for anomaly observations. */
export const DEFAULT_ANOMALY_LOOKBACK_DAYS = 7;

/** Default maximum result count. */
export const DEFAULT_PERSISTENT_ANOMALIES_LIMIT = 50;

/**
 * SQLite DDL for the `score_anomaly_observations` table.
 *
 * Each row records one observation of a quality anomaly in one analysis cycle.
 * Multiple rows per task_id (one per cycle it appeared in) allow the
 * "persistence" query to count distinct cycles.
 */
export const PERSISTENT_ANOMALIES_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS score_anomaly_observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT    NOT NULL,
  cycle_id    TEXT    NOT NULL,
  agent_name  TEXT,
  score       REAL    NOT NULL DEFAULT 0,
  anomaly_type TEXT   NOT NULL DEFAULT 'low_score_approved',
  observed_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sao_task_id    ON score_anomaly_observations (task_id);
CREATE INDEX IF NOT EXISTS idx_sao_cycle_id   ON score_anomaly_observations (cycle_id);
CREATE INDEX IF NOT EXISTS idx_sao_observed_at ON score_anomaly_observations (observed_at);
`.trim();

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single observation of a quality anomaly in one analysis cycle.
 * Written to `score_anomaly_observations` by callers.
 */
export interface AnomalyObservation {
  /** Task ULID. */
  task_id: string;
  /**
   * Opaque cycle identifier — callers choose the granularity.
   * Recommended: ISO-8601 datetime truncated to the nearest minute/hour
   * (e.g. `"2026-04-25T09:00"`) or a ULID generated once per analysis run.
   *
   * Distinct `cycle_id` values for the same `task_id` indicate it was seen
   * in multiple separate analysis passes.
   */
  cycle_id: string;
  /** Agent that owns the task, for grouping. */
  agent_name?: string | null;
  /** Quality score at observation time (0–1). */
  score?: number;
  /**
   * Anomaly category.
   * - `'low_score_approved'`  — score < 0.60 but task was approved
   * - `'high_score_rejected'` — score > 0.85 but task was rejected
   * - `'default_fallback_approved'` — score was a parse-failure default (score_source=default_fallback)
   */
  anomaly_type?: "low_score_approved" | "high_score_rejected" | "default_fallback_approved";
}

/**
 * A task whose anomaly has persisted across ≥ minCycles analysis cycles.
 */
export interface PersistentAnomaly {
  /** Task ULID. */
  task_id: string;
  /** Agent responsible for the task. */
  agent_name: string | null;
  /** Latest quality score observed. */
  latest_score: number;
  /** Number of distinct analysis cycles in which this task was observed as anomalous. */
  cycle_count: number;
  /** Anomaly category from the most recent observation. */
  anomaly_type: string;
  /** ISO-8601 timestamp of the first observation. */
  first_observed_at: string;
  /** ISO-8601 timestamp of the most recent observation. */
  last_observed_at: string;
}

/**
 * Full REST payload for `GET /api/persistent-anomalies`.
 */
export interface PersistentAnomaliesPayload {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** Minimum distinct cycles required to appear in this list. */
  min_cycles: number;
  /** Lookback window in days. */
  days: number;
  /** Total count of persistent anomalies in this window. */
  total: number;
  /** Anomalies grouped by agent for at-a-glance operator review. */
  by_agent: Array<{ agent_name: string; count: number }>;
  /** Full anomaly list, ordered by cycle_count DESC, last_observed_at DESC. */
  anomalies: PersistentAnomaly[];
}

/**
 * Options for `getPersistentAnomaliesPayload`.
 */
export interface PersistentAnomaliesOptions {
  /** Minimum cycles to qualify as "persistent". Default: 2. */
  minCycles?: number;
  /** Lookback window in days. Default: 7. */
  days?: number;
  /** Maximum rows to return. Default: 50. */
  limit?: number;
}

/**
 * Minimal store interface for persistent anomaly reads and writes.
 * Implemented by `StateStore`.
 */
export interface IPersistentAnomalyStore {
  /**
   * Insert one anomaly observation into `score_anomaly_observations`.
   * Safe to call multiple times per task per cycle — the uniqueness
   * semantics (dedup within a cycle) are left to callers via `cycle_id`.
   */
  insertAnomalyObservation(obs: AnomalyObservation): void;

  /**
   * Return tasks that have appeared as anomalous in ≥ `minCycles` distinct
   * analysis cycles within the last `days` days.
   *
   * Ordered by `cycle_count DESC`, `last_observed_at DESC`.
   *
   * @param minCycles - Minimum distinct cycles to qualify. Default: 2.
   * @param days      - Lookback window in days. Default: 7.
   * @param limit     - Maximum rows to return. Default: 50.
   */
  getPersistentAnomalies(minCycles?: number, days?: number, limit?: number): PersistentAnomaly[];
}

// ── Record helper ─────────────────────────────────────────────────────────────

/**
 * Record a quality anomaly observation for the current analysis cycle.
 *
 * This is the primary write-path.  Callers should invoke this once per
 * detected anomaly at the end of each improvement-detector / quality-anomaly
 * pass.  Use a consistent `cycleId` within a single analysis run so that
 * repeated observations in the same run are deduplicated by `cycle_id`.
 *
 * @param store   - Any object implementing `IPersistentAnomalyStore`.
 * @param obs     - The anomaly observation to record.
 */
export function recordAnomalyObservation(
  store: IPersistentAnomalyStore,
  obs: AnomalyObservation,
): void {
  try {
    store.insertAnomalyObservation({
      task_id: obs.task_id,
      cycle_id: obs.cycle_id,
      agent_name: obs.agent_name ?? null,
      score: obs.score ?? 0,
      anomaly_type: obs.anomaly_type ?? "low_score_approved",
    });
  } catch (err) {
    // Non-fatal — anomaly tracking should not block the analysis path
    log.error("Failed to record anomaly observation", {
      taskId: obs.task_id,
      cycleId: obs.cycle_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Payload builder ───────────────────────────────────────────────────────────

/**
 * Build the `GET /api/persistent-anomalies` REST payload.
 */
export function getPersistentAnomaliesPayload(
  store: IPersistentAnomalyStore,
  opts: PersistentAnomaliesOptions = {},
): PersistentAnomaliesPayload {
  const minCycles = Math.max(1, Math.floor(opts.minCycles ?? DEFAULT_MIN_CYCLES));
  const days = Math.max(1, Math.floor(opts.days ?? DEFAULT_ANOMALY_LOOKBACK_DAYS));
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_PERSISTENT_ANOMALIES_LIMIT));
  const generated_at = new Date().toISOString();

  let anomalies: PersistentAnomaly[] = [];
  try {
    anomalies = store.getPersistentAnomalies(minCycles, days, limit);
  } catch (err) {
    log.error("Failed to query persistent anomalies", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Aggregate by agent
  const agentCounts = new Map<string, number>();
  for (const anomaly of anomalies) {
    const name = anomaly.agent_name ?? "unknown";
    agentCounts.set(name, (agentCounts.get(name) ?? 0) + 1);
  }
  const by_agent = [...agentCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([agent_name, count]) => ({ agent_name, count }));

  return {
    generated_at,
    min_cycles: minCycles,
    days,
    total: anomalies.length,
    by_agent,
    anomalies,
  };
}

// ── Telegram formatter ────────────────────────────────────────────────────────

/**
 * Format a persistent-anomalies payload for Telegram.
 *
 * Designed to be embedded as a section in the daily supervisor digest.
 * Returns an empty string when there are no persistent anomalies.
 */
export function formatPersistentAnomaliesForTelegram(
  payload: PersistentAnomaliesPayload,
): string {
  if (payload.anomalies.length === 0) {
    return "";
  }

  const lines: string[] = [];
  lines.push(
    `🔁 <b>Persistent anomalies</b> (≥${payload.min_cycles} cycles, last ${payload.days}d): <b>${payload.total}</b>`,
  );

  for (const anomaly of payload.anomalies.slice(0, 5)) {
    const taskShort = anomaly.task_id.slice(0, 10);
    const scoreStr = (anomaly.latest_score * 100).toFixed(0);
    const cycleLabel = anomaly.cycle_count === 1 ? "1 cycle" : `${anomaly.cycle_count} cycles`;
    const typeLabel =
      anomaly.anomaly_type === "default_fallback_approved"
        ? "parse-failure approved"
        : anomaly.anomaly_type === "high_score_rejected"
          ? "high-score rejected"
          : "low-score approved";
    const agent = anomaly.agent_name ?? "unknown";

    lines.push(
      `  • <code>${taskShort}</code> | ${agent} | score=${scoreStr}% | ${typeLabel} | seen ${cycleLabel}`,
    );
  }

  if (payload.anomalies.length > 5) {
    lines.push(`  <i>… and ${payload.anomalies.length - 5} more. See /api/persistent-anomalies</i>`);
  }

  lines.push("");
  lines.push(
    "⚠️ These tasks have been in anomaly state across multiple analysis cycles with no resolution. Consider creating fix issues.",
  );

  return lines.join("\n");
}

/**
 * Generate a cycle ID for the current analysis run.
 *
 * Uses the current UTC time truncated to the nearest minute as an opaque
 * cycle identifier.  All anomalies recorded within the same minute share
 * the same `cycle_id`, so a single analysis run that detects multiple
 * anomalies produces a clean single-cycle grouping.
 *
 * Callers may substitute their own cycle ID (e.g. an analysis-run ULID)
 * for finer-grained deduplication.
 */
export function generateCycleId(): string {
  return new Date().toISOString().slice(0, 16); // "2026-04-25T09:00"
}
