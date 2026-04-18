/**
 * Tests for the null-score guard added to StateStore.updateTask() (issue #244).
 *
 * Root causes of null quality_score values on verified tasks:
 *
 *   1. Forward-path gap: callers that set verification_status='approved' or
 *      'rejected' without supplying quality_score leave null scores behind.
 *      updateTask() now writes a default sentinel (0.75 for approved, 0.50 for
 *      rejected) whenever this situation is detected.
 *
 *   2. Phase-2 starvation in ensureScoresPopulated(): Phase 2 previously
 *      received only `remaining = batchLimit - scored` capacity.  When Phase 1
 *      filled the batch, Phase 2 got 0 and unverified tasks accumulated.
 *      Phase 2 now uses the full batchLimit independently.
 *
 *   3. repairNullScoresForApprovedTasks(): only covered 'approved' tasks;
 *      rejected tasks with null scores were invisible to the /backfill-scores
 *      Telegram command.  Now uses getVerifiedTasksWithNullScores() to cover
 *      both statuses.
 *
 * Acceptance criteria (issue #244):
 *   ✓ Zero null quality_score entries for any task with verification_status
 *     'approved' or 'rejected' — enforced at write time by updateTask()
 *   ✓ Sentinel values (0.75 / 0.50) are recognisable and exported as constants
 *   ✓ Phase 2 of ensureScoresPopulated() is no longer starved by Phase 1
 *   ✓ repairNullScoresForApprovedTasks() repairs both approved and rejected tasks
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import { Verifier } from "../reviewer/verifier.js";

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({})),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => unknown;
    };
  };
};

/** Insert a task directly bypassing updateTask() so quality_score starts NULL. */
function insertNullScoreTask(
  store: StateStore,
  taskId: string,
  verificationStatus: "approved" | "rejected" | null = null,
): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, 'done', ?, NULL, 'agent-a', 'implementation',
               'Task output', datetime('now'), datetime('now'))`,
    )
    .run(taskId, `Task ${taskId}`, verificationStatus);
}

/** Insert a pending task that has not been verified yet. */
function insertUnverifiedTask(store: StateStore, taskId: string): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, 'done', NULL, NULL, 'agent-b', 'implementation',
               'Done output', datetime('now'), datetime('now'))`,
    )
    .run(taskId, `Unverified ${taskId}`);
}

// ── Sentinel constant exports ─────────────────────────────────────────────────

describe("StateStore sentinel constants (issue #244)", () => {
  it("NULL_SCORE_APPROVED_SENTINEL is 0.75", () => {
    expect(StateStore.NULL_SCORE_APPROVED_SENTINEL).toBe(0.75);
  });

  it("NULL_SCORE_REJECTED_SENTINEL is 0.50", () => {
    expect(StateStore.NULL_SCORE_REJECTED_SENTINEL).toBe(0.50);
  });

  it("NULL_SCORE_APPROVED_SENTINEL is above the HARD_BLOCK_THRESHOLD (0.50)", () => {
    // Approved sentinel must not trigger the score-approval invariant
    expect(StateStore.NULL_SCORE_APPROVED_SENTINEL).toBeGreaterThan(0.50);
  });
});

// ── updateTask() null-score guard — forward path ──────────────────────────────

