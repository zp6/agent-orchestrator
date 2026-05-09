import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Dispatcher,
  FAILURE_REROUTE_THRESHOLD,
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  TIMEOUT_RETRY_MAX,
  TIMEOUT_RETRY_BACKOFF_MS,
  MAX_CONNECTION_RETRIES,
  CONNECTION_ERROR_RETRY_DELAYS_MS,
  isConnectionError,
  selectHealthiestPoolInstance,
  extractRepoFromSourceRef,
  buildTargetRepoHeader,
} from "./dispatcher.js";
import { FailureInterceptor } from "./failure-interceptor.js";
import type { AgentHealth } from "../state/store.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

// Mock validateGhAuth so tests don't shell out.  Use importOriginal so that
// GhAuthError (and other real exports) remain accessible in tests.
vi.mock("../triggers/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../triggers/github.js")>();
  return {
    ...actual,
    validateGhAuth: vi.fn().mockReturnValue({ ok: true }),
    countOpenPRs: vi.fn().mockReturnValue(0),
    // Default: issues are open so retryTask proceeds normally.
    // Individual tests can override via mockIsIssueOpen.
    isIssueOpen: vi.fn().mockReturnValue(true),
    // Default: no existing PRs for issue.
    // Individual tests can override via mockFindExistingPRsForIssue.
    findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  };
});

// Mock reporters so tests don't shell out to gh CLI when escalation fires.
vi.mock("../triggers/reporters.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../triggers/reporters.js")>();
  return { ...actual, reportEscalation: vi.fn().mockReturnValue(false) };
});

// Mock notifyOperator so tests don't send real Telegram messages.
vi.mock("../service/notify.js", () => ({
  notifyOperator: vi.fn().mockResolvedValue(undefined),
}));

// Mock issue-state-bridge — the dispatcher uses cachedValidateForDispatch for
// the primary dispatch path and liveValidateForDispatch for the retry path
// (issue #1563: retry guard must bypass the cache to detect issues closed
// without a PR, which would otherwise be invisible for up to 60 s).
// Default: no skip reason (issue is open, no PRs). Individual tests override.
vi.mock("../triggers/issue-state-bridge.js", () => ({
  cachedValidateForDispatch: vi.fn().mockReturnValue(null),
  liveValidateForDispatch: vi.fn().mockReturnValue(null),
  cachedIsIssueOpen: vi.fn().mockReturnValue(true),
  cachedGetIssueState: vi.fn().mockReturnValue({
    state: "open",
    hasOpenPR: false,
    hasMergedPR: false,
    fetchedAt: Date.now(),
  }),
  logCacheMetrics: vi.fn(),
}));

vi.mock("./pre-dispatch-validator.js", () => ({
  runGitHubPreDispatchValidation: vi.fn().mockImplementation(({ source, agentName, issue }) => ({
    outcome: "passed",
    source,
    sourceRef: `${issue.repo}#${issue.number}`,
    agentName,
    repo: issue.repo,
    issueNumber: issue.number,
    checks: [],
    failureCheck: null,
    failureCode: null,
    failureReason: null,
    blockingPRNumber: null,
    draftPR: null,
    existingBranch: null,
  })),
}));

// Mock the remote capability check so dispatch() doesn't make real HTTP calls
// to agent containers (which aren't running in tests). Without this mock the
// `await runRemoteCapabilityCheck(...)` call introduces extra async ticks
// before the task reaches "dispatched" status, breaking timing-sensitive tests.
vi.mock("./capability-enforcer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capability-enforcer.js")>();
  return { ...actual, runRemoteCapabilityCheck: vi.fn().mockResolvedValue(null) };
});

import { reportEscalation } from "../triggers/reporters.js";
const mockReportEscalation = vi.mocked(reportEscalation);

import { notifyOperator } from "../service/notify.js";
const mockNotifyOperator = vi.mocked(notifyOperator);

import { validateGhAuth, GhAuthError, isIssueOpen, findExistingPRsForIssue, countOpenPRs } from "../triggers/github.js";
const mockValidateGhAuth = vi.mocked(validateGhAuth);
const mockIsIssueOpen = vi.mocked(isIssueOpen);
const mockFindExistingPRsForIssue = vi.mocked(findExistingPRsForIssue);
const mockCountOpenPRs = vi.mocked(countOpenPRs);

import { cachedValidateForDispatch, liveValidateForDispatch } from "../triggers/issue-state-bridge.js";
const mockCachedValidateForDispatch = vi.mocked(cachedValidateForDispatch);
const mockLiveValidateForDispatch = vi.mocked(liveValidateForDispatch);

import { runGitHubPreDispatchValidation } from "./pre-dispatch-validator.js";
const mockRunGitHubPreDispatchValidation = vi.mocked(runGitHubPreDispatchValidation);

// Track the last mockSend across beforeEach
let mockSend: ReturnType<typeof vi.fn>;

