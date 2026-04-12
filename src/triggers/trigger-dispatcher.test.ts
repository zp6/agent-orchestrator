import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchGitHubIssues, dispatchIdleAgentBacklog, dispatchLinearChecks, dispatchSlackChecks, buildExistingPRReviewChecklist } from "./trigger-dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";

vi.mock("./github.js", () => ({
  fetchOpenIssues: vi.fn(),
  findApprovedPRForIssue: vi.fn().mockReturnValue(null),
  findBranchForIssue: vi.fn().mockReturnValue(null),
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  isIssueOpen: vi.fn().mockReturnValue(true),
  countOpenPRs: vi.fn().mockReturnValue(0),
  // Default: authenticated — tests that need unauthenticated state override this
  validateGhAuth: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("./reporters.js", () => ({
  reportResult: vi.fn(),
  DEFAULT_ESCALATION_RETRY_LIMIT: 3,
}));

// Mock issue-state-bridge: default = issue is open, no PRs
vi.mock("./issue-state-bridge.js", () => ({
  cachedIsIssueOpen: vi.fn().mockReturnValue(true),
  cachedGetIssueState: vi.fn().mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false }),
  logCacheMetrics: vi.fn(),
}));

import { fetchOpenIssues, findApprovedPRForIssue, findBranchForIssue, findExistingPRsForIssue, isIssueOpen, validateGhAuth } from "./github.js";
import { cachedGetIssueState } from "./issue-state-bridge.js";
const mockFetchIssues = vi.mocked(fetchOpenIssues);
const mockFindApprovedPR = vi.mocked(findApprovedPRForIssue);
const mockFindBranchForIssue = vi.mocked(findBranchForIssue);
const mockFindExistingPRs = vi.mocked(findExistingPRsForIssue);
const mockIsIssueOpen = vi.mocked(isIssueOpen);
const mockValidateGhAuth = vi.mocked(validateGhAuth);
const mockCachedGetIssueState = vi.mocked(cachedGetIssueState);

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "my-agent": {
      dir: "my-agent",
      description: "Test agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/my-repo",
    },
    "linear-agent": {
      dir: "linear-agent",
      description: "Linear agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      linear: { teams: ["ENG"] },
    },
    "slack-agent": {
      dir: "slack-agent",
      description: "Slack agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      slack: { channels: ["#eng"], mention_pattern: "@bot" },
    },
    "no-triggers": {
      dir: "no-triggers",
      description: "No triggers",
      capabilities: ["test"],
      owns_topics: ["test"],
    },
  },
};

