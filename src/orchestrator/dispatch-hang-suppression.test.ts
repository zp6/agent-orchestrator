/**
 * Tests for the dispatch-hang suppression antibody (issue #1374).
 *
 * Validates that:
 *  - StateStore correctly computes hang stats from task history
 *  - Suppression fires when threshold is met
 *  - Suppression does NOT fire below threshold
 *  - The pre-dispatch validator integrates the check correctly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return join(tmpdir(), `hang-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function createTaskDirect(
  store: StateStore,
  overrides: Partial<{
    source_ref: string;
    status: string;
    retry_count: number;
    parent_task_id: string | null;
    created_at: string;
  }> = {},
) {
  const task = store.createTask({
    title: "test task",
    description: "test",
    source: "github",
    source_ref: overrides.source_ref ?? "owner/repo#1",
    agent_name: "test-agent",
    task_type: "implementation",
  });

  // Manually update fields that createTask doesn't support directly
  const db = (store as any).db;
  if (overrides.status) {
    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(overrides.status, task.id);
  }
  if (overrides.retry_count !== undefined) {
    db.prepare("UPDATE tasks SET retry_count = ? WHERE id = ?").run(overrides.retry_count, task.id);
  }
  if (overrides.parent_task_id !== undefined) {
    db.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(overrides.parent_task_id, task.id);
  }
  if (overrides.created_at) {
    db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(overrides.created_at, task.id);
  }

  return task;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getSourceRefHangStats", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("returns zeros for a source_ref with no tasks", () => {
    const stats = store.getSourceRefHangStats("owner/repo#999");

    expect(stats.source_ref).toBe("owner/repo#999");
    expect(stats.total_tasks).toBe(0);
    expect(stats.failed_or_retried_count).toBe(0);
    expect(stats.max_retry_count).toBe(0);
    expect(stats.oldest_at).toBeNull();
    expect(stats.newest_at).toBeNull();
  });

  it("counts successful tasks but not as failures", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "done", retry_count: 0 });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    expect(stats.total_tasks).toBe(1);
    expect(stats.failed_or_retried_count).toBe(0);
  });

  it("counts failed tasks as failed_or_retried", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 0 });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    expect(stats.total_tasks).toBe(1);
    expect(stats.failed_or_retried_count).toBe(1);
  });

  it("counts retried tasks as failed_or_retried", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "done", retry_count: 2 });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    expect(stats.total_tasks).toBe(1);
    expect(stats.failed_or_retried_count).toBe(1);
    expect(stats.max_retry_count).toBe(2);
  });

  it("counts escalated tasks as failed_or_retried", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "escalated", retry_count: 0 });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    expect(stats.failed_or_retried_count).toBe(1);
  });

  it("excludes child tasks (parent_task_id is not null)", () => {
    const parent = createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    createTaskDirect(store, {
      source_ref: "owner/repo#1",
      status: "failed",
      parent_task_id: parent.id,
    });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    // Only the parent counts — child is excluded
    expect(stats.total_tasks).toBe(1);
    expect(stats.failed_or_retried_count).toBe(1);
  });

  it("respects the time window", () => {
    // Task from 48 hours ago — should be excluded from 24h window
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", created_at: old });
    // Recent task
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });

    const stats = store.getSourceRefHangStats("owner/repo#1", 24);

    expect(stats.total_tasks).toBe(1);
    expect(stats.failed_or_retried_count).toBe(1);
  });

  it("tracks max_retry_count across tasks", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 1 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 3 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 2 });

    const stats = store.getSourceRefHangStats("owner/repo#1");

    expect(stats.max_retry_count).toBe(3);
  });
});

describe("checkSourceRefHangSuppression", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("does not suppress when no tasks exist", () => {
    const result = store.checkSourceRefHangSuppression("owner/repo#1");

    expect(result.suppressed).toBe(false);
    expect(result.stats.total_tasks).toBe(0);
  });

  it("does not suppress when failures are below threshold", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    // 2 failures, threshold is 3

    const result = store.checkSourceRefHangSuppression("owner/repo#1");

    expect(result.suppressed).toBe(false);
  });

  it("suppresses when failures meet threshold", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 2 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 1 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed", retry_count: 0 });

    const result = store.checkSourceRefHangSuppression("owner/repo#1");

    expect(result.suppressed).toBe(true);
    expect(result.reason).toContain("Dispatch hang suppressed");
    expect(result.reason).toContain("Operator action required");
    expect(result.stats.failed_or_retried_count).toBe(3);
  });

  it("does not suppress when total_tasks < threshold even if all failed", () => {
    // 2 tasks, both failed — but threshold is 3
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });

    const result = store.checkSourceRefHangSuppression("owner/repo#1", 3);

    expect(result.suppressed).toBe(false);
  });

  it("respects custom threshold", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });

    // threshold = 1
    const result = store.checkSourceRefHangSuppression("owner/repo#1", 1);

    expect(result.suppressed).toBe(true);
  });

  it("does not suppress successful tasks even if many exist", () => {
    for (let i = 0; i < 5; i++) {
      createTaskDirect(store, { source_ref: "owner/repo#1", status: "done", retry_count: 0 });
    }

    const result = store.checkSourceRefHangSuppression("owner/repo#1");

    expect(result.suppressed).toBe(false);
    expect(result.stats.total_tasks).toBe(5);
    expect(result.stats.failed_or_retried_count).toBe(0);
  });

  it("mixed success/failure — only counts failures toward suppression", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "done", retry_count: 0 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "done", retry_count: 0 });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });

    // 4 total tasks, 2 failures — threshold 3 not met for failures
    const result = store.checkSourceRefHangSuppression("owner/repo#1", 3);

    expect(result.suppressed).toBe(false);
    expect(result.stats.total_tasks).toBe(4);
    expect(result.stats.failed_or_retried_count).toBe(2);
  });
});

describe("getHangSuppressedSourceRefs", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
    try { unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
  });

  it("returns empty array when no source_refs meet threshold", () => {
    createTaskDirect(store, { source_ref: "owner/repo#1", status: "done" });

    const results = store.getHangSuppressedSourceRefs();

    expect(results).toEqual([]);
  });

  it("returns suppressed source_refs", () => {
    for (let i = 0; i < 3; i++) {
      createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    }

    const results = store.getHangSuppressedSourceRefs();

    expect(results).toHaveLength(1);
    expect(results[0].suppressed).toBe(true);
    expect(results[0].stats.source_ref).toBe("owner/repo#1");
    expect(results[0].stats.failed_or_retried_count).toBe(3);
  });

  it("returns multiple suppressed source_refs ordered by failure count", () => {
    for (let i = 0; i < 3; i++) {
      createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
    }
    for (let i = 0; i < 5; i++) {
      createTaskDirect(store, { source_ref: "owner/repo#2", status: "failed" });
    }

    const results = store.getHangSuppressedSourceRefs();

    expect(results).toHaveLength(2);
    // #2 should come first (more failures)
    expect(results[0].stats.source_ref).toBe("owner/repo#2");
    expect(results[1].stats.source_ref).toBe("owner/repo#1");
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 3; i++) {
      createTaskDirect(store, { source_ref: "owner/repo#1", status: "failed" });
      createTaskDirect(store, { source_ref: "owner/repo#2", status: "failed" });
    }

    const results = store.getHangSuppressedSourceRefs(3, 24, 1);

    expect(results).toHaveLength(1);
  });
});
