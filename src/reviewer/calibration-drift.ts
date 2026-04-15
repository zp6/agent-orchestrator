/**
 * Calibration Drift Monitor
 *
 * Detects when verification score distributions shift significantly over time
 * and surfaces score histograms for the /verification-calibration dashboard page.
 *
 * Implements issue #71:
 *   ✔ Score distribution histogram per agent (last 30 days)
 *   ✔ Low-confidence approval rate (proxy for false-positive risk)
 *   ✔ Drift alert when mean score deviates >0.1 from baseline
 *   ✔ Supervisor context section for active drift alerts
 *   ✔ /verification-calibration Telegram page formatter
 *
 * Issue #79: per-agent deduplication cooldown to prevent alert flooding.
 *   ✔ Tracks last-alerted timestamp per agent in memory
 *   ✔ Suppresses repeat alerts within the cooldown window (default: 1 hour)
 *
 * Issue #198: Telegram alert includes sample window and dashboard link.
 *   ✔ Alert message includes recent/baseline window sizes in days and task counts
 *   ✔ Optional dashboardUrl adds a clickable calibration view link to every alert
 */

import type {
  IStateStore,
  AgentScoreDistribution,
  CalibrationDriftAlert,
  CalibrationDriftReport,
} from "../state/types.js";
import { createLogger } from "../service/logger.js";

export type {
  AgentScoreDistribution,
  CalibrationDriftAlert,
  CalibrationDriftReport,
};

const DRIFT_THRESHOLD = 0.1;

export interface CalibrationDriftProvider {
  buildReport(opts?: { windowDays?: number; recentDays?: number; baselineDays?: number }): CalibrationDriftReport;
  formatDistributionPage(report: CalibrationDriftReport): string;
  /**
   * Optionally emit active drift alerts to a caller-provided notifier.
   * Implementations can use this during daemon cycles to surface alerts
   * immediately instead of waiting for an operator to open the dashboard page.
   */
  checkAndAlert?(notify: (text: string) => Promise<void>): Promise<void>;
}

export class CalibrationDriftMonitor implements CalibrationDriftProvider {
  private log = createLogger("calibration-drift");

  /**
   * Per-agent timestamp (Date.now()) of the last successfully sent alert.
   * Persists across daemon cycles for the lifetime of this instance.
   */
  private lastAlertedAt = new Map<string, number>();

  /**
   * Minimum milliseconds between consecutive alerts for the same agent.
   * Defaults to 1 hour so a persistent drift condition does not flood Telegram
   * across every 30-second daemon cycle.
   */
  private readonly ALERT_COOLDOWN_MS: number;

  /**
   * Number of recent days used when checkAndAlert queries for drift.
   * Shown in alert messages so operators know the sample window.
   */
  private readonly recentDays: number;

  /**
   * Number of baseline days used when checkAndAlert queries for drift.
   * Shown in alert messages so operators know the comparison window.
   */
  private readonly baselineDays: number;

  /**
   * Optional URL of the dashboard calibration view.
   * When set, every Telegram drift alert includes a clickable link.
   *
   * Example: "https://dashboard.example.com/calibration"
   */
  private readonly dashboardUrl: string | undefined;

  constructor(
    private store: IStateStore,
    opts: {
      /**
       * URL of the dashboard calibration view included in Telegram alerts.
       * Omit to suppress the link (default: none).
       */
      dashboardUrl?: string;
      /**
       * Override the per-agent alert cooldown.  Useful for tests.
       * Default: 1 hour (3 600 000 ms).
       */
      alertCooldownMs?: number;
      /**
       * Recent window size for drift comparison, in days (default: 30).
       * Shown in alert messages.
       */
      recentDays?: number;
      /**
       * Baseline window size for drift comparison, in days (default: 60).
       * Shown in alert messages.
       */
      baselineDays?: number;
    } = {},
  ) {
    this.ALERT_COOLDOWN_MS = opts.alertCooldownMs ?? 60 * 60 * 1000; // 1 hour
    this.recentDays = opts.recentDays ?? 30;
    this.baselineDays = opts.baselineDays ?? 60;
    this.dashboardUrl = opts.dashboardUrl;
  }

