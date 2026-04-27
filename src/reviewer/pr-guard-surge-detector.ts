/**
 * PR guard surge detector — issue #442 / dispatch suppression — issue #1113
 *
 * Monitors "already-in-review" guard events fired by the PR existence guard
 * and:
 *
 *   1. Sends a Telegram alert when the *same* (repo, issue) pair triggers
 *      already-in-review two or more times within a 60-minute window
 *      (surge detection — original behaviour from issue #442; threshold lowered
 *      from 3 → 2 in issue #451 to fire earlier).
 *
 *   2. Writes a 2-hour dispatch suppression entry and sends a dedicated
 *      Telegram alert (with "dispatch suppressed until HH:MM UTC") when the
 *      same pair triggers ≥5 times within a 30-minute window
 *      (auto-suppression — issue #1113 / coordinated change 01KQ0HZ3D8YZ3SMKEW2N71AFX2).
 *
 * This is a leading indicator that:
 *   - The cooldown table is not being respected by the dispatcher, or
 *   - The orchestrator has a polling loop bug that keeps re-queuing the same issue.
 *
 * After the suppression feature, when an operator receives:
 *
 *   🚫 /pr-guard-suppression: research-agent#133 hit 5x in 30min, PR #162
 *   Dispatch suppressed until 14:25 UTC — no action needed.
 *
 * they know the orchestrator has automatically stopped re-queueing the issue
 * for two hours, so no manual intervention is required.
 *
 * Usage:
 *
 *   const detector = new PRGuardSurgeDetector({
 *     telegramBotToken: process.env.TELEGRAM_BOT_TOKEN!,
 *     telegramChatId:   process.env.TELEGRAM_CHAT_ID!,
 *     suppressionStore: cooldownStore, // IPRGuardCooldownStore
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
import type { IPRGuardCooldownStore } from "./pr-existence-guard.js";

const log = createLogger("pr-guard-surge-detector");

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default minimum hit count within the window before a surge alert is sent. */
export const PR_GUARD_SURGE_THRESHOLD = 2;

/** Default rolling window duration in milliseconds for surge detection (60 minutes). */
export const PR_GUARD_SURGE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Default cooldown duration in milliseconds after a surge alert fires.
 * At most one surge alert per (repo, issue) pair within this window.
 */
export const PR_GUARD_SURGE_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Default hit count threshold to trigger automatic dispatch suppression.
 * When the same (repo, issue) pair reaches this many 'already-in-review' hits
 * within {@link PR_GUARD_SUPPRESSION_WINDOW_MS}, a 2-hour suppression entry is
 * written and a Telegram alert is sent.
 *
 * Set to 5 per the coordinated change spec (rapartlu/agent-orchestrator#1113 /
 * coordinated change 01KQ0HZ3D8YZ3SMKEW2N71AFX2).  Callers may override this
 * via {@link PRGuardSurgeConfig.suppressionThreshold} for tighter burst detection.
 */
export const PR_GUARD_SUPPRESSION_THRESHOLD = 5;

/**
 * Rolling window duration in milliseconds for suppression evaluation (30 minutes).
 * Suppression is triggered when ≥ {@link PR_GUARD_SUPPRESSION_THRESHOLD} hits
 * occur within this window.
 *
 * Set to 30 min per the coordinated change spec (rapartlu/agent-orchestrator#1113 /
 * coordinated change 01KQ0HZ3D8YZ3SMKEW2N71AFX2).  Callers may override this
 * via {@link PRGuardSurgeConfig.suppressionWindowMs} for tighter burst detection.
 */
export const PR_GUARD_SUPPRESSION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Flag indicating that the PR guard pre-flight cooldown check is mandatory on
 * **all** dispatch paths.  Consumers (orchestrator, proxy) should gate every
 * GitHub-issue dispatch through `isPRGuardCooldownActive()` before creating a
 * task — not just on the paths that historically called the guard.
 *
 * Set to `true` as part of the coordinated change in agent-proxy#450.
 */
export const PR_GUARD_PREFLIGHT_REQUIRED = true;

