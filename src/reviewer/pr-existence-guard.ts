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

const log = createLogger("pr-existence-guard");

// ── Types ─────────────────────────────────────────────────────────────────────

export type PRExistenceResolution =
  | "already-in-review" // open PR found — skip re-dispatch
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
 * @param repo         - Repository in "owner/repo" format
 * @param issueNumber  - GitHub issue number to check
 * @param prListCache  - Optional pre-fetched list of open PRs (avoids a second
 *                       gh CLI call when the caller already has the list)
 */
export async function checkPRExistenceBeforeDispatch(
  repo: string,
  issueNumber: number,
  prListCache?: OpenPRSummary[],
): Promise<PRExistenceCheckResult> {
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
