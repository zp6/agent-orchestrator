import { describe, it, expect, vi, beforeEach } from "vitest";
import { PRReviewer } from "./pr-reviewer.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

let mockPRViewResponse = JSON.stringify({
  number: 9,
  title: "Test PR",
  body: "Description",
  author: { login: "agent" },
  headRefName: "feature-branch",
  changedFiles: 2,
  mergeable: "MERGEABLE",
});

let mockDiffResponse = "+added line\n-removed line";
let mockPRStateResponse = "OPEN";

// Controls what gh issue list returns in the body-linter fuzzy-match path.
// Default is an empty list so the linter can't infer an issue from fuzzy matching.
let mockIssueListResponse = "[]";

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.includes("gh pr view") && cmd.includes("-q .state")) {
      return mockPRStateResponse;
    }
    if (cmd.includes("gh pr view")) {
      return mockPRViewResponse;
    }
    if (cmd.includes("gh pr diff")) {
      return mockDiffResponse;
    }
    if (cmd.includes("gh issue list")) {
      return mockIssueListResponse;
    }
    if (cmd.includes("gh pr list")) {
      return JSON.stringify([
        { number: 9, title: "Test PR", body: "Description\n\nCloses #9" },
        { number: 10, title: "Another PR", body: "Another description" },
      ]);
    }
    if (cmd.includes("gh pr review") || cmd.includes("gh pr edit") || cmd.includes("gh pr comment") || cmd.includes("gh pr merge")) {
      return "";
    }
    return "";
  }),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": { dir: "a", description: "A", capabilities: ["test"], owns_topics: ["a"], github: "owner/repo" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset to default non-agent PR
  mockPRViewResponse = JSON.stringify({
    number: 9,
    title: "Test PR",
    body: "Description",
    author: { login: "agent" },
    headRefName: "feature-branch",
    changedFiles: 2,
    mergeable: "MERGEABLE",
  });
  mockDiffResponse = "+added line\n-removed line";
  mockIssueListResponse = "[]";
  mockPRStateResponse = "OPEN";
});