describe("dispatchGitHubIssues", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      // checkDuplicate calls this; return undefined by default (no prior task)
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: issues are open (pre-dispatch validation passes)
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
  });

  it("dispatches new issues to owning agent", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Bug"),
      expect.objectContaining({ sourceRepo: "owner/my-repo", source: "github", sourceRef: "owner/my-repo#1" }),
    );
  });

  it("skips issues that already have an active task (duplicate-guard)", async () => {
    // Simulate an active dispatched task for this source_ref
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-existing",
      status: "dispatched",
      source: "github",
      source_ref: "owner/my-repo#1",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
    ]);
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips agents without github field", async () => {
    mockFetchIssues.mockReturnValue([]);
    await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(mockFetchIssues).toHaveBeenCalledTimes(1);
    expect(mockFetchIssues).toHaveBeenCalledWith("owner/my-repo");
  });

  it("collects errors and continues", async () => {
    mockFetchIssues.mockImplementation(() => { throw new Error("API rate limit"); });
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");
  });

  it("fire-and-forget: returns immediately, limited to maxPerAgent", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
      { repo: "owner/my-repo", number: 2, title: "Feature", body: "", url: "", labels: [] },
    ]);
    // With maxPerAgent=1, only the first issue is dispatched
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher, 1);
    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0); // second issue not reached due to limit
  });

  it("aborts with an error when gh auth pre-flight fails", async () => {
    mockValidateGhAuth.mockReturnValue({
      ok: false,
      reason: "gh CLI is not authenticated: You are not logged into any GitHub hosts. Set the GH_TOKEN environment variable or run `gh auth login` to authenticate.",
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gh auth pre-flight failed");
    // Verify no issues were fetched or dispatched
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("proceeds normally when gh auth pre-flight succeeds", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("skips auth-degraded agents without fetching issues (issue #430)", async () => {
    vi.mocked(mockStore.isAgentAuthDegraded).mockReturnValue(true);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // Should skip without fetching issues or dispatching
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches to non-degraded agents while skipping degraded ones (issue #430)", async () => {
    // my-agent is degraded, but it's the only one with github config
    vi.mocked(mockStore.isAgentAuthDegraded).mockImplementation((name: string) => name === "my-agent");
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // my-agent is the only github agent, and it's degraded → nothing dispatched
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("dispatches a priority-boosted issue ahead of older issue numbers", async () => {
    (mockStore.isSourceRefPriorityBoosted as ReturnType<typeof vi.fn>).mockImplementation(
      (_source: string, sourceRef: string) => sourceRef === "owner/my-repo#9",
    );
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 5, title: "Older", body: "", url: "", labels: [] },
      { repo: "owner/my-repo", number: 9, title: "Boosted", body: "", url: "", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher, 1);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Boosted"),
      expect.objectContaining({ sourceRef: "owner/my-repo#9" }),
    );
    expect(mockStore.clearSourceRefPriority).toHaveBeenCalledWith("github", "owner/my-repo#9");
  });
});

describe("pre-dispatch issue state validation", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockFindExistingPRs.mockReturnValue([]);
    // Default: issues are open
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
  });

  it("skips dispatch when issue has been closed (race condition guard)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Stale issue", body: "Already done", url: "https://...", labels: [] },
    ]);
    // Issue was fetched as open but has since been closed
    mockCachedGetIssueState.mockReturnValue({ state: "closed", hasOpenPR: false, hasMergedPR: false });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    // Should mark processed so it isn't re-checked every cycle
    expect(mockStore.markProcessed).toHaveBeenCalledWith("github", "owner/my-repo#42", expect.stringContaining("closed-issue-42"));
  });

  it("proceeds with dispatch when issue is confirmed open", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Live issue", body: "Needs work", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("proceeds with dispatch when isIssueOpen fails (fail-open)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Issue", body: "Needs work", url: "https://...", labels: [] },
    ]);
    // isIssueOpen returns true on error (fail-open) — dispatch should proceed
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
  });
});

