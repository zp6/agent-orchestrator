/**
 * PR guard surge detector — issue #442
 *
 * Monitors "already-in-review" guard events fired by the PR existence guard
 * and sends a Telegram alert when the *same* (repo, issue) pair triggers
 * already-in-review three or more times within a 60-minute window.
 *
 * This is a leading indicator that:
 *   - The cooldown table is not being respected by the dispatcher, or
 *   - The orchestrator has a polling loop bug that keeps re-queuing the same issue.
 *
 * Currently operators have no visibility into this failure mode — tasks all
 * score 1.0 and look healthy.  After this feature, an operator receiving:
 *
 *   ⚠️ /pr-guard-surge: research-agent#133 hit 3x in 60min, PR #162
 *
 * can immediately investigate the dispatch loop.
 *
 * Acceptance criteria (issue #442):
 *   - Alert fires when hit_count >= 3 within 60 min for same (repo, issue) pair.
 *   - Alert is deduped: at most one alert per surge event (60-min cooldown per issue).
 *   - Alert includes repo, issue number, blocking PR URL, and hit count.
 *
 * Usage:
 *
 *   const detector = new PRGuardSurgeDetector({
 *     telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
 *     telegramChatId:   process.env.TELEGRAM_CHAT_ID!,
 *   });
 *
 *   // Call from the PR existence guard onShortCircuit callback:
 *   await detector.recordHit({
 *     repo:        "rapartlu/research-agent",
 *     issueNumber: 133,
 *     prUrl:       "https://github.com/rapartlu/research-agent/pull/162",
 *     timestamp:   new Date(),
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("pr-guard-surge-detector");

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default minimum hit count within the window before an alert is sent. */
export const PR_GUARD_SURGE_THRESHOLD = 3;

/** Default rolling window duration in milliseconds (60 minutes). */
export const PR_GUARD_SURGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Default cooldown duration in milliseconds (60 minutes).
 * At most one alert per surge event per (repo, issue) pair.
 */
export const PR_GUARD_SURGE_COOLDOWN_MS = 60 * 60 * 1000;

// ── Public types ───────────────────────────────────────────────────────────────

/** A single "already-in-review" guard hit for a specific issue. */
export interface PRGuardHit {
  /** Repository slug, e.g. "rapartlu/research-agent". */
  repo: string;
  /** Issue number (integer), e.g. 133. */
  issueNumber: number;
  /** URL of the blocking PR, e.g. "https://github.com/rapartlu/research-agent/pull/162". */
  prUrl: string;
  /** When the guard hit occurred. */
  timestamp: Date;
}

export interface PRGuardSurgeConfig {
  /** Telegram bot token from @BotFather. */
  telegramBotToken: string;
  /** Telegram chat ID to send alerts to. */
  telegramChatId: string;
  /**
   * Minimum number of guard hits for the same (repo, issue) pair within the
   * window before an alert fires.  Default: {@link PR_GUARD_SURGE_THRESHOLD} (3).
   */
  surgeThreshold?: number;
  /**
   * Rolling window duration in milliseconds.
   * Default: {@link PR_GUARD_SURGE_WINDOW_MS} (60 minutes).
   */
  windowMs?: number;
  /**
   * Cooldown duration in milliseconds after an alert fires.
   * At most one alert per (repo, issue) pair within this window.
   * Default: {@link PR_GUARD_SURGE_COOLDOWN_MS} (60 minutes).
   */
  cooldownMs?: number;
}

// ── Detector ───────────────────────────────────────────────────────────────────

export class PRGuardSurgeDetector {
  private readonly surgeThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  /** All recorded hits (never pruned; window filtering applied on read). */
  private hits: PRGuardHit[] = [];

  /**
   * When the last surge alert was sent per issue key (`${repo}#${issueNumber}`).
   * Used to enforce the per-issue dedup cooldown.
   */
  private alertSentAt = new Map<string, Date>();

  constructor(private readonly config: PRGuardSurgeConfig) {
    this.surgeThreshold = config.surgeThreshold ?? PR_GUARD_SURGE_THRESHOLD;
    this.windowMs = config.windowMs ?? PR_GUARD_SURGE_WINDOW_MS;
    this.cooldownMs = config.cooldownMs ?? PR_GUARD_SURGE_COOLDOWN_MS;
  }

