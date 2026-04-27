/**
 * Agent quality trend sparklines — `/agent-trends` API payload builder.
 *
 * Provides the `getAgentTrendsApiPayload()` function that the orchestrator
 * or dashboard server can mount as `GET /agent-trends` with a single line
 * of wiring code:
 *
 *   import { getAgentTrendsApiPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/agent-trends', (_req, res) => {
 *     res.json(getAgentTrendsApiPayload(store));
 *   });
 *
 * The response shape (`AgentQualityTrend`) is directly consumable by a
 * dashboard home panel rendering one sparkline per agent.  Agents whose
 * 7-day rolling average quality score drops below `warningThreshold`
 * (default 0.75) carry `below_threshold: true` so the UI can apply a
 * warning/red colour without additional computation.
 *
 * Dashboard rendering contract:
 *   - One sparkline per `per_agent` entry.
 *   - X-axis: the seven `days` points (oldest → newest).
 *   - Y-axis: `avg_score` (0–1).  Null points = no data that day; render
 *     as a gap or zero depending on the charting library.
 *   - `below_threshold: true` → render sparkline and agent label in red /
 *     warning colour.
 *   - `rolling_avg` can be displayed as a subtitle below the agent name.
 */

import type { IStateStore, AgentQualityTrend } from "../state/types.js";

/**
 * Options accepted by `getAgentTrendsApiPayload`.
 */
export interface AgentTrendsOptions {
  /**
   * Number of calendar days to include in each sparkline series.
   * Default: 7 (one week).
   */
  days?: number;
  /**
   * Agents whose rolling average quality score falls below this threshold
   * will have `below_threshold: true` in their series.
   * Default: 0.75.
   */
  warningThreshold?: number;
  /**
   * Score below which a data point or agent is in the critical (red) band.
   * Default: 0.60.
   */
  redThreshold?: number;
  /**
   * Score at or above which a data point or agent is healthy (green band).
   * Scores in [redThreshold, yellowThreshold) are yellow (warning).
   * Default: 0.75.
   */
  yellowThreshold?: number;
  /**
   * Base URL for per-agent task history click-through.
   * When provided, each `AgentQualityTrendPoint` includes a `task_history_url`
   * of the form `<base>?agent=<name>&date=<YYYY-MM-DD>`.
   * Example: `'/tasks'` or `'https://dashboard.example.com/tasks'`.
   * Pass null or omit to skip URL generation.
   */
  taskHistoryBaseUrl?: string | null;
}

/**
 * Build the payload for the `GET /agent-trends` endpoint.
 *
 * Returns an `AgentQualityTrend` object ready to be `res.json()`-ed.
 * Only agents with at least one scored task in the look-back window are
 * included — agents with no recent activity are silently omitted so the
 * dashboard doesn't show empty sparklines.
 *
 * Each `AgentQualityTrendPoint` now includes a `band` field ("red" / "yellow"
 * / "green" / null) so dashboards can colour sparkline segments without
 * re-implementing threshold logic.  The `task_history_url` field on each
 * point (when `taskHistoryBaseUrl` is provided) lets operators click a day's
 * point to open the filtered per-agent task history for that date.
 *
 * @param store  - A live `IStateStore` instance (pass the same instance
 *                 used by the orchestrator daemon).
 * @param opts   - Optional window size and threshold overrides.
 */
export function getAgentTrendsApiPayload(
  store: IStateStore,
  opts: AgentTrendsOptions = {},
): AgentQualityTrend {
  return store.getAgentQualityTrend(
    opts.days,
    opts.warningThreshold,
    opts.redThreshold,
    opts.yellowThreshold,
    opts.taskHistoryBaseUrl ?? null,
  );
}