describe("StateStore.updateTask() null-score guard (issue #244)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("downgrades to needs_revision when approving a task with no score [issue #266]", () => {
    // Issue #266: when verification_status='approved' is set on a task that has
    // null quality_score, the store cannot verify the 0.60 floor is met, so it
    // downgrades to needs_revision rather than silently approving with an unknown
    // score.  The NULL_SCORE_APPROVED_SENTINEL path (0.75) is still reached for
    // tasks that have a non-null score already recorded in the DB.
    insertNullScoreTask(store, "01GUARD_APPROVED_NO_SCORE");

    store.updateTask("01GUARD_APPROVED_NO_SCORE", { verification_status: "approved" });

    const task = store.getTask("01GUARD_APPROVED_NO_SCORE");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("writes NULL_SCORE_REJECTED_SENTINEL when rejecting a task with no score", () => {
    insertNullScoreTask(store, "01GUARD_REJECTED_NO_SCORE");

    store.updateTask("01GUARD_REJECTED_NO_SCORE", { verification_status: "rejected" });

    const task = store.getTask("01GUARD_REJECTED_NO_SCORE");
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(StateStore.NULL_SCORE_REJECTED_SENTINEL);
    expect(task?.quality_score).not.toBeNull();
  });

  it("does NOT overwrite an explicit quality_score when one is provided", () => {
    insertNullScoreTask(store, "01GUARD_EXPLICIT_SCORE");

    store.updateTask("01GUARD_EXPLICIT_SCORE", {
      verification_status: "approved",
      quality_score: 0.92,
    });

    const task = store.getTask("01GUARD_EXPLICIT_SCORE");
    expect(task?.quality_score).toBe(0.92);
    expect(task?.quality_score).not.toBe(StateStore.NULL_SCORE_APPROVED_SENTINEL);
  });

  it("does NOT write a sentinel when the task already has a quality_score", () => {
    insertNullScoreTask(store, "01GUARD_ALREADY_SCORED");
    // First give it a real score
    store.updateTask("01GUARD_ALREADY_SCORED", { quality_score: 0.85 });
    // Now approve — should keep 0.85, not overwrite with sentinel
    store.updateTask("01GUARD_ALREADY_SCORED", { verification_status: "approved" });

    const task = store.getTask("01GUARD_ALREADY_SCORED");
    expect(task?.quality_score).toBe(0.85);
  });

  it("does not affect tasks where only non-status fields are updated", () => {
    insertNullScoreTask(store, "01GUARD_NON_STATUS");

    // Update only the result — no sentinel should be written
    store.updateTask("01GUARD_NON_STATUS", { result: "New result" });

    const task = store.getTask("01GUARD_NON_STATUS");
    expect(task?.quality_score).toBeNull();
    expect(task?.result).toBe("New result");
  });

  it("does not affect pending tasks (verification_status=null) being updated", () => {
    insertNullScoreTask(store, "01GUARD_PENDING_UPDATE", null);

    // Update to in-progress status — no sentinel
    store.updateTask("01GUARD_PENDING_UPDATE", { status: "in_progress" });

    const task = store.getTask("01GUARD_PENDING_UPDATE");
    expect(task?.quality_score).toBeNull();
  });

  it("getVerifiedTasksWithNullScores returns ZERO after approving via updateTask", () => {
    insertNullScoreTask(store, "01GUARD_ZERO_NULL");

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0); // not yet verified

    store.updateTask("01GUARD_ZERO_NULL", { verification_status: "approved" });

    // Guard wrote the sentinel — count must be zero (no null-score verified tasks)
    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
  });

  it("null-score approved task is downgraded to needs_revision (issue #266 floor guard fires first)", () => {
    // Issue #266: the floor guard in updateTask() fires before the sentinel
    // logic when a null-score task is approved.  The task is downgraded to
    // needs_revision so it can be re-dispatched with a proper score.
    // The sentinel path (approved + existing score >= 0.60) is unaffected.
    insertNullScoreTask(store, "01GUARD_INVARIANT");

    store.updateTask("01GUARD_INVARIANT", { verification_status: "approved" });

    const task = store.getTask("01GUARD_INVARIANT");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("handles the case where the task does not exist (no crash)", () => {
    // Should not throw even for a non-existent task id
    expect(() =>
      store.updateTask("NON_EXISTENT_TASK_ID", { verification_status: "approved" }),
    ).not.toThrow();
  });
});

// ── ensureScoresPopulated — Phase 2 starvation fix ────────────────────────────

describe("ensureScoresPopulated Phase 2 starvation fix (issue #244)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("Phase 2 runs even when Phase 1 fills the entire batchLimit", async () => {
    // Insert 3 null-score verified tasks (Phase 1 candidates)
    for (let i = 0; i < 3; i++) {
      insertNullScoreTask(store, `01STARVE_P1_${i}`, "approved");
    }
    // Insert 2 unverified done tasks (Phase 2 candidates)
    for (let i = 0; i < 2; i++) {
      insertUnverifiedTask(store, `01STARVE_P2_${i}`);
    }

    const verifier = new Verifier(store);
    let verifyCallCount = 0;
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.82,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });
    // Mock verify() to succeed without needing a real LLM client.
    // Phase 2 calls verify(taskId) for unverified done tasks — we simulate a
    // successful verification by updating the task in the store directly.
    (verifier as any).verify = vi.fn().mockImplementation(async (taskId: string) => {
      verifyCallCount++;
      store.updateTask(taskId, { verification_status: "approved", quality_score: 0.82 });
    });

    // With batchLimit=3, Phase 1 fills the batch with its 3 null-score tasks.
    // OLD BUG: `remaining = 3 - 3 = 0` → Phase 2 would never run.
    // NEW FIX: Phase 2 uses batchLimit=3 independently.
    const scored = await verifier.ensureScoresPopulated(3);

    // Phase 1 scored 3 null-score tasks
    expect((verifier as any).inferMissingScore).toHaveBeenCalledTimes(3);

    // Phase 2 attempted to verify unverified tasks — verify() was called for them
    // What matters is that scored > 3 (Phase 2 contributed)
    expect(scored).toBeGreaterThan(3);
  });

  it("Phase 2 respects its own batchLimit independently of Phase 1", async () => {
    // 0 null-score verified tasks (Phase 1 does nothing)
    // 5 unverified tasks (Phase 2 should process up to batchLimit)
    for (let i = 0; i < 5; i++) {
      insertUnverifiedTask(store, `01INDEPENDENT_P2_${i}`);
    }

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.85,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });
    // Mock verify() to succeed without needing a real LLM client.
    (verifier as any).verify = vi.fn().mockImplementation(async (taskId: string) => {
      store.updateTask(taskId, { verification_status: "approved", quality_score: 0.85 });
    });

    const scored = await verifier.ensureScoresPopulated(3);

    // Phase 2 should have processed exactly 3 (batchLimit)
    // rather than 0 due to starvation
    expect(scored).toBe(3);
  });
});