describe("PRReviewer", () => {
  it("approves a good PR", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        decision: "approve",
        comment: "Clean implementation, looks good.",
        reason: "Code is correct and well-structured",
      })}],
    });

    const reviewer = new PRReviewer(config);
    const result = await reviewer.reviewPR("owner/repo", 9);

    expect(result.decision).toBe("approve");
    expect(result.comment).toContain("looks good");
  });

  it("requests changes on a bad PR", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        decision: "request-changes",
        comment: "Missing error handling in the main function.",
        reason: "Incomplete implementation",
      })}],
    });

    const reviewer = new PRReviewer(config);
    const result = await reviewer.reviewPR("owner/repo", 9);

    expect(result.decision).toBe("request-changes");
  });

  it("escalates uncertain PRs to human", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({
        decision: "escalate",
        comment: "This changes auth logic — needs human review.",
        reason: "Security-sensitive change",
      })}],
    });

    const reviewer = new PRReviewer(config);
    const result = await reviewer.reviewPR("owner/repo", 9);

    expect(result.decision).toBe("escalate");
  });

  it("escalates on malformed LLM response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I think this looks fine" }],
    });

    const reviewer = new PRReviewer(config);
    const result = await reviewer.reviewPR("owner/repo", 9);

    expect(result.decision).toBe("escalate");
    expect(result.reason).toContain("Parse failure");
  });

  describe("JSON parse fallback strategies", () => {
    it("parses JSON wrapped in explanation text (strategy 2: regex extract)", async () => {
      // Claude sometimes adds explanation before or after the JSON object
      const wrappedResponse = `Based on my review of the changes, here is my assessment:\n\n{"decision":"approve","comment":"Looks good to me.","reason":"Clean and correct implementation"}\n\nThe PR implements the feature correctly.`;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: wrappedResponse }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("approve");
      expect(result.comment).toBe("Looks good to me.");
    });

    it("parses JSON wrapped in markdown code fences (strategy 3: code fence extract)", async () => {
      // Claude sometimes wraps JSON in ```json ... ``` blocks despite being told not to
      const fencedResponse = "Here is my review:\n\n```json\n{\"decision\":\"request-changes\",\"comment\":\"Missing error handling.\",\"reason\":\"Incomplete implementation\"}\n```";
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: fencedResponse }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("request-changes");
      expect(result.comment).toBe("Missing error handling.");
    });

    it("parses JSON with trailing commentary after closing brace (strategy 2: regex extract)", async () => {
      // Claude sometimes adds a note after the JSON object
      const responseWithTrailing = `{"decision":"escalate","comment":"Needs human eyes on the auth changes.","reason":"Security-sensitive change"}\n\nNote: please pay special attention to the token validation logic.`;
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: responseWithTrailing }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.comment).toBe("Needs human eyes on the auth changes.");
    });

    it("parses JSON inside plain code fences without language tag (strategy 3)", async () => {
      const plainFencedResponse = "Review:\n\n```\n{\"decision\":\"approve\",\"comment\":\"All good.\",\"reason\":\"Works correctly\"}\n```";
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: plainFencedResponse }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("approve");
      expect(result.comment).toBe("All good.");
    });

    it("defaults to escalate when no strategy can extract valid JSON", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "This PR looks fine to me, I approve it." }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.reason).toBe("Parse failure");
    });

    it("defaults decision to escalate when parsed JSON has an unrecognised decision value", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "maybe", comment: "Not sure.", reason: "Ambiguous" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Unknown decision value → safe fallback to escalate
      expect(result.decision).toBe("escalate");
      expect(result.comment).toBe("Not sure.");
    });
  });

  it("reviews all open PRs on a repo", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

    const reviewer = new PRReviewer(config);
    const results = await reviewer.reviewOpenPRs("owner/repo");

    expect(results).toHaveLength(2);
  });

  it("reviewOpenPRs includes prBody in each result entry", async () => {
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

    const reviewer = new PRReviewer(config);
    const results = await reviewer.reviewOpenPRs("owner/repo");

    expect(results[0].prBody).toBe("Description\n\nCloses #9");
    expect(results[1].prBody).toBe("Another description");
  });

  it("reviewOpenPRs returns empty prBody string when gh pr list returns no body field", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockImplementationOnce((cmd: string) => {
      if (cmd.includes("gh pr list")) {
        return JSON.stringify([{ number: 9, title: "No body PR" }]);
      }
      return "";
    });
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
    });

    const reviewer = new PRReviewer(config);
    const results = await reviewer.reviewOpenPRs("owner/repo");

    expect(results[0].prBody).toBe("");
  });

  describe("merge conflict detection", () => {
    it("auto-rebases conflicting PRs and proceeds to review when local repo is found", async () => {
      // agent-a owns "owner/repo" → local path /projects/a exists in config
      // Git commands succeed (mock returns "" for all git calls)
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "approve",
          comment: "Looks good after rebase.",
          reason: "Clean implementation",
        })}],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Auto-rebase succeeded (git mock returns ""), so LLM review runs
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("escalates conflicting PRs when auto-rebase fails", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      // Make git rebase fail on the next call that includes "rebase origin/main"
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rebase origin/main")) {
          throw new Error("CONFLICT (content): Merge conflict in src/index.ts");
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR" }]);
        if (cmd.includes("gh pr review") || cmd.includes("gh pr edit") || cmd.includes("gh pr comment") || cmd.includes("gh pr merge")) return "";
        return ""; // covers git fetch, checkout, push, rebase --abort, etc.
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.reason).toContain("auto-rebase failed");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("escalates conflicting PRs when no local repo is found for the given repo", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 42,
        title: "External PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const reviewer = new PRReviewer(config);
      // "unknown/repo" is not in config.agents and not the orchestrator repo
      const result = await reviewer.reviewPR("unknown/repo", 42);

      expect(result.decision).toBe("escalate");
      expect(result.reason).toContain("no local repo");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("proactively rebases MERGEABLE branch that is behind main, then continues to LLM review", async () => {
      // PR is MERGEABLE (not CONFLICTING) but the branch is behind main.
      // Auto-rebase should run, succeed, and review should proceed normally.
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Implements feature.\n\nCloses #5",
        author: { login: "agent" },
        headRefName: "issue-5-add-feature",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "approve",
          comment: "Clean implementation.",
          reason: "Correct and well-structured",
        })}],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);
      // Mock git rebase to return a rebase-happened output (not "up to date")
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd.includes("git rebase origin/main")) return "Successfully rebased and updated refs/heads/issue-5-add-feature.\n";
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh api") && cmd.includes("comments")) return "0\n";
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "[agent-a] Add feature", body: "Closes #5" }]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Proactive rebase succeeded → LLM review ran → approved
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();

      // Verify git rebase was called (proactive path)
      const rebaseCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("git rebase origin/main"),
      );
      expect(rebaseCall).toBeDefined();
    });

    it("skips proactive rebase when no local repo path is found, and still reviews normally", async () => {
      // PR on a repo not in config — no local path → skip proactive rebase, go straight to review
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "External PR",
        body: "Some changes.\n\nCloses #1",
        author: { login: "human" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "approve",
          comment: "Looks fine.",
          reason: "Clean",
        })}],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh api") && cmd.includes("comments")) return "0\n";
        if (cmd.includes("gh pr list")) return JSON.stringify([]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      // "unknown/external" has no local path in config
      const result = await reviewer.reviewPR("unknown/external", 9);

      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();

      // git rebase should NOT have been called (no local path)
      const rebaseCall = vi.mocked(mockExecSync).mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("git rebase"),
      );
      expect(rebaseCall).toBeUndefined();
    });

    it("continues to review even when proactive rebase fails on a MERGEABLE PR", async () => {
      // PR is MERGEABLE but proactive rebase fails (e.g., network error on git fetch).
      // Review should still proceed — proactive rebase is best-effort only.
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Fixes bug.\n\nCloses #7",
        author: { login: "agent" },
        headRefName: "issue-7-fix-bug",
        changedFiles: 1,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "approve",
          comment: "Bug is fixed.",
          reason: "Correct fix",
        })}],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("git fetch origin")) throw new Error("network error");
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh api") && cmd.includes("comments")) return "0\n";
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "[agent-a] Fix bug", body: "Closes #7" }]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Proactive rebase failed but review should still proceed (best-effort)
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("tryAutoRebase returns up-to-date when branch is already current with main", async () => {
      // Verify that "up to date" output from git rebase is classified as up-to-date (not success)
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Feature.\n\nCloses #3",
        author: { login: "agent" },
        headRefName: "issue-3-add-feature",
        changedFiles: 1,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "approve",
          comment: "Looks good.",
          reason: "Clean",
        })}],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);
      execSyncMock.mockImplementation((cmd: string) => {
        // Simulate git rebase reporting branch is already up to date
        if (cmd.includes("git rebase origin/main")) return "Current branch issue-3-add-feature is up to date.\n";
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh api") && cmd.includes("comments")) return "0\n";
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "[agent-a] Add feature", body: "Closes #3" }]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Up-to-date → no push needed → review proceeds
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();

      // git push should NOT have been called (nothing to push when up-to-date)
      const pushCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("git push"),
      );
      expect(pushCall).toBeUndefined();
    });
  });

  describe("PR body linter", () => {
    it("auto-patches PR body when issue number is inferrable from branch name", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Some description without issue ref",
        author: { login: "agent" },
        headRefName: "issue-42-add-feature",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Should proceed to LLM review after patching (not request-changes)
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();

      // Should have called gh pr edit to patch the body
      const patchCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr edit") && args[0].includes("--body"),
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain("Closes #42");
    });

    it("requests changes when issue number cannot be inferred from branch name", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Some description without issue ref",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("request-changes");
      expect(result.comment).toContain("Closes #N");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("allows agent PR with Closes #N to proceed to LLM review", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Implements the feature.\n\nCloses #42",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("does not lint non-agent PRs", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Human PR without issue ref",
        body: "Some changes",
        author: { login: "human" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("lints agent PRs that omit [agent-name] title prefix but use issue-N branch convention", async () => {
      // Agent forgot the [agent-a] prefix in the title, but used the standard issue-N branch format.
      // The linter should still fire based on branch name detection.
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Add feature",            // No [agent-a] prefix
        body: "Some description",        // No Closes #N
        author: { login: "agent" },
        headRefName: "issue-42-add-feature",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Branch encodes issue 42 → auto-patch succeeds → proceeds to LLM review
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("blocks agent PR without [agent-name] prefix AND non-issue branch, requesting actionable fix steps", async () => {
      // Agent PR with neither a [agent-name] title prefix nor an issue-N branch.
      // The linter should NOT fire (treated as non-agent PR via feature-branch).
      // This documents current behavior: feature-branch without title prefix is not linted.
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Add some feature",       // No [agent-a] prefix
        body: "Some description",        // No Closes #N
        author: { login: "agent" },
        headRefName: "feature-branch",   // No issue number
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // No agent title prefix AND no issue-N branch → treated as non-agent PR → approved by LLM
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();
    });

    it("auto-patches PR body via fuzzy match when branch name has no issue number but matches an open issue title", async () => {
      // Branch "add-streaming-support" has no issue number embedded, but fuzzy matching
      // should match open issue #57 "Add streaming support to API".
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add streaming support",
        body: "Implements streaming.",
        author: { login: "agent" },
        headRefName: "add-streaming-support",   // No issue-N prefix
        changedFiles: 3,
        mergeable: "MERGEABLE",
      });
      // Make gh issue list return a matching issue for fuzzy resolution
      mockIssueListResponse = JSON.stringify([
        { number: 57, title: "Add streaming support to API" },
        { number: 99, title: "Fix unrelated caching bug" },
      ]);
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Fuzzy match should find issue #57 → auto-patch → proceed to LLM review
      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalled();

      // Should have called gh pr edit to patch the body with Closes #57
      const patchCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr edit") && args[0].includes("--body"),
      );
      expect(patchCall).toBeDefined();
      expect(patchCall![0]).toContain("Closes #57");
    });

    it("requests changes only after all 3 tiers fail — branch parse, fuzzy, and empty issue list", async () => {
      // Branch "feature-branch" has no issue number and "feature" is a stop word,
      // so fuzzy matching against an empty issue list also returns null.
      // All 3 tiers fail → request-changes with actionable steps.
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Some description without issue ref",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      // mockIssueListResponse defaults to "[]" — no issues to fuzzy match against

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("request-changes");
      expect(result.comment).toContain("Closes #N");
      expect(result.reason).toContain("could not infer from branch name, fuzzy match, or LLM");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("feedback message includes actionable gh commands when issue number cannot be inferred", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Some description without issue ref",
        author: { login: "agent" },
        headRefName: "feature-branch",   // No issue number in branch
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("request-changes");
      // Should include the repo name and PR number for actionable commands
      expect(result.comment).toContain("owner/repo");
      expect(result.comment).toContain("gh issue list");
      expect(result.comment).toContain("gh pr edit");
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("isPROpen", () => {
    it("returns true when PR state is OPEN", () => {
      mockPRStateResponse = "OPEN";
      const reviewer = new PRReviewer(config);
      expect(reviewer.isPROpen("owner/repo", 9)).toBe(true);
    });

    it("returns false when PR state is MERGED", () => {
      mockPRStateResponse = "MERGED";
      const reviewer = new PRReviewer(config);
      expect(reviewer.isPROpen("owner/repo", 9)).toBe(false);
    });

    it("returns false when PR state is CLOSED", () => {
      mockPRStateResponse = "CLOSED";
      const reviewer = new PRReviewer(config);
      expect(reviewer.isPROpen("owner/repo", 9)).toBe(false);
    });

    it("returns false (fail-safe) when execSync throws", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementationOnce(() => {
        throw new Error("gh: PR not found");
      });

      const reviewer = new PRReviewer(config);
      expect(reviewer.isPROpen("owner/repo", 99)).toBe(false);
    });
  });

  describe("diff size safety", () => {
    it("auto-escalates when diff exceeds 200 KB without calling LLM", async () => {
      // Generate a diff larger than 200,000 characters
      mockDiffResponse = "+line\n".repeat(35_000); // ~210 KB

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.comment).toContain("exceeds the safe review limit");
      expect(result.reason).toContain("Diff too large");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("includes truncation warning in prompt when diff is between 80 KB and 200 KB", async () => {
      // Generate a diff between 80,000 and 200,000 characters
      mockDiffResponse = "+line\n".repeat(15_000); // ~90 KB
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Looks good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("approve");
      expect(mockCreate).toHaveBeenCalledOnce();

      // Verify the prompt sent to the LLM contains the truncation warning
      const callArgs = mockCreate.mock.calls[0][0];
      const userMessage = callArgs.messages[0].content as string;
      expect(userMessage).toContain("TRUNCATED DIFF WARNING");
      expect(userMessage).toContain("INCOMPLETE");
    });

    it("does not add truncation warning for small diffs under 80 KB", async () => {
      mockDiffResponse = "+small diff\n-removed line\n"; // well under 80 KB
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Looks good", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      await reviewer.reviewPR("owner/repo", 9);

      expect(mockCreate).toHaveBeenCalledOnce();
      const callArgs = mockCreate.mock.calls[0][0];
      const userMessage = callArgs.messages[0].content as string;
      expect(userMessage).not.toContain("TRUNCATED DIFF WARNING");
    });
  });

  describe("review round ceiling (countPriorReviews)", () => {
    it("escalates when 3 prior 'Changes Requested' comments exist (no LLM call)", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) {
          // Simulate 3 prior "Changes Requested" review comments
          return "3\n";
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      // PR has Closes #N in body so the body linter won't fire first
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Fixes the bug.\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.comment).toContain("revision rounds without merging");
      expect(result.reason).toContain("escalating");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("escalation comment follows the expected wording", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) return "3\n";
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Fixes the bug.\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Matches the issue acceptance criteria wording
      expect(result.comment).toBe("This PR has gone through 3 revision rounds without merging — escalating to human review.");
    });

    it("does not escalate early when only 2 prior reviews exist", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) {
          return "2\n"; // Only 2 prior reviews — below ceiling
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Closes #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "request-changes", comment: "Still needs work.", reason: "Bug remains" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // Should proceed to LLM review (not pre-emptively escalate)
      expect(mockCreate).toHaveBeenCalled();
      expect(result.decision).toBe("request-changes");
    });

    it("respects a custom feedback_ceiling from config (escalates at 2 when configured to 2)", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) return "2\n"; // 2 prior reviews
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Closes #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });

      // Config with a lower threshold
      const strictConfig = { ...config, pr_review: { feedback_ceiling: 2 } };
      const reviewer = new PRReviewer(strictConfig);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // 2 reviews >= ceiling of 2 → escalate without LLM
      expect(result.decision).toBe("escalate");
      expect(result.comment).toContain("2 revision rounds");
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("respects a custom feedback_ceiling from config (does NOT escalate at 2 when ceiling is 5)", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) return "2\n"; // only 2 prior reviews
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Closes #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good now.", reason: "Clean" }) }],
      });

      // Lenient config — 5 rounds allowed
      const lenientConfig = { ...config, pr_review: { feedback_ceiling: 5 } };
      const reviewer = new PRReviewer(lenientConfig);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // 2 reviews < ceiling of 5 → proceeds to LLM review
      expect(mockCreate).toHaveBeenCalled();
      expect(result.decision).toBe("approve");
    });

    it("fails open (proceeds to LLM review) when countPriorReviews gh API call throws", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh api") && cmd.includes("comments")) {
          throw new Error("gh: network error");
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([{ number: 9, title: "Test PR", body: "Closes #1" }]);
        return "";
      });

      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Fix bug",
        body: "Closes #1",
        author: { login: "agent" },
        headRefName: "issue-1-fix-bug",
        changedFiles: 2,
        mergeable: "MERGEABLE",
      });
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Looks good now.", reason: "Clean" }) }],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      // countPriorReviews returns 0 on error (fail-open) → proceeds to LLM review
      expect(mockCreate).toHaveBeenCalled();
      expect(result.decision).toBe("approve");
    });
  });

  describe("escalatePR (public method)", () => {
    it("posts an escalation comment and adds rapartlu as reviewer", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);

      const reviewer = new PRReviewer(config);
      await reviewer.escalatePR("owner/repo", 42, "3 feedback rounds with no approval — escalating to human.");

      // Should have called gh pr edit --add-reviewer rapartlu
      const addReviewerCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr edit") && args[0].includes("--add-reviewer rapartlu"),
      );
      expect(addReviewerCall).toBeDefined();

      // Should have posted an escalation comment
      const commentCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr comment") && args[0].includes("Orchestrator escalation"),
      );
      expect(commentCall).toBeDefined();
    });
  });

  describe("conflict escalation tracking", () => {
    it("sets conflictEscalation: true when auto-rebase fails", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rebase origin/main")) {
          throw new Error("CONFLICT (content): Merge conflict in src/index.ts");
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.conflictEscalation).toBe(true);
    });

    it("sets conflictEscalation: true when no local repo is found for a conflicting PR", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 42,
        title: "External PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const reviewer = new PRReviewer(config);
      // "unknown/repo" has no local path in config
      const result = await reviewer.reviewPR("unknown/repo", 42);

      expect(result.decision).toBe("escalate");
      expect(result.conflictEscalation).toBe(true);
    });

    it("does not set conflictEscalation on regular LLM escalations", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify({
          decision: "escalate",
          comment: "Security-sensitive change.",
          reason: "Auth changes need human review",
        })}],
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("escalate");
      expect(result.conflictEscalation).toBeUndefined();
    });

    it("increments conflict escalation count on each conflict escalation", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rebase origin/main")) {
          throw new Error("CONFLICT: Merge conflict");
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([]);
        return "";
      });

      const reviewer = new PRReviewer(config);

      expect(reviewer.getConflictEscalationCount("owner/repo", 9)).toBe(0);

      await reviewer.reviewPR("owner/repo", 9);
      expect(reviewer.getConflictEscalationCount("owner/repo", 9)).toBe(1);

      await reviewer.reviewPR("owner/repo", 9);
      expect(reviewer.getConflictEscalationCount("owner/repo", 9)).toBe(2);
    });

    it("resetConflictEscalation clears the counter", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("git rebase origin/main")) {
          throw new Error("CONFLICT: Merge conflict");
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return mockPRStateResponse;
        if (cmd.includes("gh pr view")) return mockPRViewResponse;
        if (cmd.includes("gh pr diff")) return mockDiffResponse;
        if (cmd.includes("gh issue list")) return mockIssueListResponse;
        if (cmd.includes("gh pr list")) return JSON.stringify([]);
        return "";
      });

      const reviewer = new PRReviewer(config);
      await reviewer.reviewPR("owner/repo", 9);
      await reviewer.reviewPR("owner/repo", 9);

      expect(reviewer.getConflictEscalationCount("owner/repo", 9)).toBe(2);
      reviewer.resetConflictEscalation("owner/repo", 9);
      expect(reviewer.getConflictEscalationCount("owner/repo", 9)).toBe(0);
    });

    it("autoCloseConflictingPR posts a comment and closes the PR with --delete-branch", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      const execSyncMock = vi.mocked(mockExecSync);
      execSyncMock.mockImplementation(() => "");

      const reviewer = new PRReviewer(config);
      const closed = reviewer.autoCloseConflictingPR("owner/repo", 9, "feature-branch", 2);

      expect(closed).toBe(true);

      // Should have posted an explanatory comment
      const commentCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr comment") && args[0].includes("Auto-closed due to persistent merge conflicts"),
      );
      expect(commentCall).toBeDefined();

      // Should have closed the PR with --delete-branch
      const closeCall = execSyncMock.mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh pr close") && args[0].includes("--delete-branch"),
      );
      expect(closeCall).toBeDefined();
    });

    it("autoCloseConflictingPR returns false and tries branch API deletion when PR close fails", async () => {
      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh pr close")) throw new Error("PR close failed");
        return ""; // comment succeeds, branch API succeeds
      });

      const reviewer = new PRReviewer(config);
      const closed = reviewer.autoCloseConflictingPR("owner/repo", 9, "feature-branch", 2);

      expect(closed).toBe(false);

      // Should have attempted branch deletion via API as fallback
      const branchDeleteCall = vi.mocked(mockExecSync).mock.calls.find(
        (args) => typeof args[0] === "string" && args[0].includes("gh api") && args[0].includes("DELETE") && args[0].includes("feature-branch"),
      );
      expect(branchDeleteCall).toBeDefined();
    });

    it("reviewOpenPRs includes prBranch in each result entry", async () => {
      mockCreate
        .mockResolvedValueOnce({
          content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
        })
        .mockResolvedValueOnce({
          content: [{ type: "text", text: JSON.stringify({ decision: "approve", comment: "Good", reason: "Clean" }) }],
        });

      const { execSync: mockExecSync } = await import("node:child_process");
      vi.mocked(mockExecSync).mockImplementation((cmd: string) => {
        if (cmd.includes("gh pr list")) {
          return JSON.stringify([
            { number: 9, title: "PR One", body: "Closes #9", headRefName: "issue-9-branch" },
            { number: 10, title: "PR Two", body: "Closes #10", headRefName: "issue-10-branch" },
          ]);
        }
        if (cmd.includes("gh pr view") && cmd.includes("-q .state")) return "OPEN";
        if (cmd.includes("gh pr view")) return JSON.stringify({
          number: 9, title: "PR One", body: "Closes #9",
          author: { login: "agent" }, headRefName: "issue-9-branch",
          changedFiles: 1, mergeable: "MERGEABLE",
        });
        if (cmd.includes("gh pr diff")) return "+added";
        if (cmd.includes("gh api") && cmd.includes("comments")) return "0\n";
        if (cmd.includes("gh issue list")) return "[]";
        return "";
      });

      const reviewer = new PRReviewer(config);
      const results = await reviewer.reviewOpenPRs("owner/repo");

      expect(results[0].prBranch).toBe("issue-9-branch");
      expect(results[1].prBranch).toBe("issue-10-branch");
    });
  });
});
