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

  it("writes all issue refs from the PR body to the bulk cooldown API", async () => {
    const coveragePRs: OpenPRSummary[] = [
      {
        number: 1592,
        headRefName: "issue-1531-coverage-map",
        url: "https://github.com/owner/repo/pull/1592",
        body: "Implements the shared fix.\n\nCloses #1531\nCloses #1532\nFixes #1533\nResolves #1586\nCloses #1588",
      },
    ];
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      setPRGuardCooldowns: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      1531,
      coveragePRs,
      { cooldownStore },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
    expect(result.reason).toContain("PR #1592 covers 5 issues");
    expect(result.reason).toContain("#1531");
    expect(result.reason).toContain("#1588");
    expect(cooldownStore.setPRGuardCooldowns).toHaveBeenCalledOnce();
    expect(cooldownStore.setPRGuardCooldowns).toHaveBeenCalledWith(
      "owner/repo",
      [1531, 1532, 1533, 1586, 1588],
      60,
    );
    expect(cooldownStore.setPRGuardCooldown).not.toHaveBeenCalled();
  });

  it("falls back to per-issue cooldown writes when the bulk API is unavailable", async () => {
    const coveragePRs: OpenPRSummary[] = [
      {
        number: 1592,
        headRefName: "issue-1531-coverage-map",
        url: "https://github.com/owner/repo/pull/1592",
        body: "Implements the shared fix.\n\nCloses #1531\nCloses #1532\nCloses #1533",
      },
    ];
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      1531,
      coveragePRs,
      { cooldownStore },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenCalledTimes(3);
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenNthCalledWith(1, "owner/repo", 1531, 60);
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenNthCalledWith(2, "owner/repo", 1532, 60);
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenNthCalledWith(3, "owner/repo", 1533, 60);
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

// ── onShortCircuit callback (issue #255) ──────────────────────────────────────

describe("checkPRExistenceBeforeDispatch — onShortCircuit callback", () => {
  it("invokes onShortCircuit with 'no_action_needed' when PR found and taskId provided", async () => {
    const onShortCircuit = vi.fn();

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { taskId: "task-42", onShortCircuit },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
    expect(onShortCircuit).toHaveBeenCalledOnce();
    expect(onShortCircuit).toHaveBeenCalledWith(
      "task-42",
      "no_action_needed",
      expect.stringContaining("#42"),
    );
  });

  it("does NOT invoke onShortCircuit when no PR found", async () => {
    const onShortCircuit = vi.fn();

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      999,
      mockPRs,
      { taskId: "task-999", onShortCircuit },
    );

    expect(result.skip).toBe(false);
    expect(onShortCircuit).not.toHaveBeenCalled();
  });

  it("does NOT invoke onShortCircuit when taskId is missing", async () => {
    const onShortCircuit = vi.fn();

    await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { onShortCircuit }, // no taskId
    );

    expect(onShortCircuit).not.toHaveBeenCalled();
  });

  it("still returns correct result if onShortCircuit throws", async () => {
    const onShortCircuit = vi.fn().mockImplementationOnce(() => {
      throw new Error("scoring failure");
    });

    // Should not throw — scoring errors must be swallowed
    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { taskId: "task-err", onShortCircuit },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
  });

  it("works without opts — backward-compatible", async () => {
    // Calling without opts must not throw
    const result = await checkPRExistenceBeforeDispatch("owner/repo", 42, mockPRs);
    expect(result.skip).toBe(true);
  });
});

// ── cooldownStore (issue #390) ────────────────────────────────────────────────

describe("checkPRExistenceBeforeDispatch — cooldownStore (issue #390)", () => {
  it("calls setPRGuardCooldown when already-in-review and cooldownStore provided", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { cooldownStore },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenCalledOnce();
    expect(cooldownStore.setPRGuardCooldown).toHaveBeenCalledWith("owner/repo", 42, 60);
  });

  it("respects custom cooldownTtlMinutes", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { cooldownStore, cooldownTtlMinutes: 120 },
    );

    expect(cooldownStore.setPRGuardCooldown).toHaveBeenCalledWith("owner/repo", 42, 120);
  });

  it("does NOT call setPRGuardCooldown when no PR found (no-existing-pr)", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      999,
      mockPRs,
      { cooldownStore },
    );

    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("no-existing-pr");
    expect(cooldownStore.setPRGuardCooldown).not.toHaveBeenCalled();
  });

  it("still returns already-in-review if setPRGuardCooldown throws (fail-open)", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn().mockImplementationOnce(() => {
        throw new Error("db write failure");
      }),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { cooldownStore },
    );

    // Guard decision must not be affected by a cooldown write failure
    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
  });

  it("works without cooldownStore — backward-compatible", async () => {
    // No cooldownStore in opts — must not throw
    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { taskId: "task-42" }, // opts present but no cooldownStore
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-review");
  });
});

