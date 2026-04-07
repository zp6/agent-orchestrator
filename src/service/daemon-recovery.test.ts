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
    findEscalatedTask = vi.fn((sourceRef: string) =>
      [...this.tasks.values()].find((task) => task.source_ref === sourceRef && task.status === "escalated"),
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
    getRegisteredAgents = vi.fn();
    getStaleAgents = vi.fn(() => []);
    getStaleRepoAgents = vi.fn(() => []);
    redeployStale = vi.fn(() => []);
    restartAgent = vi.fn();
  },
}));

vi.mock("../config/watcher.js", () => ({
  ConfigWatcher: MockConfigWatcher,
}));

import { Daemon, HEALTH_RECOVERY_CONFIRM_CYCLES, formatHealthDuration } from "./daemon.js";

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
    mocks.mockNotifyOperator.mockClear();
    mocks.mockClearNotifyRateLimit.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces recovery for three consecutive passing checks and reports the duration", async () => {
    expect(HEALTH_RECOVERY_CONFIRM_CYCLES).toBe(3);

    const daemon = new Daemon();
    const deployer = {
      healthCheck: mocks.mockHealthCheck,
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
});