describe("duplicate PR detection before dispatch", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: no existing PRs, issues are open
    mockFindExistingPRs.mockReturnValue([]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
  });

  it("dispatches normally when no existing PRs are found", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockFindExistingPRs.mockReturnValue([]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Bug"),
      expect.objectContaining({ sourceRepo: "owner/my-repo" }),
    );
  });

  it("skips dispatch when a merged PR already addresses the issue", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: true });
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 10, title: "Fix bug", url: "https://github.com/owner/my-repo/pull/10", state: "merged", isDraft: false },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    // Bug 2: markProcessed must be called so the issue isn't re-polled every cycle
    expect(mockStore.markProcessed).toHaveBeenCalledWith("github", "owner/my-repo#42", expect.stringContaining("merged-pr-10"));
  });

  it("skips dispatch when a non-draft open PR already exists (open-PR dispatch guard)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP fix", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: false },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // Must NOT dispatch when a ready (non-draft) open PR already exists
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    // Must NOT mark processed — the issue should be re-evaluated on the next cycle
    // in case the PR is closed/rejected and needs re-dispatch
    expect(mockStore.markProcessed).not.toHaveBeenCalled();
  });

  it("dispatches with draft PR context injected when only a draft PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP fix", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: true },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // Draft PRs still need the agent to continue — dispatch with context
    expect(result.dispatched).toBe(1);
    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).toContain("#7");
    expect(dispatchedMessage).toContain("https://github.com/owner/my-repo/pull/7");
    expect(dispatchedMessage).toContain("Do NOT create a new branch");
    expect(dispatchedMessage).not.toContain("create a branch, commit, push, and open a PR");
    expect(dispatchedMessage).toContain("push to the existing PR branch");
  });

  it("injects structured review checklist when a draft PR exists (dispatch still fires)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP fix", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: true },
    ]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Checklist must be present with all five required steps
    expect(dispatchedMessage).toContain("Mandatory pre-declaration checklist");
    expect(dispatchedMessage).toContain("Read the full diff");
    expect(dispatchedMessage).toContain("Check for logic bugs");
    expect(dispatchedMessage).toContain("Verify test coverage");
    expect(dispatchedMessage).toContain("Closes #<issue>");
    expect(dispatchedMessage).toContain("Summarise your findings");
    // The checklist must reference the correct PR URL
    expect(dispatchedMessage).toContain("https://github.com/owner/my-repo/pull/7");
  });

  it("does NOT inject review checklist when no open PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockFindExistingPRs.mockReturnValue([]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).not.toContain("Mandatory pre-declaration checklist");
  });

  it("identifies draft PRs in the injected context message", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 8, title: "Draft fix", url: "https://github.com/owner/my-repo/pull/8", state: "open", isDraft: true },
    ]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // Draft PR context must mention it's a draft
    expect(dispatchedMessage).toContain("draft PR");
  });

  it("prefers merged PR check over open PR (merged takes priority)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    // Both a merged and an open PR exist (edge case)
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 5, title: "Merged PR", url: "url1", state: "merged", isDraft: false },
      { number: 6, title: "Open PR", url: "url2", state: "open", isDraft: false },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("calls findExistingPRsForIssue with correct repo and issue number", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 123, title: "Task", body: "Do work", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(mockFindExistingPRs).toHaveBeenCalledWith("owner/my-repo", 123);
  });

  it("proceeds with dispatch when findExistingPRsForIssue returns empty (fail-open)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
  });
});

