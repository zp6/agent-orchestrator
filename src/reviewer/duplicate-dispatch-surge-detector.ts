/**
 * Duplicate-dispatch surge detector — issue #262
 *
 * Monitors "already-in-review" guard events (fired by `checkPRExistenceBeforeDispatch()`
 * when an open PR already exists for an issue) and sends a Telegram alert when
 * a *single* issue reaches a configurable dispatch count within a rolling time window.
 *
 * Designed to surface systematic re-queuing loops: if the dispatcher keeps
 * picking up issues that already have open PRs, something upstream is broken.
 * The per-issue tracking (issue #273) ensures an alert fires when the same
 * issue is dispatched repeatedly in one cycle, not just when the aggregate
 * count across all repos reaches the threshold.
 *
 * Alert format (issue #273):
 *   ⚠️ Dispatch storm detected: issue #423 (agent-proxy) dispatched 5 times
 *   this cycle — all returning already-in-review.  PR #425 is open.
 *   Consider suppressing this trigger with /suppress rapartlu/agent-proxy 423
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
 *     prUrl:     "https://github.com/rapartlu/agent-reviewer/pull/251",
 *     timestamp: new Date(),
 *   });
 *
 *   // Suppress future alerts for a specific issue (e.g. from /suppress command):
 *   detector.suppress("rapartlu/agent-reviewer", "#250");
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
  /**
   * URL of the existing open PR that caused the guard to block (if available).
   * Included in the Telegram alert so the operator can navigate directly.
   */
  prUrl?: string | null;
  /** When the event occurred. */
  timestamp: Date;
  /**
   * True when the duplicate was detected across two different agents working
   * on the same issue simultaneously (cross-agent collision, issue #336).
   * False / undefined for same-agent re-dispatch duplicates (PR already exists).
   */
  isCrossAgent?: boolean;
  /**
   * The agent that was already in-flight when this event was recorded.
   * Only populated when `isCrossAgent === true`.
   */
  conflictingAgent?: string;
  /**
   * The agent that was blocked by the guard.
   * Populated for cross-agent events; may be undefined for legacy same-agent events.
   */
  agentName?: string;
}

export interface SurgeAlertConfig {
  /** Telegram bot token from @BotFather. */
  telegramBotToken: string;
  /** Telegram chat ID to send alerts to. */
  telegramChatId: string;
  /**
   * Minimum number of "already-in-review" events for a *single* issue within
   * the window before an alert is sent.  Default: 3.
   */
  surgeThreshold?: number;
  /**
   * Rolling window (in minutes) to count events in.  Default: 30.
   */
  windowMinutes?: number;
  /**
   * Cooldown (in minutes) after an alert for a given issue before another
   * alert can be sent for that same issue.  Default: 120 (2 hours).
   */
  cooldownMinutes?: number;
}

// ── Detector ──────────────────────────────────────────────────────────────────

export class DuplicateDispatchSurgeDetector {
  /** All recorded events (never pruned — window filtering applied on read). */
  private events: SurgeEvent[] = [];
  /**
   * When the last alert was sent per issue key (`${repo}:${issueRef}`), or
   * null if no alert has been sent for that issue yet.
   *
   * Keyed per-issue so that a surge on one issue doesn't suppress alerts on
   * an unrelated issue.
   */
  private lastAlertAtPerIssue = new Map<string, Date>();

  /**
   * Issues that have been suppressed by the operator via `/suppress`.
   * Once suppressed, no alerts will be sent for that issue until the
   * detector is restarted or `unsuppress()` is called.
   */
  private suppressedIssues = new Set<string>();

  /**
   * Running count of cross-agent collision events recorded since detector start.
   * Separated from same-agent surges so the dashboard can display them independently.
   * (issue #336)
   */
  private crossAgentCollisionCount = 0;

  private readonly surgeThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;

  constructor(private readonly config: SurgeAlertConfig) {
    this.surgeThreshold = config.surgeThreshold ?? 3;
    this.windowMs = (config.windowMinutes ?? 30) * 60 * 1000;
    this.cooldownMs = (config.cooldownMinutes ?? 120) * 60 * 1000;
  }

