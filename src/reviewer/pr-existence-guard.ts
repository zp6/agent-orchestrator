/**
 * PR existence guard — issue #178
 *
 * Pre-dispatch filter that prevents re-implementation waste when an open PR
 * already exists for the target issue.  Before dispatching any GitHub-sourced
 * task the orchestrator calls `checkPRExistenceBeforeDispatch()`, which:
 *
 *   1. Lists all open PRs for the repo (one gh CLI call, result cached per
 *      dispatch cycle via the optional `prListCache` parameter).
 *   2. Checks whether any open PR matches the issue via:
 *        a. Branch name matching `issue-{N}-*` or `issue-{N}_*`
 *        b. PR body containing a "Closes #N" reference (standard GitHub close
 *           keywords: closes, fixes, resolves — case-insensitive)
 *   3. If a match is found: returns `{ skip: true, resolution: 'already-in-review' }`
 *      so the orchestrator can route directly to the PR review queue instead of
 *      re-dispatching implementation work.
 *   4. If no match is found: returns `{ skip: false, resolution: 'no-existing-pr' }`.
 *   5. On any error: returns `{ skip: false, resolution: 'check-failed' }` (fail-open).
 *
 * Acceptance criteria (issue #178):
 *   ✓ Zero re-implementation dispatches for issues that already have an open PR
 *     with a matching Closes reference or issue-{N}-* branch name
 *   ✓ 'already-in-review' resolution path appears in task history with existing PR link
 *   ✓ DispatchRationale.existing_pr_check_result is populated on every dispatch
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import type { ShortCircuitDimension } from "../state/types.js";

/** Minimal store interface needed by the PR existence guard cooldown. */
export interface IPRGuardCooldownStore {
  setPRGuardCooldown(repo: string, issueNumber: number, ttlMinutes?: number): void;
  isPRGuardCooldownActive(repo: string, issueNumber: number): boolean;
}

const log = createLogger("pr-existence-guard");

// ── Callback type ─────────────────────────────────────────────────────────────

/**
 * Callback invoked immediately when a short-circuit exit is taken.
 *
 * The orchestrator provides this as part of guard options so that
 * `recordShortCircuitScore()` is called at the moment of short-circuiting
 * rather than relying on the Phase 3 backfill (5+ min latency).
 *
 * @param taskId    - Task to score
 * @param dimension - Short-circuit category
 * @param reason    - Human-readable explanation
 */
export type ShortCircuitCallback = (
  taskId: string,
  dimension: ShortCircuitDimension,
  reason: string,
) => void;

/**
 * Options accepted by `checkPRExistenceBeforeDispatch()`.
 */
