/**
 * Tests for score coverage enforcement (issue #250).
 *
 * Acceptance criteria:
 *   1. Zero null quality_score rows for tasks in 'done' status older than 5 minutes
 *   2. Short-circuit exits like 'already-in-review' record a canonical score of 1.0
 *      with dimension label 'no_action_needed'
 *   3. Dashboard shows a 'score coverage %' metric in the quality panel
 *
 * This test file covers:
 *   - recordShortCircuitScore() canonical scoring
 *   - ensureScoresPopulated() Phase 3 backfill of stale null-score done tasks
 *   - getScoreCoverageMetric() and getDoneTasksWithNullScores() store methods
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

/**
 * Insert a 'done' task with null quality_score and null verification_status,
 * backdated by `minutesAgo` minutes to simulate stale tasks.
 */
function insertStaleDoneTask(
  store: StateStore,
  taskId: string,
  minutesAgo: number,
  agentName = "agent-a",
): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, 'done', NULL, NULL, ?, 'implementation',
               'Task output', datetime('now', ? || ' minutes'), datetime('now', ? || ' minutes'))`,
    )
    .run(taskId, `Task ${taskId}`, agentName, `-${minutesAgo}`, `-${minutesAgo}`);
}

/**
 * Insert a 'done' task that already has a quality score.
 */
function insertScoredTask(
  store: StateStore,
  taskId: string,
  score: number,
  agentName = "agent-a",
): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, status, verification_status, quality_score,
          agent_name, task_type, result, created_at, updated_at)
       VALUES (?, ?, 'done', 'approved', ?, ?, 'implementation',
               'Task output', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
    )
    .run(taskId, `Task ${taskId}`, score, agentName);
}

// ── recordShortCircuitScore ─────────────────────────────────────────────────

describe("Verifier.recordShortCircuitScore (issue #250)", () => {
  let store: StateStore;
  let verifier: Verifier;

  beforeEach(() => {
    store = new StateStore(`:memory:`);
    verifier = new Verifier(store);
  });

  it("records a canonical 1.0 score with 'no_action_needed' dimension", () => {
    insertStaleDoneTask(store, "task-short-1", 10);

    const result = verifier.recordShortCircuitScore(
      "task-short-1",
      "no_action_needed",
      "Issue #42 already has open PR #43",
    );

    expect(result.approved).toBe(true);
    expect(result.score).toBe(1.0);
    expect(result.notes).toContain("no_action_needed");
    expect(result.notes).toContain("Issue #42 already has open PR #43");
    expect(result.approvalRationale).toBe("short_circuit_no_action_needed");
    expect(result.dimensions).toEqual({
      correctness: 1.0,
      completeness: 1.0,
      test_coverage: 1.0,
      code_quality: 1.0,
    });

    // Verify DB was updated
    const task = store.getTask("task-short-1");
    expect(task?.quality_score).toBe(1.0);
    expect(task?.verification_status).toBe("approved");
    expect(task?.verification_notes).toContain("no_action_needed");
  });

  it("records pre_dispatch_blocked dimension for guard exits", () => {
    insertStaleDoneTask(store, "task-guard-1", 10);

    const result = verifier.recordShortCircuitScore(
      "task-guard-1",
      "pre_dispatch_blocked",
      "Issue #99 was closed before dispatch",
    );

    expect(result.score).toBe(1.0);
    expect(result.approvalRationale).toBe("short_circuit_pre_dispatch_blocked");
    expect(result.notes).toContain("pre_dispatch_blocked");
  });

  it("records orchestrator_routed dimension", () => {
    insertStaleDoneTask(store, "task-routed-1", 10);

    const result = verifier.recordShortCircuitScore(
      "task-routed-1",
      "orchestrator_routed",
      "Conflict recovery re-dispatch handled by orchestrator",
    );

    expect(result.score).toBe(1.0);
    expect(result.approvalRationale).toBe("short_circuit_orchestrator_routed");
  });

  it("throws for non-existent task", () => {
    expect(() =>
      verifier.recordShortCircuitScore("nonexistent", "no_action_needed", "test"),
    ).toThrow("Task not found");
  });
});

// ── getDoneTasksWithNullScores ──────────────────────────────────────────────

describe("StateStore.getDoneTasksWithNullScores (issue #250)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(`:memory:`);
  });

  it("returns done tasks older than 5 minutes with null scores", () => {
    insertStaleDoneTask(store, "stale-1", 10);
    insertStaleDoneTask(store, "stale-2", 6);
    // This one is too recent (only 2 minutes old)
    insertStaleDoneTask(store, "fresh-1", 2);
    // This one already has a score
    insertScoredTask(store, "scored-1", 0.9);

    const result = store.getDoneTasksWithNullScores(5, 50);

    expect(result).toHaveLength(2);
    const ids = result.map((t) => t.id);
    expect(ids).toContain("stale-1");
    expect(ids).toContain("stale-2");
    expect(ids).not.toContain("fresh-1");
    expect(ids).not.toContain("scored-1");
  });

  it("respects custom grace period", () => {
    insertStaleDoneTask(store, "task-8min", 8);
    insertStaleDoneTask(store, "task-3min", 3);

    // With 10-minute grace, neither should appear
    expect(store.getDoneTasksWithNullScores(10, 50)).toHaveLength(0);

    // With 2-minute grace, both should appear
    expect(store.getDoneTasksWithNullScores(2, 50)).toHaveLength(2);
  });

  it("respects limit parameter", () => {
    insertStaleDoneTask(store, "a-1", 10);
    insertStaleDoneTask(store, "a-2", 11);
    insertStaleDoneTask(store, "a-3", 12);

    const result = store.getDoneTasksWithNullScores(5, 2);
    expect(result).toHaveLength(2);
  });

  it("excludes tasks with verification_status set", () => {
    // Insert a done task with verification_status already set but no score
    const raw = store as unknown as RawDB;
    raw.db
      .prepare(
        `INSERT INTO tasks
           (id, title, status, verification_status, quality_score,
            agent_name, task_type, result, created_at, updated_at)
         VALUES ('verified-1', 'Verified task', 'done', 'approved', NULL, 'agent-a',
                 'implementation', 'output', datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
      )
      .run();

    // Should not appear — verification_status is not null (handled by Phase 1)
    const result = store.getDoneTasksWithNullScores(5, 50);
    expect(result).toHaveLength(0);
  });
});

