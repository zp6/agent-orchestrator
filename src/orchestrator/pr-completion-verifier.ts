/**
 * Post-completion PR verification — issue #1306.
 *
 * Agents that hit scope-contract violations, auth failures, or other silent
 * errors may report "task done" (tests pass, build succeeds) without ever
 * pushing a branch or opening a PR.  Three real failures occurred in 24 hours:
 *
 *   1. Linear adapter (first attempt)  — no PR, operator wrote it manually
 *   2. Linear adapter (second attempt) — no PR despite explicit push instructions
 *   3. Revenue rails                   — no PR, operator wrote it manually (#1296)
 *
 * This module provides `verifyPRCreated()` which is called inside
 * `Dispatcher.dispatch()` right after `store.updateTask(id, { status: "done" })`.
 * If no PR is found for the task's source issue, the task is re-marked as
 * "failed" and a clear error is recorded so the next dispatch cycle retries
 * with a fresh agent context rather than silently treating zero output as
 * success.
 *
 * ## When verification fires
 *
 * - Task type must be `"implementation"` (research tasks don't create PRs)
 * - Task must have a GitHub-style `source_ref` (e.g. `owner/repo#42`)
 * - Verification is **non-blocking**: errors in the GitHub lookup are logged
 *   and the original "done" status is preserved so a transient API outage
 *   does not falsely fail healthy tasks
 *
 * ## What counts as "PR found"
 *
 * Delegates to `findExistingPRsForIssue()` which checks:
 *   1. Open PRs via GitHub search index (body `Closes #N`)
 *   2. Open PRs by branch-name convention (`issue-N-*`)
 *   3. Recently merged PRs (last 30 closed)
 *
 * A draft PR counts as "found" — the agent created the artifact, even if the
 * review cycle isn't complete yet.
 */

import type { Task } from "../state/types.js";
import type { StateStore } from "../state/store.js";
import { findExistingPRsForIssue } from "../triggers/github.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("pr-completion-verifier");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PRVerificationResult {
  /** Whether verification was skipped because it does not apply to this task. */
  skipped: boolean;
  /** Whether a PR was found for the issue. Only meaningful when `skipped=false`. */
  prFound: boolean;
  /** PR number if found. */
  prNumber?: number;
  /** PR URL if found. */
  prUrl?: string;
  /** Human-readable reason for skipping (when `skipped=true`). */
  skipReason?: string;
  /** Error message set when the GitHub lookup itself failed (non-fatal). */
  lookupError?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse a GitHub `source_ref` such as `"owner/repo#42"` into its component
 * parts.  Returns `null` for non-GitHub refs (Linear, manual, etc.).
 *
 * Exported for unit testing.
 */
export function parseGitHubIssueRef(
  sourceRef: string | null | undefined,
): { repo: string; issueNumber: number } | null {
  if (!sourceRef) return null;

  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return null;

  const repo = sourceRef.slice(0, hashIdx);
  // Must look like "owner/repo" — at least one slash
  if (!repo.includes("/")) return null;

  const issueNumberStr = sourceRef.slice(hashIdx + 1);
  const issueNumber = parseInt(issueNumberStr, 10);
  if (Number.isNaN(issueNumber) || issueNumber <= 0) return null;

  return { repo, issueNumber };
}

/**
 * Check whether the agent's response text contains signals that a PR was
 * created (URL fragment, "gh pr create" output, branch push confirmation).
 * Used as a fast path before hitting the GitHub API.
 *
 * This is a heuristic — false negatives are acceptable because the API check
 * is the authoritative gate.  False positives would be a bug; keep patterns
 * conservative.
 *
 * Exported for unit testing.
 */
