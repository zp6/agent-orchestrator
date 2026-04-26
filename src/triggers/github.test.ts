import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchOpenIssues, countOpenPRs, findApprovedPRForIssue, findExistingPRsForIssue, findOpenPRsViaSearch, isIssueOpen, validateGhAuth } from "./github.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

describe("isIssueOpen", () => {
  it("returns true when issue state is OPEN", () => {
    const mockExec = vi.fn().mockReturnValue("OPEN\n");
    expect(isIssueOpen("owner/repo", 42, mockExec)).toBe(true);
  });

  it("returns false when issue state is CLOSED", () => {
    const mockExec = vi.fn().mockReturnValue("CLOSED\n");
    expect(isIssueOpen("owner/repo", 42, mockExec)).toBe(false);
  });

  it("is case-insensitive (handles lowercase 'open')", () => {
    const mockExec = vi.fn().mockReturnValue("open");
    expect(isIssueOpen("owner/repo", 42, mockExec)).toBe(true);
  });

  it("returns true on gh CLI failure (fail-open)", () => {
    const mockExec = vi.fn().mockImplementation(() => { throw new Error("gh: not found"); });
    expect(isIssueOpen("owner/repo", 42, mockExec)).toBe(true);
  });

  it("calls gh with the correct repo and issue number", () => {
    const mockExec = vi.fn().mockReturnValue("OPEN");
    isIssueOpen("rapartlu/my-agent", 99, mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("gh issue view 99 --repo rapartlu/my-agent"),
      expect.any(Object),
    );
  });
});

describe("fetchOpenIssues", () => {
  it("parses GitHub issues from gh CLI output", () => {
    mockExecSync.mockReturnValue(JSON.stringify([
      { number: 1, title: "Bug fix", body: "Fix the bug", url: "https://github.com/owner/repo/issues/1", labels: ["bug"] },
      { number: 2, title: "Feature", body: null, url: "https://github.com/owner/repo/issues/2", labels: [] },
    ]));

    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      repo: "owner/repo",
      number: 1,
      title: "Bug fix",
      body: "Fix the bug",
      url: "https://github.com/owner/repo/issues/1",
      created_at: expect.any(String),
      labels: ["bug"],
    });
    expect(issues[1].body).toBe("");
  });

  it("returns empty array when no issues", () => {
    mockExecSync.mockReturnValue("[]");
    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(0);
  });

  it("handles empty output", () => {
    mockExecSync.mockReturnValue("");
    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(0);
  });

  it("throws on gh CLI failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    expect(() => fetchOpenIssues("owner/repo")).toThrow("Failed to fetch issues");
  });

  it("passes correct repo to gh CLI", () => {
    mockExecSync.mockReturnValue("[]");
    fetchOpenIssues("rapartlu/agent-proxy");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/agent-proxy/issues"),
      expect.any(Object),
    );
  });
});

describe("countOpenPRs", () => {
  it("returns the number of open PRs in the repo", () => {
    mockExecSync.mockReturnValue(JSON.stringify([{ number: 1 }, { number: 2 }, { number: 3 }]));

    expect(countOpenPRs("owner/repo")).toBe(3);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh pr list --repo owner/repo --state open --json number"),
      expect.any(Object),
    );
  });

  it("returns 0 when there are no open PRs", () => {
    mockExecSync.mockReturnValue("[]");
    expect(countOpenPRs("owner/repo")).toBe(0);
  });

  it("returns null when gh CLI fails (fail-open)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    expect(countOpenPRs("owner/repo")).toBeNull();
  });
});