// ── getScoreCoverageMetric ──────────────────────────────────────────────────

describe("StateStore.getScoreCoverageMetric (issue #250)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(`:memory:`);
  });

  it("returns 100% coverage when all done tasks are scored", () => {
    insertScoredTask(store, "scored-1", 0.85, "agent-a");
    insertScoredTask(store, "scored-2", 0.90, "agent-b");

    const metric = store.getScoreCoverageMetric(5);

    expect(metric.total_done_tasks).toBe(2);
    expect(metric.scored_tasks).toBe(2);
    expect(metric.unscored_tasks).toBe(0);
    expect(metric.coverage_pct).toBe(1.0);
  });

  it("shows partial coverage when some tasks are unscored", () => {
    insertScoredTask(store, "scored-1", 0.85, "agent-a");
    insertStaleDoneTask(store, "unscored-1", 10, "agent-a");
    insertStaleDoneTask(store, "unscored-2", 10, "agent-b");

    const metric = store.getScoreCoverageMetric(5);

    expect(metric.total_done_tasks).toBe(3);
    expect(metric.scored_tasks).toBe(1);
    expect(metric.unscored_tasks).toBe(2);
    expect(metric.coverage_pct).toBeCloseTo(1 / 3, 5);
  });

  it("provides per-agent breakdown", () => {
    insertScoredTask(store, "s1", 0.85, "agent-a");
    insertScoredTask(store, "s2", 0.90, "agent-a");
    insertStaleDoneTask(store, "u1", 10, "agent-b");

    const metric = store.getScoreCoverageMetric(5);

    const agentA = metric.per_agent.find((a) => a.agent_name === "agent-a");
    const agentB = metric.per_agent.find((a) => a.agent_name === "agent-b");

    expect(agentA?.total).toBe(2);
    expect(agentA?.scored).toBe(2);
    expect(agentA?.coverage_pct).toBe(1.0);

    expect(agentB?.total).toBe(1);
    expect(agentB?.scored).toBe(0);
    expect(agentB?.coverage_pct).toBe(0.0);
  });

  it("excludes tasks newer than grace period", () => {
    insertStaleDoneTask(store, "fresh-1", 2, "agent-a"); // 2 min old

    const metric = store.getScoreCoverageMetric(5);
    expect(metric.total_done_tasks).toBe(0);
    expect(metric.coverage_pct).toBeNull();
  });

  it("returns null coverage_pct when no tasks exist", () => {
    const metric = store.getScoreCoverageMetric(5);
    expect(metric.total_done_tasks).toBe(0);
    expect(metric.coverage_pct).toBeNull();
    expect(metric.per_agent).toHaveLength(0);
  });
});

// ── ensureScoresPopulated Phase 3 ───────────────────────────────────────────

describe("ensureScoresPopulated Phase 3 — stale null-score backfill (issue #250)", () => {
  let store: StateStore;
  let verifier: Verifier;

  beforeEach(() => {
    store = new StateStore(`:memory:`);
    verifier = new Verifier(store);
  });

  it("scores stale done tasks with null quality_score via Phase 3", async () => {
    // Insert a task that's 10 minutes old with no score or verification_status
    insertStaleDoneTask(store, "stale-unscored", 10);

    const scored = await verifier.ensureScoresPopulated(10);

    // Phase 3 should have picked it up
    expect(scored).toBeGreaterThanOrEqual(1);

    const task = store.getTask("stale-unscored");
    expect(task?.quality_score).toBe(1.0);
    expect(task?.verification_status).toBe("approved");
    expect(task?.verification_notes).toContain("no_action_needed");
  });

  it("does not score tasks newer than 5 minutes", async () => {
    insertStaleDoneTask(store, "fresh-task", 2);

    const scored = await verifier.ensureScoresPopulated(10);

    // Phase 3 should not pick up fresh tasks
    const task = store.getTask("fresh-task");
    expect(task?.quality_score).toBeNull();
  });

  it("achieves 100% score coverage after running all phases", async () => {
    insertScoredTask(store, "already-scored", 0.85);
    insertStaleDoneTask(store, "stale-1", 15);
    insertStaleDoneTask(store, "stale-2", 20);

    await verifier.ensureScoresPopulated(50);

    const metric = store.getScoreCoverageMetric(5);
    expect(metric.coverage_pct).toBe(1.0);
    expect(metric.unscored_tasks).toBe(0);
  });
});