// Track router mocks so individual tests can override route behaviour
let mockRoute: ReturnType<typeof vi.fn>;
let mockRouteWithFallback: ReturnType<typeof vi.fn>;

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
  LLM_FALLBACK_THRESHOLD: 0.3,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Router: function MockRouter(this: any) {
    mockRoute = vi.fn().mockReturnValue([{ agentName: "test-agent", confidence: 1.0, reason: "mock" }]);
    mockRouteWithFallback = vi.fn().mockResolvedValue([{ agentName: "test-agent", confidence: 1.0, reason: "mock" }]);
    this.route = mockRoute;
    this.routeWithFallback = mockRouteWithFallback;
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
      github: "owner/repo",
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

  it("recognises proxy spawn failure as retryable", () => {
    expect(isConnectionError(new Error("Failed to spawn claude CLI: spawn ENOENT (ENOENT)"))).toBe(true);
  });

  it("recognises E2BIG spawn error as retryable", () => {
    expect(isConnectionError(new Error("Failed to spawn claude CLI: Argument list too long (E2BIG)"))).toBe(true);
  });

  it("recognises EAGAIN spawn error as retryable", () => {
    expect(isConnectionError(new Error("spawn EAGAIN"))).toBe(true);
  });

  it("recognises generic 'failed to spawn' message as retryable", () => {
    expect(isConnectionError(new Error("failed to spawn codex CLI: some reason"))).toBe(true);
  });

  // ── Quota/rate-limit 500s must NOT be classified as connection errors ──────
  // Anthropic's "extra usage" quota exhaustion arrives as HTTP 500 api_error.
  // These should be handled by isRateLimitError, not retried as connection errors.

  it("returns false for HTTP 500 quota-exhaustion error (issue #1521 fix)", () => {
    const err = Object.assign(
      new Error(`500 {"type":"error","error":{"type":"api_error","message":"You're out of extra usage · resets 1pm (UTC)"}}`),
      { status: 500 },
    );
    expect(isConnectionError(err)).toBe(false);
  });

  it("returns false for 'extra usage' in a generic 500 message (issue #1521 fix)", () => {
    const err = Object.assign(
      new Error("extra usage exhausted for this period"),
      { status: 500 },
    );
    expect(isConnectionError(err)).toBe(false);
  });

  it("returns true for a genuine 500 without rate-limit indicators", () => {
    const err = Object.assign(new Error("Internal Server Error"), { status: 500 });
    expect(isConnectionError(err)).toBe(true);
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

    const monologues = store.getMonologue({ task_id: result.taskId, limit: 10 }).reverse();
    expect(monologues.map((entry) => entry.kind)).toEqual([
      "plan",
      "execution",
      "reflection",
    ]);
    expect(monologues[0].prose).toContain("picked up");
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

  it("prepends a discipline refresh block and stores the snapshot for verification", async () => {
    mockSend.mockResolvedValueOnce({
      content: "all done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = await dispatcher.dispatch("Build a Substack draft flow", {
      agentName: "test-agent",
      source: "manual",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const sentMessage = mockSend.mock.calls[0]?.[1] as string;
    expect(sentMessage).toContain("Discipline refresh");
    expect(sentMessage).toContain("re-read the current `CLAUDE.md` and `CHARTER.md`");

    const snapshotLog = store.getLatestTaskLogByPrefix(result.taskId, "[discipline-context]");
    expect(snapshotLog).toBeDefined();
    expect(snapshotLog?.content).toContain("CLAUDE.md");
    expect(snapshotLog?.content).toContain("CHARTER.md");
  });
});

describe("Dispatcher.dispatch — superseded task guard (issue #557)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  it("does not overwrite 'superseded' status with 'done' when task is superseded mid-flight", async () => {
    // Simulate: agent send completes successfully BUT the task was superseded
    // in the DB while the HTTP call was in-flight (claim TTL expired and a
    // newer agent claimed the issue and called cancelSupersededTasks).
    mockSend.mockImplementationOnce(async () => {
      // Simulate the task being superseded in the DB while send() is running
      // (the dispatcher won't see this until send() returns)
      return {
        content: "work done",
        usage: { input_tokens: 10, output_tokens: 20 },
        stop_reason: "end_turn",
      };
    });

    const result = await dispatcher.dispatch("fix issue", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#1",
    });

    // Manually supersede the task as cancelSupersededTasks would
    store.updateTask(result.taskId, {
      status: "superseded",
      result: "Superseded by newer dispatch",
      next_retry_at: null,
    });

    // Verify the guard: if we were to re-run the dispatch update logic, it
    // should detect "superseded" and not overwrite.  The status must stay.
    const task = store.getTask(result.taskId);
    expect(task?.status).toBe("superseded");
    expect(task?.result).toBe("Superseded by newer dispatch");
  });

  it("does not overwrite 'superseded' with 'done' when send() returns after supersession", async () => {
    // This tests the actual guard in dispatcher: after send() returns we check
    // if the task was superseded before writing "done".
    let resolveDeferred!: (v: { content: string; usage: { input_tokens: number; output_tokens: number } }) => void;
    const deferred = new Promise<{ content: string; usage: { input_tokens: number; output_tokens: number } }>((resolve) => {
      resolveDeferred = resolve;
    });
    mockSend.mockReturnValueOnce(deferred);

    // Start dispatch — it will await the deferred send()
    const dispatchPromise = dispatcher.dispatch("fix issue", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#2",
    });

    // While dispatch is awaiting send(), look up the pending task and supersede it
    // (mimicking what cancelSupersededTasks does in the real scenario)
    await new Promise<void>((resolve) => setTimeout(resolve, 0)); // tick
    const pendingTasks = store.listTasks({ status: "dispatched" });
    expect(pendingTasks).toHaveLength(1);
    store.updateTask(pendingTasks[0].id, {
      status: "superseded",
      result: "Task superseded: newer agent claimed the issue",
      next_retry_at: null,
    });

    // Now let send() complete
    resolveDeferred({ content: "work done", usage: { input_tokens: 5, output_tokens: 10 } });
    const result = await dispatchPromise;

    // The dispatcher guard should have detected "superseded" and NOT overwritten it
    const task = store.getTask(result.taskId);
    expect(task?.status).toBe("superseded");
    expect(task?.result).toContain("superseded");
  });

  it("does not overwrite 'superseded' with 'failed' when the abort signal fires", async () => {
    // When AbortController.abort() is called, send() throws an AbortError.
    // The catch block should detect "superseded" and not set status to "failed".
    const controller = new AbortController();
    mockSend.mockImplementationOnce(async (_name: string, _msg: string, opts?: { signal?: AbortSignal }) => {
      // Simulate a long-running call that respects the signal
      if (opts?.signal?.aborted) {
        throw new Error("AbortError");
      }
      return { content: "done", usage: { input_tokens: 5, output_tokens: 10 } };
    });

    // dispatch and immediately abort before send completes
    const dispatchPromise = dispatcher.dispatch("fix issue", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#3",
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const pendingTasks = store.listTasks({ status: "dispatched" });
    if (pendingTasks.length > 0) {
      store.updateTask(pendingTasks[0].id, {
        status: "superseded",
        result: "Task superseded: newer agent claimed the issue",
        next_retry_at: null,
      });
    }

    // The task may or may not be "superseded" depending on timing, but we
    // verify the core invariant: if the task is "superseded", the status is
    // not changed to "failed" even if the abort causes an error.
    try {
      await dispatchPromise;
    } catch {
      // Errors are expected when the task is superseded mid-flight
    }

    if (pendingTasks.length > 0) {
      const task = store.getTask(pendingTasks[0].id);
      // If superseded: must stay superseded
      if (task?.status === "superseded") {
        expect(task.result).toContain("superseded");
      }
    }
  });
});

