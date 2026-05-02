import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkMergeStall,
  scanFleetMergeStalls,
  mergePR,
  autoMergeFleetPRs,
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

  it("returns blocked when agent has a stale MERGEABLE PR", () => {
    const mockExec = vi.fn().mockReturnValue(JSON.stringify([makePR()]));
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(true);
    expect(result.stalePRs).toHaveLength(1);
    expect(result.stalePRs[0].number).toBe(123);
    expect(result.reason).toContain("stale MERGEABLE PR");
  });

  it("returns not blocked when PR was recently updated", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ updatedAt: hoursAgo(1) })]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips draft PRs", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ isDraft: true })]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with failing CI", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([
        makePR({
          statusCheckRollup: [{ conclusion: "FAILURE", state: "COMPLETED" }],
        }),
      ]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with no status checks", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ statusCheckRollup: [] })]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips PRs with null status checks", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ statusCheckRollup: null })]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("fails open on GitHub API error", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("gh CLI timeout");
    });
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.reason).toContain("gh CLI timeout");
  });

  it("respects custom threshold", () => {
    setMergeStallThresholdHours(12);

    // PR updated 6h ago — within 12h threshold, should not block
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([makePR({ updatedAt: hoursAgo(6) })]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(false);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("detects multiple stale PRs", () => {
    const mockExec = vi.fn().mockReturnValue(
      JSON.stringify([
        makePR({ number: 100, updatedAt: hoursAgo(10) }),
        makePR({ number: 101, updatedAt: hoursAgo(20) }),
        makePR({ number: 102, updatedAt: hoursAgo(1) }), // fresh — not stale
      ]),
    );
    const result = checkMergeStall("owner/repo", "test-agent", mockExec);

    expect(result.blocked).toBe(true);
    expect(result.stalePRs).toHaveLength(2);
    expect(result.stalePRs.map((pr) => pr.number)).toContain(100);
    expect(result.stalePRs.map((pr) => pr.number)).toContain(101);
  });
});

describe("scanFleetMergeStalls", () => {
  beforeEach(() => {
    setMergeStallThresholdHours(undefined);
  });

  it("aggregates stale PRs across repos sorted by stale hours descending", () => {
    const mockExec = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes("repo-a")) {
        return JSON.stringify([makePR({ number: 1, updatedAt: hoursAgo(5) })]);
      }
      if (cmd.includes("repo-b")) {
        return JSON.stringify([makePR({ number: 2, updatedAt: hoursAgo(48) })]);
      }
      return "[]";
    });

    const result = scanFleetMergeStalls(["owner/repo-a", "owner/repo-b"], mockExec);

    expect(result).toHaveLength(2);
    // Most stale first
    expect(result[0].number).toBe(2);
    expect(result[1].number).toBe(1);
  });

  it("returns empty array when no stale PRs exist", () => {
    const mockExec = vi.fn().mockReturnValue("[]");
    const result = scanFleetMergeStalls(["owner/repo-a"], mockExec);
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
    staleHours: 6,
    ...overrides,
  };
}

describe("mergePR", () => {
  it("calls gh pr merge with correct args on success", () => {
    const mockExec = vi.fn().mockReturnValue("");
    const pr = makeMergeablePR();
    const result = mergePR(pr, mockExec);

    expect(result.success).toBe(true);
    expect(result.pr).toBe(pr);
    expect(result.error).toBeUndefined();
    expect(mockExec).toHaveBeenCalledWith(
      "gh pr merge 123 --repo owner/repo --squash --delete-branch",
      { encoding: "utf-8", timeout: 30000 },
    );
  });

  it("captures error on merge failure without throwing", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("merge conflict");
    });
    const pr = makeMergeablePR();
    const result = mergePR(pr, mockExec);

    expect(result.success).toBe(false);
    expect(result.error).toContain("merge conflict");
    expect(result.pr).toBe(pr);
  });

  it("handles non-Error thrown values", () => {
    const mockExec = vi.fn().mockImplementation(() => {
      throw "string error";
    });
    const pr = makeMergeablePR();
    const result = mergePR(pr, mockExec);

    expect(result.success).toBe(false);
    expect(result.error).toContain("string error");
  });
});

describe("autoMergeFleetPRs", () => {
  it("merges all PRs and returns results", () => {
    const mockExec = vi.fn().mockReturnValue("");
    const prs = [
      makeMergeablePR({ number: 1, repo: "owner/repo-a" }),
      makeMergeablePR({ number: 2, repo: "owner/repo-b" }),
    ];

    const results = autoMergeFleetPRs(prs, mockExec);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(true);
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("continues merging after individual failures", () => {
    const mockExec = vi.fn()
      .mockImplementationOnce(() => { throw new Error("failed"); })
      .mockReturnValueOnce("");

    const prs = [
      makeMergeablePR({ number: 1 }),
      makeMergeablePR({ number: 2 }),
    ];

    const results = autoMergeFleetPRs(prs, mockExec);

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it("returns empty array for empty input", () => {
    const mockExec = vi.fn();
    const results = autoMergeFleetPRs([], mockExec);

    expect(results).toHaveLength(0);
    expect(mockExec).not.toHaveBeenCalled();
  });
});
