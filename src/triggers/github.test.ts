import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchOpenIssues, findApprovedPRForIssue, findExistingPRsForIssue, isIssueOpen, validateGhAuth } from "./github.js";

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
    fetchOpenIssues("rapartlu/claude-proxy");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/claude-proxy/issues"),
      expect.any(Object),
    );
  });
});

describe("findExistingPRsForIssue", () => {
  // execSync is called twice: once for open PRs, once for merged PRs
  function mockPRCalls(
    openPRs: Array<{ number: number; title: string; url: string; isDraft: boolean; body: string | null }>,
    mergedPRs: Array<{ number: number; title: string; url: string; body: string | null }>,
  ): void {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(openPRs))
      .mockReturnValueOnce(JSON.stringify(mergedPRs));
  }

  it("returns empty array when no PRs reference the issue", () => {
    mockPRCalls(
      [{ number: 10, title: "Unrelated PR", url: "https://github.com/owner/repo/pull/10", isDraft: false, body: "This does something else" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("detects an open PR with 'Closes #N' in the body", () => {
    mockPRCalls(
      [{ number: 5, title: "Fix the bug", url: "https://github.com/owner/repo/pull/5", isDraft: false, body: "Closes #42\nFixed the issue." }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, state: "open", isDraft: false });
  });

  it("detects a draft PR with 'Closes #N' in the body", () => {
    mockPRCalls(
      [{ number: 7, title: "WIP fix", url: "https://github.com/owner/repo/pull/7", isDraft: true, body: "Work in progress\n\nCloses #42" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 7, state: "open", isDraft: true });
  });

  it("detects a merged PR with 'Fixes #N' in the body", () => {
    mockPRCalls(
      [],
      [{ number: 3, title: "Merged fix", url: "https://github.com/owner/repo/pull/3", body: "Fixes #42 by refactoring." }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 3, state: "merged", isDraft: false });
  });

  it("matches closing keywords case-insensitively", () => {
    const bodies = [
      "CLOSES #42",
      "Fixes #42",
      "RESOLVES #42",
      "closed #42",
      "fixed #42",
      "resolved #42",
    ];
    for (const body of bodies) {
      mockExecSync
        .mockReturnValueOnce(JSON.stringify([{ number: 1, title: "PR", url: "url", isDraft: false, body }]))
        .mockReturnValueOnce("[]");
      const prs = findExistingPRsForIssue("owner/repo", 42);
      expect(prs).toHaveLength(1);
    }
  });

  it("does NOT match a PR that only mentions the issue without a closing keyword", () => {
    mockPRCalls(
      [{ number: 8, title: "Related work", url: "url", isDraft: false, body: "See issue #42 for context. Does not close it." }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("does NOT match a different issue number (e.g. #420 vs #42)", () => {
    mockPRCalls(
      [{ number: 9, title: "Other fix", url: "url", isDraft: false, body: "Closes #420" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns both open and merged PRs when both exist", () => {
    mockPRCalls(
      [{ number: 5, title: "Open PR", url: "url1", isDraft: false, body: "Closes #42" }],
      [{ number: 3, title: "Merged PR", url: "url2", body: "Fixes #42" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(2);
    expect(prs.map((p) => p.state)).toContain("open");
    expect(prs.map((p) => p.state)).toContain("merged");
  });

  it("returns empty array when gh CLI fails (fail-open)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns empty array when gh output is empty", () => {
    mockExecSync.mockReturnValueOnce("").mockReturnValueOnce("");
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("queries the correct repo in gh API calls", () => {
    mockPRCalls([], []);
    findExistingPRsForIssue("rapartlu/my-agent", 99);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/my-agent/pulls"),
      expect.any(Object),
    );
  });

  it("handles null PR body gracefully", () => {
    mockPRCalls(
      [{ number: 11, title: "No body", url: "url", isDraft: false, body: null }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
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
