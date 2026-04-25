/**
 * Quality Summary — daily Telegram digest and `/quality-summary` formatter.
 *
 * Reports the rolling 24h approval-quality picture operators asked for in
 * issue #490:
 *   - total approvals
 *   - count below the configured floor (default 0.80)
 *   - marginal rate percentage
 *   - worst-scoring agent in the window
 *
 * The same report powers the daily digest and the on-demand Telegram command.
 */

import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";
import type { QualitySummaryReport } from "../state/types.js";

const log = createLogger("quality-summary");

export const QUALITY_SUMMARY_THRESHOLD = 0.80;
export const QUALITY_SUMMARY_LOOKBACK_HOURS = 24;
export const FLAG_LAST_QUALITY_SUMMARY_SENT = "quality_summary_digest_last_sent";

export interface IQualitySummaryStore {
  getQualitySummaryReport(windowHours?: number, threshold?: number): QualitySummaryReport;
}

export interface QualitySummaryDigestStore extends IQualitySummaryStore {
  getSystemFlag(key: string): string | null;
  setSystemFlag(key: string, value: string): void;
}

export interface QualitySummaryDigestOptions {
  windowHours?: number;
  threshold?: number;
}

export interface QualitySummarySchedulerOptions extends QualitySummaryDigestOptions {
  digestHourUtc?: number;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+=|{}.!\\-])/g, "\\$1");
}

function formatScore(score: number | null): string {
  return score === null ? "n/a" : score.toFixed(2);
}

/**
 * Build the live summary report from the backing store.
 */
export function buildQualitySummaryReport(
  store: IQualitySummaryStore,
  opts: QualitySummaryDigestOptions = {},
): QualitySummaryReport {
  const windowHours = opts.windowHours ?? QUALITY_SUMMARY_LOOKBACK_HOURS;
  const threshold = opts.threshold ?? QUALITY_SUMMARY_THRESHOLD;
  return store.getQualitySummaryReport(windowHours, threshold);
}

/**
 * Format the rolling quality summary as a Telegram Markdown message.
 */
export function formatQualitySummaryForTelegram(report: QualitySummaryReport): string {
  const thresholdLabel = report.threshold.toFixed(2);
  const header = `📈 *Quality Summary — last ${report.window_hours}h*`;
  const generatedAt = `_${new Date(report.generated_at).toUTCString()}_`;

  if (report.total_approved === 0) {
    return [
      header,
      generatedAt,
      ``,
      `No approved scored tasks in this window. ✅`,
      `Threshold: below ${thresholdLabel}`,
    ].join("\n");
  }

  const marginalRate = report.below_threshold_rate !== null
    ? `${(report.below_threshold_rate * 100).toFixed(1)}%`
    : "n/a";

  const lines: string[] = [
    header,
    generatedAt,
    ``,
    `Approved scored tasks: *${report.total_approved}*`,
    `Below ${thresholdLabel}: *${report.below_threshold_count}* (${marginalRate})`,
  ];

  if (report.worst_agent) {
    const worst = report.worst_agent;
    lines.push(
      `Worst agent: \`${escapeMarkdown(worst.agent_name)}\` — avg *${formatScore(worst.avg_quality_score)}* (${worst.below_threshold_count}/${worst.approved_count} below threshold)`,
    );
  }

  if (report.per_agent.length > 1) {
    lines.push(``, `*Worst agents*`);
    for (const [index, row] of report.per_agent.slice(0, 5).entries()) {
      lines.push(
        `${index + 1}. \`${escapeMarkdown(row.agent_name)}\` — avg *${formatScore(row.avg_quality_score)}*, ${row.below_threshold_count}/${row.approved_count} below ${thresholdLabel}`,
      );
    }
    if (report.per_agent.length > 5) {
      lines.push(`… and ${report.per_agent.length - 5} more agents`);
    }
  }

  return lines.join("\n");
}

/**
 * Telegram digest scheduler. Fires once per day at a configured UTC hour.
 */
export class QualitySummaryScheduler {
  private readonly store: QualitySummaryDigestStore;
  private readonly notifier: Notifier;
  private readonly digestHourUtc: number;
  private readonly windowHours: number;
  private readonly threshold: number;

  constructor(
    store: QualitySummaryDigestStore,
    notifier: Notifier,
    opts: QualitySummarySchedulerOptions = {},
  ) {
    this.store = store;
    this.notifier = notifier;
    this.digestHourUtc = opts.digestHourUtc ?? 9;
    this.windowHours = opts.windowHours ?? QUALITY_SUMMARY_LOOKBACK_HOURS;
    this.threshold = opts.threshold ?? QUALITY_SUMMARY_THRESHOLD;
  }

  async maybeFireDigest(): Promise<boolean> {
    const now = new Date();
    if (now.getUTCHours() !== this.digestHourUtc) return false;

    const todayKey = now.toISOString().slice(0, 10);
    const lastSent = this.store.getSystemFlag(FLAG_LAST_QUALITY_SUMMARY_SENT);
    if (lastSent && lastSent >= todayKey) return false;

    try {
      const report = buildQualitySummaryReport(this.store, {
        windowHours: this.windowHours,
        threshold: this.threshold,
      });
      await this.notifier.send(formatQualitySummaryForTelegram(report));
      this.store.setSystemFlag(FLAG_LAST_QUALITY_SUMMARY_SENT, todayKey);
      log.info("Quality summary digest sent", {
        totalApproved: report.total_approved,
        belowThreshold: report.below_threshold_count,
        marginalRate: report.below_threshold_rate,
        worstAgent: report.worst_agent?.agent_name ?? null,
      });
      return true;
    } catch (err) {
      log.error("Failed to send quality summary digest", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
