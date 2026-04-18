import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const {
  baseConfig,
  mocks,
  MockStateStore,
  MockDispatcher,
  MockReviewerClient,
  MockResearchLinker,
  MockIssueCreator,
  MockPRReviewer,
  MockPRCreationRetryQueue,
  MockConfigWatcher,
} = vi.hoisted(() => {
  const mockNotifyOperator = vi.fn().mockResolvedValue(undefined);
  const mockClearNotifyRateLimit = vi.fn();
  const mockHealthCheck = vi.fn();
  const mockRestartAgent = vi.fn();
  const mockCheckSecretsHealth = vi.fn();

  class MockStateStore {
    private tasks = new Map<string, {
      id: string;
      title: string;
      description: string | null;
      source: string;
      source_ref: string | null;
      agent_name: string | null;
      status: string;
      result: string | null;
      task_type: string;
      created_at: string;
      updated_at: string;
    }>();

    recordTokenUsage = vi.fn();
    recordCycleStart = vi.fn(() => 1);
    recordCycleEnd = vi.fn();
    close = vi.fn();
    getTotalCycleCount = vi.fn(() => 0);
    findEscalatedTask = vi.fn((sourceRef: string) =>
      [...this.tasks.values()].find((task) => task.source_ref === sourceRef && task.status === "escalated"),
    );
    findActiveIncidentTask = vi.fn((sourceRef: string) =>
      [...this.tasks.values()]
        .filter((task) => task.source_ref === sourceRef &&
          ["pending", "planning", "dispatched", "in_progress", "escalated"].includes(task.status))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0],
    );
    createTask = vi.fn((task: {
      title: string;
      description: string | null;
      source: string;
      source_ref: string | null;
      agent_name: string | null;
      task_type: string;
    }) => {
      const now = new Date().toISOString();
      const created = {
        id: `task-${this.tasks.size + 1}`,
        title: task.title,
        description: task.description,
        source: task.source,
        source_ref: task.source_ref,
        agent_name: task.agent_name,
        status: "pending",
        result: null,
        task_type: task.task_type,
        created_at: now,
        updated_at: now,
      };
      this.tasks.set(created.id, created);
      return created;
    });
    updateTask = vi.fn((id: string, updates: Partial<{ status: string; result: string | null }>) => {
      const task = this.tasks.get(id);
      if (!task) return undefined;
      Object.assign(task, updates, { updated_at: new Date().toISOString() });
      return task;
    });
    upsertSecretMountStatus = vi.fn();
    getSecretMountStatus = vi.fn(() => []);
    recordHealthCheckEvent = vi.fn();
  }

  class MockDispatcher {
    constructor(..._args: unknown[]) {}
  }

  class MockReviewerClient {
    constructor(..._args: unknown[]) {}
  }

  class MockResearchLinker {
    constructor(..._args: unknown[]) {}
  }

  class MockIssueCreator {
    constructor(..._args: unknown[]) {}
  }

  class MockPRReviewer {
    constructor(..._args: unknown[]) {}
  }

  class MockPRCreationRetryQueue {
    constructor(..._args: unknown[]) {}
    resetAuthFailures = vi.fn(() => 0);
  }

  class MockConfigWatcher {
    constructor(..._args: unknown[]) {}
    reload = vi.fn(() => ({ success: true, changes: [], errors: [] }));
  }

  return {
    baseConfig: {
      proxy: { url: "http://proxy", manager_url: "http://manager", timeout_ms: 1000 },
      orchestrator_dir: "/tmp/orchestrator",
      base_dir: "/tmp/base",
      agents: {
        "agent-a": {
          dir: "agent-a",
          description: "Test agent",
          capabilities: ["test"],
          owns_topics: ["test"],
          docker: { port: 3460 },
        },
      },
      verification: { enabled: false },
      notifications: { telegram_rate_limit_ms: 0 },
      deploy: {},
      daemon: {},
    },
    mocks: {
      mockHealthCheck,
      mockNotifyOperator,
      mockClearNotifyRateLimit,
      mockRestartAgent,
      mockCheckSecretsHealth,
    },
    MockStateStore,
    MockDispatcher,
    MockReviewerClient,
    MockResearchLinker,
    MockIssueCreator,
    MockPRReviewer,
    MockPRCreationRetryQueue,
    MockConfigWatcher,
  };
});

