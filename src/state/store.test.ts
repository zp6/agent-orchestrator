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

  describe("processed triggers", () => {
    it("tracks processed triggers", () => {
      const t = store.createTask({ title: "A", source: "github" });
      expect(store.isProcessed("github", "repo#1")).toBe(false);
      store.markProcessed("github", "repo#1", t.id);
      expect(store.isProcessed("github", "repo#1")).toBe(true);
    });
  });
});
