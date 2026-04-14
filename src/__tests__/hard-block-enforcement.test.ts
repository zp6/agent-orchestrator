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
