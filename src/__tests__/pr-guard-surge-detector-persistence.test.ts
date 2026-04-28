/**
 * Tests for PRGuardSurgeDetector DB persistence (issue #468):
 *   - surgeSuppressionStore writes on suppression trigger
 *   - loadSuppressionsFromStore() restores in-memory state on startup
 *   - isSuppressionActive() checks DB as fallback when in-memory has no entry
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  PRGuardSurgeDetector,
  type PRGuardHit,
  type PRGuardSurgeConfig,
  PR_GUARD_SUPPRESSION_TTL_MINUTES,
} from "../reviewer/pr-guard-surge-detector.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpStore(): { store: StateStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "pr-guard-surge-persist-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  return { store, dir };
}

function makeConfig(
  overrides: Partial<PRGuardSurgeConfig> = {},
): PRGuardSurgeConfig {
  return {
    telegramBotToken: "test-token",
    telegramChatId: "-100123456789",
    surgeThreshold: 2,
    windowMs: 60 * 60 * 1000,
    cooldownMs: 60 * 60 * 1000,
    suppressionThreshold: 3,       // low threshold so tests don't need many hits
    suppressionWindowMs: 30 * 60 * 1000,
    suppressionTtlMinutes: 120,
    ...overrides,
  };
}

function makeHit(overrides: Partial<PRGuardHit> & { minutesAgo?: number } = {}): PRGuardHit {
  const { minutesAgo = 0, ...rest } = overrides;
  return {
    repo: "rapartlu/research-agent",
    issueNumber: 133,
    prUrl: "https://github.com/rapartlu/research-agent/pull/162",
    timestamp: new Date(Date.now() - minutesAgo * 60_000),
    ...rest,
  };
}

function mockFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => "OK",
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PRGuardSurgeDetector — DB persistence (issue #468)", () => {
  const dirs: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function makeStore(): { store: StateStore; dir: string } {
    const result = makeTmpStore();
    dirs.push(result.dir);
    return result;
  }

  it("writes suppression entry to surgeSuppressionStore when threshold is reached", async () => {
    const { store } = makeStore();
    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: store }),
    );

    // Reach the suppressionThreshold (3)
    await detector.recordHit(makeHit({ minutesAgo: 5 }));
    await detector.recordHit(makeHit({ minutesAgo: 3 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    // DB should now have an active entry
    expect(
      store.isPRGuardSurgeSuppressionActive("rapartlu/research-agent", 133),
    ).toBe(true);

    const active = store.listActivePRGuardSurgeSuppressions();
    expect(active).toHaveLength(1);
    expect(active[0].repo).toBe("rapartlu/research-agent");
    expect(active[0].issueNumber).toBe(133);
    // suppressed_until should be ~120 minutes from the triggering hit's timestamp.
    // The last hit has minutesAgo:1, so suppressedUntil ≈ now + 119min.
    // Allow a 2-minute tolerance to account for the minutesAgo offset and execution time.
    const suppressedUntil = new Date(active[0].suppressedUntil);
    const diffMs = suppressedUntil.getTime() - Date.now();
    expect(diffMs).toBeGreaterThan(117 * 60_000);
    expect(diffMs).toBeLessThan(121 * 60_000);
  });

  it("does not write to DB when surgeSuppressionStore is not configured", async () => {
    const { store } = makeStore();
    // Detector without surgeSuppressionStore
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit({ minutesAgo: 5 }));
    await detector.recordHit(makeHit({ minutesAgo: 3 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    // No rows should exist in the DB
    expect(store.listActivePRGuardSurgeSuppressions()).toHaveLength(0);
  });

  it("loadSuppressionsFromStore() restores in-memory state from DB", () => {
    const { store } = makeStore();

    // Manually write a suppression entry to the DB
    const suppressedUntil = new Date(Date.now() + 90 * 60_000); // 90 min from now
    store.setPRGuardSurgeSuppression("rapartlu/research-agent", 133, suppressedUntil);

    // Build a detector with surgeSuppressionStore — constructor calls loadSuppressionsFromStore
    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: store }),
    );

    // In-memory should be populated and isSuppressionActive should return true
    expect(detector.isSuppressionActive("rapartlu/research-agent", 133)).toBe(true);
  });

  it("isSuppressionActive() checks DB when in-memory map has no entry (cross-restart)", () => {
    const { store } = makeStore();

    // Manually write a suppression to DB (simulates a previous process having set it)
    store.setPRGuardSurgeSuppression(
      "rapartlu/research-agent",
      133,
      new Date(Date.now() + 60 * 60_000),
    );

    // Build detector WITHOUT calling loadSuppressionsFromStore (i.e., bypass constructor load
    // by passing a fake store that has the data but no list method for startup)
    const storeWithoutList = {
      setPRGuardSurgeSuppression: store.setPRGuardSurgeSuppression.bind(store),
      isPRGuardSurgeSuppressionActive: store.isPRGuardSurgeSuppressionActive.bind(store),
      listActivePRGuardSurgeSuppressions: () => [] as Array<{ repo: string; issueNumber: number; suppressedUntil: string }>,
    };

    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: storeWithoutList }),
    );

    // In-memory is empty (listActivePRGuardSurgeSuppressions returned []) but
    // isPRGuardSurgeSuppressionActive falls through to DB — should return true
    expect(detector.isSuppressionActive("rapartlu/research-agent", 133)).toBe(true);
  });

  it("does NOT re-fire suppression alert when DB shows suppression active (cross-restart dedup)", async () => {
    const fetchMock = mockFetch();
    const { store } = makeStore();

    // Pre-populate DB with active suppression (simulates pre-restart state)
    store.setPRGuardSurgeSuppression(
      "rapartlu/research-agent",
      133,
      new Date(Date.now() + 90 * 60_000),
    );

    // Detector loads from DB on construction
    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: store }),
    );

    // Reach suppression threshold again — should NOT fire another alert
    await detector.recordHit(makeHit({ minutesAgo: 5 }));
    await detector.recordHit(makeHit({ minutesAgo: 3 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    // The surge alert fires (hit surge threshold of 2) but suppression alert must NOT fire
    // (suppression is already active from DB load).
    // Verify that no "🚫 /pr-guard-suppression:" message was sent.
    const suppressionCalls = fetchMock.mock.calls.filter((call) => {
      const body = call[1]?.body as string | undefined;
      return body?.includes("pr-guard-suppression") ?? false;
    });
    expect(suppressionCalls).toHaveLength(0);
  });

  it("isSuppressionActive() returns false when DB entry has expired", () => {
    const { store, dir: _dir } = makeStore();

    // Use a raw writer to insert an expired entry
    const Database = require("better-sqlite3");
    const db = new Database(join(_dir, "state.db"));
    db.prepare(
      `INSERT INTO pr_guard_surge_suppressions (repo, issue_number, suppressed_until)
       VALUES (?, ?, datetime('now', '-1 minute'))`,
    ).run("rapartlu/research-agent", 133);
    db.close();

    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: store }),
    );

    // Expired entry — should return false
    expect(detector.isSuppressionActive("rapartlu/research-agent", 133)).toBe(false);
  });

  it("suppressed_until in DB matches suppressionTtlMinutes config", async () => {
    const { store } = makeStore();
    const ttl = 60; // override to 60 min for this test
    const detector = new PRGuardSurgeDetector(
      makeConfig({ surgeSuppressionStore: store, suppressionTtlMinutes: ttl }),
    );

    const before = Date.now();
    await detector.recordHit(makeHit({ minutesAgo: 5 }));
    await detector.recordHit(makeHit({ minutesAgo: 3 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));
    const after = Date.now();

    const active = store.listActivePRGuardSurgeSuppressions();
    expect(active).toHaveLength(1);

    const suppressedUntilMs = new Date(active[0].suppressedUntil).getTime();
    // suppressedUntil is computed from hit.timestamp (which is minutesAgo:1 = ~60s behind now),
    // so suppressedUntil ≈ before + (ttl-1)*60s.  Allow a 90-second lower tolerance.
    expect(suppressedUntilMs).toBeGreaterThanOrEqual(before + (ttl - 1) * 60_000 - 5_000);
    expect(suppressedUntilMs).toBeLessThanOrEqual(after + ttl * 60_000 + 5_000);
  });

  it("exported PR_GUARD_SUPPRESSION_TTL_MINUTES constant is 120", () => {
    expect(PR_GUARD_SUPPRESSION_TTL_MINUTES).toBe(120);
  });
});
