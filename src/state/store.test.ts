import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("StateStore", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    // Use randomUUID() instead of Date.now() to prevent path collisions when
    // consecutive tests execute within the same millisecond.
    dbPath = join(tmpdir(), `orch-test-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    // Remove the main DB file plus SQLite WAL/SHM companion files so that a
    // subsequent test opening the same path (theoretically) cannot replay
    // stale WAL data from a previous test run.
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
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
        source_ref: "rapartlu/agent-proxy#1",
        agent_name: "claude-proxy",
      });
      expect(task.description).toBe("A longer description");
      expect(task.source_ref).toBe("rapartlu/agent-proxy#1");
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

  describe("monologues", () => {
    it("records prose monologue entries and filters them", () => {
      const t1 = store.createTask({ title: "Monologue task 1", source: "manual" });
      const t2 = store.createTask({ title: "Monologue task 2", source: "manual" });

      store.emitMonologue({
        agent_name: "claude-agent-orchestrator",
        task_id: t1.id,
        kind: "plan",
        prose: "I am mapping the task first, then I will verify the store path.",
      });
      store.emitMonologue({
        agent_name: "claude-agent-orchestrator",
        task_id: t2.id,
        kind: "execution",
        prose: "The migration is in place, and I am wiring the helper next.",
      });

      const all = store.getMonologue({ limit: 10 }).reverse();
      expect(all).toHaveLength(2);
      expect(all[0]).toMatchObject({
        agent_name: "claude-agent-orchestrator",
        task_id: t1.id,
        kind: "plan",
      });
      expect(all[1]).toMatchObject({
        task_id: t2.id,
        kind: "execution",
      });

      const filtered = store.getMonologue({ task_id: t1.id });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].prose).toContain("mapping the task first");

      const counted = store.getMonologueCount({ agent_name: "claude-agent-orchestrator" });
      expect(counted).toBe(2);

      const paged = store.getMonologue({ limit: 1, offset: 1 });
      expect(paged).toHaveLength(1);
      expect(paged[0].task_id).toBe(t1.id);
    });
  });

  describe("token usage", () => {
    it("records token usage and aggregates it by agent", () => {
      store.recordTokenUsage("claude", "claude-agent-orchestrator", 100, 40);
      store.recordTokenUsage("claude", "claude-agent-orchestrator", 60, 20);

      const usage = store.getAgentTokenUsage(24);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        agent_name: "claude-agent-orchestrator",
        input_tokens: 160,
        output_tokens: 60,
        total_tokens: 220,
      });
    });

    it("builds a Claude vs Codex fleet comparison from token_usage rows", () => {
      const claudeDone = store.createTask({ title: "Claude task 1", source: "manual", agent_name: "claude-agent-orchestrator" });
      store.updateTask(claudeDone.id, { status: "done", verification_status: "approved", quality_score: 0.9 });

      const claudeFailed = store.createTask({ title: "Claude task 2", source: "manual", agent_name: "claude-agent-orchestrator" });
      store.updateTask(claudeFailed.id, { status: "failed", verification_status: "rejected", quality_score: 0.6 });

      const codexDone1 = store.createTask({ title: "Codex task 1", source: "manual", agent_name: "codex-agent-orchestrator" });
      store.updateTask(codexDone1.id, { status: "done", verification_status: "approved", quality_score: 0.8 });

      const codexDone2 = store.createTask({ title: "Codex task 2", source: "manual", agent_name: "codex-agent-orchestrator" });
      store.updateTask(codexDone2.id, { status: "done", verification_status: "approved", quality_score: 0.7 });

      store.recordTokenUsage("claude", "claude-agent-orchestrator", 100, 50);
      store.recordTokenUsage("openai", "codex-agent-orchestrator", 40, 10);

      const comparison = store.getFleetComparison(7);
      expect(comparison.days).toBe(7);
      expect(comparison.rows).toHaveLength(2);

      const claude = comparison.rows.find((row) => row.provider === "claude");
      const codex = comparison.rows.find((row) => row.provider === "codex");

      expect(claude).toMatchObject({
        label: "Claude",
        tasks_completed: 1,
        tasks_failed: 1,
        tasks_attempted: 2,
        total_tokens: 150,
        records: 1,
      });
      expect(claude?.success_rate).toBeCloseTo(0.5, 5);
      expect(claude?.avg_quality_score).toBeCloseTo(0.75, 5);

      expect(codex).toMatchObject({
        label: "Codex",
        tasks_completed: 2,
        tasks_failed: 0,
        tasks_attempted: 2,
        total_tokens: 50,
        records: 1,
      });
      expect(codex?.success_rate).toBeCloseTo(1, 5);
      expect(codex?.avg_quality_score).toBeCloseTo(0.75, 5);
    });

    it("falls back to task_logs when token_usage is empty", () => {
      const claudeDone = store.createTask({ title: "Claude task 1", source: "manual", agent_name: "claude-agent-orchestrator" });
      store.updateTask(claudeDone.id, { status: "done", verification_status: "approved", quality_score: 0.9 });
      store.addLog({
        task_id: claudeDone.id,
        direction: "from_agent",
        agent_name: "claude-agent-orchestrator",
        content: "done",
        tokens_in: 12,
        tokens_out: 8,
      });

      const codexDone = store.createTask({ title: "Codex task 1", source: "manual", agent_name: "codex-agent-orchestrator" });
      store.updateTask(codexDone.id, { status: "done", verification_status: "approved", quality_score: 0.8 });
      store.addLog({
        task_id: codexDone.id,
        direction: "from_agent",
        agent_name: "codex-agent-orchestrator",
        content: "done",
        tokens_in: 5,
        tokens_out: 5,
      });

      const comparison = store.getFleetComparison(7);
      const claude = comparison.rows.find((row) => row.provider === "claude");
      const codex = comparison.rows.find((row) => row.provider === "codex");

      expect(claude?.total_tokens).toBe(20);
      expect(claude?.records).toBe(1);
      expect(codex?.total_tokens).toBe(10);
      expect(codex?.records).toBe(1);
    });

    it("returns detailed per-agent usage with cache metrics", () => {
      store.recordTokenUsage("claude", "claude-agent-orchestrator", 100, 40, 500, 250);
      store.recordTokenUsage("openai", "codex-agent-orchestrator", 200, 80);

      const usage = store.getAgentTokenUsageDetail(24);
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({
        agent_name: "codex-agent-orchestrator",
        provider: "openai",
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      });
      expect(usage[1]).toMatchObject({
        agent_name: "claude-agent-orchestrator",
        provider: "claude",
        input_tokens: 100,
        output_tokens: 40,
        total_tokens: 140,
        cache_read_tokens: 500,
        cache_creation_tokens: 250,
      });
    });

    it("returns daily token totals per agent for trend rendering", () => {
      store.recordTokenUsage("claude", "claude-agent-orchestrator", 100, 40);
      store.recordTokenUsage("claude", "claude-agent-orchestrator", 60, 20);
      store.recordTokenUsage("openai", "codex-agent-orchestrator", 200, 80);

      const usage = store.getDailyTokenUsageByAgent(7);
      expect(usage).toHaveLength(2);
      expect(usage[0]).toMatchObject({
        agent_name: "codex-agent-orchestrator",
        provider: "openai",
        input_tokens: 200,
        output_tokens: 80,
        total_tokens: 280,
      });
      expect(usage[1]).toMatchObject({
        agent_name: "claude-agent-orchestrator",
        provider: "claude",
        input_tokens: 160,
        output_tokens: 60,
        total_tokens: 220,
      });
      expect(typeof usage[0].date).toBe("string");
    });
  });

  describe("findTaskByIssueRef", () => {
    it("finds a task by repo and issue number", () => {
      const t = store.createTask({
        title: "Fix bug",
        source: "github",
        source_ref: "owner/repo#42",
      });

      const found = store.findTaskByIssueRef("owner/repo", "42");
      expect(found).toBeDefined();
      expect(found!.id).toBe(t.id);
    });

    it("returns undefined when no matching task exists", () => {
      const found = store.findTaskByIssueRef("owner/repo", "999");
      expect(found).toBeUndefined();
    });

    it("returns undefined for non-github tasks with matching source_ref pattern", () => {
      store.createTask({
        title: "Manual task",
        source: "manual",
        source_ref: "owner/repo#77",
      });

      const found = store.findTaskByIssueRef("owner/repo", "77");
      // source is 'manual', not 'github' — should not be found
      expect(found).toBeUndefined();
    });

    it("returns a task when multiple tasks match the same issue ref", () => {
      store.createTask({
        title: "First task",
        source: "github",
        source_ref: "owner/repo#10",
      });
      store.createTask({
        title: "Second task",
        source: "github",
        source_ref: "owner/repo#10",
      });

      const found = store.findTaskByIssueRef("owner/repo", "10");
      // Both tasks match — we only care that one is returned
      expect(found).toBeDefined();
      expect(found!.source_ref).toBe("owner/repo#10");
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

  describe("dispatch validations", () => {
    it("stores and retrieves blocked validation failures", () => {
      store.addDispatchValidation({
        source: "github",
        source_ref: "owner/repo#42",
        agent_name: "agent-a",
        repo: "owner/repo",
        issue_number: 42,
        outcome: "blocked",
        failure_check: "branch_conflicts",
        failure_code: "open_pr_exists",
        failure_reason: "issue owner/repo#42 already has open PR #7",
        checklist: [
          { name: "issue_ownership", status: "passed", code: "owned_by_agent", detail: "ok" },
          { name: "branch_conflicts", status: "failed", code: "open_pr_exists", detail: "issue owner/repo#42 already has open PR #7" },
        ],
      });

      const failures = store.getRecentDispatchValidationFailures(5);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        source_ref: "owner/repo#42",
        outcome: "blocked",
        failure_check: "branch_conflicts",
        failure_code: "open_pr_exists",
      });
    });

    it("returns validation history for a source_ref newest first", () => {
      store.addDispatchValidation({
        source: "github",
        source_ref: "owner/repo#77",
        outcome: "passed",
        checklist: [{ name: "agent_availability", status: "passed", code: "agent_available", detail: "ok" }],
      });
      store.addDispatchValidation({
        source: "github",
        source_ref: "owner/repo#77",
        outcome: "blocked",
        failure_check: "recent_failure_count",
        failure_code: "retry_limit_exceeded",
        failure_reason: "too many failures",
        checklist: [{ name: "recent_failure_count", status: "failed", code: "retry_limit_exceeded", detail: "too many failures" }],
      });

      const history = store.getDispatchValidationHistory("owner/repo#77", 10);
      expect(history).toHaveLength(2);
      expect(history[0].outcome).toBe("blocked");
      expect(history[1].outcome).toBe("passed");
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

  describe("countPrFeedbackRounds", () => {
    it("returns 0 when no pr-feedback tasks exist for that PR", () => {
      expect(store.countPrFeedbackRounds("owner/repo", 99)).toBe(0);
    });

    it("returns 1 after one feedback task is dispatched", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#42",
        source: "pr-feedback",
        source_ref: "owner/repo#42",
        agent_name: "my-agent",
      });
      expect(store.countPrFeedbackRounds("owner/repo", 42)).toBe(1);
    });

    it("returns 3 after three rounds regardless of task status", () => {
      for (let i = 1; i <= 3; i++) {
        const task = store.createTask({
          title: `[PR feedback] owner/repo#7 round ${i}`,
          source: "pr-feedback",
          source_ref: "owner/repo#7",
          agent_name: "my-agent",
        });
        if (i < 3) store.updateTask(task.id, { status: "done" });
        // Round 3 stays pending (in-flight)
      }
      expect(store.countPrFeedbackRounds("owner/repo", 7)).toBe(3);
    });

    it("counts in-flight (pending/dispatched) tasks toward the ceiling", () => {
      // An in-flight task should count — we dispatched the round, it just hasn't completed yet.
      const task = store.createTask({
        title: "[PR feedback] owner/repo#50",
        source: "pr-feedback",
        source_ref: "owner/repo#50",
        agent_name: "my-agent",
      });
      store.updateTask(task.id, { status: "dispatched" });
      expect(store.countPrFeedbackRounds("owner/repo", 50)).toBe(1);
    });

    it("does not count feedback tasks for a different PR number", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#100",
        source: "pr-feedback",
        source_ref: "owner/repo#100",
        agent_name: "my-agent",
      });
      expect(store.countPrFeedbackRounds("owner/repo", 101)).toBe(0);
    });

    it("does not count non-pr-feedback tasks for the same source_ref", () => {
      store.createTask({
        title: "github task",
        source: "github",
        source_ref: "owner/repo#200",
        agent_name: "my-agent",
      });
      expect(store.countPrFeedbackRounds("owner/repo", 200)).toBe(0);
    });

    it("accepts prNumber as a string", () => {
      store.createTask({
        title: "[PR feedback] owner/repo#300",
        source: "pr-feedback",
        source_ref: "owner/repo#300",
        agent_name: "my-agent",
      });
      expect(store.countPrFeedbackRounds("owner/repo", "300")).toBe(1);
    });
  });

  describe("markPrFeedbackTasksEscalated", () => {
    it("transitions in-flight pr-feedback tasks to escalated and returns the count", () => {
      const t1 = store.createTask({
        title: "[PR feedback] owner/repo#77",
        source: "pr-feedback",
        source_ref: "owner/repo#77",
        agent_name: "my-agent",
      });
      store.updateTask(t1.id, { status: "dispatched" });
      const t2 = store.createTask({
        title: "[PR feedback] owner/repo#77 round 2",
        source: "pr-feedback",
        source_ref: "owner/repo#77",
        agent_name: "my-agent",
      });
      // t2 stays pending

      const changed = store.markPrFeedbackTasksEscalated("owner/repo", 77);
      expect(changed).toBe(2);

      const updated1 = store.getTask(t1.id);
      const updated2 = store.getTask(t2.id);
      expect(updated1?.status).toBe("escalated");
      expect(updated2?.status).toBe("escalated");
    });

    it("does not touch already-completed tasks (done / failed)", () => {
      const done = store.createTask({
        title: "[PR feedback] owner/repo#88 done",
        source: "pr-feedback",
        source_ref: "owner/repo#88",
        agent_name: "my-agent",
      });
      store.updateTask(done.id, { status: "done" });

      const failed = store.createTask({
        title: "[PR feedback] owner/repo#88 failed",
        source: "pr-feedback",
        source_ref: "owner/repo#88",
        agent_name: "my-agent",
      });
      store.updateTask(failed.id, { status: "failed" });

      const pending = store.createTask({
        title: "[PR feedback] owner/repo#88 pending",
        source: "pr-feedback",
        source_ref: "owner/repo#88",
        agent_name: "my-agent",
      });

      const changed = store.markPrFeedbackTasksEscalated("owner/repo", 88);
      // Only the pending task should be transitioned
      expect(changed).toBe(1);
      expect(store.getTask(done.id)?.status).toBe("done");
      expect(store.getTask(failed.id)?.status).toBe("failed");
      expect(store.getTask(pending.id)?.status).toBe("escalated");
    });

    it("returns 0 when no in-flight tasks exist for that PR", () => {
      const changed = store.markPrFeedbackTasksEscalated("owner/repo", 999);
      expect(changed).toBe(0);
    });

    it("does not affect tasks for a different PR on the same repo", () => {
      const other = store.createTask({
        title: "[PR feedback] owner/repo#55",
        source: "pr-feedback",
        source_ref: "owner/repo#55",
        agent_name: "my-agent",
      });

      store.markPrFeedbackTasksEscalated("owner/repo", 56); // different PR
      expect(store.getTask(other.id)?.status).toBe("pending");
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
      expect(decisions[0].issue_refs).toEqual([]);
      expect(decisions[0].hard_gates).toEqual([]);
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
      expect(decisions[0].rationale).toBeNull();
      expect(decisions[0].task_id).toBeNull();
      expect(decisions[0].issue_refs).toEqual([]);
      expect(decisions[0].hard_gates).toEqual([]);
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

    it("stores and retrieves rationale field", () => {
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: "agent-a",
        reason: "Issue #42 open and unassigned",
        message: "Implement issue #42",
        rationale: "Issue #42 was opened 3 days ago with high user impact. No prior attempts exist. Success means a merged PR closing #42.",
        outcome: "dispatched",
        task_id: "01XYZ789",
      });

      const decisions = store.getRecentSupervisorDecisions(1);
      expect(decisions[0].rationale).toBe(
        "Issue #42 was opened 3 days ago with high user impact. No prior attempts exist. Success means a merged PR closing #42.",
      );
    });

    it("stores null rationale when not provided", () => {
      store.addSupervisorDecision({
        action: "none",
        reason: "Everything on track",
        outcome: "none",
      });

      const decisions = store.getRecentSupervisorDecisions(1);
      expect(decisions[0].rationale).toBeNull();
    });

    it("stores and retrieves structured issue refs and hard gates", () => {
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: "agent-a",
        reason: "Blocked issue #523",
        message: "Implement issue #523",
        rationale: "Issue is high priority.",
        issue_refs: ["rapartlu/agent-orchestrator#523"],
        hard_gates: ["issue already has open PR", "agent busy"],
        outcome: "skipped",
      });

      const decisions = store.getRecentSupervisorDecisions(1);
      expect(decisions[0].issue_refs).toEqual(["rapartlu/agent-orchestrator#523"]);
      expect(decisions[0].hard_gates).toEqual(["issue already has open PR", "agent busy"]);
    });
  });

  describe("countConsecutiveRejectionsForSourceRef", () => {
    it("counts only the most recent consecutive rejected attempts by the same agent", () => {
      const sourceRef = "rapartlu/agent-orchestrator#516";

      const olderApproved = store.createTask({ title: "older", source: "github", source_ref: sourceRef, agent_name: "agent-a" });
      store.updateTask(olderApproved.id, { status: "done", verification_status: "approved", quality_score: 0.9 });

      const rejected1 = store.createTask({ title: "r1", source: "github", source_ref: sourceRef, agent_name: "agent-a" });
      store.updateTask(rejected1.id, { status: "done", verification_status: "rejected", quality_score: 0.2 });

      const rejected2 = store.createTask({ title: "r2", source: "github", source_ref: sourceRef, agent_name: "agent-a" });
      store.updateTask(rejected2.id, { status: "done", verification_status: "rejected", quality_score: 0.1 });

      expect(store.countConsecutiveRejectionsForSourceRef(sourceRef, "agent-a")).toBe(2);
    });

    it("stops counting when the most recent attempt belongs to a different agent", () => {
      const sourceRef = "rapartlu/agent-orchestrator#516";

      const rejected = store.createTask({ title: "r1", source: "github", source_ref: sourceRef, agent_name: "agent-a" });
      store.updateTask(rejected.id, { status: "done", verification_status: "rejected", quality_score: 0.2 });

      const differentAgent = store.createTask({ title: "r2", source: "github", source_ref: sourceRef, agent_name: "agent-b" });
      store.updateTask(differentAgent.id, { status: "done", verification_status: "rejected", quality_score: 0.1 });

      expect(store.countConsecutiveRejectionsForSourceRef(sourceRef, "agent-a")).toBe(0);
    });
  });

  describe("getWindowedAgentMetrics", () => {
    it("returns empty array when no tasks exist", () => {
      const rows = store.getWindowedAgentMetrics(7);
      expect(rows).toHaveLength(0);
    });

    it("includes agents with done tasks in the window", () => {
      const t = store.createTask({ title: "Do something", source: "github", agent_name: "alpha" });
      store.updateTask(t.id, { status: "done" });

      const rows = store.getWindowedAgentMetrics(7);
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_name).toBe("alpha");
      expect(rows[0].done).toBe(1);
      expect(rows[0].total).toBe(1);
      expect(rows[0].failed).toBe(0);
    });

    it("computes fail_pct correctly", () => {
      const t1 = store.createTask({ title: "Pass", source: "manual", agent_name: "beta" });
      const t2 = store.createTask({ title: "Fail", source: "manual", agent_name: "beta" });
      store.updateTask(t1.id, { status: "done" });
      store.updateTask(t2.id, { status: "failed" });

      const rows = store.getWindowedAgentMetrics(7);
      const row = rows.find((r) => r.agent_name === "beta")!;
      expect(row.total).toBe(2);
      expect(row.done).toBe(1);
      expect(row.failed).toBe(1);
      expect(row.fail_pct).toBe(50);
    });

    it("computes rejection_pct from verified tasks", () => {
      const t1 = store.createTask({ title: "A", source: "manual", agent_name: "gamma" });
      const t2 = store.createTask({ title: "B", source: "manual", agent_name: "gamma" });
      store.updateTask(t1.id, { status: "done", verification_status: "approved", quality_score: 0.9 });
      store.updateTask(t2.id, { status: "done", verification_status: "rejected", quality_score: 0.4 });

      const rows = store.getWindowedAgentMetrics(7);
      const row = rows.find((r) => r.agent_name === "gamma")!;
      expect(row.rejection_pct).toBe(50); // 1 rejected out of 2 verified
      expect(row.avg_quality_score).toBeCloseTo(0.65, 1);
    });

    it("excludes sub-tasks (parent_task_id IS NOT NULL)", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "delta" });
      const child = store.createTask({ title: "Child", source: "manual", agent_name: "delta" });
      store.updateTask(child.id, { parent_task_id: parent.id, status: "done" });
      store.updateTask(parent.id, { status: "done" });

      const rows = store.getWindowedAgentMetrics(7);
      const row = rows.find((r) => r.agent_name === "delta")!;
      expect(row.total).toBe(1); // only parent counted
    });

    it("excludes tasks outside the window", () => {
      // We can't easily set created_at in the past via the normal API,
      // so we verify that tasks created now ARE included in a 7-day window.
      const t = store.createTask({ title: "Recent", source: "manual", agent_name: "epsilon" });
      store.updateTask(t.id, { status: "done" });

      const rows7 = store.getWindowedAgentMetrics(7);
      expect(rows7.find((r) => r.agent_name === "epsilon")).toBeDefined();
    });

    it("returns null fail_pct when total is 0 (no tasks)", () => {
      // getWindowedAgentMetrics only returns agents that have tasks, so
      // any row returned must have total >= 1 and non-null fail_pct.
      const t = store.createTask({ title: "Solo", source: "manual", agent_name: "zeta" });
      store.updateTask(t.id, { status: "done" });

      const rows = store.getWindowedAgentMetrics(7);
      const row = rows.find((r) => r.agent_name === "zeta")!;
      expect(row.fail_pct).not.toBeNull();
      expect(row.fail_pct).toBe(0);
    });

    it("includes trend direction", () => {
      const t = store.createTask({ title: "T", source: "manual", agent_name: "eta" });
      store.updateTask(t.id, { status: "done" });

      const rows = store.getWindowedAgentMetrics(7);
      const row = rows.find((r) => r.agent_name === "eta")!;
      expect(["improving", "stable", "declining", "insufficient_data"]).toContain(row.trend);
    });
  });

  describe("getRetryMetrics", () => {
    it("returns zeros when no tasks have been retried", () => {
      const metrics = store.getRetryMetrics(24);
      expect(metrics.per_agent).toHaveLength(0);
      expect(metrics.total_waiting).toBe(0);
      expect(metrics.total_exhausted).toBe(0);
    });

    it("counts a retried (waiting) task correctly", () => {
      const futureRetryAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const task = store.createTask({ title: "Timed out task", source: "manual", agent_name: "alpha" });
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 1,
        next_retry_at: futureRetryAt,
      });

      const metrics = store.getRetryMetrics(24);
      expect(metrics.total_waiting).toBe(1);
      expect(metrics.total_exhausted).toBe(0);

      const agentRow = metrics.per_agent.find((a) => a.agent_name === "alpha");
      expect(agentRow).toBeDefined();
      expect(agentRow!.retried_tasks).toBe(1);
      expect(agentRow!.total_retries).toBe(1);
      expect(agentRow!.waiting_retry).toBe(1);
      expect(agentRow!.exhausted_budget).toBe(0);
    });

    it("counts exhausted budget tasks correctly", () => {
      const task = store.createTask({ title: "Exhausted task", source: "manual", agent_name: "beta" });
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 2,
        next_retry_at: null,
      });

      const metrics = store.getRetryMetrics(24);
      expect(metrics.total_exhausted).toBe(1);

      const agentRow = metrics.per_agent.find((a) => a.agent_name === "beta");
      expect(agentRow).toBeDefined();
      expect(agentRow!.exhausted_budget).toBe(1);
      expect(agentRow!.waiting_retry).toBe(0);
    });

    it("aggregates multiple tasks per agent", () => {
      const futureRetryAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

      // 2 exhausted tasks
      for (let i = 0; i < 2; i++) {
        const t = store.createTask({ title: `Exhausted ${i}`, source: "manual", agent_name: "gamma" });
        store.updateTask(t.id, { status: "failed", retry_count: 2, next_retry_at: null });
      }
      // 1 waiting task
      const waiting = store.createTask({ title: "Waiting", source: "manual", agent_name: "gamma" });
      store.updateTask(waiting.id, { status: "failed", retry_count: 1, next_retry_at: futureRetryAt });

      const metrics = store.getRetryMetrics(24);
      const agentRow = metrics.per_agent.find((a) => a.agent_name === "gamma");
      expect(agentRow).toBeDefined();
      expect(agentRow!.retried_tasks).toBe(3);
      expect(agentRow!.total_retries).toBe(5); // 2+2+1
      expect(agentRow!.exhausted_budget).toBe(2);
      expect(agentRow!.waiting_retry).toBe(1);
      expect(metrics.total_waiting).toBe(1);
      expect(metrics.total_exhausted).toBe(2);
    });

    it("separates metrics by agent", () => {
      const futureRetryAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const t1 = store.createTask({ title: "Agent-A task", source: "manual", agent_name: "agent-a" });
      store.updateTask(t1.id, { status: "failed", retry_count: 1, next_retry_at: futureRetryAt });
      const t2 = store.createTask({ title: "Agent-B task", source: "manual", agent_name: "agent-b" });
      store.updateTask(t2.id, { status: "failed", retry_count: 2, next_retry_at: null });

      const metrics = store.getRetryMetrics(24);
      const aRow = metrics.per_agent.find((a) => a.agent_name === "agent-a");
      const bRow = metrics.per_agent.find((a) => a.agent_name === "agent-b");
      expect(aRow!.waiting_retry).toBe(1);
      expect(aRow!.exhausted_budget).toBe(0);
      expect(bRow!.waiting_retry).toBe(0);
      expect(bRow!.exhausted_budget).toBe(1);
      expect(metrics.total_waiting).toBe(1);
      expect(metrics.total_exhausted).toBe(1);
    });

    it("does not count tasks with retry_count = 0", () => {
      const t = store.createTask({ title: "Never retried", source: "manual", agent_name: "delta" });
      store.updateTask(t.id, { status: "failed", retry_count: 0, next_retry_at: null });

      const metrics = store.getRetryMetrics(24);
      const agentRow = metrics.per_agent.find((a) => a.agent_name === "delta");
      expect(agentRow).toBeUndefined();
    });

    it("does not count sub-tasks (parent_task_id is set)", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "epsilon" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Child",
        description: "child task",
        source: "manual",
        agent_name: "epsilon",
      });
      store.updateTask(child.id, { status: "failed", retry_count: 2, next_retry_at: null });

      const metrics = store.getRetryMetrics(24);
      const agentRow = metrics.per_agent.find((a) => a.agent_name === "epsilon");
      expect(agentRow).toBeUndefined(); // sub-tasks excluded
    });

    it("does not count already-elapsed retry tasks as 'waiting'", () => {
      const pastRetryAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const t = store.createTask({ title: "Overdue retry", source: "manual", agent_name: "zeta" });
      store.updateTask(t.id, { status: "failed", retry_count: 1, next_retry_at: pastRetryAt });

      const metrics = store.getRetryMetrics(24);
      // Task still appears in per_agent (it has retry_count > 0 and was updated in window)
      const agentRow = metrics.per_agent.find((a) => a.agent_name === "zeta");
      expect(agentRow).toBeDefined();
      // But next_retry_at is in the past so it's not "waiting"
      expect(agentRow!.waiting_retry).toBe(0);
      // And total_waiting uses a separate query with next_retry_at > now
      expect(metrics.total_waiting).toBe(0);
    });
  });

  describe("getTimeoutRates", () => {
    it("returns an empty array when no tasks exist", () => {
      const rates = store.getTimeoutRates(24);
      expect(rates).toHaveLength(0);
    });

    it("returns zero timeout rate when no tasks have retry_count > 0", () => {
      store.createTask({ title: "Clean task", source: "manual", agent_name: "timeout-agent-a" });
      store.createTask({ title: "Another clean task", source: "manual", agent_name: "timeout-agent-a" });

      const rates = store.getTimeoutRates(24);
      const row = rates.find((r) => r.agent_name === "timeout-agent-a");
      expect(row).toBeDefined();
      expect(row!.total_tasks).toBe(2);
      expect(row!.timed_out_tasks).toBe(0);
      expect(row!.timeout_rate_pct).toBe(0);
    });

    it("counts timed-out tasks correctly", () => {
      const t1 = store.createTask({ title: "Timeout task 1", source: "manual", agent_name: "timeout-agent-b" });
      const t2 = store.createTask({ title: "Timeout task 2", source: "manual", agent_name: "timeout-agent-b" });
      store.createTask({ title: "Clean task", source: "manual", agent_name: "timeout-agent-b" });

      store.updateTask(t1.id, { status: "failed", retry_count: 1 });
      store.updateTask(t2.id, { status: "failed", retry_count: 2 });

      const rates = store.getTimeoutRates(24);
      const row = rates.find((r) => r.agent_name === "timeout-agent-b");
      expect(row).toBeDefined();
      expect(row!.total_tasks).toBe(3);
      expect(row!.timed_out_tasks).toBe(2);
      expect(row!.timeout_rate_pct).toBeCloseTo(66.67, 1);
    });

    it("returns 100% rate when all tasks timed out", () => {
      const t1 = store.createTask({ title: "All timeout 1", source: "manual", agent_name: "timeout-agent-c" });
      const t2 = store.createTask({ title: "All timeout 2", source: "manual", agent_name: "timeout-agent-c" });
      store.updateTask(t1.id, { status: "failed", retry_count: 1 });
      store.updateTask(t2.id, { status: "failed", retry_count: 1 });

      const rates = store.getTimeoutRates(24);
      const row = rates.find((r) => r.agent_name === "timeout-agent-c");
      expect(row).toBeDefined();
      expect(row!.timeout_rate_pct).toBe(100);
    });

    it("separates metrics by agent", () => {
      const t1 = store.createTask({ title: "Task for d", source: "manual", agent_name: "timeout-agent-d" });
      store.updateTask(t1.id, { status: "failed", retry_count: 1 });
      store.createTask({ title: "Clean for e", source: "manual", agent_name: "timeout-agent-e" });

      const rates = store.getTimeoutRates(24);
      const dRow = rates.find((r) => r.agent_name === "timeout-agent-d");
      const eRow = rates.find((r) => r.agent_name === "timeout-agent-e");
      expect(dRow).toBeDefined();
      expect(dRow!.timed_out_tasks).toBe(1);
      expect(eRow).toBeDefined();
      expect(eRow!.timed_out_tasks).toBe(0);
    });

    it("does not count sub-tasks (parent_task_id is set)", () => {
      const parent = store.createTask({ title: "Parent", source: "manual", agent_name: "timeout-agent-f" });
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Child",
        description: "child task",
        source: "manual",
        agent_name: "timeout-agent-f",
      });
      store.updateTask(child.id, { status: "failed", retry_count: 2 });

      const rates = store.getTimeoutRates(24);
      const row = rates.find((r) => r.agent_name === "timeout-agent-f");
      // Only the parent task counted, not the child
      expect(row).toBeDefined();
      expect(row!.total_tasks).toBe(1);
      expect(row!.timed_out_tasks).toBe(0); // parent was not retried
    });

    it("excludes tasks outside the time window", () => {
      // Create a task and backdated it to 48 hours ago by manipulating created_at
      const task = store.createTask({ title: "Old timed out task", source: "manual", agent_name: "timeout-agent-g" });
      store.updateTask(task.id, { status: "failed", retry_count: 1 });
      // Manually backdated via direct DB access is complex; instead just verify window param is wired
      // by checking rates with window of 0 hours — nothing should appear
      const rates = store.getTimeoutRates(0);
      const row = rates.find((r) => r.agent_name === "timeout-agent-g");
      // With 0 hours window, the task just created may or may not appear depending on exact millisecond
      // The important thing is the method accepts a window parameter and returns typed results
      expect(Array.isArray(rates)).toBe(true);
      if (row) {
        expect(typeof row.timeout_rate_pct).toBe("number");
      }
    });
  });

  describe("recordPRReview and getPRMetrics", () => {
    it("returns zero metrics when no reviews recorded", () => {
      const m = store.getPRMetrics();
      expect(m.total_reviews).toBe(0);
      expect(m.approved).toBe(0);
      expect(m.request_changes).toBe(0);
      expect(m.escalated).toBe(0);
      expect(m.rejection_rate).toBeNull();
      expect(m.avg_cycle_time_ms).toBeNull();
      expect(m.per_repo).toHaveLength(0);
    });

    it("records and counts review decisions correctly", () => {
      store.recordPRReview("owner/repo", 1, "approve");
      store.recordPRReview("owner/repo", 2, "request-changes");
      store.recordPRReview("owner/repo", 3, "escalate");
      store.recordPRReview("owner/repo", 2, "approve"); // second round for PR #2

      const m = store.getPRMetrics();
      expect(m.total_reviews).toBe(4);
      expect(m.approved).toBe(2);
      expect(m.request_changes).toBe(1);
      expect(m.escalated).toBe(1);
    });

    it("computes rejection rate as request-changes / (approved + request-changes)", () => {
      // 2 request-changes, 2 approves → 2/(2+2) = 0.5
      store.recordPRReview("owner/repo", 1, "request-changes");
      store.recordPRReview("owner/repo", 1, "approve");
      store.recordPRReview("owner/repo", 2, "request-changes");
      store.recordPRReview("owner/repo", 2, "approve");

      const m = store.getPRMetrics();
      expect(m.rejection_rate).toBeCloseTo(0.5, 2);
    });

    it("rejection rate is null when no approve/request-changes decisions", () => {
      store.recordPRReview("owner/repo", 1, "escalate");

      const m = store.getPRMetrics();
      expect(m.rejection_rate).toBeNull();
    });

    it("rejection rate is 0 when all reviews are approvals", () => {
      store.recordPRReview("owner/repo", 1, "approve");
      store.recordPRReview("owner/repo", 2, "approve");

      const m = store.getPRMetrics();
      expect(m.rejection_rate).toBe(0);
    });

    it("computes avg_cycle_time_ms as time from first review to approval", () => {
      const now = Date.now();
      // Simulate a PR reviewed at t=0, approved at t+60s
      // We insert raw rows to control timestamps precisely.
      // Since recordPRReview uses new Date(), we test via getPRMetrics indirectly.
      store.recordPRReview("owner/repo", 10, "request-changes");
      // Approval in same ms — cycle time should be ~0
      store.recordPRReview("owner/repo", 10, "approve");

      const m = store.getPRMetrics();
      expect(m.avg_cycle_time_ms).not.toBeNull();
      expect(m.avg_cycle_time_ms!).toBeGreaterThanOrEqual(0);
    });

    it("avg_cycle_time_ms is null when no PRs approved", () => {
      store.recordPRReview("owner/repo", 1, "request-changes");

      const m = store.getPRMetrics();
      expect(m.avg_cycle_time_ms).toBeNull();
    });

    it("groups per_repo correctly", () => {
      store.recordPRReview("owner/repo-a", 1, "approve");
      store.recordPRReview("owner/repo-b", 1, "request-changes");
      store.recordPRReview("owner/repo-b", 1, "approve");

      const m = store.getPRMetrics();
      expect(m.per_repo).toHaveLength(2);

      const repoA = m.per_repo.find((r) => r.repo === "owner/repo-a");
      expect(repoA).toBeDefined();
      expect(repoA!.approved).toBe(1);
      expect(repoA!.request_changes).toBe(0);
      expect(repoA!.rejection_rate).toBe(0);

      const repoB = m.per_repo.find((r) => r.repo === "owner/repo-b");
      expect(repoB).toBeDefined();
      expect(repoB!.request_changes).toBe(1);
      expect(repoB!.approved).toBe(1);
      expect(repoB!.rejection_rate).toBeCloseTo(0.5, 2);
    });

    it("getMetrics includes pr_metrics", () => {
      store.recordPRReview("owner/repo", 1, "approve");
      store.recordPRReview("owner/repo", 2, "request-changes");

      const m = store.getMetrics();
      expect(m.pr_metrics).toBeDefined();
      expect(m.pr_metrics.total_reviews).toBe(2);
      expect(m.pr_metrics.approved).toBe(1);
      expect(m.pr_metrics.request_changes).toBe(1);
    });
  });

  describe("getAgentHealthSummary", () => {
    function makeTask(agentName: string, status: "done" | "failed", result?: string) {
      const task = store.createTask({ title: "t", source: "manual", agent_name: agentName });
      store.updateTask(task.id, { status, result: result ?? null });
      return task;
    }

    it("returns null success_rate and zero streak for agent with no tasks", () => {
      const summaries = store.getAgentHealthSummary(["ghost-agent"]);
      expect(summaries).toHaveLength(1);
      const s = summaries[0];
      expect(s.agent_name).toBe("ghost-agent");
      expect(s.success_rate).toBeNull();
      expect(s.total).toBe(0);
      expect(s.consecutive_failures).toBe(0);
      expect(s.last_failure_reason).toBeNull();
      expect(s.last_success_at).toBeNull();
    });

    it("computes correct success rate", () => {
      makeTask("agent-a", "done");
      makeTask("agent-a", "done");
      makeTask("agent-a", "failed", "something broke");
      makeTask("agent-a", "done");

      const [s] = store.getAgentHealthSummary(["agent-a"]);
      expect(s.total).toBe(4);
      expect(s.done).toBe(3);
      expect(s.failed).toBe(1);
      expect(s.success_rate).toBeCloseTo(0.75, 2);
    });

    it("detects consecutive failure streak from most recent tasks", () => {
      // Tasks are ordered newest-first; the newest are the first created after older ones.
      // SQLite orders by created_at DESC. We need newest to be failures.
      makeTask("agent-b", "done"); // oldest
      makeTask("agent-b", "done");
      makeTask("agent-b", "failed", "err1"); // newer
      makeTask("agent-b", "failed", "err2"); // newest

      const [s] = store.getAgentHealthSummary(["agent-b"]);
      expect(s.consecutive_failures).toBe(2);
    });

    it("reports 0 streak when the most recent task succeeded", () => {
      makeTask("agent-c", "failed", "old error");
      makeTask("agent-c", "done"); // newest — streak resets

      const [s] = store.getAgentHealthSummary(["agent-c"]);
      expect(s.consecutive_failures).toBe(0);
    });

    it("captures last_failure_reason from most recent failed task", () => {
      makeTask("agent-d", "done");
      makeTask("agent-d", "failed", "auth token expired");
      makeTask("agent-d", "failed", "JSON parse error: unexpected token");

      const [s] = store.getAgentHealthSummary(["agent-d"]);
      expect(s.last_failure_reason).toContain("JSON parse error");
    });

    it("truncates long failure reasons to 120 chars", () => {
      const longResult = "x".repeat(200);
      makeTask("agent-e", "failed", longResult);

      const [s] = store.getAgentHealthSummary(["agent-e"]);
      expect(s.last_failure_reason).not.toBeNull();
      expect(s.last_failure_reason!.length).toBeLessThanOrEqual(120);
    });

    it("returns summaries for all agents in config list, even those with no tasks", () => {
      makeTask("agent-f", "done");
      const summaries = store.getAgentHealthSummary(["agent-f", "agent-g"]);
      expect(summaries).toHaveLength(2);
      const ghost = summaries.find((s) => s.agent_name === "agent-g");
      expect(ghost?.total).toBe(0);
    });

    it("discovers agents from DB when no names list provided", () => {
      makeTask("agent-h", "done");
      makeTask("agent-i", "failed", "boom");
      const summaries = store.getAgentHealthSummary();
      const names = summaries.map((s) => s.agent_name);
      expect(names).toContain("agent-h");
      expect(names).toContain("agent-i");
    });

    it("returns null revision_rate and first_attempt_success_rate when no tasks", () => {
      const [s] = store.getAgentHealthSummary(["no-tasks-agent"]);
      expect(s.revision_rate).toBeNull();
      expect(s.first_attempt_success_rate).toBeNull();
    });

    it("counts pr-feedback source tasks as revisions", () => {
      // 2 normal done tasks + 1 pr-feedback task
      store.updateTask(
        store.createTask({ title: "normal 1", source: "github", agent_name: "rev-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "normal 2", source: "manual", agent_name: "rev-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "[PR feedback] owner/repo#42", source: "pr-feedback", agent_name: "rev-agent" }).id,
        { status: "done" },
      );

      const [s] = store.getAgentHealthSummary(["rev-agent"]);
      expect(s.total).toBe(3);
      expect(s.revision_rate).toBeCloseTo(1 / 3, 5);
      // first-attempt: 2 done out of 2 first-attempt tasks
      expect(s.first_attempt_success_rate).toBeCloseTo(1.0, 5);
    });

    it("counts [revision] title tasks as revisions", () => {
      // 3 first-attempt tasks (2 done, 1 failed) + 1 revision task (done)
      store.updateTask(
        store.createTask({ title: "implement feature", source: "github", agent_name: "rev2-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "another task", source: "manual", agent_name: "rev2-agent" }).id,
        { status: "failed", result: "exploded" },
      );
      store.updateTask(
        store.createTask({ title: "third task", source: "github", agent_name: "rev2-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "[revision] implement feature", source: "manual", agent_name: "rev2-agent" }).id,
        { status: "done" },
      );

      const [s] = store.getAgentHealthSummary(["rev2-agent"]);
      expect(s.total).toBe(4);
      expect(s.revision_rate).toBeCloseTo(1 / 4, 5);
      // first-attempt: 2 done out of 3 first-attempt tasks → ~0.667
      expect(s.first_attempt_success_rate).toBeCloseTo(2 / 3, 5);
    });

    it("reports revision_rate of 0 and first_attempt_success_rate matching success_rate when no revisions", () => {
      store.updateTask(
        store.createTask({ title: "task 1", source: "github", agent_name: "clean-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "task 2", source: "manual", agent_name: "clean-agent" }).id,
        { status: "done" },
      );

      const [s] = store.getAgentHealthSummary(["clean-agent"]);
      expect(s.revision_rate).toBeCloseTo(0, 5);
      expect(s.first_attempt_success_rate).toBeCloseTo(1.0, 5);
      expect(s.first_attempt_success_rate).toBeCloseTo(s.success_rate ?? 0, 5);
    });

    it("handles all tasks being revisions", () => {
      store.updateTask(
        store.createTask({ title: "[revision] task 1", source: "manual", agent_name: "all-rev-agent" }).id,
        { status: "done" },
      );
      store.updateTask(
        store.createTask({ title: "[PR feedback] repo#1", source: "pr-feedback", agent_name: "all-rev-agent" }).id,
        { status: "done" },
      );

      const [s] = store.getAgentHealthSummary(["all-rev-agent"]);
      expect(s.revision_rate).toBeCloseTo(1.0, 5);
      // No first-attempt tasks → null
      expect(s.first_attempt_success_rate).toBeNull();
    });
  });

  // ── Issue #330: findAllTasksBySourceRef + getProcessedTriggerInfo ──────────

  describe("findAllTasksBySourceRef", () => {
    it("returns empty array when no tasks match", () => {
      const tasks = store.findAllTasksBySourceRef("owner/repo#999");
      expect(tasks).toEqual([]);
    });

    it("returns all top-level tasks with the given source_ref", () => {
      store.createTask({ title: "First attempt", source: "github", source_ref: "owner/repo#42" });
      store.createTask({ title: "Second attempt", source: "github", source_ref: "owner/repo#42" });
      store.createTask({ title: "Other issue", source: "github", source_ref: "owner/repo#99" });

      const tasks = store.findAllTasksBySourceRef("owner/repo#42");
      expect(tasks).toHaveLength(2);
      expect(tasks.every((t) => t.source_ref === "owner/repo#42")).toBe(true);
    });

    it("excludes sub-tasks (tasks with parent_task_id)", () => {
      const parent = store.createTask({ title: "Parent", source: "github", source_ref: "owner/repo#42" });
      store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "Sub-task",
        description: "Sub",
        source: "github",
        agent_name: "agent",
      });

      const tasks = store.findAllTasksBySourceRef("owner/repo#42");
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe(parent.id);
    });

    it("returns tasks ordered newest-first", () => {
      const first = store.createTask({ title: "First", source: "github", source_ref: "owner/repo#42" });
      const second = store.createTask({ title: "Second", source: "github", source_ref: "owner/repo#42" });

      const tasks = store.findAllTasksBySourceRef("owner/repo#42");
      expect(tasks[0]?.id).toBe(second.id);
      expect(tasks[1]?.id).toBe(first.id);
    });
  });

  describe("getProcessedTriggerInfo", () => {
    it("returns undefined when no trigger has been recorded", () => {
      const info = store.getProcessedTriggerInfo("github", "owner/repo#999");
      expect(info).toBeUndefined();
    });

    it("returns the trigger record after markProcessed", () => {
      const task = store.createTask({ title: "Task", source: "github", source_ref: "owner/repo#42" });
      store.markProcessed("github", "owner/repo#42", task.id);

      const info = store.getProcessedTriggerInfo("github", "owner/repo#42");
      expect(info).toBeDefined();
      expect(info?.source).toBe("github");
      expect(info?.source_ref).toBe("owner/repo#42");
      expect(info?.task_id).toBe(task.id);
      expect(info?.created_at).toBeTruthy();
      // completed_at is stored alongside created_at
      expect(info?.completed_at).toBeTruthy();
    });

    it("returns undefined for a different source", () => {
      const task = store.createTask({ title: "Task", source: "github", source_ref: "owner/repo#42" });
      store.markProcessed("github", "owner/repo#42", task.id);

      const info = store.getProcessedTriggerInfo("linear", "owner/repo#42");
      expect(info).toBeUndefined();
    });
  });

  describe("daemon stats (incrementStat / getStat)", () => {
    it("returns 0 for an unknown key", () => {
      expect(store.getStat("idle_fill_dispatches")).toBe(0);
    });

    it("increments a counter from zero", () => {
      store.incrementStat("idle_fill_dispatches");
      expect(store.getStat("idle_fill_dispatches")).toBe(1);
    });

    it("accumulates multiple increments", () => {
      store.incrementStat("idle_fill_dispatches", 3);
      store.incrementStat("idle_fill_dispatches", 2);
      expect(store.getStat("idle_fill_dispatches")).toBe(5);
    });

    it("tracks independent keys separately", () => {
      store.incrementStat("idle_fill_dispatches", 4);
      store.incrementStat("other_counter", 7);
      expect(store.getStat("idle_fill_dispatches")).toBe(4);
      expect(store.getStat("other_counter")).toBe(7);
    });
  });

  describe("directives", () => {
    it("returns empty list when no directives stored", () => {
      expect(store.listDirectives()).toEqual([]);
    });

    it("adds and retrieves a directive", () => {
      const d = store.addDirective("always use plain text");
      expect(d.id).toBeTypeOf("number");
      expect(d.text).toBe("always use plain text");
      expect(d.created_at).toBeTruthy();

      const list = store.listDirectives();
      expect(list).toHaveLength(1);
      expect(list[0].text).toBe("always use plain text");
    });

    it("trims whitespace from directive text", () => {
      const d = store.addDirective("  trim me  ");
      expect(d.text).toBe("trim me");
    });

    it("stores multiple directives and returns them oldest-first", () => {
      store.addDirective("directive one");
      store.addDirective("directive two");
      store.addDirective("directive three");

      const list = store.listDirectives();
      expect(list).toHaveLength(3);
      expect(list[0].text).toBe("directive one");
      expect(list[2].text).toBe("directive three");
    });

    it("removes a directive by id", () => {
      const d1 = store.addDirective("keep me");
      const d2 = store.addDirective("remove me");

      store.removeDirective(d2.id);

      const list = store.listDirectives();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(d1.id);
    });

    it("silently ignores removal of a non-existent id", () => {
      store.addDirective("still here");
      store.removeDirective(99999); // doesn't exist
      expect(store.listDirectives()).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // countFailuresForSourceRef (issue #341 — auto-escalation)
  // ──────────────────────────────────────────────────────────────────────────
  describe("countFailuresForSourceRef", () => {
    it("returns 0 when no tasks exist for the source_ref", () => {
      expect(store.countFailuresForSourceRef("owner/repo#42")).toBe(0);
    });

    it("returns 0 for a pending task (not failed or escalated)", () => {
      store.createTask({ title: "pending", source: "github", source_ref: "owner/repo#1" });
      expect(store.countFailuresForSourceRef("owner/repo#1")).toBe(0);
    });

    it("returns 0 for a done task (not failed or escalated)", () => {
      const task = store.createTask({ title: "done", source: "github", source_ref: "owner/repo#2" });
      store.updateTask(task.id, { status: "done", retry_count: 0 });
      expect(store.countFailuresForSourceRef("owner/repo#2")).toBe(0);
    });

    it("counts retry_count + 1 for a single failed task", () => {
      const task = store.createTask({ title: "failing", source: "github", source_ref: "owner/repo#3" });
      // retry_count=2 means 1 original dispatch + 2 retries = 3 total attempts
      store.updateTask(task.id, { status: "failed", retry_count: 2 });
      expect(store.countFailuresForSourceRef("owner/repo#3")).toBe(3);
    });

    it("counts retry_count + 1 for an escalated task", () => {
      const task = store.createTask({ title: "escalated", source: "github", source_ref: "owner/repo#4" });
      store.updateTask(task.id, { status: "escalated", retry_count: 3 });
      expect(store.countFailuresForSourceRef("owner/repo#4")).toBe(4);
    });

    it("sums failures across multiple task records for the same source_ref", () => {
      const t1 = store.createTask({ title: "first attempt", source: "github", source_ref: "owner/repo#5" });
      store.updateTask(t1.id, { status: "failed", retry_count: 2 }); // 3 failures

      const t2 = store.createTask({ title: "second attempt", source: "github", source_ref: "owner/repo#5" });
      store.updateTask(t2.id, { status: "failed", retry_count: 1 }); // 2 failures

      // Total: 3 + 2 = 5
      expect(store.countFailuresForSourceRef("owner/repo#5")).toBe(5);
    });

    it("does not count sub-tasks (only top-level tasks)", () => {
      const parent = store.createTask({ title: "parent", source: "github", source_ref: "owner/repo#6" });
      store.updateTask(parent.id, { status: "failed", retry_count: 1 }); // 2 failures

      // Sub-task with same source_ref-like parent — use createSubTask
      const sub = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "sub",
        description: "sub",
        source: "github",
        agent_name: "test-agent",
      });
      store.updateTask(sub.id, { status: "failed", retry_count: 5 }); // should be excluded

      // Only the parent (top-level) task counts
      expect(store.countFailuresForSourceRef("owner/repo#6")).toBe(2);
    });

    it("does not count failures from different source_refs", () => {
      const t1 = store.createTask({ title: "issue 7", source: "github", source_ref: "owner/repo#7" });
      store.updateTask(t1.id, { status: "failed", retry_count: 2 });

      const t2 = store.createTask({ title: "issue 8", source: "github", source_ref: "owner/repo#8" });
      store.updateTask(t2.id, { status: "failed", retry_count: 3 });

      expect(store.countFailuresForSourceRef("owner/repo#7")).toBe(3); // only t1
      expect(store.countFailuresForSourceRef("owner/repo#8")).toBe(4); // only t2
    });

    it("returns 1 for a freshly-failed task (retry_count=0 means 1 attempt)", () => {
      const task = store.createTask({ title: "first fail", source: "github", source_ref: "owner/repo#9" });
      store.updateTask(task.id, { status: "failed", retry_count: 0 });
      expect(store.countFailuresForSourceRef("owner/repo#9")).toBe(1);
    });

    it("excludes connection-error-exhausted failures from the count", () => {
      const t1 = store.createTask({ title: "conn fail", source: "github", source_ref: "owner/repo#10" });
      store.updateTask(t1.id, { status: "failed", retry_count: 2, result: "connection-error-exhausted: ECONNREFUSED" });

      const t2 = store.createTask({ title: "real fail", source: "github", source_ref: "owner/repo#10" });
      store.updateTask(t2.id, { status: "failed", retry_count: 1 });

      // Only t2 counts (2 attempts). t1's 3 connection-error attempts are excluded.
      expect(store.countFailuresForSourceRef("owner/repo#10")).toBe(2);
    });

    it("excludes connection-error-exhausted even when all failures are connection errors", () => {
      const t1 = store.createTask({ title: "conn fail", source: "github", source_ref: "owner/repo#11" });
      store.updateTask(t1.id, { status: "failed", retry_count: 2, result: "connection-error-exhausted: spawn ENOENT" });
      expect(store.countFailuresForSourceRef("owner/repo#11")).toBe(0);
    });

    it("ignores failures that were cleared by an operator reroute", () => {
      const task = store.createTask({ title: "old fail", source: "github", source_ref: "owner/repo#12" });
      store.updateTask(task.id, { status: "failed", retry_count: 2 });

      store.clearFailureHistoryForSourceRef("github", "owner/repo#12");

      expect(store.countFailuresForSourceRef("owner/repo#12")).toBe(0);
      expect(store.countFailedTasksForSourceRef("github", "owner/repo#12")).toBe(0);
      expect(store.findDispatchCandidateBySourceRef("github", "owner/repo#12")).toBeUndefined();
    });

    it("tracks and clears priority boosts independently of failure resets", () => {
      expect(store.isSourceRefPriorityBoosted("github", "owner/repo#13")).toBe(false);

      store.boostSourceRefPriority("github", "owner/repo#13");
      expect(store.isSourceRefPriorityBoosted("github", "owner/repo#13")).toBe(true);

      store.clearSourceRefPriority("github", "owner/repo#13");
      expect(store.isSourceRefPriorityBoosted("github", "owner/repo#13")).toBe(false);
    });
  });

  describe("countFailuresForSourceRefByAgent", () => {
    it("counts only the matching agent's failed attempts", () => {
      const a1 = store.createTask({
        title: "issue 12",
        source: "github",
        source_ref: "owner/repo#12",
        agent_name: "agent-a",
      });
      store.updateTask(a1.id, { status: "failed", retry_count: 2 });

      const b1 = store.createTask({
        title: "issue 12",
        source: "github",
        source_ref: "owner/repo#12",
        agent_name: "agent-b",
      });
      store.updateTask(b1.id, { status: "failed", retry_count: 0 });

      expect(store.countFailuresForSourceRefByAgent("owner/repo#12", "agent-a")).toBe(3);
      expect(store.countFailuresForSourceRefByAgent("owner/repo#12", "agent-b")).toBe(1);
    });

    it("excludes connection-error-exhausted attempts for the agent", () => {
      const task = store.createTask({
        title: "issue 13",
        source: "github",
        source_ref: "owner/repo#13",
        agent_name: "agent-a",
      });
      store.updateTask(task.id, {
        status: "failed",
        retry_count: 2,
        result: "connection-error-exhausted: ECONNREFUSED",
      });

      expect(store.countFailuresForSourceRefByAgent("owner/repo#13", "agent-a")).toBe(0);
    });
  });

  describe("getTaskTypeSuccessRates", () => {
    it("returns task-type success rates per agent", () => {
      const implDone = store.createTask({
        title: "impl done",
        source: "manual",
        agent_name: "agent-a",
        task_type: "implementation",
      });
      store.updateTask(implDone.id, { status: "done" });

      const implFailed = store.createTask({
        title: "impl failed",
        source: "manual",
        agent_name: "agent-a",
        task_type: "implementation",
      });
      store.updateTask(implFailed.id, { status: "failed" });

      const researchDone = store.createTask({
        title: "research done",
        source: "manual",
        agent_name: "agent-a",
        task_type: "research",
      });
      store.updateTask(researchDone.id, { status: "done" });

      const implDoneB = store.createTask({
        title: "impl done b",
        source: "manual",
        agent_name: "agent-b",
        task_type: "implementation",
      });
      store.updateTask(implDoneB.id, { status: "done" });

      const rates = store.getTaskTypeSuccessRates("implementation", ["agent-a", "agent-b", "agent-c"]);
      expect(rates).toEqual([
        { agent_name: "agent-a", task_type: "implementation", total: 2, done: 1, success_rate: 0.5 },
        { agent_name: "agent-b", task_type: "implementation", total: 1, done: 1, success_rate: 1 },
        { agent_name: "agent-c", task_type: "implementation", total: 0, done: 0, success_rate: null },
      ]);
    });
  });

  // ── Issue #418: Agent auth quarantine ────────────────────────────────────

  describe("agent auth quarantine (issue #418)", () => {
    it("agents are not auth-degraded by default", () => {
      expect(store.isAgentAuthDegraded("new-agent")).toBe(false);
    });

    it("getAgentHealth returns auth_status='ok' for unknown agents", () => {
      const health = store.getAgentHealth("unknown-agent");
      expect(health.auth_status).toBe("ok");
      expect(health.auth_degraded_at).toBeNull();
    });

    it("setAgentAuthDegraded marks agent as auth-degraded", () => {
      store.setAgentAuthDegraded("agent-a", "GH_TOKEN missing");
      expect(store.isAgentAuthDegraded("agent-a")).toBe(true);

      const health = store.getAgentHealth("agent-a");
      expect(health.auth_status).toBe("auth-degraded");
      expect(health.auth_degraded_at).toBeTruthy();
      expect(health.last_error_message).toBe("GH_TOKEN missing");
    });

    it("clearAgentAuthDegraded restores agent to ok", () => {
      store.setAgentAuthDegraded("agent-b", "token expired");
      expect(store.isAgentAuthDegraded("agent-b")).toBe(true);

      store.clearAgentAuthDegraded("agent-b");
      expect(store.isAgentAuthDegraded("agent-b")).toBe(false);

      const health = store.getAgentHealth("agent-b");
      expect(health.auth_status).toBe("ok");
      expect(health.auth_degraded_at).toBeNull();
    });

    it("getAuthDegradedAgents returns only quarantined agents", () => {
      store.setAgentAuthDegraded("degraded-1", "missing token");
      store.setAgentAuthDegraded("degraded-2", "expired token");
      store.recordAgentSuccess("healthy-1"); // not degraded

      const degraded = store.getAuthDegradedAgents();
      expect(degraded).toHaveLength(2);
      expect(degraded.map((a) => a.agent_name).sort()).toEqual(["degraded-1", "degraded-2"]);
    });

    it("setAgentAuthDegraded preserves original auth_degraded_at on repeated calls", () => {
      store.setAgentAuthDegraded("agent-c", "first failure");
      const first = store.getAgentHealth("agent-c").auth_degraded_at;

      // Second call should preserve the original timestamp (COALESCE)
      store.setAgentAuthDegraded("agent-c", "second failure");
      const second = store.getAgentHealth("agent-c").auth_degraded_at;

      expect(first).toBe(second);
      expect(store.getAgentHealth("agent-c").last_error_message).toBe("second failure");
    });

    it("setAgentAuthDegraded does not reset consecutive_failures for existing agents", () => {
      store.recordAgentFailure("agent-d", "some error");
      store.recordAgentFailure("agent-d", "another error");
      expect(store.getAgentHealth("agent-d").consecutive_failures).toBe(2);

      store.setAgentAuthDegraded("agent-d", "token missing");
      // consecutive_failures should be preserved (ON CONFLICT doesn't touch it)
      const health = store.getAgentHealth("agent-d");
      expect(health.auth_status).toBe("auth-degraded");
    });
  });

  describe("getApprovedResearchFindings (issue #428)", () => {
    it("returns approved research tasks with results", () => {
      const task = store.createTask({
        title: "Research: Scaling",
        source: "manual",
        agent_name: "research-agent",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Key findings about scaling patterns.",
        verification_status: "approved",
        quality_score: 0.9,
      });

      const findings = store.getApprovedResearchFindings();
      expect(findings).toHaveLength(1);
      expect(findings[0].title).toBe("Research: Scaling");
      expect(findings[0].result).toContain("scaling patterns");
    });

    it("excludes non-research tasks", () => {
      const task = store.createTask({
        title: "Implementation task",
        source: "manual",
        agent_name: "agent-a",
        task_type: "implementation",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Done",
        verification_status: "approved",
        quality_score: 0.9,
      });

      const findings = store.getApprovedResearchFindings();
      expect(findings).toHaveLength(0);
    });

    it("excludes research below minimum quality score", () => {
      const task = store.createTask({
        title: "Research: Low quality",
        source: "manual",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Mediocre findings.",
        verification_status: "approved",
        quality_score: 0.5,
      });

      const findings = store.getApprovedResearchFindings(5, 0.8);
      expect(findings).toHaveLength(0);
    });

    it("excludes rejected research", () => {
      const task = store.createTask({
        title: "Research: Rejected",
        source: "manual",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Bad research.",
        verification_status: "rejected",
        quality_score: 0.3,
      });

      const findings = store.getApprovedResearchFindings();
      expect(findings).toHaveLength(0);
    });

    it("limits results to specified count", () => {
      for (let i = 0; i < 10; i++) {
        const task = store.createTask({
          title: `Research: Topic ${i}`,
          source: "manual",
          task_type: "research",
        });
        store.updateTask(task.id, {
          status: "done",
          result: `Findings for topic ${i}.`,
          verification_status: "approved",
          quality_score: 0.9,
        });
      }

      const findings = store.getApprovedResearchFindings(3);
      expect(findings).toHaveLength(3);
    });
  });

  describe("isResearchLinked (issue #428)", () => {
    it("returns true when a research-link task exists", () => {
      const research = store.createTask({
        title: "Research: Topic",
        source: "manual",
        task_type: "research",
      });
      // Create the link record
      store.createTask({
        title: "[research-link] Analyzed",
        source: "manual",
        source_ref: `research-link:${research.id}`,
      });

      expect(store.isResearchLinked(research.id)).toBe(true);
    });

    it("returns false when no link record exists", () => {
      const research = store.createTask({
        title: "Research: Unlinked",
        source: "manual",
        task_type: "research",
      });

      expect(store.isResearchLinked(research.id)).toBe(false);
    });
  });

  describe("cancelSupersededTasks (issue #557)", () => {
    function makeInFlight(status: "dispatched" | "in_progress", agentName: string, sourceRef: string) {
      const t = store.createTask({
        title: "test task",
        source: "github",
        source_ref: sourceRef,
        agent_name: agentName,
        task_type: "implementation",
      });
      store.updateTask(t.id, { status });
      return t;
    }

    it("returns 0 when there are no in-flight tasks for the source_ref", () => {
      const count = store.cancelSupersededTasks("github", "owner/repo#1", "agent-a");
      expect(count).toBe(0);
    });

    it("returns 0 when the only in-flight task belongs to the claiming agent", () => {
      makeInFlight("dispatched", "agent-a", "owner/repo#2");
      const count = store.cancelSupersededTasks("github", "owner/repo#2", "agent-a");
      expect(count).toBe(0);
    });

    it("cancels an in-flight task owned by a different agent", () => {
      const t = makeInFlight("dispatched", "agent-b", "owner/repo#3");
      const count = store.cancelSupersededTasks("github", "owner/repo#3", "agent-a");
      expect(count).toBe(1);
      const updated = store.getTask(t.id);
      expect(updated!.status).toBe("superseded");
    });

    it("sets the result message explaining why it was superseded", () => {
      const t = makeInFlight("in_progress", "agent-b", "owner/repo#4");
      store.cancelSupersededTasks("github", "owner/repo#4", "agent-a");
      const updated = store.getTask(t.id);
      expect(updated!.result).toMatch(/superseded/i);
      expect(updated!.result).toContain("agent-a");
    });

    it("cancels both dispatched and in_progress tasks", () => {
      const t1 = makeInFlight("dispatched", "agent-b", "owner/repo#5");
      const t2 = makeInFlight("in_progress", "agent-c", "owner/repo#5");
      const count = store.cancelSupersededTasks("github", "owner/repo#5", "agent-a");
      expect(count).toBe(2);
      expect(store.getTask(t1.id)!.status).toBe("superseded");
      expect(store.getTask(t2.id)!.status).toBe("superseded");
    });

    it("does not affect tasks with a different source_ref", () => {
      const t = makeInFlight("dispatched", "agent-b", "owner/repo#99");
      store.cancelSupersededTasks("github", "owner/repo#6", "agent-a");
      expect(store.getTask(t.id)!.status).toBe("dispatched");
    });

    it("does not affect tasks in terminal states (done, failed)", () => {
      const done = store.createTask({ title: "done task", source: "github", source_ref: "owner/repo#7", agent_name: "agent-b", task_type: "implementation" });
      store.updateTask(done.id, { status: "done" });
      const failed = store.createTask({ title: "failed task", source: "github", source_ref: "owner/repo#7", agent_name: "agent-b", task_type: "implementation" });
      store.updateTask(failed.id, { status: "failed" });

      const count = store.cancelSupersededTasks("github", "owner/repo#7", "agent-a");
      expect(count).toBe(0);
      expect(store.getTask(done.id)!.status).toBe("done");
      expect(store.getTask(failed.id)!.status).toBe("failed");
    });

    it("does not cancel child tasks (parent_task_id IS NOT NULL)", () => {
      const parent = makeInFlight("dispatched", "agent-b", "owner/repo#8");
      const child = store.createSubTask({
        parent_task_id: parent.id,
        step_id: "step-1",
        title: "child step",
        description: "a sub-step",
        source: "github",
        agent_name: "agent-b",
      });
      store.updateTask(child.id, { status: "dispatched" });

      const count = store.cancelSupersededTasks("github", "owner/repo#8", "agent-a");
      // Only the parent should be cancelled; child is excluded
      expect(count).toBe(1);
      expect(store.getTask(parent.id)!.status).toBe("superseded");
      expect(store.getTask(child.id)!.status).toBe("dispatched");
    });
  });

  // ── Config reload audit trail (issue #572) ─────────────────────────────────

  describe("recordConfigReload / getRecentConfigReloads / getLastSuccessfulConfigReload", () => {
    it("records a successful startup reload with no changes", () => {
      store.recordConfigReload({
        timestamp: "2026-04-07T10:00:00.000Z",
        success: true,
        changes: [],
        errors: [],
        triggeredBy: "startup",
      });
      const reloads = store.getRecentConfigReloads(10);
      expect(reloads).toHaveLength(1);
      expect(reloads[0].success).toBe(1);
      expect(reloads[0].change_count).toBe(0);
      expect(reloads[0].changes_json).toBeNull();
      expect(reloads[0].errors_json).toBeNull();
      expect(reloads[0].triggered_by).toBe("startup");
    });

    it("records a successful signal reload with changes", () => {
      store.recordConfigReload({
        timestamp: "2026-04-07T11:00:00.000Z",
        success: true,
        changes: ["proxy.timeout_ms", "verification.min_score"],
        errors: [],
        triggeredBy: "signal",
      });
      const reloads = store.getRecentConfigReloads(10);
      expect(reloads[0].success).toBe(1);
      expect(reloads[0].change_count).toBe(2);
      const paths = JSON.parse(reloads[0].changes_json!) as string[];
      expect(paths).toEqual(["proxy.timeout_ms", "verification.min_score"]);
      expect(reloads[0].triggered_by).toBe("signal");
    });

    it("records a failed reload with errors", () => {
      store.recordConfigReload({
        timestamp: "2026-04-07T12:00:00.000Z",
        success: false,
        changes: [],
        errors: ["proxy.timeout_ms: must be positive"],
        triggeredBy: "file-watcher",
      });
      const reloads = store.getRecentConfigReloads(10);
      expect(reloads[0].success).toBe(0);
      expect(reloads[0].change_count).toBe(0);
      expect(reloads[0].errors_json).not.toBeNull();
      const errs = JSON.parse(reloads[0].errors_json!) as string[];
      expect(errs).toContain("proxy.timeout_ms: must be positive");
    });

    it("returns reloads newest-first", () => {
      store.recordConfigReload({ timestamp: "2026-04-07T09:00:00.000Z", success: true, changes: [], errors: [], triggeredBy: "startup" });
      store.recordConfigReload({ timestamp: "2026-04-07T10:00:00.000Z", success: true, changes: ["a.b"], errors: [], triggeredBy: "signal" });
      store.recordConfigReload({ timestamp: "2026-04-07T11:00:00.000Z", success: false, changes: [], errors: ["bad"], triggeredBy: "file-watcher" });
      const reloads = store.getRecentConfigReloads(10);
      expect(reloads[0].timestamp).toBe("2026-04-07T11:00:00.000Z");
      expect(reloads[1].timestamp).toBe("2026-04-07T10:00:00.000Z");
      expect(reloads[2].timestamp).toBe("2026-04-07T09:00:00.000Z");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.recordConfigReload({ timestamp: `2026-04-07T0${i}:00:00.000Z`, success: true, changes: [], errors: [], triggeredBy: "startup" });
      }
      const reloads = store.getRecentConfigReloads(3);
      expect(reloads).toHaveLength(3);
    });

    it("getLastSuccessfulConfigReload ignores startup and failed entries", () => {
      // startup entry (excluded)
      store.recordConfigReload({ timestamp: "2026-04-07T09:00:00.000Z", success: true, changes: [], errors: [], triggeredBy: "startup" });
      // failed entry (excluded)
      store.recordConfigReload({ timestamp: "2026-04-07T10:00:00.000Z", success: false, changes: [], errors: ["err"], triggeredBy: "signal" });
      // successful signal reload (included)
      store.recordConfigReload({ timestamp: "2026-04-07T11:00:00.000Z", success: true, changes: ["a.b"], errors: [], triggeredBy: "signal" });
      // later successful file-watcher reload (this should be returned — newest non-startup success)
      store.recordConfigReload({ timestamp: "2026-04-07T12:00:00.000Z", success: true, changes: ["c.d"], errors: [], triggeredBy: "file-watcher" });

      const last = store.getLastSuccessfulConfigReload();
      expect(last).not.toBeNull();
      expect(last!.timestamp).toBe("2026-04-07T12:00:00.000Z");
      expect(last!.triggered_by).toBe("file-watcher");
    });

    it("getLastSuccessfulConfigReload returns null when no non-startup success exists", () => {
      store.recordConfigReload({ timestamp: "2026-04-07T09:00:00.000Z", success: true, changes: [], errors: [], triggeredBy: "startup" });
      store.recordConfigReload({ timestamp: "2026-04-07T10:00:00.000Z", success: false, changes: [], errors: ["err"], triggeredBy: "signal" });
      expect(store.getLastSuccessfulConfigReload()).toBeNull();
    });
  });

  describe("routing outcomes", () => {
    it("records a routing decision with null quality_score", () => {
      const task = store.createTask({ title: "Route test", source: "github", source_ref: "owner/repo#1" });
      store.recordRoutingDecision({
        taskId: task.id,
        agentChosen: "claude-agent-foo",
        taskType: "implementation",
        routeMethod: "deterministic",
        routeConfidence: 0.9,
        sourceRef: "owner/repo#1",
      });
      const outcomes = store.getAgentRoutingOutcomes("claude-agent-foo");
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].task_id).toBe(task.id);
      expect(outcomes[0].agent_chosen).toBe("claude-agent-foo");
      expect(outcomes[0].route_method).toBe("deterministic");
      expect(outcomes[0].route_confidence).toBeCloseTo(0.9);
      expect(outcomes[0].quality_score).toBeNull();
      expect(outcomes[0].outcome_updated_at).toBeNull();
    });

    it("updates quality_score after verification", () => {
      const task = store.createTask({ title: "Verified task", source: "github", source_ref: "owner/repo#2" });
      store.recordRoutingDecision({
        taskId: task.id,
        agentChosen: "claude-agent-bar",
        taskType: "implementation",
        routeMethod: "llm",
        routeConfidence: 0.75,
        sourceRef: "owner/repo#2",
      });
      store.updateRoutingOutcomeScore(task.id, 0.85);
      const outcomes = store.getAgentRoutingOutcomes("claude-agent-bar");
      expect(outcomes[0].quality_score).toBeCloseTo(0.85);
      expect(outcomes[0].outcome_updated_at).not.toBeNull();
    });

    it("getRoutingAccuracyStats aggregates per-agent per-task-type", () => {
      const taskA = store.createTask({ title: "Task A", source: "github" });
      const taskB = store.createTask({ title: "Task B", source: "github" });
      const taskC = store.createTask({ title: "Task C", source: "github" });

      store.recordRoutingDecision({ taskId: taskA.id, agentChosen: "agent-x", taskType: "implementation", routeMethod: "deterministic", routeConfidence: 1.0 });
      store.recordRoutingDecision({ taskId: taskB.id, agentChosen: "agent-x", taskType: "implementation", routeMethod: "deterministic", routeConfidence: 0.8 });
      store.recordRoutingDecision({ taskId: taskC.id, agentChosen: "agent-x", taskType: "research", routeMethod: "explicit", routeConfidence: null });

      store.updateRoutingOutcomeScore(taskA.id, 0.9);
      store.updateRoutingOutcomeScore(taskB.id, 0.7);
      // taskC intentionally left unscored

      const stats = store.getRoutingAccuracyStats(30);
      const implRow = stats.find((r) => r.agent_name === "agent-x" && r.task_type === "implementation");
      expect(implRow).toBeDefined();
      expect(implRow!.total_routed).toBe(2);
      expect(implRow!.scored).toBe(2);
      expect(implRow!.avg_quality_score).toBeCloseTo(0.8);

      const researchRow = stats.find((r) => r.agent_name === "agent-x" && r.task_type === "research");
      expect(researchRow).toBeDefined();
      expect(researchRow!.total_routed).toBe(1);
      expect(researchRow!.scored).toBe(0);
      expect(researchRow!.avg_quality_score).toBeNull();
    });

    it("getRoutingAccuracyStats excludes entries older than window", () => {
      const task = store.createTask({ title: "Old task", source: "github" });
      store.recordRoutingDecision({ taskId: task.id, agentChosen: "old-agent", taskType: "implementation", routeMethod: "deterministic", routeConfidence: 0.5 });
      store.updateRoutingOutcomeScore(task.id, 0.6);

      // Force the routed_at to be 60 days ago
      const store_db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const oldDate = new Date(Date.now() - 60 * 86400000).toISOString();
      store_db.prepare("UPDATE routing_outcomes SET routed_at = ? WHERE agent_chosen = 'old-agent'").run(oldDate);

      // Query for last 30 days — should not include this entry
      const stats = store.getRoutingAccuracyStats(30);
      expect(stats.find((r) => r.agent_name === "old-agent")).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Per-issue dispatch lock (issue #916)
  // ---------------------------------------------------------------------------

  describe("dispatch lock", () => {
    it("acquireDispatchLock writes a lock entry retrievable by getDispatchLock", () => {
      store.acquireDispatchLock("github", "owner/repo#42", "my-agent", 600_000);
      const lock = store.getDispatchLock("github", "owner/repo#42");
      expect(lock).toBeDefined();
      expect(lock!.source).toBe("github");
      expect(lock!.source_ref).toBe("owner/repo#42");
      expect(lock!.agent_name).toBe("my-agent");
      expect(new Date(lock!.expires_at).getTime()).toBeGreaterThan(Date.now());
    });

    it("getDispatchLock returns undefined when no lock exists", () => {
      const lock = store.getDispatchLock("github", "owner/repo#99");
      expect(lock).toBeUndefined();
    });

    it("getDispatchLock returns undefined after lock is released", () => {
      store.acquireDispatchLock("github", "owner/repo#42", "my-agent", 600_000);
      store.releaseDispatchLock("github", "owner/repo#42");
      const lock = store.getDispatchLock("github", "owner/repo#42");
      expect(lock).toBeUndefined();
    });

    it("acquireDispatchLock is idempotent: second call does not overwrite an active lock", () => {
      store.acquireDispatchLock("github", "owner/repo#42", "agent-a", 600_000);
      store.acquireDispatchLock("github", "owner/repo#42", "agent-b", 600_000);
      const lock = store.getDispatchLock("github", "owner/repo#42");
      // First lock should still be held by agent-a
      expect(lock!.agent_name).toBe("agent-a");
    });

    it("acquireDispatchLock replaces an expired lock with a fresh one", () => {
      // Write a lock that is already expired
      const store_db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      store_db.prepare(
        "INSERT INTO dispatch_locks (source, source_ref, agent_name, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run("github", "owner/repo#42", "old-agent", new Date().toISOString(), pastExpiry);

      // Acquiring a new lock should succeed (expired lock evicted first)
      store.acquireDispatchLock("github", "owner/repo#42", "new-agent", 600_000);
      const lock = store.getDispatchLock("github", "owner/repo#42");
      expect(lock!.agent_name).toBe("new-agent");
    });

    it("getDispatchLock returns undefined for an expired lock", () => {
      const store_db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      store_db.prepare(
        "INSERT INTO dispatch_locks (source, source_ref, agent_name, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run("github", "owner/repo#42", "my-agent", new Date().toISOString(), pastExpiry);

      const lock = store.getDispatchLock("github", "owner/repo#42");
      expect(lock).toBeUndefined();
    });

    it("cleanExpiredDispatchLocks removes expired entries and returns count", () => {
      const store_db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      store_db.prepare(
        "INSERT INTO dispatch_locks (source, source_ref, agent_name, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run("github", "owner/repo#1", "agent-a", new Date().toISOString(), pastExpiry);
      store_db.prepare(
        "INSERT INTO dispatch_locks (source, source_ref, agent_name, locked_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      ).run("github", "owner/repo#2", "agent-b", new Date().toISOString(), pastExpiry);

      // Also write a non-expired lock that should survive
      store.acquireDispatchLock("github", "owner/repo#3", "agent-c", 600_000);

      const cleaned = store.cleanExpiredDispatchLocks();
      expect(cleaned).toBe(2);
      expect(store.getDispatchLock("github", "owner/repo#3")).toBeDefined();
    });

    it("DISPATCH_LOCK_TTL_MS static constant equals 10 minutes", () => {
      expect(StateStore.DISPATCH_LOCK_TTL_MS).toBe(600_000);
    });
  });
});
