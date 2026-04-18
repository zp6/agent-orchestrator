/**
 * Quality System Health — `/api/quality-system-health` API payload builder.
 *
 * Tracks when the hard quality floor (0.60) is being bypassed and surfaces
 * credibility signals so operators know when the quality gate is no longer
 * meaningful.
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getQualitySystemHealthPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/api/quality-system-health', (_req, res) => {
 *     res.json(getQualitySystemHealthPayload(store));
 *   });
 *
 * Dashboard HTML page (`/quality-system-health`):
 *   - Bypass rate banner: "Quality floor was bypassed 45% this cycle — 9/20 tasks ▲"
 *   - 7-day bypass rate sparkline: green (ok) / red (warn) / grey (nodata) segments
 *   - Breakdown table: operator_override vs marginal_auto bypasses
 *   - Detail list: bypassed tasks with score, agent, reason, and PR link
 *
 * Telegram `/quality-health` command uses `formatQualitySystemHealthPage()`.
 *
 * Bypass classification:
 *   - operator_override: `verification_notes` or `verification_status` contains
 *     an operator-override marker (`[operator-override`, `operator_override`,
 *     `operator override`, or `approval_rationale`).
 *   - marginal_auto: all other sub-floor approvals (including marginal-path,
 *     floor_not_enforced, and any task approved below 0.60 without an explicit
 *     operator action).
 */

import type { IStateStore } from "../state/types.js";
import type { Notifier } from "../notify.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("quality-system-health");

// ── Constants ─────────────────────────────────────────────────────────────────

/** Quality floor — approvals below this score are "bypasses". Default: 0.60. */
export const QUALITY_FLOOR = 0.60;

/** Bypass rate above which an alert fires. Default: 0.30 (30%). */
export const BYPASS_RATE_ALERT_THRESHOLD = 0.30;

/** Default number of days for the bypass rate sparkline. */
export const DEFAULT_SPARKLINE_DAYS = 7;

/** Default number of tasks to consider for the "current cycle". */
export const DEFAULT_CYCLE_TASK_LIMIT = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Reason why a sub-floor approval was allowed through. */
export type BypassReason = "operator_override" | "marginal_auto";

/** Colour band for one day in the bypass rate sparkline. */
export type BypassBand = "ok" | "warn" | "nodata";

/** One bypassed task in the detail list. */
export interface BypassedTask {
  task_id: string;
  /** Short (8-char) prefix of task_id for display. */
  task_id_short: string;
  title: string;
  agent_name: string | null;
  quality_score: number;
  bypass_reason: BypassReason;
  /** GitHub PR URL extracted from task result/notes, or null if not found. */
  pr_url: string | null;
  bypassed_at: string;
}

/** One day's entry in the 7-day bypass rate sparkline. */
export interface SparklineDay {
  /** Calendar date "YYYY-MM-DD". */
  date: string;
  /** Total verified (approved + rejected) tasks on this day. */
  total: number;
  /** Number of approved tasks with quality_score < floor on this day. */
  bypassed: number;
  /**
   * bypassed / total as a 0-1 fraction.
   * null when total = 0 (no verified tasks that day → nodata band).
   */
  bypass_rate: number | null;
  /** Colour band for sparkline rendering. */
  band: BypassBand;
}

/** Full quality system health payload returned by `getQualitySystemHealthPayload()`. */
export interface QualitySystemHealthPayload {
  /**
   * Human-readable banner for the dashboard header.
   * Example: "Quality floor was bypassed 45% this cycle — 9/20 tasks ▲"
   */
  banner: string;
  /** Bypass rate for the current cycle (0–1). null when cycle_total = 0. */
  current_cycle_bypass_rate: number | null;
  /** Number of approved tasks scoring below the floor in the current cycle. */
  current_cycle_bypassed: number;
  /** Total verified tasks in the current cycle window. */
  current_cycle_total: number;
  /** Operator-override sub-category count. */
  operator_overrides: number;
  /** Marginal-auto sub-category count. */
  marginal_auto: number;
  /** 7-day (or N-day) bypass rate sparkline, oldest → newest. */
  sparkline: SparklineDay[];
  /** Detail list of bypassed tasks in the current cycle (most recent first). */
  bypassed_tasks: BypassedTask[];
  /** Whether the current bypass rate exceeds the alert threshold. */
  alert_active: boolean;
  /** The alert threshold used (default: 0.30). */
  alert_threshold: number;
  /** The quality floor used (default: 0.60). */
  floor: number;
  generated_at: string;
}

