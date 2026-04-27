/**
 * Synthesis Watchdog — issue #553
 *
 * Monitors meeting/standup synthesis intake entries and fires a Telegram alert
 * + re-attempts intake when synthesis has not been recorded after 24 hours.
 *
 * This addresses the facilitator-outage reliability gap described in
 * rapartlu/agent-orchestrator#1241: if the meeting-facilitator is unavailable
 * when synthesis should be written, the result can be silently lost. This
 * watchdog provides a safety net by persisting the intake moment and checking
 * back after a configurable threshold.
 *
 * ## Flow
 *
 * 1. Caller registers a meeting intake:
 *    `registerSynthesisIntake(store, repo, issueNumber)`
 *    → writes a row to `synthesis_watchlist` with `intake_at = now`
 *
 * 2. When synthesis completes, caller marks it done:
 *    `recordSynthesisComplete(store, repo, issueNumber)`
 *    → sets `synthesized_at` on the row
 *
 * 3. Daemon (or periodic CLI check) calls:
 *    `SynthesisWatchdog.checkAndAlert()`
 *    → queries for rows where `synthesized_at IS NULL`
 *       AND `intake_at < now - SYNTHESIS_MISSING_THRESHOLD_HOURS`
 *    → for each, fires a Telegram alert (once per 6h cooldown) and
 *      re-attempts intake by posting a comment on the GitHub issue
 *
 * ## Table
 *
 * ```sql
 * CREATE TABLE IF NOT EXISTS synthesis_watchlist (
 *   id           TEXT PRIMARY KEY,
 *   repo         TEXT NOT NULL,
 *   issue_number INTEGER NOT NULL,
 *   intake_at    TEXT NOT NULL DEFAULT (datetime('now')),
 *   synthesized_at TEXT,
 *   alerted_at   TEXT,
 *   reintake_at  TEXT,
 *   UNIQUE(repo, issue_number)
 * );
 * ```
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";

const log = createLogger("synthesis-watchdog");

// ── Constants ──────────────────────────────────────────────────────────────────

/** Hours after intake with no synthesis before alerting + re-attempting. */
export const SYNTHESIS_MISSING_THRESHOLD_HOURS = 24;

/**
 * Minimum hours between repeated alerts for the same (repo, issueNumber) pair.
 * Prevents alert storms if re-intake also fails.
 */
export const SYNTHESIS_ALERT_COOLDOWN_HOURS = 6;

/** DDL for the synthesis_watchlist table (idempotent). */
export const SYNTHESIS_WATCHDOG_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS synthesis_watchlist (
  id             TEXT PRIMARY KEY,
  repo           TEXT NOT NULL,
  issue_number   INTEGER NOT NULL,
  intake_at      TEXT NOT NULL DEFAULT (datetime('now')),
  synthesized_at TEXT,
  alerted_at     TEXT,
  reintake_at    TEXT,
  UNIQUE(repo, issue_number)
);

CREATE INDEX IF NOT EXISTS idx_synthesis_watchlist_intake
  ON synthesis_watchlist (intake_at DESC);
`;

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single entry in the synthesis watchlist. */
export interface SynthesisWatchEntry {
  id: string;
  repo: string;
  issue_number: number;
  /** ISO-8601 timestamp when the synthesis intake was registered. */
  intake_at: string;
  /** ISO-8601 timestamp when synthesis completed, or null if still pending. */
  synthesized_at: string | null;
  /** ISO-8601 timestamp of the last Telegram alert for this entry, or null. */
  alerted_at: string | null;
  /** ISO-8601 timestamp of the last re-intake attempt, or null. */
  reintake_at: string | null;
}

/** Result returned by `SynthesisWatchdog.checkAndAlert()`. */
export interface SynthesisWatchdogCheckResult {
  /** Number of Telegram alerts fired during this check. */
  alertsFired: number;
  /** Number of re-intake comments posted during this check. */
  reintakeAttempts: number;
  /** Entries that were processed (missing synthesis, past threshold). */
  processed: SynthesisWatchEntry[];
}

/**
 * Store interface for synthesis watchlist persistence.
 *
 * Implemented by the reviewer's StateStore.
 */
export interface ISynthesisWatchdogStore {
  /**
   * Insert or update a synthesis intake registration.
   * UPSERT: if a row already exists for (repo, issue_number), update intake_at
   * only if the existing row has already been synthesized (i.e., start a fresh
   * watch for a new meeting on the same issue).
   */
  registerSynthesisIntake(repo: string, issueNumber: number): void;

  /**
   * Mark synthesis as complete for the given (repo, issue_number) pair.
   * Sets `synthesized_at` to the current UTC timestamp.
   */
  recordSynthesisComplete(repo: string, issueNumber: number): void;

  /**
   * Return all entries where synthesis is missing (synthesized_at IS NULL)
   * and intake is older than `thresholdHours` hours.
   */
  getMissingSynthesisEntries(thresholdHours?: number): SynthesisWatchEntry[];

  /**
   * Record that a Telegram alert was sent for this entry.
   * Sets `alerted_at` to the current UTC timestamp.
   */
  markWatchdogAlerted(repo: string, issueNumber: number): void;

  /**
   * Record that a re-intake comment was posted for this entry.
   * Sets `reintake_at` to the current UTC timestamp.
   */
  markWatchdogReintake(repo: string, issueNumber: number): void;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Register a synthesis intake for a meeting or standup issue.
 *
 * Call this immediately after receiving a synthesis intake (before dispatching
 * to the facilitator) so the watchdog can start the 24h clock.
 */
export function registerSynthesisIntake(
  store: ISynthesisWatchdogStore,
  repo: string,
  issueNumber: number,
): void {
  try {
    store.registerSynthesisIntake(repo, issueNumber);
    log.info("Registered synthesis intake", { repo, issueNumber });
  } catch (err) {
    log.warn("Failed to register synthesis intake", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mark synthesis as complete for a meeting or standup issue.
 *
 * Call this once synthesis has been successfully written/persisted so the
 * watchdog knows no alert is needed.
 */
export function recordSynthesisComplete(
  store: ISynthesisWatchdogStore,
  repo: string,
  issueNumber: number,
): void {
  try {
    store.recordSynthesisComplete(repo, issueNumber);
    log.info("Recorded synthesis complete", { repo, issueNumber });
  } catch (err) {
    log.warn("Failed to record synthesis complete", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Format a Telegram message for missing synthesis entries.
 */
export function formatMissingSynthesisAlert(entries: SynthesisWatchEntry[]): string {
  if (entries.length === 0) return "✅ All tracked meetings have synthesis recorded.";
  const lines = entries.map(
    (e) => `• \`${e.repo}#${e.issue_number}\` — intake ${formatAge(e.intake_at)} ago`,
  );
  return `⚠️ *Synthesis missing (>24h)*\n\nThe following meetings have no synthesis recorded after 24h. Re-intake has been triggered.\n\n${lines.join("\n")}`;
}

