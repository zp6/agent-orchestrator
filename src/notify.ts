/**
 * Telegram notification module for escalations and alerts.
 *
 * Sends messages to a configured Telegram bot/chat when the reviewer
 * escalates PRs, rejects tasks, or detects critical issues.
 *
 * Configuration (via environment variables or ReviewerConfig.telegram):
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — Chat ID to send notifications to
 *
 * Usage:
 *   const notify = createNotifier();
 *   await notify.send("PR #42 escalated: merge conflicts");
 *   await notify.escalation("owner/repo", 42, "Diff too large");
 *   await notify.taskRejected("task-id", "claude-proxy", 0.3, "Missing auth check");
 */

import { createLogger } from "./service/logger.js";

const log = createLogger("notify");

export interface Notifier {
  /** Send a raw message to the configured chat. */
  send(text: string): Promise<void>;
  /** Send a structured PR escalation alert. */
  escalation(repo: string, prNumber: number, reason: string): Promise<void>;
  /** Send a structured task rejection alert. */
  taskRejected(taskId: string, agentName: string, score: number, notes: string): Promise<void>;
  /** Returns true if the notifier is configured (has bot token + chat ID). */
  isConfigured(): boolean;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function resolveConfig(overrides?: Partial<TelegramConfig>): TelegramConfig | null {
  const botToken = overrides?.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
  const chatId = overrides?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

async function sendTelegramMessage(
  config: TelegramConfig,
  text: string,
  parseMode: "Markdown" | "HTML" | "" = "Markdown",
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: config.chatId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
    disable_web_page_preview: true,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => "unknown error");
    throw new Error(`Telegram API error ${resp.status}: ${err}`);
  }
}

/**
 * Create a notifier.
 *
 * @param config Optional explicit config (falls back to environment variables).
 */
export function createNotifier(config?: Partial<TelegramConfig>): Notifier {
  const resolved = resolveConfig(config);

  return {
    isConfigured(): boolean {
      return resolved !== null;
    },

    async send(text: string): Promise<void> {
      if (!resolved) {
        log.warn("Telegram notifier not configured — skipping notification", { text: text.slice(0, 80) });
        return;
      }
      try {
        await sendTelegramMessage(resolved, text);
        log.info("Telegram notification sent", { length: text.length });
      } catch (err) {
        log.error("Failed to send Telegram notification", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    async escalation(repo: string, prNumber: number, reason: string): Promise<void> {
      const text = [
        `🚨 *PR Escalation*`,
        ``,
        `*Repo:* \`${repo}\``,
        `*PR:* [#${prNumber}](https://github.com/${repo}/pull/${prNumber})`,
        `*Reason:* ${reason}`,
        ``,
        `Human review required.`,
      ].join("\n");
      await this.send(text);
    },

    async taskRejected(
      taskId: string,
      agentName: string,
      score: number,
      notes: string,
    ): Promise<void> {
      const text = [
        `⚠️ *Task Rejected*`,
        ``,
        `*Task:* \`${taskId.slice(0, 8)}\``,
        `*Agent:* ${agentName}`,
        `*Score:* ${(score * 100).toFixed(0)}%`,
        `*Notes:* ${notes.slice(0, 200)}`,
      ].join("\n");
      await this.send(text);
    },
  };
}
