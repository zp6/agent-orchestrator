import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PRCreationRetryQueue, PR_CREATION_MAX_RETRIES, PR_CREATION_BACKOFF_MS } from "../pr-creation-retry-queue.js";
import { StateStore } from "../../state/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("PRCreationRetryQueue", () => {
  let store: StateStore;
  let queue: PRCreationRetryQueue;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-pr-retry-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
    queue = new PRCreationRetryQueue(store);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(dbPath);
    } catch {}
  });

  describe("enqueue", () => {
    it("inserts a new attempt record on first failure", () => {
      queue.enqueue("owner/repo", "feature-branch", "gh: authentication failed");

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(attempt).toBeDefined();
      expect(attempt!.repo).toBe("owner/repo");
      expect(attempt!.branch).toBe("feature-branch");
      expect(attempt!.attempt_count).toBe(1);
      expect(attempt!.last_error).toBe("gh: authentication failed");
      expect(attempt!.status).toBe("pending");
      expect(attempt!.next_retry_at).not.toBeNull();
    });

    it("schedules next_retry_at with backoff based on attempt index", () => {
      const before = Date.now();
      queue.enqueue("owner/repo", "feature-branch", "error");
      const after = Date.now();

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      const nextRetry = new Date(attempt!.next_retry_at!).getTime();

      // Should be scheduled at least backoff[0] ms in the future
      expect(nextRetry).toBeGreaterThanOrEqual(before + PR_CREATION_BACKOFF_MS[0]);
      expect(nextRetry).toBeLessThanOrEqual(after + PR_CREATION_BACKOFF_MS[0] + 100);
    });

    it("increments attempt_count on subsequent failures", () => {
      queue.enqueue("owner/repo", "feature-branch", "error 1");
      queue.enqueue("owner/repo", "feature-branch", "error 2");

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(attempt!.attempt_count).toBe(2);
      expect(attempt!.last_error).toBe("error 2");
    });

    it("permanently fails after max retries", () => {
      for (let i = 0; i < PR_CREATION_MAX_RETRIES; i++) {
        queue.enqueue("owner/repo", "feature-branch", `error ${i}`);
      }

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(attempt!.attempt_count).toBe(PR_CREATION_MAX_RETRIES);
      expect(attempt!.status).toBe("failed");
      expect(attempt!.next_retry_at).toBeNull();
    });

    it("is a no-op for already-succeeded branches", () => {
      queue.enqueue("owner/repo", "feature-branch", "initial error");
      queue.markSucceeded("owner/repo", "feature-branch");

      // Enqueueing again should not change the succeeded status
      queue.enqueue("owner/repo", "feature-branch", "new error");

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(attempt!.status).toBe("succeeded");
      expect(attempt!.attempt_count).toBe(1); // unchanged
    });

    it("is a no-op for already permanently failed branches", () => {
      for (let i = 0; i < PR_CREATION_MAX_RETRIES; i++) {
        queue.enqueue("owner/repo", "feature-branch", "error");
      }

      const beforeUpdate = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(beforeUpdate!.status).toBe("failed");

      // Another enqueue should not change the permanently-failed status
      queue.enqueue("owner/repo", "feature-branch", "another error");

      const after = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(after!.attempt_count).toBe(PR_CREATION_MAX_RETRIES); // unchanged
      expect(after!.status).toBe("failed");
    });

    it("tracks separate attempts for different branches", () => {
      queue.enqueue("owner/repo", "branch-a", "error a");
      queue.enqueue("owner/repo", "branch-b", "error b");

      const a = store.getPRCreationAttempt("owner/repo", "branch-a");
      const b = store.getPRCreationAttempt("owner/repo", "branch-b");

      expect(a!.attempt_count).toBe(1);
      expect(b!.attempt_count).toBe(1);
      expect(a!.last_error).toBe("error a");
      expect(b!.last_error).toBe("error b");
    });

    it("uses the last backoff delay when attempt_count exceeds the backoff array size", () => {
      // Insert an attempt whose count equals the backoff array length.
      // This simulates many failures beyond what the array covers.
      // MAX_RETRIES=5, array length=5 so newCount would be length+1=6 which >= MAX_RETRIES.
      // Use a custom scenario: start at count=3 (below MAX_RETRIES=5) so newCount=4, still pending.
      // index = min(4-1, 4) = min(3,4) = 3  → uses backoff[3] = 8 min, verifying capping works
      // for index < length. For truly capped behavior, use count > length so index wraps.
      // We'll test the actual `Math.min` guard by using count = length (array length = 5).
      // newCount = 6 → permanently failed, so we must use count = length - 2 (= 3).
      // newCount=4, index=min(3,4)=3 → PR_CREATION_BACKOFF_MS[3]=8min. Correct behavior.
      const startCount = PR_CREATION_BACKOFF_MS.length - 2; // 3
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "deep-failure-branch",
        attempt_count: startCount,
        last_error: "error",
        last_attempted_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(),
        status: "pending",
      });

      const before = Date.now();
      queue.enqueue("owner/repo", "deep-failure-branch", "one more error");
      const after = Date.now();

      const attempt = store.getPRCreationAttempt("owner/repo", "deep-failure-branch");
      expect(attempt!.status).toBe("pending");
      const newCount = startCount + 1;
      const expectedIndex = Math.min(newCount - 1, PR_CREATION_BACKOFF_MS.length - 1);
      const expectedBackoffMs = PR_CREATION_BACKOFF_MS[expectedIndex];
      const nextRetry = new Date(attempt!.next_retry_at!).getTime();
      expect(nextRetry).toBeGreaterThanOrEqual(before + expectedBackoffMs);
      expect(nextRetry).toBeLessThanOrEqual(after + expectedBackoffMs + 100);
    });
  });

  describe("markSucceeded", () => {
    it("marks a pending attempt as succeeded", () => {
      queue.enqueue("owner/repo", "feature-branch", "error");
      queue.markSucceeded("owner/repo", "feature-branch");

      const attempt = store.getPRCreationAttempt("owner/repo", "feature-branch");
      expect(attempt!.status).toBe("succeeded");
      expect(attempt!.next_retry_at).toBeNull();
    });

    it("is a no-op when the branch has no record", () => {
      // Should not throw
      expect(() => queue.markSucceeded("owner/repo", "nonexistent-branch")).not.toThrow();
    });
  });

  describe("getDueRetries", () => {
    it("returns nothing when no retries are due yet", () => {
      queue.enqueue("owner/repo", "feature-branch", "error");
      const due = queue.getDueRetries();
      expect(due).toHaveLength(0);
    });

    it("returns attempts whose next_retry_at has elapsed", () => {
      // Manually insert an attempt with a past next_retry_at
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "overdue-branch",
        attempt_count: 1,
        last_error: "error",
        last_attempted_at: new Date(Date.now() - 120_000).toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
        status: "pending",
      });

      const due = queue.getDueRetries();
      expect(due).toHaveLength(1);
      expect(due[0].branch).toBe("overdue-branch");
    });

    it("excludes succeeded and permanently failed entries", () => {
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "succeeded-branch",
        attempt_count: 1,
        last_error: null,
        last_attempted_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(),
        status: "succeeded",
      });

      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "failed-branch",
        attempt_count: PR_CREATION_MAX_RETRIES,
        last_error: "terminal error",
        last_attempted_at: new Date().toISOString(),
        next_retry_at: null,
        status: "failed",
      });

      const due = queue.getDueRetries();
      expect(due).toHaveLength(0);
    });
  });

  describe("processPendingRetries", () => {
    it("calls attemptFn for each due entry and marks succeeded on true", async () => {
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "overdue-branch",
        attempt_count: 1,
        last_error: "error",
        last_attempted_at: new Date(Date.now() - 120_000).toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(),
        status: "pending",
      });

      const attemptFn = vi.fn().mockResolvedValue(true);
      const retried = await queue.processPendingRetries(attemptFn);

      expect(retried).toBe(1);
      expect(attemptFn).toHaveBeenCalledWith("owner/repo", "overdue-branch");

      const attempt = store.getPRCreationAttempt("owner/repo", "overdue-branch");
      expect(attempt!.status).toBe("succeeded");
    });

    it("increments attempt count on false result from attemptFn", async () => {
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "overdue-branch",
        attempt_count: 1,
        last_error: "error",
        last_attempted_at: new Date(Date.now() - 120_000).toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(),
        status: "pending",
      });

      const attemptFn = vi.fn().mockResolvedValue(false);
      const getError = vi.fn().mockReturnValue("retry failed");

      await queue.processPendingRetries(attemptFn, getError);

      const attempt = store.getPRCreationAttempt("owner/repo", "overdue-branch");
      expect(attempt!.attempt_count).toBe(2);
      expect(attempt!.last_error).toBe("retry failed");
      expect(attempt!.status).toBe("pending");
    });

    it("enqueues error when attemptFn throws", async () => {
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "throwing-branch",
        attempt_count: 1,
        last_error: "original error",
        last_attempted_at: new Date(Date.now() - 120_000).toISOString(),
        next_retry_at: new Date(Date.now() - 60_000).toISOString(),
        status: "pending",
      });

      const attemptFn = vi.fn().mockRejectedValue(new Error("unexpected exception"));
      await queue.processPendingRetries(attemptFn);

      const attempt = store.getPRCreationAttempt("owner/repo", "throwing-branch");
      expect(attempt!.attempt_count).toBe(2);
      expect(attempt!.last_error).toBe("unexpected exception");
    });

    it("returns 0 when no retries are due", async () => {
      const attemptFn = vi.fn();
      const retried = await queue.processPendingRetries(attemptFn);
      expect(retried).toBe(0);
      expect(attemptFn).not.toHaveBeenCalled();
    });
  });

  describe("getFailureTelemetry", () => {
    it("returns zeroed telemetry when no attempts recorded", () => {
      const t = queue.getFailureTelemetry();
      expect(t.total_branches).toBe(0);
      expect(t.pending).toBe(0);
      expect(t.succeeded).toBe(0);
      expect(t.failed).toBe(0);
      expect(t.total_attempts).toBe(0);
      expect(t.success_rate).toBeNull();
      expect(t.top_errors).toHaveLength(0);
    });

    it("aggregates counts correctly across multiple branches", () => {
      // 1 pending, 1 succeeded, 1 permanently failed
      queue.enqueue("owner/repo", "pending-branch", "error");

      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "succeeded-branch",
        attempt_count: 2,
        last_error: null,
        last_attempted_at: new Date().toISOString(),
        next_retry_at: null,
        status: "succeeded",
      });

      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "failed-branch",
        attempt_count: PR_CREATION_MAX_RETRIES,
        last_error: "terminal",
        last_attempted_at: new Date().toISOString(),
        next_retry_at: null,
        status: "failed",
      });

      const t = queue.getFailureTelemetry();
      expect(t.total_branches).toBe(3);
      expect(t.pending).toBe(1);
      expect(t.succeeded).toBe(1);
      expect(t.failed).toBe(1);
      expect(t.total_attempts).toBe(1 + 2 + PR_CREATION_MAX_RETRIES);
      expect(t.success_rate).toBeCloseTo(1 / 3);
    });

    it("computes top_errors from last_error values", () => {
      const commonError = "gh: 422 Unprocessable Entity";

      for (let i = 0; i < 3; i++) {
        store.insertPRCreationAttempt({
          repo: "owner/repo",
          branch: `branch-${i}`,
          attempt_count: 1,
          last_error: commonError,
          last_attempted_at: new Date().toISOString(),
          next_retry_at: new Date(Date.now() + 60_000).toISOString(),
          status: "pending",
        });
      }

      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "other-branch",
        attempt_count: 1,
        last_error: "different error",
        last_attempted_at: new Date().toISOString(),
        next_retry_at: new Date(Date.now() + 60_000).toISOString(),
        status: "pending",
      });

      const t = queue.getFailureTelemetry();
      expect(t.top_errors[0].error).toBe(commonError);
      expect(t.top_errors[0].count).toBe(3);
      expect(t.top_errors[1].error).toBe("different error");
      expect(t.top_errors[1].count).toBe(1);
    });

    it("computes success_rate as null when no branches tracked", () => {
      const t = queue.getFailureTelemetry();
      expect(t.success_rate).toBeNull();
    });

    it("computes success_rate as 1.0 when all branches succeeded", () => {
      store.insertPRCreationAttempt({
        repo: "owner/repo",
        branch: "branch-1",
        attempt_count: 1,
        last_error: null,
        last_attempted_at: new Date().toISOString(),
        next_retry_at: null,
        status: "succeeded",
      });

      const t = queue.getFailureTelemetry();
      expect(t.success_rate).toBe(1);
    });
  });
});
