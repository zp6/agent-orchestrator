import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PreexistingFailureTracker,
  PREEXISTING_SKIP_THRESHOLD,
  PREEXISTING_SKIP_WINDOW_MS,
  PREEXISTING_ALERT_COOLDOWN_MS,
  type PreexistingSkip,
  type PreexistingSkipRow,
  type IPreexistingFailureStore,
} from "../reviewer/preexisting-failure-tracker.js";

// ── In-memory store stub ───────────────────────────────────────────────────────

class InMemorySkipStore implements IPreexistingFailureStore {
  private rows: PreexistingSkipRow[] = [];

  insertPreexistingSkip(skip: PreexistingSkipRow): void {
    this.rows.push(skip);
  }

  getPreexistingSkipsInWindow(
    repo: string,
    pattern: string,
    windowStart: Date,
    windowEnd: Date,
  ): PreexistingSkipRow[] {
    return this.rows.filter(
      (r) =>
        r.repo === repo &&
        r.pattern === pattern &&
        r.skipped_at >= windowStart.toISOString() &&
        r.skipped_at <= windowEnd.toISOString(),
    );
  }

  all(): PreexistingSkipRow[] {
    return this.rows;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

interface ConfigOverrides {
  telegramBotToken?: string;
  telegramChatId?: string;
  store?: IPreexistingFailureStore;
  threshold?: number;
  windowMs?: number;
  alertCooldownMs?: number;
}

function makeTracker(
  store: IPreexistingFailureStore,
  overrides: Omit<ConfigOverrides, "store"> = {},
) {
  return new PreexistingFailureTracker({
    telegramBotToken: "test-token",
    telegramChatId:   "test-chat",
    store,
    ...overrides,
  });
}

function makeSkip(
  overrides: Partial<PreexistingSkip> & { daysAgo?: number } = {},
): PreexistingSkip {
  const { daysAgo = 0, ...rest } = overrides;
  const skippedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    repo:      "rapartlu/agent-orchestrator",
    pattern:   "Error: Cannot find module './dist/service/daemon'",
    prNumber:  1000,
    skippedAt,
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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("PreexistingFailureTracker", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Constants ──────────────────────────────────────────────────────────────

  it("exports correct default constants", () => {
    expect(PREEXISTING_SKIP_THRESHOLD).toBe(3);
    expect(PREEXISTING_SKIP_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(PREEXISTING_ALERT_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
  });

  // ── Below threshold — no alert ─────────────────────────────────────────────

  it("does not send alert for a single skip", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.all()).toHaveLength(1);
  });

  it("does not send alert for 2 distinct PRs (below threshold of 3)", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Threshold reached — alert fires ───────────────────────────────────────

  it("sends alert when 3 distinct PRs are recorded", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003 }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.chat_id).toBe("test-chat");
    expect(body.text).toContain("⚠️");
    expect(body.text).toContain("rapartlu/agent-orchestrator");
    expect(body.text).toContain("3+ times");
  });

  it("alert fires on the 3rd unique PR, not the 4th", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
    expect(fetchMock).not.toHaveBeenCalled();

    await tracker.recordSkip(makeSkip({ prNumber: 1003 }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── Duplicate PR numbers don't inflate count ───────────────────────────────

  it("does not inflate count when the same PR is recorded multiple times", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    // Record the same PR 5 times — only counts as 1 distinct PR.
    for (let i = 0; i < 5; i++) {
      await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    }

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts same PR number + different repo as distinct keys", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store, { threshold: 2 });

    await tracker.recordSkip(makeSkip({ repo: "rapartlu/repo-a", prNumber: 1 }));
    await tracker.recordSkip(makeSkip({ repo: "rapartlu/repo-b", prNumber: 1 }));

    // repo-a has only 1 PR, repo-b has only 1 PR — threshold is 2, so no alert.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Rolling window ─────────────────────────────────────────────────────────

  it("does not count skips older than windowMs", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    // Use a 1-day window.
    const tracker = makeTracker(store, { windowMs: 24 * 60 * 60 * 1000 });

    // Two skips within the last day.
    await tracker.recordSkip(makeSkip({ prNumber: 1001, daysAgo: 0 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002, daysAgo: 0 }));
    // One skip 2 days ago — outside the 1-day window.
    await tracker.recordSkip(makeSkip({ prNumber: 1003, daysAgo: 2 }));

    // Only 2 PRs within window — below threshold of 3.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes skips within the window when counting", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store, { windowMs: 5 * 24 * 60 * 60 * 1000 }); // 5-day window

    await tracker.recordSkip(makeSkip({ prNumber: 1001, daysAgo: 4 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002, daysAgo: 3 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003, daysAgo: 1 }));

    // All 3 PRs within 5-day window → alert fires.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── Alert deduplication (cooldown) ────────────────────────────────────────

  it("does not send a second alert within the cooldown window", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    // First alert fires at PR 1003.
    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003 }));
    expect(fetchMock).toHaveBeenCalledOnce();

    // PR 1004 would normally re-trigger (4 distinct PRs ≥ threshold).
    // But dedup cooldown is active — second alert must not fire.
    await tracker.recordSkip(makeSkip({ prNumber: 1004 }));
    expect(fetchMock).toHaveBeenCalledOnce(); // still only 1 call
  });

  it("fires again after the cooldown expires", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    // Use a 1-ms cooldown so we can expire it immediately.
    const tracker = makeTracker(store, { alertCooldownMs: 1 });

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003 }));
    expect(fetchMock).toHaveBeenCalledOnce();