  /**
   * Record an "already-in-review" or "already-in-flight" guard event.
   *
   * Cross-agent events (`isCrossAgent === true`, issue #336) increment the
   * `crossAgentCollisionCount` and trigger an immediate single-event alert
   * without waiting for the surge threshold, because even one cross-agent
   * collision is operationally significant.
   *
   * Same-agent events (default) fire when the rolling window count reaches
   * `surgeThreshold`, with per-issue cooldown logic to prevent alert fatigue.
   *
   * This method never throws — alert failures are logged and swallowed.
   */
  async recordEvent(event: SurgeEvent): Promise<void> {
    this.events.push(event);

    // ── Cross-agent collision path (issue #336) ──────────────────────────────
    // Track separately and alert immediately (no threshold gate).
    if (event.isCrossAgent) {
      this.crossAgentCollisionCount += 1;

      if (!event.issueRef) return;

      const issueKey = makeIssueKey(event.repo, event.issueRef) + ":cross-agent";
      if (!this.suppressedIssues.has(issueKey) && !this.isInCooldownForIssue(issueKey, event.timestamp)) {
        this.lastAlertAtPerIssue.set(issueKey, event.timestamp);
        try {
          await this.sendCrossAgentAlert(event);
        } catch (err) {
          log.error("Failed to send cross-agent collision surge alert", {
            issueKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    // ── Same-agent surge path ────────────────────────────────────────────────
    if (!event.issueRef) {
      return;
    }

    const issueKey = makeIssueKey(event.repo, event.issueRef);
    const windowEvents = this.getWindowEventsForIssue(event.repo, event.issueRef, event.timestamp);

    if (windowEvents.length < this.surgeThreshold) {
      return; // below threshold — nothing to do
    }

    if (this.suppressedIssues.has(issueKey)) {
      log.info("Surge threshold reached but issue is suppressed by operator", {
        issueKey,
        windowCount: windowEvents.length,
      });
      return;
    }

    if (this.isInCooldownForIssue(issueKey, event.timestamp)) {
      log.info("Surge threshold reached but alert suppressed by cooldown", {
        issueKey,
        windowCount: windowEvents.length,
        threshold: this.surgeThreshold,
        lastAlertAt: this.lastAlertAtPerIssue.get(issueKey)?.toISOString(),
      });
      return;
    }

    // Send the per-issue alert.
    this.lastAlertAtPerIssue.set(issueKey, event.timestamp);
    try {
      await this.sendAlert(event.repo, event.issueRef, windowEvents);
    } catch (err) {
      // Never let alert failure propagate — guard must not block dispatch decisions.
      log.error("Failed to send duplicate-dispatch surge alert", {
        issueKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Return the total count of cross-agent collision events recorded since
   * this detector instance was created.
   *
   * Used by the dashboard "multi-agent collision" metric (issue #336).
   * A non-zero value indicates the cross-agent in-flight guard has fired
   * and is actively preventing duplicate work.
   */
  getCrossAgentCollisionCount(): number {
    return this.crossAgentCollisionCount;
  }

  /**
   * Return cross-agent collision events within the given rolling window.
   * Useful for building the dashboard "multi-agent collision" time series.
   *
   * @param now - Reference time.  Defaults to current time.
   */
  getCrossAgentWindowEvents(now: Date = new Date()): SurgeEvent[] {
    const cutoff = now.getTime() - this.windowMs;
    return this.events.filter(
      (e) => e.isCrossAgent === true && e.timestamp.getTime() >= cutoff,
    );
  }

  /**
   * Suppress future Telegram alerts for the given issue.
   *
   * Typically called from the `/suppress` Telegram command so the operator can
   * silence a noisy trigger after acknowledging it.  Suppression is in-memory
   * only and resets on detector restart.
   *
   * @param repo      - Repository slug, e.g. "rapartlu/agent-reviewer"
   * @param issueRef  - Issue reference string, e.g. "#250" or "250"
   */
  suppress(repo: string, issueRef: string): void {
    // Normalise to "#N" form for consistent keying.
    const normRef = issueRef.startsWith("#") ? issueRef : `#${issueRef}`;
    const issueKey = makeIssueKey(repo, normRef);
    this.suppressedIssues.add(issueKey);
    log.info("Issue suppressed — no more storm alerts until restart", { issueKey });
  }

  /**
   * Remove a suppression set by `suppress()`.
   */
  unsuppress(repo: string, issueRef: string): void {
    const normRef = issueRef.startsWith("#") ? issueRef : `#${issueRef}`;
    const issueKey = makeIssueKey(repo, normRef);
    this.suppressedIssues.delete(issueKey);
    log.info("Issue suppression removed", { issueKey });
  }

  /**
   * Returns true if the given issue has been suppressed by the operator.
   */
  isSuppressed(repo: string, issueRef: string): boolean {
    const normRef = issueRef.startsWith("#") ? issueRef : `#${issueRef}`;
    return this.suppressedIssues.has(makeIssueKey(repo, normRef));
  }

  /**
   * Returns true if an alert was sent for the given issue within the cooldown
   * window relative to the given reference time (defaults to `Date.now()`).
   */
  isInCooldown(now: Date = new Date()): boolean {
    // Legacy aggregate check: true if *any* issue is in cooldown.
    for (const lastAlertAt of this.lastAlertAtPerIssue.values()) {
      if (now.getTime() - lastAlertAt.getTime() < this.cooldownMs) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns true if an alert was sent for the given issue key within the
   * cooldown window.
   */
  isInCooldownForIssue(issueKey: string, now: Date = new Date()): boolean {
    const lastAlertAt = this.lastAlertAtPerIssue.get(issueKey);
    if (!lastAlertAt) return false;
    return now.getTime() - lastAlertAt.getTime() < this.cooldownMs;
  }

  /**
   * Returns the subset of recorded events that fall within the rolling window
   * ending at the given reference time (defaults to `Date.now()`).
   */
  getWindowEvents(now: Date = new Date()): SurgeEvent[] {
    const cutoff = now.getTime() - this.windowMs;
    return this.events.filter((e) => e.timestamp.getTime() >= cutoff);
  }

  /**
   * Returns the subset of recorded events for a specific issue (matched by
   * repo + issueRef) within the rolling window ending at the given reference
   * time.
   */
  getWindowEventsForIssue(
    repo: string,
    issueRef: string,
    now: Date = new Date(),
  ): SurgeEvent[] {
    const cutoff = now.getTime() - this.windowMs;
    return this.events.filter(
      (e) =>
        e.timestamp.getTime() >= cutoff &&
        e.repo === repo &&
        e.issueRef === issueRef,
    );
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async sendAlert(
    repo: string,
    issueRef: string,
    events: SurgeEvent[],
  ): Promise<void> {
    const message = this.buildAlertMessage(repo, issueRef, events);
    log.info("Sending per-issue duplicate-dispatch surge alert", {
      repo,
      issueRef,
      eventCount: events.length,
      threshold: this.surgeThreshold,
    });
    await this.sendTelegram(message);
  }

  private buildAlertMessage(
    repo: string,
    issueRef: string,
    events: SurgeEvent[],
  ): string {
    const windowLabel = formatWindowLabel(this.windowMs);
    const repoShort = repo.split("/")[1] ?? repo;
    // Normalise issueRef to bare number for display (e.g. "#423" → "423")
    const issueNum = issueRef.replace(/^#/, "");

    // Find the most recent PR URL from the events (prefer the latest one).
    const prUrl = events
      .slice()
      .reverse()
      .find((e) => e.prUrl)
      ?.prUrl ?? null;

    const suppressCmd = `/suppress ${repo} ${issueNum}`;

    const lines: string[] = [
      `⚠️ Dispatch storm detected: issue ${issueRef} (${repoShort}) dispatched ${events.length} times this cycle — all returning already-in-review.`,
      `Window: ${windowLabel}`,
    ];

    if (prUrl) {
      lines.push(`PR: ${prUrl}`);
    }

    lines.push(
      ``,
      `Consider suppressing this trigger: \`${suppressCmd}\``,
    );

    return lines.join("\n");
  }

  /**
   * Send a cross-agent collision alert via Telegram (issue #336).
   * These alerts fire immediately on first event — no surge threshold required.
   */
  private async sendCrossAgentAlert(event: SurgeEvent): Promise<void> {
    const message = this.buildCrossAgentAlertMessage(event);
    log.info("Sending cross-agent collision alert", {
      repo: event.repo,
      issueRef: event.issueRef,
      agentName: event.agentName,
      conflictingAgent: event.conflictingAgent,
      crossAgentCollisionCount: this.crossAgentCollisionCount,
    });
    await this.sendTelegram(message);
  }

  /**
   * Build the Telegram message for a cross-agent collision event.
   * Distinguishes itself from the same-agent surge alert with different emoji
   * and messaging.
   */
  private buildCrossAgentAlertMessage(event: SurgeEvent): string {
    const repoShort = event.repo.split("/")[1] ?? event.repo;
    const issueRef = event.issueRef ?? "(unknown issue)";
    const issueNum = issueRef.replace(/^#/, "");
    const blockedAgent = event.agentName ?? "unknown";
    const conflictingAgent = event.conflictingAgent ?? "another agent";
    const suppressCmd = `/suppress ${event.repo} ${issueNum}`;

    const lines: string[] = [
      `🔁 Multi-agent collision: issue ${issueRef} (${repoShort}) is already in-flight.`,
      `Blocked agent: ${blockedAgent}`,
      `In-flight agent: ${conflictingAgent}`,
      `Total cross-agent collisions this session: ${this.crossAgentCollisionCount}`,
      ``,
      `Dispatch to ${blockedAgent} was skipped — ${conflictingAgent} will resolve this issue first.`,
      `To suppress: \`${suppressCmd}\``,
    ];

    return lines.join("\n");
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeIssueKey(repo: string, issueRef: string): string {
  return `${repo}:${issueRef}`;
}

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
