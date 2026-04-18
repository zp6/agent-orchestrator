/**
 * Fleet health sparklines — `GET /fleet-health` API payload builder.
 *
 * Provides `getFleetHealthSparklines()` which the orchestrator or dashboard
 * server can mount as a single endpoint:
 *
 *   import { getFleetHealthSparklines } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/fleet-health', (_req, res) => {
 *     res.json(getFleetHealthSparklines(store, {
 *       task_history_base_url: '/tasks',
 *     }));
 *   });
 *
 * The response includes one sparkline series per active agent with:
 *   - `band` per daily data point: "red" (< 0.60), "yellow" (0.60–0.74),
 *     or "green" (≥ 0.75) so dashboards can colour individual points.
 *   - `task_history_url` per point: clicking a sparkline opens the per-agent
 *     task history filtered to that calendar date.
 *   - `risk_tier` per agent: the agent's overall band based on rolling_avg.
 *   - `fleet_summary`: counts of agents in each band (red / yellow / green).
 *
 * Threshold defaults:
 *   red_threshold    = 0.60   — below this: critical (red)
 *   yellow_threshold = 0.75   — below this: warning (yellow); at/above: green
 */

import type {
  IStateStore,
  FleetHealthSparklines,
  FleetRiskSummary,
} from "../state/types.js";

// ── Defaults ──────────────────────────────────────────────────────────────────

/** Score below which an agent is in the critical (red) band. */
export const FLEET_RED_THRESHOLD = 0.60;

/** Score at or above which an agent is healthy (green band). */
export const FLEET_YELLOW_THRESHOLD = 0.75;

/** Default look-back window in calendar days. */
export const FLEET_DEFAULT_DAYS = 7;

// ── Options ───────────────────────────────────────────────────────────────────

export interface FleetHealthSparklineOptions {
  /**
   * Number of calendar days to include in each sparkline series.
   * Default: 7.
   */
  days?: number;
  /**
   * Score below which a day's avg_score is coloured red (critical).
   * Default: 0.60.
   */
  red_threshold?: number;
  /**
   * Score at or above which a day's avg_score is coloured green (healthy).
   * Scores in [red_threshold, yellow_threshold) are coloured yellow.
   * Default: 0.75.
   */
  yellow_threshold?: number;
  /**
   * Base URL for the per-agent task history endpoint.
   * When provided, each sparkline point carries a `task_history_url` of the
   * form `<base>?agent=<name>&date=<YYYY-MM-DD>` so operators can click a
   * point and immediately see the tasks that drove the score on that day.
   *
   * Example: `'/tasks'` or `'https://dashboard.example.com/tasks'`.
   * Leave undefined or null to omit `task_history_url` from all points.
   */
  task_history_base_url?: string | null;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build the fleet health sparklines payload.
 *
 * Queries the state store for 7-day (or N-day) per-agent quality score
 * time series, annotates each data point with a colour band, and returns a
 * fleet-level risk summary alongside the sparkline series.
 *
 * @param store - A live `IStateStore` instance.
 * @param opts  - Optional threshold and URL overrides.
 */
export function getFleetHealthSparklines(
  store: IStateStore,
  opts: FleetHealthSparklineOptions = {},
): FleetHealthSparklines {
  const days = opts.days ?? FLEET_DEFAULT_DAYS;
  const redThreshold = opts.red_threshold ?? FLEET_RED_THRESHOLD;
  const yellowThreshold = opts.yellow_threshold ?? FLEET_YELLOW_THRESHOLD;
  const taskHistoryBaseUrl = opts.task_history_base_url ?? null;

  // Delegate to the store — it handles all band and URL annotation
  const trend = store.getAgentQualityTrend(
    days,
    yellowThreshold,  // warningThreshold aligns with yellow for backward compat
    redThreshold,
    yellowThreshold,
    taskHistoryBaseUrl,
  );

  // Build fleet-level risk summary
  const fleet_summary: FleetRiskSummary = {
    red: 0,
    yellow: 0,
    green: 0,
    no_data: 0,
    total_active: trend.per_agent.length,
  };

  for (const series of trend.per_agent) {
    switch (series.risk_tier) {
      case "red":    fleet_summary.red++;    break;
      case "yellow": fleet_summary.yellow++; break;
      case "green":  fleet_summary.green++;  break;
      default:       fleet_summary.no_data++;
    }
  }

  return {
    days: trend.days,
    red_threshold: trend.red_threshold,
    yellow_threshold: trend.yellow_threshold,
    fleet_summary,
    agents: trend.per_agent,
    generated_at: trend.generated_at,
  };
}
