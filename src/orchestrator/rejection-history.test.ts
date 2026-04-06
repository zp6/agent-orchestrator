import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildRejectionHistoryBlock, type PriorAttempt } from "./rejection-history.js";
import { StateStore } from "../state/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("buildRejectionHistoryBlock", () => {
  it("returns empty string for empty attempts array", () => {
    expect(buildRejectionHistoryBlock([])).toBe("");
  });

  it("returns empty string when no attempts are rejected or low-quality", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "Completed successfully",
        verification_status: "approved",
        quality_score: 0.95,
        verification_notes: "Excellent work",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    expect(buildRejectionHistoryBlock(attempts)).toBe("");
  });

  it("formats a single rejected attempt correctly", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "Added a basic handler",
        verification_status: "rejected",
        quality_score: 0.45,
        verification_notes: "Missing error handling and tests",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);

    expect(block).toContain("## Prior Attempts (DO NOT repeat these approaches)");
    expect(block).toContain("### Attempt 1 (quality score: 0.45, status: rejected)");
    expect(block).toContain("**Result:** Added a basic handler");
    expect(block).toContain("**Rejection notes:** Missing error handling and tests");
    expect(block).toContain("You MUST take a different approach");
  });

  it("formats multiple rejected attempts in order", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "First try",
        verification_status: "rejected",
        quality_score: 0.3,
        verification_notes: "Incomplete implementation",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "task-2",
        result: "Second try",
        verification_status: "rejected",
        quality_score: 0.5,
        verification_notes: "Better but still missing tests",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);

    expect(block).toContain("### Attempt 1 (quality score: 0.30, status: rejected)");
    expect(block).toContain("**Result:** First try");
    expect(block).toContain("### Attempt 2 (quality score: 0.50, status: rejected)");
    expect(block).toContain("**Result:** Second try");
  });

  it("includes low-quality non-rejected attempts with notes", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "Partial fix",
        verification_status: "approved",
        quality_score: 0.55,
        verification_notes: "Barely acceptable, missing edge cases",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);
    expect(block).toContain("### Attempt 1");
    expect(block).toContain("quality score: 0.55");
  });

  it("truncates long results to 500 characters", () => {
    const longResult = "x".repeat(600);
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: longResult,
        verification_status: "rejected",
        quality_score: 0.2,
        verification_notes: "Bad",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);
    expect(block).toContain("x".repeat(500) + "...");
    expect(block).not.toContain("x".repeat(501));
  });

  it("handles null result and notes gracefully", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: null,
        verification_status: "rejected",
        quality_score: 0.1,
        verification_notes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);
    expect(block).toContain("(no result recorded)");
    expect(block).toContain("(no rejection notes)");
  });

  it("handles null quality score", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "Something",
        verification_status: "rejected",
        quality_score: null,
        verification_notes: "Bad approach",
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);
    expect(block).toContain("quality score: N/A");
  });

  it("filters out approved high-quality attempts", () => {
    const attempts: PriorAttempt[] = [
      {
        id: "task-1",
        result: "Good work",
        verification_status: "approved",
        quality_score: 0.9,
        verification_notes: "Excellent",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "task-2",
        result: "Bad work",
        verification_status: "rejected",
        quality_score: 0.3,
        verification_notes: "Needs improvement",
        created_at: "2026-01-02T00:00:00Z",
      },
    ];
    const block = buildRejectionHistoryBlock(attempts);
    expect(block).not.toContain("Good work");
    expect(block).toContain("Bad work");
    // Should only have one attempt listed
    expect(block).toContain("### Attempt 1");
    expect(block).not.toContain("### Attempt 2");
  });
});

describe("StateStore.getPriorAttempts", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-rejection-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("returns empty array when no tasks match source_ref", () => {
    const result = store.getPriorAttempts("rapartlu/test#99");
    expect(result).toEqual([]);
  });

  it("returns completed tasks with the same source_ref", () => {
    const task = store.createTask({
      title: "Test task",
      source: "github",
      source_ref: "rapartlu/test#42",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "done",
      result: "Task completed",
      verification_status: "rejected",
      quality_score: 0.4,
      verification_notes: "Missing tests",
    });

    const attempts = store.getPriorAttempts("rapartlu/test#42");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(task.id);
    expect(attempts[0].result).toBe("Task completed");
    expect(attempts[0].verification_status).toBe("rejected");
    expect(attempts[0].quality_score).toBe(0.4);
    expect(attempts[0].verification_notes).toBe("Missing tests");
  });

  it("excludes pending/dispatched/in_progress tasks", () => {
    const pending = store.createTask({
      title: "Pending",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    // pending stays in "pending" status

    const dispatched = store.createTask({
      title: "Dispatched",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(dispatched.id, { status: "dispatched" });

    const attempts = store.getPriorAttempts("rapartlu/test#42");
    expect(attempts).toHaveLength(0);
  });

  it("includes failed and escalated tasks", () => {
    const failed = store.createTask({
      title: "Failed task",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(failed.id, { status: "failed", result: "Error occurred" });

    const escalated = store.createTask({
      title: "Escalated task",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(escalated.id, { status: "escalated", result: "Too many retries" });

    const attempts = store.getPriorAttempts("rapartlu/test#42");
    expect(attempts).toHaveLength(2);
  });

  it("returns attempts ordered by created_at ascending", () => {
    const first = store.createTask({
      title: "First",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(first.id, { status: "done", result: "First result" });

    const second = store.createTask({
      title: "Second",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(second.id, { status: "failed", result: "Second result" });

    const attempts = store.getPriorAttempts("rapartlu/test#42");
    expect(attempts).toHaveLength(2);
    expect(attempts[0].result).toBe("First result");
    expect(attempts[1].result).toBe("Second result");
  });

  it("excludes sub-tasks (parent_task_id IS NOT NULL)", () => {
    const parent = store.createTask({
      title: "Parent",
      source: "github",
      source_ref: "rapartlu/test#42",
    });
    store.updateTask(parent.id, { status: "done", result: "Parent done" });

    // Create a sub-task by inserting directly (createTask doesn't support parent_task_id)
    store["db"]
      .prepare(
        `INSERT INTO tasks (id, title, source, source_ref, status, result, parent_task_id, task_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("sub-1", "Sub task", "github", "rapartlu/test#42", "done", "Sub result", parent.id, "implementation", new Date().toISOString(), new Date().toISOString());

    const attempts = store.getPriorAttempts("rapartlu/test#42");
    expect(attempts).toHaveLength(1);
    expect(attempts[0].id).toBe(parent.id);
  });
});
