/**
 * Pre-existing staging failure tracker — issue #453
 *
 * The staging validator suppression fix (agent-orchestrator #1128) suppresses
 * per-merge Telegram warnings for pre-existing test failures (failures that
 * exist on `main` before a PR lands).  This is intentional: operators should
 * not receive noise on every merge for a failure they cannot fix right now.
 *
 * However, if the **same** pre-existing failure silently persists across many
 * merged PRs, operators may never realise permanent technical debt has
 * accumulated.  This module closes that gap:
 *
 *   - Every time the staging validator skips validation due to a pre-existing
 *     failure, the caller records the skip via `recordSkip()`.
 *   - When the same `(repo, pattern)` pair has been skipped for ≥ 3 **distinct**
 *     PR numbers within a rolling 7-day window, a single consolidated Telegram
 *     alert fires:
 *
 *       ⚠️ Pre-existing test failure has now been skipped 3+ times in
 *       `rapartlu/agent-orchestrator`. Consider fixing it so it doesn't
 *       mask real regressions.
 *
 *   - Alert deduplication: at most one alert per `(repo, pattern)` pair per day
 *     (calendar day in UTC) to avoid spam if the failure keeps accumulating.
 *
 * Usage:
 *
 *   const store = new StateStore();
 *   const tracker = new PreexistingFailureTracker({
 *     telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
 *     telegramChatId:   process.env.TELEGRAM_CHAT_ID!,
 *     store,
 *   });
 *
 *   // Called from the staging-validator-client when a skip is recorded:
 *   await tracker.recordSkip({
 *     repo:      "rapartlu/agent-orchestrator",
 *     pattern:   "Error: Cannot find module './dist/service/daemon'",
 *     prNumber:  1200,
 *     skippedAt: new Date(),
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("preexisting-failure-tracker");

// ── Constants ──────────────────────────────────────────────────────────────────

/**
 * Number of distinct PRs a pre-existing skip must appear in (within the
 * rolling window) before a consolidated Telegram alert fires.
 */
export const PREEXISTING_SKIP_THRESHOLD = 3;

/**
 * Rolling time window in milliseconds for counting distinct PR occurrences.
 * Default: 7 days.
 */
export const PREEXISTING_SKIP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-`(repo, pattern)` alert deduplication window in milliseconds.
 * At most one alert per pair within this window.
 * Default: 24 hours (1 calendar day).
 */
export const PREEXISTING_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// ── Public types ───────────────────────────────────────────────────────────────

/** A single staging-validator pre-existing skip event. */
export interface PreexistingSkip {
  /** Repository slug, e.g. "rapartlu/agent-orchestrator". */
  repo: string;
  /**
   * Normalised pattern string identifying the failure, e.g. the first line of
   * the test failure message or a short error type.  Should be stable across
   * runs of the same underlying failure so that distinct merges correlate.
   */
  pattern: string;
  /** PR number where the skip occurred, e.g. 1200. */
  prNumber: number;
  /** When the skip was recorded (defaults to `new Date()` if omitted). */
  skippedAt?: Date;
}

/** Stored representation of a skip row. */
export interface PreexistingSkipRow {
  repo: string;
  pattern: string;
  pr_number: number;
  skipped_at: string; // ISO-8601
}

/** Store interface for `staging_preexisting_skips`. */
export interface IPreexistingFailureStore {
  /**
   * Insert a pre-existing skip row.  Duplicate `(repo, pattern, pr_number)`
   * rows within the same day should be treated as idempotent by the caller —
   * the table itself does not enforce uniqueness so consecutive validator calls
   * for the same PR can safely call this repeatedly.
   */
  insertPreexistingSkip(skip: PreexistingSkipRow): void;

  /**
   * Return all skip rows for the given `(repo, pattern)` pair that fall within
   * the rolling window ending at `windowEnd`.
   */
  getPreexistingSkipsInWindow(
    repo: string,
    pattern: string,
    windowStart: Date,
    windowEnd: Date,
  ): PreexistingSkipRow[];
}

export interface PreexistingFailureTrackerConfig {
  /** Telegram bot token from @BotFather. */
  telegramBotToken: string;
  /** Telegram chat ID to send alerts to. */
  telegramChatId: string;
  /** Persistence store for skip rows. */
  store: IPreexistingFailureStore;
  /**
   * Minimum distinct PR count within `windowMs` before an alert fires.
   * Default: {@link PREEXISTING_SKIP_THRESHOLD} (3).
   */
  threshold?: number;
  /**
   * Rolling window in milliseconds for counting distinct PRs.
   * Default: {@link PREEXISTING_SKIP_WINDOW_MS} (7 days).
   */
  windowMs?: number;
  /**
   * Per-`(repo, pattern)` alert deduplication window in milliseconds.
   * Default: {@link PREEXISTING_ALERT_COOLDOWN_MS} (24 hours).
   */
  alertCooldownMs?: number;
}

// ── Tracker ────────────────────────────────────────────────────────────────────

