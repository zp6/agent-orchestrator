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

  describe("countUnverified and getUnverified", () => {
    it("countUnverified returns 0 when no done tasks exist", () => {
      expect(store.countUnverified()).toBe(0);
    });

    it("countUnverified counts done top-level tasks with no verification_status", () => {
      const t1 = store.createTask({ title: "Done unverified 1", source: "manual" });
      const t2 = store.createTask({ title: "Done unverified 2", source: "manual" });
      const t3 = store.createTask({ title: "Done approved", source: "manual" });
      store.updateTask(t1.id, { status: "done" });
      store.updateTask(t2.id, { status: "done" });
      store.updateTask(t3.id, { status: "done", verification_status: "approved" });

      expect(store.countUnverified()).toBe(2);
    });

    it("countUnverified excludes in_progress and failed tasks", () => {
      const t1 = store.createTask({ title: "In progress", source: "manual" });
      const t2 = store.createTask({ title: "Failed", source: "manual" });
      store.updateTask(t1.id, { status: "in_progress" });
      store.updateTask(t2.id, { status: "failed" });

      expect(store.countUnverified()).toBe(0);
    });

    it("countUnverified excludes sub-tasks", () => {
      const parent = store.createTask({ title: "Parent", source: "manual" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "agent-a",
      });
      store.updateTask(parent.id, { status: "done" });
      store.updateTask(child.id, { status: "done" });

      // Only the parent should count — child is a sub-task
      expect(store.countUnverified()).toBe(1);
    });

    it("getUnverified returns done tasks with no verification in descending order", () => {
      const t1 = store.createTask({ title: "First", source: "manual" });
      const t2 = store.createTask({ title: "Second", source: "manual" });
      const t3 = store.createTask({ title: "Approved", source: "manual" });
      store.updateTask(t1.id, { status: "done" });
      store.updateTask(t2.id, { status: "done" });
      store.updateTask(t3.id, { status: "done", verification_status: "approved" });

      const results = store.getUnverified(10);
      expect(results.map((t) => t.id)).toContain(t1.id);
      expect(results.map((t) => t.id)).toContain(t2.id);
      expect(results.map((t) => t.id)).not.toContain(t3.id);
    });

    it("getUnverified respects the limit", () => {
      for (let i = 0; i < 5; i++) {
        const t = store.createTask({ title: `Task ${i}`, source: "manual" });
        store.updateTask(t.id, { status: "done" });
      }
      expect(store.getUnverified(3)).toHaveLength(3);
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

  describe("getAgentScoreTrend", () => {
    /** Helper: create a verified task for `agentName` with `score` */
    const makeScored = (agentName: string, score: number) => {
      const t = store.createTask({ title: `t-${agentName}-${score}`, source: "manual", agent_name: agentName });
      store.updateTask(t.id, { status: "done", verification_status: "approved", quality_score: score });
    };

    it("returns insufficient_data when agent has no scored tasks", () => {
      const trend = store.getAgentScoreTrend("nobody", 10);
      expect(trend.direction).toBe("insufficient_data");
      expect(trend.scored_count).toBe(0);
      expect(trend.recent_avg).toBeNull();
      expect(trend.prior_avg).toBeNull();
      expect(trend.delta).toBeNull();
    });

    it("returns insufficient_data when agent has fewer than windowSize scored tasks", () => {
      for (let i = 0; i < 5; i++) makeScored("alpha", 0.8);
      const trend = store.getAgentScoreTrend("alpha", 10);
      expect(trend.direction).toBe("insufficient_data");
      expect(trend.scored_count).toBe(5);
    });

    it("returns stable when recent and prior averages are within ±0.05", () => {
      // Create 20 tasks: first 10 (prior) avg 0.80, last 10 (recent) avg 0.82 → delta = +0.02 → stable
      for (let i = 0; i < 10; i++) makeScored("alpha", 0.80);
      for (let i = 0; i < 10; i++) makeScored("alpha", 0.82);
      const trend = store.getAgentScoreTrend("alpha", 10);
      expect(trend.direction).toBe("stable");
      expect(trend.delta).not.toBeNull();
      expect(Math.abs(trend.delta!)).toBeLessThanOrEqual(0.05);
    });

    it("returns improving when recent avg is more than 0.05 higher than prior avg", () => {
      // prior window: avg 0.40, recent window: avg 0.90 → large positive delta
      for (let i = 0; i < 10; i++) makeScored("beta", 0.40);
      for (let i = 0; i < 10; i++) makeScored("beta", 0.90);
      const trend = store.getAgentScoreTrend("beta", 10);
      expect(trend.direction).toBe("improving");
      expect(trend.delta).toBeGreaterThan(0.05);
      // recent avg should be much higher than prior avg
      expect(trend.recent_avg!).toBeGreaterThan(trend.prior_avg!);
    });

    it("returns declining when recent avg is more than 0.05 lower than prior avg", () => {
      // prior window: avg 0.90, recent window: avg 0.40 → large negative delta
      for (let i = 0; i < 10; i++) makeScored("gamma", 0.90);
      for (let i = 0; i < 10; i++) makeScored("gamma", 0.40);
      const trend = store.getAgentScoreTrend("gamma", 10);
      expect(trend.direction).toBe("declining");
      expect(trend.delta).toBeLessThan(-0.05);
      // recent avg should be much lower than prior avg
      expect(trend.recent_avg!).toBeLessThan(trend.prior_avg!);
    });

    it("ignores sub-tasks and unscored tasks", () => {
      // Add unverified and sub-tasks — these should not count toward the window
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "delta" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "s1",
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "delta",
      });
      store.updateTask(parent.id, { status: "done", verification_status: "approved", quality_score: 0.90 });
      store.updateTask(child.id, { status: "done", verification_status: "approved", quality_score: 0.90 });
      // Add an unverified task
      const unverified = store.createTask({ title: "Unverified", source: "manual", agent_name: "delta" });
      store.updateTask(unverified.id, { status: "done" });

      // Only 1 top-level scored task → insufficient_data with windowSize=10
      const trend = store.getAgentScoreTrend("delta", 10);
      expect(trend.direction).toBe("insufficient_data");
      expect(trend.scored_count).toBe(1);
    });

    it("reports window_size correctly", () => {
      for (let i = 0; i < 10; i++) makeScored("epsilon", 0.80);
      const trend = store.getAgentScoreTrend("epsilon", 5);
      expect(trend.window_size).toBe(5);
      // 10 scored tasks with windowSize=5 → should have both windows
      expect(trend.direction).not.toBe("insufficient_data");
    });

    it("getMetrics includes per_agent_score_trends", () => {
      // Create 20 tasks for "trendy": prior 10 avg 0.60, recent 10 avg 0.90 → improving
      for (let i = 0; i < 10; i++) makeScored("trendy", 0.60);
      for (let i = 0; i < 10; i++) makeScored("trendy", 0.90);

      const m = store.getMetrics();
      expect(m.per_agent_score_trends).toBeDefined();
      expect(m.per_agent_score_trends["trendy"]).toBeDefined();
      expect(m.per_agent_score_trends["trendy"].direction).toBe("improving");
    });
  });

  describe("getDailyTrend", () => {
    it("returns empty arrays when no tasks or cycles exist", () => {
      const trend = store.getDailyTrend(7);
      expect(trend.days).toBe(7);
      expect(trend.task_days).toEqual([]);
      expect(trend.cycle_days).toEqual([]);
      expect(trend.throughput_delta).toBeNull();
      expect(trend.pass_rate_delta).toBeNull();
      expect(trend.score_delta).toBeNull();
      expect(trend.cycle_duration_delta).toBeNull();
    });

    it("reflects today's completed tasks in the trend window", () => {
      // Create and complete 3 top-level tasks today
      for (let i = 0; i < 3; i++) {
        const t = store.createTask({ title: `Trend task ${i}`, source: "manual" });
        store.updateTask(t.id, {
          status: "done",
          verification_status: "approved",
          quality_score: 0.8,
        });
      }

      const trend = store.getDailyTrend(7);
      // Should have at least one day entry (today)
      expect(trend.task_days.length).toBeGreaterThanOrEqual(1);
      const total = trend.task_days.reduce((s, d) => s + d.tasks_completed, 0);
      expect(total).toBe(3);
    });

    it("counts failed tasks separately from completed", () => {
      const done = store.createTask({ title: "Done task", source: "manual" });
      store.updateTask(done.id, { status: "done" });

      const failed = store.createTask({ title: "Failed task", source: "manual" });
      store.updateTask(failed.id, { status: "failed" });

      const trend = store.getDailyTrend(7);
      const totalDone = trend.task_days.reduce((s, d) => s + d.tasks_completed, 0);
      const totalFailed = trend.task_days.reduce((s, d) => s + d.tasks_failed, 0);
      expect(totalDone).toBe(1);
      expect(totalFailed).toBe(1);
    });

    it("excludes sub-tasks from trend counts", () => {
      const parent = store.createTask({ title: "Parent", source: "manual" });
      store.updateTask(parent.id, { status: "done" });

      // Sub-task should not appear in trend
      const sub = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Sub",
        description: "sub desc",
        source: "manual",
        agent_name: "agent",
      });
      store.updateTask(sub.id, { status: "done" });

      const trend = store.getDailyTrend(7);
      const totalDone = trend.task_days.reduce((s, d) => s + d.tasks_completed, 0);
      // Only the parent should count
      expect(totalDone).toBe(1);
    });

    it("computes avg_quality_score for verified tasks", () => {
      const scores = [0.9, 0.8, 0.7];
      for (const score of scores) {
        const t = store.createTask({ title: `T-${score}`, source: "manual" });
        store.updateTask(t.id, {
          status: "done",
          verification_status: "approved",
          quality_score: score,
        });
      }

      const trend = store.getDailyTrend(7);
      const todayEntry = trend.task_days[trend.task_days.length - 1];
      expect(todayEntry).toBeDefined();
      expect(todayEntry.avg_quality_score).toBeCloseTo(0.8, 2);
    });

    it("computes verification_pass_rate for verified tasks", () => {
      // 2 approved, 1 rejected
      const t1 = store.createTask({ title: "T1", source: "manual" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved", quality_score: 0.9 });

      const t2 = store.createTask({ title: "T2", source: "manual" });
      store.updateTask(t2.id, { status: "done", verification_status: "approved", quality_score: 0.8 });

      const t3 = store.createTask({ title: "T3", source: "manual" });
      store.updateTask(t3.id, { status: "done", verification_status: "rejected", quality_score: 0.3 });

      const trend = store.getDailyTrend(7);
      const todayEntry = trend.task_days[trend.task_days.length - 1];
      expect(todayEntry).toBeDefined();
      // 2/3 approved
      expect(todayEntry.verification_pass_rate).toBeCloseTo(2 / 3, 2);
    });

    it("reflects today's daemon cycles in cycle_days", () => {
      const cycleId = store.recordCycleStart();
      const start = new Date();
      // Simulate a 200ms cycle
      store.recordCycleEnd(cycleId, new Date(start.getTime() - 200));

      const trend = store.getDailyTrend(7);
      const totalCycles = trend.cycle_days.reduce((s, d) => s + d.cycle_count, 0);
      expect(totalCycles).toBeGreaterThanOrEqual(1);
    });

    it("respects the days parameter — 1-day window only includes today", () => {
      const t = store.createTask({ title: "Today", source: "manual" });
      store.updateTask(t.id, { status: "done" });

      const trend1 = store.getDailyTrend(1);
      expect(trend1.days).toBe(1);
      // Should still find today's task
      const total = trend1.task_days.reduce((s, d) => s + d.tasks_completed, 0);
      expect(total).toBe(1);
    });

    it("throughput_delta is null when no prior-period data exists", () => {
      // All tasks are today → prior period is empty → delta is null
      const t = store.createTask({ title: "T", source: "manual" });
      store.updateTask(t.id, { status: "done" });

      const trend = store.getDailyTrend(7);
      // Prior 7 days before today will have no data in a fresh DB
      expect(trend.throughput_delta).toBeNull();
    });
  });

  describe("hasActivePrFeedbackTask", () => {
    it("returns false when no pr-feedback task exists for that PR", () => {
      expect(store.hasActivePrFeedbackTask("owner/repo", 42)).toBe(false);
    });

    it("returns true when a pending pr-feedback task exists", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#42",
        source: "pr-feedback",
        source_ref: "owner/repo#42",
        agent_name: "my-agent",
      });
      expect(store.hasActivePrFeedbackTask("owner/repo", 42)).toBe(true);
    });

    it("returns true when a dispatched pr-feedback task exists", () => {
      const task = store.createTask({
        title: "[PR feedback] owner/repo#7",
        source: "pr-feedback",
        source_ref: "owner/repo#7",
        agent_name: "my-agent",
      });
      store.updateTask(task.id, { status: "dispatched" });
      expect(store.hasActivePrFeedbackTask("owner/repo", 7)).toBe(true);
    });

    it("returns true when an in_progress pr-feedback task exists", () => {
      const task = store.createTask({
        title: "[PR feedback] owner/repo#9",
        source: "pr-feedback",
        source_ref: "owner/repo#9",
        agent_name: "my-agent",
      });
      store.updateTask(task.id, { status: "in_progress" });
      expect(store.hasActivePrFeedbackTask("owner/repo", 9)).toBe(true);
    });

    it("returns false when the pr-feedback task is done", () => {
      const task = store.createTask({
        title: "[PR feedback] owner/repo#10",
        source: "pr-feedback",
        source_ref: "owner/repo#10",
        agent_name: "my-agent",
      });
      store.updateTask(task.id, { status: "done" });
      expect(store.hasActivePrFeedbackTask("owner/repo", 10)).toBe(false);
    });

    it("returns false when the pr-feedback task is failed", () => {
      const task = store.createTask({
        title: "[PR feedback] owner/repo#11",
        source: "pr-feedback",
        source_ref: "owner/repo#11",
        agent_name: "my-agent",
      });
      store.updateTask(task.id, { status: "failed" });
      expect(store.hasActivePrFeedbackTask("owner/repo", 11)).toBe(false);
    });

    it("does not match a different PR number on the same repo", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#42",
        source: "pr-feedback",
        source_ref: "owner/repo#42",
        agent_name: "my-agent",
      });
      expect(store.hasActivePrFeedbackTask("owner/repo", 43)).toBe(false);
    });

    it("does not match a different repo with the same PR number", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#5",
        source: "pr-feedback",
        source_ref: "owner/repo#5",
        agent_name: "my-agent",
      });
      expect(store.hasActivePrFeedbackTask("owner/other-repo", 5)).toBe(false);
    });

    it("accepts prNumber as a string", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#20",
        source: "pr-feedback",
        source_ref: "owner/repo#20",
        agent_name: "my-agent",
      });
      expect(store.hasActivePrFeedbackTask("owner/repo", "20")).toBe(true);
    });
  });

  describe("getPrFeedbackHistory", () => {
    it("returns empty array when no pr-feedback tasks exist for source_ref", () => {
      const history = store.getPrFeedbackHistory("owner/repo#99");
      expect(history).toEqual([]);
    });

    it("returns all pr-feedback tasks for a given source_ref in chronological order", () => {
      // Create two feedback tasks for the same PR
      const t1 = store.createTask({
        title: "[PR feedback] owner/repo#7 cycle 1",
        source: "pr-feedback",
        source_ref: "owner/repo#7",
        agent_name: "my-agent",
      });
      const t2 = store.createTask({
        title: "[PR feedback] owner/repo#7 cycle 2",
        source: "pr-feedback",
        source_ref: "owner/repo#7",
        agent_name: "my-agent",
      });

      const history = store.getPrFeedbackHistory("owner/repo#7");
      expect(history.length).toBe(2);
      // Chronological (oldest first)
      expect(history[0].id).toBe(t1.id);
      expect(history[1].id).toBe(t2.id);
    });

    it("does not include tasks with a different source_ref", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#8",
        source: "pr-feedback",
        source_ref: "owner/repo#8",
        agent_name: "my-agent",
      });
      store.createTask({
        title: "[PR feedback] owner/repo#9",
        source: "pr-feedback",
        source_ref: "owner/repo#9",
        agent_name: "my-agent",
      });

      const history = store.getPrFeedbackHistory("owner/repo#8");
      expect(history.length).toBe(1);
      expect(history[0].source_ref).toBe("owner/repo#8");
    });

    it("does not include non-pr-feedback tasks with a matching source_ref", () => {
      store.createTask({
        title: "github task",
        source: "github",
        source_ref: "owner/repo#10",
        agent_name: "my-agent",
      });

      const history = store.getPrFeedbackHistory("owner/repo#10");
      expect(history).toEqual([]);
    });

    it("includes tasks in all statuses (pending, done, failed)", () => {
      const t1 = store.createTask({
        title: "[PR feedback] owner/repo#11 cycle 1",
        source: "pr-feedback",
        source_ref: "owner/repo#11",
        agent_name: "my-agent",
      });
      store.updateTask(t1.id, { status: "done" });
      const t2 = store.createTask({
        title: "[PR feedback] owner/repo#11 cycle 2",
        source: "pr-feedback",
        source_ref: "owner/repo#11",
        agent_name: "my-agent",
      });
      store.updateTask(t2.id, { status: "failed" });

      const history = store.getPrFeedbackHistory("owner/repo#11");
      expect(history.length).toBe(2);
      const statuses = history.map((t) => t.status);
      expect(statuses).toContain("done");
      expect(statuses).toContain("failed");
    });
  });

  describe("getTaskStatusCountsLastHours", () => {
    it("returns zero counts when no tasks exist", () => {
      const counts = store.getTaskStatusCountsLastHours(24);
      expect(counts.done).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.pending).toBe(0);
      expect(counts.in_progress).toBe(0);
    });

    it("counts tasks by status within the time window", () => {
      const t1 = store.createTask({ title: "Task A", source: "manual", agent_name: "alpha" });
      store.updateTask(t1.id, { status: "done" });
      const t2 = store.createTask({ title: "Task B", source: "manual", agent_name: "alpha" });
      store.updateTask(t2.id, { status: "failed" });
      store.createTask({ title: "Task C", source: "manual", agent_name: "beta" });

      const counts = store.getTaskStatusCountsLastHours(24);
      expect(counts.done).toBe(1);
      expect(counts.failed).toBe(1);
      expect(counts.pending).toBe(1);
    });

    it("excludes sub-tasks (tasks with parent_task_id)", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "alpha" });
      store.createSubTask({
        title: "Child",
        description: "sub",
        source: "manual",
        agent_name: "alpha",
        parent_task_id: parent.id,
        step_id: "step-1",
      });

      const counts = store.getTaskStatusCountsLastHours(24);
      // Only the parent should be counted (child has parent_task_id)
      expect(counts.pending).toBe(1);
    });
  });

  describe("getAgentsWithRecentFailures", () => {
    it("returns empty array when no failures exist", () => {
      const result = store.getAgentsWithRecentFailures(24, 1);
      expect(result).toEqual([]);
    });

    it("returns agents with more failures than the threshold", () => {
      // alpha has 2 failures — above threshold of 1 (HAVING COUNT(*) > 1)
      const t1 = store.createTask({ title: "Fail 1", source: "manual", agent_name: "alpha" });
      store.updateTask(t1.id, { status: "failed" });
      const t2 = store.createTask({ title: "Fail 2", source: "manual", agent_name: "alpha" });
      store.updateTask(t2.id, { status: "failed" });
      // beta has 1 failure — not above threshold (HAVING COUNT(*) > 1 means > 1, so 1 is excluded)
      const t3 = store.createTask({ title: "Fail 3", source: "manual", agent_name: "beta" });
      store.updateTask(t3.id, { status: "failed" });

      const result = store.getAgentsWithRecentFailures(24, 1);
      expect(result.length).toBe(1);
      expect(result[0].agent_name).toBe("alpha");
      expect(result[0].failed).toBe(2);
    });

    it("excludes sub-tasks from failure counts", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "gamma" });
      store.updateTask(parent.id, { status: "failed" });
      // Two child failures — should not be counted (have parent_task_id)
      const child1 = store.createSubTask({
        title: "Child 1",
        description: "sub 1",
        source: "manual",
        agent_name: "gamma",
        parent_task_id: parent.id,
        step_id: "step-1",
      });
      store.updateTask(child1.id, { status: "failed" });
      const child2 = store.createSubTask({
        title: "Child 2",
        description: "sub 2",
        source: "manual",
        agent_name: "gamma",
        parent_task_id: parent.id,
        step_id: "step-2",
      });
      store.updateTask(child2.id, { status: "failed" });

      // Only the parent counts — 1 failure for gamma, not above threshold of 1
      const result = store.getAgentsWithRecentFailures(24, 1);
      expect(result).toEqual([]);
    });
  });

  describe("getRetryableTasks", () => {
    it("returns failed tasks whose next_retry_at has elapsed", () => {
      const task = store.createTask({ title: "Retryable", source: "github", agent_name: "test-agent" });
      // Set next_retry_at in the past so it's due now
      const pastRetryAt = new Date(Date.now() - 5000).toISOString();
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 1,
        next_retry_at: pastRetryAt,
      });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(1);
      expect(due[0].id).toBe(task.id);
    });

    it("does not return tasks whose next_retry_at is in the future", () => {
      const task = store.createTask({ title: "Not yet due", source: "github", agent_name: "test-agent" });
      const futureRetryAt = new Date(Date.now() + 60_000).toISOString();
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 1,
        next_retry_at: futureRetryAt,
      });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(0);
    });

    it("does not return tasks where retry_count >= maxRetries", () => {
      const task = store.createTask({ title: "Exhausted", source: "github", agent_name: "test-agent" });
      const pastRetryAt = new Date(Date.now() - 5000).toISOString();
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 3,
        next_retry_at: pastRetryAt,
      });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(0);
    });

    it("does not return failed tasks with no next_retry_at (permanently failed)", () => {
      const task = store.createTask({ title: "Permanent fail", source: "github", agent_name: "test-agent" });
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 3,
        next_retry_at: null,
      });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(0);
    });

    it("does not return done tasks", () => {
      const task = store.createTask({ title: "Done task", source: "github", agent_name: "test-agent" });
      const pastRetryAt = new Date(Date.now() - 5000).toISOString();
      // Manually set next_retry_at on a done task (should never happen in practice, but guards against it)
      store.updateTask(task.id, { status: "done", retry_count: 1, next_retry_at: pastRetryAt });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(0);
    });

    it("returns tasks ordered by next_retry_at ascending (oldest due first)", () => {
      const older = store.createTask({ title: "Older retry", source: "github", agent_name: "agent-a" });
      const newer = store.createTask({ title: "Newer retry", source: "github", agent_name: "agent-b" });

      const olderRetryAt = new Date(Date.now() - 10_000).toISOString();
      const newerRetryAt = new Date(Date.now() - 1_000).toISOString();

      store.updateTask(older.id, { status: "failed", retry_count: 1, next_retry_at: olderRetryAt });
      store.updateTask(newer.id, { status: "failed", retry_count: 1, next_retry_at: newerRetryAt });

      const due = store.getRetryableTasks(3);
      expect(due).toHaveLength(2);
      expect(due[0].id).toBe(older.id); // older timestamp comes first
    });
  });

  describe("supervisor memory", () => {
    it("stores and retrieves a supervisor decision", () => {
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: "agent-a",
        reason: "Agent is idle with open issue #42",
        message: "Please implement issue #42",
        outcome: "dispatched",
        task_id: "01ABC123",
      });

      const decisions = store.getRecentSupervisorDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("dispatch");
      expect(decisions[0].agent_name).toBe("agent-a");
      expect(decisions[0].reason).toBe("Agent is idle with open issue #42");
      expect(decisions[0].outcome).toBe("dispatched");
      expect(decisions[0].task_id).toBe("01ABC123");
      expect(decisions[0].created_at).toBeTruthy();
    });

    it("stores decisions with optional fields as null", () => {
      store.addSupervisorDecision({
        action: "none",
        reason: "All systems nominal",
        outcome: "none",
      });

      const decisions = store.getRecentSupervisorDecisions();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].agent_name).toBeNull();
      expect(decisions[0].message).toBeNull();
      expect(decisions[0].task_id).toBeNull();
    });

    it("returns decisions newest-first", () => {
      store.addSupervisorDecision({ action: "dispatch", agent_name: "agent-a", reason: "First", outcome: "dispatched" });
      store.addSupervisorDecision({ action: "follow-up", agent_name: "agent-b", reason: "Second", outcome: "skipped" });
      store.addSupervisorDecision({ action: "none", reason: "Third", outcome: "none" });

      const decisions = store.getRecentSupervisorDecisions();
      expect(decisions[0].reason).toBe("Third");
      expect(decisions[1].reason).toBe("Second");
      expect(decisions[2].reason).toBe("First");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 15; i++) {
        store.addSupervisorDecision({ action: "none", reason: `Decision ${i}`, outcome: "none" });
      }

      const decisions = store.getRecentSupervisorDecisions(5);
      expect(decisions).toHaveLength(5);
    });

    it("returns empty array when no decisions recorded", () => {
      const decisions = store.getRecentSupervisorDecisions();
      expect(decisions).toHaveLength(0);
    });

    it("stores unhandled outcome for unsupported action types", () => {
      store.addSupervisorDecision({
        action: "create-issue",
        agent_name: "agent-a",
        reason: "Repeated failures detected",
        outcome: "unhandled",
      });

      const decisions = store.getRecentSupervisorDecisions(1);
      expect(decisions[0].action).toBe("create-issue");
      expect(decisions[0].outcome).toBe("unhandled");
      expect(decisions[0].task_id).toBeNull();
    });
  });
});
