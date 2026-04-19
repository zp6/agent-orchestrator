/**
 * Tests for the antibody false-positive correction flow (issue #762).
 *
 * Covers:
 *   - StateStore.markAntibodyFalsePositive()
 *   - StateStore.getAntibodyHeldTasks()
 *   - StateStore.getAntibodyFilterAccuracy()
 *   - StateStore.getAntibodyEntries() with includeFalsePositives option
 *   - formatFilterAccuracy() CLI helper
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore, type AntibodyFilterAccuracy } from "../../state/store.js";
import { formatFilterAccuracy } from "./antibodies.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempStore(): StateStore {
  // Use in-memory database to avoid disk I/O in tests
  return new StateStore(":memory:");
}

function seedAntibodyEntry(
  store: StateStore,
  opts: {
    repo?: string;
    decision?: "approve" | "request-changes" | "escalate";
    outcome?: "clean" | "regression" | null;
    agent?: string;
    reason?: string;
  } = {},
) {
  return store.recordAntibodyEntry({
    repo: opts.repo ?? "owner/repo",
    pr_number: Math.floor(Math.random() * 10000) + 1,
    diff_shape: {
      files_changed: 3,
      diff_size_bytes: 1024,
      extensions: [".ts"],
      directories: ["src/state"],
      touches_schema: false,
      touches_tests: true,
    },
    decision: opts.decision ?? "request-changes",
    reason: opts.reason ?? "Missing error handling in the state update path",
    agent: opts.agent ?? "claude-proxy",
  });
}

// ── markAntibodyFalsePositive ──────────────────────────────────────────────

describe("StateStore.markAntibodyFalsePositive", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTempStore();
  });

  it("marks an existing entry as false_positive = 1", () => {
    const entry = seedAntibodyEntry(store, { decision: "request-changes" });
    expect(entry.false_positive).toBe(0);

    store.markAntibodyFalsePositive(entry.id);

    const updated = store.getAntibodyEntries({ includeFalsePositives: true })
      .find((e) => e.id === entry.id);
    expect(updated?.false_positive).toBe(1);
  });

  it("throws when the entry ID does not exist", () => {
    expect(() => store.markAntibodyFalsePositive(99999)).toThrow();
  });

  it("is idempotent — calling twice does not throw", () => {
    const entry = seedAntibodyEntry(store);
    store.markAntibodyFalsePositive(entry.id);
    expect(() => store.markAntibodyFalsePositive(entry.id)).not.toThrow();
  });
});

// ── getAntibodyEntries with includeFalsePositives ─────────────────────────

describe("StateStore.getAntibodyEntries — false positive filtering", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTempStore();
  });

  it("excludes false-positive entries by default", () => {
    const e1 = seedAntibodyEntry(store, { reason: "missing auth check" });
    const e2 = seedAntibodyEntry(store, { reason: "no test coverage" });
    store.markAntibodyFalsePositive(e1.id);

    const entries = store.getAntibodyEntries({});
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain(e1.id);
    expect(ids).toContain(e2.id);
  });

  it("includes false-positive entries when includeFalsePositives=true", () => {
    const e1 = seedAntibodyEntry(store);
    store.markAntibodyFalsePositive(e1.id);

    const entries = store.getAntibodyEntries({ includeFalsePositives: true });
    const ids = entries.map((e) => e.id);
    expect(ids).toContain(e1.id);
  });

  it("returns zero risk entries after all are marked false-positive", () => {
    const e1 = seedAntibodyEntry(store, { decision: "request-changes" });
    const e2 = seedAntibodyEntry(store, { decision: "escalate" });
    store.markAntibodyFalsePositive(e1.id);
    store.markAntibodyFalsePositive(e2.id);

    const entries = store.getAntibodyEntries({ decision: "request-changes" });
    expect(entries).toHaveLength(0);
  });
});

// ── getAntibodyHeldTasks ───────────────────────────────────────────────────

describe("StateStore.getAntibodyHeldTasks", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTempStore();
  });

  it("returns empty array when no tasks have been flagged", () => {
    const held = store.getAntibodyHeldTasks();
    expect(held).toHaveLength(0);
  });

  it("returns tasks in pending/dispatched/in_progress with antibody-flagged log", () => {
    // Create an active task
    const task = store.createTask({
      title: "Fix authentication bug",
      description: "Implement OAuth token refresh",
      agent_name: "claude-proxy",
      task_type: "implementation",
    });

    // Simulate antibody-flagged system log
    store.addLog({
      task_id: task.id,
      direction: "system",
      agent_name: "claude-proxy",
      content: "[antibody-flagged] Matched 1 risk pattern(s): owner/repo#42(85%)",
    });

    const held = store.getAntibodyHeldTasks();
    expect(held.length).toBeGreaterThanOrEqual(1);
    const found = held.find((t) => t.id === task.id);
    expect(found).toBeDefined();
    expect(found?.antibody_log_entry).toContain("[antibody-flagged]");
  });

  it("does NOT return completed tasks (status=done)", () => {
    const task = store.createTask({
      title: "Completed flagged task",
      description: "This task is done",
      agent_name: "claude-proxy",
      task_type: "implementation",
    });

    store.addLog({
      task_id: task.id,
      direction: "system",
      agent_name: "claude-proxy",
      content: "[antibody-flagged] Matched 1 risk pattern(s): owner/repo#42(85%)",
    });

    // Mark as done
    store.updateTaskStatus(task.id, "done");

    const held = store.getAntibodyHeldTasks();
    const found = held.find((t) => t.id === task.id);
    expect(found).toBeUndefined();
  });
});

// ── getAntibodyFilterAccuracy ──────────────────────────────────────────────

describe("StateStore.getAntibodyFilterAccuracy", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTempStore();
  });

  it("returns zero counts and null precision when no data", () => {
    const acc = store.getAntibodyFilterAccuracy(30);
    expect(acc.total_flagged).toBe(0);
    expect(acc.true_positives).toBe(0);
    expect(acc.false_positives).toBe(0);
    expect(acc.operator_overrides).toBe(0);
    expect(acc.precision).toBeNull();
  });

  it("counts operator overrides in the accuracy window", () => {
    // Seed a false-positive entry
    const e = seedAntibodyEntry(store, { decision: "request-changes" });
    store.markAntibodyFalsePositive(e.id);

    const acc = store.getAntibodyFilterAccuracy(30);
    expect(acc.operator_overrides).toBe(1);
    expect(acc.false_positives).toBeGreaterThanOrEqual(1);
  });

  it("returns window_days matching the argument", () => {
    const acc7 = store.getAntibodyFilterAccuracy(7);
    const acc90 = store.getAntibodyFilterAccuracy(90);
    expect(acc7.window_days).toBe(7);
    expect(acc90.window_days).toBe(90);
  });

  it("computes precision correctly when there are true and false positives", () => {
    // Create tasks: 2 done (FP), 1 failed (TP)
    const taskDone1 = store.createTask({ title: "Task 1", agent_name: "a", task_type: "implementation" });
    const taskDone2 = store.createTask({ title: "Task 2", agent_name: "a", task_type: "implementation" });
    const taskFailed = store.createTask({ title: "Task 3", agent_name: "a", task_type: "implementation" });

    for (const task of [taskDone1, taskDone2, taskFailed]) {
      store.addLog({
        task_id: task.id,
        direction: "system",
        agent_name: "a",
        content: `[antibody-flagged] Matched 1 risk pattern(s): repo#1(80%)`,
      });
    }

    store.updateTaskStatus(taskDone1.id, "done");
    store.updateTaskStatus(taskDone2.id, "done");
    store.updateTaskStatus(taskFailed.id, "failed");

    const acc = store.getAntibodyFilterAccuracy(30);
    // TP=1 (failed), FP=2 (done) → precision = 1/3 ≈ 0.333
    expect(acc.true_positives).toBe(1);
    expect(acc.false_positives).toBeGreaterThanOrEqual(2);
    expect(acc.precision).not.toBeNull();
    if (acc.precision !== null) {
      expect(acc.precision).toBeCloseTo(1 / 3, 1);
    }
  });
});

// ── formatFilterAccuracy ───────────────────────────────────────────────────

describe("formatFilterAccuracy", () => {
  it("includes all key metrics in the output", () => {
    const acc: AntibodyFilterAccuracy = {
      window_days: 30,
      total_flagged: 10,
      true_positives: 7,
      false_positives: 3,
      operator_overrides: 1,
      precision: 0.7,
    };
    const output = formatFilterAccuracy(acc);
    expect(output).toContain("10");
    expect(output).toContain("7");
    expect(output).toContain("3");
    expect(output).toContain("70.0%");
  });

  it("handles null precision gracefully", () => {
    const acc: AntibodyFilterAccuracy = {
      window_days: 30,
      total_flagged: 0,
      true_positives: 0,
      false_positives: 0,
      operator_overrides: 0,
      precision: null,
    };
    const output = formatFilterAccuracy(acc);
    expect(output).toContain("n/a");
  });

  it("shows green indicator when precision >= 0.8", () => {
    const acc: AntibodyFilterAccuracy = {
      window_days: 30,
      total_flagged: 5,
      true_positives: 4,
      false_positives: 1,
      operator_overrides: 0,
      precision: 0.8,
    };
    const output = formatFilterAccuracy(acc);
    expect(output).toContain("performing well");
  });

  it("shows warning indicator when precision is 60–79%", () => {
    const acc: AntibodyFilterAccuracy = {
      window_days: 30,
      total_flagged: 5,
      true_positives: 3,
      false_positives: 2,
      operator_overrides: 0,
      precision: 0.6,
    };
    const output = formatFilterAccuracy(acc);
    expect(output).toContain("moderate");
  });

  it("shows critical indicator when precision < 0.6", () => {
    const acc: AntibodyFilterAccuracy = {
      window_days: 30,
      total_flagged: 5,
      true_positives: 1,
      false_positives: 4,
      operator_overrides: 2,
      precision: 0.2,
    };
    const output = formatFilterAccuracy(acc);
    expect(output).toContain("low");
  });
});
