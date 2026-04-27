/**
 * Tests for the per-issue PR guard cooldown check endpoint (issue #1112).
 *
 * Covers:
 *   - getCooldownCheckPayload: inactive / active / TTL computation
 *   - parseCooldownCheckParams: valid and invalid inputs
 *   - formatCooldownCheckError: error shape
 *   - Integration with StateStore.getActivePRGuardCooldown
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getCooldownCheckPayload,
  parseCooldownCheckParams,
  formatCooldownCheckError,
} from "../reviewer/pr-guard-cooldown-check.js";
import type { IPRGuardCooldownCheckStore } from "../reviewer/pr-guard-cooldown-check.js";
import { StateStore } from "../state/store.js";

// ── Mock store helpers ─────────────────────────────────────────────────────────

function makeActiveStore(expiresAt: string): IPRGuardCooldownCheckStore {
  return {
    getActivePRGuardCooldown: (_repo, _issueNumber) => expiresAt,
  };
}

function makeInactiveStore(): IPRGuardCooldownCheckStore {
  return {
    getActivePRGuardCooldown: (_repo, _issueNumber) => null,
  };
}

// ── StateStore fixture helpers ────────────────────────────────────────────────

interface Fixture {
  store: StateStore;
  writer: Database.Database;
  dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "pr-guard-cooldown-check-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);
  return { store, writer, dir };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getCooldownCheckPayload", () => {
  const REPO = "rapartlu/research-agent";
  const ISSUE = 440;

  // ── Inactive cooldown ────────────────────────────────────────────────────────

  it("returns active=false when no cooldown exists", () => {
    const store = makeInactiveStore();
    const now = new Date("2026-04-23T12:00:00Z");
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    expect(payload.active).toBe(false);
    expect(payload.expires_at).toBeNull();
    expect(payload.ttl_remaining_seconds).toBeNull();
    expect(payload.repo).toBe(REPO);
    expect(payload.issue_number).toBe(ISSUE);
    expect(payload.checked_at).toBe("2026-04-23T12:00:00.000Z");
  });

  // ── Active cooldown ──────────────────────────────────────────────────────────

  it("returns active=true when a cooldown exists", () => {
    const expiresAt = "2026-04-23T14:00:00.000Z";
    const store = makeActiveStore(expiresAt);
    const now = new Date("2026-04-23T12:00:00Z");
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    expect(payload.active).toBe(true);
    expect(payload.expires_at).toBe(expiresAt);
    expect(payload.repo).toBe(REPO);
    expect(payload.issue_number).toBe(ISSUE);
  });

  it("computes ttl_remaining_seconds correctly", () => {
    const expiresAt = "2026-04-23T14:00:00.000Z";
    const now = new Date("2026-04-23T12:00:00Z"); // 2 hours before expiry
    const store = makeActiveStore(expiresAt);
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    expect(payload.ttl_remaining_seconds).toBe(7200); // 2 * 60 * 60
  });

  it("computes ttl_remaining_seconds as floor (truncates ms)", () => {
    const expiresAt = "2026-04-23T14:00:00.500Z"; // 500ms extra
    const now = new Date("2026-04-23T12:00:00Z");
    const store = makeActiveStore(expiresAt);
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    // floor(7200500 / 1000) = 7200
    expect(payload.ttl_remaining_seconds).toBe(7200);
  });

  it("clamps ttl_remaining_seconds to 0 when expiry is exactly now", () => {
    const now = new Date("2026-04-23T12:00:00Z");
    const expiresAt = now.toISOString(); // exact same timestamp
    const store = makeActiveStore(expiresAt);
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    expect(payload.ttl_remaining_seconds).toBe(0);
  });

  it("sets checked_at to the provided 'now'", () => {
    const store = makeInactiveStore();
    const now = new Date("2026-04-23T13:45:00Z");
    const payload = getCooldownCheckPayload(store, REPO, ISSUE, now);

    expect(payload.checked_at).toBe("2026-04-23T13:45:00.000Z");
  });

  it("passes repo and issueNumber through to the store", () => {
    let capturedRepo: string | undefined;
    let capturedIssue: number | undefined;
    const store: IPRGuardCooldownCheckStore = {
      getActivePRGuardCooldown(repo, issueNumber) {
        capturedRepo = repo;
        capturedIssue = issueNumber;
        return null;
      },
    };

    getCooldownCheckPayload(store, "owner/my-repo", 99);

    expect(capturedRepo).toBe("owner/my-repo");
    expect(capturedIssue).toBe(99);
  });
});

// ── parseCooldownCheckParams ──────────────────────────────────────────────────

describe("parseCooldownCheckParams", () => {
  it("returns ok=true for valid repo and issue", () => {
    const result = parseCooldownCheckParams({ repo: "rapartlu/research-agent", issue: "440" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.repo).toBe("rapartlu/research-agent");
      expect(result.params.issueNumber).toBe(440);
    }
  });

  it("trims whitespace from repo", () => {
    const result = parseCooldownCheckParams({ repo: "  owner/repo  ", issue: "1" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.repo).toBe("owner/repo");
    }
  });

  it("returns ok=false when repo is missing", () => {
    const result = parseCooldownCheckParams({ issue: "440" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/repo/i);
    }
  });

  it("returns ok=false when repo is an empty string", () => {
    const result = parseCooldownCheckParams({ repo: "", issue: "440" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when repo is whitespace-only", () => {
    const result = parseCooldownCheckParams({ repo: "   ", issue: "440" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when repo has no slash (invalid format)", () => {
    const result = parseCooldownCheckParams({ repo: "myrepo", issue: "440" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/owner\/repo/i);
    }
  });

  it("returns ok=false when issue is missing", () => {
    const result = parseCooldownCheckParams({ repo: "owner/repo" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/issue/i);
    }
  });

  it("returns ok=false when issue is zero", () => {
    const result = parseCooldownCheckParams({ repo: "owner/repo", issue: "0" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when issue is negative", () => {
    const result = parseCooldownCheckParams({ repo: "owner/repo", issue: "-5" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when issue is non-numeric", () => {
    const result = parseCooldownCheckParams({ repo: "owner/repo", issue: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/issue/i);
    }
  });

  it("returns ok=false when issue is a non-string type", () => {
    const result = parseCooldownCheckParams({ repo: "owner/repo", issue: ["1", "2"] });
    expect(result.ok).toBe(false);
  });
});

// ── formatCooldownCheckError ──────────────────────────────────────────────────

describe("formatCooldownCheckError", () => {
  it("returns an object with an 'error' key", () => {
    const result = formatCooldownCheckError("something went wrong");
    expect(result).toEqual({ error: "something went wrong" });
  });

  it("preserves the full error message", () => {
    const msg = "Missing or empty 'repo' query parameter (expected 'owner/repo' format)";
    const result = formatCooldownCheckError(msg);
    expect(result.error).toBe(msg);
  });
});

// ── Integration: StateStore.getActivePRGuardCooldown ─────────────────────────

describe("StateStore.getActivePRGuardCooldown", () => {
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

  it("returns null when no cooldown exists", () => {
    const { store } = fixture();
    const result = store.getActivePRGuardCooldown("owner/repo", 42);
    expect(result).toBeNull();
  });

  it("returns expires_at string when an active cooldown exists", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/repo", 42, 60);
    const result = store.getActivePRGuardCooldown("owner/repo", 42);
    expect(typeof result).toBe("string");
    // The returned value should be a valid date in the future
    expect(new Date(result!).getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for an expired cooldown", () => {
    const { store, writer } = fixture();
    // Insert an already-expired entry directly
    writer.prepare(`
      INSERT INTO pr_guard_cooldown (repo, issue_number, expires_at)
      VALUES (?, ?, datetime('now', '-1 minute'))
    `).run("owner/repo", 99);

    const result = store.getActivePRGuardCooldown("owner/repo", 99);
    expect(result).toBeNull();
  });

  it("returns null for a different (repo, issue) pair", () => {
    const { store } = fixture();
    store.setPRGuardCooldown("owner/repo-a", 10, 60);

    // Different repo
    expect(store.getActivePRGuardCooldown("owner/repo-b", 10)).toBeNull();
    // Different issue
    expect(store.getActivePRGuardCooldown("owner/repo-a", 11)).toBeNull();
  });

  it("getCooldownCheckPayload integrates correctly with StateStore", () => {
    const { store } = fixture();
    const repo = "rapartlu/research-agent";
    const issue = 440;

    // No cooldown → inactive
    const inactive = getCooldownCheckPayload(store, repo, issue);
    expect(inactive.active).toBe(false);

    // Set cooldown → active
    store.setPRGuardCooldown(repo, issue, 120);
    const active = getCooldownCheckPayload(store, repo, issue);
    expect(active.active).toBe(true);
    expect(active.ttl_remaining_seconds).toBeGreaterThan(0);
    expect(active.ttl_remaining_seconds).toBeLessThanOrEqual(120 * 60);
    expect(typeof active.expires_at).toBe("string");
  });
});