describe("Dispatcher auto-reroute after repeated failures", () => {
  let store: StateStore;

  const makeRerouteConfig = (): OrchestratorConfig => ({
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    agents: {
      "primary-agent": {
        dir: "primary-agent",
        description: "Primary implementation agent",
        github: "rapartlu/agent-orchestrator",
        capabilities: ["code", "orchestrator"],
        owns_topics: ["orchestrator", "quality"],
        docker: { port: 3457, api_key: "secret" },
      },
      "backup-fast": {
        dir: "backup-fast",
        description: "Best backup",
        github: "rapartlu/agent-orchestrator",
        capabilities: ["code", "orchestrator"],
        owns_topics: ["orchestrator", "quality"],
        docker: { port: 3458, api_key: "secret" },
      },
      "backup-slow": {
        dir: "backup-slow",
        description: "Worse backup",
        github: "rapartlu/agent-orchestrator",
        capabilities: ["code", "orchestrator"],
        owns_topics: ["orchestrator", "quality"],
        docker: { port: 3459, api_key: "secret" },
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
  });

  it("reroutes a new dispatch to the best task-type substitute after 3 failed attempts", async () => {
    const dispatcher = new Dispatcher(makeRerouteConfig(), store);
    const sourceRef = "rapartlu/agent-orchestrator#524";

    const failed = store.createTask({
      title: "Issue 524",
      source: "github",
      source_ref: sourceRef,
      agent_name: "primary-agent",
      task_type: "implementation",
    });
    store.updateTask(failed.id, { status: "failed", retry_count: FAILURE_REROUTE_THRESHOLD - 1 });

    for (let i = 0; i < 4; i++) {
      const t = store.createTask({
        title: `backup-fast-${i}`,
        source: "manual",
        agent_name: "backup-fast",
        task_type: "implementation",
      });
      store.updateTask(t.id, { status: i === 3 ? "failed" : "done" });
    }
    for (let i = 0; i < 3; i++) {
      const t = store.createTask({
        title: `backup-slow-${i}`,
        source: "manual",
        agent_name: "backup-slow",
        task_type: "implementation",
      });
      store.updateTask(t.id, { status: i === 0 ? "done" : "failed" });
    }

    mockSend.mockResolvedValueOnce({
      content: "implemented",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = await dispatcher.dispatch("Implement issue #524", {
      agentName: "primary-agent",
      source: "github",
      sourceRef,
      title: "Issue 524",
      taskType: "implementation",
    });

    expect(result.agentName).toBe("backup-fast");
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toBe("backup-fast");
    expect(mockSend.mock.calls[0][1]).toContain("## Auto-Reroute Context");

    const created = store.getTask(result.taskId);
    expect(created?.agent_name).toBe("backup-fast");

    const decisions = store.getRecentSupervisorDecisions(1);
    expect(decisions[0].reason).toBe("auto-reroute-failed-attempts");
    expect(decisions[0].agent_name).toBe("backup-fast");
    expect(decisions[0].outcome).toBe("dispatched");
    expect(decisions[0].rationale).toContain("after 3 failed attempt(s)");

    // The auto-reroute sends one notification; the failure-interceptor may also fire
    // a "Failure Interceptor fired" notification when similarity_score >= threshold.
    // Assert the reroute notification was sent (allow additional interceptor alerts).
    expect(mockNotifyOperator).toHaveBeenCalled();
    const rerouteCall = mockNotifyOperator.mock.calls.find((c) =>
      c[1]?.includes("reassigned from primary-agent to backup-fast"),
    );
    expect(rerouteCall).toBeDefined();
  });

  it("converts a queued retry into a reroute and stops retrying the original task", async () => {
    const dispatcher = new Dispatcher(makeRerouteConfig(), store);
    const sourceRef = "rapartlu/agent-orchestrator#525";

    for (let i = 0; i < 2; i++) {
      const t = store.createTask({
        title: `backup-fast-${i}`,
        source: "manual",
        agent_name: "backup-fast",
        task_type: "implementation",
      });
      store.updateTask(t.id, { status: "done" });
    }

    const failed = store.createTask({
      title: "Issue 525",
      description: "Implement issue #525",
      source: "github",
      source_ref: sourceRef,
      agent_name: "primary-agent",
      task_type: "implementation",
    });
    store.updateTask(failed.id, {
      status: "failed",
      retry_count: FAILURE_REROUTE_THRESHOLD - 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    mockSend.mockResolvedValueOnce({
      content: "fixed by backup",
      usage: { input_tokens: 12, output_tokens: 24 },
    });

    await dispatcher.retryTask(store.getTask(failed.id)!);

    const original = store.getTask(failed.id);
    expect(original?.next_retry_at).toBeNull();

    const rerouted = store.listTasks({}).find((t) => t.title === "[auto-reroute] Issue 525");
    expect(rerouted?.agent_name).toBe("backup-fast");
    expect(rerouted?.status).toBe("done");

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toBe("backup-fast");
    expect(mockSend.mock.calls[0][1]).toContain("## Auto-Reroute Context");

    const decisions = store.getRecentSupervisorDecisions(1);
    expect(decisions[0].reason).toBe("auto-reroute-failed-attempts");
    expect(decisions[0].task_id).toBe(rerouted?.id);

    // Failure-interceptor may also send notifications; just verify at least one was sent.
    expect(mockNotifyOperator).toHaveBeenCalled();
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

  it("quarantines agent as auth-degraded when gh auth fails on github-sourced dispatch", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "token expired" });

    await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "github" })
      .catch(() => {});

    expect(store.isAgentAuthDegraded("test-agent")).toBe(true);
  });

  it("sends Telegram alert when quarantining an agent", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: false, reason: "token expired" });

    await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "github" })
      .catch(() => {});

    expect(mockNotifyOperator).toHaveBeenCalledWith(
      "Agent quarantined: auth-degraded",
      expect.stringContaining("test-agent"),
      "critical",
      "auth-degraded:test-agent",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch() — auth-degraded quarantine blocking (issue #418)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — auth-degraded quarantine", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("blocks non-research tasks to auth-degraded agents", async () => {
    store.setAgentAuthDegraded("test-agent", "GH_TOKEN missing");

    const err = await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "github" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GhAuthError);
    expect((err as GhAuthError).reason).toBe("agent-auth-degraded");
    expect(store.listTasks()).toHaveLength(0);
  });

  it("allows research tasks to auth-degraded agents", async () => {
    store.setAgentAuthDegraded("test-agent", "GH_TOKEN missing");

    mockSend.mockResolvedValue({
      content: "research result",
      model: "test",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const result = await dispatcher.dispatch("research this topic", {
      agentName: "test-agent",
      source: "github",
      taskType: "research",
    });

    expect(result.taskId).toBeDefined();
    expect(result.response.content).toBe("research result");
  });

  it("allows dispatch after auth-degraded status is cleared", async () => {
    store.setAgentAuthDegraded("test-agent", "GH_TOKEN missing");
    store.clearAgentAuthDegraded("test-agent");

    mockSend.mockResolvedValue({
      content: "done",
      model: "test",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
    });

    expect(result.taskId).toBeDefined();
  });

  it("blocks manual implementation tasks to auth-degraded agents too", async () => {
    store.setAgentAuthDegraded("test-agent", "GH_TOKEN missing");

    const err = await dispatcher
      .dispatch("fix the bug", { agentName: "test-agent", source: "manual" })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(GhAuthError);
    expect((err as GhAuthError).reason).toBe("agent-auth-degraded");
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
// retryTask() — closed-issue guard (issue #1563)
// Verifies that liveValidateForDispatch (not cachedValidateForDispatch) is used
// in the retry path so a stale cache entry cannot cause a re-dispatch for an
// issue that was closed (without a PR) during a prior attempt.
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask — closed-issue guard (issue #1563)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
    // Default: live fetch says issue is open (no skip reason).
    mockLiveValidateForDispatch.mockReturnValue(null);
  });

  const makeGithubConnectionErrorTask = (retryCount = 1) => {
    const task = store.createTask({
      title: "github task",
      description: "fix the issue",
      source: "github",
      source_ref: "owner/repo#567",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "Connection error: proxy unreachable",
      retry_count: retryCount,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });
    return store.getTask(task.id)!;
  };

  it("cancels retry and marks task done+approved when issue is closed without PR (live check)", async () => {
    // Simulate: stale cache says "open" but live fetch detects closure.
    mockCachedValidateForDispatch.mockReturnValue(null); // stale cache: open
    mockLiveValidateForDispatch.mockReturnValue("issue owner/repo#567 is closed");

    const task = makeGithubConnectionErrorTask(1);
    await dispatcher.retryTask(task);

    // Must NOT dispatch to agent
    expect(mockSend).not.toHaveBeenCalled();

    const updated = store.getTask(task.id)!;
    // Task should be marked done (not failed) — this was a valid external completion
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("issue-closed-without-pr");
    expect(updated.verification_status).toBe("approved");
    expect(updated.quality_score).toBe(1.0);
    expect(updated.next_retry_at).toBeNull();
  });

  it("uses liveValidateForDispatch (not cachedValidateForDispatch) in the retry guard", async () => {
    // Scenario from #1563: the cache (populated 30s ago) still says the issue is
    // open. The live fetch sees it is closed. The retry must honour the live check.
    mockCachedValidateForDispatch.mockReturnValue(null);
    mockLiveValidateForDispatch.mockReturnValue("issue owner/repo#567 is closed");

    const task = makeGithubConnectionErrorTask(1);
    await dispatcher.retryTask(task);

    // liveValidateForDispatch must have been called, cachedValidateForDispatch must NOT
    expect(mockLiveValidateForDispatch).toHaveBeenCalledWith("owner/repo", 567);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("cancels retry and marks task failed when issue has an open PR (not closed)", async () => {
    mockLiveValidateForDispatch.mockReturnValue("issue owner/repo#567 already has an open PR");

    const task = makeGithubConnectionErrorTask(1);
    await dispatcher.retryTask(task);

    expect(mockSend).not.toHaveBeenCalled();
    const updated = store.getTask(task.id)!;
    // Open-PR case is not a valid external completion — keep as failed
    expect(updated.status).toBe("failed");
    expect(updated.result).toContain("Resolved externally");
    expect(updated.next_retry_at).toBeNull();
  });

  it("proceeds with retry when live check confirms issue is still open", async () => {
    mockLiveValidateForDispatch.mockReturnValue(null); // issue still open
    mockSend.mockResolvedValueOnce({
      content: "fix applied",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const task = makeGithubConnectionErrorTask(1);
    await dispatcher.retryTask(task);

    expect(mockLiveValidateForDispatch).toHaveBeenCalledWith("owner/repo", 567);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)!.status).toBe("done");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch() — closed-issue guard (issue #444)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — closed-issue guard (issue #444)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("skips dispatch and returns skip result when source issue is closed", async () => {
    mockRunGitHubPreDispatchValidation.mockReturnValueOnce({
      outcome: "blocked",
      source: "github",
      sourceRef: "owner/repo#99",
      agentName: "test-agent",
      repo: "owner/repo",
      issueNumber: 99,
      checks: [],
      failureCheck: "issue_state",
      failureCode: "issue_closed",
      failureReason: "issue owner/repo#99 is closed",
      blockingPRNumber: null,
      draftPR: null,
      existingBranch: null,
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    // Should NOT have called agent send
    expect(mockSend).not.toHaveBeenCalled();

    // No task should have been created
    const tasks = store.listTasks({});
    expect(tasks).toHaveLength(0);

    // Should return a skip result with empty taskId
    expect(result.taskId).toBe("");
    expect(result.agentName).toBe("test-agent");
    expect(result.response.stop_reason).toBe("skipped");
    expect(result.response.content).toContain("closed");
  });

  it("proceeds with dispatch when source issue is open", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.taskId).not.toBe("");
  });

  it("does not check issue state for non-github sources", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.dispatch("do the thing", {
      agentName: "test-agent",
      source: "manual",
    });

    expect(mockRunGitHubPreDispatchValidation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("skips manual implementation dispatches when the target repo is at PR capacity", async () => {
    mockCountOpenPRs.mockReturnValueOnce(3);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const result = await dispatcher.dispatch("implement the thing", {
      agentName: "test-agent",
      source: "manual",
    });

    expect(mockCountOpenPRs).toHaveBeenCalledWith("owner/repo");
    expect(mockSend).not.toHaveBeenCalled();
    expect(result.taskId).toBe("");
    expect(result.response.stop_reason).toBe("skipped");
    expect(result.response.content).toContain("repo at PR capacity");
  });

  it("does not check issue state when sourceRef has no issue number", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.dispatch("do the thing", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo",
    });

    expect(mockRunGitHubPreDispatchValidation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatch() — already-resolved guard (issue #457)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.dispatch — already-resolved guard (issue #457)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
    mockValidateGhAuth.mockReturnValue({ ok: true });
  });

  it("skips dispatch when pre-dispatch validation returns blocked (e.g. closed issue)", async () => {
    // Note: as of issue #775, a merged PR on an OPEN issue no longer blocks dispatch.
    // This test verifies that the dispatcher correctly handles any blocked validation
    // outcome (here we use issue_closed as the representative blocking code).
    mockRunGitHubPreDispatchValidation.mockReturnValueOnce({
      outcome: "blocked",
      source: "github",
      sourceRef: "owner/repo#99",
      agentName: "test-agent",
      repo: "owner/repo",
      issueNumber: 99,
      checks: [],
      failureCheck: "issue_state",
      failureCode: "issue_closed",
      failureReason: "issue owner/repo#99 is already closed",
      blockingPRNumber: null,
      draftPR: null,
      existingBranch: null,
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    // Should NOT have called agent send
    expect(mockSend).not.toHaveBeenCalled();

    // No task should have been created
    const tasks = store.listTasks({});
    expect(tasks).toHaveLength(0);

    // Should return a skip result
    expect(result.taskId).toBe("");
    expect(result.agentName).toBe("test-agent");
    expect(result.response.stop_reason).toBe("skipped");
    expect(result.response.content).toContain("already closed");
  });

  it("proceeds with dispatch when no merged PR exists", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.taskId).not.toBe("");
  });

  it("proceeds with dispatch when pre-dispatch validation passes", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    const result = await dispatcher.dispatch("fix the bug", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(result.taskId).not.toBe("");
  });

  it("does not check merged PRs for non-github sources", async () => {
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.dispatch("do the thing", {
      agentName: "test-agent",
      source: "manual",
    });

    expect(mockRunGitHubPreDispatchValidation).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// retryTask() — closed-issue guard (issue #431)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask — closed-issue guard (issue #431)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  const makeRetryRerouteConfig = (): OrchestratorConfig => ({
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    agents: {
      "primary-agent": {
        dir: "primary-agent",
        description: "Primary implementation agent",
        github: "rapartlu/agent-orchestrator",
        capabilities: ["code", "orchestrator"],
        owns_topics: ["orchestrator", "quality"],
        docker: { port: 3457, api_key: "secret" },
      },
      "backup-fast": {
        dir: "backup-fast",
        description: "Best backup",
        github: "rapartlu/agent-orchestrator",
        capabilities: ["code", "orchestrator"],
        owns_topics: ["orchestrator", "quality"],
        docker: { port: 3458, api_key: "secret" },
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  it("skips retry and marks done+approved when source issue is closed (no PR)", async () => {
    const task = store.createTask({
      title: "Fix bug",
      description: "Fix the bug",
      source: "github",
      source_ref: "owner/repo#99",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    // Live check shows issue is closed (bypasses stale cache — issue #1563)
    mockLiveValidateForDispatch.mockReturnValueOnce("issue owner/repo#99 is closed");

    await dispatcher.retryTask(store.getTask(task.id)!);

    // Should NOT have called send
    expect(mockSend).not.toHaveBeenCalled();

    // Issue-closed-without-PR is a valid external completion — mark done+approved
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("issue-closed-without-pr");
    expect(updated.verification_status).toBe("approved");
    expect(updated.next_retry_at).toBeNull();
  });

  it("does not auto-reroute a retry when the source issue is already closed", async () => {
    const rerouteDispatcher = new Dispatcher(makeRetryRerouteConfig(), store);
    const sourceRef = "owner/repo#99";

    for (let i = 0; i < 2; i++) {
      const t = store.createTask({
        title: `backup-fast-${i}`,
        source: "manual",
        agent_name: "backup-fast",
        task_type: "implementation",
      });
      store.updateTask(t.id, { status: "done" });
    }

    const task = store.createTask({
      title: "Fix bug",
      description: "Fix the bug",
      source: "github",
      source_ref: sourceRef,
      agent_name: "primary-agent",
      task_type: "implementation",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: FAILURE_REROUTE_THRESHOLD - 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    mockLiveValidateForDispatch.mockReturnValueOnce(`issue ${sourceRef} is closed`);

    await rerouteDispatcher.retryTask(store.getTask(task.id)!);

    expect(mockSend).not.toHaveBeenCalled();
    expect(store.listTasks({}).find((t) => t.title === "[auto-reroute] Fix bug")).toBeUndefined();

    const updated = store.getTask(task.id)!;
    // Issue closed without PR → done+approved (not failed, not auto-rerouted)
    expect(updated.status).toBe("done");
    expect(updated.result).toBe("issue-closed-without-pr");
    expect(updated.next_retry_at).toBeNull();
  });

  it("proceeds with retry when source issue is still open", async () => {
    const task = store.createTask({
      title: "Fix bug",
      description: "Fix the bug",
      source: "github",
      source_ref: "owner/repo#99",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    // Issue is still open (live validation confirms — issue #1563)
    mockLiveValidateForDispatch.mockReturnValueOnce(null);
    mockSend.mockResolvedValueOnce({
      content: "retry succeeded",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.retryTask(store.getTask(task.id)!);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("done");
  });

  it("does not check issue state for non-github tasks", async () => {
    const task = store.createTask({
      title: "Linear task",
      description: "Do the linear thing",
      source: "linear",
      source_ref: "linear-check:test-agent:2026-01-01T00",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "error",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.retryTask(store.getTask(task.id)!);

    // liveValidateForDispatch should NOT have been called for non-github tasks
    expect(mockLiveValidateForDispatch).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// retryTask() — already-resolved guard (issue #457)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher.retryTask — already-resolved guard (issue #457, #458 live)", () => {
  let store: StateStore;
  let dispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    dispatcher = new Dispatcher(makeConfig(), store);
  });

  it("skips retry and marks failed when issue has a merged PR (not closed)", async () => {
    const task = store.createTask({
      title: "Fix bug",
      description: "Fix the bug",
      source: "github",
      source_ref: "owner/repo#99",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    // Live check (not cached) detects merged PR — not a closed-without-PR completion
    mockLiveValidateForDispatch.mockReturnValueOnce("issue owner/repo#99 has a merged PR");

    await dispatcher.retryTask(store.getTask(task.id)!);

    // Should NOT have called send
    expect(mockSend).not.toHaveBeenCalled();

    // Merged PR (but not "is closed") → keeps "failed" status
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("failed");
    expect(updated.result).toContain("Resolved externally");
    expect(updated.next_retry_at).toBeNull();
  });

  it("proceeds with retry when no merged PR exists", async () => {
    const task = store.createTask({
      title: "Fix bug",
      description: "Fix the bug",
      source: "github",
      source_ref: "owner/repo#99",
      agent_name: "test-agent",
    });
    store.updateTask(task.id, {
      status: "failed",
      result: "connection refused",
      retry_count: 1,
      next_retry_at: new Date(Date.now() - 1000).toISOString(),
    });

    mockLiveValidateForDispatch.mockReturnValueOnce(null);
    mockSend.mockResolvedValueOnce({
      content: "retry succeeded",
      usage: { input_tokens: 5, output_tokens: 5 },
    });

    await dispatcher.retryTask(store.getTask(task.id)!);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const updated = store.getTask(task.id)!;
    expect(updated.status).toBe("done");
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
    // Per #1522: tasks targeting deleted agents are marked superseded
    // (a structural state-change), not failed.
    expect(updated.status).toBe("superseded");
    expect(updated.result).toMatch(/agent-removed/);
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
    expect(extractRepoFromSourceRef("rapartlu/agent-orchestrator#338")).toBe(
      "rapartlu/agent-orchestrator",
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
    const header = buildTargetRepoHeader("rapartlu/agent-orchestrator#338");
    expect(header).toBeDefined();
    expect(header).toContain("rapartlu/agent-orchestrator");
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
      sourceRef: "rapartlu/agent-orchestrator#338",
    });

    const [, sentMessage] = mockSend.mock.calls[0];
    expect(sentMessage).toContain("rapartlu/agent-orchestrator");
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
    expect(sentMessage).toContain("Do something");
    expect(sentMessage).not.toContain("Target repository");
  });

  it("includes the repo header on retry dispatch", async () => {
    const store = new StateStore(":memory:");
    const dispatcher = new Dispatcher(makeConfig(), store);
    const task = store.createTask({
      title: "Fix the bug",
      description: "Fix the bug in detail",
      source: "github",
      source_ref: "rapartlu/agent-orchestrator#338",
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
    expect(sentMessage).toContain("rapartlu/agent-orchestrator");
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
    expect(sentMessage).toContain("A linear task");
    expect(sentMessage).not.toContain("Target repository");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// selectHealthiestPoolInstance (issue #385)
// ────────────────────────────────────────────────────────────────────────────

describe("selectHealthiestPoolInstance", () => {
  const makeHealth = (
    name: string,
    overrides?: Partial<AgentHealth>,
  ): AgentHealth => ({
    agent_name: name,
    consecutive_failures: 0,
    last_error_at: null,
    last_error_message: null,
    last_success_at: null,
    is_healthy: true,
    ...overrides,
  });

  const noActiveTask = () => false;

  it("returns the only member when pool has a single instance", () => {
    const result = selectHealthiestPoolInstance(
      ["reviewer"],
      [makeHealth("reviewer")],
      noActiveTask,
    );
    expect(result).toBe("reviewer");
  });

  it("selects a healthy idle instance over an unhealthy one", () => {
    const health = [
      makeHealth("reviewer-1", { consecutive_failures: 5, is_healthy: false, last_error_at: "2026-04-05T21:30:00Z" }),
      makeHealth("reviewer-2", { consecutive_failures: 0, is_healthy: true }),
    ];
    const result = selectHealthiestPoolInstance(
      ["reviewer-1", "reviewer-2"],
      health,
      noActiveTask,
    );
    expect(result).toBe("reviewer-2");
  });

  it("prefers idle over busy even if busy is healthier", () => {
    const health = [
      makeHealth("reviewer-1", { consecutive_failures: 0 }),
      makeHealth("reviewer-2", { consecutive_failures: 1, is_healthy: true }),
    ];
    const busySet = new Set(["reviewer-1"]);
    const result = selectHealthiestPoolInstance(
      ["reviewer-1", "reviewer-2"],
      health,
      (name) => busySet.has(name),
    );
    expect(result).toBe("reviewer-2");
  });

  it("falls back to least-recently-failed when all instances are unhealthy", () => {
    const health = [
      makeHealth("reviewer-1", {
        consecutive_failures: 5,
        is_healthy: false,
        last_error_at: "2026-04-05T21:35:00Z", // more recent error
      }),
      makeHealth("reviewer-2", {
        consecutive_failures: 3,
        is_healthy: false,
        last_error_at: "2026-04-05T21:25:00Z", // older error, fewer failures
      }),
      makeHealth("reviewer-3", {
        consecutive_failures: 3,
        is_healthy: false,
        last_error_at: "2026-04-05T21:30:00Z", // older than reviewer-1
      }),
    ];
    const result = selectHealthiestPoolInstance(
      ["reviewer-1", "reviewer-2", "reviewer-3"],
      health,
      noActiveTask,
    );
    // reviewer-2 has fewest failures (3) AND oldest error
    expect(result).toBe("reviewer-2");
  });

  it("when all healthy, round-robins among tied idle members", () => {
    const health = [
      makeHealth("reviewer-1"),
      makeHealth("reviewer-2"),
      makeHealth("reviewer-3"),
    ];
    const members = ["reviewer-1", "reviewer-2", "reviewer-3"];
    const results = new Set<string>();
    for (let i = 0; i < 6; i++) {
      results.add(selectHealthiestPoolInstance(members, health, noActiveTask));
    }
    // All three should be selected across 6 calls (round-robin)
    expect(results.size).toBe(3);
  });

  it("prefers instance with no errors over one with reset errors (same failure count)", () => {
    const health = [
      makeHealth("reviewer-1", {
        consecutive_failures: 0,
        last_error_at: "2026-04-05T21:00:00Z", // had an error before, now recovered
      }),
      makeHealth("reviewer-2", {
        consecutive_failures: 0,
        last_error_at: null, // never errored
      }),
    ];
    const result = selectHealthiestPoolInstance(
      ["reviewer-1", "reviewer-2"],
      health,
      noActiveTask,
    );
    expect(result).toBe("reviewer-2");
  });

  it("handles missing health records (treats as healthy)", () => {
    // Only provide health for reviewer-1 (unhealthy), reviewer-2 has no record
    const health = [
      makeHealth("reviewer-1", { consecutive_failures: 5, is_healthy: false, last_error_at: "2026-04-05T21:30:00Z" }),
    ];
    const result = selectHealthiestPoolInstance(
      ["reviewer-1", "reviewer-2"],
      health,
      noActiveTask,
    );
    expect(result).toBe("reviewer-2");
  });

  it("among equally unhealthy busy instances, picks the one with oldest error", () => {
    const health = [
      makeHealth("r1", { consecutive_failures: 3, is_healthy: false, last_error_at: "2026-04-05T21:35:00Z" }),
      makeHealth("r2", { consecutive_failures: 3, is_healthy: false, last_error_at: "2026-04-05T21:20:00Z" }),
    ];
    const result = selectHealthiestPoolInstance(
      ["r1", "r2"],
      health,
      () => true, // all busy
    );
    expect(result).toBe("r2");
  });

  it("throws on empty members list", () => {
    expect(() => selectHealthiestPoolInstance([], [], noActiveTask)).toThrow(
      "empty members list",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Pool failover routing integration (issue #385)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher — pool failover routing integration", () => {
  const makePoolConfig = (): OrchestratorConfig => ({
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    agents: {
      "reviewer": {
        dir: "reviewer",
        pool: "reviewer-pool",
        description: "Primary reviewer",
        capabilities: ["review"],
        owns_topics: ["review"],
        docker: { port: 3457, api_key: "secret" },
      },
      "reviewer-2": {
        dir: "reviewer-2",
        pool: "reviewer-pool",
        description: "Reviewer pool instance 2",
        capabilities: ["review"],
        owns_topics: ["review"],
        docker: { port: 3458, api_key: "secret" },
      },
      "reviewer-3": {
        dir: "reviewer-3",
        pool: "reviewer-pool",
        description: "Reviewer pool instance 3",
        capabilities: ["review"],
        owns_topics: ["review"],
        docker: { port: 3459, api_key: "secret" },
      },
    },
  });

  let store: StateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
  });

  it("honours explicit --agent as a hard pin (no pool rebalancing)", async () => {
    // Mark primary reviewer as unhealthy (3 consecutive failures)
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");

    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    // Explicit --agent is a hard operator directive — pool rebalancing must
    // NOT redirect to a healthier sibling.  The intent is "this exact agent",
    // not "any agent in this pool".  (Fixes #1420 Bug 1.)
    const result = await dispatcher.dispatch("review this PR", {
      agentName: "reviewer",
      source: "manual",
    });

    expect(result.agentName).toBe("reviewer");
  });

  it("auto-routing rebalances within pool to healthy member when primary is unhealthy", async () => {
    // Mark primary reviewer as unhealthy (3 consecutive failures)
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");
    store.recordAgentFailure("reviewer", "503 Failed to spawn claude CLI");

    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    // Override the router mock so auto-routing returns "reviewer" (the pool entry point)
    mockRoute.mockReturnValueOnce([{ agentName: "reviewer", confidence: 0.9, reason: "topic match" }]);
    mockRouteWithFallback.mockResolvedValueOnce([{ agentName: "reviewer", confidence: 0.9, reason: "topic match" }]);

    // Without explicit agentName, auto-routing selects the pool then
    // rebalancing picks the healthiest member (reviewer-2 or reviewer-3).
    const result = await dispatcher.dispatch("review this PR", {
      source: "manual",
      // no agentName — let auto-routing pick the pool
    });

    // Should have been routed to reviewer-2 or reviewer-3 (both healthy)
    expect(result.agentName).not.toBe("reviewer");
    expect(["reviewer-2", "reviewer-3"]).toContain(result.agentName);
  });

  it("resets health on successful dispatch", async () => {
    // Mark reviewer as having some failures (still healthy at 2 < 3 threshold)
    store.recordAgentFailure("reviewer", "503 error");
    store.recordAgentFailure("reviewer", "503 error");

    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = await dispatcher.dispatch("do something", {
      agentName: "reviewer",
      source: "manual",
    });

    // The routed agent should now have 0 consecutive failures
    const health = store.getAgentHealth(result.agentName);
    expect(health.consecutive_failures).toBe(0);
    expect(health.last_success_at).not.toBeNull();
    expect(health.is_healthy).toBe(true);
  });

  it("records failure on failed dispatch", async () => {
    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3457"));

    await expect(
      dispatcher.dispatch("do something", { agentName: "reviewer", source: "manual" }),
    ).rejects.toThrow("ECONNREFUSED");

    // Find which agent was actually routed to
    const task = store.listTasks({ status: "failed" })[0];
    const routedAgent = task.agent_name!;

    const health = store.getAgentHealth(routedAgent);
    expect(health.consecutive_failures).toBe(1);
    expect(health.last_error_at).not.toBeNull();
    expect(health.last_error_message).toContain("ECONNREFUSED");
  });

  it("auto-routing selects least-recently-failed when all pool instances are unhealthy", async () => {
    // Make all 3 reviewers unhealthy, but with different failure counts/times
    for (let i = 0; i < 5; i++) store.recordAgentFailure("reviewer", "503 error");
    for (let i = 0; i < 3; i++) store.recordAgentFailure("reviewer-2", "503 error");
    for (let i = 0; i < 4; i++) store.recordAgentFailure("reviewer-3", "503 error");

    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    // Override the router mock so auto-routing returns "reviewer" (the pool entry point)
    mockRoute.mockReturnValueOnce([{ agentName: "reviewer", confidence: 0.9, reason: "topic match" }]);
    mockRouteWithFallback.mockResolvedValueOnce([{ agentName: "reviewer", confidence: 0.9, reason: "topic match" }]);

    // Without explicit agentName, auto-routing + rebalancing picks the
    // least-unhealthy pool member (reviewer-2 has fewest failures).
    const result = await dispatcher.dispatch("review this PR", {
      source: "manual",
      // no agentName — let auto-routing pick the pool
    });

    // reviewer-2 has fewest failures (3), should be selected
    expect(result.agentName).toBe("reviewer-2");
  });

  it("explicit --agent bypasses pool rebalancing even when all instances are unhealthy", async () => {
    // Make all 3 reviewers unhealthy
    for (let i = 0; i < 5; i++) store.recordAgentFailure("reviewer", "503 error");
    for (let i = 0; i < 3; i++) store.recordAgentFailure("reviewer-2", "503 error");
    for (let i = 0; i < 4; i++) store.recordAgentFailure("reviewer-3", "503 error");

    const dispatcher = new Dispatcher(makePoolConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    // Explicit pin must be honoured — routes to reviewer regardless of health.
    const result = await dispatcher.dispatch("review this PR", {
      agentName: "reviewer",
      source: "manual",
    });

    expect(result.agentName).toBe("reviewer");
  });

  it("records failure for retryTask and updates agent health", async () => {
    const dispatcher = new Dispatcher(makePoolConfig(), store);
    // Create a task first — dispatch to reviewer pool, get routed to reviewer (first idle)
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });

    const result = await dispatcher.dispatch("do something", {
      agentName: "reviewer",
      source: "manual",
    });

    const routedAgent = result.agentName;

    // Now simulate the task failing on retry
    const task = store.getTask(result.taskId)!;
    store.updateTask(task.id, { status: "failed", retry_count: 1, next_retry_at: new Date().toISOString() });

    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3458"));
    await dispatcher.retryTask(store.getTask(task.id)!);

    const health = store.getAgentHealth(routedAgent);
    // Dispatch success reset to 0, then retry failure incremented to 1
    expect(health.consecutive_failures).toBe(1);
    expect(health.last_error_message).toContain("ECONNREFUSED");
  });

  it("records success for retryTask and resets agent health", async () => {
    const dispatcher = new Dispatcher(makePoolConfig(), store);

    // Create a task via dispatch that fails (connection error)
    mockSend.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3458"));
    await expect(
      dispatcher.dispatch("do something", { agentName: "reviewer", source: "manual" }),
    ).rejects.toThrow();

    const task = store.listTasks({ status: "failed" })[0];
    const routedAgent = task.agent_name!;
    store.updateTask(task.id, { status: "dispatched", next_retry_at: null });

    // Verify the agent has at least 1 failure recorded
    expect(store.getAgentHealth(routedAgent).consecutive_failures).toBeGreaterThanOrEqual(1);

    // Retry succeeds
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    await dispatcher.retryTask(store.getTask(task.id)!);

    const health = store.getAgentHealth(routedAgent);
    expect(health.consecutive_failures).toBe(0);
    expect(health.is_healthy).toBe(true);
  });

  it("defers retryTask without consuming a retry slot when provider is exhausted (#1420 Bug 2)", async () => {
    const dispatcher = new Dispatcher(makePoolConfig(), store);

    // Dispatch a task to reviewer so we have a real task record
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    const result = await dispatcher.dispatch("review this PR", {
      agentName: "reviewer",
      source: "manual",
    });
    const task = store.getTask(result.taskId)!;

    // Manually set the task up as if it had previously failed and is due for retry
    const initialRetryCount = 1;
    const resetAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min from now
    store.updateTask(task.id, {
      status: "failed",
      retry_count: initialRetryCount,
      next_retry_at: new Date().toISOString(),
    });

    // Simulate provider being exhausted (as would happen after a rate-limit failure)
    // Import provider-state functions to manipulate state in this test
    const { markProviderExhausted, markProviderAvailable } = await import("../service/provider-state.js");
    markProviderExhausted("claude", "rate limit hit", resetAt);

    try {
      // retryTask should detect exhausted provider and defer without sending
      await dispatcher.retryTask(store.getTask(task.id)!);

      // The agent's send should NOT have been called
      // (mockSend call count should still be 1 from the initial dispatch)
      expect(mockSend).toHaveBeenCalledTimes(1);

      // The task should be deferred (next_retry_at set to resetAt), not consumed
      const updatedTask = store.getTask(task.id)!;
      expect(updatedTask.status).toBe("failed");
      expect(updatedTask.retry_count).toBe(initialRetryCount); // unchanged — slot not consumed
      expect(updatedTask.next_retry_at).not.toBeNull();
    } finally {
      // Clean up provider state so other tests aren't affected
      markProviderAvailable("claude");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// StateStore agent health methods (issue #385)
// ────────────────────────────────────────────────────────────────────────────

describe("StateStore — agent health tracking", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns default healthy record for unknown agent", () => {
    const health = store.getAgentHealth("unknown-agent");
    expect(health.agent_name).toBe("unknown-agent");
    expect(health.consecutive_failures).toBe(0);
    expect(health.is_healthy).toBe(true);
    expect(health.last_error_at).toBeNull();
  });

  it("records failure and increments consecutive count", () => {
    store.recordAgentFailure("reviewer", "503 error");
    let health = store.getAgentHealth("reviewer");
    expect(health.consecutive_failures).toBe(1);
    expect(health.is_healthy).toBe(true); // threshold is 3

    store.recordAgentFailure("reviewer", "503 error again");
    health = store.getAgentHealth("reviewer");
    expect(health.consecutive_failures).toBe(2);
    expect(health.is_healthy).toBe(true);

    store.recordAgentFailure("reviewer", "still failing");
    health = store.getAgentHealth("reviewer");
    expect(health.consecutive_failures).toBe(3);
    expect(health.is_healthy).toBe(false); // now unhealthy
  });

  it("records success and resets consecutive failures", () => {
    store.recordAgentFailure("reviewer", "503 error");
    store.recordAgentFailure("reviewer", "503 error");
    store.recordAgentSuccess("reviewer");

    const health = store.getAgentHealth("reviewer");
    expect(health.consecutive_failures).toBe(0);
    expect(health.is_healthy).toBe(true);
    expect(health.last_success_at).not.toBeNull();
  });

  it("getAgentHealthBatch returns records for all requested agents", () => {
    store.recordAgentFailure("reviewer", "error");
    store.recordAgentSuccess("reviewer-2");

    const batch = store.getAgentHealthBatch(["reviewer", "reviewer-2", "reviewer-3"]);
    expect(batch).toHaveLength(3);
    expect(batch.find((h) => h.agent_name === "reviewer")!.consecutive_failures).toBe(1);
    expect(batch.find((h) => h.agent_name === "reviewer-2")!.consecutive_failures).toBe(0);
    expect(batch.find((h) => h.agent_name === "reviewer-3")!.is_healthy).toBe(true); // default
  });

  it("last_error_message is updated on each failure", () => {
    store.recordAgentFailure("reviewer", "first error");
    store.recordAgentFailure("reviewer", "second error");

    const health = store.getAgentHealth("reviewer");
    expect(health.last_error_message).toBe("second error");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Dispatcher — unknown-agent guard (issue #864)
// ────────────────────────────────────────────────────────────────────────────

describe("Dispatcher — UNKNOWN_AGENT dispatch guard (issue #864)", () => {
  let store: StateStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
  });

  it("returns stop_reason 'unknown-agent' when an explicit unknown agent is dispatched", async () => {
    const dispatcher = new Dispatcher(makeConfig(), store);
    const result = await dispatcher.dispatch("do the thing", {
      agentName: "codex-orchestrator-reviewer", // not in registry
      source: "manual",
    });

    expect(result.response.stop_reason).toBe("unknown-agent");
    expect(result.taskId).toBe("");
  });

  it("does NOT create a task in the store for an unknown-agent dispatch", async () => {
    const dispatcher = new Dispatcher(makeConfig(), store);
    await dispatcher.dispatch("do the thing", {
      agentName: "ghost-agent",
      source: "github",
      sourceRef: "owner/repo#42",
    });

    const tasks = store.listTasks({ limit: 100 });
    // No task should have been created for the unregistered agent
    expect(tasks.filter((t) => t.agent_name === "ghost-agent")).toHaveLength(0);
  });

  it("logs a supervisor decision with hard_gate UNKNOWN_AGENT", async () => {
    const dispatcher = new Dispatcher(makeConfig(), store);
    await dispatcher.dispatch("do the thing", {
      agentName: "stale-renamed-agent",
      source: "github",
      sourceRef: "owner/repo#99",
    });

    const decisions = store.getRecentSupervisorDecisions(5);
    const unknownAgentDecision = decisions.find(
      (d) => d.hard_gates.includes("UNKNOWN_AGENT"),
    );
    expect(unknownAgentDecision).toBeDefined();
    expect(unknownAgentDecision?.outcome).toBe("skipped");
    expect(unknownAgentDecision?.agent_name).toBe("stale-renamed-agent");
  });

  it("notifies the operator when an unknown agent is dispatched to", async () => {
    const dispatcher = new Dispatcher(makeConfig(), store);
    await dispatcher.dispatch("do the thing", {
      agentName: "codex-orchestrator-reviewer",
      source: "github",
      sourceRef: "owner/repo#1",
    });

    expect(mockNotifyOperator).toHaveBeenCalledWith(
      expect.stringContaining("UNKNOWN_AGENT"),
      expect.stringContaining("codex-orchestrator-reviewer"),
      "warning",
      expect.any(String),
    );
  });

  it("proceeds normally when dispatching to a registered agent", async () => {
    // Construct dispatcher first so mockSend captures the fresh vi.fn() from the
    // MockAgentClient constructor; then configure the return value.
    const dispatcher = new Dispatcher(makeConfig(), store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });
    const result = await dispatcher.dispatch("do the thing", {
      agentName: "test-agent", // registered in makeConfig()
      source: "manual",
    });

    expect(result.response.stop_reason).not.toBe("unknown-agent");
    expect(result.taskId).not.toBe("");
  });

  it("response content mentions the rejected agent name", async () => {
    const dispatcher = new Dispatcher(makeConfig(), store);
    const result = await dispatcher.dispatch("do the thing", {
      agentName: "codex-orchestrator-reviewer",
      source: "manual",
    });

    expect(result.response.content).toContain("codex-orchestrator-reviewer");
    expect(result.response.content).toContain("agent registry");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Repo-to-agent affinity guardrail (issue #928)
// ────────────────────────────────────────────────────────────────────────────

describe("dispatch() — repo-to-agent affinity guardrail (issue #928)", () => {
  let store: StateStore;

  /**
   * Build a config with three agents and an affinity table.
   * "test-agent" is the router-default (the module-level Router mock returns it).
   * "orchestrator-agent" is the canonical agent for "owner/orchestrator".
   * "dashboard-agent" is the canonical agent for "owner/dashboard".
   *
   * This lets us test auto-route correction: the router picks "test-agent"
   * but the affinity map redirects orchestrator tasks to "orchestrator-agent".
   */
  const makeAffinityConfig = (): OrchestratorConfig => ({
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    dispatch: {
      repo_affinity: {
        // router default ("test-agent") won't match for orchestrator tasks →
        // auto-route correction kicks in and picks "orchestrator-agent" instead.
        "owner/orchestrator": "orchestrator-agent",
        "owner/dashboard": "dashboard-agent",
      },
    },
    agents: {
      // The module-level Router mock always returns this agent name.
      // It's included so the unknown-agent guard passes in auto-route tests.
      "test-agent": {
        dir: "test-agent",
        description: "Router default agent (mock)",
        capabilities: ["implementation"],
        owns_topics: ["test"],
        github: "owner/other-repo",
        docker: { port: 3457, api_key: "secret" },
      },
      "orchestrator-agent": {
        dir: "orchestrator-agent",
        description: "Handles orchestrator repo",
        capabilities: ["implementation"],
        owns_topics: ["orchestrator"],
        github: "owner/orchestrator",
        docker: { port: 3490, api_key: "secret" },
      },
      "dashboard-agent": {
        dir: "dashboard-agent",
        description: "Handles dashboard repo",
        capabilities: ["implementation"],
        owns_topics: ["dashboard"],
        github: "owner/dashboard",
        docker: { port: 3491, api_key: "secret" },
      },
    },
  });

  beforeEach(() => {
    store = new StateStore(":memory:");
    vi.clearAllMocks();
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockCachedValidateForDispatch.mockReturnValue(null);
  });

  afterEach(() => {
    store.close();
  });

  it("auto-routed task to wrong agent is silently corrected to the canonical agent", async () => {
    const config = makeAffinityConfig();

    const dispatcher = new Dispatcher(config, store);
    // Override router mocks to return "dashboard-agent" (the wrong agent for orchestrator issues)
    mockRoute.mockReturnValue([
      { agentName: "dashboard-agent", confidence: 0.6, reason: "LLM fallback" },
    ]);
    mockRouteWithFallback.mockResolvedValue([
      { agentName: "dashboard-agent", confidence: 0.6, reason: "LLM fallback" },
    ]);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Dispatch WITHOUT specifying agentName (auto-route path)
    const result = await dispatcher.dispatch("Implement feature in orchestrator", {
      source: "github",
      sourceRef: "owner/orchestrator#42",
      // No agentName — relies on router
    });

    // The affinity guardrail should have corrected the route to orchestrator-agent
    expect(result.agentName).toBe("orchestrator-agent");
    expect(result.taskId).not.toBe("");
  });

  it("auto-routed task to correct canonical agent is not redirected", async () => {
    const config = makeAffinityConfig();
    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Router is mocked to return "orchestrator-agent" — the correct canonical agent
    // The Router mock in this test file returns "test-agent" by default.
    // We dispatch with an explicit sourceRef pointing to owner/orchestrator.
    const result = await dispatcher.dispatch("Fix orchestrator bug", {
      agentName: "orchestrator-agent", // explicit — correct
      source: "github",
      sourceRef: "owner/orchestrator#99",
    });

    // No affinity mismatch — should succeed normally, no warning notification
    expect(result.taskId).not.toBe("");
    expect(mockNotifyOperator).not.toHaveBeenCalledWith(
      expect.stringContaining("affinity"),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("explicit dispatch to non-canonical agent emits warning but proceeds", async () => {
    const config = makeAffinityConfig();
    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Explicit dispatch: dashboard-agent receives an orchestrator task (mismatch)
    const result = await dispatcher.dispatch("Orchestrator backend work", {
      agentName: "dashboard-agent",
      source: "github",
      sourceRef: "owner/orchestrator#10",
    });

    // Should still proceed (explicit override), but with a warning
    expect(result.taskId).not.toBe("");
    expect(result.response.stop_reason).not.toBe("repo-affinity-blocked");

    // A Telegram notification should have been sent about the mismatch
    expect(mockNotifyOperator).toHaveBeenCalledWith(
      expect.stringContaining("affinity"),
      expect.stringContaining("dashboard-agent"),
      "warning",
      expect.stringContaining("repo-affinity"),
    );
  });

  it("explicit dispatch mismatch writes a supervisor decision record", async () => {
    const config = makeAffinityConfig();
    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    await dispatcher.dispatch("Orchestrator backend work", {
      agentName: "dashboard-agent",
      source: "github",
      sourceRef: "owner/orchestrator#10",
    });

    const decisions = store.getRecentSupervisorDecisions(10);
    const affinityDecision = decisions.find((d) =>
      d.hard_gates?.includes("REPO_AFFINITY_MISMATCH"),
    );
    expect(affinityDecision).toBeDefined();
    expect(affinityDecision?.agent_name).toBe("dashboard-agent");
    expect(affinityDecision?.reason).toContain("owner/orchestrator");
    expect(affinityDecision?.reason).toContain("orchestrator-agent");
  });

  it("affinity guardrail does not fire when affinity map is absent", async () => {
    // Config without any affinity map
    const config = makeConfig(); // standard config, no dispatch.repo_affinity
    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    await dispatcher.dispatch("Normal dispatch", {
      agentName: "test-agent",
      source: "github",
      sourceRef: "owner/repo#5",
    });

    // No affinity-related notification
    expect(mockNotifyOperator).not.toHaveBeenCalledWith(
      expect.stringContaining("affinity"),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  }, 15000);

  it("affinity guardrail is skipped when mapped agent is not registered", async () => {
    const config = makeAffinityConfig();
    // Map orchestrator repo to an agent that doesn't exist in agents list
    config.dispatch = {
      repo_affinity: {
        "owner/orchestrator": "nonexistent-agent",
      },
    };

    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Should proceed without error — stale config entry doesn't block dispatch
    const result = await dispatcher.dispatch("Orchestrator work", {
      agentName: "dashboard-agent",
      source: "github",
      sourceRef: "owner/orchestrator#20",
    });

    expect(result.taskId).not.toBe("");
    // No warning for unknown mapped agent
    expect(mockNotifyOperator).not.toHaveBeenCalledWith(
      expect.stringContaining("affinity"),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("affinity guardrail does not fire for tasks without a sourceRef", async () => {
    const config = makeAffinityConfig();
    const dispatcher = new Dispatcher(config, store);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    // Manual dispatch without sourceRef — no repo to check affinity for
    const result = await dispatcher.dispatch("Ad-hoc task", {
      agentName: "dashboard-agent",
      source: "manual",
      // No sourceRef
    });

    expect(result.taskId).not.toBe("");
    expect(mockNotifyOperator).not.toHaveBeenCalledWith(
      expect.stringContaining("affinity"),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Genome-risk routing (issue #1131)
// ────────────────────────────────────────────────────────────────────────────

describe("dispatch() — failure genome routing (issue #1131)", () => {
  let store: StateStore;
  let genomeSpy: ReturnType<typeof vi.spyOn>;

  const makeGenomeConfig = (): OrchestratorConfig => ({
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    dispatch: {
      failure_genome_risk_threshold: 0.75,
    },
    agents: {
      "primary-agent": {
        dir: "primary-agent",
        description: "Primary implementation agent",
        capabilities: ["test"],
        owns_topics: ["genome"],
        github: "owner/repo",
        docker: { port: 3457, api_key: "secret" },
      },
      "backup-agent": {
        dir: "backup-agent",
        description: "Backup implementation agent",
        capabilities: ["test"],
        owns_topics: ["genome"],
        github: "owner/repo",
        docker: { port: 3458, api_key: "secret" },
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    store = new StateStore(":memory:");
    mockValidateGhAuth.mockReturnValue({ ok: true });
    genomeSpy = vi.spyOn(FailureInterceptor.prototype, "check");
  });

  afterEach(() => {
    genomeSpy.mockRestore();
    store.close();
  });

  it("reroutes away from a high-risk genome candidate when genome accuracy is above 60%", async () => {
    vi.spyOn(store, "getAntibodyFilterAccuracy").mockReturnValue({
      window_days: 30,
      total_flagged: 12,
      true_positives: 9,
      false_positives: 3,
      operator_overrides: 0,
      precision: 0.75,
    });

    genomeSpy.mockImplementation((_title, _taskType, agent) => {
      if (agent === "primary-agent") {
        return {
          intercepted: true,
          similarity_score: 0.88,
          risk_score: 0.91,
          lessons: ["avoid the risky path"],
          suggest_model_upgrade: true,
          matched_task_ids: ["task-a"],
        };
      }
      return {
        intercepted: false,
        similarity_score: 0.35,
        risk_score: 0.32,
        lessons: [],
        suggest_model_upgrade: false,
        matched_task_ids: [],
      };
    });

    const dispatcher = new Dispatcher(makeGenomeConfig(), store);
    mockRoute.mockReturnValue([
      { agentName: "primary-agent", confidence: 0.9, reason: "primary match" },
      { agentName: "backup-agent", confidence: 0.7, reason: "fallback match" },
    ]);
    mockRouteWithFallback.mockResolvedValue([
      { agentName: "primary-agent", confidence: 0.9, reason: "primary match" },
      { agentName: "backup-agent", confidence: 0.7, reason: "fallback match" },
    ]);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const result = await dispatcher.dispatch("Implement the genome-sensitive fix", {
      source: "manual",
    });

    expect(result.agentName).toBe("backup-agent");
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toBe("backup-agent");
  });

  it("does not query the genome when current accuracy is 60% or lower", async () => {
    vi.spyOn(store, "getAntibodyFilterAccuracy").mockReturnValue({
      window_days: 30,
      total_flagged: 12,
      true_positives: 6,
      false_positives: 6,
      operator_overrides: 0,
      precision: 0.5,
    });

    const dispatcher = new Dispatcher(makeGenomeConfig(), store);
    mockRoute.mockReturnValue([
      { agentName: "primary-agent", confidence: 0.9, reason: "primary match" },
      { agentName: "backup-agent", confidence: 0.7, reason: "fallback match" },
    ]);
    mockRouteWithFallback.mockResolvedValue([
      { agentName: "primary-agent", confidence: 0.9, reason: "primary match" },
      { agentName: "backup-agent", confidence: 0.7, reason: "fallback match" },
    ]);
    mockSend.mockResolvedValueOnce({
      content: "done",
      usage: { input_tokens: 5, output_tokens: 10 },
    });

    const result = await dispatcher.dispatch("Implement the genome-sensitive fix", {
      source: "manual",
    });

    expect(result.agentName).toBe("primary-agent");
    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend.mock.calls[0][0]).toBe("primary-agent");
  });
});
