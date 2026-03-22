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
    expect(mockExecSync).toHaveBeenCalledTimes(2);
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
});
