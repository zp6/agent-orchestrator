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
});

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    if (cmd.includes("gh pr view")) {
      return mockPRViewResponse;
    }
    if (cmd.includes("gh pr diff")) {
      return "+added line\n-removed line";
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
  });
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

  describe("PR body linter", () => {
    it("short-circuits agent PR without Closes #N to request-changes", async () => {
      mockPRViewResponse = JSON.stringify({
        number: 9,
        title: "[agent-a] Add feature",
        body: "Some description without issue ref",
        author: { login: "agent" },
        headRefName: "feature-branch",
        changedFiles: 2,
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
});
