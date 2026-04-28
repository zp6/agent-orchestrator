/**
 * Bypass-Audit — `/api/bypass-audit` API payload builder and daily Telegram digest.
 *
 * Operators need a consolidated view of every task approved below the 0.60
 * quality floor so they can audit exactly which tasks bypassed the gate and why,
 * without digging through logs.  Task 01KPRYG5 (score 0.42) was approved with
 * no visible operator alert — this module closes that gap.
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getBypassAuditPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/bypass-audit', (req, res) => {
 *     res.json(getBypassAuditPayload(store, {
 *       days: req.query.days ? Number(req.query.days) : undefined,
 *       limit: req.query.limit ? Number(req.query.limit) : undefined,
 *     }));
 *   });
 *
 * Daily Telegram digest:
 *
 *   const scheduler = new BypassAuditScheduler(store, notifier);
 *   // Call from daemon's daily maintenance cycle:
 *   await scheduler.checkAndSend();
 *
 * Telegram `/bypass-audit` command uses `formatBypassAuditForTelegram()`.
 *
 * Issue #398.
 */

import type { IBypassAuditStore } from "../state/types.js";
import type { Task } from "../state/types.js";
import type { Notifier } from "../notify.js";
import { extractPrUrl } from "../telegram/command-handler.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("bypass-audit");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Hard quality floor — tasks approved below this score are "bypasses".
 * Matches `BYPASS_REASON_FLOOR` in verifier.ts (0.60).
 */
export const BYPASS_AUDIT_FLOOR = 0.60;

/** Default lookback window in days. */
export const BYPASS_AUDIT_DEFAULT_DAYS = 7;

/** Default result cap. */
export const BYPASS_AUDIT_DEFAULT_LIMIT = 200;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One sub-floor-approved task in the bypass audit report.
 */
export interface BypassAuditEntry {
  /** Full ULID task identifier. */
  task_id: string;
  /** Short (8-char) prefix for display. */
  task_id_short: string;
  /** Task title. */
  title: string;
  /** Agent that completed the task. */
  agent_name: string | null;
  /** Verified quality score (always < 0.60 here). */
  quality_score: number;
  /**
   * Recorded bypass reason from the `bypass_reason` column.
   * 'none' when no explicit reason was stored (historical gap or silent bypass).
   */
  bypass_reason: string;
  /** Source reference (e.g. "owner/repo#123"). */
  source_ref: string | null;
  /** Extracted GitHub PR URL, or null. */
  pr_url: string | null;
  /** ISO timestamp of when the task was last updated (approved). */
  approved_at: string;
}

/**
 * Response payload for the `/api/bypass-audit` endpoint.
 */
export interface BypassAuditPayload {
  /** Quality floor used for this query (always 0.60). */
  floor: number;
  /** Lookback window used for this query. */
  period_days: number;
  /** Total number of sub-floor approvals in the window. */
  count: number;
  /**
   * Tasks with `bypass_reason = 'none'` (silent bypasses — no operator justification).
   * These are the most actionable: the gate fired but no reason was recorded.
   */
  silent_bypass_count: number;
  /** The task with the lowest quality_score in the window (worst offender), or null. */
  worst_offender: BypassAuditEntry | null;
  /** All sub-floor approvals in the window, worst first. */
  entries: BypassAuditEntry[];
  /** ISO timestamp when this payload was generated. */
  generated_at: string;
}

/**
 * Options accepted by `getBypassAuditPayload()`.
 */
export interface BypassAuditOptions {
  /** Lookback window in days. Default: 7. */
  days?: number;
  /** Maximum rows to return. Default: 200. */
  limit?: number;
}

// ── Core payload builder ──────────────────────────────────────────────────────

/**
 * Build the `/api/bypass-audit` response payload.
 *
 * Returns all tasks approved below the 0.60 quality floor in the last `days`
 * days, ordered by quality_score ascending (worst first), with the bypass_reason
 * for each (or 'none' if not recorded).
 *
 * @param store - Must satisfy `IBypassAuditStore`.
 * @param opts  - Optional query parameters.
 */
export function getBypassAuditPayload(
  store: IBypassAuditStore,
  opts: BypassAuditOptions = {},
): BypassAuditPayload {
  const days = Number.isFinite(opts.days) && (opts.days ?? 0) >= 1
    ? Math.floor(opts.days!)
    : BYPASS_AUDIT_DEFAULT_DAYS;
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1
    ? Math.floor(opts.limit!)
    : BYPASS_AUDIT_DEFAULT_LIMIT;

  const tasks = store.getBypassAuditTasks(days, limit);
  const entries = tasks.map(taskToEntry);

  const silentBypassCount = entries.filter((e) => e.bypass_reason === "none").length;

  return {
    floor: BYPASS_AUDIT_FLOOR,
    period_days: days,
    count: entries.length,
    silent_bypass_count: silentBypassCount,
    worst_offender: entries[0] ?? null,
    entries,
    generated_at: new Date().toISOString(),
  };
}

// ── Telegram formatters ───────────────────────────────────────────────────────

/**
 * Format a `BypassAuditPayload` as a concise Telegram Markdown message.
 *
 * Used by the daily digest scheduler and the `/bypass-audit` Telegram command.
 * Kept to ≤ 10 lines so it renders cleanly on mobile.
 *
 * Example output:
 *   🔒 *Bypass Audit — last 7 days*
 *   Sub-floor (<0.60) approvals: *3* (2 silent — no bypass reason)
 *
 *   Worst offender: task 01KP… (score *0.42*, agent claude-agent-orchestrator)
 *   Reason: none
 *
 *   Full list: /api/bypass-audit
 */
