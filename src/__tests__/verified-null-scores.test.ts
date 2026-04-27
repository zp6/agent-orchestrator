/**
 * Tests for issue #229 — persist quality scores for ALL verified tasks.
 *
 * Before this fix:
 * - getApprovedTasksWithNullScores() covered only 'approved' tasks; rejected
 *   tasks with null quality_score were invisible to the repair loop.
 * - ensureScoresPopulated() Phase 1 therefore left rejected tasks with null scores.
 * - /backfill-scores Telegram command also only processed approved tasks.
 *
 * After this fix:
 * - getVerifiedTasksWithNullScores() covers both 'approved' AND 'rejected'.
 * - ensureScoresPopulated() repairs both; for already-rejected tasks the
 *   rejection is preserved (status is never flipped to approved).
 * - /backfill-scores processes both statuses.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({})),
}));

import { Verifier } from "../reviewer/verifier.js";
import { StateStore } from "../state/store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
    };
  };
};

function insertVerifiedNullScoreTask(
  store: StateStore,
  taskId: string,
  verificationStatus: "approved" | "rejected",
  result = "Agent output for task",
): void {
  const raw = store as unknown as RawDB;
  const now = "2026-04-16T10:00:00.000Z";
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, description, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, ?, 'done', ?, NULL, ?, 'implementation', ?, ?, ?)`,
    )
    .run(
      taskId,
      `Task ${taskId}`,
      "A test task description",
      verificationStatus,
      "agent-a",
      result,
      now,
      now,
    );
}

// ── getVerifiedTasksWithNullScores ────────────────────────────────────────────

describe("StateStore.getVerifiedTasksWithNullScores (issue #229)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns approved tasks with null scores", () => {
    insertVerifiedNullScoreTask(store, "01TASK_APPROVED_NULL", "approved");
    const rows = store.getVerifiedTasksWithNullScores();
    expect(rows).toHaveLength(1);
    expect(rows[0].verification_status).toBe("approved");
  });

  it("returns rejected tasks with null scores", () => {
    insertVerifiedNullScoreTask(store, "01TASK_REJECTED_NULL", "rejected");
    const rows = store.getVerifiedTasksWithNullScores();
    expect(rows).toHaveLength(1);
    expect(rows[0].verification_status).toBe("rejected");
  });

  it("returns both approved and rejected tasks when both have null scores", () => {
    insertVerifiedNullScoreTask(store, "01TASK_APPROVED_NULL2", "approved");
    insertVerifiedNullScoreTask(store, "01TASK_REJECTED_NULL2", "rejected");
    const rows = store.getVerifiedTasksWithNullScores();
    expect(rows).toHaveLength(2);
    const statuses = rows.map((r) => r.verification_status).sort();
    expect(statuses).toEqual(["approved", "rejected"]);
  });

  it("excludes tasks that already have a score", () => {
    insertVerifiedNullScoreTask(store, "01TASK_NULL_SCORE", "approved");
    // Also insert one with a score via updateTask
    insertVerifiedNullScoreTask(store, "01TASK_WITH_SCORE", "approved");
    store.updateTask("01TASK_WITH_SCORE", { quality_score: 0.85 });

    const rows = store.getVerifiedTasksWithNullScores();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("01TASK_NULL_SCORE");
  });

  it("getVerifiedTasksWithNullScoresCount returns the correct count", () => {
    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
    insertVerifiedNullScoreTask(store, "01TASK_COUNT_APPROVED", "approved");
    insertVerifiedNullScoreTask(store, "01TASK_COUNT_REJECTED", "rejected");
    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(2);
  });
});

// ── ensureScoresPopulated — rejected tasks are repaired ───────────────────────

describe("ensureScoresPopulated repairs rejected tasks with null scores (issue #229)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("backfills score for a rejected task and preserves rejection status", async () => {
    const taskId = "01TASK_REJECTED_BACKFILL_001";
    insertVerifiedNullScoreTask(store, taskId, "rejected");

    const verifier = new Verifier(store);
    // Stub inferMissingScore to return a high score — must NOT flip to approved
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true, // high score → would approve if unconstrained
      score: 0.88,
      notes: "Inferred score",
      approvalRationale: "inferred_fallback_llm_secondary",
    });

    const scored = await verifier.ensureScoresPopulated(10);

    expect(scored).toBe(1);

    const task = store.getTask(taskId);
    // Status must stay rejected — we do not flip already-rejected tasks
    expect(task?.verification_status).toBe("rejected");
    // But the numeric score must now be filled in
    expect(task?.quality_score).toBe(0.88);
  });

  it("backfills score for a rejected task even when inferred score is low", async () => {
    const taskId = "01TASK_REJECTED_BACKFILL_002";
    insertVerifiedNullScoreTask(store, taskId, "rejected");

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: false,
      score: 0.30,
      notes: "Low inferred score",
      approvalRationale: undefined,
      blockedReason: "hard_block_sub50",
    });

    const scored = await verifier.ensureScoresPopulated(10);

    expect(scored).toBe(1);

    const task = store.getTask(taskId);
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.30);
  });

  it("backfills both approved and rejected tasks in the same batch", async () => {
    const approvedId = "01TASK_MIXED_APPROVED_001";
    const rejectedId = "01TASK_MIXED_REJECTED_001";
    insertVerifiedNullScoreTask(store, approvedId, "approved");
    insertVerifiedNullScoreTask(store, rejectedId, "rejected");

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.82,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });

    const scored = await verifier.ensureScoresPopulated(10);

    expect(scored).toBe(2);

    const approvedTask = store.getTask(approvedId);
    expect(approvedTask?.quality_score).toBe(0.82);
    expect(approvedTask?.verification_status).toBe("approved");

    const rejectedTask = store.getTask(rejectedId);
    expect(rejectedTask?.quality_score).toBe(0.82);
    // Still rejected — we preserve rejection regardless of inferred score
    expect(rejectedTask?.verification_status).toBe("rejected");
  });

  it("getVerifiedTasksWithNullScoresCount drops to zero after full repair", async () => {
    const taskId = "01TASK_COUNT_ZERO_AFTER_REPAIR";
    insertVerifiedNullScoreTask(store, taskId, "approved");
    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(1);

    const verifier = new Verifier(store);
    (verifier as any).inferMissingScore = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.80,
      notes: "Inferred",
      approvalRationale: "inferred_fallback_housekeeping_heuristic",
    });

    await verifier.ensureScoresPopulated(10);

    expect(store.getVerifiedTasksWithNullScoresCount()).toBe(0);
  });
});
