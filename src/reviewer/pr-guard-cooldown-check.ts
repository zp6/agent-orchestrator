/**
 * PR guard cooldown per-issue check endpoint — issue #1112
 *
 * Problem: the PR guard cooldown table exists in the reviewer's SQLite state.db
 * and is checked *reactively* inside `checkPRExistenceBeforeDispatch()` —
 * after the task has already been created and dispatched to the reviewer.
 * This is too late: issue #440 was dispatched 11 times in rapid succession
 * before the cooldown had any effect because every dispatch cycle made a fresh
 * gh CLI call.
 *
 * Fix: expose a lightweight REST endpoint that the orchestrator (and proxy)
 * can call *before* creating a task, so dispatch is blocked at the source.
 *
 *   GET /api/pr-guard-cooldown/check?repo=rapartlu%2Fresearch-agent&issue=440
 *
 * Response when cooldown is active:
 *   {
 *     "repo": "rapartlu/research-agent",
 *     "issue_number": 440,
 *     "active": true,
 *     "expires_at": "2026-04-23T14:25:00.000Z",
 *     "ttl_remaining_seconds": 3120,
 *     "checked_at": "2026-04-23T13:12:40.000Z"
 *   }
 *
 * Response when no cooldown is active:
 *   {
 *     "repo": "rapartlu/research-agent",
 *     "issue_number": 440,
 *     "active": false,
 *     "expires_at": null,
 *     "ttl_remaining_seconds": null,
 *     "checked_at": "2026-04-23T13:12:40.000Z"
 *   }
 *
 * The orchestrator integrates this as a pre-dispatch gate: if `active === true`,
 * skip the issue for the current batch cycle.  No task is created, no gh CLI
 * call is made, and no redundant 'already-in-review' score is generated.
 *
 * Mount on the reviewer HTTP server:
 *
 *   app.get('/api/pr-guard-cooldown/check', (req, res) => {
 *     const repo = req.query.repo as string;
 *     const issue = parseInt(req.query.issue as string, 10);
 *     if (!repo || isNaN(issue)) {
 *       return res.status(400).json({ error: 'repo and issue query params are required' });
 *     }
 *     res.json(getCooldownCheckPayload(store, repo, issue));
 *   });
 *
 * Validation helpers for Express / Fastify request parsing:
 *   - `parseCooldownCheckParams(query)` — returns `{ repo, issueNumber }` or error string.
 *   - `formatCooldownCheckError(message)` — returns a `{ error: string }` object.
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("pr-guard-cooldown-check");

// ── Store interface ────────────────────────────────────────────────────────────

/**
 * Minimal store interface required by the per-issue cooldown check endpoint.
 *
 * Implemented by `StateStore` in `state/store.ts`.  Callers that only need the
 * check endpoint can depend on this narrower interface rather than the full store.
 */
export interface IPRGuardCooldownCheckStore {
  /**
   * Return the expiry timestamp (ISO-8601) for the active PR guard cooldown
   * entry for `(repo, issueNumber)`, or `null` when no active cooldown exists.
   *
   * An entry is "active" when it is present and `expires_at > now`.
   *
   * @param repo         - Repository in "owner/repo" format, e.g. "rapartlu/research-agent"
   * @param issueNumber  - GitHub issue number
   * @returns ISO-8601 `expires_at` string when active, `null` otherwise
   */
  getActivePRGuardCooldown(repo: string, issueNumber: number): string | null;
}

// ── Payload types ──────────────────────────────────────────────────────────────

/**
 * Response payload for `GET /api/pr-guard-cooldown/check`.
 *
 * When `active === false`, `expires_at` and `ttl_remaining_seconds` are both
 * `null` — the orchestrator should proceed with dispatch normally.
 *
 * When `active === true`, the orchestrator should skip dispatch for this issue
 * until `expires_at` (or wait `ttl_remaining_seconds` seconds before retrying).
 */