/**
 * How long (in minutes) a dispatch suppression entry blocks re-queuing.
 * Written via {@link IPRGuardCooldownStore.setPRGuardCooldown} with this TTL.
 */
export const PR_GUARD_SUPPRESSION_TTL_MINUTES = 120;

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
   * surge window before a surge alert fires.
   * Default: {@link PR_GUARD_SURGE_THRESHOLD} (3).
   */
  surgeThreshold?: number;
  /**
   * Rolling window duration in milliseconds for surge detection.
   * Default: {@link PR_GUARD_SURGE_WINDOW_MS} (60 minutes).
   */
  windowMs?: number;
  /**
   * Cooldown duration in milliseconds after a surge alert fires.
   * At most one surge alert per (repo, issue) pair within this window.
   * Default: {@link PR_GUARD_SURGE_COOLDOWN_MS} (60 minutes).
   */
  cooldownMs?: number;
  /**
   * Minimum number of guard hits within {@link suppressionWindowMs} that trigger
   * automatic dispatch suppression and a dedicated Telegram alert.
   * Default: {@link PR_GUARD_SUPPRESSION_THRESHOLD} (5).
   */
  suppressionThreshold?: number;
  /**
   * Rolling window duration in milliseconds for suppression evaluation.
   * Default: {@link PR_GUARD_SUPPRESSION_WINDOW_MS} (30 minutes).
   */
  suppressionWindowMs?: number;
  /**
   * How long (in minutes) the suppression entry blocks re-queuing.
   * Written via {@link suppressionStore.setPRGuardCooldown} with this TTL.
   * Default: {@link PR_GUARD_SUPPRESSION_TTL_MINUTES} (120 minutes).
   */
  suppressionTtlMinutes?: number;
  /**
   * State store used to persist the dispatch suppression entry.
   * When provided and the suppression threshold is reached, a cooldown entry
   * with TTL = {@link suppressionTtlMinutes} is written, blocking further
   * dispatch until the TTL expires.
   *
   * If omitted, no suppression entry is written (Telegram alert still fires).
   */
  suppressionStore?: IPRGuardCooldownStore;
}

// ── Detector ───────────────────────────────────────────────────────────────────

export class PRGuardSurgeDetector {
  private readonly surgeThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly suppressionThreshold: number;
  private readonly suppressionWindowMs: number;
  private readonly suppressionTtlMinutes: number;

  /** All recorded hits (never pruned; window filtering applied on read). */
  private hits: PRGuardHit[] = [];

  /**
   * When the last surge alert was sent per issue key (`${repo}#${issueNumber}`).
   * Used to enforce the per-issue dedup cooldown for the surge (3-hit) alert.
   */
  private alertSentAt = new Map<string, Date>();

  /**
   * When the last suppression alert was sent per issue key.
   * A suppression alert fires at most once per (repo, issue) pair until the
   * suppression TTL expires — tracked independently from the surge alert cooldown.
   */
  private suppressionSentAt = new Map<string, Date>();

  constructor(private readonly config: PRGuardSurgeConfig) {
    this.surgeThreshold       = config.surgeThreshold        ?? PR_GUARD_SURGE_THRESHOLD;
    this.windowMs             = config.windowMs               ?? PR_GUARD_SURGE_WINDOW_MS;
    this.cooldownMs           = config.cooldownMs             ?? PR_GUARD_SURGE_COOLDOWN_MS;
    this.suppressionThreshold = config.suppressionThreshold   ?? PR_GUARD_SUPPRESSION_THRESHOLD;
    this.suppressionWindowMs  = config.suppressionWindowMs    ?? PR_GUARD_SUPPRESSION_WINDOW_MS;
    this.suppressionTtlMinutes = config.suppressionTtlMinutes ?? PR_GUARD_SUPPRESSION_TTL_MINUTES;
  }

