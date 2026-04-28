/**
 * Quality anomaly feed — `/quality-anomalies` API payload builder.
 *
 * Exposes a dashboard-friendly feed of tasks whose verification score
 * contradicts the final decision:
 *   - score < 0.60 and approved
 *   - score > 0.85 and rejected
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import { getQualityAnomaliesApiPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/quality-anomalies', (req, res) => {
 *     res.json(getQualityAnomaliesApiPayload(store, {
 *       since: req.query.since as string | undefined,
 *       until: req.query.until as string | undefined,
 *       limit: req.query.limit ? Number(req.query.limit) : undefined,
 *     }));
 *   });
 */

import type {
  IQualityAnomalyStore,
  QualityAnomalyFeed,
  QualityAnomaly,
  QualityAnomalyQuery,
} from "../state/types.js";
import { createLogger } from "../service/logger.js";
import type { Notifier } from "../notify.js";

export interface QualityAnomaliesOptions extends QualityAnomalyQuery {}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SPIKE_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_SPIKE_THRESHOLD = 3;
const DEFAULT_FEED_URL = "/quality-anomalies";
const DEFAULT_QUERY_LIMIT = 1000;

export interface QualityAnomalySpikeDetectorOptions {
  /** Rolling window to inspect for spikes. Default: 1 hour. */
  windowMs?: number;
  /** Minimum number of anomalies required to alert. Default: 3. */
  threshold?: number;
  /** Link included in the Telegram alert. Default: `/quality-anomalies`. */
  feedUrl?: string;
}

export interface QualityAnomalySpikeSummary {
  generated_at: string;
  window_ms: number;
  threshold: number;
  total: number;
  anomalies: QualityAnomaly[];
  per_agent: Array<{ agent_name: string; count: number }>;
}

function normalizeWindowMs(windowMs: number | undefined): number {
  if (!Number.isFinite(windowMs) || (windowMs ?? 0) <= 0) {
    return DEFAULT_SPIKE_WINDOW_MS;
  }
  return Math.floor(windowMs ?? DEFAULT_SPIKE_WINDOW_MS);
}

function normalizeThreshold(threshold: number | undefined): number {
  if (!Number.isFinite(threshold) || (threshold ?? 0) < 1) {
    return DEFAULT_SPIKE_THRESHOLD;
  }
  return Math.floor(threshold ?? DEFAULT_SPIKE_THRESHOLD);
}

function formatWindowLabel(windowMs: number): string {
  const hours = windowMs / (60 * 60 * 1000);
  if (Number.isInteger(hours)) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }

  const minutes = windowMs / (60 * 1000);
  if (Number.isInteger(minutes)) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }

  return `${Math.round(windowMs / 1000)}s`;
}

function buildSpikeSummary(
  anomalies: QualityAnomaly[],
  windowMs: number,
  threshold: number,
): QualityAnomalySpikeSummary {
  const counts = new Map<string, number>();
  for (const anomaly of anomalies) {
    const agentName = anomaly.agent_name ?? "unknown";
    counts.set(agentName, (counts.get(agentName) ?? 0) + 1);
  }

  return {
    generated_at: new Date().toISOString(),
    window_ms: windowMs,
    threshold,
    total: anomalies.length,
    anomalies,
    per_agent: Array.from(counts.entries())
      .map(([agent_name, count]) => ({ agent_name, count }))
      .sort((a, b) => b.count - a.count || a.agent_name.localeCompare(b.agent_name)),
  };
}

export function formatQualityAnomalySpikeAlert(
  summary: QualityAnomalySpikeSummary,
  feedUrl: string,
): string {
  const windowLabel = formatWindowLabel(summary.window_ms);
  const affectedAgents = summary.per_agent.length > 0
    ? summary.per_agent.map((row) => `\`${row.agent_name}\` (${row.count})`).join(", ")
    : "unknown";

  const lines: string[] = [
    `🚨 *Quality anomaly spike detected*`,
    ``,
    `*Window:* last ${windowLabel}`,
    `*Count:* ${summary.total} anomalies`,
    `*Threshold:* ${summary.threshold}+`,
    `*Agents:* ${affectedAgents}`,
    `*Feed:* [quality anomaly feed](${feedUrl})`,
  ];

  return lines.join("\n");
}