export function responseContainsPRSignal(responseText: string): boolean {
  // Common patterns in `gh pr create` output and agent summaries:
  //   https://github.com/owner/repo/pull/123
  //   PR #123 created
  //   pull request #123
  //   opened PR
  const patterns = [
    /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i,
    /\bPR\s+#\d+\s+(created|opened|submitted)/i,
    /\b(opened|created|submitted)\s+(a\s+)?PR\b/i,
    /\bpull\s+request\s+#\d+/i,
    /\bgh\s+pr\s+create\b/i,
  ];
  return patterns.some((re) => re.test(responseText));
}

// ── Main verification function ────────────────────────────────────────────────

/**
 * Verify that a PR was created for the GitHub issue linked to `task`.
 *
 * Call this *after* marking the task `"done"` in the store.  When no PR is
 * found the task is re-marked `"failed"` with a descriptive error so the next
 * dispatch cycle retries rather than treating zero-output as success.
 *
 * The function is synchronous because `findExistingPRsForIssue` uses
 * `execSync` internally — no await needed.
 *
 * @param task          The just-completed task.
 * @param store         The shared state store.
 * @param responseText  The agent's full response (optional fast-path hint).
 */
export function verifyPRCreated(
  task: Task,
  store: StateStore,
  responseText?: string,
): PRVerificationResult {
  // ── Skip conditions ───────────────────────────────────────────────────────

  if (task.task_type !== "implementation") {
    return {
      skipped: true,
      prFound: false,
      skipReason: `task_type is "${task.task_type}" — only implementation tasks create PRs`,
    };
  }

  const ref = parseGitHubIssueRef(task.source_ref);
  if (!ref) {
    return {
      skipped: true,
      prFound: false,
      skipReason: `source_ref "${task.source_ref ?? "(none)"}" is not a GitHub issue ref`,
    };
  }

  // ── Fast path: response text already confirms PR creation ─────────────────

  if (responseText && responseContainsPRSignal(responseText)) {
    log.info("PR verification fast-path: response contains PR signal", {
      taskId: task.id,
      repo: ref.repo,
      issueNumber: ref.issueNumber,
    });
    return { skipped: false, prFound: true };
  }

  // ── GitHub API check ──────────────────────────────────────────────────────

  let prs;
  try {
    prs = findExistingPRsForIssue(ref.repo, ref.issueNumber);
  } catch (err) {
    // Non-fatal: preserve the "done" status and log the error so it's visible
    // in the ops feed without failing the task on a transient API hiccup.
    const lookupError = err instanceof Error ? err.message : String(err);
    log.warn("PR verification: GitHub lookup failed (non-fatal, preserving done status)", {
      taskId: task.id,
      repo: ref.repo,
      issueNumber: ref.issueNumber,
      error: lookupError,
    });
    return { skipped: false, prFound: false, lookupError };
  }

  if (prs.length > 0) {
    const pr = prs[0];
    log.info("PR verification passed", {
      taskId: task.id,
      repo: ref.repo,
      issueNumber: ref.issueNumber,
      prNumber: pr.number,
      prUrl: pr.url,
      detectionStrategy: pr.detectionStrategy,
    });
    return { skipped: false, prFound: true, prNumber: pr.number, prUrl: pr.url };
  }

  // ── No PR found — mark task failed ───────────────────────────────────────

  const errorMsg =
    `[pr-completion-verifier] Implementation task completed but NO PR was created ` +
    `for ${ref.repo}#${ref.issueNumber}. ` +
    `Agent "${task.agent_name ?? "unknown"}" reported task done without pushing a branch or opening a PR. ` +
    `Possible causes: scope-contract violation aborted PR creation silently (#1252), ` +
    `gh auth issue at push time, or agent stopped after tests without reaching the git-push step. ` +
    `Task re-marked failed so the next dispatch cycle retries with a fresh context.`;

  log.warn("PR verification FAILED — no PR found after implementation task completed", {
    taskId: task.id,
    repo: ref.repo,
    issueNumber: ref.issueNumber,
    agentName: task.agent_name,
    sourceRef: task.source_ref,
  });

  store.updateTask(task.id, {
    status: "failed",
    result: errorMsg,
  });

  return { skipped: false, prFound: false };
}