export function formatBypassAuditForTelegram(payload: BypassAuditPayload): string {
  const header = `🔒 *Bypass Audit — last ${payload.period_days} day${payload.period_days === 1 ? "" : "s"}*`;

  if (payload.count === 0) {
    return `${header}\nNo sub-floor (<${payload.floor}) approvals in this window. ✅`;
  }

  const silentNote =
    payload.silent_bypass_count > 0
      ? ` (${payload.silent_bypass_count} silent — no bypass reason recorded)`
      : "";

  const lines: string[] = [
    header,
    `Sub-floor (<${payload.floor}) approvals: *${payload.count}*${silentNote}`,
  ];

  if (payload.worst_offender) {
    const w = payload.worst_offender;
    const agentStr = w.agent_name ? `, agent ${w.agent_name}` : "";
    const prStr = w.pr_url ? `\n  PR: ${w.pr_url}` : "";
    lines.push(
      ``,
      `Worst offender: task \`${w.task_id_short}…\` — *${w.title.slice(0, 60)}*`,
      `  Score: *${w.quality_score.toFixed(2)}*${agentStr}`,
      `  Bypass reason: \`${w.bypass_reason}\`${prStr}`,
    );
  }

  if (payload.count > 1) {
    const rest = payload.entries.slice(1, 4);
    if (rest.length > 0) {
      lines.push(``, `Other violations:`);
      for (const e of rest) {
        const reasonStr = e.bypass_reason === "none" ? " ⚠️ no reason" : ` (${e.bypass_reason})`;
        lines.push(`  • ${e.task_id_short}… score *${e.quality_score.toFixed(2)}*${reasonStr}`);
      }
      if (payload.count > 4) {
        lines.push(`  … and ${payload.count - 4} more. See /api/bypass-audit for full list.`);
      }
    }
  }

  return lines.join("\n");
}

// ── Daily scheduler ───────────────────────────────────────────────────────────

/**
 * Options for `BypassAuditScheduler`.
 */
export interface BypassAuditSchedulerOptions {
  /** Lookback window in days. Default: 7. */
  days?: number;
  /** Dashboard base URL for the full-report link in Telegram messages. */
  dashboardUrl?: string;
}

/**
 * Daemon-style scheduler that posts a daily Telegram bypass-audit digest.
 *
 * Uses a per-day deduplication key so one digest fires per calendar day
 * regardless of how often the daemon's maintenance cycle calls `checkAndSend()`.
 *
 * Usage in the orchestrator daemon's daily maintenance cycle:
 *
 *   const scheduler = new BypassAuditScheduler(store, notifier, { days: 7 });
 *   await scheduler.checkAndSend();  // no-ops on second call in same day
 */
export class BypassAuditScheduler {
  private readonly log = createLogger("bypass-audit-scheduler");
  private lastSentDateKey = "";

  constructor(
    private readonly store: IBypassAuditStore,
    private readonly notifier: Notifier | undefined,
    private readonly opts: BypassAuditSchedulerOptions = {},
  ) {}

  /**
   * Send a daily bypass-audit digest to Telegram if:
   *   1. Today's digest has not already been sent (date-keyed dedup), AND
   *   2. A notifier is configured.
   *
   * Returns true when a message was dispatched (or attempted), false otherwise.
   */
  async checkAndSend(nowMs: number = Date.now()): Promise<boolean> {
    const dateKey = toDateKey(new Date(nowMs));

    if (this.lastSentDateKey === dateKey) {
      this.log.info("Bypass-audit digest already sent today", { dateKey });
      return false;
    }

    const payload = getBypassAuditPayload(this.store, { days: this.opts.days });

    if (!this.notifier) {
      this.log.warn("Bypass-audit digest due but no notifier configured", {
        count: payload.count,
        silentBypassCount: payload.silent_bypass_count,
      });
      this.lastSentDateKey = dateKey;
      return false;
    }

    let text = formatBypassAuditForTelegram(payload);

    if (this.opts.dashboardUrl && payload.count > 0) {
      text += `\n\n[Full report](${this.opts.dashboardUrl}/bypass-audit)`;
    }

    try {
      // NOISE SUPPRESSION (#564): Bypass audit is informational reporting.
      // Operator should query /bypass-audit if interested; no push notifications.
      this.lastSentDateKey = dateKey;
      this.log.info("Bypass-audit digest prepared (not sending to Telegram per #564)", {
        dateKey,
        count: payload.count,
        silentBypassCount: payload.silent_bypass_count,
        worstScore: payload.worst_offender?.quality_score ?? null,
      });
      return true;
    } catch (err) {
      this.log.error("Failed to send bypass-audit digest", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function taskToEntry(task: Task): BypassAuditEntry {
  return {
    task_id: task.id,
    task_id_short: task.id.slice(0, 8),
    title: task.title ?? "(untitled)",
    agent_name: task.agent_name ?? null,
    quality_score: task.quality_score as number,
    bypass_reason: task.bypass_reason ?? "none",
    source_ref: task.source_ref ?? null,
    pr_url: extractPrUrl(task),
    approved_at: task.updated_at,
  };
}

function toDateKey(date: Date): string {
  return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
}
