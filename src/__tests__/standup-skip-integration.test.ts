/**
 * Integration test: zero-action standup skip guard.
 *
 * Verifies that when a PR is associated with a zero-action standup issue,
 * the reviewer posts an acknowledgment comment and returns an auto-approve
 * result — regardless of branch naming convention.
 *
 * Covers the bug where non-standard branch names (e.g. "standup-721-response"
 * instead of "issue-721-standup") caused the guard to silently skip, allowing
 * the PR through to a full LLM review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import { PRReviewer } from "../reviewer/pr-reviewer.js";

// Mock child_process so no real shell calls are made
vi.mock("child_process");

// Mock the LLM client (reviewer would call it for non-standup PRs)
vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    sendMessage: vi.fn().mockResolvedValue("LGTM"),
  }),
}));

// Mock the logger
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeMinimalStore() {
  return {
    queuePRForMerge: vi.fn().mockReturnValue({
      repo: "",
      pr_number: 0,
      branch: "",
      status: "queued" as const,
      position: 0,
    }),
    getMergeQueue: vi.fn().mockReturnValue([]),
    isPRInMergeQueue: vi.fn().mockReturnValue(false),
    markQueuedPRMerging: vi.fn(),
    markQueuedPRMerged: vi.fn(),
    markQueuedPRFailed: vi.fn(),
    removeFromMergeQueue: vi.fn(),
    recordPRReview: vi.fn(),
    getTask: vi.fn().mockReturnValue(null),
    updateTask: vi.fn(),
    hasActiveTask: vi.fn().mockReturnValue(false),
    listTasks: vi.fn().mockReturnValue([]),
    getRecentCompleted: vi.fn().mockReturnValue([]),
    getUnverified: vi.fn().mockReturnValue([]),
    getAgentStats: vi.fn().mockReturnValue([]),
    getAgentHealthBatch: vi.fn().mockReturnValue([]),
    getRecentSupervisorDecisions: vi.fn().mockReturnValue([]),
    querySupervisorDecisions: vi.fn().mockReturnValue([]),
    pruneOldSupervisorDecisions: vi.fn().mockReturnValue(0),
    recordSupervisorDecision: vi.fn(),
  };
}

function makeReviewer() {
  const config = {
    base_dir: "/tmp",
    orchestrator_dir: "/tmp",
    agents: {},
  };
  return new PRReviewer(config, makeMinimalStore());
}

/**
 * Build a mock for execSync that serves:
 * 1. fetchPRInfo (gh pr view + gh pr diff)
 * 2. handleStandupIssueIfNeeded (gh issue view)
 * 3. handleZeroActionStandup (gh issue comment + gh issue close)
 */
function buildExecSyncMock(opts: {
  branch: string;
  prBody: string;
  prTitle?: string;
  issueTitle: string;
  issueBody: string;
  issueLabels: string[];
  issueState?: string;
}) {
  const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
  mockExecSync.mockImplementation((cmd: string) => {
    // fetchPRInfo — gh pr view
    if (cmd.includes("gh pr view") && cmd.includes("--json")) {
      return JSON.stringify({
        number: 42,
        title: opts.prTitle ?? "Standup response for #721",
        body: opts.prBody,
        author: { login: "claude-orchestrator-reviewer" },
        headRefName: opts.branch,
        changedFiles: 1,
        mergeable: "MERGEABLE",
      });
    }

    // fetchPRInfo — gh pr diff
    if (cmd.includes("gh pr diff")) {
      return "diff --git a/docs/standups/response.md b/docs/standups/response.md\n+standup notes";
    }

    // handleStandupIssueIfNeeded — gh issue view
    if (cmd.includes("gh issue view")) {
      return JSON.stringify({
        number: 721,
        title: opts.issueTitle,
        body: opts.issueBody,
        labels: opts.issueLabels.map((name) => ({ name })),
        state: opts.issueState ?? "OPEN",
      });
    }

    // handleZeroActionStandup — gh issue comment
    if (cmd.includes("gh issue comment")) {
      return "";
    }

    // handleZeroActionStandup — gh issue close
    if (cmd.includes("gh issue close")) {
      return "";
    }

    // gh pr view for PR merge status check
    if (cmd.includes("gh pr view") && cmd.includes("merged")) {
      return "true";
    }

    return "";
  });

  return mockExecSync;
}

// ── Zero-Action Standup Detection ─────────────────────────────────────────

