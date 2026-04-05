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
 *   await notify.notifyOperator("Deploy failed", "claude-proxy is down", "high");
 */

import { createLogger } from "./service/logger.js";

const log = createLogger("notify");

/** Urgency level for operator notifications. */
export type NotifyUrgency = "low" | "medium" | "high";

export interface Notifier {
  /** Send a raw message to the configured chat. */
  send(text: string): Promise<void>;
  /** Send a structured PR escalation alert. */
  escalation(repo: string, prNumber: number, reason: string): Promise<void>;
  /** Send a structured task rejection alert. */
  taskRejected(taskId: string, agentName: string, score: number, notes: string): Promise<void>;
  /**
   * Send an operator notification with urgency level.
   * Rate-limited to max 1 message per (title, urgency) type per 15 minutes.
   * Returns true if the message was sent, false if suppressed by the rate limit.
   */
  notifyOperator(title: string, body: string, urgency: NotifyUrgency): Promise<boolean>;
  /**
   * Post a supervisor decision to Telegram.
   * Only posts for concrete actions (not "none") to avoid noise.
   */
  supervisorDecision(
    action: string,
    reason: string,
    opts?: { agentName?: string; message?: string; issueRef?: string; outcome?: string },
  ): Promise<void>;
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

/** Rate limit window for notifyOperator: 15 minutes in milliseconds. */
const NOTIFY_RATE_LIMIT_MS = 15 * 60 * 1000;

/** Urgency icons for notifyOperator messages. */
const URGENCY_ICON: Record<NotifyUrgency, string> = {
  low: "ℹ️",
  medium: "⚠️",
  high: "🚨",
};

/**
 * Create a notifier.
 *
 * @param config Optional explicit config (falls back to environment variables).
 * @param opts.rateLimitMs Override the rate limit window (default: 15 minutes). Useful for tests.
 */
export function createNotifier(
  config?: Partial<TelegramConfig>,
  opts: { rateLimitMs?: number } = {},
): Notifier {
  const resolved = resolveConfig(config);
  const rateLimitMs = opts.rateLimitMs ?? NOTIFY_RATE_LIMIT_MS;

  /**
   * Rate-limit map for notifyOperator.
   * Key: `${title}::${urgency}` — tracks the last timestamp a message of that
   * type was sent so we suppress duplicates within the rate-limit window.
   */
  const lastSentAt = new Map<string, number>();

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

    async supervisorDecision(
      action: string,
      reason: string,
      opts: { agentName?: string; message?: string; issueRef?: string; outcome?: string } = {},
    ): Promise<void> {
      // Skip "none" decisions — they would be pure noise
      if (action === "none") return;

      const ACTION_ICON: Record<string, string> = {
        dispatch: "🚀",
        verify: "🔍",
        redeploy: "🔄",
        "create-issue": "📝",
        "follow-up": "↩️",
      };
      const icon = ACTION_ICON[action] ?? "🤖";

      const lines: string[] = [
        `${icon} *Supervisor: ${action}*`,
        ``,
      ];
      if (opts.agentName) lines.push(`*Agent:* \`${opts.agentName}\``);
      if (opts.issueRef) lines.push(`*Issue:* ${opts.issueRef}`);
      lines.push(`*Reason:* ${reason.slice(0, 200)}${reason.length > 200 ? "…" : ""}`);
      if (opts.message) lines.push(`*Message:* ${opts.message.slice(0, 200)}${opts.message.length > 200 ? "…" : ""}`);
      if (opts.outcome && opts.outcome !== "pending") lines.push(`*Outcome:* ${opts.outcome}`);

      await this.send(lines.join("\n"));
    },

    async notifyOperator(
      title: string,
      body: string,
      urgency: NotifyUrgency,
    ): Promise<boolean> {
      if (!resolved) {
        log.warn("Telegram notifier not configured — skipping notifyOperator", { title, urgency });
        return false;
      }

      const rateKey = `${title}::${urgency}`;
      const now = Date.now();
      const last = lastSentAt.get(rateKey);

      if (last !== undefined && now - last < rateLimitMs) {
        log.info("notifyOperator suppressed by rate limit", {
          title,
          urgency,
          nextAllowedIn: Math.ceil((rateLimitMs - (now - last)) / 1000),
        });
        return false;
      }

      const icon = URGENCY_ICON[urgency];
      const text = [
        `${icon} *${title}*`,
        ``,
        body.slice(0, 1000),
      ].join("\n");

      await this.send(text);
      lastSentAt.set(rateKey, now);
      return true;
    },
  };
}
