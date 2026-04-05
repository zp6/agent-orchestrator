import { createLogger } from "../service/logger.js";
import type { StateStore, PRCreationAttempt, PRCreationTelemetry } from "../state/store.js";

export type { PRCreationAttempt, PRCreationTelemetry };

const log = createLogger("pr-creation-retry-queue");

/** Maximum number of PR creation attempts before permanently marking as failed. */
export const PR_CREATION_MAX_RETRIES = 5;

/**
 * Exponential backoff delays (in milliseconds) indexed by attempt number (0-based).
 * Attempt 0 → 1 min, 1 → 2 min, 2 → 4 min, 3 → 8 min, 4 → 16 min.
 */
export const PR_CREATION_BACKOFF_MS = [
  1 * 60 * 1000,
  2 * 60 * 1000,
  4 * 60 * 1000,
  8 * 60 * 1000,
  16 * 60 * 1000,
];

/**
 * Manages a persistent retry queue for PR creation failures.
 *
 * When the daemon's orphan-branch → PR creation step fails for a branch, it
 * calls `enqueue()` to record the failure in SQLite.  On each subsequent daemon
 * cycle `processPendingRetries()` is called, which re-attempts branches whose
 * exponential-backoff window has elapsed.  Successful attempts are marked
 * "succeeded"; branches that exhaust the retry budget (5 attempts) are marked
 * "failed" permanently.
 *
 * Telemetry (total attempts, error distribution, success rate) is available via
 * `getFailureTelemetry()` and is logged periodically by the daemon.
 */
export class PRCreationRetryQueue {
  constructor(private readonly store: StateStore) {}

  /**
   * Record a failed PR creation attempt for the given branch.
   *
   * - If the branch is not yet tracked, inserts a new pending row.
   * - If it's already tracked (and still pending), increments the attempt
   *   counter and schedules the next retry with exponential backoff.
   * - If the branch has already succeeded or permanently failed, this is a
   *   no-op so that re-appearing orphan branches don't reset their history.
   */
  enqueue(repo: string, branch: string, error: string): void {
    const existing = this.store.getPRCreationAttempt(repo, branch);

    if (existing) {
      if (existing.status !== "pending") {
        // Already resolved — don't overwrite terminal state.
        return;
      }
      const newCount = existing.attempt_count + 1;
      const backoffMs = PR_CREATION_BACKOFF_MS[Math.min(newCount - 1, PR_CREATION_BACKOFF_MS.length - 1)];
      const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      const permanentlyFailed = newCount >= PR_CREATION_MAX_RETRIES;

      this.store.updatePRCreationAttempt(repo, branch, {
        attempt_count: newCount,
        last_error: error,
        last_attempted_at: new Date().toISOString(),
        next_retry_at: permanentlyFailed ? null : nextRetryAt,
        status: permanentlyFailed ? "failed" : "pending",
      });

      if (permanentlyFailed) {
        log.error("PR creation permanently failed after max retries", {
          repo,
          branch,
          attempts: newCount,
          lastError: error,
        });
      } else {
        log.warn("PR creation failed — scheduled retry", {
          repo,
          branch,
          attempt: newCount,
          nextRetryAt,
          error,
        });
      }
    } else {
      // First failure — insert with backoff for next attempt.
      const backoffMs = PR_CREATION_BACKOFF_MS[0];
      const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
      this.store.insertPRCreationAttempt({
        repo,
        branch,
        attempt_count: 1,
        last_error: error,
        last_attempted_at: new Date().toISOString(),
        next_retry_at: nextRetryAt,
        status: "pending",
      });

      log.warn("PR creation failed — enqueued for retry", {
        repo,
        branch,
        nextRetryAt,
        error,
      });
    }
  }

  /**
   * Mark a PR creation attempt as succeeded (removes it from the retry queue).
   * Called by the daemon when a previously-failing branch has a PR created
   * successfully on a retry attempt.
   */
  markSucceeded(repo: string, branch: string): void {
    const existing = this.store.getPRCreationAttempt(repo, branch);
    if (!existing) return;

    this.store.updatePRCreationAttempt(repo, branch, {
      last_attempted_at: new Date().toISOString(),
      next_retry_at: null,
      status: "succeeded",
    });

    log.info("PR creation succeeded on retry", {
      repo,
      branch,
      totalAttempts: existing.attempt_count + 1,
    });
  }

  /**
   * Return all branches that are pending and whose `next_retry_at` has elapsed.
   * These are ready to be retried this cycle.
   */
  getDueRetries(): PRCreationAttempt[] {
    return this.store.getDuePRCreationAttempts();
  }

  /**
   * Process all pending retries that are due, invoking `attemptFn` for each.
   *
   * `attemptFn` should return `true` on success, `false` on failure.
   * On success the entry is marked succeeded.
   * On failure `enqueue()` is called with the error, incrementing the counter.
   *
   * @returns Number of branches retried this cycle.
   */
  async processPendingRetries(
    attemptFn: (repo: string, branch: string) => Promise<boolean>,
    getError: (repo: string, branch: string) => string = () => "unknown error",
  ): Promise<number> {
    const due = this.getDueRetries();
    if (due.length === 0) return 0;

    log.info("Processing pending PR creation retries", { count: due.length });
    let retried = 0;

    for (const entry of due) {
      try {
        const success = await attemptFn(entry.repo, entry.branch);
        if (success) {
          this.markSucceeded(entry.repo, entry.branch);
        } else {
          this.enqueue(entry.repo, entry.branch, getError(entry.repo, entry.branch));
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.enqueue(entry.repo, entry.branch, errMsg);
      }
      retried++;
    }

    return retried;
  }

  /**
   * Aggregate telemetry across all tracked PR creation attempts.
   */
  getFailureTelemetry(): PRCreationTelemetry {
    return this.store.getPRCreationTelemetry();
  }
}