vi.mock("../config/schema.js", () => ({
  loadConfig: vi.fn(() => baseConfig),
}));

vi.mock("../config/validator.js", () => ({
  validateConfig: vi.fn(() => []),
}));

vi.mock("../state/store.js", () => ({
  StateStore: MockStateStore,
}));

vi.mock("../client/llm-client.js", () => ({
  setLLMUsageRecorder: vi.fn(),
}));

vi.mock("../client/reviewer-client.js", () => ({
  ReviewerClient: MockReviewerClient,
}));

vi.mock("../orchestrator/research-linker.js", () => ({
  ResearchLinker: MockResearchLinker,
}));

vi.mock("../orchestrator/issue-creator.js", () => ({
  IssueCreator: MockIssueCreator,
}));

vi.mock("../orchestrator/pr-reviewer.js", () => ({
  PRReviewer: MockPRReviewer,
}));

vi.mock("../orchestrator/pr-creation-retry-queue.js", () => ({
  PRCreationRetryQueue: MockPRCreationRetryQueue,
}));

vi.mock("../triggers/issue-state-bridge.js", () => ({
  initIssueCachePersistence: vi.fn(),
  cachedIsIssueOpen: vi.fn(),
  cachedGetIssueState: vi.fn(),
  logCacheMetrics: vi.fn(),
}));

vi.mock("../triggers/trigger-dispatcher.js", () => ({
  dispatchGitHubIssues: vi.fn(),
  dispatchIdleAgentBacklog: vi.fn(),
  dispatchLinearChecks: vi.fn(),
  dispatchSlackChecks: vi.fn(),
}));

vi.mock("../orchestrator/dispatcher.js", () => ({
  Dispatcher: MockDispatcher,
  MAX_RETRIES: 3,
  TIMEOUT_RETRY_MAX: 2,
  TIMEOUT_RETRY_BACKOFF_MS: 120_000,
  extractRepoFromSourceRef: vi.fn(),
}));

vi.mock("../orchestrator/sync.js", () => ({
  planSync: vi.fn(() => []),
  executeSync: vi.fn(() => ({ errors: [] })),
}));

vi.mock("../service/notify.js", () => ({
  notifyOperator: mocks.mockNotifyOperator,
  clearNotifyRateLimit: mocks.mockClearNotifyRateLimit,
  setTelegramRateLimitMs: vi.fn(),
}));

vi.mock("./pid.js", () => ({
  writePid: vi.fn(),
  removePid: vi.fn(),
}));

vi.mock("./telegram.js", () => ({
  startTelegramPolling: vi.fn(),
  stopTelegramPolling: vi.fn(),
  pollTelegram: vi.fn(),
}));

vi.mock("./slack-digest.js", () => ({
  maybePostDailyDigest: vi.fn(),
}));

vi.mock("../orchestrator/security-scanner.js", () => ({
  maybeRunDailySecurityScan: vi.fn(),
}));

vi.mock("../orchestrator/team-meeting.js", () => ({
  runTeamMeeting: vi.fn(),
}));

vi.mock("../service/logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock("../orchestrator/deployer.js", () => ({
  Deployer: class {
    healthCheck = mocks.mockHealthCheck;
    restartAgent = mocks.mockRestartAgent;
    checkSecretsHealth = mocks.mockCheckSecretsHealth;
    getRegisteredAgents = vi.fn();
    getStaleAgents = vi.fn(() => []);
    getStaleRepoAgents = vi.fn(() => []);
    redeployStale = vi.fn(() => []);
  },
}));

