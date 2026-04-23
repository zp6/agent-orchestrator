/**
 * HTTP client for the reviewer's /api/pr-guard-cooldowns endpoint (issue #1112).
 *
 * Before dispatching any GitHub-sourced task, the orchestrator calls
 * `queryPRGuardCooldown()` to check whether the reviewer has recorded an
 * active cooldown for the given (repo, issue) pair.  When a cooldown is
 * active the orchestrator suppresses the dispatch entirely — no task is
 * created, and a structured skip event is emitted instead.
 *
 * Design principles
 * ─────────────────
 * • Non-blocking / fail-open: if the reviewer is unreachable (connection
 *   refused, 404, timeout) the function returns `{ status: 'unavailable' }`
 *   and the dispatch proceeds normally.  A reviewer outage must never halt
 *   the orchestrator's dispatch loop.
 * • Fast timeout (3 s default): the check is on the hot dispatch path and
 *   must not materially increase per-issue latency.
 * • Structured logging: all outcomes are logged at DEBUG level so operators
 *   can trace cooldown decisions through the dispatch audit log.
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("pr-guard-cooldown-client");

/** Default reviewer base URL — overridden by REVIEWER_URL env var at runtime. */
export const DEFAULT_REVIEWER_URL = process.env["REVIEWER_URL"] ?? "http://localhost:3474";

/** Request timeout in milliseconds (kept short — this is a pre-dispatch hot path). */
export const COOLDOWN_CHECK_TIMEOUT_MS = 3_000;

// ── Response / outcome types ──────────────────────────────────────────────────

/**
 * Shape of the JSON body returned by `GET /api/pr-guard-cooldowns?repo=…&issue=…`.
 * The reviewer must include `active: true` **and** `expires_at` for the
 * orchestrator to treat the cooldown as active; any other response is treated
 * as inactive.
 */
export interface PRGuardCooldownResponse {
  /** Whether an active (non-expired) cooldown entry exists. */
  active: boolean;
  /** ISO-8601 timestamp when the cooldown expires (present when active === true). */
  expires_at?: string;
  /** PR number that originally triggered the cooldown, if known. */
  blocking_pr?: number;
}

/**
 * Structured outcome returned by `queryPRGuardCooldown()`.
 *
 * - `active`      — reviewer has a live cooldown; orchestrator should suppress dispatch.
 * - `inactive`    — no cooldown; orchestrator may proceed with dispatch.
 * - `unavailable` — check could not be completed; orchestrator fails open.
 */
export type PRGuardCooldownOutcome =
  | {
      status: "active";
      /** ISO-8601 timestamp when the cooldown expires. */
      expires_at: string;
      /** PR number that triggered the cooldown, if known. */
      blocking_pr?: number;
    }
  | { status: "inactive" }
  | {
      status: "unavailable";
      /** Human-readable reason (network error, HTTP status, timeout, etc.). */
      error: string;
    };

// ── HTTP client ───────────────────────────────────────────────────────────────

/**
 * Query the reviewer's `/api/pr-guard-cooldowns` endpoint to check whether
 * an active PR guard cooldown exists for `(repo, issueNumber)`.
 *
 * Always fails open: returns `{ status: 'unavailable' }` on any network or
 * parsing error so that reviewer outages never block the orchestrator.
 *
 * @param repo         Repository in `"owner/repo"` format.
 * @param issueNumber  GitHub issue number.
 * @param reviewerUrl  Reviewer base URL (default: env `REVIEWER_URL` or `http://localhost:3474`).
 * @param timeoutMs    Request timeout in milliseconds (default: 3 000).
 */
export async function queryPRGuardCooldown(
  repo: string,
  issueNumber: number,
  reviewerUrl = DEFAULT_REVIEWER_URL,
  timeoutMs = COOLDOWN_CHECK_TIMEOUT_MS,
): Promise<PRGuardCooldownOutcome> {
  const params = new URLSearchParams({
    repo,
    issue: String(issueNumber),
  });
  const url = `${reviewerUrl}/api/pr-guard-cooldowns?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    // 404 means the reviewer is running an older version without this endpoint.
    // Fail open so a partial rollout doesn't break the dispatch loop.
    if (res.status === 404) {
      log.debug("PR guard cooldown endpoint not found on reviewer — failing open", {
        reviewerUrl,
      });
      return { status: "unavailable", error: "HTTP 404 — endpoint not implemented" };
    }

    if (!res.ok) {
      log.debug("PR guard cooldown check returned non-OK status — failing open", {
        reviewerUrl,
        status: res.status,
      });
      return { status: "unavailable", error: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as PRGuardCooldownResponse;

    if (body.active && body.expires_at) {
      log.info("PR guard cooldown active on reviewer — dispatch will be suppressed", {
        repo,
        issueNumber,
        expiresAt: body.expires_at,
        blockingPR: body.blocking_pr,
      });
      return {
        status: "active",
        expires_at: body.expires_at,
        blocking_pr: body.blocking_pr,
      };
    }

    log.debug("PR guard cooldown inactive", { repo, issueNumber });
    return { status: "inactive" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const isTimeout =
      error.toLowerCase().includes("abort") || error.toLowerCase().includes("aborterror");
    if (isTimeout) {
      log.debug("PR guard cooldown check timed out — failing open", {
        reviewerUrl,
        timeoutMs,
      });
    } else {
      log.debug("PR guard cooldown check failed — failing open", {
        reviewerUrl,
        error,
      });
    }
    return { status: "unavailable", error };
  } finally {
    clearTimeout(timer);
  }
}