export interface PRExistenceGuardOptions {
  /**
   * Task ID to record a canonical 1.0 score for when the guard finds an
   * existing PR.  Requires `onShortCircuit` to be set — if omitted, scoring
   * is deferred to the Phase 3 backfill.
   */
  taskId?: string;
  /**
   * Called immediately when resolution === 'already-in-review' and `taskId`
   * is provided.  Typically wired to `verifier.recordShortCircuitScore()`.
   */
  onShortCircuit?: ShortCircuitCallback;
  /**
   * Optional state store to persist a per-(repo, issue) cooldown entry when
   * the guard returns 'already-in-review'.  The dispatcher can then call
   * `store.isPRGuardCooldownActive()` to avoid re-queuing for the TTL window.
   *
   * If omitted, no cooldown is written (backward-compatible).
   */
  cooldownStore?: IPRGuardCooldownStore;
  /**
   * TTL for the cooldown entry in minutes (default 60).
   * Ignored when `cooldownStore` is not provided.
   */
  cooldownTtlMinutes?: number;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type PRExistenceResolution =
  | "already-in-review" // open PR found — skip re-dispatch
  | "cooldown-active"   // cooldown table hit — skip gh CLI call, re-dispatch blocked (issue #441)
  | "no-existing-pr"    // no open PR found — proceed with dispatch
  | "check-failed";     // guard threw — fail-open, proceed with dispatch

export interface PRExistenceCheckResult {
  /** If true, the orchestrator should NOT re-dispatch — route to PR review queue. */
  skip: boolean;
  /** How the guard resolved (for logging and DispatchRationale). */
  resolution: PRExistenceResolution;
  /** Matched PR number, or null if no match. */
  prNumber: number | null;
  /** Matched PR URL, or null if no match. */
  prUrl: string | null;
  /** Human-readable reason for the decision. */
  reason: string;
}

/** Slim view of a PR returned by `gh pr list`. */
export interface OpenPRSummary {
  number: number;
  headRefName: string;
  url: string;
  /** PR body text (may be empty string). */
  body: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether an open PR already exists for the given GitHub issue.
 *
 * Call this BEFORE dispatching any GitHub-sourced task.  If an open PR is
 * found, return the result's `skip: true` and route to the review queue.
 *
 * Pass `opts.taskId` + `opts.onShortCircuit` to record an immediate 1.0
 * quality score when the guard blocks — this eliminates the 5+ minute
 * Phase 3 backfill latency for these tasks.
 *
 * @param repo         - Repository in "owner/repo" format
 * @param issueNumber  - GitHub issue number to check
 * @param prListCache  - Optional pre-fetched list of open PRs (avoids a second
 *                       gh CLI call when the caller already has the list)
 * @param opts         - Optional task ID and scoring callback for immediate scoring
 */
export async function checkPRExistenceBeforeDispatch(
  repo: string,
  issueNumber: number,
  prListCache?: OpenPRSummary[],
  opts?: PRExistenceGuardOptions,
): Promise<PRExistenceCheckResult> {
  // ── Early cooldown check (issue #441) ────────────────────────────────────────
  // If a cooldown was written by a previous cycle's guard hit, skip the
  // expensive gh CLI call entirely and return skip=true immediately.
  // This prevents redundant tasks from being enqueued for issues already
  // under a 60-min cooldown, eliminating the "already-in-review" spam.
  if (opts?.cooldownStore?.isPRGuardCooldownActive(repo, issueNumber)) {
    const reason =
      `Issue #${issueNumber} (${repo}) is under PR guard cooldown — ` +
      `skipping gh CLI call; re-dispatch blocked until cooldown expires`;
    log.info("PR guard cooldown active — short-circuiting before gh CLI call", {
      repo,
      issueNumber,
    });

    if (opts.taskId && opts.onShortCircuit) {
      try {
        opts.onShortCircuit(opts.taskId, "no_action_needed", reason);
      } catch {
        // Scoring failure must not block the guard decision.
      }
    }

    return {
      skip: true,
      resolution: "cooldown-active",
      prNumber: null,
      prUrl: null,
      reason,
    };
  }

  try {
    const openPRs = prListCache ?? fetchOpenPRs(repo);
    const match = findMatchingPR(openPRs, issueNumber);

    if (match) {
      const reason =
        `Issue #${issueNumber} already has open PR #${match.number} ` +
        `(${match.headRefName}) — routing to review queue instead of re-dispatching`;
      log.info("Existing PR found — skipping re-dispatch", {
        repo,
        issueNumber,
        prNumber: match.number,
        prUrl: match.url,
        branch: match.headRefName,
      });

      // Immediately record a canonical short-circuit score so the task is
      // covered without waiting for Phase 3 backfill (~5 min latency).
      if (opts?.taskId && opts.onShortCircuit) {
        try {
          opts.onShortCircuit(opts.taskId, "no_action_needed", reason);
          log.info("Recorded short-circuit score for already-in-review task", {
            taskId: opts.taskId,
            prNumber: match.number,
          });
        } catch (scoreErr) {
          // Scoring failure must not block the guard decision — log and continue.
          log.warn("Failed to record short-circuit score — Phase 3 backfill will cover it", {
            taskId: opts.taskId,
            error: scoreErr instanceof Error ? scoreErr.message : String(scoreErr),
          });
        }
      }

      // Write a per-issue cooldown so the dispatcher skips re-queuing for the
      // TTL window without making another gh CLI call.
      if (opts?.cooldownStore) {
        try {
          const ttl = opts.cooldownTtlMinutes ?? 60;
          opts.cooldownStore.setPRGuardCooldown(repo, issueNumber, ttl);
          log.info("PR guard cooldown set", { repo, issueNumber, ttlMinutes: ttl });
        } catch (cooldownErr) {
          // Cooldown write failure must not block the guard decision.
          log.warn("Failed to write PR guard cooldown — dispatch may retry this cycle", {
            repo,
            issueNumber,
            error: cooldownErr instanceof Error ? cooldownErr.message : String(cooldownErr),
          });
        }
      }

      return {
        skip: true,
        resolution: "already-in-review",
        prNumber: match.number,
        prUrl: match.url,
        reason,
      };
    }

    return {
      skip: false,
      resolution: "no-existing-pr",
      prNumber: null,
      prUrl: null,
      reason: `No open PR found for issue #${issueNumber} in ${repo} — proceeding with dispatch`,
    };
  } catch (err) {
    log.error("PR existence guard failed — falling back to dispatch", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      skip: false,
      resolution: "check-failed",
      prNumber: null,
      prUrl: null,
      reason: `Guard error: ${err instanceof Error ? err.message : String(err)} — proceeding with dispatch`,
    };
  }
}

/**
 * Quick pre-filter: does this task's source_ref look like a GitHub issue task?
 *
 * Use this as a fast string-only check before calling
 * `checkPRExistenceBeforeDispatch()`, which makes a GitHub API call.
 *
 * @param sourceRef - Task source_ref (e.g. "github-issue:owner/repo#42")
 */
export function looksLikeGitHubIssueTask(sourceRef?: string | null): boolean {
  if (!sourceRef) return false;
  return sourceRef.startsWith("github-issue:");
}

/**
 * Extract the GitHub issue number from a task's source_ref.
 *
 * Supported formats:
 *   - "github-issue:owner/repo#42" → 42
 *   - "#42"                        → 42
 *
 * @returns Issue number or null if not extractable.
 */
export function extractIssueNumberFromSourceRef(
  sourceRef: string | null | undefined,
): number | null {
  if (!sourceRef) return null;

  // "github-issue:owner/repo#42"
  const ghIssueMatch = sourceRef.match(/github-issue:[^#]+#(\d+)$/);
  if (ghIssueMatch) return parseInt(ghIssueMatch[1], 10);

  // Bare "#42"
  const bareMatch = sourceRef.match(/^#(\d+)$/);
  if (bareMatch) return parseInt(bareMatch[1], 10);

  return null;
}

/**
 * Extract the repository slug from a task's source_ref.
 *
 * Supported formats:
 *   - "github-issue:owner/repo#42" → "owner/repo"
 *
 * @returns Repo slug or null if not extractable.
 */
export function extractRepoFromSourceRef(
  sourceRef: string | null | undefined,
): string | null {
  if (!sourceRef) return null;
  const match = sourceRef.match(/^github-issue:([^#]+)#\d+$/);
  return match ? match[1] : null;
}

/**
 * Format a `PRExistenceCheckResult` as a compact string suitable for storing
 * in `DispatchRationale.existing_pr_check_result`.
 *
 * Examples:
 *   "open PR #42 (issue-42-feature-x)"
 *   "none"
 *   "check-failed"
 */
export function formatPRCheckResult(result: PRExistenceCheckResult): string {
  if (result.resolution === "already-in-review" && result.prNumber !== null) {
    return `open PR #${result.prNumber}`;
  }
  if (result.resolution === "cooldown-active") {
    return "cooldown-active";
  }
  if (result.resolution === "check-failed") {
    return "check-failed";
  }
  return "none";
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Fetch all open PRs for a repo via gh CLI.
 * Raises on error so the caller (checkPRExistenceBeforeDispatch) can fail-open.
 */
export function fetchOpenPRs(repo: string): OpenPRSummary[] {
  const output = execSync(
    `gh pr list --repo ${shellEscape(repo)} --state open --json number,headRefName,url,body --limit 200`,
    { encoding: "utf-8", timeout: 20000 },
  );
  const raw: Array<{ number: number; headRefName: string; url: string; body: string }> =
    JSON.parse(output.trim());
  return raw.map((pr) => ({
    number: pr.number,
    headRefName: pr.headRefName ?? "",
    url: pr.url ?? "",
    body: pr.body ?? "",
  }));
}

/**
 * Find an open PR that matches `issueNumber` by branch name or Closes reference.
 *
 * Match criteria (either sufficient):
 *   a. `headRefName` starts with `issue-{N}-` or `issue-{N}_` (case-insensitive)
 *   b. PR body contains a GitHub close keyword followed by `#{N}`
 *      (closes|fixes|resolves #N, optionally with a space before #)
 */
export function findMatchingPR(
  openPRs: OpenPRSummary[],
  issueNumber: number,
): OpenPRSummary | null {
  // Branch-name pattern: issue-42-something or issue-42_something
  const branchPattern = new RegExp(`^issue-${issueNumber}[-_]`, "i");

  // Close-keyword pattern: "closes #42", "fixes #42", "resolves #42" (with optional space)
  const closesPattern = new RegExp(
    `(?:closes|fixes|resolves)\\s+#${issueNumber}(?:\\b|$)`,
    "i",
  );

  for (const pr of openPRs) {
    if (branchPattern.test(pr.headRefName)) {
      return pr;
    }
    if (closesPattern.test(pr.body)) {
      return pr;
    }
  }
  return null;
}

function shellEscape(s: string): string {
  if (!s) return "''";
  if (/[^a-zA-Z0-9._/-]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}
