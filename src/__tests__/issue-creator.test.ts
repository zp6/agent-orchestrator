import { describe, it, expect, beforeEach, vi } from "vitest";
import { IssueCreator, DEFAULT_MAX_CROSS_REPO_ISSUES } from "../reviewer/issue-creator.js";
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
    "claude-orchestrator-dashboard": {
      description: "Dashboard agent",
      github: "owner/claude-orchestrator-dashboard",
      dir: "dashboard",
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

describe("IssueCreator.createAcrossReposWithCap", () => {
  let creator: IssueCreator;

  beforeEach(() => {
    creator = new IssueCreator(mockConfig);
    // Stub out external calls
    vi.spyOn(creator, "getOpenOrchestratorIssueCount").mockReturnValue(0);
    vi.spyOn(creator, "getOpenIssueTitles").mockReturnValue([]);
    vi.spyOn(creator, "createIssue").mockImplementation((repo, title) => ({
      repo,
      number: 100,
      url: `https://github.com/${repo}/issues/100`,
    }));
  });

  it("defaults maxCrossRepoIssues to 1", () => {
    expect(DEFAULT_MAX_CROSS_REPO_ISSUES).toBe(1);
  });

  it("creates only 1 issue and defers the rest with default cap", () => {
    const improvement: DetectedImprovement = {
      title: "Fix dispatch surge",
      description: "Cap cross-repo follow-ups",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator", "claude-orchestrator-dashboard"],
      severity: "high",
      evidence: [],
    };

    const result = creator.createAcrossReposWithCap(improvement);

    expect(result.created).toHaveLength(1);
    expect(result.deferred).toHaveLength(2);
    expect(result.capReached).toBe(true);
    expect(result.created[0].repo).toBe("owner/claude-proxy");
    expect(result.deferred[0].repo).toBe("owner/claude-agent-orchestrator");
    expect(result.deferred[1].repo).toBe("owner/claude-orchestrator-dashboard");
  });

  it("creates all issues when maxCrossRepoIssues is 0 (unlimited)", () => {
    const improvement: DetectedImprovement = {
      title: "Fix dispatch surge",
      description: "No cap",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator", "claude-orchestrator-dashboard"],
      severity: "high",
      evidence: [],
    };

    const result = creator.createAcrossReposWithCap(improvement, { maxCrossRepoIssues: 0 });

    expect(result.created).toHaveLength(3);
    expect(result.deferred).toHaveLength(0);
    expect(result.capReached).toBe(false);
  });

  it("creates up to the specified cap", () => {
    const improvement: DetectedImprovement = {
      title: "Fix dispatch surge",
      description: "Cap at 2",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator", "claude-orchestrator-dashboard"],
      severity: "high",
      evidence: [],
    };

    const result = creator.createAcrossReposWithCap(improvement, { maxCrossRepoIssues: 2 });

    expect(result.created).toHaveLength(2);
    expect(result.deferred).toHaveLength(1);
    expect(result.capReached).toBe(true);
  });

  it("does not defer when only 1 agent is affected", () => {
    const improvement: DetectedImprovement = {
      title: "Single agent fix",
      description: "Only one agent",
      affected_agents: ["claude-proxy"],
      severity: "low",
      evidence: [],
    };

    const result = creator.createAcrossReposWithCap(improvement);

    expect(result.created).toHaveLength(1);
    expect(result.deferred).toHaveLength(0);
    expect(result.capReached).toBe(false);
  });

  it("backward compat: createAcrossRepos still returns CreatedIssue[]", () => {
    const improvement: DetectedImprovement = {
      title: "Backward compat test",
      description: "Should return flat array",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator"],
      severity: "medium",
      evidence: [],
    };

    const result = creator.createAcrossRepos(improvement);

    // Legacy callers get only the created issues (cap applied silently)
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it("backward compat: accepts string[] as extra labels", () => {
    const improvement: DetectedImprovement = {
      title: "Label test",
      description: "Labels passed",
      affected_agents: ["claude-proxy"],
      severity: "low",
      evidence: [],
    };

    const createIssueSpy = vi.spyOn(creator, "createIssue");
    creator.createAcrossReposWithCap(improvement, { extraLabels: ["iteration-cost-triggered"] });

    expect(createIssueSpy).toHaveBeenCalledWith(
      "owner/claude-proxy",
      "[Orchestrator] Label test",
      expect.any(String),
      ["orchestrator", "iteration-cost-triggered"],
    );
  });

  it("skips throttled repos without counting toward the cap", () => {
    vi.spyOn(creator, "getOpenOrchestratorIssueCount").mockImplementation((repo) =>
      repo === "owner/claude-proxy" ? 999 : 0,
    );

    const improvement: DetectedImprovement = {
      title: "Throttled first",
      description: "First agent is throttled",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator", "claude-orchestrator-dashboard"],
      severity: "high",
      evidence: [],
    };

    const result = creator.createAcrossReposWithCap(improvement);

    // claude-proxy is throttled (skipped), so orchestrator gets created (1 cap),
    // dashboard is deferred
    expect(result.created).toHaveLength(1);
    expect(result.created[0].repo).toBe("owner/claude-agent-orchestrator");
    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].repo).toBe("owner/claude-orchestrator-dashboard");
  });

  it("deferred items include title and body", () => {
    const improvement: DetectedImprovement = {
      title: "Multi-repo concern",
      description: "Detailed description of the concern",
      affected_agents: ["claude-proxy", "claude-agent-orchestrator"],
      severity: "high",
      evidence: [{ taskId: "abc12345", detail: "Evidence detail" }],
    };

    const result = creator.createAcrossReposWithCap(improvement);

    expect(result.deferred).toHaveLength(1);
    expect(result.deferred[0].title).toBe("[Orchestrator] Multi-repo concern");
    expect(result.deferred[0].body).toContain("Detailed description of the concern");
    expect(result.deferred[0].agentName).toBe("claude-agent-orchestrator");
  });
});

describe("IssueCreator.postDeferredFollowUps", () => {
  let creator: IssueCreator;
  const mockExecSync = vi.fn();

  beforeEach(() => {
    creator = new IssueCreator(mockConfig);
    // We can't easily mock execSync inside the module, so we test the format logic
    // by checking the method doesn't throw with valid inputs
  });

  it("does nothing when deferred array is empty", () => {
    // Should not throw
    creator.postDeferredFollowUps("owner/repo", 42, []);
  });
});
