import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("StateStore", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  describe("createTask", () => {
    it("creates a task with pending status", () => {
      const task = store.createTask({
        title: "Test task",
        source: "manual",
      });
      expect(task.id).toBeTruthy();
      expect(task.title).toBe("Test task");
      expect(task.status).toBe("pending");
      expect(task.source).toBe("manual");
    });

    it("stores optional fields", () => {
      const task = store.createTask({
        title: "Test",
        description: "A longer description",
        source: "github",
        source_ref: "rapartlu/claude-proxy#1",
        agent_name: "claude-proxy",
      });
      expect(task.description).toBe("A longer description");
      expect(task.source_ref).toBe("rapartlu/claude-proxy#1");
      expect(task.agent_name).toBe("claude-proxy");
    });
  });

  describe("getTask", () => {
    it("retrieves a task by ID", () => {
      const created = store.createTask({ title: "Find me", source: "manual" });
      const found = store.getTask(created.id);
      expect(found?.title).toBe("Find me");
    });

    it("returns undefined for unknown ID", () => {
      expect(store.getTask("nonexistent")).toBeUndefined();
    });
  });

  describe("listTasks", () => {
    it("lists all tasks", () => {
      store.createTask({ title: "First", source: "manual" });
      store.createTask({ title: "Second", source: "manual" });
      const tasks = store.listTasks();
      expect(tasks.length).toBe(2);
      expect(tasks.map((t) => t.title).sort()).toEqual(["First", "Second"]);
    });

    it("filters by status", () => {
      const t = store.createTask({ title: "A", source: "manual" });
      store.createTask({ title: "B", source: "manual" });
      store.updateTask(t.id, { status: "done" });
      const done = store.listTasks({ status: "done" });
      expect(done.length).toBe(1);
      expect(done[0].title).toBe("A");
    });

    it("filters by agent_name", () => {
      store.createTask({ title: "A", source: "manual", agent_name: "proxy" });
      store.createTask({ title: "B", source: "manual", agent_name: "blog" });
      const filtered = store.listTasks({ agent_name: "proxy" });
      expect(filtered.length).toBe(1);
      expect(filtered[0].agent_name).toBe("proxy");
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) {
        store.createTask({ title: `Task ${i}`, source: "manual" });
      }
      const limited = store.listTasks({ limit: 2 });
      expect(limited.length).toBe(2);
    });
  });

  describe("updateTask", () => {
    it("updates status", () => {
      const t = store.createTask({ title: "A", source: "manual" });
      const updated = store.updateTask(t.id, { status: "dispatched" });
      expect(updated?.status).toBe("dispatched");
    });

    it("updates multiple fields", () => {
      const t = store.createTask({ title: "A", source: "manual" });
      const updated = store.updateTask(t.id, {
        status: "done",
        agent_name: "proxy",
        result: "All good",
      });
      expect(updated?.status).toBe("done");
      expect(updated?.agent_name).toBe("proxy");
      expect(updated?.result).toBe("All good");
    });
  });

  describe("logs", () => {
    it("adds and retrieves logs", () => {
      const t = store.createTask({ title: "A", source: "manual" });
      store.addLog({ task_id: t.id, direction: "to_agent", agent_name: "proxy", content: "Hello" });
      store.addLog({ task_id: t.id, direction: "from_agent", agent_name: "proxy", content: "Hi back", tokens_in: 10, tokens_out: 20 });
      const logs = store.getLogs(t.id);
      expect(logs.length).toBe(2);
      expect(logs[0].direction).toBe("to_agent");
      expect(logs[1].tokens_out).toBe(20);
    });
  });

  describe("hasActiveTask", () => {
    it("returns false when agent has no tasks", () => {
      expect(store.hasActiveTask("some-agent")).toBe(false);
    });

    it("returns true when agent has a dispatched task", () => {
      const t = store.createTask({ title: "A", source: "manual", agent_name: "some-agent" });
      store.updateTask(t.id, { status: "dispatched" });
      expect(store.hasActiveTask("some-agent")).toBe(true);
    });

    it("returns true when agent has an in_progress task", () => {
      const t = store.createTask({ title: "A", source: "manual", agent_name: "some-agent" });
      store.updateTask(t.id, { status: "in_progress" });
      expect(store.hasActiveTask("some-agent")).toBe(true);
    });

    it("returns false when agent only has done tasks", () => {
      const t = store.createTask({ title: "A", source: "manual", agent_name: "some-agent" });
      store.updateTask(t.id, { status: "done" });
      expect(store.hasActiveTask("some-agent")).toBe(false);
    });

    it("does not count active tasks belonging to other agents", () => {
      const t = store.createTask({ title: "A", source: "manual", agent_name: "other-agent" });
      store.updateTask(t.id, { status: "in_progress" });
      expect(store.hasActiveTask("some-agent")).toBe(false);
    });
  });

  describe("task_type", () => {
    it("defaults to implementation", () => {
      const task = store.createTask({ title: "Build it", source: "manual" });
      expect(task.task_type).toBe("implementation");
    });

    it("creates a research task", () => {
      const task = store.createTask({ title: "Investigate X", source: "manual", task_type: "research" });
      expect(task.task_type).toBe("research");
    });

    it("filters by task_type", () => {
      store.createTask({ title: "Build A", source: "manual", task_type: "implementation" });
      store.createTask({ title: "Research B", source: "manual", task_type: "research" });
      store.createTask({ title: "Build C", source: "manual" });

      const research = store.listTasks({ task_type: "research" });
      expect(research.length).toBe(1);
      expect(research[0].title).toBe("Research B");

      const impl = store.listTasks({ task_type: "implementation" });
      expect(impl.length).toBe(2);
    });
  });

  describe("processed triggers", () => {
    it("tracks processed triggers", () => {
      const t = store.createTask({ title: "A", source: "github" });
      expect(store.isProcessed("github", "repo#1")).toBe(false);
      store.markProcessed("github", "repo#1", t.id);
      expect(store.isProcessed("github", "repo#1")).toBe(true);
    });
  });

  describe("daemon cycle tracking", () => {
    it("records cycle start and returns a numeric id", () => {
      const id = store.recordCycleStart();
      expect(typeof id).toBe("number");
      expect(id).toBeGreaterThan(0);
    });

    it("records cycle end and updates the row", () => {
      const start = new Date();
      const id = store.recordCycleStart();
      // Simulate a short pause
      store.recordCycleEnd(id, start);

      const metrics = store.getMetrics();
      expect(metrics.cycles.total_cycles).toBe(1);
      expect(metrics.cycles.avg_duration_ms).toBeGreaterThanOrEqual(0);
      expect(metrics.cycles.last_cycle_at).toBeTruthy();
    });

    it("accumulates multiple cycles", () => {
      for (let i = 0; i < 3; i++) {
        const start = new Date();
        const id = store.recordCycleStart();
        store.recordCycleEnd(id, start);
      }
      const metrics = store.getMetrics();
      expect(metrics.cycles.total_cycles).toBe(3);
    });
  });

  describe("getRecentVerified", () => {
    it("returns only approved tasks", () => {
      const t1 = store.createTask({ title: "Approved", source: "manual" });
      const t2 = store.createTask({ title: "Rejected", source: "manual" });
      const t3 = store.createTask({ title: "Unverified", source: "manual" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved" });
      store.updateTask(t2.id, { status: "done", verification_status: "rejected", quality_score: 0.3 });
      store.updateTask(t3.id, { status: "done" });

      const results = store.getRecentVerified(20, 0.7);
      expect(results.map((t) => t.id)).toContain(t1.id);
      expect(results.map((t) => t.id)).not.toContain(t2.id);
      expect(results.map((t) => t.id)).not.toContain(t3.id);
    });

    it("includes tasks with quality_score >= minScore even if not explicitly approved", () => {
      const t1 = store.createTask({ title: "High quality", source: "manual" });
      const t2 = store.createTask({ title: "Low quality", source: "manual" });
      store.updateTask(t1.id, { status: "done", quality_score: 0.9 });
      store.updateTask(t2.id, { status: "done", quality_score: 0.5 });

      const results = store.getRecentVerified(20, 0.7);
      expect(results.map((t) => t.id)).toContain(t1.id);
      expect(results.map((t) => t.id)).not.toContain(t2.id);
    });

    it("excludes sub-tasks", () => {
      const parent = store.createTask({ title: "Parent", source: "manual" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "alpha",
      });
      store.updateTask(parent.id, { status: "done", verification_status: "approved" });
      store.updateTask(child.id, { status: "done", verification_status: "approved" });

      const results = store.getRecentVerified(20, 0.7);
      expect(results.map((t) => t.id)).toContain(parent.id);
      expect(results.map((t) => t.id)).not.toContain(child.id);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        const t = store.createTask({ title: `Task ${i}`, source: "manual" });
        store.updateTask(t.id, { status: "done", verification_status: "approved" });
      }
      const results = store.getRecentVerified(3, 0.7);
      expect(results.length).toBe(3);
    });

    it("returns empty array when no qualifying tasks", () => {
      const t = store.createTask({ title: "Bad", source: "manual" });
      store.updateTask(t.id, { status: "done", verification_status: "rejected", quality_score: 0.2 });
      expect(store.getRecentVerified(20, 0.7)).toHaveLength(0);
    });
  });

  describe("getScoreDistribution", () => {
    it("returns all-zero distribution when no verified tasks exist", () => {
      const dist = store.getScoreDistribution();
      expect(dist.excellent).toBe(0);
      expect(dist.good).toBe(0);
      expect(dist.fair).toBe(0);
      expect(dist.poor).toBe(0);
      expect(dist.unscored).toBe(0);
      expect(dist.total).toBe(0);
    });

    it("buckets scores correctly", () => {
      const makeVerified = (score: number | null, status: "approved" | "rejected" = "approved") => {
        const t = store.createTask({ title: `score-${score}`, source: "manual" });
        store.updateTask(t.id, { status: "done", verification_status: status, quality_score: score });
      };

      makeVerified(1.0);   // excellent
      makeVerified(0.95);  // excellent
      makeVerified(0.85);  // good
      makeVerified(0.70);  // good
      makeVerified(0.60);  // fair
      makeVerified(0.45, "rejected"); // poor
      makeVerified(null);  // unscored

      const dist = store.getScoreDistribution();
      expect(dist.excellent).toBe(2);
      expect(dist.good).toBe(2);
      expect(dist.fair).toBe(1);
      expect(dist.poor).toBe(1);
      expect(dist.unscored).toBe(1);
      expect(dist.total).toBe(7);
    });

    it("excludes sub-tasks from distribution", () => {
      const parent = store.createTask({ title: "Parent", source: "manual" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "s1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "alpha",
      });
      store.updateTask(parent.id, { status: "done", verification_status: "approved", quality_score: 0.95 });
      store.updateTask(child.id, { status: "done", verification_status: "approved", quality_score: 0.95 });

      const dist = store.getScoreDistribution();
      expect(dist.total).toBe(1); // only the parent
      expect(dist.excellent).toBe(1);
    });

    it("excludes unverified tasks from distribution", () => {
      const t = store.createTask({ title: "Unverified", source: "manual" });
      store.updateTask(t.id, { status: "done" }); // no verification_status

      const dist = store.getScoreDistribution();
      expect(dist.total).toBe(0);
    });

    it("getMetrics includes score_distribution", () => {
      const t1 = store.createTask({ title: "T1", source: "manual" });
      const t2 = store.createTask({ title: "T2", source: "manual" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved", quality_score: 0.95 });
      store.updateTask(t2.id, { status: "done", verification_status: "rejected", quality_score: 0.40 });

      const m = store.getMetrics();
      expect(m.score_distribution).toBeDefined();
      expect(m.score_distribution.excellent).toBe(1);
      expect(m.score_distribution.poor).toBe(1);
      expect(m.score_distribution.total).toBe(2);
    });
  });

  describe("getMetrics", () => {
    it("returns zeroed metrics when empty", () => {
      const m = store.getMetrics();
      expect(m.total_tasks).toBe(0);
      expect(m.done_tasks).toBe(0);
      expect(m.failed_tasks).toBe(0);
      expect(m.avg_task_duration_ms).toBeNull();
      expect(m.verification_pass_rate).toBeNull();
      expect(m.avg_quality_score).toBeNull();
      expect(m.score_distribution.total).toBe(0);
      expect(m.per_agent).toHaveLength(0);
      expect(m.cycles.total_cycles).toBe(0);
    });

    it("computes global task counts correctly", () => {
      store.createTask({ title: "A", source: "manual" });
      const b = store.createTask({ title: "B", source: "manual", agent_name: "alpha" });
      const c = store.createTask({ title: "C", source: "manual", agent_name: "alpha" });
      store.updateTask(b.id, { status: "done" });
      store.updateTask(c.id, { status: "failed" });

      const m = store.getMetrics();
      expect(m.total_tasks).toBe(3);
      expect(m.done_tasks).toBe(1);
      expect(m.failed_tasks).toBe(1);
    });

    it("excludes sub-tasks from global counts", () => {
      const parent = store.createTask({ title: "Parent", source: "manual" });
      store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "alpha",
      });

      const m = store.getMetrics();
      // only the parent should be counted (no parent_task_id)
      expect(m.total_tasks).toBe(1);
    });

    it("computes per-agent metrics", () => {
      const t1 = store.createTask({ title: "T1", source: "manual", agent_name: "alpha" });
      const t2 = store.createTask({ title: "T2", source: "manual", agent_name: "alpha" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved", quality_score: 0.9 });
      store.updateTask(t2.id, { status: "failed", verification_status: "rejected", quality_score: 0.4 });

      const m = store.getMetrics();
      const alpha = m.per_agent.find((a) => a.agent_name === "alpha");
      expect(alpha).toBeDefined();
      expect(alpha!.total).toBe(2);
      expect(alpha!.done).toBe(1);
      expect(alpha!.failed).toBe(1);
      expect(alpha!.avg_quality_score).toBeCloseTo(0.65, 1);
      // 1 approved / (1 approved + 1 rejected) = 0.5
      expect(alpha!.verification_pass_rate).toBeCloseTo(0.5, 2);
    });

    it("computes verification pass rate correctly", () => {
      const tasks = Array.from({ length: 4 }, (_, i) =>
        store.createTask({ title: `T${i}`, source: "manual", agent_name: "beta" }),
      );
      store.updateTask(tasks[0].id, { status: "done", verification_status: "approved", quality_score: 1.0 });
      store.updateTask(tasks[1].id, { status: "done", verification_status: "approved", quality_score: 0.8 });
      store.updateTask(tasks[2].id, { status: "done", verification_status: "rejected", quality_score: 0.3 });
      store.updateTask(tasks[3].id, { status: "done" }); // unverified — should not count

      const m = store.getMetrics();
      // 2 approved / 3 verified = 0.666…
      expect(m.verification_pass_rate).toBeCloseTo(2 / 3, 2);
    });
  });

  describe("getScoreDistributionByAgent", () => {
    it("returns empty record when no verified tasks exist", () => {
      const result = store.getScoreDistributionByAgent();
      expect(Object.keys(result)).toHaveLength(0);
    });

    it("buckets scores per agent correctly", () => {
      const make = (agent: string, score: number | null, status: "approved" | "rejected" = "approved") => {
        const t = store.createTask({ title: `t-${agent}-${score}`, source: "manual", agent_name: agent });
        store.updateTask(t.id, { status: "done", verification_status: status, quality_score: score });
      };

      // alpha: 1 excellent, 1 good
      make("alpha", 0.95);
      make("alpha", 0.75);
      // beta: 1 fair, 1 poor, 1 unscored
      make("beta", 0.60);
      make("beta", 0.30, "rejected");
      make("beta", null);

      const result = store.getScoreDistributionByAgent();

      expect(result["alpha"]).toBeDefined();
      expect(result["alpha"].excellent).toBe(1);
      expect(result["alpha"].good).toBe(1);
      expect(result["alpha"].fair).toBe(0);
      expect(result["alpha"].poor).toBe(0);
      expect(result["alpha"].unscored).toBe(0);
      expect(result["alpha"].total).toBe(2);

      expect(result["beta"]).toBeDefined();
      expect(result["beta"].excellent).toBe(0);
      expect(result["beta"].good).toBe(0);
      expect(result["beta"].fair).toBe(1);
      expect(result["beta"].poor).toBe(1);
      expect(result["beta"].unscored).toBe(1);
      expect(result["beta"].total).toBe(3);
    });

    it("excludes sub-tasks from per-agent distribution", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "alpha" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "s1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "alpha",
      });
      store.updateTask(parent.id, { status: "done", verification_status: "approved", quality_score: 0.92 });
      store.updateTask(child.id, { status: "done", verification_status: "approved", quality_score: 0.92 });

      const result = store.getScoreDistributionByAgent();
      expect(result["alpha"].total).toBe(1); // only parent
      expect(result["alpha"].excellent).toBe(1);
    });

    it("excludes agents with no verified tasks from result", () => {
      // task exists but no verification_status
      const t = store.createTask({ title: "No verify", source: "manual", agent_name: "gamma" });
      store.updateTask(t.id, { status: "done" });

      const result = store.getScoreDistributionByAgent();
      expect(result["gamma"]).toBeUndefined();
    });

    it("getMetrics includes per_agent_score_distribution", () => {
      const t1 = store.createTask({ title: "T1", source: "manual", agent_name: "alpha" });
      const t2 = store.createTask({ title: "T2", source: "manual", agent_name: "beta" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved", quality_score: 0.95 });
      store.updateTask(t2.id, { status: "done", verification_status: "rejected", quality_score: 0.40 });

      const m = store.getMetrics();
      expect(m.per_agent_score_distribution).toBeDefined();
      expect(m.per_agent_score_distribution["alpha"].excellent).toBe(1);
      expect(m.per_agent_score_distribution["beta"].poor).toBe(1);
    });
  });
});