    // Wait for cooldown to expire.
    await new Promise((r) => setTimeout(r, 5));

    await tracker.recordSkip(makeSkip({ prNumber: 1004 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── isInCooldown ───────────────────────────────────────────────────────────

  it("isInCooldown returns false when no alert has been sent", () => {
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);
    expect(tracker.isInCooldown("rapartlu/agent-orchestrator::some-pattern")).toBe(false);
  });

  it("isInCooldown returns true immediately after alert fires", async () => {
    mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003 }));

    const pattern = "Error: Cannot find module './dist/service/daemon'";
    expect(
      tracker.isInCooldown(`rapartlu/agent-orchestrator::${pattern}`),
    ).toBe(true);
  });

  // ── Different patterns are independent ────────────────────────────────────

  it("different patterns are tracked independently", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    const patternA = "Error: pattern-a";
    const patternB = "Error: pattern-b";

    // 3 distinct PRs for pattern-a → alert fires for pattern-a.
    await tracker.recordSkip(makeSkip({ prNumber: 1001, pattern: patternA }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002, pattern: patternA }));
    await tracker.recordSkip(makeSkip({ prNumber: 1003, pattern: patternA }));
    expect(fetchMock).toHaveBeenCalledOnce();

    // Only 1 distinct PR for pattern-b → no additional alert.
    await tracker.recordSkip(makeSkip({ prNumber: 1001, pattern: patternB }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("alert fires independently for each (repo, pattern) pair", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    const repoA = "rapartlu/repo-a";
    const repoB = "rapartlu/repo-b";
    const pat   = "Error: shared-pattern";

    for (const prNumber of [1, 2, 3]) {
      await tracker.recordSkip({ repo: repoA, pattern: pat, prNumber });
    }
    expect(fetchMock).toHaveBeenCalledOnce();

    for (const prNumber of [1, 2, 3]) {
      await tracker.recordSkip({ repo: repoB, pattern: pat, prNumber });
    }
    // Separate (repo, pattern) key — second alert must fire.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Custom threshold ───────────────────────────────────────────────────────

  it("respects custom threshold override", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store, { threshold: 5 });

    for (let i = 1; i <= 4; i++) {
      await tracker.recordSkip(makeSkip({ prNumber: i }));
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await tracker.recordSkip(makeSkip({ prNumber: 5 }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // ── buildAlertMessage ──────────────────────────────────────────────────────

  it("buildAlertMessage includes repo, count, and window days", () => {
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    const msg = tracker.buildAlertMessage(
      "rapartlu/agent-orchestrator",
      "Error: Cannot find module",
      4,
    );

    expect(msg).toContain("⚠️");
    expect(msg).toContain("rapartlu/agent-orchestrator");
    expect(msg).toContain("3+ times");
    expect(msg).toContain("Error: Cannot find module");
    expect(msg).toContain("4 distinct PRs");
    expect(msg).toContain("7 days");
  });

  it("buildAlertMessage truncates very long patterns", () => {
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    const longPattern = "a".repeat(300);
    const msg = tracker.buildAlertMessage("rapartlu/repo", longPattern, 3);

    expect(msg).toContain("…");
    // The displayed pattern must be ≤ 120 chars + "…"
    const patternLine = msg.split("\n").find((l) => l.startsWith("Pattern:"))!;
    expect(patternLine.length).toBeLessThan(200);
  });

  // ── Telegram not configured ────────────────────────────────────────────────

  it("does not throw when Telegram is not configured", async () => {
    const fetchMock = mockFetch();
    const store = new InMemorySkipStore();
    const tracker = new PreexistingFailureTracker({
      telegramBotToken: "",
      telegramChatId:   "",
      store,
    });

    // 3 distinct PRs → threshold reached, but Telegram is unconfigured.
    await expect(
      (async () => {
        await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
        await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
        await tracker.recordSkip(makeSkip({ prNumber: 1003 }));
      })(),
    ).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Telegram failure resilience ────────────────────────────────────────────

  it("does not throw when Telegram API returns an error", async () => {
    mockFetch(false /* ok = false */);
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    // Should not throw even if Telegram returns 500.
    await expect(
      (async () => {
        await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
        await tracker.recordSkip(makeSkip({ prNumber: 1002 }));
        await tracker.recordSkip(makeSkip({ prNumber: 1003 }));
      })(),
    ).resolves.toBeUndefined();
  });

  it("does not throw when store.insertPreexistingSkip throws", async () => {
    const fetchMock = mockFetch();
    const store: IPreexistingFailureStore = {
      insertPreexistingSkip: () => {
        throw new Error("DB write failure");
      },
      getPreexistingSkipsInWindow: () => [],
    };
    const tracker = makeTracker(store);

    // insertPreexistingSkip throws, but tracker swallows it and the alert
    // can still be evaluated (window query returns [] → no alert yet).
    await expect(tracker.recordSkip(makeSkip({ prNumber: 1001 }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when store.getPreexistingSkipsInWindow throws", async () => {
    const fetchMock = mockFetch();
    const store: IPreexistingFailureStore = {
      insertPreexistingSkip: () => {},
      getPreexistingSkipsInWindow: () => {
        throw new Error("DB read failure");
      },
    };
    const tracker = makeTracker(store);

    // Query fails → early return, no alert.
    await expect(tracker.recordSkip(makeSkip({ prNumber: 1001 }))).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Persistence ───────────────────────────────────────────────────────────

  it("persists every skip row to the store regardless of threshold", async () => {
    mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);

    await tracker.recordSkip(makeSkip({ prNumber: 1001 }));
    await tracker.recordSkip(makeSkip({ prNumber: 1002 }));

    expect(store.all()).toHaveLength(2);
    expect(store.all()[0]?.pr_number).toBe(1001);
    expect(store.all()[1]?.pr_number).toBe(1002);
  });

  it("persisted rows contain repo, pattern, pr_number, and skipped_at", async () => {
    mockFetch();
    const store = new InMemorySkipStore();
    const tracker = makeTracker(store);
    const now = new Date("2026-04-20T12:00:00.000Z");

    await tracker.recordSkip({
      repo:      "rapartlu/test-repo",
      pattern:   "Test failure pattern",
      prNumber:  42,
      skippedAt: now,
    });

    const row = store.all()[0]!;
    expect(row.repo).toBe("rapartlu/test-repo");
    expect(row.pattern).toBe("Test failure pattern");
    expect(row.pr_number).toBe(42);
    expect(row.skipped_at).toBe(now.toISOString());
  });
});