vi.mock("../config/watcher.js", () => ({
  ConfigWatcher: MockConfigWatcher,
}));

import { Daemon, HEALTH_RECOVERY_CONFIRM_CYCLES, HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS, formatHealthDuration } from "./daemon.js";

describe("formatHealthDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatHealthDuration(45_000)).toBe("45s");
  });

  it("formats minutes under an hour", () => {
    expect(formatHealthDuration(12 * 60 * 1000)).toBe("12m");
  });

  it("formats hours and minutes beyond an hour", () => {
    expect(formatHealthDuration((1 * 60 * 60 + 2 * 60 + 9) * 1000)).toBe("1h 2m");
  });
});

describe("daemon health recovery", () => {
  beforeEach(() => {
    mocks.mockHealthCheck.mockReset();
    mocks.mockHealthCheck.mockResolvedValue(true);
    mocks.mockRestartAgent.mockReset();
    mocks.mockRestartAgent.mockResolvedValue({ agentName: "agent-a", action: "redeployed" });
    mocks.mockCheckSecretsHealth.mockReset();
    mocks.mockCheckSecretsHealth.mockResolvedValue({ reachable: true, healthy: true, unhealthySecrets: [], mountDetails: [] });
    mocks.mockNotifyOperator.mockClear();
    mocks.mockClearNotifyRateLimit.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── onHealthCheckFailed (direct escalation, called after recovery exhausted) ─

  it("immediately escalates with Telegram alert when called directly", () => {
    const daemon = new Daemon();

    (daemon as any).onHealthCheckFailed("agent-a", "container stopped responding");

    expect(mocks.mockNotifyOperator).toHaveBeenCalledWith(
      "Health check failed: agent-a",
      expect.stringContaining("container stopped responding"),
      "critical",
      "health-fail:agent-a",
    );
  });

  it("does not send a second Telegram alert if called again after escalation", () => {
    const daemon = new Daemon();

    (daemon as any).onHealthCheckFailed("agent-a", "detail one");
    mocks.mockNotifyOperator.mockClear();
    (daemon as any).onHealthCheckFailed("agent-a", "detail two");

    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("debounces recovery for three consecutive passing checks and reports the duration", async () => {
    expect(HEALTH_RECOVERY_CONFIRM_CYCLES).toBe(3);

    const daemon = new Daemon();
    const deployer = {
      healthCheck: mocks.mockHealthCheck,
      restartAgent: mocks.mockRestartAgent,
      checkSecretsHealth: mocks.mockCheckSecretsHealth,
    };
    (daemon as unknown as { deployer: typeof deployer }).deployer = deployer;

    (daemon as any).onHealthCheckFailed("agent-a", "container stopped responding");
    expect(mocks.mockNotifyOperator).toHaveBeenCalledWith(
      "Health check failed: agent-a",
      expect.stringContaining("container stopped responding"),
      "critical",
      "health-fail:agent-a",
    );

    mocks.mockNotifyOperator.mockClear();

    mocks.mockHealthCheck
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    vi.setSystemTime(new Date("2026-04-07T12:04:00Z"));
    await (daemon as any).checkHealthRecoveries();
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-07T12:08:00Z"));
    await (daemon as any).checkHealthRecoveries();
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-07T12:12:00Z"));
    await (daemon as any).checkHealthRecoveries();
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-07T12:16:00Z"));
    await (daemon as any).checkHealthRecoveries();
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-07T12:20:00Z"));
    await (daemon as any).checkHealthRecoveries();
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-04-07T12:24:00Z"));
    await (daemon as any).checkHealthRecoveries();

    expect(mocks.mockNotifyOperator).toHaveBeenCalledTimes(1);
    expect(mocks.mockNotifyOperator).toHaveBeenCalledWith(
      "Agent agent-a recovered",
      expect.stringContaining("24m"),
      "info",
      "health-recovery:agent-a",
    );
    expect(mocks.mockHealthCheck).toHaveBeenCalledTimes(6);
  });

  // ─── runAutoRecoveryPlaybook ────────────────────────────────────────────────

  it("exports HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS = 2", () => {
    expect(HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS).toBe(2);
  });

  it("recovers silently without operator notification when first restart succeeds", async () => {
    // restartAgent returns "redeployed" (default mock) — first attempt succeeds.
    const daemon = new Daemon();

    await (daemon as any).runAutoRecoveryPlaybook("agent-a", "health check timed out");

    // No escalation — operator is never notified.
    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();
    // Agent removed from failing set.
    expect((daemon as any).healthFailingAgents.has("agent-a")).toBe(false);
    // Secrets and restart called exactly once.
    expect(mocks.mockCheckSecretsHealth).toHaveBeenCalledTimes(1);
    expect(mocks.mockRestartAgent).toHaveBeenCalledTimes(1);
  });

  it("tries second restart when first attempt fails and recovers silently", async () => {
    mocks.mockRestartAgent
      .mockResolvedValueOnce({ agentName: "agent-a", action: "health-check-failed", detail: "still down" })
      .mockResolvedValueOnce({ agentName: "agent-a", action: "redeployed" });

    const daemon = new Daemon();
    await (daemon as any).runAutoRecoveryPlaybook("agent-a", "port unreachable");

    expect(mocks.mockNotifyOperator).not.toHaveBeenCalled();
    expect(mocks.mockRestartAgent).toHaveBeenCalledTimes(2);
    expect(mocks.mockCheckSecretsHealth).toHaveBeenCalledTimes(2);
    expect((daemon as any).healthFailingAgents.has("agent-a")).toBe(false);
  });

  it("escalates via Telegram after exhausting all recovery attempts", async () => {
    // Both restart attempts fail.
    mocks.mockRestartAgent.mockResolvedValue({
      agentName: "agent-a",
      action: "health-check-failed",
      detail: "container won't start",
    });

    const daemon = new Daemon();
    await (daemon as any).runAutoRecoveryPlaybook("agent-a", "ECONNREFUSED");

    expect(mocks.mockNotifyOperator).toHaveBeenCalledWith(
      "Health check failed: agent-a",
      expect.stringContaining("ECONNREFUSED"),
      "critical",
      "health-fail:agent-a",
    );
    // All attempts tried.
    expect(mocks.mockRestartAgent).toHaveBeenCalledTimes(HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS);
  });

  it("includes secrets check results in the escalation task description", async () => {
    mocks.mockCheckSecretsHealth.mockResolvedValue({
      reachable: true,
      healthy: false,
      unhealthySecrets: ["gh_token"],
      mountDetails: [{ name: "gh_token", status: "not-mounted", reason: "file not found or unreadable (ENOENT — secret was never injected)" }],
    });
    mocks.mockRestartAgent.mockResolvedValue({
      agentName: "agent-a",
      action: "health-check-failed",
      detail: "still unhealthy",
    });

    const daemon = new Daemon();
    await (daemon as any).runAutoRecoveryPlaybook("agent-a", "startup failure");

    // The task description should mention the unhealthy secret.
    const store = (daemon as any).store;
    const createTaskCall = store.createTask.mock.calls[0]?.[0];
    expect(createTaskCall).toBeDefined();
    expect(createTaskCall.description).toContain("gh_token");
  });

  it("is a no-op when agent is already being tracked (prevents concurrent playbooks)", async () => {
    const daemon = new Daemon();

    // Simulate agent already tracked.
    (daemon as any).healthFailingAgents.add("agent-a");

    await (daemon as any).runAutoRecoveryPlaybook("agent-a", "second call");

    expect(mocks.mockRestartAgent).not.toHaveBeenCalled();
    expect(mocks.mockCheckSecretsHealth).not.toHaveBeenCalled();
  });
});