  /**
   * Build a full calibration drift report.
   *
   * @param opts.windowDays   - Look-back window for score distributions (default: 30).
   * @param opts.recentDays   - Recent window for drift comparison (default: 30).
   * @param opts.baselineDays - Baseline window size before the recent window (default: 60).
   */
  buildReport(opts: {
    windowDays?: number;
    recentDays?: number;
    baselineDays?: number;
  } = {}): CalibrationDriftReport {
    const windowDays = opts.windowDays ?? 30;
    const recentDays = opts.recentDays ?? 30;
    const baselineDays = opts.baselineDays ?? 60;

    const distributions = this.store.getScoreDistributions(windowDays);
    const driftAlerts = this.store.getCalibrationDriftAlerts(recentDays, baselineDays);

    return {
      generated_at: new Date().toISOString(),
      window_days: windowDays,
      distributions,
      drift_alerts: driftAlerts,
    };
  }

  /**
   * Format the full /verification-calibration page for Telegram.
   *
   * Includes:
   * - Score distribution histogram per agent (ASCII bar chart)
   * - Low-confidence approval rate per agent
   * - Drift alerts for any agents whose mean score shifted > 0.1
   */
  formatDistributionPage(report: CalibrationDriftReport): string {
    const lines: string[] = [
      `📊 *Verification Calibration* (last ${report.window_days}d)`,
      `_Generated: ${report.generated_at.replace("T", " ").slice(0, 19)}_`,
      ``,
    ];

    if (report.distributions.length === 0) {
      lines.push("No verified tasks in the selected window.");
    } else {
      for (const dist of report.distributions) {
        lines.push(...formatAgentDistribution(dist));
        lines.push(``);
      }
    }

    // Drift alert section
    const alerted = report.drift_alerts.filter((a) => a.alerted);
    if (alerted.length > 0) {
      lines.push(`⚠️ *Drift Alerts* (|shift| > ${DRIFT_THRESHOLD})`);
      for (const a of alerted) {
        lines.push(...formatDriftAlertLine(a));
      }
    } else if (report.drift_alerts.length > 0) {
      lines.push(`✅ No calibration drift detected (all agents within ±${DRIFT_THRESHOLD})`);
    }

    return lines.join("\n").trimEnd();
  }

  /**
   * Format the drift alert section for supervisor context.
   * Returns an empty array when there are no active alerts.
   */
  formatDriftAlertSection(alerts: CalibrationDriftAlert[]): string[] {
    const active = alerts.filter((a) => a.alerted);
    if (active.length === 0) return [];

    const lines: string[] = [];
    for (const a of active) {
      const direction = a.drift > 0 ? "▲ up" : "▼ down";
      lines.push(
        `- ${a.agent_name}: mean drifted ${direction} ${Math.abs(a.drift).toFixed(2)} ` +
        `(baseline ${a.baseline_mean.toFixed(2)} → recent ${a.recent_mean.toFixed(2)}, ` +
        `${a.recent_task_count} recent / ${a.baseline_task_count} baseline tasks)`,
      );
    }
    return lines;
  }