describe("findOpenPRsViaSearch", () => {
  it("returns PRs from search results", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([{ number: 5, title: "Fix", url: "url", isDraft: false, headRefName: "fix-branch" }]),
    );
    const prs = findOpenPRsViaSearch("owner/repo", 42, mockExec);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, isDraft: false });
  });

  it("uses the correct repo and issue number in the gh pr list command", () => {
    const mockExec = vi.fn().mockReturnValue("[]");
    findOpenPRsViaSearch("rapartlu/agent-reviewer", 323, mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--repo rapartlu/agent-reviewer"),
      expect.any(Object),
    );
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("#323"),
      expect.any(Object),
    );
  });

  it("includes closes, fixes, and resolves keyword variants in the search query", () => {
    const mockExec = vi.fn().mockReturnValue("[]");
    findOpenPRsViaSearch("owner/repo", 42, mockExec);
    const [cmd] = mockExec.mock.calls[0] as [string, unknown];
    expect(cmd).toContain("closes #42");
    expect(cmd).toContain("fixes #42");
    expect(cmd).toContain("resolves #42");
  });

  it("searches only open PRs (--state open)", () => {
    const mockExec = vi.fn().mockReturnValue("[]");
    findOpenPRsViaSearch("owner/repo", 42, mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("--state open"),
      expect.any(Object),
    );
  });

  it("returns empty array on gh CLI error (fail-open)", () => {
    const mockExec = vi.fn().mockImplementation(() => { throw new Error("gh: not found"); });
    const prs = findOpenPRsViaSearch("owner/repo", 42, mockExec);
    expect(prs).toHaveLength(0);
  });

  it("returns empty array on empty gh output", () => {
    const mockExec = vi.fn().mockReturnValue("");
    const prs = findOpenPRsViaSearch("owner/repo", 42, mockExec);
    expect(prs).toHaveLength(0);
  });

  it("correctly reflects isDraft: true for draft PRs", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([{ number: 7, title: "WIP", url: "url", isDraft: true, headRefName: "wip" }]),
    );
    const prs = findOpenPRsViaSearch("owner/repo", 42, mockExec);
    expect(prs[0]).toMatchObject({ number: 7, isDraft: true });
  });
});

