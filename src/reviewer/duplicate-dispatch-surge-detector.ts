/**
 * Duplicate-dispatch surge detector — issue #262
 *
 * Monitors "already-in-review" guard events (fired by `checkPRExistenceBeforeDispatch()`
 * when an open PR already exists for an issue) and sends a Telegram alert when
 * the count reaches a configurable threshold within a rolling time window.
 *
 * Designed to surface systematic re-queuing loops: if the dispatcher keeps
 * picking up issues that already have open PRs, something upstream is broken.
 *
 * Usage:
 *
 *   const detector = new DuplicateDispatchSurgeDetector({
 *     telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
 *     telegramChatId:   process.env.TELEGRAM_CHAT_ID!,
 *   });
 *
 *   // Call from checkPRExistenceBeforeDispatch() onShortCircuit callback:
 *   await detector.recordEvent({
 *     taskId:    task.id,
 *     repo:      "rapartlu/agent-reviewer",
 *     issueRef:  "#250",
 *     timestamp: new Date(),
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("duplicate-dispatch-surge-detector");

// ── Public types ──────────────────────────────────────────────────────────────

export interface SurgeEvent {
  /** Task ID that was blocked by the PR existence guard. */
  taskId: string;
  /** Repository slug, e.g. "rapartlu/agent-reviewer". */
  repo: string;
  /** Issue reference, e.g. "#250", or null if unavailable. */
  issueRef: string | null;
  /** When the event occurred. */
  timestamp: Date;
}

export interface SurgeAlertConfig {
  /** Telegram bot token from @BotFather. */
  telegramBotToken: string;
  /** Telegram chat ID to send alerts to. */
  telegramChatId: string;
  /**
   * Minimum number of "already-in-review" events within the window before an
   * alert is sent.  Default: 3.
   */
  surgeThreshold?: number;
  /**
   * Rolling window (in minutes) to count events in.  Default: 30.
   */
  windowMinutes?: number;
  /**
   * Cooldown (in minutes) after an alert before another alert can be sent.
   * Default: 120 (2 hours).
   */
  cooldownMinutes?: number;
}

// ── Detector ──────────────────────────────────────────────────────────────────

export class DuplicateDispatchSurgeDetector {
  /** All recorded events (never pruned — window filtering applied on read). */
  private events: SurgeEvent[] = [];
  /** When the last alert was sent, or null if no alert has been sent yet. */
  private lastAlertAt: Date | null = null;

  private readonly surgeThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly config: SurgeAlertConfig) {
    this.surgeThreshold = config.surgeThreshold ?? 3;
    this.windowMs = (config.windowMinutes ?? 30) * 60 * 1000;
    this.cooldownMs = (config.cooldownMinutes ?? 120) * 60 * 1000;
  }

  /**
   * Record an "already-in-review" guard event.
   *
   * If this call pushes the count of events within the rolling window to ≥
   * `surgeThreshold` and we are not in a cooldown period, fires a Telegram
   * alert.
   *
   * This method never throws — alert failures are logged and swallowed.
   */
  async recordEvent(event: SurgeEvent): Promise<void> {
    this.events.push(event);

    const windowEvents = this.getWindowEvents(event.timestamp);

    if (windowEvents.length < this.surgeThreshold) {
      return; // below threshold — nothing to do
    }

    if (this.isInCooldown(event.timestamp)) {
      log.info("Surge threshold reached but alert suppressed by cooldown", {
        windowCount: windowEvents.length,
        threshold: this.surgeThreshold,
        lastAlertAt: this.lastAlertAt?.toISOString(),
      });
      return;
    }

    // Send the alert.
    this.lastAlertAt = event.timestamp;
    try {
      await this.sendAlert(windowEvents);
    } catch (err) {
      // Never let alert failure propagate — guard must not block dispatch decisions.
      log.error("Failed to send duplicate-dispatch surge alert", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Returns true if an alert was sent within the cooldown window relative to
   * the given reference time (defaults to `Date.now()`).
   */
  isInCooldown(now: Date = new Date()): boolean {
    if (!this.lastAlertAt) return false;
    return now.getTime() - this.lastAlertAt.getTime() < this.cooldownMs;
  }

  /**
   * Returns the subset of recorded events that fall within the rolling window
   * ending at the given reference time (defaults to `Date.now()`).
   */
  getWindowEvents(now: Date = new Date()): SurgeEvent[] {
    const cutoff = now.getTime() - this.windowMs;
    return this.events.filter((e) => e.timestamp.getTime() >= cutoff);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async sendAlert(events: SurgeEvent[]): Promise<void> {
    const message = this.buildAlertMessage(events);
    log.info("Sending duplicate-dispatch surge alert", {
      eventCount: events.length,
      threshold: this.surgeThreshold,
    });
    await this.sendTelegram(message);
  }

  private buildAlertMessage(events: SurgeEvent[]): string {
    const windowLabel = formatWindowLabel(this.windowMs);

    // Group events by repo, collecting issue refs per repo.
    const byRepo = new Map<string, string[]>();
    for (const event of events) {
      const refs = byRepo.get(event.repo) ?? [];
      if (event.issueRef && !refs.includes(event.issueRef)) {
        refs.push(event.issueRef);
      }
      byRepo.set(event.repo, refs);
    }

    const repoLines = Array.from(byRepo.entries())
      .map(([repo, refs]) => {
        const issueList = refs.length > 0 ? ` (issues ${refs.join(", ")})` : "";
        return `  - ${repo}${issueList}`;
      })
      .join("\n");

    return [
      `⚠️ Duplicate dispatch surge: ${events.length} already-in-review blocks in ${windowLabel}`,
      `Affected repos:`,
      repoLines,
      `Action: check why these issues are being re-queued by the dispatcher`,
    ].join("\n");
  }

  private async sendTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;

    if (!telegramBotToken || !telegramChatId) {
      log.warn("Telegram not configured — duplicate-dispatch surge alert not sent");
      return;
    }

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        parse_mode: "",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Telegram API error ${response.status}: ${body}`);
    }
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatWindowLabel(windowMs: number): string {
  const minutes = windowMs / (60 * 1000);
  if (Number.isInteger(minutes) && minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  const hours = windowMs / (60 * 60 * 1000);
  if (Number.isInteger(hours)) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }

  return `${Math.round(windowMs / 1000)}s`;
}
