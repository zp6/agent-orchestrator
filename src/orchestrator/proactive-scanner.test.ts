import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { runProactiveScan } from "./proactive-scanner.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockExecSync = vi.mocked(execSync);

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "agent-a": { dir: "a", description: "A", capabilities: ["test"], owns_topics: ["a"], github: "owner/repo" },
  },
};

function branchList(branches: string[]): string {
  return JSON.stringify(branches);
}

describe("runProactiveScan stale branch filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips filing an issue when all stale branches disappear before dispatch", () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh run list --repo owner/repo --branch main --status failure")) return "[]";
      if (cmd.includes("gh api repos/owner/repo/branches")) {
        return branchList(["feature-1", "feature-2", "feature-3", "feature-4", "feature-5"]);
      }
      if (cmd.includes("gh pr list --repo owner/repo --head")) return "0";
      if (cmd.includes("git/refs/heads/")) throw new Error("Not Found");
      throw new Error(`Unexpected command: ${cmd}`);
    });

    expect(runProactiveScan(config, {} as never)).toBe(0);
  });

  it("filters deleted branches out of the stale-branch issue body", () => {
    const liveBranches = new Set(["feature-1", "feature-2", "feature-3", "feature-4", "feature-5"]);
    const issueCreates: string[] = [];

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh run list --repo owner/repo --branch main --status failure")) return "[]";
      if (cmd.includes("gh api repos/owner/repo/branches")) {
        return branchList([...liveBranches, "feature-deleted"]);
      }
      if (cmd.includes("gh pr list --repo owner/repo --head")) return "0";
      if (cmd.includes("git/refs/heads/")) {
        const branch = cmd.match(/git\/refs\/heads\/(.+?)'\s+--jq/)?.[1];
        if (branch && liveBranches.has(branch)) return `refs/heads/${branch}`;
        throw new Error("Not Found");
      }
      if (cmd.includes("gh issue list --repo owner/repo --state open --search")) return "0";
      if (cmd.startsWith("gh issue create")) {
        issueCreates.push(cmd);
        return "https://github.com/owner/repo/issues/123";
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    expect(runProactiveScan(config, {} as never)).toBe(1);
    expect(issueCreates).toHaveLength(1);
    expect(issueCreates[0]).toContain("5 orphan branches with no open PR");
    expect(issueCreates[0]).not.toContain("feature-deleted");
    expect(issueCreates[0]).toContain("feature-1");
    expect(issueCreates[0]).toContain("feature-5");
  });
});
