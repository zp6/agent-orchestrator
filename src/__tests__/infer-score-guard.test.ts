/**
 * Regression tests for issue #203 — enforce score threshold on the
 * inferMissingScore / repairNullScoresForApprovedTasks paths.
 *
 * Before the fix these two paths hard-coded `approved: true` and bypassed the
 * hard-block (< 0.50) and sub-threshold (< 0.60) rejection guards.  A task
 * pre-approved in state.db with a null quality_score could therefore re-emerge
 * from verify() as "approved" even when the LLM inference returned 0.15.
 *
 * The fix applies applyHardBlockGuard + applySubThresholdRejectionGuard to the
 * inferred result before writing it back to state.db or returning it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// LLM client must be mocked before the Verifier module is imported (issue #203).
vi.mock("../client/llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({})),
}));

import { Verifier } from "../reviewer/verifier.js";
import { StateStore } from "../state/store.js";

// ── helpers ──────────────────────────────────────────────────────────────────

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => unknown;
    };
  };
};

/**
 * Insert a task that is already marked "approved" in state.db with a
 * null quality_score — the exact trigger condition for inferMissingScore.
 */
function insertPreApprovedNullScoreTask(
  store: StateStore,
  taskId: string,
  result = "Some agent output",
): void {
  const raw = store as unknown as RawDB;
  const now = "2026-04-15T10:00:00.000Z";

  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, description, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, ?, 'done', 'approved', NULL, ?, 'implementation', ?, ?, ?)`,
    )
    .run(taskId, `Task ${taskId}`, "A test task", "agent-a", result, now, now);
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("inferMissingScore hard-block guard (issue #203)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("score 0.15 returned by LLM inference must not result in approved=true", async () => {
    const taskId = "01HZINFER0000000000000000001";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    // Simulate LLM inference returning a very low score
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.15,
      notes: "Inferred score — task was pre-approved",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const result = await verifier.verify(taskId);

    // Guard must have fired — approved: false
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");

    // state.db must reflect the rejection
    const task = store.getTask(taskId);
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.15);

    // Audit record must NOT be recorded as a first_pass approval
    const record = store.getLatestVerificationRecord(taskId);
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("hard_block_sub50");
  });

  it("score 0.30 (below 0.50) returned by inference must not auto-approve", async () => {
    const taskId = "01HZINFER0000000000000000002";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.30,
      notes: "Inferred fallback",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const result = await verifier.verify(taskId);

    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
    expect(store.getTask(taskId)?.verification_status).toBe("rejected");
  });

  it("score 0.55 (sub-60) returned by inference must not auto-approve", async () => {
    const taskId = "01HZINFER0000000000000000003";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.55,
      notes: "Inferred fallback",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const result = await verifier.verify(taskId);

    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
    expect(store.getTask(taskId)?.verification_status).toBe("rejected");
  });

  it("score 0.85 from heuristic inference passes normally", async () => {
    const taskId = "01HZINFER0000000000000000004";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.85,
      notes: "Heuristic fallback — research task",
      approvalRationale: "inferred_fallback_research_heuristic",
    });

    const result = await verifier.verify(taskId);

    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(store.getTask(taskId)?.verification_status).toBe("approved");
  });

  it("score exactly at HARD_BLOCK_THRESHOLD boundary (0.50) is not blocked", async () => {
    const taskId = "01HZINFER0000000000000000005";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.50,
      notes: "Boundary score",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const result = await verifier.verify(taskId);

    // 0.50 is not hard-blocked (threshold is exclusive: < 0.50)
    // but it IS sub-threshold-rejected (< 0.60)
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });
});

describe("repairNullScoresForApprovedTasks hard-block guard (issue #203)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("repair loop must not record sub-0.50 inferred score as approved", async () => {
    const taskId = "01HZREPAIR000000000000000001";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.15,
      notes: "Inferred low score",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const repaired = await verifier.repairNullScoresForApprovedTasks();

    expect(repaired).toBe(1);

    const task = store.getTask(taskId);
    // The task's verification_status must be corrected — issue #266 changed the
    // store-layer downgrade from 'rejected' to 'needs_revision' so the task
    // stays in the work queue rather than being permanently closed.
    expect(task?.verification_status).toBe("needs_revision");
    expect(task?.quality_score).toBe(0.15);

    const record = store.getLatestVerificationRecord(taskId);
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("hard_block_sub50");
  });

  it("repair loop preserves approval for high inferred scores", async () => {
    const taskId = "01HZREPAIR000000000000000002";
    insertPreApprovedNullScoreTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.82,
      notes: "Heuristic fallback — housekeeping task",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });

    const repaired = await verifier.repairNullScoresForApprovedTasks();

    expect(repaired).toBe(1);

    const task = store.getTask(taskId);
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(0.82);

    const record = store.getLatestVerificationRecord(taskId);
    expect(record?.first_pass).toBe(1);
    expect(record?.blocked_reason).toBeNull();
  });
});