export class PreexistingFailureTracker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly alertCooldownMs: number;

  /**
   * Tracks when the last consolidated alert was sent per `(repo, pattern)` key.
   * Used to enforce the per-day dedup without a DB query on every call.
   */
  private lastAlertAt = new Map<string, Date>();

  constructor(private readonly config: PreexistingFailureTrackerConfig) {
    this.threshold      = config.threshold      ?? PREEXISTING_SKIP_THRESHOLD;
    this.windowMs       = config.windowMs       ?? PREEXISTING_SKIP_WINDOW_MS;
    this.alertCooldownMs = config.alertCooldownMs ?? PREEXISTING_ALERT_COOLDOWN_MS;
  }

  /**
   * Record a pre-existing staging failure skip and — if the same
   * `(repo, pattern)` pair has now been skipped across ≥ threshold distinct
   * PR numbers within the rolling window — fire a consolidated Telegram alert.
   *
   * This method never throws.  Alert or store failures are logged and swallowed
   * so that the staging-validator path is never interrupted.
   */
  async recordSkip(skip: PreexistingSkip): Promise<void> {
    const now     = skip.skippedAt ?? new Date();
    const row: PreexistingSkipRow = {
      repo:       skip.repo,
      pattern:    skip.pattern,
      pr_number:  skip.prNumber,
      skipped_at: now.toISOString(),
    };

    // Persist the skip.
    try {
      this.config.store.insertPreexistingSkip(row);
    } catch (err) {
      log.error("Failed to persist preexisting skip", {
        repo: skip.repo,
        pattern: skip.pattern,
        prNumber: skip.prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      // Continue — we still want to evaluate in-memory if store is flaky.
    }

    // Count distinct PRs for this (repo, pattern) in the rolling window.
    const windowStart = new Date(now.getTime() - this.windowMs);
    let windowRows: PreexistingSkipRow[];
    try {
      windowRows = this.config.store.getPreexistingSkipsInWindow(
        skip.repo, skip.pattern, windowStart, now,
      );
    } catch (err) {
      log.error("Failed to query preexisting skips window", {
        repo: skip.repo,
        pattern: skip.pattern,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const distinctPRs = new Set(windowRows.map((r) => r.pr_number)).size;

    log.info("Preexisting skip recorded", {
      repo: skip.repo,
      pattern: skip.pattern.slice(0, 80),
      prNumber: skip.prNumber,
      distinctPRsInWindow: distinctPRs,
      threshold: this.threshold,
    });

    if (distinctPRs < this.threshold) return;

    // Threshold reached — check dedup cooldown.
    const key = makeKey(skip.repo, skip.pattern);
    if (this.isInCooldown(key, now)) {
      log.info("Preexisting failure alert suppressed by cooldown", {
        key,
        distinctPRsInWindow: distinctPRs,
        lastAlertAt: this.lastAlertAt.get(key)?.toISOString(),
      });
      return;
    }

    // Record before sending so a Telegram error doesn't leave cooldown unset.
    this.lastAlertAt.set(key, now);

    try {
      await this.sendAlert(skip.repo, skip.pattern, distinctPRs);
    } catch (err) {
      log.error("Failed to send preexisting failure Telegram alert", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Returns true if a consolidated alert was already sent for the given key
   * within the alert cooldown window relative to `now`.
   */
  isInCooldown(key: string, now: Date = new Date()): boolean {
    const lastSent = this.lastAlertAt.get(key);
    if (!lastSent) return false;
    return now.getTime() - lastSent.getTime() < this.alertCooldownMs;
  }

  /**
   * Build the consolidated Telegram alert message.
   *
   * Format (matching the proposal in issue #453):
   *
   *   ⚠️ Pre-existing test failure has now been skipped 3+ times in
   *   `rapartlu/agent-orchestrator`. Consider fixing it so it doesn't
   *   mask real regressions.
   *
   *   Pattern: Error: Cannot find module './dist/service/daemon'
   *   Skipped in: 3 distinct PRs in the last 7 days.
   */
  buildAlertMessage(repo: string, pattern: string, distinctPRCount: number): string {
    const windowDays = Math.round(this.windowMs / (24 * 60 * 60 * 1000));
    const patternDisplay = pattern.length > 120 ? pattern.slice(0, 120) + "…" : pattern;

    const lines: string[] = [
      `⚠️ Pre-existing test failure has now been skipped ${this.threshold}+ times in \`${repo}\`. Consider fixing it so it doesn't mask real regressions.`,
      ``,
      `Pattern: ${patternDisplay}`,
      `Skipped in: ${distinctPRCount} distinct PRs in the last ${windowDays} days.`,
    ];

    return lines.join("\n");
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async sendAlert(repo: string, pattern: string, distinctPRCount: number): Promise<void> {
    const message = this.buildAlertMessage(repo, pattern, distinctPRCount);
    log.info("Sending preexisting failure consolidated alert", {
      repo,
      pattern: pattern.slice(0, 80),
      distinctPRCount,
    });
    await this.sendTelegram(message);
  }

  private async sendTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;

    if (!telegramBotToken || !telegramChatId) {
      log.warn("Telegram not configured — preexisting failure alert not sent");
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

function makeKey(repo: string, pattern: string): string {
  // Truncate pattern to avoid absurdly long map keys.
  return `${repo}::${pattern.slice(0, 200)}`;
}
