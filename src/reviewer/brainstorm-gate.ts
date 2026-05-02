/**
 * Brainstorm dispatch gate — issue #625
 *
 * Problem: the fleet runs repeated blue-sky brainstorm sessions with identical
 * fleet state, consuming task slots and tokens during active failure cascades.
 * Meeting-facilitator issue #30 tracks the idempotency problem but lacks a
 * hash comparison mechanism to detect duplicate-state dispatches.
 *
 * Solution: the reviewer exposes a lightweight HTTP endpoint that the
 * orchestrator or meeting-facilitator can query *before* dispatching a
 * brainstorm task. The check is a two-part gate:
 *
 *   1. Hash match: if the current fleet_hash equals the hash used in the last
 *      session, the fleet state hasn't materially changed.
 *   2. Recency guard: even when hashes differ, allow at most one session per
 *      24-hour window (configurable via `minIntervalHours`).
 *
 * If both conditions are met the gate returns `should_dispatch: false`.
 * Otherwise `should_dispatch: true` and the caller may proceed.
 *
 * The fleet_hash is produced by `computeBatchHash()` (re-exported from
 * `src/index.ts`) applied to the current open-task snapshot.
 *
 *   GET /api/brainstorm-gate?fleet_hash=<sha256-hex>
 *
 * Response:
 *   {
 *     "should_dispatch": true,
 *     "last_dispatched_at": "2026-05-01T10:00:00.000Z",   // or null
 *     "hash_age_hours": 14.5,                              // hours since last hash match; null if no prior match
 *     "reason": "hash_changed"                             // "hash_changed" | "interval_elapsed" | "no_prior_session" | "skip_same_hash" | "skip_within_interval"
 *   }
 *
 * After a brainstorm is dispatched, the orchestrator records the session by
 * calling `POST /api/brainstorm-gate/record` (body: BrainstormSessionRecord).
 * The reviewer persists rows to the `brainstorm_sessions` SQLite table so the
 * gate has history on the next query.
 *
 * Mount on the reviewer HTTP server:
 *
 *   app.get('/api/brainstorm-gate', (req, res) => {
 *     const fleetHash = req.query.fleet_hash as string;
 *     if (!fleetHash) return res.status(400).json({ error: "'fleet_hash' query param is required" });
 *     res.json(getBrainstormGatePayload(store, fleetHash));
 *   });
 *
 *   app.post('/api/brainstorm-gate/record', (req, res) => {
 *     const body: BrainstormSessionRecord = req.body;
 *     store.recordBrainstormSession(body);
 *     res.json({ ok: true });
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("brainstorm-gate");

/** Default minimum hours between brainstorm sessions regardless of hash. */
const DEFAULT_MIN_INTERVAL_HOURS = 24;

// ── Store interface ────────────────────────────────────────────────────────────

/**
 * Minimal store interface required by the brainstorm gate.
 *
 * Implemented by `StateStore` in `state/store.ts`.
 */
export interface IBrainstormGateStore {
  /**
   * Return the most recent brainstorm session row, or `null` when no sessions
   * have been recorded yet.
   */
  getLastBrainstormSession(): BrainstormSessionRow | null;

  /**
   * Persist a new brainstorm session record.
   *
   * Called by the orchestrator/meeting-facilitator immediately after a
   * brainstorm task is dispatched so the gate has history on the next query.
   */
  recordBrainstormSession(record: BrainstormSessionRecord): void;
}

// ── Data types ─────────────────────────────────────────────────────────────────

/**
 * A row from the `brainstorm_sessions` SQLite table.
 */
export interface BrainstormSessionRow {
  /** Auto-assigned ULID or integer primary key (string in SQLite). */
  id: string;
  /** SHA-256 hex digest of the fleet state snapshot at dispatch time. */
  fleet_hash: string;
  /** ISO-8601 timestamp when the brainstorm was dispatched. */
  dispatched_at: string;
  /** Agent failure rate at dispatch time (0.0–1.0), if known. */
  failure_rate: number | null;
  /** Number of open GitHub issues at dispatch time, if known. */
  open_issues_count: number | null;
  /** Number of mergeable open PRs at dispatch time, if known. */
  mergeable_prs_count: number | null;
}

/**
 * Payload supplied by the caller when recording a dispatched brainstorm.
 *
 * The `dispatched_at` field is optional: the store will default to the current
 * timestamp when omitted.
 */
export interface BrainstormSessionRecord {
  /** SHA-256 hex digest of the fleet state snapshot. */
  fleet_hash: string;
  /** ISO-8601 dispatch timestamp (defaults to now when omitted). */
  dispatched_at?: string;
  /** Agent failure rate at dispatch time. */
  failure_rate?: number;
  /** Number of open GitHub issues at dispatch time. */
  open_issues_count?: number;
  /** Number of mergeable open PRs at dispatch time. */
  mergeable_prs_count?: number;
}

/**
 * The reason returned in a `BrainstormGatePayload`.
 *
 * - `no_prior_session`    — no session has ever been recorded; dispatch is allowed.
 * - `hash_changed`        — fleet state has materially changed; dispatch is allowed.
 * - `interval_elapsed`    — enough time has passed since the last session; dispatch is allowed.
 * - `skip_same_hash`      — hash matches AND within the minimum interval; skip.
 * - `skip_within_interval`— interval hasn't elapsed yet (even if hash differs); skip.
 */
export type BrainstormGateReason =
  | "no_prior_session"
  | "hash_changed"
  | "interval_elapsed"
  | "skip_same_hash"
  | "skip_within_interval";

