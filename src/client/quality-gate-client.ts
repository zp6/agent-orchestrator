/**
 * HTTP client for the reviewer's POST /api/quality-gate/check endpoint.
 *
 * Before any PR is approved and enqueued for merge, the orchestrator calls
 * `checkQualityGate()` to verify the reviewer has not flagged the PR as
 * failing its quality gate.  This closes the bypass hole described in issue
 * #445 — previously the auto-approval path could enqueue a PR without the
 * reviewer's explicit sign-off.
 *
 * Design principles
 * ─────────────────
 * • Non-blocking / fail-open: if the reviewer is unreachable (connection
 *   refused, 404, timeout) the function returns `{ status: 'unavailable' }`
 *   and the approval proceeds normally.  A reviewer outage must never stall
 *   the orchestrator's merge queue.
 * • Fast timeout (5 s default): the check sits on the PR-approval hot path
 *   and must not materially delay merge throughput.
 * • Structured logging: all outcomes are logged at DEBUG level so operators
 *   can trace gate decisions through the review audit log.
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("quality-gate-client");

/** Default reviewer base URL — overridden by REVIEWER_URL env var at runtime. */
export const DEFAULT_REVIEWER_URL = process.env["REVIEWER_URL"] ?? "http://localhost:3474";

/** Request timeout in milliseconds (slightly longer than pr-guard — POST with body). */
export const QUALITY_GATE_TIMEOUT_MS = 5_000;

// ── Request / response types ──────────────────────────────────────────────────

/**
 * Payload sent to `POST /api/quality-gate/check` on the reviewer agent.
 */
export interface QualityGateCheckRequest {
  /** Repository in `"owner/repo"` format. */
  repo: string;
  /** GitHub PR number. */
  pr_number: number;
  /** Feature branch name (e.g. `"issue-123-my-feature"`). */
  branch: string;
}

/**
 * Shape of the JSON body returned by `POST /api/quality-gate/check`.
 *
 * The reviewer returns `passed: true` when all quality checks pass, or
 * `passed: false` (with an optional `reason`) when the PR should be blocked
 * from the merge queue.
 */
export interface QualityGateCheckResponse {
  /** Whether the PR passed all quality gate checks. */
  passed: boolean;
  /** Human-readable explanation when `passed === false`. */
  reason?: string;
  /** Score from 0–1 assigned by the reviewer, if available. */
  score?: number;
}

/**
 * Structured outcome returned by `checkQualityGate()`.
 *
 * - `passed`      — reviewer approved; orchestrator may enqueue for merge.
 * - `blocked`     — reviewer rejected; orchestrator should skip merge queue
 *                   and post a "request-changes" comment instead.
 * - `unavailable` — check could not be completed; orchestrator fails open and
 *                   proceeds with approval as before.
 */
export type QualityGateOutcome =
  | {
      status: "passed";
      /** Score returned by the reviewer, if provided. */
      score?: number;
    }
  | {
      status: "blocked";
      /** Human-readable reason from the reviewer. */
      reason: string;
      /** Score returned by the reviewer, if provided. */
      score?: number;
    }
  | {
      status: "unavailable";
      /** Human-readable error (network failure, timeout, HTTP error, etc.). */
      error: string;
    };

// ── HTTP client ───────────────────────────────────────────────────────────────

/**
 * Ask the reviewer's `/api/quality-gate/check` endpoint whether a PR is
 * clear to be approved and enqueued for merge.
 *
 * Always fails open: returns `{ status: 'unavailable' }` on any network or
 * parsing error so that reviewer outages never block the orchestrator's
 * approval path.
 *
 * @param repo         Repository in `"owner/repo"` format.
 * @param prNumber     GitHub PR number.
 * @param branch       Feature branch name.
 * @param reviewerUrl  Reviewer base URL (default: env `REVIEWER_URL` or `http://localhost:3474`).
 * @param timeoutMs    Request timeout in milliseconds (default: 5 000).
 */
export async function checkQualityGate(
  repo: string,
  prNumber: number,
  branch: string,
  reviewerUrl = DEFAULT_REVIEWER_URL,
  timeoutMs = QUALITY_GATE_TIMEOUT_MS,
): Promise<QualityGateOutcome> {
  const url = `${reviewerUrl}/api/quality-gate/check`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload: QualityGateCheckRequest = { repo, pr_number: prNumber, branch };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    // 404 means the reviewer is running an older version without this endpoint.
    // Fail open so a partial rollout does not break the approval loop.
    if (res.status === 404) {
      log.debug("Quality gate endpoint not found on reviewer — failing open", { reviewerUrl });
      return { status: "unavailable", error: "HTTP 404 — endpoint not implemented" };
    }

    if (!res.ok) {
      log.debug("Quality gate check returned non-OK status — failing open", {
        reviewerUrl,
        status: res.status,
      });
      return { status: "unavailable", error: `HTTP ${res.status}` };
    }

    const body = (await res.json()) as QualityGateCheckResponse;

    if (!body.passed) {
      const reason = body.reason ?? "Quality gate rejected the PR (no reason provided)";
      log.info("Quality gate blocked PR from merge queue", {
        repo,
        prNumber,
        reason,
        score: body.score,
      });
      return { status: "blocked", reason, score: body.score };
    }

    log.debug("Quality gate passed", { repo, prNumber, score: body.score });
    return { status: "passed", score: body.score };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const isTimeout =
      error.toLowerCase().includes("abort") || error.toLowerCase().includes("aborterror");
    if (isTimeout) {
      log.debug("Quality gate check timed out — failing open", { reviewerUrl, timeoutMs });
    } else {
      log.debug("Quality gate check failed — failing open", { reviewerUrl, error });
    }
    return { status: "unavailable", error };
  } finally {
    clearTimeout(timer);
  }
}