  /**
   * Record an "already-in-review" guard hit for a specific (repo, issue) pair.
   *
   * Two checks run independently:
   *
   * 1. **Surge alert** — when rolling-window hits reach `surgeThreshold` (default 2)
   *    within `windowMs` (default 60 min), a Telegram alert fires (deduped by
   *    `cooldownMs`).
   *
   * 2. **Suppression** — when rolling-window hits reach `suppressionThreshold`
   *    (default 3) within `suppressionWindowMs` (default 15 min):
   *      - A 2-hour cooldown entry is written via `suppressionStore` (if provided).
   *      - A Telegram alert is sent with "dispatch suppressed until HH:MM".
   *
   * This method never throws — alert/store failures are logged and swallowed so
   * that guard logic is never interrupted.
   */
  async recordHit(hit: PRGuardHit): Promise<void> {
    this.hits.push(hit);

    const key = makeKey(hit.repo, hit.issueNumber);

    // ── 1. Surge alert check (60-min window, threshold 3) ───────────────────────
    const surgeWindowHits = this.getWindowHitsInMs(hit.repo, hit.issueNumber, hit.timestamp, this.windowMs);

    if (surgeWindowHits.length >= this.surgeThreshold) {
      if (this.isInCooldown(hit.repo, hit.issueNumber, hit.timestamp)) {
        log.info("PR guard surge threshold reached but surge alert suppressed by cooldown", {
          key,
          windowHitCount: surgeWindowHits.length,
          threshold: this.surgeThreshold,
          lastAlertAt: this.alertSentAt.get(key)?.toISOString(),
        });
      } else {
        // Record before sending to avoid leaving cooldown unset on throw.
        this.alertSentAt.set(key, hit.timestamp);
        try {
          await this.sendSurgeAlert(hit.repo, hit.issueNumber, hit.prUrl, surgeWindowHits.length);
        } catch (err) {
          log.error("Failed to send PR guard surge alert", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── 2. Suppression check (30-min window, threshold 5) ───────────────────────
    const suppressionWindowHits = this.getWindowHitsInMs(
      hit.repo, hit.issueNumber, hit.timestamp, this.suppressionWindowMs,
    );

    if (suppressionWindowHits.length >= this.suppressionThreshold) {
      if (this.isSuppressionActive(hit.repo, hit.issueNumber, hit.timestamp)) {
        log.info("Suppression threshold reached but suppression already active", {
          key,
          windowHitCount: suppressionWindowHits.length,
          threshold: this.suppressionThreshold,
          suppressionSentAt: this.suppressionSentAt.get(key)?.toISOString(),
        });
      } else {
        // Compute when the suppression expires so the alert can display HH:MM.
        const suppressedUntil = new Date(
          hit.timestamp.getTime() + this.suppressionTtlMinutes * 60 * 1000,
        );

        // Write suppression entry to block dispatch for suppressionTtlMinutes.
        if (this.config.suppressionStore) {
          try {
            this.config.suppressionStore.setPRGuardCooldown(
              hit.repo,
              hit.issueNumber,
              this.suppressionTtlMinutes,
              {
                prNumber: parsePrNumber(hit.prUrl),
                hitCount: suppressionWindowHits.length,
              },
            );
            log.info("Dispatch suppression written", {
              key,
              ttlMinutes: this.suppressionTtlMinutes,
              suppressedUntil: suppressedUntil.toISOString(),
            });
          } catch (storeErr) {
            log.error("Failed to write dispatch suppression entry", {
              key,
              error: storeErr instanceof Error ? storeErr.message : String(storeErr),
            });
          }
        } else {
          log.warn(
            "Suppression threshold reached but no suppressionStore configured — " +
            "Telegram alert will fire but dispatch is NOT blocked in state.db",
            { key },
          );
        }

        // Record before sending so a throw doesn't leave suppressionSentAt unset.
        this.suppressionSentAt.set(key, hit.timestamp);

        try {
          await this.sendSuppressionAlert(
            hit.repo,
            hit.issueNumber,
            hit.prUrl,
            suppressionWindowHits.length,
            suppressedUntil,
          );
        } catch (err) {
          log.error("Failed to send dispatch suppression alert", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * Returns all hits for the given (repo, issueNumber) pair within the rolling
   * window ending at the given reference time (defaults to `Date.now()`).
   *
   * Uses the configured `windowMs` (60-minute surge window).
   */
  getWindowHits(repo: string, issueNumber: number, now: Date = new Date()): PRGuardHit[] {
    return this.getWindowHitsInMs(repo, issueNumber, now, this.windowMs);
  }

  /**
   * Returns all hits for the given (repo, issueNumber) pair within the
   * specified window duration in milliseconds.
   */
  getWindowHitsInMs(
    repo: string,
    issueNumber: number,
    now: Date,
    windowMs: number,
  ): PRGuardHit[] {
    const cutoff = now.getTime() - windowMs;
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

  /**
   * Returns true if a suppression alert has been sent for the given
   * (repo, issueNumber) pair within the suppression TTL window.
   */
  isSuppressionActive(repo: string, issueNumber: number, now: Date = new Date()): boolean {
    const lastSent = this.suppressionSentAt.get(makeKey(repo, issueNumber));
    if (!lastSent) return false;
    return now.getTime() - lastSent.getTime() < this.suppressionTtlMinutes * 60 * 1000;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async sendSurgeAlert(
    repo: string,
    issueNumber: number,
    prUrl: string,
    hitCount: number,
  ): Promise<void> {
    const message = this.buildAlertMessage(repo, issueNumber, prUrl, hitCount);
    log.info("Sending PR guard surge alert", { repo, issueNumber, prUrl, hitCount });
    await this.sendTelegram(message);
  }

  private async sendSuppressionAlert(
    repo: string,
    issueNumber: number,
    prUrl: string,
    hitCount: number,
    suppressedUntil: Date,
  ): Promise<void> {
    const message = this.buildSuppressionAlertMessage(
      repo, issueNumber, prUrl, hitCount, suppressedUntil,
    );
    log.info("Sending dispatch suppression alert", {
      repo,
      issueNumber,
      prUrl,
      hitCount,
      suppressedUntil: suppressedUntil.toISOString(),
    });
    await this.sendTelegram(message);
  }

  /**
   * Build the Telegram surge alert message (fires at surgeThreshold hits).
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

  /**
   * Build the Telegram suppression alert message (fires at suppressionThreshold hits).
   *
   * Format:
   *   🚫 /pr-guard-suppression: research-agent#133 hit 5x in 30min, PR #162
   *   Repo: rapartlu/research-agent
   *   Blocking PR: <prUrl>
   *   Hit count: 5 times in 30 minutes
   *   Dispatch suppressed until 14:25 UTC — no action needed.
   */
  buildSuppressionAlertMessage(
    repo: string,
    issueNumber: number,
    prUrl: string,
    hitCount: number,
    suppressedUntil: Date,
  ): string {
    const repoShort = repo.split("/")[1] ?? repo;
    const windowMin = Math.round(this.suppressionWindowMs / 60_000);
    const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
    const prRef = prNumberMatch ? `PR #${prNumberMatch[1]}` : prUrl;

    // Format suppression time as HH:MM UTC for operator readability.
    const hh = String(suppressedUntil.getUTCHours()).padStart(2, "0");
    const mm = String(suppressedUntil.getUTCMinutes()).padStart(2, "0");
    const suppressedUntilStr = `${hh}:${mm} UTC`;

    const lines: string[] = [
      `🚫 /pr-guard-suppression: ${repoShort}#${issueNumber} hit ${hitCount}x in ${windowMin}min, ${prRef}`,
      `Repo: ${repo}`,
      `Blocking PR: ${prUrl}`,
      `Hit count: ${hitCount} times in ${windowMin} minutes`,
      `dispatch suppressed until ${suppressedUntilStr} — no action needed.`,
    ];

    return lines.join("\n");
  }

  private async sendTelegram(text: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = this.config;

    if (!telegramBotToken || !telegramChatId) {
      log.warn("Telegram not configured — PR guard alert not sent");
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

function parsePrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)(?:[/?#].*)?$/);
  return match ? Number.parseInt(match[1], 10) : null;
}
