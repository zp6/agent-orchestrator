import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractIssueNumberFromBranch,
  fuzzyMatchIssues,
  findMatchingIssueNumber,
  createPRForBranch,
  createPRWithRetry,
  PR_CREATE_MAX_RETRIES,
} from "./pr-creator.js";
import type { OrphanBranch } from "./pr-creator.js";
import { validateGhAuth } from "../triggers/github.js";

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

// Default: gh auth passes. Individual tests can override with mockReturnValueOnce.
vi.mock("../triggers/github.js", () => ({
  validateGhAuth: vi.fn().mockReturnValue({ ok: true }),
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

  /** Find the `gh pr create` call among all mockExecSync calls. */
  function findPrCreateCall(): string | undefined {
    return (mockExecSync.mock.calls as string[][])
      .map((args) => args[0])
      .find((cmd) => cmd?.includes("gh pr create"));
  }

  it("includes Closes #N in PR body when issue number is inferrable from branch", async () => {
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateTestsPass: no localPath → skip (no mock needed)
    // validateUnrelatedFiles: gh api compare → normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/10\n");

    const url = await createPRForBranch(orphan);

    expect(url).toBe("https://github.com/owner/repo/pull/10");
    expect(findPrCreateCall()).toContain("Closes #105");
  });

  it("returns null and skips PR creation when no issue ref can be matched", async () => {
    // findMatchingIssueNumber (Tier 2): gh issue list → empty
    mockExecSync.mockReturnValueOnce("[]");
    // validateIssueRef re-runs findMatchingIssueNumber: gh issue list → empty
    mockExecSync.mockReturnValueOnce("[]");
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: API fails → skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

    const genericOrphan: OrphanBranch = { ...orphan, branch: "feature-branch" };
    const result = await createPRForBranch(genericOrphan);

    // Pre-submit validator blocks the PR — no gh pr create should be called
    expect(result).toBeNull();
    expect(findPrCreateCall()).toBeUndefined();
  });

  it("includes Closes #N when fuzzy matching finds an issue", async () => {
    // findMatchingIssueNumber (Tier 2): gh issue list → returns a matching issue
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 77, title: "Auto-link orphan branch PRs" }]),
    );
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/15\n");

    const fuzzyOrphan: OrphanBranch = { ...orphan, branch: "auto-link-orphan-prs" };
    await createPRForBranch(fuzzyOrphan);

    expect(findPrCreateCall()).toContain("Closes #77");
  });

  it("returns null when no issue can be matched (pre-submit blocks PR)", async () => {
    // findMatchingIssueNumber: gh issue list → empty
    mockExecSync.mockReturnValueOnce("[]");
    // validateIssueRef re-runs findMatchingIssueNumber: gh issue list → throws
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("gh: not found");
    });

    const result = await createPRForBranch({ ...orphan, branch: "feature-branch" });
    expect(result).toBeNull();
  });

  it("includes the agent name and branch in the PR title", async () => {
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/12\n");

    await createPRForBranch(orphan);

    const prCreateCmd = findPrCreateCall();
    expect(prCreateCmd).toContain("[agent-a]");
    expect(prCreateCmd).toContain("issue-105-add-feature");
  });

  it("handles fix/issue-N branch format correctly", async () => {
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/20\n");

    const slashOrphan: OrphanBranch = { ...orphan, branch: "fix/issue-134-auto-link" };
    await createPRForBranch(slashOrphan);

    expect(findPrCreateCall()).toContain("Closes #134");
  });

  it("auto-fixes body with Closes #N when initial lookup fails but validateIssueRef infers the issue", async () => {
    // findMatchingIssueNumber (before validation): gh issue list → empty → null
    mockExecSync.mockReturnValueOnce("[]");
    // validateIssueRef internally calls findMatchingIssueNumber: gh issue list → issue 55
    mockExecSync.mockReturnValueOnce(JSON.stringify([{ number: 55, title: "Add new widget feature" }]));
    // validateBranchFreshness (first validation): 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists (first validation): no PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts (first validation): ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles (first validation): normal files
    mockExecSync.mockReturnValueOnce("src/widget.ts\n");
    // validateBranchFreshness (second validation after auto-fix): 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists (second validation): no PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts (second validation): ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles (second validation): normal files
    mockExecSync.mockReturnValueOnce("src/widget.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/30\n");

    const branchOrphan: OrphanBranch = { ...orphan, branch: "new-widget-feature" };
    const url = await createPRForBranch(branchOrphan);

    expect(url).toBe("https://github.com/owner/repo/pull/30");
    expect(findPrCreateCall()).toContain("Closes #55");
  });

  it("does not auto-fix when multiple blockers are present (not just missing issue ref)", async () => {
    // findMatchingIssueNumber: empty → null
    mockExecSync.mockReturnValueOnce("[]");
    // validateIssueRef → findMatchingIssueNumber: returns issue 55
    mockExecSync.mockReturnValueOnce(JSON.stringify([{ number: 55, title: "Add new widget feature" }]));
    // validateBranchFreshness: 3 commits behind (second blocker)
    mockExecSync.mockReturnValueOnce("3\n");
    // validatePRExists: no PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");

    const branchOrphan: OrphanBranch = { ...orphan, branch: "new-widget-feature" };
    const result = await createPRForBranch(branchOrphan);

    // Two blockers (issue ref + stale branch) → no auto-fix, PR skipped
    expect(result).toBeNull();
    expect(findPrCreateCall()).toBeUndefined();
  });

  it("logs validation result to task_logs when store has a matching task", async () => {
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/40\n");

    const mockStore = {
      findTaskByIssueRef: vi.fn().mockReturnValue({ id: "task-123" }),
      addLog: vi.fn(),
    };

    await createPRForBranch(orphan, undefined, mockStore as never);

    expect(mockStore.findTaskByIssueRef).toHaveBeenCalledWith("owner/repo", "105");
    expect(mockStore.addLog).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "task-123",
        direction: "system",
        agent_name: "agent-a",
        content: expect.stringContaining("pre-submit"),
      }),
    );
  });

  it("skips task_logs logging when store has no matching task", async () => {
    // validateBranchFreshness: gh api compare → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: gh pr list → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles: normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/41\n");

    const mockStore = {
      findTaskByIssueRef: vi.fn().mockReturnValue(undefined),
      addLog: vi.fn(),
    };

    const url = await createPRForBranch(orphan, undefined, mockStore as never);

    // PR should still be created even without a matching task
    expect(url).toBe("https://github.com/owner/repo/pull/41");
    expect(mockStore.addLog).not.toHaveBeenCalled();
  });

  it("uses local path from config for validation when agent dir is configured", async () => {
    const configWithDir = {
      agents: {
        "agent-a": {
          dir: "my-repo",
          github: "owner/repo",
        },
      },
      base_dir: "/tmp/repos",
      orchestrator_dir: "/tmp/orch",
      proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 30000 },
    } as never;

    // validateBranchFreshness: gh api compare → API fails, falls back to local git
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch (local fallback for freshness)
    mockExecSync.mockReturnValueOnce("");
    // git rev-list (local: 0 behind)
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists: no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts: gh api compare → ahead
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateTestsPass: test -f package.json (localPath provided)
    mockExecSync.mockReturnValueOnce("");
    // validateTestsPass: npx tsc --noEmit
    mockExecSync.mockReturnValueOnce("");
    // validateTestsPass: npx vitest run
    mockExecSync.mockReturnValueOnce("");
    // validateUnrelatedFiles: gh api compare → normal files
    mockExecSync.mockReturnValueOnce("src/feature.ts\n");
    // gh pr create
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/50\n");

    const url = await createPRForBranch(orphan, configWithDir);

    expect(url).toBe("https://github.com/owner/repo/pull/50");
    // Verify that git fetch was called (proves localPath was used as fallback)
    const gitFetchCall = (mockExecSync.mock.calls as Array<[string, unknown]>)
      .find(([cmd]) => typeof cmd === "string" && cmd.includes("git fetch"));
    expect(gitFetchCall).toBeDefined();
  });

  it("returns null immediately when gh auth pre-flight fails", async () => {
    vi.mocked(validateGhAuth).mockReturnValueOnce({
      ok: false,
      reason: "gh CLI is not authenticated. Run `gh auth login`.",
    });

    const result = await createPRForBranch(orphan);

    // Auth failure should bail out before any execSync calls (no gh or git calls)
    expect(result).toBeNull();
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

describe("createPRWithRetry", () => {
  const noDelay = async (_ms: number) => {};

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns PR URL on first attempt when gh pr create succeeds", async () => {
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/99\n");

    const url = await createPRWithRetry("gh pr create --repo owner/repo", noDelay);

    expect(url).toBe("https://github.com/owner/repo/pull/99");
    expect(mockExecSync).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on second attempt after transient failure", async () => {
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("connection reset"); })
      .mockReturnValueOnce("https://github.com/owner/repo/pull/99\n");

    const url = await createPRWithRetry("gh pr create --repo owner/repo", noDelay);

    expect(url).toBe("https://github.com/owner/repo/pull/99");
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it("retries up to PR_CREATE_MAX_RETRIES times and succeeds on last attempt", async () => {
    // Fail PR_CREATE_MAX_RETRIES times, succeed on the last allowed attempt
    for (let i = 0; i < PR_CREATE_MAX_RETRIES; i++) {
      mockExecSync.mockImplementationOnce(() => { throw new Error(`transient error ${i}`); });
    }
    mockExecSync.mockReturnValueOnce("https://github.com/owner/repo/pull/99\n");

    const url = await createPRWithRetry("gh pr create --repo owner/repo", noDelay);

    expect(url).toBe("https://github.com/owner/repo/pull/99");
    // 1 initial attempt + PR_CREATE_MAX_RETRIES retry attempts = PR_CREATE_MAX_RETRIES + 1 total
    expect(mockExecSync).toHaveBeenCalledTimes(PR_CREATE_MAX_RETRIES + 1);
  });

  it("throws the last error after all retries are exhausted", async () => {
    // Fail on every attempt (initial + all retries)
    for (let i = 0; i <= PR_CREATE_MAX_RETRIES; i++) {
      mockExecSync.mockImplementationOnce(() => { throw new Error(`gh: auth error (attempt ${i})`); });
    }

    await expect(
      createPRWithRetry("gh pr create --repo owner/repo", noDelay),
    ).rejects.toThrow("gh: auth error");

    expect(mockExecSync).toHaveBeenCalledTimes(PR_CREATE_MAX_RETRIES + 1);
  });

  it("calls delayFn between retry attempts with increasing delay", async () => {
    const delays: number[] = [];
    const recordDelay = async (ms: number) => { delays.push(ms); };

    mockExecSync
      .mockImplementationOnce(() => { throw new Error("fail 1"); })
      .mockImplementationOnce(() => { throw new Error("fail 2"); })
      .mockReturnValueOnce("https://github.com/owner/repo/pull/99\n");

    await createPRWithRetry("gh pr create --repo owner/repo", recordDelay);

    // delay is called once before attempt 1, once before attempt 2
    expect(delays).toHaveLength(2);
    // Delay increases with each attempt
    expect(delays[1]).toBeGreaterThan(delays[0]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findOrphanBranches — agentFilter parameter (post-dispatch orphan hook)
// ────────────────────────────────────────────────────────────────────────────

import { findOrphanBranches } from "./pr-creator.js";
import type { OrchestratorConfig } from "../config/schema.js";

describe("findOrphanBranches agentFilter", () => {
  const multiAgentConfig = {
    proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
    orchestrator_dir: "/tmp",
    base_dir: "/projects",
    agents: {
      "agent-a": {
        dir: "agent-a",
        description: "Agent A",
        capabilities: [],
        owns_topics: [],
        github: "owner/repo-a",
      },
      "agent-b": {
        dir: "agent-b",
        description: "Agent B",
        capabilities: [],
        owns_topics: [],
        github: "owner/repo-b",
      },
    },
  } as unknown as OrchestratorConfig;

  it("without agentFilter scans all agents with github repos", () => {
    // Both agents: gh pr list returns no PRs, gh api branches returns no branches
    mockExecSync.mockReturnValue("");

    const orphans = findOrphanBranches(multiAgentConfig);
    // Should have called execSync for both repos (at least the pr list + branches call each)
    const callArgs = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(callArgs.some((a: string) => a.includes("repo-a"))).toBe(true);
    expect(callArgs.some((a: string) => a.includes("repo-b"))).toBe(true);
    expect(orphans).toHaveLength(0);
  });

  it("with agentFilter only scans the specified agent's repo", () => {
    // agent-a: gh pr list returns no PRs, branches returns one branch ahead of main
    mockExecSync
      .mockReturnValueOnce("") // gh pr list for agent-a → no PRs
      .mockReturnValueOnce("issue-305-fix\n") // gh api branches for agent-a
      .mockReturnValueOnce("1\n"); // compare ahead_by = 1

    const orphans = findOrphanBranches(multiAgentConfig, "agent-a");

    // Should only have queried repo-a, not repo-b
    const callArgs = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(callArgs.some((a: string) => a.includes("repo-b"))).toBe(false);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({ repo: "owner/repo-a", branch: "issue-305-fix", agentName: "agent-a" });
  });

  it("with agentFilter returns empty array when specified agent has no github repo", () => {
    const configNoGitHub = {
      ...multiAgentConfig,
      agents: {
        "no-github-agent": {
          dir: "no-gh",
          description: "No GitHub",
          capabilities: [],
          owns_topics: [],
          // no github field
        },
      },
    } as unknown as OrchestratorConfig;

    const orphans = findOrphanBranches(configNoGitHub, "no-github-agent");
    expect(orphans).toHaveLength(0);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("with agentFilter skips agents not matching the filter even if they have orphan branches", () => {
    // Only setup mock for agent-a (agent-b should not be called)
    mockExecSync
      .mockReturnValueOnce("") // gh pr list for agent-a
      .mockReturnValueOnce(""); // gh api branches → empty

    const orphans = findOrphanBranches(multiAgentConfig, "agent-a");

    const callArgs = mockExecSync.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(callArgs.every((a: string) => !a.includes("repo-b"))).toBe(true);
    expect(orphans).toHaveLength(0);
  });
});
