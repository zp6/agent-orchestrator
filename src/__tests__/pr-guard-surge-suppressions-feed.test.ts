/**
 * Tests for getPRGuardSurgeSuppressionsFeedPayload and the underlying
 * StateStore pr_guard_surge_suppressions table (issue #468).
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import { getPRGuardSurgeSuppressionsFeedPayload } from "../reviewer/pr-guard-surge-suppressions-feed.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Fixture {
  store: StateStore;
  writer: Database.Database;
  dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pr-guard-surge-suppressions-feed-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);
  return { store, writer, dir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getPRGuardSurgeSuppressionsFeedPayload", () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      try { f.writer.close(); } catch { /* ignore */ }
      try { rmSync(f.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function fixture(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  it("returns empty list when no suppressions exist", () => {
    const { store } = fixture();
    const payload = getPRGuardSurgeSuppressionsFeedPayload(store);

    expect(payload.total).toBe(0);
    expect(payload.suppressions).toEqual([]);
    expect(payload.repo_filter).toBeNull();
    expect(typeof payload.generated_at).toBe("string");
  });

  it("returns active suppression entries with correct shape", () => {
    const { store } = fixture();
    const until1 = new Date(Date.now() + 60 * 60 * 1000); // +1h
    const until2 = new Date(Date.now() + 90 * 60 * 1000); // +90m
    store.setPRGuardSurgeSuppression("owner/repo-a", 42, until1);
    store.setPRGuardSurgeSuppression("owner/repo-b", 7, until2);

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store);

    expect(payload.total).toBe(2);
    expect(payload.suppressions).toHaveLength(2);
    for (const entry of payload.suppressions) {
      expect(typeof entry.repo).toBe("string");
      expect(typeof entry.issueNumber).toBe("number");
      expect(typeof entry.suppressedUntil).toBe("string");
    }
    // Spot-check
    const entryA = payload.suppressions.find((s) => s.repo === "owner/repo-a");
    expect(entryA).toBeDefined();
    expect(entryA!.issueNumber).toBe(42);
    const entryB = payload.suppressions.find((s) => s.repo === "owner/repo-b");
    expect(entryB).toBeDefined();
    expect(entryB!.issueNumber).toBe(7);
  });

  it("excludes expired suppression entries", () => {
    const { store, writer } = fixture();
    // Insert an already-expired entry directly via raw writer
    writer
      .prepare(
        `INSERT INTO pr_guard_surge_suppressions (repo, issue_number, suppressed_until)
         VALUES (?, ?, datetime('now', '-1 minute'))`,
      )
      .run("owner/expired-repo", 99);

    // Insert a live entry via store
    store.setPRGuardSurgeSuppression("owner/live-repo", 1, new Date(Date.now() + 60 * 60 * 1000));

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store);

    expect(payload.total).toBe(1);
    expect(payload.suppressions).toHaveLength(1);
    expect(payload.suppressions[0].repo).toBe("owner/live-repo");
    expect(payload.suppressions[0].issueNumber).toBe(1);
  });

  it("filters by repo when repoFilter is provided", () => {
    const { store } = fixture();
    const until = new Date(Date.now() + 60 * 60 * 1000);
    store.setPRGuardSurgeSuppression("owner/repo-target", 10, until);
    store.setPRGuardSurgeSuppression("owner/repo-target", 11, until);
    store.setPRGuardSurgeSuppression("owner/repo-other", 20, until);

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store, "owner/repo-target");

    expect(payload.total).toBe(2);
    expect(payload.suppressions).toHaveLength(2);
    expect(payload.repo_filter).toBe("owner/repo-target");
    for (const entry of payload.suppressions) {
      expect(entry.repo).toBe("owner/repo-target");
    }
  });

  it("sets repo_filter to null when no filter is provided", () => {
    const { store } = fixture();
    store.setPRGuardSurgeSuppression("owner/any-repo", 5, new Date(Date.now() + 3600_000));

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store);

    expect(payload.repo_filter).toBeNull();
  });

  it("trims whitespace from repo filter", () => {
    const { store } = fixture();
    store.setPRGuardSurgeSuppression("owner/trimmed-repo", 3, new Date(Date.now() + 3600_000));

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store, "  owner/trimmed-repo  ");

    expect(payload.total).toBe(1);
    expect(payload.repo_filter).toBe("owner/trimmed-repo");
  });

  it("returns suppressions ordered by suppressed_until ascending", () => {
    const { store } = fixture();
    const now = Date.now();
    // Insert in reverse expiry order
    store.setPRGuardSurgeSuppression("owner/repo", 3, new Date(now + 3 * 3600_000)); // expires last
    store.setPRGuardSurgeSuppression("owner/repo", 1, new Date(now + 1 * 3600_000)); // expires first
    store.setPRGuardSurgeSuppression("owner/repo", 2, new Date(now + 2 * 3600_000)); // expires second

    const payload = getPRGuardSurgeSuppressionsFeedPayload(store);

    expect(payload.total).toBe(3);
    expect(payload.suppressions[0].issueNumber).toBe(1);
    expect(payload.suppressions[1].issueNumber).toBe(2);
    expect(payload.suppressions[2].issueNumber).toBe(3);
  });
});

