import { describe, it, expect, beforeEach } from "vitest";
import { IssueCreator } from "../reviewer/issue-creator.js";
import type { ReviewerConfig } from "../config.js";
import type { DetectedImprovement } from "../reviewer/improvement-detector.js";

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

describe("IssueCreator.formatIssueBody", () => {
  let creator: IssueCreator;

  const baseImprovement: DetectedImprovement = {
    title: "Add research findings issue drafting",
    description: "Automatically draft GitHub issues from research recommendations.",
    affected_agents: ["claude-proxy"],
    severity: "medium",
    evidence: [{ taskId: "aaaabbbbccccdddd", detail: "Research: follow-up context injection" }],
  };

  beforeEach(() => {
    creator = new IssueCreator(mockConfig);
  });

  it("uses task-pattern header when source is undefined", () => {
    const body = creator.formatIssueBody(baseImprovement, "claude-proxy");
    expect(body).toContain("## Improvement Identified by Orchestrator");
    expect(body).toContain("recent task patterns");
    expect(body).not.toContain("Research Findings");
  });

  it("uses task-pattern header when source is 'task-pattern'", () => {
    const imp: DetectedImprovement = { ...baseImprovement, source: "task-pattern" };
    const body = creator.formatIssueBody(imp, "claude-proxy");
    expect(body).toContain("## Improvement Identified by Orchestrator");
    expect(body).toContain("recent task patterns");
  });

  it("uses research-finding header when source is 'research-finding'", () => {
    const imp: DetectedImprovement = { ...baseImprovement, source: "research-finding" };
    const body = creator.formatIssueBody(imp, "claude-proxy");
    expect(body).toContain("## Implementation Proposal from Research Findings");
    expect(body).toContain("### Source Research Tasks");
    expect(body).toContain("research reports");
    expect(body).not.toContain("task patterns");
  });

  it("includes severity and agent name in both formats", () => {
    const taskImp: DetectedImprovement = { ...baseImprovement, source: "task-pattern" };
    const researchImp: DetectedImprovement = { ...baseImprovement, source: "research-finding" };

    for (const imp of [taskImp, researchImp]) {
      const body = creator.formatIssueBody(imp, "claude-proxy");
      expect(body).toContain("**Severity:** medium");
      expect(body).toContain("**Affected agent:** claude-proxy");
      expect(body).toContain(baseImprovement.description);
    }
  });

  it("includes evidence task IDs in both formats", () => {
    const imp: DetectedImprovement = { ...baseImprovement, source: "research-finding" };
    const body = creator.formatIssueBody(imp, "claude-proxy");
    expect(body).toContain("aaaabbbb");
    expect(body).toContain("Research: follow-up context injection");
  });

  it("shows fallback message when evidence is empty", () => {
    const imp: DetectedImprovement = { ...baseImprovement, evidence: [], source: "research-finding" };
    const body = creator.formatIssueBody(imp, "claude-proxy");
    expect(body).toContain("No specific task evidence available.");
  });
});
