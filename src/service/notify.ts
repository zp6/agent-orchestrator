import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "./logger.js";

const log = createLogger("notify");

// Rate limiting: max 1 message per key per configured interval
const rateLimitMap = new Map<string, number>();

/**
 * Default rate limit: 15 minutes between repeated notifications for the same key.
 * Configurable via `notifications.telegram_rate_limit_ms` in agents.yaml.
 */
const DEFAULT_RATE_LIMIT_MS = 15 * 60 * 1000;

/** Module-level override set from agents.yaml. */
let configuredRateLimitMs: number | undefined;

/**
 * Set the Telegram notification rate limit from the loaded config.
 * Called once at daemon startup.
 */
export function setTelegramRateLimitMs(ms: number | undefined): void {
  configuredRateLimitMs = ms;
}

function getRateLimitMs(): number {
  return configuredRateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
}

interface TelegramConfig {
  botToken: string;
  chatId: string;
}

let cachedConfig: TelegramConfig | null | undefined;

function loadTelegramConfig(): TelegramConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;

  try {
    const envPath = join(homedir(), ".claude-orchestrator", ".env");
    const content = readFileSync(envPath, "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) vars[key.trim()] = rest.join("=").trim();
    }

    const botToken = vars.TELEGRAM_BOT_TOKEN;
    const chatId = vars.TELEGRAM_CHAT_ID;
    if (botToken && chatId) {
      cachedConfig = { botToken, chatId };
      return cachedConfig;
    }
  } catch { /* .env not found — notifications disabled */ }

  cachedConfig = null;
  return null;
}

/**
 * Send a notification to the operator via Telegram.
 * Silently no-ops if Telegram is not configured.
 * Rate-limited: max 1 message per rateLimitKey per 15 minutes.
 */
export async function notifyOperator(
  title: string,
  body: string,
  urgency: "info" | "warning" | "critical" = "info",
  rateLimitKey?: string,
): Promise<void> {
  const config = loadTelegramConfig();
  if (!config) return;

  // Rate limiting
  if (rateLimitKey) {
    const lastSent = rateLimitMap.get(rateLimitKey);
    if (lastSent && Date.now() - lastSent < getRateLimitMs()) return;
  }

  const emoji = urgency === "critical" ? "🚨" : urgency === "warning" ? "⚠️" : "🔔";
  const text = `${emoji} *${escapeMarkdown(title)}*\n\n${escapeMarkdown(body)}`;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          parse_mode: "MarkdownV2",
        }),
      },
    );

    if (!res.ok) {
      log.error("Telegram send failed", { status: res.status, statusText: res.statusText });
      return;
    }

    if (rateLimitKey) {
      rateLimitMap.set(rateLimitKey, Date.now());
    }
    log.info("Telegram notification sent", { title, urgency });
  } catch (err) {
    log.error("Telegram send error", { error: err instanceof Error ? err.message : String(err) });
  }
}

function escapeMarkdown(text: string): string {
  // Escape Telegram Markdown v1 special chars (except * which we use for bold)
  return text.replace(/([_\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
