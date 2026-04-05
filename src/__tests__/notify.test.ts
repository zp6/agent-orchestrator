import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNotifier } from "../notify.js";

describe("createNotifier", () => {
  it("returns isConfigured=false when no env vars set", () => {
    // Remove env vars for this test
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    const savedChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const notifier = createNotifier();
    expect(notifier.isConfigured()).toBe(false);

    // Restore
    if (savedToken) process.env.TELEGRAM_BOT_TOKEN = savedToken;
    if (savedChat) process.env.TELEGRAM_CHAT_ID = savedChat;
  });

  it("returns isConfigured=true when explicit config is provided", () => {
    const notifier = createNotifier({
      botToken: "test-token",
      chatId: "-123456789",
    });
    expect(notifier.isConfigured()).toBe(true);
  });

  it("send() resolves without throwing when not configured", async () => {
    const notifier = createNotifier(); // no config
    // Should not throw — logs a warning and returns
    await expect(notifier.send("test message")).resolves.toBeUndefined();
  });

  it("escalation() resolves without throwing when not configured", async () => {
    const notifier = createNotifier();
    await expect(
      notifier.escalation("owner/repo", 42, "Merge conflict"),
    ).resolves.toBeUndefined();
  });

  it("taskRejected() resolves without throwing when not configured", async () => {
    const notifier = createNotifier();
    await expect(
      notifier.taskRejected("abc123", "claude-proxy", 0.3, "Missing auth check"),
    ).resolves.toBeUndefined();
  });
});

describe("notifyOperator — rate limiting", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false (no-op) when not configured", async () => {
    const notifier = createNotifier(); // no config
    const result = await notifier.notifyOperator("Deploy failed", "agent is down", "high");
    expect(result).toBe(false);
  });

  it("sends the first message and returns true", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const notifier = createNotifier({ botToken: "tok", chatId: "42" });
    const result = await notifier.notifyOperator("Daily digest", "all good", "low");

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("suppresses a duplicate message within the rate-limit window", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    // Use a 60-second window so we can control time
    const notifier = createNotifier({ botToken: "tok", chatId: "42" }, { rateLimitMs: 60_000 });

    const first = await notifier.notifyOperator("High CPU", "cpu at 99%", "medium");
    const second = await notifier.notifyOperator("High CPU", "cpu at 99%", "medium");

    expect(first).toBe(true);
    expect(second).toBe(false);
    // fetch was only called once (second was rate-limited)
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("allows a message after the rate-limit window expires", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    // Use a 0ms window so the second call is always outside the window
    const notifier = createNotifier({ botToken: "tok", chatId: "42" }, { rateLimitMs: 0 });

    await notifier.notifyOperator("Alert", "body", "high");
    await new Promise((r) => setTimeout(r, 1)); // let a tick pass
    const third = await notifier.notifyOperator("Alert", "body", "high");

    expect(third).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("tracks different (title, urgency) pairs independently", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const notifier = createNotifier({ botToken: "tok", chatId: "42" }, { rateLimitMs: 60_000 });

    // Same title, different urgency — should both send
    await notifier.notifyOperator("Alert", "body", "low");
    await notifier.notifyOperator("Alert", "body", "high");

    // Same (title, urgency) — second should be suppressed
    const dup = await notifier.notifyOperator("Alert", "body", "low");

    expect(dup).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // low + high, not the dup
  });

  it("includes urgency icon and title in the message body", async () => {
    let capturedBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse(init?.body as string).text as string;
      return new Response("{}", { status: 200 });
    });

    const notifier = createNotifier({ botToken: "tok", chatId: "42" });
    await notifier.notifyOperator("Service down", "redis is unreachable", "high");

    expect(capturedBody).toContain("🚨");
    expect(capturedBody).toContain("Service down");
    expect(capturedBody).toContain("redis is unreachable");
  });
});
