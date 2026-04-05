import { describe, it, expect } from "vitest";
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
