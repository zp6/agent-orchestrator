import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractIssueNumberFromBranch, createPRForBranch } from "./pr-creator.js";
import type { OrphanBranch } from "./pr-creator.js";

const mockExecSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

beforeEach(() => {
  mockExecSync.mockReset();
});

describe("extractIssueNumberFromBranch", () => {
  it("extracts issue number from issue-N-description pattern", () => {
    expect(extractIssueNumberFromBranch("issue-105-enforce-closes-n")).toBe("105");
  });

  it("extracts issue number from issue-N pattern (no description)", () => {
    expect(extractIssueNumberFromBranch("issue-42")).toBe("42");
  });

  it("extracts issue number from fix-issue-N pattern", () => {
    expect(extractIssueNumberFromBranch("fix-issue-99")).toBe("99");
  });

  it("extracts issue number from issue_N_description (underscore separator)", () => {
    expect(extractIssueNumberFromBranch("issue_7_fix_bug")).toBe("7");
  });

  it("extracts issue number from branch starting with N-description", () => {
    expect(extractIssueNumberFromBranch("105-add-feature")).toBe("105");
  });

  it("returns null for generic feature branch with no issue number", () => {
    expect(extractIssueNumberFromBranch("feature-branch")).toBeNull();
  });

  it("returns null for main branch", () => {
    expect(extractIssueNumberFromBranch("main")).toBeNull();
  });

  it("returns null for branch with number in the middle but not at start or after 'issue'", () => {
    expect(extractIssueNumberFromBranch("feature-42-enhancement")).toBeNull();
  });

  it("is case-insensitive for 'issue' keyword", () => {
    expect(extractIssueNumberFromBranch("ISSUE-200-description")).toBe("200");
  });
});

describe("createPRForBranch", () => {
  const orphan: OrphanBranch = {
    repo: "owner/repo",
    branch: "issue-105-add-feature",
    agentName: "agent-a",
  };

  it("includes Closes #N in PR body when issue number is inferrable from branch", () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/10\n");

    const url = createPRForBranch(orphan);

    expect(url).toBe("https://github.com/owner/repo/pull/10");
    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).toContain("Closes #105");
  });

  it("uses generic body when issue number is not inferrable from branch", () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/11\n");

    const genericOrphan: OrphanBranch = { ...orphan, branch: "feature-branch" };
    createPRForBranch(genericOrphan);

    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).not.toContain("Closes #");
    expect(callCmd).toContain("Auto-created by orchestrator");
  });

  it("returns null when gh pr create fails", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: not found");
    });

    const result = createPRForBranch(orphan);
    expect(result).toBeNull();
  });

  it("includes the agent name and branch in the PR title", () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/12\n");

    createPRForBranch(orphan);

    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).toContain("[agent-a]");
    expect(callCmd).toContain("issue-105-add-feature");
  });
});
