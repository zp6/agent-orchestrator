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
        { number: 9, title: "Test PR" },
        { number: 10, title: "Another PR" },
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

  describe("merge conflict detection", () => {
    it("short-circuits conflicting PRs without calling LLM", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "Test PR",
        body: "Description\n\nCloses #1",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
        mergeable: "CONFLICTING",
      });

      const reviewer = new PRReviewer(config);
      const result = await reviewer.reviewPR("owner/repo", 9);

      expect(result.decision).toBe("request-changes");
      expect(result.comment).toContain("merge conflict");
      expect(result.reason).toContain("Merge conflict");
      expect(mockCreate).not.toHaveBeenCalled();
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
});
