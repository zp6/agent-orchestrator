import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMergeStall,
  scanFleetMergeStalls,
  mergePR,
  autoMergeFleetPRs,
  selectMergeCandidates,
  setMergeStallThresholdHours,
  getMergeStallThresholdHours,
  DEFAULT_MERGE_STALL_THRESHOLD_HOURS,
  type MergeablePR,
} from "./merge-stall-guard.js";

vi.mock("../service/logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600 * 1000).toISOString();
}

function makePR(overrides: Record<string, unknown> = {}) {
  return {
    number: 123,
    title: "fix: some improvement",
    url: "https://github.com/owner/repo/pull/123",
    updatedAt: hoursAgo(6),
    headRefName: "issue-123-fix",
    isDraft: false,
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ conclusion: "SUCCESS", state: "COMPLETED" }],
    author: { login: "rapartlu" },
    commits: [{ committedDate: hoursAgo(6) }],
    ...overrides,
  };
}

describe("getMergeStallThresholdHours", () => {
  beforeEach(() => {
    setMergeStallThresholdHours(undefined);
  });

  it("returns default when no override set", () => {
    expect(getMergeStallThresholdHours()).toBe(DEFAULT_MERGE_STALL_THRESHOLD_HOURS);
  });

  it("returns configured value when set", () => {
    setMergeStallThresholdHours(8);
    expect(getMergeStallThresholdHours()).toBe(8);
  });
});

describe("checkMergeStall", () => {
  beforeEach(() => {
    setMergeStallThresholdHours(undefined);
  });

  it("returns blocked when agent has a stale MERGEABLE PR", async () => {
    const mockExec = vi.fn().mockResolvedValue(JSON.stringify([makePR()]));
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(true);
    expect(result.stalePRs).toHaveLength(1);
    expect(result.stalePRs[0].number).toBe(123);
    expect(result.reason).toContain("stale MERGEABLE PR");
  });

  it("returns not blocked when PR has a recent commit", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ commits: [{ committedDate: hoursAgo(1) }] })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips draft PRs", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ isDraft: true })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with failing CI", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([
        makePR({
          statusCheckRollup: [{ conclusion: "FAILURE", state: "COMPLETED" }],
        }),
      ]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with no status checks", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ statusCheckRollup: [] })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with null status checks", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ statusCheckRollup: null })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("fails open on GitHub API error", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("gh CLI timeout"));
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("gh CLI timeout");
  });

  it("respects custom threshold", async () => {
    setMergeStallThresholdHours(12);

    // PR last committed 6h ago — within 12h threshold, should not block
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ commits: [{ committedDate: hoursAgo(6) }] })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("detects multiple stale PRs", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([
        makePR({ number: 100, commits: [{ committedDate: hoursAgo(10) }] }),
        makePR({ number: 101, commits: [{ committedDate: hoursAgo(20) }] }),
        makePR({ number: 102, commits: [{ committedDate: hoursAgo(1) }] }), // fresh — not stale
      ]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(true);
    expect(result.stalePRs).toHaveLength(2);
    expect(result.stalePRs.map((pr) => pr.number)).toContain(100);
    expect(result.stalePRs.map((pr) => pr.number)).toContain(101);
  });

  it("skips PRs with no commits (defensive)", async () => {
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([makePR({ commits: [] })]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("regression: detects stale PR despite recent metadata churn (updatedAt != lastCommitDate)", async () => {
    // PR was created over 24h ago, last committed 8h ago (stale by 4h threshold),
    // but updatedAt is only 30min ago due to CI re-run / daemon label change.
    // The old updatedAt-based check would have incorrectly skipped this PR.
    const mockExec = vi.fn().mockResolvedValue(
      JSON.stringify([
        makePR({
          updatedAt: hoursAgo(0.5), // very recent metadata update — would have hidden staleness
          commits: [{ committedDate: hoursAgo(8) }], // actual code activity is 8h old
        }),
      ]),
    );
    const result = await checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(true);
    expect(result.stalePRs).toHaveLength(1);
    expect(result.stalePRs[0].lastCommitDate).toBeDefined();
    expect(result.stalePRs[0].staleHours).toBeGreaterThanOrEqual(7.9);
  });
});

describe("scanFleetMergeStalls", () => {
  beforeEach(() => {
    setMergeStallThresholdHours(undefined);
  });

  it("aggregates stale PRs across repos sorted by stale hours descending", async () => {
    const mockExec = vi.fn().mockImplementation(async (cmd: string) => {
      if (cmd.includes("repo-a")) {
        return JSON.stringify([makePR({ number: 1, commits: [{ committedDate: hoursAgo(5) }] })]);
      }
      if (cmd.includes("repo-b")) {
        return JSON.stringify([makePR({ number: 2, commits: [{ committedDate: hoursAgo(48) }] })]);
      }
      return "[]";
    });

    const result = await scanFleetMergeStalls(["owner/repo-a", "owner/repo-b"], mockExec);

    expect(result).toHaveLength(2);
    // Most stale first
    expect(result[0].number).toBe(2);
    expect(result[1].number).toBe(1);
  });

  it("returns empty array when no stale PRs exist", async () => {
    const mockExec = vi.fn().mockResolvedValue("[]");
    const result = await scanFleetMergeStalls(["owner/repo-a"], mockExec);
    expect(result).toHaveLength(0);
  });
});

function makeMergeablePR(overrides: Partial<MergeablePR> = {}): MergeablePR {
  return {
    number: 123,
    title: "fix: some improvement",
    url: "https://github.com/owner/repo/pull/123",
    repo: "owner/repo",
    updatedAt: hoursAgo(6),
    headRefName: "issue-123-fix",
    authorLogin: "rapartlu",
    staleHours: 6,
    lastCommitDate: hoursAgo(6),
    ...overrides,
  };
}

describe("mergePR", () => {
  it("calls gh pr merge with correct args on success", async () => {
    const mockExec = vi.fn().mockResolvedValue("");
    const pr = makeMergeablePR();
    const result = await mergePR(pr, mockExec);

    expect(result.success).toBe(true);
    expect(result.pr).toBe(pr);
    expect(result.error).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      "gh pr merge 123 --repo owner/repo --squash --delete-branch",
      { encoding: "utf-8", timeout: 30000 },
    );
  });

  it("captures error on merge failure without throwing", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("merge conflict"));
    const pr = makeMergeablePR();
    const result = await mergePR(pr, mockExec);

    expect(result.success).toBe(false);
    expect(result.error).toContain("merge conflict");
    expect(result.pr).toBe(pr);
  });

  it("handles non-Error thrown values", async () => {
    const mockExec = vi.fn().mockImplementation(async () => {
      throw "string error";
    });
    const pr = makeMergeablePR();
    const result = await mergePR(pr, mockExec);

    expect(result.success).toBe(false);
    expect(result.error).toContain("string error");
  });
});

