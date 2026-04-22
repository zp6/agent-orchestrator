import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import { getPRGuardCooldownFeedPayload } from "../reviewer/pr-guard-cooldown-feed.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Fixture {
  store: StateStore;
  writer: Database.Database;
  dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pr-guard-cooldown-feed-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);
  return { store, writer, dir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getPRGuardCooldownFeedPayload", () => {
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

  it("returns empty list when no cooldowns exist", () => {
    const { store } = fixture();
    const payload = getPRGuardCooldownFeedPayload(store);

    expect(payload.total).toBe(0);
    expect(payload.cooldowns).toEqual([]);
    expect(payload.repo_filter).toBeNull();
    expect(typeof payload.generated_at).toBe("string");
  });

  it("returns active cooldowns with correct shape", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/repo-a", 42, 60);
    store.setPRGuardCooldown("owner/repo-b", 7, 30);

    const payload = getPRGuardCooldownFeedPayload(store);

    expect(payload.total).toBe(2);
    expect(payload.cooldowns).toHaveLength(2);
    // Each entry has the required fields
    for (const entry of payload.cooldowns) {
      expect(typeof entry.repo).toBe("string");
      expect(typeof entry.issueNumber).toBe("number");
      expect(typeof entry.expiresAt).toBe("string");
    }
    // Spot-check specific values
    const repoAEntry = payload.cooldowns.find((c) => c.repo === "owner/repo-a");
    expect(repoAEntry).toBeDefined();
    expect(repoAEntry!.issueNumber).toBe(42);
    const repoBEntry = payload.cooldowns.find((c) => c.repo === "owner/repo-b");
    expect(repoBEntry).toBeDefined();
    expect(repoBEntry!.issueNumber).toBe(7);
  });

  it("excludes expired cooldown entries", () => {
    const { store, writer } = fixture();
    // Insert an already-expired entry directly via writer
    writer.prepare(`
      INSERT INTO pr_guard_cooldown (repo, issue_number, expires_at)
      VALUES (?, ?, datetime('now', '-1 minute'))
    `).run("owner/expired-repo", 99);

    // Insert a live entry via store
    store.setPRGuardCooldown("owner/live-repo", 1, 60);

    const payload = getPRGuardCooldownFeedPayload(store);

    expect(payload.total).toBe(1);
    expect(payload.cooldowns).toHaveLength(1);
    expect(payload.cooldowns[0].repo).toBe("owner/live-repo");
    expect(payload.cooldowns[0].issueNumber).toBe(1);
  });

  it("filters by repo when repoFilter is provided", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/repo-target", 10, 60);
    store.setPRGuardCooldown("owner/repo-target", 11, 60);
    store.setPRGuardCooldown("owner/repo-other", 20, 60);

    const payload = getPRGuardCooldownFeedPayload(store, "owner/repo-target");

    expect(payload.total).toBe(2);
    expect(payload.cooldowns).toHaveLength(2);
    expect(payload.repo_filter).toBe("owner/repo-target");
    for (const entry of payload.cooldowns) {
      expect(entry.repo).toBe("owner/repo-target");
    }
  });

  it("sets repo_filter to null when no filter is provided", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/any-repo", 5, 60);

    const payload = getPRGuardCooldownFeedPayload(store);

    expect(payload.repo_filter).toBeNull();
  });

  it("trims whitespace from repo filter", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/trimmed-repo", 3, 60);

    const payload = getPRGuardCooldownFeedPayload(store, "  owner/trimmed-repo  ");

    expect(payload.total).toBe(1);
    expect(payload.repo_filter).toBe("owner/trimmed-repo");
  });

  it("returns cooldowns ordered by expires_at ascending", () => {
    const { store } = fixture();
    // Insert in reverse TTL order
    store.setPRGuardCooldown("owner/repo", 3, 90); // expires last
    store.setPRGuardCooldown("owner/repo", 1, 30); // expires first
    store.setPRGuardCooldown("owner/repo", 2, 60); // expires second

    const payload = getPRGuardCooldownFeedPayload(store);

    expect(payload.total).toBe(3);
    // Should be in ascending expires_at order: issue 1 (30 min) < 2 (60 min) < 3 (90 min)
    expect(payload.cooldowns[0].issueNumber).toBe(1);
    expect(payload.cooldowns[1].issueNumber).toBe(2);
    expect(payload.cooldowns[2].issueNumber).toBe(3);
  });
});
