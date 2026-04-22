import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockCountOpenPRs = vi.fn();
const mockCachedGetIssueState = vi.fn();
const mockFindExistingPRsForIssue = vi.fn();

vi.mock("../triggers/github.js", () => ({
  countOpenPRs: (...args: unknown[]) => mockCountOpenPRs(...args),
  findApprovedPRForIssue: vi.fn().mockReturnValue(null),
  findBranchForIssue: vi.fn().mockReturnValue(null),
  findExistingPRsForIssue: (...args: unknown[]) => mockFindExistingPRsForIssue(...args),
  // Cross-repo check (issue #991): default fail-open (no peer-repo PRs found)
  findExistingPRsForIssueAcrossRepos: vi.fn().mockReturnValue([]),
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
  mockFindExistingPRsForIssue.mockReset();
  mockCachedGetIssueState.mockReturnValue({
    state: "open",
    hasOpenPR: false,
    hasMergedPR: false,
    fetchedAt: Date.now(),
  });
  mockFindExistingPRsForIssue.mockReturnValue([]);
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

  it("blocks dispatch when an open PR already exists even if the cache says no PR exists", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(0);
    mockCachedGetIssueState.mockReturnValue({
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    });
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 17, title: "WIP fix", url: "https://github.com/owner/repo/pull/17", state: "open", isDraft: false },
    ]);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 42 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("open_pr_exists");
    expect(result.failureReason).toContain("already has open PR #17");
    expect(mockFindExistingPRsForIssue).toHaveBeenCalledWith("owner/repo", 42);
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

  it("includes the known agent names in the failure reason (agent registry)", () => {
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

// ────────────────────────────────────────────────────────────────────────────
// Pre-dispatch open-PR dedup gate — issue #884
// ────────────────────────────────────────────────────────────────────────────

describe("runGitHubPreDispatchValidation — open-PR dedup gate (issue #884)", () => {
  it("blocks dispatch when a non-draft open PR already closes the issue", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 42, title: "Fix it", url: "https://github.com/owner/repo/pull/42", state: "open", isDraft: false },
    ]);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 10 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("open_pr_exists");
    expect(result.failureReason).toContain("open PR #42");
    expect(result.blockingPRNumber).toBe(42);
  });

  it("blocks dispatch even when cache reports hasOpenPR: false (stale cache bypass, issue #884)", () => {
    // Simulate the exact failure mode: cache says no open PR (fresh 60-second
    // hit) but the agent opened a PR in the same cycle. The validator must
    // call findExistingPRsForIssue unconditionally to catch this.
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);
    // Cache claims hasOpenPR: false — stale data from earlier in the poll cycle
    mockCachedGetIssueState.mockReturnValue({
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    });
    // But live API shows an open PR
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 99, title: "Already done", url: "https://github.com/owner/repo/pull/99", state: "open", isDraft: false },
    ]);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 11 },
    });

    expect(result.outcome).toBe("blocked");
    expect(result.failureCode).toBe("open_pr_exists");
    expect(result.blockingPRNumber).toBe(99);
    // Confirm findExistingPRsForIssue was called regardless of cached state
    expect(mockFindExistingPRsForIssue).toHaveBeenCalledWith("owner/repo", 11);
  });

  it("allows dispatch through a draft PR (draft does not gate dispatch)", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 55, title: "WIP", url: "https://github.com/owner/repo/pull/55", state: "open", isDraft: true },
    ]);

    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 12 },
    });

    // Draft PRs should not block; agent is asked to continue existing work
    expect(result.outcome).toBe("passed");
    expect(result.draftPR).not.toBeNull();
    expect(result.draftPR?.number).toBe(55);
  });

  it("always calls findExistingPRsForIssue regardless of cache state", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(0);
    // Cache reports no open/merged PRs — but we should still call the live check
    mockCachedGetIssueState.mockReturnValue({
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    });
    mockFindExistingPRsForIssue.mockReturnValue([]);

    runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 13 },
    });

    // Must have been called unconditionally — not gated on cache
    expect(mockFindExistingPRsForIssue).toHaveBeenCalledWith("owner/repo", 13);
  });

  it("persists an open_pr_exists block to the dispatch_validations table", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 77, title: "My PR", url: "https://github.com/owner/repo/pull/77", state: "open", isDraft: false },
    ]);

    runGitHubPreDispatchValidation({
      config,
      store,
      source: "github",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 14 },
    });

    const rows = store.getDispatchValidationHistory("owner/repo#14", 10);
    expect(rows.length).toBeGreaterThan(0);
    const block = rows.find((r) => r.failure_code === "open_pr_exists");
    expect(block).toBeDefined();
    expect(block?.outcome).toBe("blocked");
  });

  it("exempts pr-feedback source from open_pr_exists guard (issue #1073)", () => {
    const config = makeConfig();
    const store = new StateStore(":memory:");
    mockCountOpenPRs.mockReturnValue(1);
    mockFindExistingPRsForIssue.mockReturnValue([
      { number: 1057, title: "Fix schema", url: "https://github.com/owner/repo/pull/1057", state: "open", isDraft: false },
    ]);

    // pr-feedback should bypass the open_pr_exists guard since feedback
    // by definition targets an already-open PR
    const result = runGitHubPreDispatchValidation({
      config,
      store,
      source: "pr-feedback",
      agentName: "test-agent",
      issue: { repo: "owner/repo", number: 1057 },
    });

    expect(result.outcome).toBe("passed");
    expect(result.failureCode).toBeNull();
    const feedbackCheck = result.checks.find((c) => c.code === "open_pr_feedback_allowed");
    expect(feedbackCheck).toBeDefined();
    expect(feedbackCheck?.status).toBe("info");
    expect(feedbackCheck?.detail).toContain("pr-feedback source is allowed");
  });
});
