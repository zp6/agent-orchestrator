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

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.includes("gh pr view")) {
      return mockPRViewResponse;
    }
    if (cmd.includes("gh pr diff")) {
      return mockDiffResponse;
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
    it("short-circuits agent PR without Closes #N to request-changes", async () => {
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
