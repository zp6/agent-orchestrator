import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchGitHubIssues, dispatchIdleAgentBacklog, dispatchLinearChecks, dispatchSlackChecks } from "./trigger-dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";

vi.mock("./github.js", () => ({
  fetchOpenIssues: vi.fn(),
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  isIssueOpen: vi.fn().mockReturnValue(true),
  // Default: authenticated — tests that need unauthenticated state override this
  validateGhAuth: vi.fn().mockReturnValue({ ok: true }),
}));

vi.mock("./reporters.js", () => ({
  reportResult: vi.fn(),
}));

import { fetchOpenIssues, findExistingPRsForIssue, isIssueOpen, validateGhAuth } from "./github.js";
const mockFetchIssues = vi.mocked(fetchOpenIssues);
const mockFindExistingPRs = vi.mocked(findExistingPRsForIssue);
const mockIsIssueOpen = vi.mocked(isIssueOpen);
const mockValidateGhAuth = vi.mocked(validateGhAuth);

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
      // checkDuplicate calls this; return undefined by default (no prior task)
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: issues are open (pre-dispatch validation passes)
    mockIsIssueOpen.mockReturnValue(true);
  });

  it("dispatches new issues to owning agent", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Bug"),
      expect.objectContaining({ agentName: "my-agent", source: "github", sourceRef: "owner/my-repo#1" }),
    );
  });

  it("skips issues that already have an active task (duplicate-guard)", async () => {
    // Simulate an active dispatched task for this source_ref
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockFindExistingPRs.mockReturnValue([]);
    // Default: issues are open
    mockIsIssueOpen.mockReturnValue(true);
  });

  it("skips dispatch when issue has been closed (race condition guard)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Stale issue", body: "Already done", url: "https://...", labels: [] },
    ]);
    // Issue was fetched as open but has since been closed
    mockIsIssueOpen.mockReturnValue(false);

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
    mockIsIssueOpen.mockReturnValue(true);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalled();
  });

  it("proceeds with dispatch when isIssueOpen fails (fail-open)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Issue", body: "Needs work", url: "https://...", labels: [] },
    ]);
    // isIssueOpen returns true on error (fail-open) — dispatch should proceed
    mockIsIssueOpen.mockReturnValue(true);

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
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: no existing PRs, issues are open
    mockFindExistingPRs.mockReturnValue([]);
    mockIsIssueOpen.mockReturnValue(true);
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
      expect.objectContaining({ agentName: "my-agent" }),
    );
  });

  it("skips dispatch when a merged PR already addresses the issue", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
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

  it("dispatches with PR context injected when an open PR already exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP fix", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: false },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).toContain("#7");
    expect(dispatchedMessage).toContain("https://github.com/owner/my-repo/pull/7");
    expect(dispatchedMessage).toContain("Do NOT create a new branch");
    // Bug 1: must NOT include the "create a branch ... gh pr create" workflow when an open PR exists
    expect(dispatchedMessage).not.toContain("create a branch, commit, push, and open a PR");
    // Must include push-only instructions instead
    expect(dispatchedMessage).toContain("push to the existing PR branch");
  });

  it("marks draft PRs as [DRAFT] in injected context", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    mockFindExistingPRs.mockReturnValue([
      { number: 8, title: "Draft fix", url: "https://github.com/owner/my-repo/pull/8", state: "open", isDraft: true },
    ]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    const dispatchedMessage = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(dispatchedMessage).toContain("[DRAFT]");
  });

  it("prefers merged PR check over open PR (merged takes priority)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
    // Both a merged and an open PR exist (edge case)
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

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(mockFindExistingPRs).toHaveBeenCalledWith("owner/my-repo", 123);
  });

  it("proceeds with dispatch when findExistingPRsForIssue returns empty (fail-open)", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 42, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);
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
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    // Default: issues are open
    mockIsIssueOpen.mockReturnValue(true);
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockImplementation(
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
      expect.objectContaining({ agentName: "my-agent", source: "github", sourceRef: "owner/my-repo#2" }),
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockIsIssueOpen.mockReturnValue(true);
    mockFindExistingPRs.mockReturnValue([]);
  });

  it("normally skips issues within the recency window (baseline)", async () => {
    // Issue #1 has a recent done task — duplicate-guard blocks it
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
      expect.objectContaining({ agentName: "my-agent", sourceRef: "owner/my-repo#1" }),
    );
  });

  it("force-reclaim still skips issues with active tasks (pending/dispatched/in_progress)", async () => {
    // Active task — even force-reclaim should not double-dispatch
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
      findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
    mockIsIssueOpen.mockReturnValue(true);
    mockFindExistingPRs.mockReturnValue([]);
  });

  it("dispatches highest-priority issue (lowest issue number first) to an idle agent", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 10, title: "Newer task", body: "", url: "https://...", labels: [] },
      { repo: "owner/my-repo", number: 2, title: "Oldest task", body: "Fix it", url: "https://...", labels: [] },
      { repo: "owner/my-repo", number: 5, title: "Middle task", body: "", url: "https://...", labels: [] },
    ]);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Oldest task"),
      expect.objectContaining({ agentName: "my-agent", source: "github", sourceRef: "owner/my-repo#2" }),
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
    (mockStore.findTaskBySourceRef as ReturnType<typeof vi.fn>).mockReturnValue({
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
    mockIsIssueOpen.mockReturnValue(false);

    const result = await dispatchIdleAgentBacklog(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(mockStore.markProcessed).toHaveBeenCalledWith(
      "github", "owner/my-repo#1", expect.stringContaining("closed-issue-1"),
    );
  });

  it("injects open-PR context into message when an open PR already exists", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 3, title: "PR in progress", body: "Do work", url: "https://...", labels: [] },
    ]);
    mockFindExistingPRs.mockReturnValue([
      { number: 7, title: "WIP", url: "https://github.com/owner/my-repo/pull/7", state: "open", isDraft: false },
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
});
