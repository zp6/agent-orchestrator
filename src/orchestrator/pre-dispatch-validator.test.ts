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

// ────────────────────────────────────────────────────────────────────────────
// Agent registry check — issue #864
// ────────────────────────────────────────────────────────────────────────────

describe("runGitHubPreDispatchValidation — agent_registered check (issue #864)", () => {
  it("blocks dispatch with UNKNOWN_AGENT when agent is not in registry", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "codex-orchestrator-reviewer", // not in config
      issue: { repo: "owner/repo", number: 1 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("UNKNOWN_AGENT");
    expect(result.failureCheck).toBe("agent_registered");
    expect(result.failureReason).toContain("codex-orchestrator-reviewer");
    expect(result.failureReason).toContain("agent registry");
  });

  it("does not call GitHub APIs when agent is unregistered (early bail-out)", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");

    runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "ghost-agent",
      issue: { repo: "owner/repo", number: 2 },
    });

    // Should bail out before reaching any GitHub API calls
    expect(mockCountOpenPRs).not.toHaveBeenCalled();
    expect(mockCachedGetIssueState).not.toHaveBeenCalled();
  });

  it("persists the UNKNOWN_AGENT rejection to the dispatch_validations table", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");

    runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "stale-renamed-agent",
      issue: { repo: "owner/repo", number: 5 },
    });

    const rows = store.getDispatchValidationHistory("owner/repo#5", 10);
    expect(rows.length).toBeGreaterThan(0);
    const rejection = rows.find((r) => r.failure_code === "UNKNOWN_AGENT");
    expect(rejection).toBeDefined();
    expect(rejection?.outcome).toBe("blocked");
    expect(rejection?.agent_name).toBe("stale-renamed-agent");
  });

  it("passes the agent_registered check for a known agent", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(0);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent", // registered in config
      issue: { repo: "owner/repo", number: 7 },
    });

    const registryCheck = result.checks.find((c) => c.name === "agent_registered");
    expect(registryCheck).toBeDefined();
    expect(registryCheck?.status).toBe("passed");
    expect(registryCheck?.code).toBe("agent_in_registry");
  });

  it("includes the known agent names in the failure reason", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "mystery-agent",
      issue: { repo: "owner/repo", number: 9 },
    });

    expect(result.failureReason).toContain("test-agent"); // the known agent in makeConfig()
  });
});
