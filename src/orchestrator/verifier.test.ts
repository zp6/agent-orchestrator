import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Verifier } from "./verifier.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const mockCreate = vi.fn();
const mockDispatch = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

// Use a regular function (not arrow) so `new Dispatcher()` works as a constructor
vi.mock("./dispatcher.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Dispatcher: function MockDispatcher(this: any) {
    this.dispatch = mockDispatch;
  },
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {},
};

describe("Verifier", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `orch-verify-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("approves high-quality work", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: true, score: 0.9, notes: "Excellent work" }) }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "I did the thing" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.9);

    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBe("approved");
    expect(updated?.quality_score).toBe(0.9);
  });

  it("rejects low-quality work with revision suggestion", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.3, notes: "Incomplete", revision: "Add error handling" }) }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "Partial result" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(false);
    expect(result.revision).toBe("Add error handling");

    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBe("rejected");
  });

  it("handles malformed verification response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "test" });
    store.updateTask(task.id, { status: "done", result: "Result" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verify(task.id);

    expect(result.approved).toBe(false);
    expect(result.score).toBe(0);
  });

  it("throws for non-existent task", async () => {
    const verifier = new Verifier(config, store);
    await expect(verifier.verify("nonexistent")).rejects.toThrow("Task not found");
  });

  it("throws for non-done task", async () => {
    const task = store.createTask({ title: "Test", source: "manual" });

    const verifier = new Verifier(config, store);
    await expect(verifier.verify(task.id)).rejects.toThrow("not done");
  });

  describe("verifyAndRevise — capacity guard", () => {
    it("defers verification when the agent already has an active (dispatched) task", async () => {
      // Create the task to verify (done)
      const done = store.createTask({
        title: "Done task",
        description: "Do something",
        source: "manual",
        agent_name: "busy-agent",
      });
      store.updateTask(done.id, { status: "done", result: "Result" });

      // Create another task for the same agent that is still dispatched
      const active = store.createTask({
        title: "Active task",
        source: "manual",
        agent_name: "busy-agent",
      });
      store.updateTask(active.id, { status: "dispatched" });

      const verifier = new Verifier(config, store);
      const result = await verifier.verifyAndRevise(done.id);

      // Should return deferred sentinel without running the LLM
      expect(result.notes).toBe("Deferred: agent busy");
      expect(result.approved).toBe(false);
      expect(mockCreate).not.toHaveBeenCalled();

      // verification_status must remain NULL so the daemon retries next cycle
      const updated = store.getTask(done.id);
      expect(updated?.verification_status).toBeNull();
    });

    it("defers verification when the agent already has an active (in_progress) task", async () => {
      const done = store.createTask({
        title: "Done task",
        description: "Do something",
        source: "manual",
        agent_name: "busy-agent",
      });
      store.updateTask(done.id, { status: "done", result: "Result" });

      const active = store.createTask({
        title: "Active task",
        source: "manual",
        agent_name: "busy-agent",
      });
      store.updateTask(active.id, { status: "in_progress" });

      const verifier = new Verifier(config, store);
      const result = await verifier.verifyAndRevise(done.id);

      expect(result.notes).toBe("Deferred: agent busy");
      expect(mockCreate).not.toHaveBeenCalled();

      const updated = store.getTask(done.id);
      expect(updated?.verification_status).toBeNull();
    });

    it("proceeds with verification when the agent is idle (only done tasks)", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ approved: true, score: 0.95, notes: "Great" }) }],
      });

      const done = store.createTask({
        title: "Done task",
        description: "Do something",
        source: "manual",
        agent_name: "idle-agent",
      });
      store.updateTask(done.id, { status: "done", result: "Result" });

      const verifier = new Verifier(config, store);
      const result = await verifier.verifyAndRevise(done.id);

      expect(result.approved).toBe(true);
      expect(result.score).toBe(0.95);
      expect(mockCreate).toHaveBeenCalledTimes(1);

      const updated = store.getTask(done.id);
      expect(updated?.verification_status).toBe("approved");
    });
  });
});

describe("Verifier.verifyAndRevise — retry mechanism", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    // Reset queued return values (mockResolvedValueOnce) as well as call counts
    mockCreate.mockReset();
    mockDispatch.mockReset();
    dbPath = join(tmpdir(), `orch-retry-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("resets verification_status to null when agent is busy (capacity guard)", async () => {
    // Verifier LLM says: rejected with revision guidance
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.4, notes: "Incomplete", revision: "Add error handling" }) }],
    });

    const task = store.createTask({ title: "Test task", description: "Do something", source: "manual", agent_name: "busy-agent" });
    store.updateTask(task.id, { status: "done", result: "Partial work" });

    // Spy on hasActiveTask so that:
    //   - pre-verify check (first call): returns false → lets the LLM run
    //   - post-verify check (second call): returns true → defers revision dispatch
    // This tests the post-verify capacity guard (the pre-verify guard is covered by
    // the "verifyAndRevise — capacity guard" describe block above).
    const hasActiveTaskSpy = vi.spyOn(store, "hasActiveTask")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const verifier = new Verifier(config, store);
    const result = await verifier.verifyAndRevise(task.id);

    // Returns the rejected result so caller knows the quality
    expect(result.approved).toBe(false);
    expect(result.revision).toBe("Add error handling");

    // But verification_status is reset to null so the daemon retries next cycle
    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBeNull();

    // Dispatcher should NOT have been called (agent was busy)
    expect(mockDispatch).not.toHaveBeenCalled();

    hasActiveTaskSpy.mockRestore();
  });

  it("resets verification_status to null on transient dispatch failure", async () => {
    // Verifier LLM says: rejected with revision guidance
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.3, notes: "Needs work", revision: "Fix the logic" }) }],
    });

    const task = store.createTask({ title: "Test task", description: "Do something", source: "manual", agent_name: "free-agent" });
    store.updateTask(task.id, { status: "done", result: "Partial work" });

    // No active tasks — agent is free — but dispatch throws a transient error
    mockDispatch.mockRejectedValueOnce(new Error("connection refused"));

    const verifier = new Verifier(config, store);
    const result = await verifier.verifyAndRevise(task.id);

    // Returns the rejected result
    expect(result.approved).toBe(false);
    expect(result.revision).toBe("Fix the logic");

    // verification_status reset to null for retry
    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBeNull();
  });

  it("dispatches revision and verifies when agent is free", async () => {
    // First verify call: rejected
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.4, notes: "Needs improvement", revision: "Be more thorough" }) }],
    });
    // Second verify call (on revision task): approved
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: true, score: 0.9, notes: "Much better" }) }],
    });

    const task = store.createTask({ title: "Original task", description: "Do the thing", source: "manual", agent_name: "free-agent" });
    store.updateTask(task.id, { status: "done", result: "Initial work" });

    // Simulate dispatch returning a new revision task
    const revisionTask = store.createTask({ title: "[revision] Original task", source: "manual", agent_name: "free-agent" });
    store.updateTask(revisionTask.id, { status: "done", result: "Improved work" });
    mockDispatch.mockResolvedValueOnce({ taskId: revisionTask.id });

    const verifier = new Verifier(config, store);
    const result = await verifier.verifyAndRevise(task.id);

    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.9);
    expect(mockDispatch).toHaveBeenCalledOnce();

    // Original task stays rejected (the revision task is what got approved)
    const originalTask = store.getTask(task.id);
    expect(originalTask?.verification_status).toBe("rejected");

    // Revision task is approved
    const revised = store.getTask(revisionTask.id);
    expect(revised?.verification_status).toBe("approved");
  });

  it("returns rejected result without dispatching when maxRetries is 0", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.2, notes: "Poor", revision: "Redo everything" }) }],
    });

    const task = store.createTask({ title: "Test", source: "manual", agent_name: "free-agent" });
    store.updateTask(task.id, { status: "done", result: "Bad work" });

    const verifier = new Verifier(config, store);
    const result = await verifier.verifyAndRevise(task.id, 0); // maxRetries=0 means skip revision

    expect(result.approved).toBe(false);
    expect(result.score).toBe(0.2);
    // No dispatch when maxRetries = 0
    expect(mockDispatch).not.toHaveBeenCalled();
    // Status stays rejected (no retries left — this is an intentional final rejection, not a deferral)
    const updated = store.getTask(task.id);
    expect(updated?.verification_status).toBe("rejected");
  });
});
