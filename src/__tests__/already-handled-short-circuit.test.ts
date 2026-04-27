/**
 * Regression tests for issue #270 — already-handled pattern short-circuit.
 *
 * Before the fix, tasks where the agent correctly reported "already-in-review"
 * or "already handled" were passed to LLM scoring, which penalised them for
 * lacking implementation content (scores 0.25–0.30).
 *
 * The fix adds a pre-LLM pattern check in verify(): if task.result matches a
 * well-known already-handled pattern the verifier short-circuits immediately
 * with score=1.0 and verification_status="approved" — no LLM call is made.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — the factory cannot reference variables declared after it.
vi.mock("../client/llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({
    chat: { completions: { create: vi.fn() } },
  })),
}));

import { createLLMClient } from "../client/llm-client.js";
import { Verifier } from "../reviewer/verifier.js";
import { StateStore } from "../state/store.js";

const mockCreateLLMClient = vi.mocked(createLLMClient);

// ── helpers ──────────────────────────────────────────────────────────────────

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
    };
  };
};

function insertDoneTask(
  store: StateStore,
  taskId: string,
  result: string,
): void {
  const raw = store as unknown as RawDB;
  const now = "2026-04-18T10:00:00.000Z";

  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, description, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, ?, 'done', NULL, NULL, ?, 'implementation', ?, ?, ?)`,
    )
    .run(
      taskId,
      `Task ${taskId}`,
      "A test task description",
      "claude-orchestrator-reviewer",
      result,
      now,
      now,
    );
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("already-handled short-circuit (issue #270)", () => {
  let store: StateStore;
  let verifier: Verifier;

  beforeEach(() => {
    store = new StateStore(":memory:");
    verifier = new Verifier(store);
    mockCreateLLMClient.mockClear();
  });

  it('short-circuits with score 1.0 when result starts with "already-in-review:"', async () => {
    insertDoneTask(
      store,
      "task-270-a",
      "already-in-review: PR #268 is open and mergeable — skipping dispatch.",
    );

    const result = await verifier.verify("task-270-a");

    expect(result.approved).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.approvalRationale).toBe("short_circuit_no_action_needed");

    // No LLM call should have been made
    expect(mockCreateLLMClient).not.toHaveBeenCalled();

    // State should be persisted correctly
    const task = store.getTask("task-270-a");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(1.0);
  });

  it('short-circuits with score 1.0 when result contains "already handled"', async () => {
    insertDoneTask(
      store,
      "task-270-b",
      "This issue is already handled — a merged PR addresses the requirements.",
    );

    const result = await verifier.verify("task-270-b");

    expect(result.approved).toBe(true);
    expect(result.score).toBe(1.0);
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });

  it('short-circuits with score 1.0 when result contains "already-handled" (hyphenated)', async () => {
    insertDoneTask(
      store,
      "task-270-c",
      "Task already-handled: found open PR #301 covering this issue.",
    );

    const result = await verifier.verify("task-270-c");

    expect(result.approved).toBe(true);
    expect(result.score).toBe(1.0);
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });

  it('short-circuits with score 1.0 when result contains "PR already exists and is mergeable"', async () => {
    insertDoneTask(
      store,
      "task-270-d",
      "PR already exists and is mergeable: https://github.com/owner/repo/pull/99",
    );

    const result = await verifier.verify("task-270-d");

    expect(result.approved).toBe(true);
    expect(result.score).toBe(1.0);
    expect(mockCreateLLMClient).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit for normal implementation results", async () => {
    // Normal result — should still proceed to LLM verification.
    // Stub runLLMPass on the instance to avoid a real LLM call while still
    // confirming the already-handled guard is NOT triggered.
    const llmResult = {
      approved: true,
      score: 0.90,
      notes: "Looks good",
      dimensions: {
        correctness: 0.9,
        completeness: 0.9,
        test_coverage: 0.9,
        code_quality: 0.9,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runLLMPassSpy = vi
      .spyOn(verifier as any, "runLLMPass")
      .mockResolvedValue(llmResult);

    insertDoneTask(
      store,
      "task-270-e",
      "Implemented the feature by updating src/foo.ts and adding tests.",
    );

    const result = await verifier.verify("task-270-e");

    // runLLMPass should have been invoked (not short-circuited)
    expect(runLLMPassSpy).toHaveBeenCalled();
    // Result should NOT be a short-circuit approval
    expect(result.approvalRationale).not.toBe("short_circuit_no_action_needed");
  });

  it("all quality dimensions are 1.0 on short-circuit", async () => {
    insertDoneTask(
      store,
      "task-270-f",
      "already-in-review: PR #500 open and mergeable.",
    );

    const result = await verifier.verify("task-270-f");

    expect(result.dimensions?.correctness).toBe(1.0);
    expect(result.dimensions?.completeness).toBe(1.0);
    expect(result.dimensions?.test_coverage).toBe(1.0);
    expect(result.dimensions?.code_quality).toBe(1.0);
  });
});