/**
 * Response payload for `GET /api/brainstorm-gate`.
 */
export interface BrainstormGatePayload {
  /**
   * Whether the caller should proceed with dispatching the brainstorm task.
   *
   * `true`  — dispatch is safe (hash changed, interval elapsed, or no prior session).
   * `false` — skip this dispatch cycle; fleet state hasn't materially changed.
   */
  should_dispatch: boolean;
  /**
   * ISO-8601 timestamp when the last brainstorm session was dispatched.
   * `null` when no prior session exists.
   */
  last_dispatched_at: string | null;
  /**
   * How many hours have elapsed since the last session that used an identical
   * fleet_hash.  `null` when no session with a matching hash exists.
   */
  hash_age_hours: number | null;
  /**
   * Machine-readable reason for the decision.
   */
  reason: BrainstormGateReason;
  /**
   * ISO-8601 timestamp when this payload was generated.
   */
  checked_at: string;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build the `/api/brainstorm-gate` response payload for the given fleet hash.
 *
 * Logic:
 *   1. If no prior session exists → allow (`no_prior_session`).
 *   2. Compute elapsed hours since the last session's `dispatched_at`.
 *      If elapsed < `minIntervalHours` AND hash matches → skip (`skip_same_hash`).
 *      If elapsed < `minIntervalHours` AND hash differs → skip (`skip_within_interval`).
 *   3. If elapsed >= `minIntervalHours` AND hash matches → allow (`interval_elapsed`).
 *   4. If elapsed >= `minIntervalHours` AND hash differs → allow (`hash_changed`).
 *
 * @param store            Store implementing {@link IBrainstormGateStore}
 * @param fleetHash        SHA-256 hex digest of the current fleet state snapshot
 * @param minIntervalHours Minimum hours between sessions (default: 24)
 * @param now              Reference time (default: current time)
 */
export function getBrainstormGatePayload(
  store: IBrainstormGateStore,
  fleetHash: string,
  minIntervalHours: number = DEFAULT_MIN_INTERVAL_HOURS,
  now: Date = new Date(),
): BrainstormGatePayload {
  log.info("Evaluating brainstorm gate", { fleetHash, minIntervalHours });

  const last = store.getLastBrainstormSession();

  if (!last) {
    log.info("No prior brainstorm session — allowing dispatch");
    return {
      should_dispatch: true,
      last_dispatched_at: null,
      hash_age_hours: null,
      reason: "no_prior_session",
      checked_at: now.toISOString(),
    };
  }

  const lastDispatchedMs = new Date(last.dispatched_at).getTime();
  const elapsedMs = now.getTime() - lastDispatchedMs;
  const elapsedHours = elapsedMs / (1000 * 60 * 60);

  const hashMatches = last.fleet_hash === fleetHash;

  // Compute hash_age_hours: how long ago we last saw this exact hash.
  // We only have the most recent session here; if the hash matches, that
  // session IS the last matching one.  If it doesn't match, we report null.
  const hashAgeHours = hashMatches ? elapsedHours : null;

  log.info("Brainstorm gate evaluation", {
    hashMatches,
    elapsedHours: elapsedHours.toFixed(2),
    minIntervalHours,
    lastDispatchedAt: last.dispatched_at,
  });

  if (elapsedHours < minIntervalHours) {
    // Within the minimum interval — skip regardless of hash.
    const reason: BrainstormGateReason = hashMatches
      ? "skip_same_hash"
      : "skip_within_interval";
    log.info(`Brainstorm gate: skipping (${reason})`, { elapsedHours, minIntervalHours });
    return {
      should_dispatch: false,
      last_dispatched_at: last.dispatched_at,
      hash_age_hours: hashAgeHours,
      reason,
      checked_at: now.toISOString(),
    };
  }

  // Interval has elapsed — allow dispatch.
  const reason: BrainstormGateReason = hashMatches ? "interval_elapsed" : "hash_changed";
  log.info(`Brainstorm gate: allowing dispatch (${reason})`, { elapsedHours, minIntervalHours });
  return {
    should_dispatch: true,
    last_dispatched_at: last.dispatched_at,
    hash_age_hours: hashAgeHours,
    reason,
    checked_at: now.toISOString(),
  };
}

/**
 * Parse and validate query parameters for the brainstorm gate endpoint.
 *
 * @param query  Raw query-string object (e.g. `req.query` in Express)
 * @returns `{ ok: true, fleetHash }` on success, `{ ok: false, error }` on failure
 *
 * @example
 * const result = parseBrainstormGateParams(req.query);
 * if (!result.ok) return res.status(400).json({ error: result.error });
 * const payload = getBrainstormGatePayload(store, result.fleetHash);
 */
export function parseBrainstormGateParams(
  query: Record<string, unknown>,
): { ok: true; fleetHash: string } | { ok: false; error: string } {
  const { fleet_hash } = query;

  if (typeof fleet_hash !== "string" || !fleet_hash.trim()) {
    return {
      ok: false,
      error: "Missing or empty 'fleet_hash' query parameter (expected a SHA-256 hex digest)",
    };
  }

  const trimmed = fleet_hash.trim();

  // Validate: SHA-256 produces a 64-character lowercase hex string.
  if (!/^[0-9a-f]{64}$/i.test(trimmed)) {
    return {
      ok: false,
      error: `Invalid 'fleet_hash': expected a 64-character hex string, got '${trimmed.slice(0, 16)}...'`,
    };
  }

  return { ok: true, fleetHash: trimmed.toLowerCase() };
}
