import { describe, it, expect } from "vitest";
import { checkDuplicate, RECENCY_WINDOW_HOURS } from "./duplicate-guard.js";
import type { StateStore, Task } from "../state/store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

function makeStore(task: Task | undefined): Pick<StateStore, "findTaskBySourceRef"> {
  return { findTaskBySourceRef: () => task } as unknown as StateStore;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01ABC",
    title: "Test task",
    description: null,
    source: "github",
    source_ref: "owner/repo#1",
    status: "done",
    agent_name: "claude-agent-orchestrator",
    conversation_id: null,
    result: null,
    parent_task_id: null,
    step_id: null,
    plan: null,
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    created_at: hoursAgo(5),
    updated_at: hoursAgo(5),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No existing task
// ---------------------------------------------------------------------------

describe("no existing task", () => {
  it("returns isDuplicate=false when no task exists for the ref", () => {
    const store = makeStore(undefined);
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#99");
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Active tasks — always duplicates
// ---------------------------------------------------------------------------

describe("active tasks", () => {
  for (const status of ["pending", "planning", "dispatched", "in_progress"] as const) {
    it(`blocks when existing task has status "${status}"`, () => {
      const store = makeStore(makeTask({ status }));
      const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
      expect(result.isDuplicate).toBe(true);
      expect(result.reason).toContain(status);
      expect(result.existingTask).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// Completed tasks within the recency window
// ---------------------------------------------------------------------------

describe("recent completed tasks", () => {
  it("blocks a done task updated 1 hour ago (within window)", () => {
    const store = makeStore(makeTask({ status: "done", updated_at: hoursAgo(1) }));
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("done");
  });

  it("blocks a failed task updated 2 hours ago (within window)", () => {
    const store = makeStore(makeTask({ status: "failed", updated_at: hoursAgo(2) }));
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("failed");
  });

  it("blocks a task updated just under the window boundary", () => {
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(RECENCY_WINDOW_HOURS - 0.01) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Completed tasks outside the recency window — allow re-dispatch
// ---------------------------------------------------------------------------

describe("stale completed tasks", () => {
  it("allows re-dispatch of a done task older than the window", () => {
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(RECENCY_WINDOW_HOURS + 0.1) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(false);
  });

  it("allows re-dispatch of a failed task older than the window", () => {
    const store = makeStore(
      makeTask({ status: "failed", updated_at: hoursAgo(RECENCY_WINDOW_HOURS + 1) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verifier-rejected tasks — always allow re-dispatch
// ---------------------------------------------------------------------------

describe("verifier-rejected tasks", () => {
  it("allows immediate re-dispatch of a recently-rejected done task", () => {
    const store = makeStore(
      makeTask({
        status: "done",
        verification_status: "rejected",
        updated_at: hoursAgo(0.5),
      }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(false);
  });

  it("allows immediate re-dispatch of a recently-rejected failed task", () => {
    const store = makeStore(
      makeTask({
        status: "failed",
        verification_status: "rejected",
        updated_at: hoursAgo(1),
      }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(false);
  });

  it("does NOT exempt an approved task from the recency window", () => {
    const store = makeStore(
      makeTask({
        status: "done",
        verification_status: "approved",
        updated_at: hoursAgo(1),
      }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.isDuplicate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-world cases from issue #15
// ---------------------------------------------------------------------------

describe("issue-15 real-world cases", () => {
  it("blocks re-dispatch of an in-flight PR merge-conflict task", () => {
    // Simulates tasks 01KMBW90 / 01KMBT19 / 01KMC2EH pattern
    const store = makeStore(
      makeTask({ status: "dispatched", source_ref: "owner/repo#10", updated_at: hoursAgo(0.5) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#10");
    expect(result.isDuplicate).toBe(true);
  });

  it("allows re-dispatch after the recency window expires", () => {
    const store = makeStore(
      makeTask({ status: "done", source_ref: "owner/repo#10", updated_at: hoursAgo(RECENCY_WINDOW_HOURS + 1) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#10");
    expect(result.isDuplicate).toBe(false);
  });

  it("allows first dispatch when no prior task exists for that ref", () => {
    const store = makeStore(undefined);
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#10");
    expect(result.isDuplicate).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #330 — 24-hour recency window
// ---------------------------------------------------------------------------

describe("issue-330: 24h recency window", () => {
  it("RECENCY_WINDOW_HOURS is 24", () => {
    expect(RECENCY_WINDOW_HOURS).toBe(24);
  });

  it("blocks re-dispatch of a task completed 4 hours ago (within 24h window)", () => {
    // Reproduces the exact scenario from issue #330: task completed, issue
    // still open, next poll cycle picks it up again within 4 hours.
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(4) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#264");
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain("4.0h ago");
    expect(result.reason).toContain("window: 24h");
  });

  it("blocks re-dispatch of a task completed 23 hours ago (still within window)", () => {
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(23) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#264");
    expect(result.isDuplicate).toBe(true);
  });

  it("allows re-dispatch of a task completed exactly at the window boundary (24h)", () => {
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(RECENCY_WINDOW_HOURS + 0.01) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#264");
    expect(result.isDuplicate).toBe(false);
  });

  it("reason message includes windowHours value", () => {
    const store = makeStore(
      makeTask({ status: "done", updated_at: hoursAgo(1) }),
    );
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#264");
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toContain(`window: ${RECENCY_WINDOW_HOURS}h`);
  });
});

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe("result shape", () => {
  it("existingTask is undefined when isDuplicate is false", () => {
    const store = makeStore(undefined);
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.existingTask).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it("existingTask is populated when isDuplicate is true", () => {
    const task = makeTask({ status: "dispatched" });
    const store = makeStore(task);
    const result = checkDuplicate(store as StateStore, "github", "owner/repo#1");
    expect(result.existingTask).toEqual(task);
    expect(result.reason).toBeTruthy();
  });
});