// ── StateStore unit tests ─────────────────────────────────────────────────────

describe("StateStore.setPRGuardSurgeSuppression / isPRGuardSurgeSuppressionActive / listActivePRGuardSurgeSuppressions / prunePRGuardSurgeSuppressions", () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      try { f.writer.close(); } catch { /* ignore */ }
      try { rmSync(f.dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function fixture(): Fixture {
    const f = makeFixture();
    fixtures.push(f);
    return f;
  }

  it("isPRGuardSurgeSuppressionActive returns false when no entry exists", () => {
    const { store } = fixture();
    expect(store.isPRGuardSurgeSuppressionActive("owner/repo", 1)).toBe(false);
  });

  it("isPRGuardSurgeSuppressionActive returns true for a live entry", () => {
    const { store } = fixture();
    store.setPRGuardSurgeSuppression("owner/repo", 1, new Date(Date.now() + 3600_000));
    expect(store.isPRGuardSurgeSuppressionActive("owner/repo", 1)).toBe(true);
  });

  it("isPRGuardSurgeSuppressionActive returns false for an expired entry", () => {
    const { store, writer } = fixture();
    writer
      .prepare(
        `INSERT INTO pr_guard_surge_suppressions (repo, issue_number, suppressed_until)
         VALUES (?, ?, datetime('now', '-1 second'))`,
      )
      .run("owner/repo", 1);
    expect(store.isPRGuardSurgeSuppressionActive("owner/repo", 1)).toBe(false);
  });

  it("setPRGuardSurgeSuppression upserts: updating suppressed_until for same (repo, issue)", () => {
    const { store } = fixture();
    const firstUntil = new Date(Date.now() + 3600_000);
    store.setPRGuardSurgeSuppression("owner/repo", 1, firstUntil);

    // Extend the suppression
    const secondUntil = new Date(Date.now() + 7200_000);
    store.setPRGuardSurgeSuppression("owner/repo", 1, secondUntil);

    const active = store.listActivePRGuardSurgeSuppressions();
    // Should still be just one row
    expect(active).toHaveLength(1);
    expect(active[0].issueNumber).toBe(1);
    // The stored until should reflect the updated value
    expect(new Date(active[0].suppressedUntil).getTime()).toBeGreaterThan(firstUntil.getTime() + 3500_000);
  });

  it("listActivePRGuardSurgeSuppressions returns only active entries", () => {
    const { store, writer } = fixture();
    store.setPRGuardSurgeSuppression("owner/repo", 1, new Date(Date.now() + 3600_000));
    writer
      .prepare(
        `INSERT INTO pr_guard_surge_suppressions (repo, issue_number, suppressed_until)
         VALUES (?, ?, datetime('now', '-1 minute'))`,
      )
      .run("owner/repo", 2);

    const active = store.listActivePRGuardSurgeSuppressions();
    expect(active).toHaveLength(1);
    expect(active[0].issueNumber).toBe(1);
  });

  it("prunePRGuardSurgeSuppressions removes only expired rows", () => {
    const { store, writer } = fixture();
    // One live
    store.setPRGuardSurgeSuppression("owner/repo", 1, new Date(Date.now() + 3600_000));
    // One expired
    writer
      .prepare(
        `INSERT INTO pr_guard_surge_suppressions (repo, issue_number, suppressed_until)
         VALUES (?, ?, datetime('now', '-1 minute'))`,
      )
      .run("owner/repo", 2);

    const deleted = store.prunePRGuardSurgeSuppressions();
    expect(deleted).toBe(1);

    const remaining = store.listActivePRGuardSurgeSuppressions();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].issueNumber).toBe(1);
  });

  it("prunePRGuardSurgeSuppressions returns 0 when nothing to prune", () => {
    const { store } = fixture();
    store.setPRGuardSurgeSuppression("owner/repo", 1, new Date(Date.now() + 3600_000));
    expect(store.prunePRGuardSurgeSuppressions()).toBe(0);
  });
});
