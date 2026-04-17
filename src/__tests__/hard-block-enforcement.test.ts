import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({})),
}));

import { Verifier } from "../reviewer/verifier.js";
import { StateStore } from "../state/store.js";

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => unknown;
    };
  };
};

function insertDoneTask(
  store: StateStore,
  taskId: string,
  scoreText = "Task response",
): void {
  const raw = store as unknown as RawDB;
  const now = "2026-04-07T12:00:00.000Z";

  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, description, status, agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, ?, 'done', ?, 'implementation', ?, ?, ?)`,
    )
    .run(taskId, `Task ${taskId}`, "Test task", "agent-a", scoreText, now, now);
}

describe("hard-block enforcement", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("stores a sub-0.50 verification as rejected even if the caller reports approved", async () => {
    const taskId = "01HZXHARDBLOCK0000000000001";
    insertDoneTask(store, taskId);

    const verifier = new Verifier(store);
    (verifier as any).runLLMPass = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.38,
      notes: "LLM incorrectly approved a very low score",
      revision: "Revise the implementation",
      explanation: "The result is incomplete and incorrect.",
    });

    const result = await verifier.verify(taskId);
    const task = store.getTask(taskId);
    const record = store.getLatestVerificationRecord(taskId);

    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.38);
    expect(task?.verification_notes).toContain("HARD BLOCK");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("hard_block_sub50");
  });

  it("normalizes direct verification result inserts below the hard-block threshold", () => {
    store.insertVerificationResult({
      task_id: "T-LOW",
      score: 0.10,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "should-not-persist",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-LOW");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("hard_block_sub50");
    expect(record?.approval_rationale).toBeNull();
  });
});

describe("sub-threshold rejection (0.50–0.60) enforcement at store write path", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  // ── insertVerificationResult normalization ────────────────────────────────

  it("score of 0.50 with first_pass=1 is normalised to first_pass=0 (low_score_sub60)", () => {
    store.insertVerificationResult({
      task_id: "T-SUB60-BOUNDARY",
      score: 0.50,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "should-not-persist",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-SUB60-BOUNDARY");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("low_score_sub60");
    expect(record?.approval_rationale).toBeNull();
  });

  it("score of 0.55 with first_pass=1 is normalised to first_pass=0 (low_score_sub60)", () => {
    store.insertVerificationResult({
      task_id: "T-SUB60-MID",
      score: 0.55,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "should-not-persist",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-SUB60-MID");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("low_score_sub60");
    expect(record?.approval_rationale).toBeNull();
  });

  it("score of 0.59 with first_pass=1 is normalised to first_pass=0 (just below floor)", () => {
    store.insertVerificationResult({
      task_id: "T-SUB60-NEAR",
      score: 0.59,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "should-not-persist",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-SUB60-NEAR");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("low_score_sub60");
    expect(record?.approval_rationale).toBeNull();
  });

  it("score of 0.60 with first_pass=1 is stored as-is (exactly at floor)", () => {
    store.insertVerificationResult({
      task_id: "T-AT-FLOOR",
      score: 0.60,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "marginal_approval",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-AT-FLOOR");
    expect(record?.first_pass).toBe(1);
    expect(record?.blocked_reason).toBeNull();
    expect(record?.approval_rationale).toBe("marginal_approval");
  });

  it("score of 0.38 is still normalised as hard_block_sub50 (not low_score_sub60)", () => {
    store.insertVerificationResult({
      task_id: "T-HARD-BLOCK",
      score: 0.38,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "should-not-persist",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: "2026-04-07T12:00:00.000Z",
    });

    const record = store.getLatestVerificationRecord("T-HARD-BLOCK");
    expect(record?.first_pass).toBe(0);
    expect(record?.blocked_reason).toBe("hard_block_sub50");
    expect(record?.approval_rationale).toBeNull();
  });

  // ── updateTask invariant ──────────────────────────────────────────────────

  it("updateTask rejects approved status with quality_score of 0.55 (sub-threshold)", () => {
    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, agent_name, task_type, created_at, updated_at)
         VALUES ('T-UPDATE-LOW', 'Test', 'desc', 'done', 'agent-a', 'implementation', '2026-04-07', '2026-04-07')`,
      )
      .run();

    store.updateTask("T-UPDATE-LOW", {
      verification_status: "approved",
      quality_score: 0.55,
    });

    const task = store.getTask("T-UPDATE-LOW");
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.55);
  });

  it("updateTask rejects approved status with quality_score of 0.38 (hard block)", () => {
    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, agent_name, task_type, created_at, updated_at)
         VALUES ('T-UPDATE-HARD', 'Test', 'desc', 'done', 'agent-a', 'implementation', '2026-04-07', '2026-04-07')`,
      )
      .run();

    store.updateTask("T-UPDATE-HARD", {
      verification_status: "approved",
      quality_score: 0.38,
    });

    const task = store.getTask("T-UPDATE-HARD");
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.38);
  });

  it("updateTask allows approved status with quality_score of 0.60 (at floor)", () => {
    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, agent_name, task_type, created_at, updated_at)
         VALUES ('T-UPDATE-AT-FLOOR', 'Test', 'desc', 'done', 'agent-a', 'implementation', '2026-04-07', '2026-04-07')`,
      )
      .run();

    store.updateTask("T-UPDATE-AT-FLOOR", {
      verification_status: "approved",
      quality_score: 0.60,
    });

    const task = store.getTask("T-UPDATE-AT-FLOOR");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(0.60);
  });

  // ── getApprovedBelowThreshold audit query ─────────────────────────────────

  it("getApprovedBelowThreshold returns empty array when no low-score approved records exist", () => {
    store.insertVerificationResult({
      task_id: "T-GOOD",
      score: 0.85,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: null,
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: new Date().toISOString(),
    });

    const violations = store.getApprovedBelowThreshold(0.60, 30);
    expect(violations).toHaveLength(0);
  });

  it("getApprovedBelowThreshold returns empty array because sub-threshold writes are normalised to rejected", () => {
    // Even though we try to insert an approved record at 0.55, the store normalises it to rejected.
    store.insertVerificationResult({
      task_id: "T-NORM",
      score: 0.55,
      first_pass: 1,   // ← attempting to mark as approved
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: null,
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: new Date().toISOString(),
    });

    // After normalisation the record has first_pass=0, so audit query returns nothing.
    const violations = store.getApprovedBelowThreshold(0.60, 30);
    expect(violations).toHaveLength(0);
  });

  it("getApprovedBelowThreshold returns empty array when only above-threshold approved records exist", () => {
    store.insertVerificationResult({
      task_id: "T-ABOVE",
      score: 0.75,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: "marginal_approval",
      threshold: 0.8,
      agent_id: "agent-a",
      timestamp: new Date().toISOString(),
    });

    const violations = store.getApprovedBelowThreshold(0.60, 30);
    expect(violations).toHaveLength(0);
  });
});

