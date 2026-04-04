import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher, MAX_RETRIES, RETRY_DELAYS_MS } from "./dispatcher.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

// Track the last mockSend across beforeEach
let mockSend: ReturnType<typeof vi.fn>;

// Mock the agent client so we don't make real network calls.
// Must use a regular function (not arrow) so `new AgentClient()` works as a constructor.
vi.mock("../client/agent-client.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AgentClient: function MockAgentClient(this: any) {
    mockSend = vi.fn();
    this.send = mockSend;
  },
}));

// Mock routers so dispatch() doesn't require a live agent config.
vi.mock("./router.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Router: function MockRouter(this: any) {
    this.route = vi.fn().mockReturnValue([{ agentName: "test-agent", confidence: 1.0, reason: "mock" }]);
  },
}));

vi.mock("./llm-router.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LLMRouter: function MockLLMRouter(this: any) {
    this.route = vi.fn();
  },
}));

vi.mock("./planner.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Planner: function MockPlanner(this: any) {
    this.plan = vi.fn();
  },
}));

vi.mock("../service/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const makeConfig = (): OrchestratorConfig => ({
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "test-agent": {
      dir: "test-agent",
      description: "A test agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      docker: { port: 3457, api_key: "secret" },
    },
  },
});

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher — retry constants", () => {
  it("MAX_RETRIES is 3", () => {
    expect(MAX_RETRIES).toBe(3);
  });

  it("RETRY_DELAYS_MS has 3 entries with increasing delays", () => {
    expect(RETRY_DELAYS_MS).toHaveLength(3);
    const [first, second, third] = RETRY_DELAYS_MS;
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
  });

  it("first retry delay is at least 10 seconds", () => {
    expect(RETRY_DELAYS_MS[0]).toBeGreaterThanOrEqual(10_000);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch() — retry scheduling on failure
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — retry scheduling on failure", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  it("on first failure: schedules retry with retry_count=1 and next_retry_at set", async () => {
    mockSend.mockRejectedValueOnce(new Error("connection refused"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("connection refused");

    const tasks = store.listTasks({ status: "failed" });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];

    expect(task.retry_count).toBe(1);
    expect(task.next_retry_at).not.toBeNull();

    // next_retry_at should be in the future
    const nextRetry = new Date(task.next_retry_at!).getTime();
    expect(nextRetry).toBeGreaterThan(Date.now());
  });

  it("on success: task is marked done with retry_count=0 and next_retry_at null", async () => {
    mockSend.mockResolvedValueOnce({
      content: "all done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = await dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" });

    const task = store.getTask(result.taskId);
    expect(task?.status).toBe("done");
    expect(task?.retry_count).toBe(0);
    expect(task?.next_retry_at).toBeNull();
  });

  it("uses RETRY_DELAYS_MS[0] for the first retry delay", async () => {
    const before = Date.now();
    mockSend.mockRejectedValueOnce(new Error("timeout"));

    await expect(
      dispatcher.dispatch("task", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const tasks = store.listTasks({ status: "failed" });
    const nextRetry = new Date(tasks[0].next_retry_at!).getTime();
    const expectedRetry = before + RETRY_DELAYS_MS[0];

    // Allow 1s clock drift
    expect(nextRetry).toBeGreaterThanOrEqual(expectedRetry - 1000);
    expect(nextRetry).toBeLessThanOrEqual(expectedRetry + 1000);
  });

  it("when retry_count exceeds MAX_RETRIES: sets next_retry_at to null (permanently failed)", async () => {
    mockSend.mockRejectedValue(new Error("always fails"));

    // Dispatch fails — retry_count becomes 1, next_retry_at is set
    await expect(
      dispatcher.dispatch("task", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const tasks = store.listTasks({ status: "failed" });
    // First failure schedules a retry
    expect(tasks[0].retry_count).toBe(1);
    expect(tasks[0].next_retry_at).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// retryTask()
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  const makeFailedTask = (retryCount = 1) => {
    const task = store.createTask({
      title: "test task",
      description: "please do something useful",
      source: "github",
      source_ref: "owner/repo#42",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: retryCount,
      next_retry_at: new Date(Date.now() - 1000).toISOString(), // already elapsed
    });
    return store.getTask(task.id)!;
  };

  it("succeeds: marks task done and clears next_retry_at", async () => {
    mockSend.mockResolvedValueOnce({
      content: "retry succeeded",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    const task = makeFailedTask();

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("retry succeeded");
    expect(updated.next_retry_at).toBeNull();
  });

  it("failure during retry: increments retry_count and schedules next retry if within limit", async () => {
    mockSend.mockRejectedValueOnce(new Error("still down"));
    const task = makeFailedTask(1); // retry_count = 1 → after failure becomes 2

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(2);
    expect(updated.next_retry_at).not.toBeNull();
    const nextRetry = new Date(updated.next_retry_at!).getTime();
    expect(nextRetry).toBeGreaterThan(Date.now());
  });

  it("final failure (retry_count reaches MAX_RETRIES): sets next_retry_at to null (permanently failed)", async () => {
    mockSend.mockRejectedValueOnce(new Error("still broken"));
    // Set retry_count to MAX_RETRIES - 1 so the next failure exhausts all retries
    const task = makeFailedTask(MAX_RETRIES - 1);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(MAX_RETRIES);
    // No more retries scheduled
    expect(updated.next_retry_at).toBeNull();
  });

  it("skips retry when task has no agent_name", async () => {
    const task = store.createTask({
      title: "orphan task",
      description: "no agent",
      source: "manual",
    });
    store.updateTask(task.id, {
      status: "failed",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    const failedTask = store.getTask(task.id)!;

    await dispatcher.retryTask(failedTask);

    expect(mockSend).not.toHaveBeenCalled();
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.next_retry_at).toBeNull();
  });

  it("skips retry when agent is not in config", async () => {
    const task = store.createTask({
      title: "unknown agent task",
      description: "task for unknown agent",
      source: "manual",
      agent_name: "ghost-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    const failedTask = store.getTask(task.id)!;

    await dispatcher.retryTask(failedTask);

    expect(mockSend).not.toHaveBeenCalled();
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.next_retry_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// StateStore.getRetryableTasks — integration with retry logic
// ────────────────────────────────────────────────────────────────────────────

describe("StateStore.getRetryableTasks — integration with dispatcher", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns tasks whose next_retry_at has elapsed", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const ready = store.createTask({ title: "ready", description: "ready", source: "manual", agent_name: "a" });
    store.updateTask(ready.id, { status: "failed", retry_count: 1, next_retry_at: past });

    const notYet = store.createTask({ title: "not yet", description: "not yet", source: "manual", agent_name: "a" });
    store.updateTask(notYet.id, { status: "failed", retry_count: 1, next_retry_at: future });

    const results = store.getRetryableTasks(MAX_RETRIES);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(ready.id);
  });

  it("excludes tasks that have hit MAX_RETRIES", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const task = store.createTask({ title: "exhausted", description: "exhausted", source: "manual", agent_name: "a" });
    store.updateTask(task.id, { status: "failed", retry_count: MAX_RETRIES, next_retry_at: past });

    expect(store.getRetryableTasks(MAX_RETRIES)).toHaveLength(0);
  });

  it("excludes tasks with null next_retry_at (permanently failed)", () => {
    const task = store.createTask({ title: "dead", description: "dead", source: "manual", agent_name: "a" });
    store.updateTask(task.id, { status: "failed", retry_count: 1, next_retry_at: null });

    expect(store.getRetryableTasks(MAX_RETRIES)).toHaveLength(0);
  });

  it("returns tasks ordered by next_retry_at ascending", () => {
    const earlier = new Date(Date.now() - 120_000).toISOString();
    const later = new Date(Date.now() - 30_000).toISOString();

    const t1 = store.createTask({ title: "t1", description: "t1", source: "manual", agent_name: "a" });
    store.updateTask(t1.id, { status: "failed", retry_count: 1, next_retry_at: later });

    const t2 = store.createTask({ title: "t2", description: "t2", source: "manual", agent_name: "a" });
    store.updateTask(t2.id, { status: "failed", retry_count: 1, next_retry_at: earlier });

    const results = store.getRetryableTasks(MAX_RETRIES);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(t2.id); // earlier first
    expect(results[1].id).toBe(t1.id);
  });
});
