/**
 * Telegram notification module for escalations and alerts.
 *
 * DISCIPLINE: Telegram is an escalation channel, not a feed.
 * Only send messages when the fleet genuinely needs Operator input/action.
 *
 * Configuration (via environment variables or ReviewerConfig.telegram):
 *   TELEGRAM_BOT_TOKEN  — Telegram bot token from @BotFather
 *   TELEGRAM_CHAT_ID    — Chat ID to send notifications to
 *
 * Usage (SIGNAL — Operator input needed):
 *   const notify = createNotifier();
 *   await notify.emitOperatorEscalation("quality-floor-bypass", "Quality Floor Bypass", body, "high");
 *   await notify.emitOperatorEscalation("task-needs-review", "Task Needs Review", body, "medium");
 *   await notify.emitOperatorEscalation("charter-amendment", "Charter Amendment Proposal", body, "high");
 *
 * Usage (NOISE — Log only, no Telegram):
 *   log.info("Low-score approval", { score, task_id });  // Not notifyOperator
 *   log.info("Quality summary", { report });              // Query via /quality-summary command
 *   log.info("Standup synthesis fallback", { count });    // Operational metric
 */

import { createLogger } from "./service/logger.js";
import { formatDurationShort } from "./health-recovery.js";
import type { SemanticMemoryDigestReport } from "./state/types.js";
import { formatMemoryDigest } from "./reviewer/memory-digest.js";

const log = createLogger("notify");

/** Urgency level for operator notifications. */
export type NotifyUrgency = "low" | "medium" | "high";

export interface Notifier {
  /**
   * SIGNAL PATH (Operator action required):
   * Gated escalation channel — only for issues requiring Operator input/decision.
   * Automatically rate-limited to prevent flooding.
   * Categories: quality-floor-bypass, task-needs-review, charter-amendment,
   * operator-only-action, existential-outage, irreversible-commitment
   */
  emitOperatorEscalation(
    category: string,
    title: string,
    body: string,
    urgency: NotifyUrgency,
  ): Promise<boolean>;

  /**
   * DEPRECATED: Use emitOperatorEscalation instead.
   * This method is being phased out as part of noise suppression (#564).
   * Send an operator notification with urgency level.
   * Rate-limited to max 1 message per (title, urgency) type per 15 minutes.
   * Returns true if the message was sent, false if suppressed by the rate limit.
   */
  notifyOperator(title: string, body: string, urgency: NotifyUrgency): Promise<boolean>;

  /** Send a raw message to the configured chat. */
  send(text: string): Promise<void>;
  /** Send a structured PR escalation alert. */
  escalation(repo: string, prNumber: number, reason: string): Promise<void>;
  /** Send a structured task rejection alert. */
  taskRejected(taskId: string, agentName: string, score: number, notes: string): Promise<void>;
  /**
   * Post a supervisor decision to Telegram.
   * Only posts for concrete actions (not "none") to avoid noise.
   */
  supervisorDecision(
    action: string,
    reason: string,
    opts?: { agentName?: string; message?: string; issueRef?: string; outcome?: string },
  ): Promise<void>;
  /**
   * Send a recovery notice when an agent transitions from failing to passing.
   * This path is deliberately not rate-limited; the recovery tracker ensures
   * one notification per incident.
   */
  healthRecovery(agentName: string, degradedForMs: number, confirmationCycles?: number): Promise<void>;
  /**
   * Send the daily semantic memory digest.
   * Formats the three sections (top queried, repeated attempts, low confidence)
   * and sends as a single Markdown message.
   */
  memoryDigest(report: SemanticMemoryDigestReport): Promise<void>;
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

    async emitOperatorEscalation(
      category: string,
      title: string,
      body: string,
      urgency: NotifyUrgency,
    ): Promise<boolean> {
      if (!resolved) {
        log.warn("Telegram notifier not configured — skipping emitOperatorEscalation", {
          category,
          title,
          urgency,
        });
        return false;
      }

      const rateKey = `${category}::${urgency}`;
      const now = Date.now();
      const last = lastSentAt.get(rateKey);

      if (last !== undefined && now - last < rateLimitMs) {
        log.info("emitOperatorEscalation suppressed by rate limit", {
          category,
          title,
          urgency,
          nextAllowedIn: Math.ceil((rateLimitMs - (now - last)) / 1000),
        });
        return false;
      }

      const icon = URGENCY_ICON[urgency];
      const text = [
        `${icon} *[${category}] ${title}*`,
        ``,
        body.slice(0, 1000),
      ].join("\n");

      await this.send(text);
      lastSentAt.set(rateKey, now);
      return true;
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

    async healthRecovery(
      agentName: string,
      degradedForMs: number,
      confirmationCycles: number = 3,
    ): Promise<void> {
      if (!resolved) {
        log.warn("Telegram notifier not configured — skipping healthRecovery", {
          agentName,
          confirmationCycles,
        });
        return;
      }

      const degradedFor = formatDurationShort(degradedForMs);
      const text = [
        `✅ *${agentName} recovered after ${degradedFor}*`,
        ``,
        `*Agent:* \`${agentName}\``,
        `*Degraded for:* ${degradedFor}`,
        `*Status:* now passing`,
        `*Confirmation:* ${confirmationCycles} consecutive healthy checks`,
      ].join("\n");

      await this.send(text);
    },

    async memoryDigest(report: SemanticMemoryDigestReport): Promise<void> {
      const text = formatMemoryDigest(report);
      await this.send(text);
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

const defaultNotifier = createNotifier();

/**
 * Backwards-compatible module-level operator notifier.
 *
 * Some survival-plan and escalation helpers import a named `notifyOperator`
 * function directly. Keep that surface available while the rest of the code
 * continues to prefer `createNotifier()`.
 */
export async function notifyOperator(
  title: string,
  body: string,
  urgency: NotifyUrgency,
): Promise<boolean> {
  return defaultNotifier.notifyOperator(title, body, urgency);
}