describe("autoMergeFleetPRs", () => {
  it("merges all PRs and returns results", async () => {
    const mockExec = vi.fn().mockResolvedValue("");
    const prs = [
      makeMergeablePR({ number: 1, repo: "owner/repo-a" }),
      makeMergeablePR({ number: 2, repo: "owner/repo-b" }),
    ];

    const results = await autoMergeFleetPRs(prs, mockExec);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("continues merging after individual failures", async () => {
    const mockExec = vi.fn()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("");

    const prs = [
      makeMergeablePR({ number: 1 }),
      makeMergeablePR({ number: 2 }),
    ];

    const results = await autoMergeFleetPRs(prs, mockExec);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it("returns empty array for empty input", async () => {
    const mockExec = vi.fn();
    const results = await autoMergeFleetPRs([], mockExec);

    expect(results).toHaveLength(0);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ── selectMergeCandidates (issue #1587) ───────────────────────────────────

describe("selectMergeCandidates", () => {
  const allowlist = new Set(["rapartlu"]);

  it("skips when disabled (kill switch off)", () => {
    const decision = selectMergeCandidates(
      [makeMergeablePR()],
      { enabled: false, authorAllowlist: allowlist, dailyCap: 25 },
      0,
    );
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("disabled");
    expect(decision.toMerge).toHaveLength(0);
  });

  it("skips when no stale PRs to consider", () => {
    const decision = selectMergeCandidates(
      [],
      { enabled: true, authorAllowlist: allowlist, dailyCap: 25 },
      0,
    );
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("no-stale");
  });

  it("skips when no stale PR matches the author allowlist", () => {
    const decision = selectMergeCandidates(
      [
        makeMergeablePR({ number: 1, authorLogin: "external-contributor" }),
        makeMergeablePR({ number: 2, authorLogin: "another-outsider" }),
      ],
      { enabled: true, authorAllowlist: allowlist, dailyCap: 25 },
      0,
    );
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("no-eligible");
  });

  it("filters allowlisted PRs and returns them all when under daily cap", () => {
    const decision = selectMergeCandidates(
      [
        makeMergeablePR({ number: 1, authorLogin: "rapartlu" }),
        makeMergeablePR({ number: 2, authorLogin: "external" }),
        makeMergeablePR({ number: 3, authorLogin: "rapartlu" }),
      ],
      { enabled: true, authorAllowlist: allowlist, dailyCap: 25 },
      0,
    );
    expect(decision.skipped).toBe(false);
    expect(decision.toMerge).toHaveLength(2);
    expect(decision.toMerge.map((p) => p.number)).toEqual([1, 3]);
    expect(decision.deferred).toBe(0);
  });

  it("skips when daily cap is already exhausted", () => {
    const decision = selectMergeCandidates(
      [makeMergeablePR({ authorLogin: "rapartlu" })],
      { enabled: true, authorAllowlist: allowlist, dailyCap: 25 },
      25, // already merged 25 today
    );
    expect(decision.skipped).toBe(true);
    expect(decision.reason).toBe("daily-cap");
    expect(decision.deferred).toBe(1);
  });

  it("partial cap: merges up to remaining slots, defers the rest", () => {
    const stale = [1, 2, 3, 4, 5].map((n) =>
      makeMergeablePR({ number: n, authorLogin: "rapartlu" }),
    );
    const decision = selectMergeCandidates(
      stale,
      { enabled: true, authorAllowlist: allowlist, dailyCap: 5 },
      3, // 2 slots remaining today
    );
    expect(decision.skipped).toBe(false);
    expect(decision.toMerge).toHaveLength(2);
    expect(decision.toMerge.map((p) => p.number)).toEqual([1, 2]);
    expect(decision.deferred).toBe(3);
  });

  it("multi-allowlist: accepts any author in the set", () => {
    const multi = new Set(["rapartlu", "fleet-bot"]);
    const decision = selectMergeCandidates(
      [
        makeMergeablePR({ number: 1, authorLogin: "rapartlu" }),
        makeMergeablePR({ number: 2, authorLogin: "fleet-bot" }),
        makeMergeablePR({ number: 3, authorLogin: "external" }),
      ],
      { enabled: true, authorAllowlist: multi, dailyCap: 25 },
      0,
    );
    expect(decision.toMerge).toHaveLength(2);
    expect(decision.toMerge.map((p) => p.number)).toEqual([1, 2]);
  });
});