describe("findExistingPRsForIssue", () => {
  // execSync is called three times:
  //   1. findOpenPRsViaSearch — gh pr list --search (server-side keyword match)
  //   2. branch-name match   — gh api pulls?state=open&per_page=100
  //   3. merged PRs          — gh api pulls?state=closed&per_page=30
  type SearchPR = { number: number; title: string; url: string; isDraft: boolean; headRefName: string };
  type OpenPR   = { number: number; title: string; url: string; isDraft: boolean; body: string | null; headRefName?: string };
  type MergedPR = { number: number; title: string; url: string; body: string | null; headRefName?: string };

  function mockPRCalls(
    searchPRs: SearchPR[],
    openPRs: OpenPR[],
    mergedPRs: MergedPR[],
  ): void {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(searchPRs))   // call 1: gh pr list --search
      .mockReturnValueOnce(JSON.stringify(openPRs))     // call 2: gh api pulls?state=open
      .mockReturnValueOnce(JSON.stringify(mergedPRs));  // call 3: gh api pulls?state=closed
  }

  it("returns empty array when no PRs reference the issue", () => {
    mockPRCalls(
      [], // search finds nothing
      [{ number: 10, title: "Unrelated PR", url: "https://github.com/owner/repo/pull/10", isDraft: false, body: "This does something else", headRefName: "unrelated" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("detects an open PR via server-side search (keyword match, issue #967 fix)", () => {
    // Simulates a repo with >100 open PRs where the keyword-matched PR would
    // have been silently missed by the old per_page=100 paginated approach.
    mockPRCalls(
      [{ number: 5, title: "Fix the bug", url: "https://github.com/owner/repo/pull/5", isDraft: false, headRefName: "fix-something" }],
      [], // branch list is empty (PR is beyond page 1 in a large repo)
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, state: "open", isDraft: false });
  });

  it("detects a draft PR via server-side search", () => {
    mockPRCalls(
      [{ number: 7, title: "WIP fix", url: "https://github.com/owner/repo/pull/7", isDraft: true, headRefName: "wip-fix" }],
      [],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 7, state: "open", isDraft: true });
  });

  it("detects a merged PR with 'Fixes #N' in the body (client-side regex on closed list)", () => {
    mockPRCalls(
      [],
      [],
      [{ number: 3, title: "Merged fix", url: "https://github.com/owner/repo/pull/3", body: "Fixes #42 by refactoring.", headRefName: "merged-fix" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 3, state: "merged", isDraft: false });
  });

  it("merged PR keyword matching is still case-insensitive for the closed list", () => {
    const bodies = ["CLOSES #42", "Fixes #42", "RESOLVES #42", "closed #42", "fixed #42", "resolved #42"];
    for (const body of bodies) {
      mockExecSync
        .mockReturnValueOnce("[]")  // search
        .mockReturnValueOnce("[]")  // open list
        .mockReturnValueOnce(JSON.stringify([{ number: 1, title: "PR", url: "url", body, headRefName: "fix" }]));
      const prs = findExistingPRsForIssue("owner/repo", 42);
      expect(prs).toHaveLength(1);
    }
  });

  it("DOES match a PR with a matching branch name even without a closing keyword (fixes issue #959)", () => {
    // Search finds nothing (no keyword); branch-name match catches it from the open list.
    mockPRCalls(
      [],
      [{ number: 8, title: "Research findings", url: "url", isDraft: false, body: "Research findings from issue investigation.", headRefName: "42-research-findings" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 8, state: "open" });
  });

  it("matches branch patterns like 'issue-N-*'", () => {
    mockPRCalls(
      [],
      [{ number: 9, title: "Issue fix", url: "url", isDraft: false, body: "Some work.", headRefName: "issue-42-fix-something" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
  });

  it("matches branch patterns like 'issue_N_*'", () => {
    mockPRCalls(
      [],
      [{ number: 10, title: "Issue fix", url: "url", isDraft: false, body: "Some work.", headRefName: "issue_42_feature" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
  });

  it("deduplicates PRs found by both search and branch-name list", () => {
    // PR #5 appears in both search results and the open list.
    // It should appear only once in the output.
    mockPRCalls(
      [{ number: 5, title: "Fix", url: "url", isDraft: false, headRefName: "issue-42-fix" }],
      [{ number: 5, title: "Fix", url: "url", isDraft: false, body: "Closes #42", headRefName: "issue-42-fix" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, state: "open" });
  });

  it("does NOT match a PR that only mentions the issue without a closing keyword or matching branch", () => {
    mockPRCalls(
      [],
      [{ number: 8, title: "Related work", url: "url", isDraft: false, body: "See issue #42 for context. Does not close it.", headRefName: "unrelated-branch" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("does NOT match a different issue number (e.g. #420 vs #42)", () => {
    // Search is scoped to #42 and returns nothing. Branch "420-fix" does not match issue-42 pattern.
    mockPRCalls(
      [],
      [{ number: 9, title: "Other fix", url: "url", isDraft: false, body: "Closes #420", headRefName: "420-fix" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns both open (search) and merged PRs when both exist", () => {
    mockPRCalls(
      [{ number: 5, title: "Open PR", url: "url1", isDraft: false, headRefName: "fix-open" }],
      [],
      [{ number: 3, title: "Merged PR", url: "url2", body: "Fixes #42", headRefName: "fix-merged" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(2);
    expect(prs.map((p) => p.state)).toContain("open");
    expect(prs.map((p) => p.state)).toContain("merged");
  });

  it("returns empty array when gh CLI fails (fail-open)", () => {
    // findOpenPRsViaSearch catches its own error and returns [].
    // The subsequent execSync for branch list throws → outer catch → returns [].
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns empty array when gh output is empty", () => {
    mockExecSync
      .mockReturnValueOnce("")  // search
      .mockReturnValueOnce("")  // open list
      .mockReturnValueOnce(""); // merged
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("queries the correct repo in both gh pr list and gh api calls", () => {
    mockPRCalls([], [], []);
    findExistingPRsForIssue("rapartlu/my-agent", 99);
    // Search call must target the right repo
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("rapartlu/my-agent"),
      expect.any(Object),
    );
    // Branch-list call must target the right repo via gh api
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/my-agent/pulls"),
      expect.any(Object),
    );
  });

  it("handles null PR body gracefully for branch-name list", () => {
    mockPRCalls(
      [],
      [{ number: 11, title: "No body", url: "url", isDraft: false, body: null, headRefName: "unrelated-branch" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("detects PR with null body but matching branch name (via open list)", () => {
    mockPRCalls(
      [],
      [{ number: 12, title: "No body but matching branch", url: "url", isDraft: false, body: null, headRefName: "42-feature" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 12, state: "open" });
  });

  it("falls back to branch-name matching when search fails", () => {
    // First call (search via findOpenPRsViaSearch) throws — caught internally, returns [].
    // Second call (open list) succeeds and finds a branch-matched PR.
    mockExecSync
      .mockImplementationOnce(() => { throw new Error("search failed"); }) // search fails
      .mockReturnValueOnce(JSON.stringify([{ number: 8, title: "Branch match", url: "url", isDraft: false, body: null, headRefName: "42-some-work" }]))
      .mockReturnValueOnce("[]"); // merged
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 8, state: "open" });
  });

  it("detects a cross-variant PR with 'Closes #N' in body but non-standard branch (search index lag simulation, issue #1174)", () => {
    // Simulates a sibling agent (e.g. codex variant) that opened a PR with
    // "Closes #42" in the body but used a non-standard branch name like
    // "triage-pass-12-apr-25". The server-side search index has not yet
    // indexed it (minutes of lag), so searchPRs is empty. The paginated
    // open-PR list returns the PR with the body keyword — the body-matching
    // fallback must catch it to prevent a duplicate dispatch.
    mockPRCalls(
      [], // search index hasn't indexed the new PR yet (lag)
      [{ number: 13, title: "Cross-variant fix", url: "url", isDraft: false, body: "Closes #42", headRefName: "triage-pass-12-apr-25" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 13, state: "open" });
  });

  it("does not false-positive on 'Closes #42' body in a PR already found via search (no duplicate)", () => {
    // PR #5 appears in both the search results and the open list with a
    // matching body. The dedup by PR number must prevent it being counted twice.
    mockPRCalls(
      [{ number: 5, title: "Fix", url: "url", isDraft: false, headRefName: "fix-something" }],
      [{ number: 5, title: "Fix", url: "url", isDraft: false, body: "Closes #42", headRefName: "fix-something" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1); // deduplicated — not counted twice
    expect(prs[0]).toMatchObject({ number: 5, state: "open" });
  });

  // ── detectionStrategy tagging (issue #1179) ─────────────────────────────

  it("tags PRs found via search with detectionStrategy: search_index", () => {
    mockPRCalls(
      [{ number: 50, title: "Search hit", url: "url", isDraft: false, headRefName: "issue-42-fix" }],
      [],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].detectionStrategy).toBe("search_index");
  });

  it("tags PRs found via branch-name pattern with detectionStrategy: branch_name", () => {
    mockPRCalls(
      [], // search index empty
      [{ number: 51, title: "Branch match", url: "url", isDraft: false, body: null, headRefName: "issue-42-feature" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].detectionStrategy).toBe("branch_name");
  });

  it("tags PRs found via body keyword (non-standard branch) with detectionStrategy: body_keyword", () => {
    mockPRCalls(
      [], // search index not yet updated
      [{ number: 52, title: "Cross-variant", url: "url", isDraft: false, body: "Closes #42", headRefName: "triage-unrelated-branch" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].detectionStrategy).toBe("body_keyword");
  });

  it("prefers branch_name over body_keyword when both match for the same open PR", () => {
    mockPRCalls(
      [],
      [{ number: 53, title: "Both match", url: "url", isDraft: false, body: "Closes #42", headRefName: "issue-42-dual" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].detectionStrategy).toBe("branch_name"); // branch_name takes precedence
  });

  it("tags merged PRs found via body keyword with detectionStrategy: body_keyword", () => {
    mockPRCalls(
      [],
      [],
      [{ number: 54, title: "Merged via body", url: "url", body: "Closes #42", headRefName: "unrelated-branch" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].state).toBe("merged");
    expect(prs[0].detectionStrategy).toBe("body_keyword");
  });

  it("tags merged PRs found only via branch name with detectionStrategy: branch_name", () => {
    mockPRCalls(
      [],
      [],
      [{ number: 55, title: "Merged via branch", url: "url", body: "No closing keyword", headRefName: "issue-42-merged" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0].state).toBe("merged");
    expect(prs[0].detectionStrategy).toBe("branch_name");
  });
});

describe("validateGhAuth", () => {
  const originalToken = process.env["GH_TOKEN"];

  beforeEach(() => {
    // Start each test with no GH_TOKEN so the exec path is exercised by default
    delete process.env["GH_TOKEN"];
  });

  afterEach(() => {
    // Restore original env
    if (originalToken !== undefined) {
      process.env["GH_TOKEN"] = originalToken;
    } else {
      delete process.env["GH_TOKEN"];
    }
  });

  it("returns ok=true when GH_TOKEN is set and non-empty", () => {
    process.env["GH_TOKEN"] = "ghp_testtoken123";
    const mockExec = vi.fn();
    const result = validateGhAuth(mockExec);
    expect(result.ok).toBe(true);
    // Should not even call execSync when the env var is present
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("returns ok=true when gh auth status succeeds", () => {
    const mockExec = vi.fn().mockReturnValue("github.com\n  Logged in to github.com\n");
    const result = validateGhAuth(mockExec);
    expect(result.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith("gh auth status", expect.any(Object));
  });

  it("returns ok=false with a clear reason when gh auth status fails", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("You are not logged into any GitHub hosts.");
    });
    const result = validateGhAuth(mockExec);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("gh CLI is not authenticated");
    expect(result.reason).toContain("gh auth login");
  });

  it("returns ok=false when GH_TOKEN is set to an empty string", () => {
    process.env["GH_TOKEN"] = "";
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("You are not logged into any GitHub hosts.");
    });
    const result = validateGhAuth(mockExec);
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when GH_TOKEN is set to whitespace only", () => {
    process.env["GH_TOKEN"] = "   ";
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not authenticated");
    });
    const result = validateGhAuth(mockExec);
    expect(result.ok).toBe(false);
  });

  it("includes a hint about GH_TOKEN or gh auth login in the reason", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("not authenticated");
    });
    const result = validateGhAuth(mockExec);
    expect(result.reason).toMatch(/GH_TOKEN|gh auth login/);
  });
});

// ---------------------------------------------------------------------------
// findBranchForIssue
// ---------------------------------------------------------------------------

import { findBranchForIssue } from "./github.js";

// ---------------------------------------------------------------------------
// findApprovedPRForIssue
// ---------------------------------------------------------------------------

describe("findApprovedPRForIssue", () => {
  function makePR(overrides: {
    number?: number;
    headRefName?: string;
    reviewDecision?: string | null;
    mergeStateStatus?: string;
  }) {
    return {
      number: 10,
      headRefName: "issue-381-fix",
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      ...overrides,
    };
  }

  it("returns PR details when an open PR is approved and clean", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ number: 10, headRefName: "issue-381-skip-dispatch" })]),
    );
    const result = findApprovedPRForIssue("owner/repo", 381, mockExec);
    expect(result).toEqual({ number: 10, headRefName: "issue-381-skip-dispatch" });
  });

  it("returns null when reviewDecision is not APPROVED", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null when reviewDecision is null (no review yet)", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ reviewDecision: null, mergeStateStatus: "CLEAN" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null when mergeStateStatus is CONFLICTING", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ reviewDecision: "APPROVED", mergeStateStatus: "CONFLICTING" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null when mergeStateStatus is BLOCKED", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null when branch does not match the issue number", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ headRefName: "issue-999-other", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("matches branch pattern N-description (leading number)", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ number: 5, headRefName: "381-fix-dispatch" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toEqual({
      number: 5,
      headRefName: "381-fix-dispatch",
    });
  });

  it("matches branch pattern fix/issue-N-description", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ number: 7, headRefName: "fix/issue-381-something" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toEqual({
      number: 7,
      headRefName: "fix/issue-381-something",
    });
  });

  it("does NOT match issue-3810 for issue 381 (no false positives)", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ headRefName: "issue-3810-something" })]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null when there are no open PRs", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([]));
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null on gh CLI failure (fail-open)", () => {
    const mockExec = vi.fn().mockImplementation(() => { throw new Error("network error"); });
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("returns null on empty output (fail-open)", () => {
    const mockExec = vi.fn().mockReturnValue("");
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toBeNull();
  });

  it("calls gh with the correct repo", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([]));
    findApprovedPRForIssue("rapartlu/my-agent", 381, mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("rapartlu/my-agent"),
      expect.any(Object),
    );
  });

  it("uses gh pr list with open state and correct JSON fields", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([]));
    findApprovedPRForIssue("owner/repo", 42, mockExec);
    const cmd = (mockExec as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(cmd).toContain("--state open");
    expect(cmd).toContain("reviewDecision");
    expect(cmd).toContain("mergeStateStatus");
  });

  it("skips non-matching PRs and returns the approved+clean one", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([
        makePR({ number: 1, headRefName: "issue-999-other", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }),
        makePR({ number: 2, headRefName: "issue-381-fix", reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "CLEAN" }),
        makePR({ number: 3, headRefName: "issue-381-fix-v2", reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }),
      ]),
    );
    expect(findApprovedPRForIssue("owner/repo", 381, mockExec)).toEqual({
      number: 3,
      headRefName: "issue-381-fix-v2",
    });
  });
});

describe("findBranchForIssue", () => {
  it("returns matching branch for issue-N-description pattern", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify(["main", "issue-352-pre-dispatch-check", "feature-branch"]),
    );
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBe("issue-352-pre-dispatch-check");
  });

  it("returns matching branch for fix/issue-N-description pattern", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify(["main", "fix/issue-352-something"]),
    );
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBe("fix/issue-352-something");
  });

  it("returns matching branch for N-description pattern (leading number)", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify(["main", "352-my-feature"]),
    );
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBe("352-my-feature");
  });

  it("returns null when no matching branch exists", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify(["main", "feature-unrelated", "fix-something-else"]),
    );
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBeNull();
  });

  it("does not match a different issue number (e.g. 3520 does not match 352)", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify(["main", "issue-3520-other"]),
    );
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBeNull();
  });

  it("returns null on gh CLI failure (fail-open)", () => {
    const mockExec = vi.fn().mockImplementation(() => { throw new Error("API error"); });
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBeNull();
  });

  it("returns null when branches list is empty", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([]));
    expect(findBranchForIssue("owner/repo", 352, mockExec)).toBeNull();
  });

  it("uses the correct repo in the gh api call", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([]));
    findBranchForIssue("rapartlu/my-agent", 99, mockExec);
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining("rapartlu/my-agent"),
      expect.anything(),
    );
  });
});
