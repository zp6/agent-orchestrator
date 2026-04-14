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
  QualityAnomalyQuery,
} from "../state/types.js";

export interface QualityAnomaliesOptions extends QualityAnomalyQuery {}

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
