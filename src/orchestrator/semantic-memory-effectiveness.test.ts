import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Tests for the semantic memory effectiveness dashboard (issue #1016).
 *
 * Uses a real SQLite database via StateStore to exercise the actual SQL
 * queries for classifying tasks as memory-assisted vs unmatched.
 */

let store: StateStore;
let dbPath: string;

function makeDbPath(): string {
  const dir = join(tmpdir(), "orch-test-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.sqlite");
}

beforeEach(() => {
  dbPath = makeDbPath();
  store = new StateStore(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
  } catch {
    // cleanup best-effort
  }
});

/**
 * Create a task using the real store.createTask (which generates a valid ULID),
 * then update it to the desired state.
 */
function createTestTask(
  overrides: {
    status?: string;
    verification_status?: string | null;
    quality_score?: number | null;
    revision_count?: number;
    created_at?: string;
    title?: string;
    withMemoryMatch?: boolean;
  } = {},
): string {
  const task = store.createTask({
    title: overrides.title ?? "Test task",
    description: "Test description",
    source: "github",
    source_ref: `owner/repo#${Math.floor(Math.random() * 10000)}`,
    task_type: "implementation",
  });

  const updates: Record<string, unknown> = {};
  if (overrides.status) updates.status = overrides.status;
  if (overrides.verification_status !== undefined) updates.verification_status = overrides.verification_status;
  if (overrides.quality_score !== undefined) updates.quality_score = overrides.quality_score;
  if (overrides.revision_count !== undefined) updates.revision_count = overrides.revision_count;
  if (overrides.created_at) updates.created_at = overrides.created_at;

  if (Object.keys(updates).length > 0) {
    store.updateTask(task.id, updates as any);
  }

  if (overrides.withMemoryMatch) {
    store.addLog({
      task_id: task.id,
      direction: "system",
      agent_name: "test-agent",
      content: `[semantic-memory] Attached 2 past success(es): task1(0.90), task2(0.85)`,
    });
  }

  return task.id;
}

describe("getSemanticMemoryEffectiveness", () => {
  it("returns empty stats when no tasks exist", () => {
    const result = store.getSemanticMemoryEffectiveness();
    expect(result.total_dispatches).toBe(0);
    expect(result.memory_hit_count).toBe(0);
    expect(result.memory_hit_rate).toBeNull();
    expect(result.matched.total_tasks).toBe(0);
    expect(result.unmatched.total_tasks).toBe(0);
    expect(result.improvement_delta).toBeNull();
    expect(result.meets_target).toBeNull();
  });

  it("classifies tasks with [semantic-memory] logs as memory-assisted", () => {
    // Memory-assisted tasks
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.9, revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.85, revision_count: 0, withMemoryMatch: true });

    // Unmatched tasks
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.7, revision_count: 1 });
    createTestTask({ status: "failed" });

    const result = store.getSemanticMemoryEffectiveness();
    expect(result.matched.total_tasks).toBe(2);
    expect(result.unmatched.total_tasks).toBe(2);
  });

  it("computes first-pass approval rate correctly", () => {
    // Memory-assisted: 2 first-pass approved, 1 needed revision
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.9, revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.85, revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.7, revision_count: 1, withMemoryMatch: true });

    // Unmatched: 1 first-pass approved, 2 needed revision
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.8, revision_count: 0 });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.6, revision_count: 1 });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.65, revision_count: 2 });

    const result = store.getSemanticMemoryEffectiveness();

    // Matched: 2/3 first-pass approved = 66.7%
    expect(result.matched.first_pass_rate).toBeCloseTo(2 / 3, 2);
    expect(result.matched.first_pass_approved).toBe(2);

    // Unmatched: 1/3 first-pass approved = 33.3%
    expect(result.unmatched.first_pass_rate).toBeCloseTo(1 / 3, 2);
    expect(result.unmatched.first_pass_approved).toBe(1);

    // Improvement delta: 66.7% - 33.3% = 33.3%
    expect(result.improvement_delta).toBeCloseTo(1 / 3, 2);
    expect(result.meets_target).toBe(true); // > 15%
  });

  it("computes average quality score correctly", () => {
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.9, revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", quality_score: 0.8, revision_count: 0, withMemoryMatch: true });

    const result = store.getSemanticMemoryEffectiveness();
    expect(result.matched.avg_quality_score).toBeCloseTo(0.85, 2);
  });

  it("computes revision distribution correctly", () => {
    createTestTask({ status: "done", verification_status: "approved", revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", revision_count: 1, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", revision_count: 3, withMemoryMatch: true });

    const result = store.getSemanticMemoryEffectiveness();
    expect(result.matched.revision_distribution).toEqual({ zero: 1, one: 1, two_plus: 1 });
  });

  it("computes memory hit rate correctly", () => {
    // 3 dispatched tasks, 2 with memory hits
    createTestTask({ status: "done", withMemoryMatch: true });
    createTestTask({ status: "done", withMemoryMatch: true });
    createTestTask({ status: "done" });

    const result = store.getSemanticMemoryEffectiveness();
    expect(result.total_dispatches).toBe(3);
    expect(result.memory_hit_count).toBe(2);
    expect(result.memory_hit_rate).toBeCloseTo(2 / 3, 2);
  });

  it("marks target as not met when improvement is below 15%", () => {
    // Both cohorts have same first-pass rate
    createTestTask({ status: "done", verification_status: "approved", revision_count: 0, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "rejected", revision_count: 1, withMemoryMatch: true });

    createTestTask({ status: "done", verification_status: "approved", revision_count: 0 });
    createTestTask({ status: "done", verification_status: "rejected", revision_count: 1 });

    const result = store.getSemanticMemoryEffectiveness();
    // Both cohorts: 50% FPR → delta = 0%
    expect(result.improvement_delta).toBeCloseTo(0, 2);
    expect(result.meets_target).toBe(false);
  });

  it("respects the time window filter", () => {
    // Old task (outside window)
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    createTestTask({ status: "done", verification_status: "approved", created_at: oldDate, withMemoryMatch: true });

    // Recent task (inside window)
    createTestTask({ status: "done", verification_status: "approved" });

    const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const result = store.getSemanticMemoryEffectiveness(recentCutoff);

    // Only the recent task should be counted
    expect(result.matched.total_tasks).toBe(0);
    expect(result.unmatched.total_tasks).toBe(1);
  });

  it("excludes pending/planning tasks from terminal-task cohorts", () => {
    createTestTask({ status: "pending" });
    createTestTask({ status: "planning" });
    createTestTask({ status: "done" });

    const result = store.getSemanticMemoryEffectiveness();
    // pending/planning tasks are excluded from matched/unmatched cohorts
    // (they're terminal-state only: done/failed/escalated)
    expect(result.matched.total_tasks + result.unmatched.total_tasks).toBe(1);
  });

  it("returns weekly cohorts sorted chronologically", () => {
    // Create tasks across 2 different weeks
    const week1 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const week2 = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    createTestTask({ status: "done", verification_status: "approved", revision_count: 0, created_at: week1, withMemoryMatch: true });
    createTestTask({ status: "done", verification_status: "approved", revision_count: 0, created_at: week2, withMemoryMatch: true });

    const result = store.getSemanticMemoryEffectiveness();
    expect(result.weekly.length).toBeGreaterThanOrEqual(1);
    // Check chronological order
    for (let i = 1; i < result.weekly.length; i++) {
      expect(result.weekly[i].week_start >= result.weekly[i - 1].week_start).toBe(true);
    }
  });

  it("returns generated_at timestamp", () => {
    const result = store.getSemanticMemoryEffectiveness();
    expect(result.generated_at).toBeTruthy();
    expect(new Date(result.generated_at).getTime()).toBeGreaterThan(0);
  });
});