describe("idle agent pickup (post-completion dispatch)", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: issues are open
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
  });

  it("skips agent while a task is in-flight (first call in cycle)", async () => {
    // Agent has an active task — first dispatchGitHubIssues call during dispatchTriggers skips it
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 2, title: "Next task", body: "Do it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("dispatches immediately after task completes (second call — idle pickup)", async () => {
    // Same cycle: agent just finished its task, now idle
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // New issue #2 is unprocessed (issue #1 already done)
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockImplementation(
      (_source: string, ref: string) => {
        if (ref === "owner/my-repo#1") {
          // Prior issue — recently completed, within recency window; duplicate suppressed
          return {
            id: "task-old",
            status: "done",
            verification_status: null,
            updated_at: new Date().toISOString(),
          };
        }
        return undefined; // issue #2 is fresh
      },
    );
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Done task", body: "", url: "https://...", labels: [] },
      { repo: "owner/my-repo", number: 2, title: "Next task", body: "Do it", url: "https://...", labels: [] },
    ]);

    // This simulates the pickupIdleAgents call that runs after verifyCompleted
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Next task"),
      expect.objectContaining({ sourceRepo: "owner/my-repo", source: "github", sourceRef: "owner/my-repo#2" }),
    );
  });

  it("is a no-op when agent is still busy (already has a new active task)", async () => {
    // Agent picked up work earlier in this cycle; second call should find it busy
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 3, title: "Another task", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("is a no-op when all open issues are already processed (no new work)", async () => {
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(false);
    // Both open issues have recent completed tasks — duplicate suppressed
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-recent",
      status: "done",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Done", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

describe("dispatchIdleAgentBacklog — force-reclaim path", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([]);
  });

  it("normally skips issues within the recency window (baseline)", async () => {
    // Issue #1 has a recent done task — duplicate-guard blocks it
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-recent",
      status: "done",
      verification_status: null,
      updated_at: new Date().toISOString(), // just now, well within 4h window
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Still open", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("force-reclaim bypasses recency window and dispatches oldest open issue", async () => {
    // Issue #1 has a recent done task — normally blocked by duplicate-guard
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-recent",
      status: "done",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Still open", body: "Needs retry", url: "https://...", labels: [] },
    ]);

    const forceReclaimAgents = new Set(["my-agent"]);
    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher, undefined, forceReclaimAgents);

    expect(result.dispatched).toBe(1);
    expect(result.dispatchedAgents).toContain("my-agent");
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Still open"),
      expect.objectContaining({ sourceRepo: "owner/my-repo", sourceRef: "owner/my-repo#1" }),
    );
  });

  it("force-reclaim still skips issues with active tasks (pending/dispatched/in_progress)", async () => {
    // Active task — even force-reclaim should not double-dispatch
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-active",
      status: "dispatched",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 5, title: "In progress", body: "", url: "https://...", labels: [] },
    ]);

    const forceReclaimAgents = new Set(["my-agent"]);
    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher, undefined, forceReclaimAgents);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("force-reclaim dispatches even when task was failed within recency window", async () => {
    // Failed task within recency window — normally duplicate-guard blocks; force-reclaim overrides
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-failed",
      status: "failed",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 7, title: "Failed issue", body: "Try again", url: "https://...", labels: [] },
    ]);

    const forceReclaimAgents = new Set(["my-agent"]);
    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher, undefined, forceReclaimAgents);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("force-reclaim only applies to agents in the set — others are unaffected", async () => {
    // Issue has recent done task — blocks for non-force agents
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-recent",
      status: "done",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Issue", body: "", url: "https://...", labels: [] },
    ]);

    // my-agent is NOT in forceReclaimAgents
    const forceReclaimAgents = new Set(["some-other-agent"]);
    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher, undefined, forceReclaimAgents);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("result includes dispatchedAgents list", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Task", body: "Work", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(result.dispatchedAgents).toEqual(["my-agent"]);
  });

  it("result dispatchedAgents is empty when nothing was dispatched", async () => {
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(true); // agent busy
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Task", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.dispatchedAgents).toEqual([]);
  });

  it("skips dispatch when a non-draft open PR exists in idle pickup (open-PR dispatch guard)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 9, title: "Open fix", url: "https://github.com/owner/my-repo/pull/9", state: "open", isDraft: false },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("injects structured review checklist into idle pickup message when only a draft PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 9, title: "Draft fix", url: "https://github.com/owner/my-repo/pull/9", state: "open", isDraft: true },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).toContain("Mandatory pre-declaration checklist");
    expect(dispatchedMessage).toContain("Read the full diff");
    expect(dispatchedMessage).toContain("Check for logic bugs");
    expect(dispatchedMessage).toContain("Verify test coverage");
    expect(dispatchedMessage).toContain("Closes #<issue>");
    expect(dispatchedMessage).toContain("Summarise your findings");
    expect(dispatchedMessage).toContain("https://github.com/owner/my-repo/pull/9");
  });
});

