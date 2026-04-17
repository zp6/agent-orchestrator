/**
 * Tests for pr-existence-guard (issue #178)
 *
 * Verifies that `checkPRExistenceBeforeDispatch` correctly identifies open PRs
 * that match a given issue number and returns the appropriate skip/proceed
 * decision.
 */

import { execSync } from "child_process";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkPRExistenceBeforeDispatch,
  findMatchingPR,
  looksLikeGitHubIssueTask,
  extractIssueNumberFromSourceRef,
  extractRepoFromSourceRef,
  formatPRCheckResult,
  fetchOpenPRs,
  type OpenPRSummary,
} from "../reviewer/pr-existence-guard.js";

// Mock child_process so gh CLI calls never execute in tests
vi.mock("child_process");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const mockPRs: OpenPRSummary[] = [
  {
    number: 201,
    headRefName: "issue-42-add-feature-x",
    url: "https://github.com/owner/repo/pull/201",
    body: "Implements the feature.\n\nCloses #42",
  },
  {
    number: 202,
    headRefName: "fix/unrelated-bugfix",
    url: "https://github.com/owner/repo/pull/202",
    body: "Fixes a totally unrelated bug.",
  },
  {
    number: 203,
    headRefName: "feat/another-thing",
    url: "https://github.com/owner/repo/pull/203",
    body: "This resolves #99 as a side effect.",
  },
  {
    number: 204,
    headRefName: "issue-55_underscore-variant",
    url: "https://github.com/owner/repo/pull/204",
    body: "No close reference here.",
  },
];

// ── findMatchingPR ────────────────────────────────────────────────────────────

describe("findMatchingPR", () => {
  it("matches by branch name prefix issue-{N}-", () => {
    const match = findMatchingPR(mockPRs, 42);
    expect(match).not.toBeNull();
    expect(match!.number).toBe(201);
  });

  it("matches by branch name prefix issue-{N}_ (underscore variant)", () => {
    const match = findMatchingPR(mockPRs, 55);
    expect(match).not.toBeNull();
    expect(match!.number).toBe(204);
  });

  it("matches by Closes keyword in PR body", () => {
    // PR 201 closes #42, PR 203 resolves #99
    const match = findMatchingPR(mockPRs, 99);
    expect(match).not.toBeNull();
    expect(match!.number).toBe(203);
  });

  it("returns null when no PR matches", () => {
    const match = findMatchingPR(mockPRs, 999);
    expect(match).toBeNull();
  });

  it("returns null for empty PR list", () => {
    const match = findMatchingPR([], 42);
    expect(match).toBeNull();
  });

  it("is case-insensitive for branch names", () => {
    const prs: OpenPRSummary[] = [
      { number: 301, headRefName: "ISSUE-77-uppercase", url: "https://example.com", body: "" },
    ];
    const match = findMatchingPR(prs, 77);
    expect(match).not.toBeNull();
    expect(match!.number).toBe(301);
  });

  it("is case-insensitive for close keywords", () => {
    const prs: OpenPRSummary[] = [
      { number: 302, headRefName: "some-branch", url: "https://example.com", body: "FIXES #88" },
    ];
    const match = findMatchingPR(prs, 88);
    expect(match).not.toBeNull();
  });

  it("matches 'fixes' and 'resolves' keywords in addition to 'closes'", () => {
    const prs: OpenPRSummary[] = [
      { number: 303, headRefName: "a", url: "https://example.com", body: "fixes #10" },
      { number: 304, headRefName: "b", url: "https://example.com", body: "resolves #20" },
      { number: 305, headRefName: "c", url: "https://example.com", body: "closes #30" },
    ];
    expect(findMatchingPR(prs, 10)?.number).toBe(303);
    expect(findMatchingPR(prs, 20)?.number).toBe(304);
    expect(findMatchingPR(prs, 30)?.number).toBe(305);
  });

  it("does not partially match issue numbers (e.g., #4 vs #42)", () => {
    const prs: OpenPRSummary[] = [
      { number: 306, headRefName: "issue-4-something", url: "https://example.com", body: "" },
    ];
    // Should NOT match issue 42 when branch is issue-4-something
    const match = findMatchingPR(prs, 42);
    expect(match).toBeNull();
  });

  it("does not partially match close references (e.g., closes #4 vs issue 42)", () => {
    const prs: OpenPRSummary[] = [
      { number: 307, headRefName: "some-branch", url: "https://example.com", body: "closes #4" },
    ];
    const match = findMatchingPR(prs, 42);
    expect(match).toBeNull();
  });
});

