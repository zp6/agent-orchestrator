/**
 * Tests for the brainstorm dispatch gate (issue #625).
 *
 * Covers:
 *   - getBrainstormGatePayload: no-prior-session, hash-match, hash-changed,
 *     interval-elapsed, within-interval cases
 *   - parseBrainstormGateParams: valid and invalid inputs
 *   - Integration with StateStore (brainstorm_sessions table)
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getBrainstormGatePayload,
  parseBrainstormGateParams,
} from "../reviewer/brainstorm-gate.js";
import type {
  IBrainstormGateStore,
  BrainstormSessionRow,
} from "../reviewer/brainstorm-gate.js";
import { StateStore } from "../state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// ── Mock store helpers ────────────────────────────────────────────────────────

function makeNullStore(): IBrainstormGateStore {
  return {
    getLastBrainstormSession: () => null,
    recordBrainstormSession: () => undefined,
  };
}

function makeSessionStore(row: BrainstormSessionRow): IBrainstormGateStore {
  return {
    getLastBrainstormSession: () => row,
    recordBrainstormSession: () => undefined,
  };
}

function makeRow(overrides: Partial<BrainstormSessionRow> = {}): BrainstormSessionRow {
  return {
    id: "test-id",
    fleet_hash: HASH_A,
    dispatched_at: "2026-05-01T10:00:00.000Z",
    failure_rate: null,
    open_issues_count: null,
    mergeable_prs_count: null,
    ...overrides,
  };
}

// ── StateStore fixture helpers ────────────────────────────────────────────────

interface Fixture {
  store: StateStore;
  writer: Database.Database;
  dir: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "brainstorm-gate-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);
  return { store, writer, dir };
}

// ── getBrainstormGatePayload ──────────────────────────────────────────────────

describe("getBrainstormGatePayload", () => {
  // ── No prior session ──────────────────────────────────────────────────────

  it("allows dispatch when no prior session exists", () => {
    const store = makeNullStore();
    const now = new Date("2026-05-02T12:00:00Z");
    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    expect(payload.should_dispatch).toBe(true);
    expect(payload.reason).toBe("no_prior_session");
    expect(payload.last_dispatched_at).toBeNull();
    expect(payload.hash_age_hours).toBeNull();
    expect(payload.checked_at).toBe("2026-05-02T12:00:00.000Z");
  });

  // ── Within interval, same hash ────────────────────────────────────────────

  it("skips dispatch when hash matches and interval has not elapsed", () => {
    // Last session was 6 hours ago, interval is 24h → skip
    const dispatchedAt = new Date("2026-05-02T06:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // 6 hours later

    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    expect(payload.should_dispatch).toBe(false);
    expect(payload.reason).toBe("skip_same_hash");
    expect(payload.last_dispatched_at).toBe(dispatchedAt);
    expect(payload.hash_age_hours).toBeCloseTo(6, 1);
  });

  // ── Within interval, different hash ──────────────────────────────────────

  it("skips dispatch when hash differs but interval has not elapsed", () => {
    const dispatchedAt = new Date("2026-05-02T10:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // 2 hours later

    const payload = getBrainstormGatePayload(store, HASH_B, 24, now);

    expect(payload.should_dispatch).toBe(false);
    expect(payload.reason).toBe("skip_within_interval");
    expect(payload.hash_age_hours).toBeNull(); // different hash → no prior match
  });

  // ── Interval elapsed, same hash ───────────────────────────────────────────

  it("allows dispatch when interval elapsed even though hash matches", () => {
    const dispatchedAt = new Date("2026-05-01T10:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // 26 hours later

    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    expect(payload.should_dispatch).toBe(true);
    expect(payload.reason).toBe("interval_elapsed");
    expect(payload.hash_age_hours).toBeCloseTo(26, 0);
  });

  // ── Interval elapsed, different hash ─────────────────────────────────────

  it("allows dispatch when interval elapsed and hash changed", () => {
    const dispatchedAt = new Date("2026-05-01T10:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // 26 hours later

    const payload = getBrainstormGatePayload(store, HASH_B, 24, now);

    expect(payload.should_dispatch).toBe(true);
    expect(payload.reason).toBe("hash_changed");
    expect(payload.hash_age_hours).toBeNull();
  });

  // ── Exactly on the interval boundary ─────────────────────────────────────

  it("allows dispatch when elapsed time exactly equals minIntervalHours", () => {
    const dispatchedAt = new Date("2026-05-01T12:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // exactly 24h later

    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    // elapsed (24h) >= minIntervalHours (24h) → allow
    expect(payload.should_dispatch).toBe(true);
    expect(payload.reason).toBe("interval_elapsed");
  });

  // ── checked_at is set to the provided now ────────────────────────────────

  it("sets checked_at to the provided now", () => {
    const store = makeNullStore();
    const now = new Date("2026-05-02T15:30:00Z");
    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    expect(payload.checked_at).toBe("2026-05-02T15:30:00.000Z");
  });

  // ── last_dispatched_at is populated when a session exists ─────────────────

  it("includes last_dispatched_at from the previous session", () => {
    const dispatchedAt = "2026-05-01T08:00:00.000Z";
    const store = makeSessionStore(makeRow({ dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z");

    const payload = getBrainstormGatePayload(store, HASH_A, 24, now);

    expect(payload.last_dispatched_at).toBe(dispatchedAt);
  });

  // ── Custom interval ───────────────────────────────────────────────────────

  it("respects a custom minIntervalHours", () => {
    const dispatchedAt = new Date("2026-05-02T10:00:00Z").toISOString();
    const store = makeSessionStore(makeRow({ fleet_hash: HASH_A, dispatched_at: dispatchedAt }));
    const now = new Date("2026-05-02T12:00:00Z"); // 2 hours later

    // With a 1-hour interval, 2 hours elapsed → allow
    const payload = getBrainstormGatePayload(store, HASH_A, 1, now);
    expect(payload.should_dispatch).toBe(true);
    expect(payload.reason).toBe("interval_elapsed");
  });
});

// ── parseBrainstormGateParams ────────────────────────────────────────────────

describe("parseBrainstormGateParams", () => {
  it("returns ok=true for a valid 64-char hex fleet_hash", () => {
    const result = parseBrainstormGateParams({ fleet_hash: HASH_A });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fleetHash).toBe(HASH_A);
    }
  });

  it("normalises uppercase hex to lowercase", () => {
    const result = parseBrainstormGateParams({ fleet_hash: HASH_A.toUpperCase() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fleetHash).toBe(HASH_A);
    }
  });

  it("trims surrounding whitespace", () => {
    const result = parseBrainstormGateParams({ fleet_hash: `  ${HASH_A}  ` });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fleetHash).toBe(HASH_A);
    }
  });

  it("returns ok=false when fleet_hash is missing", () => {
    const result = parseBrainstormGateParams({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/fleet_hash/i);
    }
  });

  it("returns ok=false when fleet_hash is an empty string", () => {
    const result = parseBrainstormGateParams({ fleet_hash: "" });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when fleet_hash is whitespace-only", () => {
    const result = parseBrainstormGateParams({ fleet_hash: "   " });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when fleet_hash is too short", () => {
    const result = parseBrainstormGateParams({ fleet_hash: "abc123" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/64-character/i);
    }
  });

  it("returns ok=false when fleet_hash contains non-hex characters", () => {
    const badHash = "z".repeat(64);
    const result = parseBrainstormGateParams({ fleet_hash: badHash });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when fleet_hash is 65 chars (too long)", () => {
    const result = parseBrainstormGateParams({ fleet_hash: "a".repeat(65) });
    expect(result.ok).toBe(false);
  });

  it("returns ok=false when fleet_hash is a non-string type", () => {
    const result = parseBrainstormGateParams({ fleet_hash: 12345 });
    expect(result.ok).toBe(false);
  });
});

// ── Integration: StateStore brainstorm_sessions table ────────────────────────

describe("StateStore brainstorm_sessions", () => {
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

  it("returns null when no sessions have been recorded", () => {
    const { store } = fixture();
    expect(store.getLastBrainstormSession()).toBeNull();
  });

  it("returns the recorded session after recording", () => {
    const { store } = fixture();
    store.recordBrainstormSession({
      fleet_hash: HASH_A,
      failure_rate: 0.1,
      open_issues_count: 5,
      mergeable_prs_count: 2,
    });

    const row = store.getLastBrainstormSession();
    expect(row).not.toBeNull();
    expect(row!.fleet_hash).toBe(HASH_A);
    expect(row!.failure_rate).toBe(0.1);
    expect(row!.open_issues_count).toBe(5);
    expect(row!.mergeable_prs_count).toBe(2);
    expect(typeof row!.dispatched_at).toBe("string");
  });

  it("returns the most recent session when multiple exist", () => {
    const { store } = fixture();

    store.recordBrainstormSession({
      fleet_hash: HASH_A,
      dispatched_at: "2026-05-01T08:00:00.000Z",
    });
    store.recordBrainstormSession({
      fleet_hash: HASH_B,
      dispatched_at: "2026-05-02T10:00:00.000Z",
    });

    const row = store.getLastBrainstormSession();
    expect(row!.fleet_hash).toBe(HASH_B);
    expect(row!.dispatched_at).toBe("2026-05-02T10:00:00.000Z");
  });

  it("persists null optional fields as null", () => {
    const { store } = fixture();
    store.recordBrainstormSession({ fleet_hash: HASH_A });

    const row = store.getLastBrainstormSession();
    expect(row!.failure_rate).toBeNull();
    expect(row!.open_issues_count).toBeNull();
    expect(row!.mergeable_prs_count).toBeNull();
  });

  it("integrates with getBrainstormGatePayload end-to-end", () => {
    const { store } = fixture();

    // No session yet → allow
    const initial = getBrainstormGatePayload(store, HASH_A, 24);
    expect(initial.should_dispatch).toBe(true);
    expect(initial.reason).toBe("no_prior_session");

    // Record the session
    store.recordBrainstormSession({ fleet_hash: HASH_A });

    // Same hash, just recorded → within interval (< 24h) → skip
    const after = getBrainstormGatePayload(store, HASH_A, 24);
    expect(after.should_dispatch).toBe(false);
    expect(after.reason).toBe("skip_same_hash");
    expect(after.hash_age_hours).toBeGreaterThanOrEqual(0);
    expect(after.hash_age_hours!).toBeLessThan(0.01); // just recorded
  });
});
