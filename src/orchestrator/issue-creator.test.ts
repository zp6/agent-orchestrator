import { describe, it, expect, vi, beforeEach } from "vitest";
import { IssueCreator } from "./issue-creator.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { DetectedImprovement } from "./improvement-detector.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("https://github.com/owner/repo/issues/42\n"),
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
      if (typeof cmd === "string" && cmd.includes("--label orchestrator") && cmd.includes("--state open")) return "[]";
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
    // 2 throttle checks + 2 issue creates = 4 calls
    expect(mockExecSync).toHaveBeenCalledTimes(4);
  });

  it("skips agents without github config", () => {
    const improvement: DetectedImprovement = {
      title: "Fix",
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
        if (typeof cmd === "string" && cmd.includes("gh issue list") && cmd.includes("--state open")) return tenIssues;
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
        if (typeof cmd === "string" && cmd.includes("gh issue list") && cmd.includes("--state open")) return fiveIssues;
        return "https://github.com/owner/repo-a/issues/42\n";
      });

      const improvement: DetectedImprovement = {
        title: "Fix", description: "Issue", affected_agents: ["agent-a"], severity: "low", evidence: [],
      };
      const creator = new IssueCreator(config);
      const results = creator.createAcrossRepos(improvement);
      expect(results).toHaveLength(1);
    });

    it("fails open when count check errors", () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && cmd.includes("gh issue list") && cmd.includes("--state open")) throw new Error("gh failed");
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
});
