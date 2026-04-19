/**
 * Tests for proactive-rebase-scheduler (issue #335)
 *
 * Verifies:
 *  - Stale PR detection (commit divergence + age thresholds)
 *  - Proactive rebase task generation
 *  - Cooldown enforcement (no double-scheduling within 6h)
 *  - Stats tracking (proactive vs reactive counts)
 *  - classifyRebaseTask() distinguishes proactive vs reactive tasks
 *  - Telegram alert formatting
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "child_process";
import {
  ProactiveRebaseScheduler,
  classifyRebaseTask,
  formatProactiveRebaseAlert,
  hoursAgo,
  fetchOpenPRRecords,
  countCommitsBehind,
  DEFAULT_DIVERGE_THRESHOLD,
  DEFAULT_MIN_PR_AGE_HOURS,
  DEFAULT_SCHEDULE_COOLDOWN_MS,
  type OpenPRRecord,
  type StalePRRebaseTask,
} from "../reviewer/proactive-rebase-scheduler.js";

// Mock child_process so gh CLI and git commands never execute in tests
vi.mock("child_process");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW_MS = new Date("2026-04-19T12:00:00.000Z").getTime();

function prAgeMs(hours: number): string {
  return new Date(NOW_MS - hours * 60 * 60 * 1000).toISOString();
}

const PR_FRESH: OpenPRRecord = {
  number: 10,
  headRefName: "issue-10-fresh-feature",
  url: "https://github.com/owner/repo/pull/10",
  createdAt: prAgeMs(2), // only 2h old — not eligible
  author: "bot",
};

const PR_STALE_ENOUGH: OpenPRRecord = {
  number: 42,
  headRefName: "issue-42-old-feature",
  url: "https://github.com/owner/repo/pull/42",
  createdAt: prAgeMs(30), // 30h old — eligible
  author: "bot",
};

const PR_VERY_OLD: OpenPRRecord = {
  number: 99,
  headRefName: "issue-99-ancient-feature",
  url: "https://github.com/owner/repo/pull/99",
  createdAt: prAgeMs(72), // 72h old — eligible
  author: "bot",
};

// ── hoursAgo ──────────────────────────────────────────────────────────────────

describe("hoursAgo", () => {
  it("returns correct hour difference", () => {
    const ts = new Date(NOW_MS - 5 * 60 * 60 * 1000).toISOString();
    expect(hoursAgo(ts, NOW_MS)).toBeCloseTo(5, 2);
  });

  it("returns 0 for invalid timestamps", () => {
    expect(hoursAgo("not-a-date", NOW_MS)).toBe(0);
  });
});

// ── classifyRebaseTask ────────────────────────────────────────────────────────

describe("classifyRebaseTask", () => {
  it("classifies proactive tasks by [stale-pr-rebase] tag", () => {
    expect(classifyRebaseTask("[stale-pr-rebase] Proactively rebase PR #42")).toBe("proactive");
    expect(classifyRebaseTask("[STALE-PR-REBASE] Rebase PR #10")).toBe("proactive");
  });

  it("classifies reactive tasks by conflict keywords", () => {
    expect(classifyRebaseTask("Resolve merge conflict on issue-42-feature")).toBe("reactive");
    expect(classifyRebaseTask("Rebase conflict: PR #99 blocked")).toBe("reactive");
    expect(classifyRebaseTask("Fix merge.conflict in branch foo")).toBe("reactive");
  });

  it("returns unknown for unrecognised titles", () => {
    expect(classifyRebaseTask("Some unrelated task")).toBe("unknown");
    expect(classifyRebaseTask("")).toBe("unknown");
  });
});

// ── fetchOpenPRRecords ────────────────────────────────────────────────────────

describe("fetchOpenPRRecords", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns parsed PRs on success", () => {
    const raw = [
      {
        number: 42,
        headRefName: "issue-42-feat",
        url: "https://github.com/owner/repo/pull/42",
        createdAt: "2026-04-18T10:00:00.000Z",
        author: { login: "bot" },
      },
    ];
    vi.mocked(childProcess.execSync).mockReturnValueOnce(JSON.stringify(raw));
    const result = fetchOpenPRRecords("owner/repo");
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(result[0].author).toBe("bot");
  });

  it("returns empty array when gh CLI throws", () => {
    vi.mocked(childProcess.execSync).mockImplementationOnce(() => {
      throw new Error("gh: not found");
    });
    const result = fetchOpenPRRecords("owner/repo");
    expect(result).toEqual([]);
  });
});

// ── countCommitsBehind ────────────────────────────────────────────────────────

describe("countCommitsBehind", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns parsed integer on success", () => {
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("5\n"); // git rev-list --count
    const count = countCommitsBehind("owner/repo", "issue-42-feat", "main");
    expect(count).toBe(5);
  });

  it("returns null when git fetch fails", () => {
    vi.mocked(childProcess.execSync).mockImplementationOnce(() => {
      throw new Error("git fetch failed");
    });
    const count = countCommitsBehind("owner/repo", "issue-42-feat", "main");
    expect(count).toBeNull();
  });

  it("returns null when rev-list fails", () => {
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce("") // git fetch succeeds
      .mockImplementationOnce(() => {
        throw new Error("rev-list failed");
      });
    const count = countCommitsBehind("owner/repo", "issue-42-feat", "main");
    expect(count).toBeNull();
  });
});

// ── formatProactiveRebaseAlert ────────────────────────────────────────────────

describe("formatProactiveRebaseAlert", () => {
  it("includes all stale PR details in the message", () => {
    const stalePRs: StalePRRebaseTask[] = [
      {
        repo: "owner/repo",
        prNumber: 42,
        branch: "issue-42-feat",
        prUrl: "https://github.com/owner/repo/pull/42",
        commitsBehind: 5,
        hoursOpen: 30,
        scheduledAt: new Date(NOW_MS).toISOString(),
        taskTitle: "[stale-pr-rebase] Proactively rebase PR #42",
        taskDescription: "Description",
      },
    ];
    const msg = formatProactiveRebaseAlert("owner/repo", stalePRs, NOW_MS);
    expect(msg).toContain("Proactive rebase scheduled");
    expect(msg).toContain("owner/repo");
    expect(msg).toContain("PR #42");
    expect(msg).toContain("5 commits behind main");
    expect(msg).toContain("30h");
  });

  it("mentions no-operator-action in the message", () => {
    const stalePRs: StalePRRebaseTask[] = [
      {
        repo: "owner/repo",
        prNumber: 1,
        branch: "issue-1-feat",
        prUrl: "https://github.com/owner/repo/pull/1",
        commitsBehind: 3,
        hoursOpen: 25,
        scheduledAt: new Date(NOW_MS).toISOString(),
        taskTitle: "[stale-pr-rebase] Rebase PR #1",
        taskDescription: "Description",
      },
    ];
    const msg = formatProactiveRebaseAlert("owner/repo", stalePRs, NOW_MS);
    expect(msg).toMatch(/no operator action/i);
  });
});

// ── ProactiveRebaseScheduler ──────────────────────────────────────────────────

describe("ProactiveRebaseScheduler", () => {
  beforeEach(() => vi.resetAllMocks());

  function makeScheduler(opts = {}) {
    return new ProactiveRebaseScheduler(undefined, opts);
  }

  it("exports expected defaults", () => {
    expect(DEFAULT_DIVERGE_THRESHOLD).toBe(3);
    expect(DEFAULT_MIN_PR_AGE_HOURS).toBe(24);
    expect(DEFAULT_SCHEDULE_COOLDOWN_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("skips PRs that are too fresh (< minPROpenHours)", async () => {
    const scheduler = makeScheduler({ minPROpenHours: 24 });

    vi.mocked(childProcess.execSync).mockReturnValueOnce(
      JSON.stringify([
        {
          number: PR_FRESH.number,
          headRefName: PR_FRESH.headRefName,
          url: PR_FRESH.url,
          createdAt: PR_FRESH.createdAt,
          author: { login: "bot" },
        },
      ]),
    );

    const result = await scheduler.run("owner/repo", NOW_MS);
    expect(result.prsInspected).toBe(0); // fresh PR filtered out
    expect(result.tasksScheduled).toBe(0);
    expect(result.stalePRs).toHaveLength(0);
  });

  it("skips eligible PRs that are not stale enough (< divergeThreshold)", async () => {
    const scheduler = makeScheduler({ divergeThreshold: 3, minPROpenHours: 24 });

    // gh pr list returns one eligible PR
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: PR_STALE_ENOUGH.number,
            headRefName: PR_STALE_ENOUGH.headRefName,
            url: PR_STALE_ENOUGH.url,
            createdAt: PR_STALE_ENOUGH.createdAt,
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("1\n"); // only 1 commit behind — below threshold

    const result = await scheduler.run("owner/repo", NOW_MS);
    expect(result.prsInspected).toBe(1);
    expect(result.tasksScheduled).toBe(0);
  });

  it("schedules a rebase task for a PR that is stale enough", async () => {
    const scheduler = makeScheduler({ divergeThreshold: 3, minPROpenHours: 24 });

    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: PR_STALE_ENOUGH.number,
            headRefName: PR_STALE_ENOUGH.headRefName,
            url: PR_STALE_ENOUGH.url,
            createdAt: PR_STALE_ENOUGH.createdAt,
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("5\n"); // 5 commits behind — above threshold

    const result = await scheduler.run("owner/repo", NOW_MS);
    expect(result.tasksScheduled).toBe(1);
    expect(result.stalePRs).toHaveLength(1);

    const task = result.stalePRs[0];
    expect(task.prNumber).toBe(PR_STALE_ENOUGH.number);
    expect(task.commitsBehind).toBe(5);
    expect(task.taskTitle).toMatch(/\[stale-pr-rebase\]/);
    expect(task.taskDescription).toContain("git rebase");
  });

  it("enforces cooldown — does not re-schedule within the cooldown window", async () => {
    const scheduler = makeScheduler({
      divergeThreshold: 3,
      minPROpenHours: 24,
      cooldownMs: 6 * 60 * 60 * 1000,
    });

    const rawPR = JSON.stringify([
      {
        number: PR_STALE_ENOUGH.number,
        headRefName: PR_STALE_ENOUGH.headRefName,
        url: PR_STALE_ENOUGH.url,
        createdAt: PR_STALE_ENOUGH.createdAt,
        author: { login: "bot" },
      },
    ]);

    // First run — should schedule
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(rawPR)
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("5\n"); // 5 commits behind

    const first = await scheduler.run("owner/repo", NOW_MS);
    expect(first.tasksScheduled).toBe(1);

    // Second run 1h later — still in cooldown.
    // Only mock the gh call; git commands are skipped because the cooldown gate
    // fires before countCommitsBehind() is reached.
    vi.mocked(childProcess.execSync).mockReturnValueOnce(rawPR);

    const second = await scheduler.run("owner/repo", NOW_MS + 60 * 60 * 1000);
    expect(second.tasksScheduled).toBe(0); // cooldown blocks re-schedule

    // Third run after cooldown expires (7h later) — all three calls needed again.
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(rawPR)
      .mockReturnValueOnce("") // git fetch
      .mockReturnValueOnce("8\n"); // even more stale

    const third = await scheduler.run("owner/repo", NOW_MS + 7 * 60 * 60 * 1000);
    expect(third.tasksScheduled).toBe(1); // cooldown expired — schedule again
  });

  it("tracks proactive vs reactive rebase stats separately", async () => {
    const scheduler = makeScheduler({ divergeThreshold: 3, minPROpenHours: 24 });

    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: PR_STALE_ENOUGH.number,
            headRefName: PR_STALE_ENOUGH.headRefName,
            url: PR_STALE_ENOUGH.url,
            createdAt: PR_STALE_ENOUGH.createdAt,
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("4\n");

    await scheduler.run("owner/repo", NOW_MS);

    // Record 2 reactive rebases from the conflict-recovery path
    scheduler.recordReactiveRebase();
    scheduler.recordReactiveRebase();

    const stats = scheduler.getStats();
    expect(stats.proactiveScheduled).toBe(1);
    expect(stats.reactiveRecorded).toBe(2);
    expect(stats.lastRunTasksScheduled).toBe(1);
    expect(stats.lastRunAt).not.toBeNull();
  });

  it("resetStats() clears all counters", async () => {
    const scheduler = makeScheduler({ divergeThreshold: 3, minPROpenHours: 24 });

    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: PR_VERY_OLD.number,
            headRefName: PR_VERY_OLD.headRefName,
            url: PR_VERY_OLD.url,
            createdAt: PR_VERY_OLD.createdAt,
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("10\n");

    await scheduler.run("owner/repo", NOW_MS);
    scheduler.recordReactiveRebase();

    scheduler.resetStats();
    const stats = scheduler.getStats();
    expect(stats.proactiveScheduled).toBe(0);
    expect(stats.reactiveRecorded).toBe(0);
    expect(stats.lastRunAt).toBeNull();
  });

  it("generates a task description with step-by-step rebase instructions", async () => {
    const scheduler = makeScheduler({ divergeThreshold: 3, minPROpenHours: 24 });

    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: 42,
            headRefName: "issue-42-feat",
            url: "https://github.com/owner/repo/pull/42",
            createdAt: prAgeMs(30),
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("3\n");

    const result = await scheduler.run("owner/repo", NOW_MS);
    const desc = result.stalePRs[0].taskDescription;
    expect(desc).toContain("git fetch origin");
    expect(desc).toContain("git checkout issue-42-feat");
    expect(desc).toContain("git rebase origin/main");
    expect(desc).toContain("git push --force-with-lease");
  });

  it("does not send notification when notifier is not provided", async () => {
    // Scheduler created without notifier — should not throw
    const scheduler = new ProactiveRebaseScheduler(undefined, {
      divergeThreshold: 3,
      minPROpenHours: 24,
    });

    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce(
        JSON.stringify([
          {
            number: 42,
            headRefName: "issue-42-feat",
            url: "https://github.com/owner/repo/pull/42",
            createdAt: prAgeMs(30),
            author: { login: "bot" },
          },
        ]),
      )
      .mockReturnValueOnce("")
      .mockReturnValueOnce("4\n");

    await expect(scheduler.run("owner/repo", NOW_MS)).resolves.not.toThrow();
  });
});
