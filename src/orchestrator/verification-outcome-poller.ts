/**
 * Verification Outcome Poller
 *
 * Implements Phase 1 of the calibration feedback loop from
 * findings/verification-calibration.md (rapartlu/research-agent).
 *
 * Polls GitHub PR events for all pending verification_outcome_logs entries
 * (rows where pr_outcome IS NULL and pr_url IS NOT NULL) and updates each
 * row once the PR reaches a terminal state: merged, closed, or redispatched.
 *
 * Called by the daemon on each cycle; safe to call repeatedly (idempotent
 * for already-resolved rows due to the INSERT OR IGNORE + conditional UPDATE).
 *
 * Terminal state mapping:
 *   merged + 0 review comments  → 'merged_clean'   (merge_weight = 1.0)
 *   merged + N review comments  → 'merged_with_feedback' (merge_weight = 0.5)
 *   closed + not merged         → 'rejected'        (merge_weight = 0.0)
 *   task re-dispatched after PR → 'redispatched'    (merge_weight = 0.0)
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import type { StateStore } from "../state/store.js";

const log = createLogger("verification-outcome-poller");

interface PRStatus {
  state: "OPEN" | "MERGED" | "CLOSED";
  merged: boolean;
  reviewDecision: string | null;
  comments: number;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

function fetchPRStatus(prUrl: string): PRStatus | null {
  // pr_url is of the form https://github.com/owner/repo/pull/123
  const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!match) {
    log.warn("Cannot parse pr_url — skipping", { prUrl });
    return null;
  }
  const [, repo, prNumber] = match;

  try {
    const raw = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json state,merged,reviewDecision,comments,createdAt,mergedAt,closedAt`,
      { stdio: ["pipe", "pipe", "pipe"] },
    ).toString();
    const data = JSON.parse(raw) as {
      state: string;
      merged: boolean;
      reviewDecision: string | null;
      comments: Array<{ body: string }>;
      createdAt: string;
      mergedAt: string | null;
      closedAt: string | null;
    };
    return {
      state: data.state as PRStatus["state"],
      merged: data.merged,
      reviewDecision: data.reviewDecision,
      comments: data.comments.length,
      createdAt: data.createdAt,
      mergedAt: data.mergedAt,
      closedAt: data.closedAt,
    };
  } catch (err) {
    log.warn("Failed to fetch PR status", { prUrl, err });
    return null;
  }
}

function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Resolve the pr_outcome for a single pending entry.
 * Returns true when the entry was updated, false when the PR is still open.
 */
function resolveOutcome(
  store: StateStore,
  entry: { task_id: string; pr_url: string; verifier_agent: string; verified_at: string },
): boolean {
  const status = fetchPRStatus(entry.pr_url);
  if (!status) return false;

  // PR still open — nothing to record yet.
  if (status.state === "OPEN") return false;

  const resolvedAt = status.mergedAt ?? status.closedAt ?? new Date().toISOString();
  const daysToResolution = daysBetween(entry.verified_at, resolvedAt);

  let pr_outcome: "merged_clean" | "merged_with_feedback" | "rejected" | "redispatched";
  if (status.merged) {
    pr_outcome = status.comments > 0 ? "merged_with_feedback" : "merged_clean";
  } else {
    // Closed without merge — check if a successor task was dispatched
    // (redispatch detection: a new task with the same issue ref opened after close).
    // For now we conservatively record as 'rejected'; the daemon can upgrade to
    // 'redispatched' when it detects a re-dispatch event for the same issue.
    pr_outcome = "rejected";
  }

  store.updateVerificationOutcome({
    task_id: entry.task_id,
    pr_outcome,
    review_comment_count: status.comments,
    days_to_resolution: daysToResolution,
    resolved_at: resolvedAt,
  });

  log.info("Verification outcome resolved", {
    task_id: entry.task_id,
    pr_outcome,
    comments: status.comments,
    daysToResolution,
  });

  return true;
}

/**
 * Poll all pending verification outcomes in the store and resolve any that
 * have reached a terminal GitHub PR state.
 *
 * Returns the count of newly resolved entries.
 */
export async function pollVerificationOutcomes(store: StateStore): Promise<number> {
  const pending = store.getPendingVerificationOutcomes();
  if (pending.length === 0) return 0;

  log.info("Polling verification outcomes", { count: pending.length });

  let resolved = 0;
  for (const entry of pending) {
    if (resolveOutcome(store, entry)) {
      resolved++;
    }
  }

  if (resolved > 0) {
    log.info("Verification outcomes resolved this cycle", { resolved, total: pending.length });
  }

  return resolved;
}

/**
 * Mark a verification outcome as 'redispatched' when the orchestrator
 * re-dispatches the same issue after a PR was closed without merge.
 * Called from the dispatcher when it creates a new task for an issue
 * that already has a closed PR.
 */
export function markVerificationOutcomeRedispatched(
  store: StateStore,
  taskId: string,
): void {
  store.updateVerificationOutcome({
    task_id: taskId,
    pr_outcome: "redispatched",
    review_comment_count: 0,
    days_to_resolution: 0,
    resolved_at: new Date().toISOString(),
  });
}