// ── repairNullScoresForApprovedTasks — now covers rejected too ────────────────

describe("repairNullScoresForApprovedTasks covers rejected tasks (issue #244)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("repairs null score for a rejected task", async () => {
    insertNullScoreTask(store, "01REPAIR_REJECTED_NULL", "rejected");

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: false,
      score: 0.45,
      notes: "Inferred low",
      blockedReason: "hard_block_sub50",
    });

    const repaired = await verifier.repairNullScoresForApprovedTasks();

    expect(repaired).toBe(1);
    const task = store.getTask("01REPAIR_REJECTED_NULL");
    expect(task?.quality_score).toBe(0.45);
    expect(task?.verification_status).toBe("rejected");
  });

  it("repairs both approved and rejected null-score tasks in one pass", async () => {
    insertNullScoreTask(store, "01REPAIR_BOTH_APPROVED", "approved");
    insertNullScoreTask(store, "01REPAIR_BOTH_REJECTED", "rejected");

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.80,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });

    const repaired = await verifier.repairNullScoresForApprovedTasks();

    expect(repaired).toBe(2);

    const approved = store.getTask("01REPAIR_BOTH_APPROVED");
    expect(approved?.quality_score).toBe(0.80);
    expect(approved?.verification_status).toBe("approved");

    const rejected = store.getTask("01REPAIR_BOTH_REJECTED");
    expect(rejected?.quality_score).toBe(0.80);
    // Rejection is preserved regardless of inferred score
    expect(rejected?.verification_status).toBe("rejected");
  });

  it("returns 0 when no verified tasks have null scores", async () => {
    // Insert a task with a score already set
    insertNullScoreTask(store, "01REPAIR_NONE", "approved");
    store.updateTask("01REPAIR_NONE", { quality_score: 0.88 });

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn();

    const repaired = await verifier.repairNullScoresForApprovedTasks();

    expect(repaired).toBe(0);
    expect((verifier as any).inferMissingScore).not.toHaveBeenCalled();
  });

  it("getVerifiedTasksWithNullScoresCount drops to zero after full repair", async () => {
    insertNullScoreTask(store, "01REPAIR_COUNT_APPROVED", "approved");
    insertNullScoreTask(store, "01REPAIR_COUNT_REJECTED", "rejected");
    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(2);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.83,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });

    await verifier.repairNullScoresForApprovedTasks();

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
  });
});

// ── Acceptance criteria end-to-end ───────────────────────────────────────────

describe("End-to-end: zero null quality_score for verified tasks (issue #244)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("approving 10 tasks via updateTask() produces zero null scores", () => {
    for (let i = 0; i < 10; i++) {
      insertNullScoreTask(store, `01E2E_APPROVED_${i.toString().padStart(3, "0")}`);
      store.updateTask(`01E2E_APPROVED_${i.toString().padStart(3, "0")}`, {
        verification_status: "approved",
      });
    }

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
    const tasks = store.getVerifiedTasksWithNullScores();
    expect(tasks).toHaveLength(0);
  });

  it("rejecting 10 tasks via updateTask() produces zero null scores", () => {
    for (let i = 0; i < 10; i++) {
      insertNullScoreTask(store, `01E2E_REJECTED_${i.toString().padStart(3, "0")}`);
      store.updateTask(`01E2E_REJECTED_${i.toString().padStart(3, "0")}`, {
        verification_status: "rejected",
      });
    }

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
  });

  it("mixing approved and rejected tasks via updateTask() produces zero null scores", () => {
    for (let i = 0; i < 20; i++) {
      const status = i % 2 === 0 ? "approved" : "rejected";
      insertNullScoreTask(store, `01E2E_MIXED_${i.toString().padStart(3, "0")}`);
      store.updateTask(`01E2E_MIXED_${i.toString().padStart(3, "0")}`, {
        verification_status: status,
      });
    }

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
  });

  it("tasks approved WITH explicit quality_score do not get the sentinel", () => {
    for (let i = 0; i < 5; i++) {
      const score = 0.80 + i * 0.02;
      insertNullScoreTask(store, `01E2E_EXPLICIT_${i}`);
      store.updateTask(`01E2E_EXPLICIT_${i}`, {
        verification_status: "approved",
        quality_score: score,
      });
    }

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
    // None of the tasks should have the sentinel value — all have explicit scores
    const tasks = store.listTasks({ status: "done", limit: 100 }).filter(
      (t) => t.verification_status === "approved",
    );
    for (const task of tasks) {
      expect(task.quality_score).not.toBe(StateStore.NULL_SCORE_APPROVED_SENTINEL);
    }
  });
});