export interface PRGuardCooldownCheckPayload {
  /** Repository slug, e.g. "rapartlu/research-agent". */
  repo: string;
  /** GitHub issue number. */
  issue_number: number;
  /**
   * Whether an active (non-expired) PR guard cooldown exists for this
   * (repo, issue_number) pair.
   *
   * When `true` the orchestrator MUST NOT dispatch a new task for this issue.
   */
  active: boolean;
  /**
   * ISO-8601 timestamp when the active cooldown expires.
   * `null` when `active === false`.
   */
  expires_at: string | null;
  /**
   * Remaining TTL in seconds (rounded down) until the cooldown expires.
   * `null` when `active === false`.
   * May be 0 for entries expiring within the current second (rare).
   */
  ttl_remaining_seconds: number | null;
  /** ISO-8601 timestamp when this payload was generated. */
  checked_at: string;
}

/** Successful parse result from {@link parseCooldownCheckParams}. */
export interface CooldownCheckParams {
  repo: string;
  issueNumber: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build the `/api/pr-guard-cooldown/check` response payload for a single
 * (repo, issueNumber) pair.
 *
 * Reads from `store.getActivePRGuardCooldown()` and computes the remaining
 * TTL relative to the provided `now` (defaults to `new Date()`).
 *
 * @param store       Store implementing `IPRGuardCooldownCheckStore`
 * @param repo        Repository slug, e.g. "rapartlu/research-agent"
 * @param issueNumber GitHub issue number
 * @param now         Reference time for TTL computation (default: current time)
 */
export function getCooldownCheckPayload(
  store: IPRGuardCooldownCheckStore,
  repo: string,
  issueNumber: number,
  now: Date = new Date(),
): PRGuardCooldownCheckPayload {
  log.info("Checking PR guard cooldown", { repo, issueNumber });

  const expiresAt = store.getActivePRGuardCooldown(repo, issueNumber);

  if (!expiresAt) {
    return {
      repo,
      issue_number: issueNumber,
      active: false,
      expires_at: null,
      ttl_remaining_seconds: null,
      checked_at: now.toISOString(),
    };
  }

  const expiresMs = new Date(expiresAt).getTime();
  const ttlMs = Math.max(0, expiresMs - now.getTime());
  const ttlSeconds = Math.floor(ttlMs / 1000);

  log.info("Active PR guard cooldown found", {
    repo,
    issueNumber,
    expiresAt,
    ttlSeconds,
  });

  return {
    repo,
    issue_number: issueNumber,
    active: true,
    expires_at: expiresAt,
    ttl_remaining_seconds: ttlSeconds,
    checked_at: now.toISOString(),
  };
}

/**
 * Parse and validate query parameters for the cooldown check endpoint.
 *
 * @param query  Raw query-string object (e.g. `req.query` in Express)
 * @returns `{ ok: true, params }` on success, `{ ok: false, error }` on failure
 *
 * @example
 * const result = parseCooldownCheckParams(req.query);
 * if (!result.ok) return res.status(400).json(formatCooldownCheckError(result.error));
 * const payload = getCooldownCheckPayload(store, result.params.repo, result.params.issueNumber);
 */
export function parseCooldownCheckParams(
  query: Record<string, unknown>,
): { ok: true; params: CooldownCheckParams } | { ok: false; error: string } {
  const { repo, issue } = query;

  if (typeof repo !== "string" || !repo.trim()) {
    return { ok: false, error: "Missing or empty 'repo' query parameter (expected 'owner/repo' format)" };
  }

  if (!repo.includes("/")) {
    return { ok: false, error: `Invalid 'repo' format: expected 'owner/repo', got '${repo}'` };
  }

  const rawIssue = typeof issue === "string" ? issue : "";
  const issueNumber = parseInt(rawIssue, 10);

  if (!rawIssue || isNaN(issueNumber) || issueNumber <= 0) {
    return {
      ok: false,
      error: `Missing or invalid 'issue' query parameter: expected a positive integer, got '${rawIssue || "(missing)"}'`,
    };
  }

  return {
    ok: true,
    params: { repo: repo.trim(), issueNumber },
  };
}

/**
 * Build a standardized error response object for the cooldown check endpoint.
 *
 * @example
 * res.status(400).json(formatCooldownCheckError("Invalid repo format"));
 */
export function formatCooldownCheckError(message: string): { error: string } {
  return { error: message };
}