describe("end-to-end: score 0.38 submitted via verifier is stored as rejected", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("stores a sub-0.60 verification as rejected at the store write path", async () => {
    const taskId = "01HZXSUB60E2E00000000000001";
    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, agent_name, task_type, result, created_at, updated_at)
         VALUES (?, ?, ?, 'done', 'agent-a', 'implementation', 'result', '2026-04-17', '2026-04-17')`,
      )
      .run(taskId, `Task ${taskId}`, "Test task");

    const verifier = new Verifier(store);
    (verifier as any).runLLMPass = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.38,
      notes: "LLM incorrectly approved a sub-0.60 score",
      revision: "Revise the implementation",
      explanation: "The result is incomplete.",
    });

    const result = await verifier.verify(taskId);
    const task = store.getTask(taskId);

    // Verifier should override to rejected due to hard-block (< 0.50)
    expect(result.approved).toBe(false);
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.38);

    // getApprovedBelowThreshold should return zero violations
    const violations = store.getApprovedBelowThreshold(0.60, 30);
    expect(violations).toHaveLength(0);
  });

  it("stores a score-0.55 task as rejected, audit query returns zero violations", async () => {
    const taskId = "01HZXSUB60E2E00000000000002";
    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, description, status, agent_name, task_type, result, created_at, updated_at)
         VALUES (?, ?, ?, 'done', 'agent-a', 'implementation', 'result', '2026-04-17', '2026-04-17')`,
      )
      .run(taskId, `Task ${taskId}`, "Test task");

    const verifier = new Verifier(store);
    (verifier as any).runLLMPass = vi.fn().mockResolvedValue({
      approved: true,
      score: 0.55,
      notes: "LLM incorrectly approved a sub-0.60 score",
      revision: "Revise the implementation",
      explanation: "The result partially addresses requirements.",
    });

    const result = await verifier.verify(taskId);
    const task = store.getTask(taskId);

    // Verifier should override to rejected via sub-threshold guard
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
    expect(task?.verification_status).toBe("rejected");
    expect(task?.quality_score).toBe(0.55);

    // Acceptance criterion: no approved records with score < 0.60 in last 30 days
    const violations = store.getApprovedBelowThreshold(0.60, 30);
    expect(violations).toHaveLength(0);
  });
});