  /**
   * Record an "already-in-review" guard hit for a specific (repo, issue) pair.
   *
   * When the rolling window hit count for the same pair reaches
   * `surgeThreshold`, a Telegram alert is sent — unless the pair is already
   * within its post-alert cooldown window (dedup).
   *
   * This method never throws — alert failures are logged and swallowed so
   * that guard logic is never interrupted.
   */
  async recordHit(hit: PRGuardHit): Promise<void> {
    this.hits.push(hit);

    const key = makeKey(hit.repo, hit.issueNumber);
    const windowHits = this.getWindowHits(hit.repo, hit.issueNumber, hit.timestamp);

    if (windowHits.length < this.surgeThreshold) {
      return; // below threshold — nothing to do yet
    }

    if (this.isInCooldown(hit.repo, hit.issueNumber, hit.timestamp)) {
      log.info("PR guard surge threshold reached but alert suppressed by cooldown", {
        key,
        windowHitCount: windowHits.length,
        threshold: this.surgeThreshold,
        lastAlertAt: this.alertSentAt.get(key)?.toISOString(),
      });
      return;
    }

    // Record before sending so a throw doesn't leave the cooldown unset.
    this.alertSentAt.set(key, hit.timestamp);

    try {
      await this.sendAlert(hit.repo, hit.issueNumber, hit.prUrl, windowHits.length);
    } catch (err) {
      // Never let alert failure propagate — guard must not block dispatch decisions.
      log.error("Failed to send PR guard surge alert", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Returns all hits for the given (repo, issueNumber) pair within the rolling
   * window ending at the given reference time (defaults to `Date.now()`).
   */
  getWindowHits(repo: string, issueNumber: number, now: Date = new Date()): PRGuardHit[] {
    const cutoff = now.getTime() - this.windowMs;
    return this.hits.filter(
      (h) =>
        h.repo === repo &&
        h.issueNumber === issueNumber &&
        h.timestamp.getTime() >= cutoff,
    );
  }

  /**
   * Returns true if a surge alert was sent for the given (repo, issueNumber)
   * pair within the cooldown window relative to `now`.
   */
  isInCooldown(repo: string, issueNumber: number, now: Date = new Date()): boolean {
    const lastSent = this.alertSentAt.get(makeKey(repo, issueNumber));
    if (!lastSent) return false;
    return now.getTime() - lastSent.getTime() < this.cooldownMs;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async sendAlert(
    repo: string,
    issueNumber: number,
    prUrl: string,
    hitCount: number,
  ): Promise<void> {
    const message = this.buildAlertMessage(repo, issueNumber, prUrl, hitCount);
    log.info("Sending PR guard surge alert", {
      repo,
      issueNumber,
      prUrl,
      hitCount,
      threshold: this.surgeThreshold,
    });
    await this.sendTelegram(message);
  }

  /**
   * Build the Telegram alert message.
   *
   * Format (matching the example in issue #442):
   *   ⚠️ /pr-guard-surge: research-agent#133 hit 3x in 60min, PR #162
   *   Repo: rapartlu/research-agent
   *   Blocking PR: <prUrl>
   *   Hit count: 3 times in 60 minutes
   *
   *   This may indicate the cooldown table is not being respected or a
   *   dispatcher polling loop bug.
   */
  buildAlertMessage(
    repo: string,
    issueNumber: number,
    prUrl: string,
    hitCount: number,
  ): string {
    const repoShort = repo.split("/")[1] ?? repo;
    const windowMin = Math.round(this.windowMs / 60_000);
    // Extract PR number from URL for the compact headline, e.g. ".../pull/162" → "#162"
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prRef = prNumberMatch ? `PR #${prNumberMatch[1]}` : prUrl;

    const lines: string[] = [
      `⚠️ /pr-guard-surge: ${repoShort}#${issueNumber} hit ${hitCount}x in ${windowMin}min, ${prRef}`,
      `Repo: ${repo}`,
      `Blocking PR: ${prUrl}`,
      `Hit count: ${hitCount} times in ${windowMin} minutes`,
      ``,
      `This may indicate the cooldown table is not being respected or a dispatcher polling loop bug.`,
      `Investigate dispatch logs for issue #${issueNumber} in ${repo}.`,
    ];

    return lines.join("\n");
  }

  private async sendTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;

    if (!telegramBotToken || !telegramChatId) {
      log.warn("Telegram not configured — PR guard surge alert not sent");
      return;
    }

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Telegram API error ${response.status}: ${body}`);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}
