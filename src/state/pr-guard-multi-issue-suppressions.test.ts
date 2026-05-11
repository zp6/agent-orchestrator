import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("PR guard multi-issue suppressions", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-pr-guard-multi-issue-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  it("stores, reads, and lists active multi-issue suppressions", () => {
    const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    store.setPRGuardMultiIssueSuppression({
      repo: "owner/repo",
      blockingPrNumber: 42,
      blockedIssueNumbers: [10, 11],
      eventCount: 2,
      suppressedUntil: expiresAt,
    });

    expect(store.isPRGuardMultiIssueSuppressionActive("owner/repo", 42)).toBe(true);

    const suppression = store.getPRGuardMultiIssueSuppression("owner/repo", 42);
    expect(suppression).toMatchObject({
      repo: "owner/repo",
      blocking_pr_number: 42,
      event_count: 2,
      blocked_issues: [10, 11],
    });
    expect(suppression?.minutes_remaining).toBeGreaterThan(0);

    const active = store.listActivePRGuardMultiIssueSuppressions();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      repo: "owner/repo",
      blocking_pr_number: 42,
      event_count: 2,
    });
  });

  it("prunes expired multi-issue suppressions", () => {
    const suppressedUntil = new Date(Date.now() - 1_000);
    store.setPRGuardMultiIssueSuppression({
      repo: "owner/repo",
      blockingPrNumber: 1,
      blockedIssueNumbers: [1, 2],
      eventCount: 2,
      suppressedUntil,
    });

    expect(store.isPRGuardMultiIssueSuppressionActive("owner/repo", 1)).toBe(false);
    expect(store.prunePRGuardMultiIssueSuppressions()).toBe(1);
  });
});