/** Options for `getQualitySystemHealthPayload()`. */
export interface QualitySystemHealthOptions {
  /**
   * Number of calendar days for the bypass rate sparkline.
   * Default: 7.
   */
  days?: number;
  /**
   * Quality floor below which an approval counts as a bypass.
   * Default: 0.60.
   */
  floor?: number;
  /**
   * Bypass rate above which `alert_active` is set to true.
   * Default: 0.30 (30%).
   */
  alertThreshold?: number;
  /**
   * Number of most-recent verified tasks that form the "current cycle".
   * Default: 20.
   */
  cycleTaskLimit?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract the UTC calendar date ("YYYY-MM-DD") from an ISO-8601 timestamp.
 * Returns the empty string for unparseable inputs so callers can filter.
 */
function toDateKey(isoTs: string): string {
  if (!isoTs) return "";
  const d = new Date(isoTs);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Add `n` days to a "YYYY-MM-DD" date key.
 * Returns a new date key string.
 */
function addDays(dateKey: string, n: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Classify a sub-floor approved task into a bypass reason.
 *
 * Checks verification_notes for any operator-override marker:
 *   - "[operator-override" (the review-queue approve path)
 *   - "operator_override" (bypass_reason column content echoed into notes)
 *   - "operator override" (natural language)
 *   - "approval_rationale" (legacy marker)
 */
function classifyBypassReason(notes: string | null | undefined): BypassReason {
  if (!notes) return "marginal_auto";
  const lower = notes.toLowerCase();
  if (
    lower.includes("[operator-override") ||
    lower.includes("operator_override") ||
    lower.includes("operator override") ||
    lower.includes("approval_rationale")
  ) {
    return "operator_override";
  }
  return "marginal_auto";
}

/**
 * Attempt to extract a GitHub PR URL from task `result` or `verification_notes`.
 * Returns null when no URL is found.
 */
function extractPrUrlFromTask(
  result: string | null | undefined,
  notes: string | null | undefined,
): string | null {
  const combined = [result ?? "", notes ?? ""].join(" ");
  // Match https://github.com/<owner>/<repo>/pull/<number>
  const match = combined.match(/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

/**
 * Choose the sparkline band for a day given its bypass rate.
 *
 * - nodata: no verified tasks (total = 0)
 * - ok:   bypass_rate < alertThreshold
 * - warn: bypass_rate >= alertThreshold
 */
function chooseBand(bypassRate: number | null, alertThreshold: number): BypassBand {
  if (bypassRate === null) return "nodata";
  return bypassRate >= alertThreshold ? "warn" : "ok";
}

/**
 * Generate a trend arrow for the current bypass rate vs. the previous day.
 *
 * Returns "▲" (up/worse), "▼" (down/better), or "→" (flat/no change).
 */
function trendArrow(sparkline: SparklineDay[]): string {
  if (sparkline.length < 2) return "→";
  const today = sparkline[sparkline.length - 1];
  const yesterday = sparkline[sparkline.length - 2];
  if (today.bypass_rate === null || yesterday.bypass_rate === null) return "→";
  const delta = today.bypass_rate - yesterday.bypass_rate;
  if (delta > 0.02) return "▲";
  if (delta < -0.02) return "▼";
  return "→";
}

// ── Main payload builder ───────────────────────────────────────────────────────

/**
 * Build the quality system health payload.
 *
 * Queries `getRecentVerifiedTasks()` for the last `days * 50` tasks (capped at
 * 500) to ensure sufficient data for both the sparkline and the current cycle.
 * Tasks are filtered to those with a non-null quality_score.
 *
 * @param store - A live IStateStore instance.
 * @param opts  - Optional configuration overrides.
 */
export function getQualitySystemHealthPayload(
  store: IStateStore,
  opts: QualitySystemHealthOptions = {},
): QualitySystemHealthPayload {
  const days = Math.max(1, opts.days ?? DEFAULT_SPARKLINE_DAYS);
  const floor = opts.floor ?? QUALITY_FLOOR;
  const alertThreshold = opts.alertThreshold ?? BYPASS_RATE_ALERT_THRESHOLD;
  const cycleTaskLimit = Math.max(1, opts.cycleTaskLimit ?? DEFAULT_CYCLE_TASK_LIMIT);

  // Fetch enough tasks to cover the sparkline window + a full current cycle
  const fetchLimit = Math.min(500, days * 50 + cycleTaskLimit);
  const allVerified = store.getRecentVerifiedTasks(fetchLimit);

  // ── Current cycle (most-recent `cycleTaskLimit` verified tasks) ────────────
  const cycleSlice = allVerified.slice(0, cycleTaskLimit);
  const cycleBypassed: BypassedTask[] = [];

  for (const task of cycleSlice) {
    if (
      task.verification_status === "approved" &&
      task.quality_score !== null &&
      task.quality_score !== undefined &&
      task.quality_score < floor
    ) {
      cycleBypassed.push({
        task_id: task.id,
        task_id_short: task.id.slice(0, 8),
        title: task.title,
        agent_name: task.agent_name ?? null,
        quality_score: task.quality_score,
        bypass_reason: classifyBypassReason(task.verification_notes),
        pr_url: extractPrUrlFromTask(task.result, task.verification_notes),
        bypassed_at: task.updated_at,
      });
    }
  }

  const cycleTotal = cycleSlice.length;
  const currentCycleBypassed = cycleBypassed.length;
  const currentCycleBypassRate =
    cycleTotal > 0 ? currentCycleBypassed / cycleTotal : null;

  const operatorOverrides = cycleBypassed.filter(
    (t) => t.bypass_reason === "operator_override",
  ).length;
  const marginalAuto = cycleBypassed.filter(
    (t) => t.bypass_reason === "marginal_auto",
  ).length;

  // ── Sparkline (one entry per calendar day, oldest → newest) ───────────────
  // Build a date-keyed map of { total, bypassed } across ALL fetched tasks
  const dateMap = new Map<string, { total: number; bypassed: number }>();

  // Initialise all days in the window to zero (ensures "nodata" shows correctly)
  const today = toDateKey(new Date().toISOString());
  for (let i = days - 1; i >= 0; i--) {
    const dateKey = addDays(today, -i);
    dateMap.set(dateKey, { total: 0, bypassed: 0 });
  }

  for (const task of allVerified) {
    if (task.quality_score === null || task.quality_score === undefined) continue;
    const dateKey = toDateKey(task.updated_at);
    if (!dateMap.has(dateKey)) continue; // outside our window

    const entry = dateMap.get(dateKey)!;
    entry.total += 1;
    if (
      task.verification_status === "approved" &&
      task.quality_score < floor
    ) {
      entry.bypassed += 1;
    }
  }

  const sparkline: SparklineDay[] = [];
  for (const [date, { total, bypassed }] of dateMap) {
    const bypassRate = total > 0 ? bypassed / total : null;
    sparkline.push({
      date,
      total,
      bypassed,
      bypass_rate: bypassRate,
      band: chooseBand(bypassRate, alertThreshold),
    });
  }
  // Ensure oldest → newest order
  sparkline.sort((a, b) => a.date.localeCompare(b.date));

  // ── Banner ─────────────────────────────────────────────────────────────────
  const arrow = trendArrow(sparkline);
  const ratePct =
    currentCycleBypassRate !== null
      ? `${Math.round(currentCycleBypassRate * 100)}%`
      : "n/a";
  const banner =
    currentCycleBypassRate !== null
      ? `Quality floor was bypassed ${ratePct} this cycle — ${currentCycleBypassed}/${cycleTotal} tasks ${arrow}`
      : `No verified tasks in current cycle`;

  const alertActive =
    currentCycleBypassRate !== null &&
    currentCycleBypassRate >= alertThreshold;

  return {
    banner,
    current_cycle_bypass_rate: currentCycleBypassRate,
    current_cycle_bypassed: currentCycleBypassed,
    current_cycle_total: cycleTotal,
    operator_overrides: operatorOverrides,
    marginal_auto: marginalAuto,
    sparkline,
    bypassed_tasks: cycleBypassed,
    alert_active: alertActive,
    alert_threshold: alertThreshold,
    floor,
    generated_at: new Date().toISOString(),
  };
}

// ── Telegram formatter ─────────────────────────────────────────────────────────

/**
 * Format a `QualitySystemHealthPayload` as a Telegram Markdown message for
 * the `/quality-health` bot command.
 *
 * Output sections:
 *   1. Banner with bypass rate and trend arrow
 *   2. Breakdown: operator_override vs marginal_auto counts
 *   3. 7-day bypass rate sparkline (text-based, one char per day)
 *   4. Detail list of bypassed tasks (up to 5)
 */
export function formatQualitySystemHealthPage(
  payload: QualitySystemHealthPayload,
): string {
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────
  const headerIcon = payload.alert_active ? "🚨" : "✅";
  lines.push(`${headerIcon} *Quality System Health*`);
  lines.push(``);
  lines.push(`_${payload.banner}_`);
  lines.push(``);

  // ── Bypass breakdown ────────────────────────────────────────────────────
  if (payload.current_cycle_total > 0) {
    const floorPct = Math.round(payload.floor * 100);
    lines.push(`*Below-floor approvals (< ${floorPct}% score):* ${payload.current_cycle_bypassed}/${payload.current_cycle_total}`);
    lines.push(`  • Operator overrides: ${payload.operator_overrides}`);
    lines.push(`  • Marginal auto-approved: ${payload.marginal_auto}`);
    lines.push(``);
  }

  // ── Sparkline ──────────────────────────────────────────────────────────
  if (payload.sparkline.length > 0) {
    const BAND_CHAR: Record<BypassBand, string> = {
      ok: "🟢",
      warn: "🔴",
      nodata: "⬜",
    };
    const sparkStr = payload.sparkline
      .map((day) => BAND_CHAR[day.band])
      .join("");
    const firstDate = payload.sparkline[0]?.date ?? "";
    const lastDate = payload.sparkline[payload.sparkline.length - 1]?.date ?? "";
    lines.push(`*${payload.sparkline.length}-day bypass rate trend:*`);
    lines.push(`${sparkStr}`);
    lines.push(`_${firstDate} → ${lastDate}_`);
    lines.push(`_🟢 ok (<${Math.round(payload.alert_threshold * 100)}%) · 🔴 warn · ⬜ no data_`);
    lines.push(``);
  }

  // ── Alert status ─────────────────────────────────────────────────────────
  if (payload.alert_active) {
    const thresholdPct = Math.round(payload.alert_threshold * 100);
    lines.push(`⚠️ *Alert active* — bypass rate ≥ ${thresholdPct}%. Quality gate is unreliable.`);
    lines.push(``);
  }

  // ── Bypassed task details ────────────────────────────────────────────────
  if (payload.bypassed_tasks.length === 0) {
    lines.push(`✅ No below-floor approvals in the current cycle.`);
  } else {
    lines.push(`*Bypassed tasks (current cycle):*`);
    const shown = payload.bypassed_tasks.slice(0, 5);
    for (const t of shown) {
      const score = `${(t.quality_score * 100).toFixed(0)}%`;
      const agent = t.agent_name ?? "unknown";
      const reason = t.bypass_reason === "operator_override"
        ? "🔓 operator"
        : "🤖 auto";
      const prLink = t.pr_url ? ` · [PR](${t.pr_url})` : "";
      lines.push(`  • \`${t.task_id_short}\` ${reason} ${score} _(${agent})_${prLink}`);
      lines.push(`    ${t.title.slice(0, 50)}`);
    }
    if (payload.bypassed_tasks.length > 5) {
      lines.push(`  _…and ${payload.bypassed_tasks.length - 5} more_`);
    }
  }

  return lines.join("\n");
}

// ── QualitySystemHealthMonitor ─────────────────────────────────────────────────

/** Options for `QualitySystemHealthMonitor`. */
export interface QualitySystemHealthMonitorOptions extends QualitySystemHealthOptions {
  /**
   * Dashboard URL for drill-down links in alerts.
   * Example: "https://dashboard.example.com".
   */
  dashboardUrl?: string;
}

/**
 * Daemon-style monitor that fires a Telegram alert when the bypass rate in the
 * current cycle exceeds `alertThreshold`.
 *
 * Uses a per-cycle deduplication key (date + 2-hour bucket) so one alert fires
 * per cycle window, not on every daemon poll iteration.
 */
export class QualitySystemHealthMonitor {
  private readonly log = createLogger("quality-system-health-monitor");
  private lastAlertCycleKey = "";

  constructor(
    private readonly store: IStateStore,
    private readonly notifier: Notifier | undefined,
    private readonly opts: QualitySystemHealthMonitorOptions = {},
  ) {}

  /**
   * Check current bypass rate and send a Telegram alert if:
   *   1. bypass_rate >= alertThreshold, AND
   *   2. We haven't already alerted in the current 2-hour cycle window.
   *
   * Returns true when a notification was dispatched (or attempted), false otherwise.
   */
  async checkAndAlert(nowMs: number = Date.now()): Promise<boolean> {
    const payload = getQualitySystemHealthPayload(this.store, this.opts);

    if (!payload.alert_active) {
      return false;
    }

    // Build a cycle key: "YYYY-MM-DD-HH" rounded to 2-hour buckets
    const now = new Date(nowMs);
    const hourBucket = Math.floor(now.getUTCHours() / 2) * 2;
    const cycleKey = `${toDateKey(now.toISOString())}-${String(hourBucket).padStart(2, "0")}`;

    if (this.lastAlertCycleKey === cycleKey) {
      this.log.info("Quality system health alert suppressed (already alerted this cycle)", {
        cycleKey,
        bypassRate: payload.current_cycle_bypass_rate,
      });
      return false;
    }

    if (!this.notifier) {
      this.log.warn("Quality system health alert fired but no notifier configured", {
        bypassRate: payload.current_cycle_bypass_rate,
        bypassed: payload.current_cycle_bypassed,
        total: payload.current_cycle_total,
      });
      this.lastAlertCycleKey = cycleKey;
      return false;
    }

    const thresholdPct = Math.round(payload.alert_threshold * 100);
    const ratePct =
      payload.current_cycle_bypass_rate !== null
        ? `${Math.round(payload.current_cycle_bypass_rate * 100)}%`
        : "n/a";

    const dashUrl = this.opts.dashboardUrl
      ? ` · [Dashboard](${this.opts.dashboardUrl}/quality-system-health)`
      : "";

    const alertBody = [
      `Bypass rate: *${ratePct}* (threshold: ${thresholdPct}%)`,
      `Bypassed: ${payload.current_cycle_bypassed}/${payload.current_cycle_total} tasks`,
      `Operator overrides: ${payload.operator_overrides} · Auto: ${payload.marginal_auto}`,
      dashUrl ? dashUrl : null,
    ].filter(Boolean).join("\n");

    try {
      await this.notifier.send(
        `🚨 *Quality gate credibility alert*\n\n${alertBody}`,
      );
      this.lastAlertCycleKey = cycleKey;
      this.log.info("Quality system health alert sent", {
        cycleKey,
        bypassRate: payload.current_cycle_bypass_rate,
      });
      return true;
    } catch (err) {
      this.log.error("Failed to send quality system health alert", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