// ── checkPRExistenceBeforeDispatch ────────────────────────────────────────────

describe("checkPRExistenceBeforeDispatch", () => {
  it("returns skip=true with 'already-in-review' when a matching PR exists", async () => {
    const result = await checkPRExistenceBeforeDispatch("owner/repo", 42, mockPRs);
    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
    expect(result.prNumber).toBe(201);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/201");
    expect(result.reason).toContain("#42");
    expect(result.reason).toContain("201");
  });

  it("returns skip=false with 'no-existing-pr' when no PR matches", async () => {
    const result = await checkPRExistenceBeforeDispatch("owner/repo", 999, mockPRs);
    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("no-existing-pr");
    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBeNull();
  });

  it("returns skip=false with 'check-failed' when fetchOpenPRs throws", async () => {
    // Make execSync throw to simulate gh CLI failure (no cache passed)
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("gh CLI error");
    });

    const result = await checkPRExistenceBeforeDispatch("owner/repo", 42);
    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("check-failed");
    expect(result.reason).toContain("Guard error");
  });

  it("uses provided cache to avoid extra gh CLI calls", async () => {
    // Reset the mock so we can verify it was NOT called
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();

    // With cache provided, execSync (gh CLI) should not be called
    const result = await checkPRExistenceBeforeDispatch("owner/repo", 99, mockPRs);
    expect(result.skip).toBe(true);
    expect(result.prNumber).toBe(203);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ── looksLikeGitHubIssueTask ──────────────────────────────────────────────────

describe("looksLikeGitHubIssueTask", () => {
  it("returns true for github-issue: source refs", () => {
    expect(looksLikeGitHubIssueTask("github-issue:owner/repo#42")).toBe(true);
  });

  it("returns false for standup: source refs", () => {
    expect(looksLikeGitHubIssueTask("standup:703")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(looksLikeGitHubIssueTask(null)).toBe(false);
    expect(looksLikeGitHubIssueTask(undefined)).toBe(false);
    expect(looksLikeGitHubIssueTask("")).toBe(false);
  });

  it("returns false for bare issue refs", () => {
    expect(looksLikeGitHubIssueTask("#42")).toBe(false);
  });
});

// ── extractIssueNumberFromSourceRef ──────────────────────────────────────────

describe("extractIssueNumberFromSourceRef", () => {
  it("extracts from github-issue:owner/repo#42 format", () => {
    expect(extractIssueNumberFromSourceRef("github-issue:owner/repo#42")).toBe(42);
  });

  it("extracts from bare #42 format", () => {
    expect(extractIssueNumberFromSourceRef("#42")).toBe(42);
  });

  it("returns null for standup: format", () => {
    expect(extractIssueNumberFromSourceRef("standup:703")).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(extractIssueNumberFromSourceRef(null)).toBeNull();
    expect(extractIssueNumberFromSourceRef(undefined)).toBeNull();
  });

  it("handles multi-digit issue numbers", () => {
    expect(extractIssueNumberFromSourceRef("github-issue:org/my-repo#1234")).toBe(1234);
  });
});

// ── extractRepoFromSourceRef ──────────────────────────────────────────────────

describe("extractRepoFromSourceRef", () => {
  it("extracts repo slug from github-issue format", () => {
    expect(extractRepoFromSourceRef("github-issue:owner/repo#42")).toBe("owner/repo");
  });

  it("returns null for non-github source refs", () => {
    expect(extractRepoFromSourceRef("standup:42")).toBeNull();
    expect(extractRepoFromSourceRef("#42")).toBeNull();
    expect(extractRepoFromSourceRef(null)).toBeNull();
  });
});

// ── formatPRCheckResult ───────────────────────────────────────────────────────

describe("formatPRCheckResult", () => {
  it("formats 'already-in-review' as 'open PR #N'", () => {
    const result = formatPRCheckResult({
      skip: true,
      resolution: "already-in-review",
      prNumber: 201,
      prUrl: "https://example.com",
      reason: "...",
    });
    expect(result).toBe("open PR #201");
  });

  it("formats 'no-existing-pr' as 'none'", () => {
    const result = formatPRCheckResult({
      skip: false,
      resolution: "no-existing-pr",
      prNumber: null,
      prUrl: null,
      reason: "...",
    });
    expect(result).toBe("none");
  });

  it("formats 'check-failed' as 'check-failed'", () => {
    const result = formatPRCheckResult({
      skip: false,
      resolution: "check-failed",
      prNumber: null,
      prUrl: null,
      reason: "...",
    });
    expect(result).toBe("check-failed");
  });
});