/**
 * Spike detector for quality anomalies.
 *
 * Intended for daemon-style polling. The detector inspects a rolling window,
 * and if 3 or more anomalies are present it sends a Telegram notification
 * through the provided Notifier.
 */
export class QualityAnomalySpikeDetector {
  private readonly log = createLogger("quality-anomaly-spike");
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly feedUrl: string;
  private lastAlertedAt = 0;

  constructor(
    private store: IQualityAnomalyStore,
    private notifier?: Notifier,
    opts: QualityAnomalySpikeDetectorOptions = {},
  ) {
    this.windowMs = normalizeWindowMs(opts.windowMs);
    this.threshold = normalizeThreshold(opts.threshold);
    this.feedUrl = opts.feedUrl ?? DEFAULT_FEED_URL;
  }

  /**
   * Inspect the rolling window and send a Telegram alert if the spike threshold is met.
   *
   * Returns true when a notification was sent, false for no spike / suppressed / no notifier.
   */
  async checkAndAlert(nowMs: number = Date.now()): Promise<boolean> {
    const windowStartMs = nowMs - this.windowMs;
    const lookbackDays = Math.max(1, Math.ceil(this.windowMs / DAY_MS) + 1);

    const candidates = this.store.getQualityAnomalies({
      days: lookbackDays,
      limit: DEFAULT_QUERY_LIMIT,
    });
    const anomalies = candidates.filter((anomaly) => {
      const updatedAtMs = Date.parse(anomaly.updated_at);
      return Number.isFinite(updatedAtMs) && updatedAtMs >= windowStartMs && updatedAtMs <= nowMs;
    });

    if (anomalies.length < this.threshold) {
      return false;
    }

    if (this.lastAlertedAt !== 0 && nowMs - this.lastAlertedAt < this.windowMs) {
      this.log.info("Quality anomaly spike suppressed by rolling-window cooldown", {
        anomalyCount: anomalies.length,
        threshold: this.threshold,
        windowMs: this.windowMs,
      });
      return false;
    }

    if (!this.notifier || !this.notifier.isConfigured()) {
      this.log.warn("Telegram notifier not configured — quality anomaly spike not routed", {
        anomalyCount: anomalies.length,
        threshold: this.threshold,
      });
      return false;
    }

    const summary = buildSpikeSummary(anomalies, this.windowMs, this.threshold);

    try {
      const message = formatQualityAnomalySpikeAlert(summary, this.feedUrl);
      // NOISE SUPPRESSION (#564): Quality anomalies are informational monitoring.
      // Operator should query /anomalies command if interested; no push notifications.
      this.lastAlertedAt = nowMs;
      this.log.info("Quality anomaly spike detected (not sending to Telegram per #564)", {
        anomalyCount: summary.total,
        threshold: this.threshold,
        affectedAgents: summary.per_agent.length,
      });
      return true;
    } catch (err) {
      this.log.error("Failed to send quality anomaly spike notification", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

/**
 * Build the payload for the `GET /quality-anomalies` endpoint.
 *
 * The query supports either an explicit date range (`since` / `until`) or a
 * rolling look-back window (`days`), plus an optional result cap.
 */
export function getQualityAnomaliesApiPayload(
  store: IQualityAnomalyStore,
  opts: QualityAnomaliesOptions = {},
): QualityAnomalyFeed {
  const anomalies = store.getQualityAnomalies(opts);
  const days = Number.isFinite(opts.days) && (opts.days ?? 0) >= 1 ? Math.floor(opts.days ?? 7) : 7;
  const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1 ? Math.floor(opts.limit ?? 50) : 50;

  let total = anomalies.length;
  let lowScoreApproved = 0;
  let highScoreRejected = 0;
  for (const anomaly of anomalies) {
    if (anomaly.anomaly_type === "low_score_approved") {
      lowScoreApproved += 1;
    } else if (anomaly.anomaly_type === "high_score_rejected") {
      highScoreRejected += 1;
    }
  }

  return {
    generated_at: new Date().toISOString(),
    query: {
      since: opts.since ?? null,
      until: opts.until ?? null,
      days,
      limit,
    },
    anomalies,
    total,
    low_score_approved: lowScoreApproved,
    high_score_rejected: highScoreRejected,
  };
}
