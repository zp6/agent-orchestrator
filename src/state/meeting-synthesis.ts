/**
 * Meeting synthesis persistence schema shared by the orchestrator daemon and
 * the state store.
 *
 * This module centralises the SQLite DDL and small schema-level helpers for
 * the `meeting_synthesis_signals` table so the daemon can keep a durable
 * audit trail even when the facilitator HTTP endpoint is unavailable.
 */

import type { MeetingSynthesisSignalRecord, MeetingSynthesisSignalType } from "./types.js";

export type { IMeetingSynthesisStore, MeetingSynthesisSignalRecord, MeetingSynthesisSignalType } from "./types.js";

/** Default age threshold for stale meeting synthesis alerts. */
export const DEFAULT_MEETING_SYNTHESIS_STALE_HOURS = 24;

/** Canonical pending signal type written after each meeting dispatch. */
export const MEETING_SYNTHESIS_PENDING_SIGNAL: MeetingSynthesisSignalType = "meeting_synthesis_pending";

/** Canonical resolved signal type written when the facilitator confirms synthesis. */
export const MEETING_SYNTHESIS_RESOLVED_SIGNAL: MeetingSynthesisSignalType = "meeting_synthesis_resolved";

/**
 * SQLite DDL for durable meeting synthesis tracking.
 *
 * One row is kept per meeting_id.  The orchestrator writes a pending row as
 * soon as the meeting is dispatched and later marks it resolved once the
 * facilitator's outcome API confirms the synthesis.
 */
export const MEETING_SYNTHESIS_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS meeting_synthesis_signals (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id         TEXT NOT NULL UNIQUE,
  topic              TEXT NOT NULL,
  signal_type        TEXT NOT NULL DEFAULT 'meeting_synthesis_pending',
  dispatched_at      TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at        TEXT,
  alerted_at         TEXT,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  last_outcome_status TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meeting_synthesis_signals_signal_type_dispatched_at
  ON meeting_synthesis_signals (signal_type, dispatched_at DESC);

CREATE INDEX IF NOT EXISTS idx_meeting_synthesis_signals_resolved_at
  ON meeting_synthesis_signals (resolved_at);

CREATE INDEX IF NOT EXISTS idx_meeting_synthesis_signals_alerted_at
  ON meeting_synthesis_signals (alerted_at);
`.trim();

/**
 * Return `true` when a meeting synthesis row should be considered stale.
 *
 * Rows are stale when they are still pending and their dispatch timestamp is
 * older than the provided look-back window.
 */
export function isMeetingSynthesisStale(
  signal: MeetingSynthesisSignalRecord,
  staleAfterHours: number = DEFAULT_MEETING_SYNTHESIS_STALE_HOURS,
): boolean {
  if (signal.signal_type !== MEETING_SYNTHESIS_PENDING_SIGNAL) {
    return false;
  }

  const cutoff = Date.now() - staleAfterHours * 3600_000;
  return new Date(signal.dispatched_at).getTime() <= cutoff;
}
