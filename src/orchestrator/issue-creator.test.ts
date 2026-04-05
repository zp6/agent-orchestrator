import { describe, it, expect, vi, beforeEach } from "vitest";
import { IssueCreator } from "./issue-creator.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { DetectedImprovement } from "./improvement-detector.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("gh issue list")) {
      return "[]";
    }
    return "https://github.com/owner/repo/issues/42\n";
  }),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "agent-a": { dir: "a", description: "A", capabilities: ["test"], owns_topics: ["a"], github: "owner/repo-a" },
    "agent-b": { dir: "b", description: "B", capabilities: ["test"], owns_topics: ["b"], github: "owner/repo-b" },
    "no-github": { dir: "c", description: "C", capabilities: ["test"], owns_topics: ["c"] },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IssueCreator", () => {
  it("creates a single issue", () => {
    const creator = new IssueCreator(config);
    const result = creator.createIssue("owner/repo", "Test issue", "Body text");
    expect(result.number).toBe(42);
    expect(result.url).toContain("issues/42");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue create"),
      expect.any(Object),
    );
  });

  it("creates issues across repos for affected agents", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("gh issue list")) return "[]";
      return "https://github.com/owner/repo/issues/42\n";
    });

    const improvement: DetectedImprovement = {
      title: "Add retry logic",
      description: "Both agents need retries",
      affected_agents: ["agent-a", "agent-b"],
      severity: "medium",
      evidence: [{ taskId: "test-1", detail: "Failed task" }],
    };

    const creator = new IssueCreator(config);
    const results = creator.createAcrossRepos(improvement);
    expect(results).toHaveLength(2);
    // Each agent: 1 throttle check (--label orchestrator) + 1 dedup check (no --label) + 1 create = 3 calls × 2 agents = 6
    expect(mockExecSync).toHaveBeenCalledTimes(6);
  });

  it("skips agents without github config", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("gh issue list")) return "[]";
      return "https://github.com/owner/repo/issues/42\n";
    });

    const improvement: DetectedImprovement = {
      title: "Fix some things",
      description: "Issue",
      affected_agents: ["agent-a", "no-github"],
      severity: "low",
      evidence: [],
    };

    const creator = new IssueCreator(config);
    const results = creator.createAcrossRepos(improvement);
    expect(results).toHaveLength(1); // only agent-a
  });

  it("includes orchestrator label", () => {
    const creator = new IssueCreator(config);
    creator.createIssue("owner/repo", "Test", "Body");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("--label"),
      expect.any(Object),
    );
  });

  describe("issue creation throttle", () => {
    it("skips creation when repo has too many open orchestrator issues", () => {
      const tenIssues = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ number: i + 1 })));
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh issue list") && cmd.includes("--label orchestrator")) return tenIssues;
        return "https://github.com/owner/repo-a/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Fix", description: "Issue", affected_agents: ["agent-a"], severity: "low", evidence: [],
      };
      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(0);
    });

    it("allows creation when repo is below threshold", () => {
      const fiveIssues = JSON.stringify(Array.from({ length: 5 }, (_, i) => ({ number: i + 1 })));
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh issue list") && cmd.includes("--label orchestrator")) return fiveIssues;
        if (typeof cmd === "string" && cmd.includes("gh issue list")) return "[]";
        return "https://github.com/owner/repo-a/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Fix unique problem", description: "Issue", affected_agents: ["agent-a"], severity: "low", evidence: [],
      };
      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(1);
    });

    it("fails open when count check errors", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh issue list")) throw new Error("gh failed");
        return "https://github.com/owner/repo-a/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Fix", description: "Issue", affected_agents: ["agent-a"], severity: "low", evidence: [],
      };
      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(1);
    });
  });

  describe("titleSimilarity", () => {
    it("returns 1 for identical titles", () => {
      const creator = new IssueCreator(config);
      expect(creator.titleSimilarity("Add retry logic", "Add retry logic")).toBe(1);
    });

    it("returns 0 for completely different titles", () => {
      const creator = new IssueCreator(config);
      expect(creator.titleSimilarity("Improve caching layer", "Fix broken authentication")).toBe(0);
    });

    it("detects partial overlap as moderate similarity", () => {
      const creator = new IssueCreator(config);
      const sim = creator.titleSimilarity(
        "[Orchestrator] Add retry logic for failed tasks",
        "Add retry logic",
      );
      // "retry" and "logic" overlap → should be above 0 but below 1
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
    });

    it("ignores stop words and punctuation", () => {
      const creator = new IssueCreator(config);
      // "the", "a", "and" are stop words; meaningful words "streaming" and "bug" only partially overlap
      const sim = creator.titleSimilarity("Fix the streaming bug", "Fix a streaming issue");
      // "streaming" overlaps, "bug" vs "issue" don't → should be > 0
      expect(sim).toBeGreaterThan(0);
    });

    it("handles empty strings gracefully", () => {
      const creator = new IssueCreator(config);
      expect(creator.titleSimilarity("", "")).toBe(1);
      expect(creator.titleSimilarity("Add retry", "")).toBe(0);
    });
  });

  describe("isDuplicate", () => {
    it("returns true when a highly similar issue exists", () => {
      const existingTitles = JSON.stringify([
        { title: "[Orchestrator] Add retry logic for failed tasks" },
      ]);
      mockExecSync.mockReturnValue(existingTitles);

      const creator = new IssueCreator(config);
      // Near-identical title — should be detected as duplicate
      expect(creator.isDuplicate("owner/repo", "[Orchestrator] Add retry logic for tasks")).toBe(true);
    });

    it("returns false when no similar issue exists", () => {
      const existingTitles = JSON.stringify([
        { title: "Improve caching layer" },
        { title: "Fix broken authentication flow" },
      ]);
      mockExecSync.mockReturnValue(existingTitles);

      const creator = new IssueCreator(config);
      expect(creator.isDuplicate("owner/repo", "[Orchestrator] Add metrics dashboard")).toBe(false);
    });

    it("fails open (returns false) when gh errors", () => {
      mockExecSync.mockImplementation(() => { throw new Error("gh failed"); });

      const creator = new IssueCreator(config);
      expect(creator.isDuplicate("owner/repo", "Any title")).toBe(false);
    });
  });

  describe("dedup in createAcrossRepos", () => {
    it("skips issue creation when a similar issue already exists", () => {
      const existingIssues = JSON.stringify([
        { title: "[Orchestrator] Add retry logic for failed tasks" },
      ]);

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--label orchestrator")) return "[]";
        if (typeof cmd === "string" && cmd.includes("gh issue list")) return existingIssues;
        return "https://github.com/owner/repo/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Add retry logic for tasks", // similar to existing
        description: "Agents need retries",
        affected_agents: ["agent-a"],
        severity: "medium",
        evidence: [],
      };

      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(0);
      expect(mockExecSync).not.toHaveBeenCalledWith(
        expect.stringContaining("gh issue create"),
        expect.any(Object),
      );
    });

    it("creates issue when existing issues are dissimilar", () => {
      const existingIssues = JSON.stringify([
        { title: "Improve caching layer" },
        { title: "Fix authentication" },
      ]);

      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("--label orchestrator")) return "[]";
        if (typeof cmd === "string" && cmd.includes("gh issue list")) return existingIssues;
        return "https://github.com/owner/repo-a/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Add metrics dashboard",
        description: "Need visibility into task throughput",
        affected_agents: ["agent-a"],
        severity: "low",
        evidence: [],
      };

      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(1);
    });
  });
});