describe("buildExistingPRReviewChecklist", () => {
  it("returns a string containing all five required checklist steps", () => {
    const checklist = buildExistingPRReviewChecklist(7, "https://github.com/owner/repo/pull/7");
    expect(checklist).toContain("Mandatory pre-declaration checklist");
    expect(checklist).toContain("Read the full diff");
    expect(checklist).toContain("gh pr diff 7");
    expect(checklist).toContain("https://github.com/owner/repo/pull/7");
    expect(checklist).toContain("logic bugs");
    expect(checklist).toContain("off-by-one errors");
    expect(checklist).toContain("Math.min vs Math.max");
    expect(checklist).toContain("Verify test coverage");
    expect(checklist).toContain("Closes #<issue>");
    expect(checklist).toContain("Summarise your findings");
  });

  it("warns that a build alone is not sufficient", () => {
    const checklist = buildExistingPRReviewChecklist(7, "https://github.com/owner/repo/pull/7");
    expect(checklist).toContain("build alone is NOT sufficient");
    expect(checklist).toContain("line by line");
  });

  it("warns that skipping items fails verification", () => {
    const checklist = buildExistingPRReviewChecklist(7, "https://github.com/owner/repo/pull/7");
    expect(checklist).toContain("scored as incomplete");
    expect(checklist).toContain("will not pass verification");
  });

  it("includes the correct PR number in the gh pr diff command", () => {
    const checklist = buildExistingPRReviewChecklist(42, "https://github.com/owner/repo/pull/42");
    expect(checklist).toContain("gh pr diff 42");
    expect(checklist).not.toContain("gh pr diff 7");
  });

  it("includes the correct PR URL for viewing the diff online", () => {
    const checklist = buildExistingPRReviewChecklist(123, "https://github.com/example/proj/pull/123");
    expect(checklist).toContain("https://github.com/example/proj/pull/123/files");
  });
});

