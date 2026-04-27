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

  it("sends an alert when 3 events for the same issue occur within the 30-minute window", async () => {
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

  it("does not alert when events span different issues (per-issue threshold)", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Three events but across three different issues — no single issue hits threshold.
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#251", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#252", minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("alerts when one issue is dispatched threshold times even if other issues are fine", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Issue #250 — three times → alert
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#251", minutesAgo: 15 })); // different issue
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5 }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("applies per-issue cooldown: no second alert within 2 hours for same issue", async () => {
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

  it("allows a second alert for a different issue during cooldown of the first", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Issue #250 triggers alert.
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 1 }));
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockClear();

    // Issue #999 independently reaches threshold — should fire its own alert.
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 0 }));
    expect(fetchMock).toHaveBeenCalledOnce();
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

  it("isInCooldownForIssue() returns true only for the alerted issue", async () => {
    mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 1 }));

    expect(detector.isInCooldownForIssue("rapartlu/agent-reviewer:#250")).toBe(true);
    expect(detector.isInCooldownForIssue("rapartlu/agent-reviewer:#999")).toBe(false);
  });

  it("alert can fire again after the cooldown expires", async () => {
    mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({
      cooldownMinutes: 120,
    }));

    const alertTime = new Date(Date.now() - 121 * 60 * 1000); // 121 min ago

    // Simulate a past alert by setting lastAlertAtPerIssue directly.
    (detector as unknown as { lastAlertAtPerIssue: Map<string, Date> })
      .lastAlertAtPerIssue.set("rapartlu/agent-reviewer:#250", alertTime);

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

  it("getWindowEventsForIssue() returns only events for the specified issue", async () => {
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    const e250a = makeEvent({ issueRef: "#250", minutesAgo: 10 });
    const e250b = makeEvent({ issueRef: "#250", minutesAgo: 5 });
    const e999 = makeEvent({ issueRef: "#999", minutesAgo: 8 });

    await detector.recordEvent(e250a);
    await detector.recordEvent(e250b);
    await detector.recordEvent(e999);

    const events250 = detector.getWindowEventsForIssue("rapartlu/agent-reviewer", "#250");
    expect(events250).toHaveLength(2);
    expect(events250.map((e) => e.taskId)).toEqual(
      expect.arrayContaining([e250a.taskId, e250b.taskId]),
    );

    const events999 = detector.getWindowEventsForIssue("rapartlu/agent-reviewer", "#999");
    expect(events999).toHaveLength(1);
  });

  it("alert message contains dispatch count and issue ref", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig({ windowMinutes: 30 }));

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain("#250");
    expect(body.text).toContain("3 times");
    expect(body.text).toContain("30 minutes");
  });

  it("alert message contains PR URL when provided", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());
    const prUrl = "https://github.com/rapartlu/agent-reviewer/pull/251";

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20, prUrl }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10, prUrl }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5, prUrl }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain(prUrl);
  });

  it("alert message contains /suppress command", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5 }));

    const [_url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string) as { text: string };

    expect(body.text).toContain("/suppress");
    expect(body.text).toContain("rapartlu/agent-reviewer");
    expect(body.text).toContain("250");
  });

  it("suppress() prevents future alerts for the suppressed issue", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    detector.suppress("rapartlu/agent-reviewer", "#250");

    // Even though 3 events come in, no alert should fire.
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppress() only suppresses the targeted issue, not others", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    detector.suppress("rapartlu/agent-reviewer", "#250");

    // Issue #999 is not suppressed — should still alert.
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#999", minutesAgo: 5 }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("suppress() accepts bare issue numbers without '#' prefix", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Suppress using bare number.
    detector.suppress("rapartlu/agent-reviewer", "250");

    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: "#250", minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isSuppressed() returns true after suppress() and false after unsuppress()", () => {
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    expect(detector.isSuppressed("rapartlu/agent-reviewer", "#250")).toBe(false);
    detector.suppress("rapartlu/agent-reviewer", "#250");
    expect(detector.isSuppressed("rapartlu/agent-reviewer", "#250")).toBe(true);
    detector.unsuppress("rapartlu/agent-reviewer", "#250");
    expect(detector.isSuppressed("rapartlu/agent-reviewer", "#250")).toBe(false);
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

  it("events with null issueRef are recorded but do not trigger per-issue alerts", async () => {
    const fetchMock = mockFetch();
    const detector = new DuplicateDispatchSurgeDetector(makeConfig());

    // Events without issueRef should not count toward per-issue threshold.
    await detector.recordEvent(makeEvent({ issueRef: null, minutesAgo: 20 }));
    await detector.recordEvent(makeEvent({ issueRef: null, minutesAgo: 10 }));
    await detector.recordEvent(makeEvent({ issueRef: null, minutesAgo: 5 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