  /**
   * Check for drift and fire a Telegram alert if any agents have drifted
   * beyond the threshold.  Designed to be called from the daemon cycle.
   *
   * Per-agent deduplication: an alert is only sent for an agent if it has not
   * been alerted within `ALERT_COOLDOWN_MS` (default 1 hour).  This prevents
   * a persistent drift condition from flooding Telegram on every 30-second
   * daemon tick.
   *
   * @param notify - Async function that sends a Telegram message.
   */
  async checkAndAlert(notify: (text: string) => Promise<void>): Promise<void> {
    try {
      const alerts = this.store.getCalibrationDriftAlerts(this.recentDays, this.baselineDays);
      const active = alerts.filter((a) => a.alerted);
      if (active.length === 0) return;

      // Per-agent cooldown: only alert agents whose cooldown has expired.
      const now = Date.now();
      const due = active.filter((a) => {
        const last = this.lastAlertedAt.get(a.agent_name);
        return last === undefined || now - last >= this.ALERT_COOLDOWN_MS;
      });
      if (due.length === 0) return;

      const lines: string[] = [
        `⚠️ *Calibration Drift Detected*`,
        ``,
        `${due.length} agent${due.length === 1 ? "" : "s"} drifted > ${DRIFT_THRESHOLD} from baseline:`,
        `_Sample window: ${this.recentDays}d recent · ${this.baselineDays}d baseline_`,
        ``,
      ];
      for (const a of due) {
        const direction = a.drift > 0 ? "▲" : "▼";
        lines.push(
          `${direction} *${a.agent_name}*: ${a.baseline_mean.toFixed(2)} → ${a.recent_mean.toFixed(2)} ` +
          `(drift ${a.drift > 0 ? "+" : ""}${a.drift.toFixed(2)}, ` +
          `${a.recent_task_count} recent · ${a.baseline_task_count} baseline tasks)`,
        );
      }
      lines.push(``, `Run \`/verification-calibration\` for score histograms.`);
      if (this.dashboardUrl) {
        lines.push(`[📊 Calibration View](${this.dashboardUrl})`);
      }

      await notify(lines.join("\n"));

      // Record alert timestamps only after a successful send.
      for (const a of due) {
        this.lastAlertedAt.set(a.agent_name, now);
      }

      this.log.info("Calibration drift alert sent", {
        agents: due.map((a) => a.agent_name),
        recentDays: this.recentDays,
        baselineDays: this.baselineDays,
        dashboardUrl: this.dashboardUrl,
      });
    } catch (err) {
      this.log.error("checkAndAlert failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Formatting helpers (exported for unit tests) ──────────────────────────

/**
 * Format one agent's score distribution as Telegram-ready lines.
 *
 * Example:
 *   *claude-orchestrator-reviewer* (42 tasks · mean 0.82 · low-conf approvals 12%)
 *   0.5─0.6  ▓▓       2
 *   0.6─0.7  ▓▓▓▓▓▓   6
 *   0.7─0.8  ▓▓▓▓▓▓▓▓ 8
 *   0.8─0.9  ▓▓▓▓▓▓▓▓▓▓▓▓ 12
 *   0.9─1.0  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 14
 */
export function formatAgentDistribution(dist: AgentScoreDistribution): string[] {
  const mean = dist.mean_score !== null ? dist.mean_score.toFixed(2) : "n/a";
  const lcRate =
    dist.low_confidence_approval_rate !== null
      ? `${(dist.low_confidence_approval_rate * 100).toFixed(0)}% low-conf approvals`
      : "no approvals";

  const lines: string[] = [
    `*${dist.agent_name}* (${dist.task_count} task${dist.task_count === 1 ? "" : "s"} · mean ${mean} · ${lcRate})`,
  ];

  if (dist.buckets.length === 0) {
    lines.push(`  _no scored tasks_`);
    return lines;
  }

  const maxCount = Math.max(...dist.buckets.map((b) => b.count));
  const BAR_WIDTH = 12;

  for (const bucket of dist.buckets) {
    const lo = bucket.bucket_min.toFixed(1);
    const hi = (bucket.bucket_min + 0.1).toFixed(1);
    const barLen = maxCount > 0 ? Math.round((bucket.count / maxCount) * BAR_WIDTH) : 0;
    const bar = "▓".repeat(barLen).padEnd(BAR_WIDTH);
    lines.push(`  \`${lo}─${hi}\` ${bar} ${bucket.count}`);
  }

  return lines;
}

/**
 * Format a single drift alert as a compact Telegram line.
 */
export function formatDriftAlertLine(alert: CalibrationDriftAlert): string[] {
  const direction = alert.drift > 0 ? "▲ up" : "▼ down";
  const signedDrift = `${alert.drift > 0 ? "+" : ""}${alert.drift.toFixed(2)}`;
  return [
    `  ⚠️ *${alert.agent_name}*: mean shifted ${direction} ${Math.abs(alert.drift).toFixed(2)} ` +
    `(${alert.baseline_mean.toFixed(2)} → ${alert.recent_mean.toFixed(2)}, drift ${signedDrift})`,
    `     Baseline: ${alert.baseline_task_count} tasks · Recent: ${alert.recent_task_count} tasks`,
  ];
}
