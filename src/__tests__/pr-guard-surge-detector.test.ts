import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PRGuardSurgeDetector,
  PR_GUARD_SURGE_THRESHOLD,
  PR_GUARD_SURGE_WINDOW_MS,
  PR_GUARD_SURGE_COOLDOWN_MS,
} from "../reviewer/pr-guard-surge-detector.js";
import type { PRGuardHit, PRGuardSurgeConfig } from "../reviewer/pr-guard-surge-detector.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<PRGuardSurgeConfig> = {}): PRGuardSurgeConfig {
  return {
    telegramBotToken: "test-bot-token",
    telegramChatId: "-100123456789",
    surgeThreshold: 3,
    windowMs: 60 * 60 * 1000, // 60 minutes
    cooldownMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function makeHit(
  overrides: Partial<PRGuardHit> & { minutesAgo?: number } = {},
): PRGuardHit {
  const { minutesAgo = 0, ...rest } = overrides;
  const timestamp = new Date(Date.now() - minutesAgo * 60 * 1000);
  return {
    repo: "rapartlu/research-agent",
    issueNumber: 133,
    prUrl: "https://github.com/rapartlu/research-agent/pull/162",
    timestamp,
    ...rest,
  };
}

function mockFetch(ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => (ok ? "OK" : "Internal Server Error"),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PRGuardSurgeDetector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constant values ──────────────────────────────────────────────────────────

  it("exports correct default threshold constant (3)", () => {
    expect(PR_GUARD_SURGE_THRESHOLD).toBe(3);
  });

  it("exports correct default window constant (60 minutes)", () => {
    expect(PR_GUARD_SURGE_WINDOW_MS).toBe(60 * 60 * 1000);
  });

  it("exports correct default cooldown constant (60 minutes)", () => {
    expect(PR_GUARD_SURGE_COOLDOWN_MS).toBe(60 * 60 * 1000);
  });

  // ── Below-threshold: no alert ────────────────────────────────────────────────

  it("does not send an alert for a single hit (below threshold)", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send an alert for two hits (below threshold of 3)", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit({ minutesAgo: 30 }));
    await detector.recordHit(makeHit({ minutesAgo: 15 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── At-threshold: alert fires ────────────────────────────────────────────────

  it("sends an alert exactly at threshold (3 hits within 60-minute window)", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit({ minutesAgo: 40 }));
    await detector.recordHit(makeHit({ minutesAgo: 20 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── Alert message format ─────────────────────────────────────────────────────

  it("includes repo, issue number, PR URL, and hit count in the alert message", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit({ minutesAgo: 40 }));
    await detector.recordHit(makeHit({ minutesAgo: 20 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain("research-agent#133");
    expect(body.text).toContain("3x");
    expect(body.text).toContain("rapartlu/research-agent");
    expect(body.text).toContain("https://github.com/rapartlu/research-agent/pull/162");
  });

  it("includes PR number in the headline (e.g. 'PR #162')", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    await detector.recordHit(makeHit({ minutesAgo: 40 }));
    await detector.recordHit(makeHit({ minutesAgo: 20 }));
    await detector.recordHit(makeHit({ minutesAgo: 1 }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    // Headline should match "/pr-guard-surge: research-agent#133 hit 3x in 60min, PR #162"
    expect(body.text).toMatch(/\/pr-guard-surge: research-agent#133 hit 3x in 60min, PR #162/);
  });

  it("buildAlertMessage returns expected format", () => {
    const detector = new PRGuardSurgeDetector(makeConfig());
    const msg = detector.buildAlertMessage(
      "rapartlu/research-agent",
      133,
      "https://github.com/rapartlu/research-agent/pull/162",
      4,
    );
    expect(msg).toContain("⚠️ /pr-guard-surge: research-agent#133 hit 4x in 60min, PR #162");
    expect(msg).toContain("Repo: rapartlu/research-agent");
    expect(msg).toContain("Blocking PR: https://github.com/rapartlu/research-agent/pull/162");
    expect(msg).toContain("Hit count: 4 times in 60 minutes");
  });

  // ── Cooldown dedup ───────────────────────────────────────────────────────────

  it("sends only one alert per surge event (cooldown suppresses subsequent hits)", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());
    const base = new Date();

    // Trigger the first alert (hits 1–3)
    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit({ timestamp: new Date(base.getTime() + i * 1000) }));
    }
    // Two more hits within the cooldown window
    await detector.recordHit(makeHit({ timestamp: new Date(base.getTime() + 30 * 60 * 1000) }));
    await detector.recordHit(makeHit({ timestamp: new Date(base.getTime() + 45 * 60 * 1000) }));

    // Only one alert should have been sent
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fires a second alert after the cooldown window expires", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(
      makeConfig({ cooldownMs: 60 * 60 * 1000 }), // 60-minute cooldown
    );
    const base = new Date("2026-01-01T00:00:00Z");

    // Trigger the first alert (hits 1–3 at T+0..T+2s)
    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit({ timestamp: new Date(base.getTime() + i * 1000) }));
    }

    // 61 minutes later — cooldown has expired; 3 more hits should trigger a second alert
    const afterCooldown = new Date(base.getTime() + 61 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await detector.recordHit(
        makeHit({ timestamp: new Date(afterCooldown.getTime() + i * 1000) }),
      );
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Per-issue independence ───────────────────────────────────────────────────

  it("treats different (repo, issue) pairs independently", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    // 3 hits for issue 133
    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit({ issueNumber: 133 }));
    }
    // 3 hits for issue 150 — should trigger its own separate alert
    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit({ issueNumber: 150 }));
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hits for one issue do not count toward another issue's threshold", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());

    // 2 hits for issue 133 — below threshold
    await detector.recordHit(makeHit({ issueNumber: 133, minutesAgo: 20 }));
    await detector.recordHit(makeHit({ issueNumber: 133, minutesAgo: 10 }));
    // 2 hits for issue 150 — also below threshold
    await detector.recordHit(makeHit({ issueNumber: 150, minutesAgo: 20 }));
    await detector.recordHit(makeHit({ issueNumber: 150, minutesAgo: 10 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Window boundary ──────────────────────────────────────────────────────────

  it("does not count hits that are outside the rolling window", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(
      makeConfig({ windowMs: 60 * 60 * 1000 }), // 60-minute window
    );
    const now = new Date();

    // Two old hits clearly outside the 60-minute window (>65 min ago relative to the recent hit).
    // The window is computed relative to each incoming hit's timestamp, so we use explicit
    // timestamps to avoid boundary ambiguity.
    const oldBase = new Date(now.getTime() - 70 * 60 * 1000); // 70 min ago
    await detector.recordHit(makeHit({ timestamp: new Date(oldBase.getTime()) }));
    await detector.recordHit(makeHit({ timestamp: new Date(oldBase.getTime() + 2 * 60 * 1000) })); // 68 min ago

    // One recent hit at T=now — window covers [now-60min, now]; both old hits are outside
    await detector.recordHit(makeHit({ timestamp: now }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── getWindowHits ────────────────────────────────────────────────────────────

  it("getWindowHits returns only hits within the window for the given pair", async () => {
    const detector = new PRGuardSurgeDetector(makeConfig({ windowMs: 60 * 60 * 1000 }));
    const now = new Date();

    // Old hit outside the window
    await detector.recordHit(makeHit({ minutesAgo: 70 }));
    // Two recent hits inside the window
    await detector.recordHit(makeHit({ minutesAgo: 30, timestamp: new Date(now.getTime() - 30 * 60 * 1000) }));
    await detector.recordHit(makeHit({ minutesAgo: 10, timestamp: new Date(now.getTime() - 10 * 60 * 1000) }));

    const windowHits = detector.getWindowHits("rapartlu/research-agent", 133, now);
    expect(windowHits).toHaveLength(2);
  });

  // ── isInCooldown ─────────────────────────────────────────────────────────────

  it("isInCooldown returns false before any alert has been sent", () => {
    const detector = new PRGuardSurgeDetector(makeConfig());
    expect(detector.isInCooldown("rapartlu/research-agent", 133)).toBe(false);
  });

  it("isInCooldown returns true immediately after an alert fires", async () => {
    mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig());
    const now = new Date();

    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit({ timestamp: new Date(now.getTime() + i) }));
    }

    // Check immediately after — should be in cooldown
    expect(detector.isInCooldown("rapartlu/research-agent", 133, now)).toBe(true);
  });

  // ── Missing Telegram config ──────────────────────────────────────────────────

  it("does not throw when Telegram token is missing", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(
      makeConfig({ telegramBotToken: "", telegramChatId: "" }),
    );

    for (let i = 0; i < 3; i++) {
      await detector.recordHit(makeHit());
    }

    // fetch should not be called with missing config
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Telegram API failure ─────────────────────────────────────────────────────

  it("does not throw when Telegram API returns a non-OK response", async () => {
    mockFetch(false);
    const detector = new PRGuardSurgeDetector(makeConfig());

    await expect(async () => {
      for (let i = 0; i < 3; i++) {
        await detector.recordHit(makeHit());
      }
    }).not.toThrow();
  });

  // ── Custom threshold ─────────────────────────────────────────────────────────

  it("respects a custom surgeThreshold override", async () => {
    const fetchMock = mockFetch();
    const detector = new PRGuardSurgeDetector(makeConfig({ surgeThreshold: 5 }));

    // 4 hits — below custom threshold of 5
    for (let i = 0; i < 4; i++) {
      await detector.recordHit(makeHit());
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // 5th hit — exactly at threshold
    await detector.recordHit(makeHit());
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