// ── Cooldown enforcement — early skip (issue #441) ────────────────────────────
//
// When isPRGuardCooldownActive() returns true, checkPRExistenceBeforeDispatch
// must return skip=true / cooldown-active BEFORE making any gh CLI call.
// This eliminates redundant tasks for issues already under the 60-min cooldown.

describe("checkPRExistenceBeforeDispatch — cooldown enforcement (issue #441)", () => {
  it("returns skip=true with 'cooldown-active' when cooldown is active", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();

    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      undefined, // no cache — would require gh CLI call if cooldown not respected
      { cooldownStore },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("cooldown-active");
    expect(result.prNumber).toBeNull();
    expect(result.prUrl).toBeNull();
    expect(result.reason).toContain("#42");
    expect(result.reason).toContain("cooldown");
  });

  it("does NOT call gh CLI (fetchOpenPRs) when cooldown is active", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();

    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    await checkPRExistenceBeforeDispatch("owner/repo", 42, undefined, { cooldownStore });

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("does NOT call gh CLI (execSync) when cooldown is active, even with no cache", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();

    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    // Pass neither a prListCache nor a stub — if the guard calls gh, execSync would throw
    await checkPRExistenceBeforeDispatch("rapartlu/agent-reviewer", 364, undefined, {
      cooldownStore,
    });

    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("invokes onShortCircuit for cooldown-active hits when taskId is provided", async () => {
    const onShortCircuit = vi.fn();
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      undefined,
      { cooldownStore, taskId: "task-cooldown", onShortCircuit },
    );

    expect(result.resolution).toBe("cooldown-active");
    expect(onShortCircuit).toHaveBeenCalledOnce();
    expect(onShortCircuit).toHaveBeenCalledWith(
      "task-cooldown",
      "no_action_needed",
      expect.stringContaining("cooldown"),
    );
  });

  it("swallows onShortCircuit throw for cooldown-active (guard must not block)", async () => {
    const onShortCircuit = vi.fn().mockImplementationOnce(() => {
      throw new Error("scoring failure");
    });
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    // Must not throw even if scoring callback throws
    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      undefined,
      { cooldownStore, taskId: "task-err", onShortCircuit },
    );

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("cooldown-active");
  });

  it("proceeds normally when cooldown is NOT active", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(false),
    };

    // Cache provided so no actual gh call needed; cooldown inactive → goes through normal path
    const result = await checkPRExistenceBeforeDispatch(
      "owner/repo",
      42,
      mockPRs,
      { cooldownStore },
    );

    expect(result.resolution).toBe("already-in-review");
    expect(result.prNumber).toBe(201);
  });

  it("proceeds normally (no cooldown check) when cooldownStore is not provided", async () => {
    // No cooldownStore — should fall through to cache-based check
    const result = await checkPRExistenceBeforeDispatch("owner/repo", 42, mockPRs);

    expect(result.resolution).toBe("already-in-review");
    expect(result.prNumber).toBe(201);
  });

  it("does NOT write setPRGuardCooldown for cooldown-active hits (already written)", async () => {
    const cooldownStore = {
      setPRGuardCooldown: vi.fn(),
      isPRGuardCooldownActive: vi.fn().mockReturnValue(true),
    };

    await checkPRExistenceBeforeDispatch("owner/repo", 42, undefined, { cooldownStore });

    // The cooldown was already written on the previous cycle — no need to refresh
    expect(cooldownStore.setPRGuardCooldown).not.toHaveBeenCalled();
  });
});

// ── formatPRCheckResult — cooldown-active (issue #441) ───────────────────────

describe("formatPRCheckResult — cooldown-active resolution", () => {
  it("formats 'cooldown-active' as 'cooldown-active'", () => {
    const result = formatPRCheckResult({
      skip: true,
      resolution: "cooldown-active",
      prNumber: null,
      prUrl: null,
      reason: "cooldown active",
    });
    expect(result).toBe("cooldown-active");
  });
});
