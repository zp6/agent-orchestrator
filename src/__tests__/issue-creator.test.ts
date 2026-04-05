import { describe, it, expect, beforeEach } from "vitest";
import { IssueCreator } from "../reviewer/issue-creator.js";
import type { ReviewerConfig } from "../config.js";

const mockConfig: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orch",
  agents: {
    "claude-proxy": {
      description: "Claude proxy agent",
      github: "owner/claude-proxy",
      dir: "claude-proxy",
    },
    "claude-agent-orchestrator": {
      description: "Orchestrator agent",
      github: "owner/claude-agent-orchestrator",
      dir: "orchestrator",
    },
  },
};

describe("IssueCreator.titleSimilarity", () => {
  let creator: IssueCreator;

  beforeEach(() => {
    creator = new IssueCreator(mockConfig);
  });

  it("returns 1 for identical titles", () => {
    expect(creator.titleSimilarity("Add authentication feature", "Add authentication feature")).toBe(1);
  });

  it("returns 0 for completely different titles", () => {
    const sim = creator.titleSimilarity("Add authentication", "Deploy container");
    expect(sim).toBe(0);
  });

  it("returns high similarity for near-duplicate titles", () => {
    const sim = creator.titleSimilarity(
      "[Orchestrator] Add OAuth2 authentication support",
      "[Orchestrator] Add OAuth2 authentication support for login",
    );
    expect(sim).toBeGreaterThan(0.4);
  });

  it("returns similarity below threshold for different topics", () => {
    const sim = creator.titleSimilarity(
      "Add webhook integration",
      "Improve error logging",
    );
    expect(sim).toBeLessThan(0.4);
  });

  it("handles empty strings", () => {
    // Both empty = no meaningful words = similarity of 1 (by convention)
    expect(creator.titleSimilarity("", "")).toBe(1);
    // One empty, one non-empty = 0
    expect(creator.titleSimilarity("hello", "")).toBe(0);
  });

  it("ignores stop words in comparison", () => {
    // "add" and "fix" are stop words, so "add oauth" and "fix oauth" should
    // share the meaningful word "oauth" and have high similarity
    const sim = creator.titleSimilarity("add oauth integration", "fix oauth integration");
    expect(sim).toBeGreaterThan(0.4);
  });
});
