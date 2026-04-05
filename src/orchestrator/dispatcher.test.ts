import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Dispatcher,
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  TIMEOUT_RETRY_MAX,
  TIMEOUT_RETRY_BACKOFF_MS,
  MAX_CONNECTION_RETRIES,
  CONNECTION_ERROR_RETRY_DELAYS_MS,
  isConnectionError,
  extractRepoFromSourceRef,
  buildTargetRepoHeader,
} from "./dispatcher.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

// Mock validateGhAuth so tests don't shell out.  Use importOriginal so that
// GhAuthError (and other real exports) remain accessible in tests.
vi.mock("../triggers/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../triggers/github.js")>();
  return { ...actual, validateGhAuth: vi.fn().mockReturnValue({ ok: true }) };
});

// Mock reporters so tests don't shell out to gh CLI when escalation fires.
vi.mock("../triggers/reporters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../triggers/reporters.js")>();
  return { ...actual, reportEscalation: vi.fn().mockReturnValue(false) };
});

import { reportEscalation } from "../triggers/reporters.js";
const mockReportEscalation = vi.mocked(reportEscalation);

import { validateGhAuth, GhAuthError } from "../triggers/github.js";
const mockValidateGhAuth = vi.mocked(validateGhAuth);

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

  it("TIMEOUT_RETRY_MAX is less than MAX_RETRIES (timeout policy is stricter)", () => {
    expect(TIMEOUT_RETRY_MAX).toBeLessThan(MAX_RETRIES);
  });

  it("TIMEOUT_RETRY_MAX is 2 (matches the issue spec)", () => {
    expect(TIMEOUT_RETRY_MAX).toBe(2);
  });

  it("TIMEOUT_RETRY_BACKOFF_MS is 2 minutes", () => {
    expect(TIMEOUT_RETRY_BACKOFF_MS).toBe(2 * 60 * 1000);
  });

  it("MAX_CONNECTION_RETRIES is 3", () => {
    expect(MAX_CONNECTION_RETRIES).toBe(3);
  });

  it("CONNECTION_ERROR_RETRY_DELAYS_MS has 3 entries: 30s → 60s → 120s", () => {
    expect(CONNECTION_ERROR_RETRY_DELAYS_MS).toHaveLength(3);
    const [a, b, c] = CONNECTION_ERROR_RETRY_DELAYS_MS;
    expect(a).toBe(30_000);
    expect(b).toBe(60_000);
    expect(c).toBe(120_000);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// isConnectionError()
// ────────────────────────────────────────────────────────────────────────────

describe("isConnectionError", () => {
  it("returns true for ECONNREFUSED", () => {
    expect(isConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:3457"))).toBe(true);
  });

  it("returns true for ETIMEDOUT", () => {
    expect(isConnectionError(new Error("connect ETIMEDOUT 10.0.0.1:3457"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(isConnectionError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for ENOTFOUND", () => {
    expect(isConnectionError(new Error("getaddrinfo ENOTFOUND localhost"))).toBe(true);
  });

  it("returns true for 'connection error' phrase", () => {
    expect(isConnectionError(new Error("Connection error: proxy unavailable"))).toBe(true);
  });

  it("returns true for 'connection refused' phrase", () => {
    expect(isConnectionError(new Error("Connection refused by remote host"))).toBe(true);
  });

  it("returns true for 'socket hang up'", () => {
    expect(isConnectionError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for HTTP 503 status code on error object", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(isConnectionError(err)).toBe(true);
  });

  it("returns true for HTTP 502 status code on error object", () => {
    const err = Object.assign(new Error("Bad Gateway"), { status: 502 });
    expect(isConnectionError(err)).toBe(true);
  });

  it("returns true for HTTP 500 status code on error object", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    expect(isConnectionError(err)).toBe(true);
  });

  it("returns false for a logic error message", () => {
    expect(isConnectionError(new Error("agent returned invalid output"))).toBe(false);
  });

  it("returns false for a generic 'timeout' message (not network timeout)", () => {
    expect(isConnectionError(new Error("timeout"))).toBe(false);
  });

  it("returns false for HTTP 4xx status code", () => {
    const err = Object.assign(new Error("Not Found"), { status: 404 });
    expect(isConnectionError(err)).toBe(false);
  });

  it("returns false for HTTP 401 status code", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(isConnectionError(err)).toBe(false);
  });

  it("returns false for non-Error values (string)", () => {
    expect(isConnectionError("some string error")).toBe(false);
  });

  it("returns false for exit-code-143 timeout message", () => {
    // exit 143 = SIGTERM from container timeout — handled by daemon watchdog, not here
    expect(isConnectionError(new Error("Timed out: dispatched 10 minutes ago with no response (exit 143)"))).toBe(false);
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

  it("uses CONNECTION_ERROR_RETRY_DELAYS_MS[0] for the first connection-error retry delay", async () => {
    const before = Date.now();
    // ECONNREFUSED is a connection error — should use connection-error backoff
    mockSend.mockRejectedValueOnce(new Error("ECONNREFUSED 127.0.0.1:3457"));

    await expect(
      dispatcher.dispatch("task", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const tasks = store.listTasks({ status: "failed" });
    const nextRetry = new Date(tasks[0].next_retry_at!).getTime();
    const expectedRetry = before + CONNECTION_ERROR_RETRY_DELAYS_MS[0];

    // Allow 1s clock drift
    expect(nextRetry).toBeGreaterThanOrEqual(expectedRetry - 1000);
    expect(nextRetry).toBeLessThanOrEqual(expectedRetry + 1000);
  });

  it("logic error on first dispatch: sets next_retry_at to null (no retry)", async () => {
    mockSend.mockRejectedValue(new Error("agent returned invalid output"));

    await expect(
      dispatcher.dispatch("task", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const tasks = store.listTasks({ status: "failed" });
    expect(tasks[0].retry_count).toBe(1);
    // Logic errors are NOT retried — next_retry_at stays null
    expect(tasks[0].next_retry_at).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Connection-error retry state machine (issue #367)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher — connection-error retry state machine (dispatch)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  it("connection error on first dispatch schedules retry with CONNECTION_ERROR_RETRY_DELAYS_MS[0]", async () => {
    const before = Date.now();
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("ECONNREFUSED");

    const tasks = store.listTasks({ status: "failed" });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];

    expect(task.retry_count).toBe(1);
    expect(task.next_retry_at).not.toBeNull();

    const nextRetry = new Date(task.next_retry_at!).getTime();
    const expectedRetry = before + CONNECTION_ERROR_RETRY_DELAYS_MS[0];
    expect(nextRetry).toBeGreaterThanOrEqual(expectedRetry - 1000);
    expect(nextRetry).toBeLessThanOrEqual(expectedRetry + 1000);
  });

  it("connection error on second dispatch schedules retry with CONNECTION_ERROR_RETRY_DELAYS_MS[1]", async () => {
    // Simulate a task that already has retry_count=1 (pre-set in store)
    const before = Date.now();
    mockSend.mockRejectedValueOnce(new Error("connect ETIMEDOUT 127.0.0.1:3457"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("ETIMEDOUT");

    const tasks = store.listTasks({ status: "failed" });
    const task = tasks[0];

    // Manually bump retry_count to 1, re-dispatch to simulate second failure
    store.updateTask(task.id, { retry_count: 1, status: "dispatched", next_retry_at: null });
    mockSend.mockRejectedValueOnce(new Error("connect ETIMEDOUT 127.0.0.1:3457"));

    // Use retryTask to simulate the second attempt
    await dispatcher.retryTask(store.getTask(task.id)!);

    const updatedTask = store.getTask(task.id)!;
    expect(updatedTask.retry_count).toBe(2);
    expect(updatedTask.next_retry_at).not.toBeNull();

    const nextRetry = new Date(updatedTask.next_retry_at!).getTime();
    const expectedRetry = before + CONNECTION_ERROR_RETRY_DELAYS_MS[1];
    expect(nextRetry).toBeGreaterThanOrEqual(expectedRetry - 2000);
    expect(nextRetry).toBeLessThanOrEqual(expectedRetry + 2000);
  });

  it("after MAX_CONNECTION_RETRIES connection errors: marks task failed with connection-error-exhausted", async () => {
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("ECONNREFUSED");

    const tasks = store.listTasks({ status: "failed" });
    const task = tasks[0];

    // Simulate retry_count already at MAX_CONNECTION_RETRIES - 1
    store.updateTask(task.id, {
      retry_count: MAX_CONNECTION_RETRIES - 1,
      status: "dispatched",
      next_retry_at: null,
    });

    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));

    await dispatcher.retryTask(store.getTask(task.id)!);

    const finalTask = store.getTask(task.id)!;
    expect(finalTask.status).toBe("failed");
    expect(finalTask.next_retry_at).toBeNull();
    expect(finalTask.result).toContain("connection-error-exhausted");
    expect(finalTask.retry_count).toBe(MAX_CONNECTION_RETRIES);
  });

  it("logic error on dispatch: next_retry_at is null (not retried)", async () => {
    mockSend.mockRejectedValueOnce(new Error("agent produced no output"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("agent produced no output");

    const tasks = store.listTasks({ status: "failed" });
    expect(tasks[0].next_retry_at).toBeNull();
    expect(tasks[0].result).not.toContain("connection-error-exhausted");
  });

  it("HTTP 503 from proxy is treated as connection error and retried", async () => {
    const proxyErr = Object.assign(new Error("Service Unavailable"), { status: 503 });
    mockSend.mockRejectedValueOnce(proxyErr);

    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("Service Unavailable");

    const tasks = store.listTasks({ status: "failed" });
    expect(tasks[0].next_retry_at).not.toBeNull();
    expect(tasks[0].retry_count).toBe(1);
  });

  it("configurable connection_error_delays_ms overrides defaults", async () => {
    const before = Date.now();
    const customConfig = makeConfig();
    customConfig.retry = { connection_error_delays_ms: [5_000, 10_000, 20_000], max_connection_retries: 3 };
    const customDispatcher = new Dispatcher(customConfig, store);

    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));

    await expect(
      customDispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow("ECONNREFUSED");

    const tasks = store.listTasks({ status: "failed" });
    const nextRetry = new Date(tasks[0].next_retry_at!).getTime();
    const expectedRetry = before + 5_000;
    expect(nextRetry).toBeGreaterThanOrEqual(expectedRetry - 1000);
    expect(nextRetry).toBeLessThanOrEqual(expectedRetry + 1000);
  });
});

describe("Dispatcher — connection-error retry state machine (retryTask)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("connection error in retryTask schedules next retry", async () => {
    // Create a failed task that's been retried once
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const task = store.listTasks({ status: "failed" })[0];
    // Manually set retry_count to 1, status back to dispatched
    store.updateTask(task.id, { retry_count: 1, status: "dispatched", next_retry_at: null });

    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    await dispatcher.retryTask(store.getTask(task.id)!);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(2);
    expect(updated.next_retry_at).not.toBeNull();
  });

  it("logic error in retryTask does NOT schedule further retry", async () => {
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const task = store.listTasks({ status: "failed" })[0];
    store.updateTask(task.id, { retry_count: 1, status: "dispatched", next_retry_at: null });

    // Now fail with a logic error (not a connection error)
    mockSend.mockRejectedValueOnce(new Error("invalid instructions"));
    await dispatcher.retryTask(store.getTask(task.id)!);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.next_retry_at).toBeNull();
    expect(updated.result).not.toContain("connection-error-exhausted");
  });

  it("connection-error retryTask with exhausted retries marks result as connection-error-exhausted", async () => {
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    await expect(
      dispatcher.dispatch("do something", { agentName: "test-agent", source: "manual" }),
    ).rejects.toThrow();

    const task = store.listTasks({ status: "failed" })[0];
    // Set retry_count to just below exhaustion
    store.updateTask(task.id, {
      retry_count: MAX_CONNECTION_RETRIES - 1,
      status: "dispatched",
      next_retry_at: null,
    });

    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    await dispatcher.retryTask(store.getTask(task.id)!);

    const final = store.getTask(task.id)!;
    expect(final.status).toBe("failed");
    expect(final.next_retry_at).toBeNull();
    expect(final.result).toContain("connection-error-exhausted");
    expect(final.retry_count).toBe(MAX_CONNECTION_RETRIES);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// gh auth pre-flight (issue #307)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — gh auth pre-flight for github source", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    // Restore default: auth OK
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("throws immediately when gh auth fails for a github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({
      ok: false,
      reason: "gh CLI is not authenticated: token expired. Set GH_TOKEN or run `gh auth login`.",
    });

    await expect(
      dispatcher.dispatch("fix the bug", {
        agentName: "test-agent",
        source: "github",
        sourceRef: "owner/repo#42",
      }),
    ).rejects.toThrow("GH auth pre-flight failed");
  });

  it("does NOT create a task record when gh auth fails for a github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "not authenticated" });

    try {
      await dispatcher.dispatch("fix the bug", {
        agentName: "test-agent",
        source: "github",
        sourceRef: "owner/repo#42",
      });
    } catch {
      // expected
    }

    // No task should have been created — the dispatch was blocked before task creation
    const tasks = store.listTasks({});
    expect(tasks).toHaveLength(0);
  });

  it("does NOT call agent send when gh auth fails for a github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "not authenticated" });

    try {
      await dispatcher.dispatch("fix the bug", {
        agentName: "test-agent",
        source: "github",
      });
    } catch {
      // expected
    }

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("proceeds normally when gh auth passes for a github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#42",
    });

    expect(result.taskId).toBeDefined();
    expect(mockSend).toHaveBeenCalledOnce();
  });

  it("does NOT check gh auth for non-github sources (manual, linear, slack)", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "not authenticated" });
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Manual dispatch should succeed even when gh auth is down
    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "manual",
    });

    expect(result.taskId).toBeDefined();
    expect(mockValidateGhAuth).not.toHaveBeenCalled();
  });

  it("throws GhAuthError (not plain Error) so callers can distinguish auth failures", async () => {
    mockValidateGhAuth.mockReturnValue({
      ok: false,
      reason: "token expired",
    });

    const err = await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "github" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GhAuthError);
    expect((err as GhAuthError).reason).toBe("token expired");
  });

  it("does not create a task record when gh auth fails", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "not authenticated" });

    await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "github" })
      .catch(() => {});

    expect(store.listTasks()).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// retryTask() — GH auth pre-flight
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask — GH auth pre-flight", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  const makeGithubFailedTask = (retryCount = 1) => {
    const task = store.createTask({
      title: "github task",
      description: "fix the issue",
      source: "github",
      source_ref: "owner/repo#99",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "pr creation failed",
      retry_count: retryCount,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    return store.getTask(task.id)!;
  };

  it("skips retry and preserves retry_count when gh auth fails for github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "gh: not authenticated." });
    const task = makeGithubFailedTask(1);

    await dispatcher.retryTask(task);

    expect(mockSend).not.toHaveBeenCalled();
    const updated = store.getTask(task.id)!;
    // retry_count must NOT be incremented — auth failure does not burn a retry slot
    expect(updated.retry_count).toBe(1);
    // next_retry_at should be rescheduled for a future cycle
    expect(updated.next_retry_at).not.toBeNull();
    expect(new Date(updated.next_retry_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it("proceeds with retry when gh auth succeeds for github-sourced task", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockSend.mockResolvedValueOnce({
      content: "retry succeeded",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    const task = makeGithubFailedTask(1);

    await dispatcher.retryTask(task);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)!.status).toBe("done");
  });

  it("does not check gh auth for manual-sourced retry tasks", async () => {
    const task = store.createTask({
      title: "manual task",
      description: "do something",
      source: "manual",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "transient error",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    mockSend.mockResolvedValueOnce({ content: "ok", usage: { input_tokens: 1, output_tokens: 1 } });

    await dispatcher.retryTask(store.getTask(task.id)!);

    expect(mockValidateGhAuth).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
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

  it("connection error during retry: increments retry_count and schedules next retry if within limit", async () => {
    // Use a connection error so the retry system schedules the next attempt
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));
    const task = makeFailedTask(1); // retry_count = 1 → after failure becomes 2

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(2);
    expect(updated.next_retry_at).not.toBeNull();
    const nextRetry = new Date(updated.next_retry_at!).getTime();
    expect(nextRetry).toBeGreaterThan(Date.now());
  });

  it("logic error during retry: does NOT schedule next retry (permanently failed)", async () => {
    mockSend.mockRejectedValueOnce(new Error("still down — non-transient logic error"));
    const task = makeFailedTask(1);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.retry_count).toBe(2);
    expect(updated.next_retry_at).toBeNull();
  });

  it("final failure (retry_count reaches escalation limit): escalates instead of permanently failing", async () => {
    // With retry_count = MAX_RETRIES - 1 (= 2), countFailuresForSourceRef returns
    // retry_count + 1 = 3, which equals the default escalation limit (3).
    // The pre-retry guard fires before even calling mockSend.
    const task = makeFailedTask(MAX_RETRIES - 1);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("escalated");
    // retry_count unchanged — pre-retry escalation doesn't burn a retry slot
    expect(updated.retry_count).toBe(MAX_RETRIES - 1);
    expect(updated.next_retry_at).toBeNull();
    // Agent was not contacted — escalation fires before the send
    expect(mockSend).not.toHaveBeenCalled();
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
// dispatch() — conversationId passthrough (issue #333)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — conversationId passthrough", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockSend.mockResolvedValue({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
  });

  it("reuses the provided conversationId instead of generating a new ULID", async () => {
    const fixedConversationId = "01HXYZ_FIXED_CONVERSATION_ID";

    const result = await dispatcher.dispatch("do something", {
      agentName: "test-agent",
      source: "manual",
      conversationId: fixedConversationId,
    });

    const task = store.getTask(result.taskId);
    expect(task?.conversation_id).toBe(fixedConversationId);
  });

  it("passes the provided conversationId to agent client send()", async () => {
    const fixedConversationId = "01HXYZ_FIXED_CONVERSATION_ID";

    await dispatcher.dispatch("do something", {
      agentName: "test-agent",
      source: "pr-feedback",
      conversationId: fixedConversationId,
    });

    expect(mockSend).toHaveBeenCalledOnce();
    const callArgs = mockSend.mock.calls[0];
    // callArgs[2] is the options object { conversationId, taskType }
    expect(callArgs[2]).toMatchObject({ conversationId: fixedConversationId });
  });

  it("generates a new ULID when conversationId is omitted", async () => {
    const result = await dispatcher.dispatch("do something", {
      agentName: "test-agent",
      source: "manual",
    });

    const task = store.getTask(result.taskId);
    // A ULID is 26 chars of uppercase Crockford base32
    expect(task?.conversation_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("generates a new ULID when conversationId is undefined", async () => {
    const result1 = await dispatcher.dispatch("task 1", {
      agentName: "test-agent",
      source: "manual",
      conversationId: undefined,
    });
    const result2 = await dispatcher.dispatch("task 2", {
      agentName: "test-agent",
      source: "manual",
      conversationId: undefined,
    });

    const task1 = store.getTask(result1.taskId);
    const task2 = store.getTask(result2.taskId);

    // Each task should get a unique, non-empty conversation ID
    expect(task1?.conversation_id).toBeTruthy();
    expect(task2?.conversation_id).toBeTruthy();
    expect(task1?.conversation_id).not.toBe(task2?.conversation_id);
  });

  it("reuses exact conversation_id in the task record (PR feedback resume)", async () => {
    // Simulate what the daemon does for PR feedback: pass the original task's
    // conversation_id so the agent resumes the same session.
    const originalConversationId = "01HXYZ_ORIGINAL_SESSION";

    const prFeedbackResult = await dispatcher.dispatch(
      "Your PR needs changes: add error handling",
      {
        agentName: "test-agent",
        source: "pr-feedback",
        sourceRef: "owner/repo#42",
        title: "[PR feedback] owner/repo#42",
        conversationId: originalConversationId,
      },
    );

    const task = store.getTask(prFeedbackResult.taskId);
    expect(task?.conversation_id).toBe(originalConversationId);
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

// ────────────────────────────────────────────────────────────────────────────
// Auto-escalation on retry exhaustion (issue #341)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask — auto-escalation (issue #341)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  const makeConfigWithEscalation = (retryLimit = 3): OrchestratorConfig => ({
    ...makeConfig(),
    escalation: { retry_limit: retryLimit },
  });

  const makeFailedTaskWithRef = (retryCount: number, sourceRef = "owner/repo#42") => {
    const task = store.createTask({
      title: "failing task",
      description: "implement the feature",
      source: "github",
      source_ref: sourceRef,
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: retryCount,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    return store.getTask(task.id)!;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfigWithEscalation(3), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("escalates (pre-retry guard) when source_ref cumulative failures >= escalation limit", async () => {
    // retry_count=2 → countFailuresForSourceRef returns 3 = limit
    const task = makeFailedTaskWithRef(2);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("escalated");
    expect(updated.next_retry_at).toBeNull();
    // Agent should NOT have been contacted
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("calls reportEscalation when escalating via pre-retry guard", async () => {
    const task = makeFailedTaskWithRef(2); // cumulative failures = 3 = limit

    await dispatcher.retryTask(task);

    expect(mockReportEscalation).toHaveBeenCalledOnce();
    const [, calledTask, calledLimit] = mockReportEscalation.mock.calls[0];
    expect(calledTask.status).toBe("escalated");
    expect(calledLimit).toBe(3);
  });

  it("does NOT escalate when cumulative failures are below the limit", async () => {
    // retry_count=1 → countFailuresForSourceRef returns 2 < 3
    mockSend.mockRejectedValueOnce(new Error("still down"));
    const task = makeFailedTaskWithRef(1);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    // Should be re-scheduled for further retry, not escalated
    expect(updated.status).toBe("failed");
    expect(mockReportEscalation).not.toHaveBeenCalled();
  });

  it("escalates (post-failure catch block) when task has no source_ref and newRetryCount reaches the limit", async () => {
    // Tasks with no source_ref skip the pre-retry guard entirely.
    // With limit=2 and retry_count=1, newRetryCount=2 >= 2 → catch-block escalation.
    dispatcher = new Dispatcher(makeConfigWithEscalation(2), store);
    mockSend.mockRejectedValueOnce(new Error("agent error"));

    const task = store.createTask({
      title: "no source_ref task",
      description: "implement it",
      source: "manual",
      source_ref: undefined, // no source_ref → pre-retry guard skipped
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "prior error",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    await dispatcher.retryTask(store.getTask(task.id)!);

    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("escalated");
    expect(updated.retry_count).toBe(2);
    expect(updated.next_retry_at).toBeNull();
    expect(mockReportEscalation).toHaveBeenCalledOnce();
  });

  it("does NOT escalate when escalation is disabled (retry_limit=0)", async () => {
    dispatcher = new Dispatcher(makeConfigWithEscalation(0), store);
    mockSend.mockRejectedValueOnce(new Error("still down"));
    // retry_count=2 — without escalation this would normally be at the limit
    const task = makeFailedTaskWithRef(2);

    await dispatcher.retryTask(task);

    const updated = store.getTask(task.id)!;
    // With escalation disabled, should proceed normally (fail or retry)
    expect(updated.status).not.toBe("escalated");
    expect(mockReportEscalation).not.toHaveBeenCalled();
  });

  it("escalates across multiple task records for the same source_ref", async () => {
    // Two older failed task records for the same source_ref with retry_count=1 each.
    // Combined they have 2+2 = 4 cumulative failures which exceeds limit=3.
    const t1 = makeFailedTaskWithRef(1, "owner/repo#100");
    store.updateTask(t1.id, { status: "failed", retry_count: 1 });

    // Create another failed task for the same source_ref
    const t2 = store.createTask({
      title: "second attempt",
      description: "still broken",
      source: "github",
      source_ref: "owner/repo#100",
      agent_name: "test-agent",
    });
    store.updateTask(t2.id, {
      status: "failed",
      result: "timeout",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    const task = store.getTask(t2.id)!;
    // countFailuresForSourceRef: (1+1) + (1+1) = 4 >= 3 → escalate
    await dispatcher.retryTask(task);

    const updated = store.getTask(t2.id)!;
    expect(updated.status).toBe("escalated");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not call reportEscalation for manual-sourced tasks (no source_ref escalation comment)", async () => {
    const task = store.createTask({
      title: "manual task",
      description: "no source ref",
      source: "manual",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "error",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    mockSend.mockRejectedValueOnce(new Error("still down"));
    // no source_ref → no pre-retry guard, but catch-block escalation still fires
    // with limit=3 and newRetryCount=2 < 3 → no escalation
    const failedTask = store.getTask(task.id)!;

    await dispatcher.retryTask(failedTask);

    // No escalation at 2 retries with limit=3
    expect(store.getTask(task.id)!.status).toBe("failed");
    expect(mockReportEscalation).not.toHaveBeenCalled();
  });
});

describe("StateStore.countFailedTasksForSourceRef", () => {
  it("returns 0 when no tasks", () => {
    const store = new StateStore(":memory:");
    expect(store.countFailedTasksForSourceRef("github", "owner/repo#1")).toBe(0);
  });

  it("counts failed and escalated tasks only", () => {
    const store = new StateStore(":memory:");
    const t1 = store.createTask({ title: "t1", source: "github", source_ref: "owner/repo#1" });
    store.updateTask(t1.id, { status: "failed" });
    const t2 = store.createTask({ title: "t2", source: "github", source_ref: "owner/repo#1" });
    store.updateTask(t2.id, { status: "escalated" });
    const t3 = store.createTask({ title: "t3", source: "github", source_ref: "owner/repo#1" });
    store.updateTask(t3.id, { status: "done" });
    expect(store.countFailedTasksForSourceRef("github", "owner/repo#1")).toBe(2);
  });

  it("does not cross-count different source_refs", () => {
    const store = new StateStore(":memory:");
    const t1 = store.createTask({ title: "t1", source: "github", source_ref: "owner/repo#1" });
    store.updateTask(t1.id, { status: "failed" });
    const t2 = store.createTask({ title: "t2", source: "github", source_ref: "owner/repo#2" });
    store.updateTask(t2.id, { status: "failed" });
    expect(store.countFailedTasksForSourceRef("github", "owner/repo#1")).toBe(1);
    expect(store.countFailedTasksForSourceRef("github", "owner/repo#2")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Target-repo header injection (issue #338)
// ─────────────────────────────────────────────────────────────────────────────

describe("extractRepoFromSourceRef", () => {
  it("extracts owner/repo from a GitHub source_ref", () => {
    expect(extractRepoFromSourceRef("rapartlu/claude-agent-orchestrator#338")).toBe(
      "rapartlu/claude-agent-orchestrator",
    );
  });

  it("extracts repo when issue number is multi-digit", () => {
    expect(extractRepoFromSourceRef("owner/repo#1234")).toBe("owner/repo");
  });

  it("returns undefined for non-GitHub refs (linear, slack)", () => {
    expect(extractRepoFromSourceRef("linear-check:agent:2026-04-05T14")).toBeUndefined();
    expect(extractRepoFromSourceRef("slack-check:agent:2026-04-05T14")).toBeUndefined();
  });

  it("returns undefined for undefined / null / empty", () => {
    expect(extractRepoFromSourceRef(undefined)).toBeUndefined();
    expect(extractRepoFromSourceRef(null)).toBeUndefined();
    expect(extractRepoFromSourceRef("")).toBeUndefined();
  });

  it("returns undefined when there is no slash before the hash", () => {
    expect(extractRepoFromSourceRef("repo#5")).toBeUndefined();
  });

  it("returns undefined when there is no hash", () => {
    expect(extractRepoFromSourceRef("owner/repo")).toBeUndefined();
  });
});

describe("buildTargetRepoHeader", () => {
  it("returns a markdown block containing the repo name", () => {
    const header = buildTargetRepoHeader("rapartlu/claude-agent-orchestrator#338");
    expect(header).toBeDefined();
    expect(header).toContain("rapartlu/claude-agent-orchestrator");
    expect(header).toContain("Target repository");
  });

  it("returns undefined for non-GitHub source refs", () => {
    expect(buildTargetRepoHeader("linear-check:agent:2026-04-05T14")).toBeUndefined();
  });

  it("returns undefined for undefined source ref", () => {
    expect(buildTargetRepoHeader(undefined)).toBeUndefined();
  });
});

describe("Dispatcher — target-repo header injection (issue #338)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("prepends the target-repo header when dispatching a GitHub-sourced task", async () => {
    const store = new StateStore(":memory:");
    const dispatcher = new Dispatcher(makeConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    await dispatcher.dispatch("Implement feature X", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "rapartlu/claude-agent-orchestrator#338",
    });

    const [, sentMessage] = mockSend.mock.calls[0];
    expect(sentMessage).toContain("rapartlu/claude-agent-orchestrator");
    expect(sentMessage).toContain("Target repository");
    expect(sentMessage).toContain("Implement feature X");
    // Header must come before the task body
    expect(sentMessage.indexOf("Target repository")).toBeLessThan(
      sentMessage.indexOf("Implement feature X"),
    );
  });

  it("does NOT prepend a header for manual (non-GitHub) tasks", async () => {
    const store = new StateStore(":memory:");
    const dispatcher = new Dispatcher(makeConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    await dispatcher.dispatch("Do something", {
      agentName: "test-agent",
      source: "manual",
    });

    const [, sentMessage] = mockSend.mock.calls[0];
    expect(sentMessage).toBe("Do something");
    expect(sentMessage).not.toContain("Target repository");
  });

  it("includes the repo header on retry dispatch", async () => {
    const store = new StateStore(":memory:");
    const dispatcher = new Dispatcher(makeConfig(), store);
    const task = store.createTask({
      title: "Fix the bug",
      description: "Fix the bug in detail",
      source: "github",
      source_ref: "rapartlu/claude-agent-orchestrator#338",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    mockSend.mockResolvedValueOnce({
      content: "fixed",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.retryTask(store.getTask(task.id)!);

    const [, sentMessage] = mockSend.mock.calls[0];
    expect(sentMessage).toContain("rapartlu/claude-agent-orchestrator");
    expect(sentMessage).toContain("Target repository");
    expect(sentMessage).toContain("Fix the bug in detail");
  });

  it("does not add a header when sourceRef has no repo (linear task)", async () => {
    const store = new StateStore(":memory:");
    const dispatcher = new Dispatcher(makeConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    await dispatcher.dispatch("A linear task", {
      agentName: "test-agent",
      source: "linear",
      sourceRef: "linear-check:test-agent:2026-04-05T14",
    });

    const [, sentMessage] = mockSend.mock.calls[0];
    expect(sentMessage).toBe("A linear task");
    expect(sentMessage).not.toContain("Target repository");
  });
});