describe("dispatchLinearChecks", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "linear-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("dispatches check to agents with linear config", async () => {
    const result = await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Check Linear"),
      expect.objectContaining({ agentName: "linear-agent", source: "linear" }),
    );
  });

  it("includes team filters in the message", async () => {
    await dispatchLinearChecks(config, mockStore, mockDispatcher);
    const call = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("teams: ENG");
  });

  it("skips when already checked this hour", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips agents without linear config", async () => {
    await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchSlackChecks", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "slack-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("dispatches check to agents with slack config", async () => {
    const result = await dispatchSlackChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Check Slack"),
      expect.objectContaining({ agentName: "slack-agent", source: "slack" }),
    );
  });

  it("includes mention pattern and channels", async () => {
    await dispatchSlackChecks(config, mockStore, mockDispatcher);
    const call = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("@bot");
    expect(call[0]).toContain("#eng");
  });

  it("skips when already checked this hour", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await dispatchSlackChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatchIdleAgentBacklog — idle-agent backlog dispatch (#247)
// ────────────────────────────────────────────────────────────────────────────

describe("dispatchIdleAgentBacklog", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([]);
  });

  it("dispatches highest-priority issue first (by priority score, not issue number)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 10, title: "Low priority task", body: "", url: "https://...", labels: ["P3-low"] },
      { repo: "owner/my-repo", number: 2, title: "Normal task", body: "Fix it", url: "https://...", labels: [] },
      { repo: "owner/my-repo", number: 5, title: "Critical bug", body: "", url: "https://...", labels: ["P1-high"] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Critical bug"),
      expect.objectContaining({ sourceRepo: "owner/my-repo", source: "github", sourceRef: "owner/my-repo#5" }),
    );
  });

  it("skips busy agents (agents with active tasks)", async () => {
    (mockStore.hasActiveTask as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Pending task", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("skips already-processed issues (not re-dispatched)", async () => {
    (mockStore.findDispatchCandidateBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "task-done",
      status: "done",
      verification_status: null,
      updated_at: new Date().toISOString(),
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Already done", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("skips agents without a github config", async () => {
    // Only my-agent has github; linear-agent, slack-agent, no-triggers do not
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Task", body: "", url: "https://...", labels: [] },
    ]);

    await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    // fetchOpenIssues should only be called once (for my-agent)
    expect(mockFetchIssues).toHaveBeenCalledTimes(1);
    expect(mockFetchIssues).toHaveBeenCalledWith("owner/my-repo");
  });

  it("dispatches only one issue per idle agent per call", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "First", body: "", url: "https://...", labels: [] },
      { repo: "owner/my-repo", number: 2, title: "Second", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("First"),
      expect.anything(),
    );
  });

  it("skips agents filtered out by registeredAgents set", async () => {
    const registeredAgents = new Set<string>(["other-agent"]);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Task", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher, registeredAgents);

    expect(result.dispatched).toBe(0);
    expect(mockFetchIssues).not.toHaveBeenCalled();
  });

  it("collects errors and continues to next agent", async () => {
    mockFetchIssues.mockImplementation(() => { throw new Error("API unavailable"); });

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API unavailable");
    expect(result.dispatched).toBe(0);
  });

  it("skips issues with a merged PR (no double-dispatch)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Already fixed", body: "", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 5, title: "Fix", url: "url", state: "merged", isDraft: false },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockStore.markProcessed).toHaveBeenCalledWith(
      "github", "owner/my-repo#1", expect.stringContaining("merged-pr-5"),
    );
  });

  it("skips issues that have been closed before dispatch (race condition guard)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Closed issue", body: "", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "closed", hasOpenPR: false, hasMergedPR: false });

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockStore.markProcessed).toHaveBeenCalledWith(
      "github", "owner/my-repo#1", expect.stringContaining("closed-issue-1"),
    );
  });

  it("skips dispatch when a non-draft open PR already exists in idle backlog", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 3, title: "PR in progress", body: "Do work", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: false },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("injects open-draft-PR context into message when only a draft PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 3, title: "PR in progress", body: "Do work", url: "https://...", labels: [] },
    ]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: true },
    ]);

    await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).toContain("#7");
    expect(dispatchedMessage).toContain("Do NOT create a new branch");
    expect(dispatchedMessage).not.toContain("create a branch, commit, push, and open a PR");
  });

  it("returns zero dispatched when no open issues exist", async () => {
    mockFetchIssues.mockReturnValue([]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("aborts with an error when gh auth pre-flight fails", async () => {
    mockValidateGhAuth.mockReturnValue({
      ok: false,
      reason: "gh CLI is not authenticated: You are not logged into any GitHub hosts. Set the GH_TOKEN environment variable or run `gh auth login` to authenticate.",
    });
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("gh auth pre-flight failed");
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("skips auth-degraded agents without fetching issues (issue #430)", async () => {
    mockValidateGhAuth.mockReturnValue({ ok: true });
    vi.mocked(mockStore.isAgentAuthDegraded).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(mockFetchIssues).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// dispatchGitHubIssues — onAgentCompleted post-dispatch hook (issue #305)
// ────────────────────────────────────────────────────────────────────────────

describe("dispatchGitHubIssues onAgentCompleted hook", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateGhAuth.mockReturnValue({ ok: true });
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("calls onAgentCompleted with the agent name after dispatch completes", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const completedAgents: string[] = [];
    const onCompleted = vi.fn(async (name: string) => { completedAgents.push(name); });

    await dispatchGitHubIssues(config, mockStore, mockDispatcher, 1, undefined, onCompleted);

    // Dispatch was fire-and-forget — wait for the Promise to resolve
    await vi.runAllTimersAsync().catch(() => {});
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
    // onCompleted should have been called once the dispatch resolved
    expect(onCompleted).toHaveBeenCalledWith("my-agent");
    expect(completedAgents).toContain("my-agent");
  });

  it("does not call onAgentCompleted when no issues are dispatched", async () => {
    mockFetchIssues.mockReturnValue([]);

    const onCompleted = vi.fn(async () => {});

    await dispatchGitHubIssues(config, mockStore, mockDispatcher, 1, undefined, onCompleted);
    await new Promise((r) => setTimeout(r, 0));

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("works correctly without onAgentCompleted (backward compatible)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
    ]);

    // Should not throw when callback is omitted
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
  });

  it("swallows errors thrown by onAgentCompleted so they do not break dispatch", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
    ]);

    const failingHook = vi.fn(async () => { throw new Error("orphan check failed"); });

    // Should not throw even if the hook fails
    await expect(
      dispatchGitHubIssues(config, mockStore, mockDispatcher, 1, undefined, failingHook),
    ).resolves.not.toThrow();

    await new Promise((r) => setTimeout(r, 0));
    // Hook was still called
    expect(failingHook).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// In-flight branch detection (issue #352)
// ---------------------------------------------------------------------------

describe("in-flight branch detection", () => {
  const branchConfig: OrchestratorConfig = {
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    agents: {
      "my-agent": {
        dir: "my-agent",
        description: "Test agent",
        capabilities: [],
        owns_topics: [],
        github: "owner/my-repo",
      },
    },
  };

  const baseIssue = {
    repo: "owner/my-repo",
    number: 42,
    title: "Fix something",
    body: "Details here",
    url: "https://github.com/owner/my-repo/issues/42",
    labels: [],
  };

  beforeEach(() => {
    mockFetchIssues.mockReturnValue([baseIssue]);
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([]);
    mockFindBranchForIssue.mockReturnValue(null);
  });

  it("injects existing branch context into dispatch message when branch found", async () => {
    mockFindBranchForIssue.mockReturnValue("issue-42-fix-something");

    const dispatched: string[] = [];
    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (msg: string) => {
        dispatched.push(msg);
        return { taskId: "t1", agentName: "my-agent" };
      }),
    } as unknown as Dispatcher;

    const mockStore = {
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      addLog: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(null),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;

    vi.mocked(mockStore.hasActiveTask).mockReturnValue(false);

    await dispatchGitHubIssues(branchConfig, mockStore, mockDispatcher);

    // Wait for fire-and-forget
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("issue-42-fix-something");
    expect(dispatched[0]).toContain("Do NOT create a new branch");
  });

  it("does not inject branch context when no matching branch found", async () => {
    mockFindBranchForIssue.mockReturnValue(null);

    const dispatched: string[] = [];
    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (msg: string) => {
        dispatched.push(msg);
        return { taskId: "t1", agentName: "my-agent" };
      }),
    } as unknown as Dispatcher;

    const mockStore = {
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      addLog: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(null),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;

    await dispatchGitHubIssues(branchConfig, mockStore, mockDispatcher);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("gh pr create");
    expect(dispatched[0]).not.toContain("Do NOT create a new branch");
  });

  it("skips dispatch entirely when a non-draft open PR exists (open PR takes precedence over branch)", async () => {
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([
      { number: 10, title: "PR", url: "https://github.com/owner/my-repo/pull/10", state: "open", isDraft: false },
    ]);
    // Even if a branch exists, the non-draft open PR should cause a skip
    mockFindBranchForIssue.mockReturnValue("issue-42-fix-something");

    const dispatched: string[] = [];
    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (msg: string) => {
        dispatched.push(msg);
        return { taskId: "t1", agentName: "my-agent" };
      }),
    } as unknown as Dispatcher;

    const mockStore = {
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      addLog: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(null),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;

    const result = await dispatchGitHubIssues(branchConfig, mockStore, mockDispatcher);

    // Must skip (not dispatch) when a non-draft open PR exists
    expect(dispatched).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("idle pickup: injects branch context when in-flight branch found", async () => {
    mockFindBranchForIssue.mockReturnValue("issue-42-in-flight");

    const dispatched: string[] = [];
    const mockDispatcher = {
      dispatch: vi.fn().mockImplementation(async (msg: string) => {
        dispatched.push(msg);
        return { taskId: "t1", agentName: "my-agent" };
      }),
    } as unknown as Dispatcher;

    const mockStore = {
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      addLog: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(null),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;

    await dispatchIdleAgentBacklog(branchConfig, mockStore, mockDispatcher);
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain("issue-42-in-flight");
    expect(dispatched[0]).toContain("Do NOT create a new branch");
  });
});

// ---------------------------------------------------------------------------
// Approved PR skip logic (issue #381)
// ---------------------------------------------------------------------------

describe("approved PR skip logic", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
      getTask: vi.fn().mockReturnValue(null),
      listTasks: vi.fn().mockReturnValue([]),
      hasActiveTask: vi.fn().mockReturnValue(false),
      isAgentAuthDegraded: vi.fn().mockReturnValue(false),
      isSourceRefPriorityBoosted: vi.fn().mockReturnValue(false),
      clearSourceRefPriority: vi.fn(),
      findDispatchCandidateBySourceRef: vi.fn().mockReturnValue(undefined),
      countFailuresForSourceRef: vi.fn().mockReturnValue(0),
      addDispatchValidation: vi.fn(),
      // Issue claim lock methods (added in #539)
      cleanExpiredClaims: vi.fn().mockReturnValue(0),
      tryClaimIssue: vi.fn().mockReturnValue(true),
      getActiveClaim: vi.fn().mockReturnValue(undefined),
      releaseIssueClaim: vi.fn(),
      updateClaimTaskId: vi.fn(),
      cancelSupersededTasks: vi.fn().mockReturnValue(0),
      findAllTasksBySourceRef: vi.fn().mockReturnValue([]),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: false, hasMergedPR: false });
    mockCachedGetIssueState.mockReturnValue({ state: "open", hasOpenPR: true, hasMergedPR: false });
    mockFindExistingPRs.mockReturnValue([]);
    // Default: no approved PR
    mockFindApprovedPR.mockReturnValue(null);
  });

  // --- dispatchGitHubIssues ---

  it("dispatchGitHubIssues: skips dispatch when approved+clean PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Skip me", body: "body", url: "https://...", labels: [] },
    ]);
    mockFindApprovedPR.mockReturnValue({ number: 10, headRefName: "issue-381-fix" });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("dispatchGitHubIssues: dispatches normally when no approved PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Do me", body: "body", url: "https://...", labels: [] },
    ]);
    mockFindApprovedPR.mockReturnValue(null);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("dispatchGitHubIssues: dispatches when PR has CHANGES_REQUESTED (not approved)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Needs work", body: "body", url: "https://...", labels: [] },
    ]);
    // findApprovedPRForIssue returns null because CHANGES_REQUESTED is filtered out inside the function
    mockFindApprovedPR.mockReturnValue(null);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("dispatchGitHubIssues: dispatches when PR is approved but CONFLICTING", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Conflicting", body: "body", url: "https://...", labels: [] },
    ]);
    // findApprovedPRForIssue returns null because CONFLICTING is filtered out inside the function
    mockFindApprovedPR.mockReturnValue(null);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("dispatchGitHubIssues: does NOT mark processed when skipping approved PR (PR not yet merged)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Skip me", body: "body", url: "https://...", labels: [] },
    ]);
    mockFindApprovedPR.mockReturnValue({ number: 10, headRefName: "issue-381-fix" });

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // markProcessed must NOT be called for approved-PR skip — the issue should
    // remain pollable so it is re-evaluated after the PR merges and closes the issue.
    expect(mockStore.markProcessed).not.toHaveBeenCalled();
  });

  it("dispatchGitHubIssues: calls findApprovedPRForIssue with correct repo and issue number", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Task", body: "body", url: "https://...", labels: [] },
    ]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(mockFindApprovedPR).toHaveBeenCalledWith("owner/my-repo", 42);
  });

  // --- dispatchIdleAgentBacklog ---

  it("dispatchIdleAgentBacklog: skips dispatch when approved+clean PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Skip me", body: "body", url: "https://...", labels: [] },
    ]);
    mockFindApprovedPR.mockReturnValue({ number: 10, headRefName: "issue-381-fix" });

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("dispatchIdleAgentBacklog: dispatches when no approved PR exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 381, title: "Do me", body: "body", url: "https://...", labels: [] },
    ]);
    mockFindApprovedPR.mockReturnValue(null);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });
});
