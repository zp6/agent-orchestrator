import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockCountOpenPRs = vi.fn();
const mockCachedGetIssueState = vi.fn();

vi.mock("../triggers/github.js", () => ({
  countOpenPRs: (...args: unknown[]) => mockCountOpenPRs(...args),
  findApprovedPRForIssue: vi.fn().mockReturnValue(null),
  findBranchForIssue: vi.fn().mockReturnValue(null),
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
}));

vi.mock("../triggers/issue-state-bridge.js", () => ({
  cachedGetIssueState: (...args: unknown[]) => mockCachedGetIssueState(...args),
}));

vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runGitHubPreDispatchValidation } from "./pre-dispatch-validator.js";

function makeConfig(): OrchestratorConfig {
  return {
    proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
    orchestrator_dir: "/tmp/orch",
    base_dir: "/tmp",
    dispatch: { max_open_prs: 3 },
    agents: {
      "test-agent": {
        dir: "test-agent",
        description: "Test agent",
        capabilities: ["typescript"],
        owns_topics: ["test"],
        github: "owner/repo",
      },
    },
  };
}

beforeEach(() => {
  mockCountOpenPRs.mockReset();
  mockCachedGetIssueState.mockReset();
  mockCachedGetIssueState.mockReturnValue({
    state: "open",
    hasOpenPR: false,
    hasMergedPR: false,
    fetchedAt: Date.now(),
  });
});

describe("runGitHubPreDispatchValidation", () => {
  it("blocks dispatch when the target repo is at PR capacity", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(3);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 42 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("repo_at_pr_capacity");
    expect(result.failureReason).toContain("open PR(s)");
    expect(mockCachedGetIssueState).not.toHaveBeenCalled();
  });

  it("uses the per-agent PR cap override before the global default", () => {
    const config = makeConfig();
    config.agents["test-agent"].max_open_prs = 2;
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(2);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 42 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("repo_at_pr_capacity");
    expect(result.failureReason).toContain("cap of 2");
  });

  it("passes when open PR count is below the cap", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 42 },
    });

    expect(result.outcome).toBe("passed");
    expect(result.checks.some((check) => check.name === "repo_pr_capacity" && check.code === "within_pr_cap")).toBe(true);
    expect(mockCachedGetIssueState).toHaveBeenCalled();
  });
});