// ── SynthesisWatchdog class ────────────────────────────────────────────────────

/**
 * Watchdog that periodically checks for missing synthesis and alerts operators.
 *
 * Intended to be called from the daemon loop (every 30s) or a scheduled task.
 * Guards against alert storms via a 6h per-entry cooldown.
 *
 * @example
 * ```typescript
 * const watchdog = new SynthesisWatchdog(store, notifier);
 * const result = await watchdog.checkAndAlert();
 * log.info("Watchdog check complete", result);
 * ```
 */
export class SynthesisWatchdog {
  constructor(
    private readonly store: ISynthesisWatchdogStore,
    private readonly notifier: Notifier,
  ) {}

  /**
   * Check for missing synthesis entries, alert operators, and re-attempt intake.
   *
   * - Skips entries whose `alerted_at` is within the 6h cooldown window.
   * - Fires `notifyOperator` with urgency "high" for each eligible entry.
   * - Posts a GitHub issue comment to request re-synthesis from the facilitator.
   * - Records `alerted_at` and `reintake_at` timestamps for dedup.
   */
  async checkAndAlert(): Promise<SynthesisWatchdogCheckResult> {
    const missing = this.store.getMissingSynthesisEntries(SYNTHESIS_MISSING_THRESHOLD_HOURS);

    let alertsFired = 0;
    let reintakeAttempts = 0;
    const processed: SynthesisWatchEntry[] = [];

    for (const entry of missing) {
      const hoursSinceIntake =
        (Date.now() - new Date(entry.intake_at).getTime()) / 3_600_000;
      const hoursSinceAlert = entry.alerted_at
        ? (Date.now() - new Date(entry.alerted_at).getTime()) / 3_600_000
        : Infinity;

      if (hoursSinceAlert < SYNTHESIS_ALERT_COOLDOWN_HOURS) {
        log.info("Synthesis watchdog: alert cooldown active, skipping", {
          repo: entry.repo,
          issueNumber: entry.issue_number,
          hoursSinceAlert: Math.round(hoursSinceAlert),
        });
        continue;
      }

      processed.push(entry);

      log.warn("Synthesis missing after threshold", {
        repo: entry.repo,
        issueNumber: entry.issue_number,
        hoursSinceIntake: Math.round(hoursSinceIntake),
      });

      // Fire Telegram alert
      const alertSent = await this.notifier.notifyOperator(
        "Synthesis missing after 24h",
        `Meeting synthesis not recorded for \`${entry.repo}#${entry.issue_number}\` — ` +
          `intake was ${Math.round(hoursSinceIntake)}h ago. Re-attempting intake now.`,
        "high",
      );

      if (alertSent) {
        this.store.markWatchdogAlerted(entry.repo, entry.issue_number);
        alertsFired++;
      }

      // Re-attempt intake via GitHub issue comment
      const reintakeOk = postReintakeComment(entry.repo, entry.issue_number);
      if (reintakeOk) {
        this.store.markWatchdogReintake(entry.repo, entry.issue_number);
        reintakeAttempts++;
      }
    }

    if (processed.length > 0) {
      log.warn("Synthesis watchdog: processed missing entries", {
        count: processed.length,
        alertsFired,
        reintakeAttempts,
      });
    }

    return { alertsFired, reintakeAttempts, processed };
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Post a re-intake comment on the GitHub issue to trigger facilitator retry.
 * Returns true on success, false on failure.
 */
function postReintakeComment(repo: string, issueNumber: number): boolean {
  const body =
    "[synthesis-watchdog] Synthesis has been missing for >24h since intake — " +
    "re-triggering synthesis intake. Facilitator please re-run synthesis for this meeting.";
  try {
    const escaped = body.replace(/'/g, "'\\''");
    execSync(
      `gh issue comment ${issueNumber} --repo '${repo.replace(/'/g, "'\\''")}' --body '${escaped}'`,
      { stdio: "pipe", timeout: 15_000 },
    );
    log.info("Posted re-intake comment", { repo, issueNumber });
    return true;
  } catch (err) {
    log.warn("Failed to post re-intake comment", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Format an ISO timestamp as a human-readable age string (e.g. "26h", "3d"). */
function formatAge(isoDate: string): string {
  const hours = Math.round((Date.now() - new Date(isoDate).getTime()) / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
