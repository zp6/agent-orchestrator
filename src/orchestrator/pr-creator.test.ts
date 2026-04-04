import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractIssueNumberFromBranch,
  fuzzyMatchIssues,
  findMatchingIssueNumber,
  createPRForBranch,
} from "./pr-creator.js";
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

// Mock LLM client — tests that exercise LLM disambiguation will override this
vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "none" }] }),
    },
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

  it("extracts issue number from fix/issue-N-description (slash separator)", () => {
    expect(extractIssueNumberFromBranch("fix/issue-134-auto-link-prs")).toBe("134");
  });

  it("extracts issue number from feature/issue-N (slash with no description)", () => {
    expect(extractIssueNumberFromBranch("feature/issue-200")).toBe("200");
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

describe("fuzzyMatchIssues", () => {
  const issues = [
    { number: 10, title: "Auto-link issues when creating orphan branch PRs" },
    { number: 11, title: "Validate Closes #N before PR creation" },
    { number: 12, title: "Show response latency in agent health output" },
    { number: 13, title: "Support branch configuration for deployments" },
  ];

  it("matches branch tokens against issue titles", () => {
    const results = fuzzyMatchIssues("auto-link-orphan-prs", issues);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].number).toBe(10);
  });

  it("returns results sorted by score (highest first)", () => {
    const results = fuzzyMatchIssues("auto-link-orphan-prs", issues);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it("ignores stop words in branch name", () => {
    // "fix" and "feature" are stop words — should not cause false matches
    const results = fuzzyMatchIssues("fix-feature-branch", issues);
    // "branch" appears in issue #13, "feature" is a stop word
    // Only "branch" is a meaningful token here
    const hasIssue13 = results.some((r) => r.number === 13);
    expect(hasIssue13).toBe(true);
  });

  it("handles slash separators in branch name", () => {
    const results = fuzzyMatchIssues("feature/auto-link-orphan-prs", issues);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].number).toBe(10);
  });

  it("returns empty array when no meaningful tokens match", () => {
    const results = fuzzyMatchIssues("xyz-zzz-aaa-bbb", issues);
    expect(results).toHaveLength(0);
  });

  it("returns empty array when branch only has stop words", () => {
    const results = fuzzyMatchIssues("fix-feat-ci-docs", issues);
    expect(results).toHaveLength(0);
  });

  it("includes score on returned candidates", () => {
    const results = fuzzyMatchIssues("auto-link-orphan-prs", issues);
    for (const r of results) {
      expect(typeof r.score).toBe("number");
      expect(r.score).toBeGreaterThan(0);
    }
  });
});

describe("findMatchingIssueNumber", () => {
  it("returns issue number parsed from branch name without querying GitHub", async () => {
    const result = await findMatchingIssueNumber("owner/repo", "issue-105-add-feature");
    // Should return without calling execSync (branch parse is synchronous)
    expect(result).toBe("105");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("falls back to fuzzy match when branch name has no issue number", async () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { number: 42, title: "Auto-link orphan branch PRs to issues" },
        { number: 99, title: "Unrelated issue about caching" },
      ]),
    );

    const result = await findMatchingIssueNumber("owner/repo", "auto-link-orphan-branches");
    expect(result).toBe("42");
  });

  it("returns null when gh issue list fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: authentication failed");
    });

    const result = await findMatchingIssueNumber("owner/repo", "feature-branch");
    expect(result).toBeNull();
  });

  it("returns null when no issues are open", async () => {
    mockExecSync.mockReturnValueOnce("[]");
    const result = await findMatchingIssueNumber("owner/repo", "auto-link-prs");
    expect(result).toBeNull();
  });

  it("returns null when fuzzy match finds no candidates", async () => {
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 1, title: "Something completely unrelated xyz" }]),
    );
    const result = await findMatchingIssueNumber("owner/repo", "totally-different-branch");
    expect(result).toBeNull();
  });
});

describe("createPRForBranch", () => {
  const orphan: OrphanBranch = {
    repo: "owner/repo",
    branch: "issue-105-add-feature",
    agentName: "agent-a",
  };

  it("includes Closes #N in PR body when issue number is inferrable from branch", async () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/10\n");

    const url = await createPRForBranch(orphan);

    expect(url).toBe("https://github.com/owner/repo/pull/10");
    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).toContain("Closes #105");
  });

  it("uses generic body when issue number is not inferrable and no issues match", async () => {
    // First call: gh issue list → empty
    mockExecSync.mockReturnValueOnce("[]");
    // Second call: gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/11\n");

    const genericOrphan: OrphanBranch = { ...orphan, branch: "feature-branch" };
    await createPRForBranch(genericOrphan);

    const prCreateCall = mockExecSync.mock.calls[1][0] as string;
    expect(prCreateCall).not.toContain("Closes #");
    expect(prCreateCall).toContain("Auto-created by orchestrator");
  });

  it("includes Closes #N when fuzzy matching finds an issue", async () => {
    // First call: gh issue list → returns a matching issue
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 77, title: "Auto-link orphan branch PRs" }]),
    );
    // Second call: gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/15\n");

    const fuzzyOrphan: OrphanBranch = { ...orphan, branch: "auto-link-orphan-prs" };
    await createPRForBranch(fuzzyOrphan);

    const prCreateCall = mockExecSync.mock.calls[1][0] as string;
    expect(prCreateCall).toContain("Closes #77");
  });

  it("returns null when gh pr create fails", async () => {
    mockExecSync.mockReturnValueOnce("[]"); // gh issue list
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("gh: not found");
    }); // gh pr create

    const result = await createPRForBranch({ ...orphan, branch: "feature-branch" });
    expect(result).toBeNull();
  });

  it("includes the agent name and branch in the PR title", async () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/12\n");

    await createPRForBranch(orphan);

    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).toContain("[agent-a]");
    expect(callCmd).toContain("issue-105-add-feature");
  });

  it("handles fix/issue-N branch format correctly", async () => {
    mockExecSync.mockReturnValue("https://github.com/owner/repo/pull/20\n");

    const slashOrphan: OrphanBranch = { ...orphan, branch: "fix/issue-134-auto-link" };
    await createPRForBranch(slashOrphan);

    const callCmd = mockExecSync.mock.calls[0][0] as string;
    expect(callCmd).toContain("Closes #134");
  });
});