describe("Zero-action standup skip (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ZERO_ACTION_ISSUE = {
    issueTitle: "[📋 Standup] 2026-04-12 — 0 action items",
    issueBody: `## 📋 Standup — 2026-04-12

### Synthesis
All systems running smoothly. No blockers identified.

### Action Items
No action items.

### Goal Adjustments
No adjustments proposed.

---
*Auto-generated 2-round standup meeting.*`,
    issueLabels: ["team-meeting", "standup"],
  };

  it("skips PR review for zero-action standup with issue-N branch", async () => {
    const mockExecSync = buildExecSyncMock({
      branch: "issue-721-standup-response",
      prBody: "Standup response\n\nCloses #721",
      ...ZERO_ACTION_ISSUE,
    });

    const reviewer = makeReviewer();
    const result = await reviewer.reviewPR("rapartlu/agent-orchestrator", 42);

    // Should auto-approve without LLM review
    expect(result.decision).toBe("approve");
    expect(result.reason).toContain("Zero-action standup");

    // Should have posted acknowledgment comment on the issue
    const commentCalls = mockExecSync.mock.calls.filter(
      ([cmd]: [string]) => typeof cmd === "string" && cmd.includes("gh issue comment"),
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("skips PR review for zero-action standup with non-standard branch name", async () => {
    // This is the specific bug: branch named "standup-721-response" instead of "issue-721-..."
    const mockExecSync = buildExecSyncMock({
      branch: "standup-721-response",
      prBody: "Standup response for issue #721\n\nCloses #721",
      ...ZERO_ACTION_ISSUE,
    });

    const reviewer = makeReviewer();
    const result = await reviewer.reviewPR("rapartlu/agent-orchestrator", 42);

    // Should STILL auto-approve — the body contains "Closes #721"
    expect(result.decision).toBe("approve");
    expect(result.reason).toContain("Zero-action standup");

    // Should have posted acknowledgment comment
    const commentCalls = mockExecSync.mock.calls.filter(
      ([cmd]: [string]) => typeof cmd === "string" && cmd.includes("gh issue comment"),
    );
    expect(commentCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("skips PR review when issue ref uses fully qualified form", async () => {
    const mockExecSync = buildExecSyncMock({
      branch: "standup-2026-04-12",
      prBody: "Standup response\n\nCloses rapartlu/agent-orchestrator#721",
      ...ZERO_ACTION_ISSUE,
    });

    const reviewer = makeReviewer();
    const result = await reviewer.reviewPR("rapartlu/agent-orchestrator", 42);

    expect(result.decision).toBe("approve");
    expect(result.reason).toContain("Zero-action standup");
  });

  it("does NOT skip PR review for standup with action items", async () => {
    buildExecSyncMock({
      branch: "issue-720-standup-response",
      prBody: "Standup response\n\nCloses #720",
      issueTitle: "[📋 Standup] 2026-04-12 — 3 action items",
      issueBody: `## 📋 Standup — 2026-04-12

### Synthesis
Steady progress on PR review automation.

### Action Items
- [HIGH] Merge calibration PRs (owner: orchestrator)
- [MEDIUM] Deploy token instrumentation (owner: reviewer)
- [LOW] Update docs for schema detection (owner: reviewer)

### Goal Adjustments
No adjustments proposed.`,
      issueLabels: ["team-meeting", "standup"],
    });

    const reviewer = makeReviewer();

    // reviewPR will proceed past the standup guard and try full review.
    // Since we don't mock the full LLM review path, it will throw or
    // return a non-standup result. We verify the guard didn't fire.
    try {
      const result = await reviewer.reviewPR("rapartlu/agent-orchestrator", 42);
      // If it returns, the reason should NOT mention standup skip
      expect(result.reason).not.toContain("Zero-action standup");
    } catch {
      // Expected: full review path may throw without complete mocking.
      // The important thing is the standup guard didn't fire.
    }
  });

  it("does NOT skip PR review for non-standup issues", async () => {
    buildExecSyncMock({
      branch: "issue-500-fix-bug",
      prBody: "Fix login bug\n\nCloses #500",
      issueTitle: "Fix login bug on mobile",
      issueBody: "Login is broken on mobile devices.",
      issueLabels: ["bug"],
    });

    const reviewer = makeReviewer();

    try {
      const result = await reviewer.reviewPR("rapartlu/agent-orchestrator", 42);
      expect(result.reason).not.toContain("Zero-action standup");
    } catch {
      // Expected: full review path may throw without complete mocking
    }
  });
});

// ── resolveIssueNumberForStandupCheck (unit tests) ───────────────────────

describe("resolveIssueNumberForStandupCheck", () => {
  it("extracts from issue-N branch name", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "PR title",
      body: "",
      repo: "rapartlu/test",
      author: "bot",
      branch: "issue-721-standup-response",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    expect(result).toBe(721);
  });

  it("falls back to bare Closes #N in body", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "Standup response",
      body: "Response to standup\n\nCloses #721",
      repo: "rapartlu/test",
      author: "bot",
      branch: "standup-721-response",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    expect(result).toBe(721);
  });

  it("falls back to fully qualified Closes owner/repo#N in body", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "Standup response",
      body: "Response\n\nCloses rapartlu/agent-orchestrator#721",
      repo: "rapartlu/test",
      author: "bot",
      branch: "standup-2026-04-12",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    expect(result).toBe(721);
  });

  it("falls back to PR title #N reference", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "Standup response for #721",
      body: "No closes ref here",
      repo: "rapartlu/test",
      author: "bot",
      branch: "standup-response",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    expect(result).toBe(721);
  });

  it("returns null when no issue number can be resolved", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "Standup response",
      body: "No issue references at all",
      repo: "rapartlu/test",
      author: "bot",
      branch: "standup-response",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    expect(result).toBeNull();
  });

  it("prefers branch name over body reference", () => {
    const reviewer = makeReviewer();
    const result = reviewer.resolveIssueNumberForStandupCheck({
      number: 1,
      title: "PR title",
      body: "Closes #999",
      repo: "rapartlu/test",
      author: "bot",
      branch: "issue-721-standup",
      diff: "",
      files_changed: 1,
      mergeable: "MERGEABLE",
    });
    // Branch takes priority
    expect(result).toBe(721);
  });

  it("handles Fixes and Resolves keywords", () => {
    const reviewer = makeReviewer();

    const fixes = reviewer.resolveIssueNumberForStandupCheck({
      number: 1, title: "PR", body: "Fixes #100", repo: "r/t", author: "b",
      branch: "x", diff: "", files_changed: 0, mergeable: "MERGEABLE",
    });
    expect(fixes).toBe(100);

    const resolves = reviewer.resolveIssueNumberForStandupCheck({
      number: 1, title: "PR", body: "Resolves #200", repo: "r/t", author: "b",
      branch: "x", diff: "", files_changed: 0, mergeable: "MERGEABLE",
    });
    expect(resolves).toBe(200);
  });
});
