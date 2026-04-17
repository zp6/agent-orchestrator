import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DuplicateDispatchSurgeDetector } from "../reviewer/duplicate-dispatch-surge-detector.js";
import type { SurgeEvent, SurgeAlertConfig } from "../reviewer/duplicate-dispatch-surge-detector.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<SurgeAlertConfig> = {}): SurgeAlertConfig {
  return {
    telegramBotToken: "test-bot-token",
    telegramChatId: "-100123456789",
    surgeThreshold: 3,
    windowMinutes: 30,
    cooldownMinutes: 120,
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<SurgeEvent> & { minutesAgo?: number } = {},
): SurgeEvent {
  const { minutesAgo = 0, ...rest } = overrides;
  const timestamp = new Date(Date.now() - minutesAgo * 60 * 1000);
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    repo: "rapartlu/agent-reviewer",
    issueRef: "#250",
    timestamp,
    ...rest,
  };
}

// Capture fetch calls without hitting the network.
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

describe("DuplicateDispatchSurgeDetector", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not send an alert for a single event (below threshold)", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent());

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not send an alert for two events (below threshold)", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an alert when 3 events occur within the 30-minute window", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 1 }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not alert when events are older than the 30-minute window", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Two old events (outside window) + one recent.
    await detector.recordEvent(makeEvent({ minutesAgo: 60 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 45 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies cooldown: no second alert within 2 hours of the first", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Trigger first alert.
    await detector.recordEvent(makeEvent({ minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 1 }));

    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    // New event shortly after — still in cooldown.
    await detector.recordEvent(makeEvent({ minutesAgo: 0 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isInCooldown() returns true after an alert is fired", async () => {
    mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 1 }));

    expect(detector.isInCooldown()).toBe(true);
  });

  it("isInCooldown() returns false before any alert is fired", () => {
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());
    expect(detector.isInCooldown()).toBe(false);
  });

  it("alert can fire again after the cooldown expires", async () => {
    mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({
      cooldownMinutes: 120,
    }));

    const alertTime = new Date(Date.now() - 121 * 60 * 1000); // 121 min ago

    // Simulate a past alert by triggering the cooldown tracking.
    // Access private field via type assertion to set lastAlertAt directly.
    (detector as unknown as { lastAlertAt: Date }).lastAlertAt = alertTime;

    // Cooldown should be expired now.
    expect(detector.isInCooldown()).toBe(false);
  });

  it("getWindowEvents() returns only events within the rolling window", async () => {
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    const recent = makeEvent({ minutesAgo: 10 });
    const old = makeEvent({ minutesAgo: 60 });

    await detector.recordEvent(old);
    await detector.recordEvent(recent);

    const windowEvents = detector.getWindowEvents();
    expect(windowEvents).toHaveLength(1);
    expect(windowEvents[0].taskId).toBe(recent.taskId);
  });

  it("alert message contains affected repo names", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ repo: "rapartlu/agent-reviewer", issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ repo: "rapartlu/agent-dashboard", issueRef: "#327", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ repo: "rapartlu/agent-reviewer", issueRef: "#245", minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain("rapartlu/agent-reviewer");
    expect(body.text).toContain("rapartlu/agent-dashboard");
  });

  it("alert message contains issue refs", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#245", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#327", minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain("#250");
    expect(body.text).toContain("#245");
    expect(body.text).toContain("#327");
  });

  it("alert message contains event count and window label", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({ windowMinutes: 30 }));

    await detector.recordEvent(makeEvent({ minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain("3 already-in-review blocks");
    expect(body.text).toContain("30 minutes");
  });

  it("does not throw when Telegram token is missing", async () => {
    vi.stubGlobal("fetch", vi.fn()); // should not be called
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({
      telegramBotToken: "",
      telegramChatId: "",
    }));

    await detector.recordEvent(makeEvent({ minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ minutesAgo: 10 }));

    // Below threshold anyway, but also shouldn't throw with empty token.
    await expect(
      detector.recordEvent(makeEvent({ minutesAgo: 5 })),
    ).resolves.toBeUndefined();
  });

  it("respects a custom threshold", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({ surgeThreshold: 5 }));

    // 4 events — should NOT alert with threshold=5.
    for (let i = 0; i < 4; i++) {
      await detector.recordEvent(makeEvent({ minutesAgo: i + 1 }));
    }
    expect(fetchMock).not.toHaveBeenCalled();

    // 5th event — should alert.
    await detector.recordEvent(makeEvent({ minutesAgo: 0 }));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("deduplicates issue refs per repo in alert message", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Same issue ref appears twice.
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#245", minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    // "#250" should appear only once in the repo line.
    const repoLine = body.text.split("\n").find((l) => l.includes("rapartlu/agent-reviewer")) ?? "";
    const count250 = (repoLine.match(/#250/g) ?? []).length;
    expect(count250).toBe(1);
  });
});
