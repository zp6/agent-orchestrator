/**
 * Lightweight HTTP metrics server (issue #976).
 *
 * Exposes a `/dispatch-efficiency` endpoint so the dashboard and external
 * consumers can poll dispatch block-rate metrics without invoking the CLI.
 *
 * The server binds to the orchestrator's own port (default 3472) on 127.0.0.1
 * so it is reachable from the dashboard container on the same host.
 *
 * Endpoints:
 *   GET /dispatch-efficiency          — 7-day rolling window
 *   GET /dispatch-efficiency?days=30  — configurable window
 *   GET /health                       — basic liveness check
 *   GET /investigations               — research investigation feed (issue #140)
 *   GET /investigations?limit=20&offset=0&status=done
 *   GET /misrouting                   — research agent impl-task misroute feed (issue #1077)
 *   GET /misrouting?agent=claude-research-agent&days=7
 *   GET /supervisor-decisions                         — recent supervisor dispatch decisions (issue #1140)
 *   GET /supervisor-decisions?limit=50&agent=claude-agent-orchestrator&days=7
 *   GET /marginal-score-tasks                         — tasks with marginal quality scores + trend + per-agent (issue #597)
 *   GET /marginal-score-tasks?days=30&min_score=0.5&max_score=0.75&agent=<name>&limit=50&offset=0
 *   POST /marginal-score-tasks/:id/redispatch         — create a re-dispatch task for a marginal-score task
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import {
  StateStore,
  type DispatchBlockMetrics,
  type PRDetectionStrategyBreakdown,
  type SemanticMemoryEffectivenessResult,
  type FailureInterceptionStats,
  type VerificationCalibrationRecommendationRow,
  type SupervisorDecisionRecord,
  type StandupQualityAgentTrend,
  type MarginalScoreTasksResult,
} from "../state/store.js";
import { createLogger } from "./logger.js";

const log = createLogger("metrics-server");

/** Default port the orchestrator metrics server listens on. */
export const DEFAULT_METRICS_PORT = 3472;

/** Maximum rolling-window size operators may request (days). */
const MAX_WINDOW_DAYS = 90;

/** Maximum number of investigation items per page. */
const MAX_INVESTIGATIONS_LIMIT = 100;

/**
 * JSON response shape for GET /dispatch-efficiency.
 * Intentionally flat so dashboard widgets can read it without deep nesting.
 */
export interface DispatchEfficiencyResponse {
  /** Rolling window in days */
  days: number;
  /** Total dispatch-block events in the window */
  total_blocked: number;
  /** Total dispatch attempts (blocked + actual) in the window */
  total_dispatches: number;
  /** Average block rate as a percentage (0–100), null if no data */
  block_rate_pct: number | null;
  /** Trend direction */
  trend: DispatchBlockMetrics["trend"];
  /** Per-day breakdown, oldest first */
  daily: Array<{
    date: string;
    blocked: number;
    total: number;
    block_rate_pct: number | null;
  }>;
  /**
   * Breakdown of blocks by PR detection strategy (issue #1179).
   * Shows how often each detection path (search_index, branch_name, body_keyword)
   * was the deciding factor, over the same rolling window.
   */
  pr_detection_strategy_breakdown: PRDetectionStrategyBreakdown;
  /** ISO timestamp of when this response was generated */
  generated_at: string;
}

/**
 * A single investigation item in the feed response.
 * Long `result` fields are truncated to 500 chars to keep payloads lean.
 */
export interface InvestigationFeedItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  agent_name: string | null;
  verification_status: string | null;
  quality_score: number | null;
  /** First 500 chars of the result, or null. */
  result_excerpt: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * JSON response shape for GET /investigations.
 */
export interface InvestigationFeedResponse {
  /** Total number of matching investigations (across all pages). */
  total: number;
  /** Items on this page. */
  items: InvestigationFeedItem[];
  /** Pagination metadata. */
  limit: number;
  offset: number;
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * Quality score histogram buckets for GET /misrouting.
 */
export interface MisroutingQualityHistogram {
  excellent: number;
  good: number;
  fair: number;
  poor: number;
  unscored: number;
}

/**
 * A single misrouted task in the /misrouting feed.
 */
export interface MisroutingTaskItem {
  id: string;
  title: string;
  task_type: string;
  quality_score: number | null;
  status: string;
  created_at: string;
}

/**
 * JSON response shape for GET /failure-interceptions.
 */
export interface FailureInterceptionsResponse {
  /** Look-back window in days. */
  days: number;
  /** Total interceptions recorded in the window. */
  total_interceptions: number;
  /** Average similarity score across all interceptions (0–1). */
  avg_similarity: number;
  /** Number of interceptions where a model upgrade was suggested. */
  model_upgrades_suggested: number;
  /** Intercepted tasks that subsequently passed verification. */
  intercepted_tasks_passed: number;
  /** Intercepted tasks that subsequently failed verification. */
  intercepted_tasks_failed: number;
  /** Fraction of resolved interceptions that passed (0–1). */
  prevention_rate: number;
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * JSON response shape for GET /verification-calibration.
 */
export interface VerificationCalibrationResponse {
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
  /** Applied thresholds keyed by verifier agent. */
  applied_thresholds: Record<string, number>;
  /** Most recent calibration recommendations, newest first. */
  recommendations: VerificationCalibrationRecommendationRow[];
}

/**
 * JSON response shape for GET /supervisor-decisions (issue #1140).
 * Exposes supervisor dispatch rationale to unblock dashboard #570.
 */
export interface SupervisorDecisionsResponse {
  /** Look-back window in days (0 = no window filter, use limit only). */
  days: number;
  /** Maximum number of records returned. */
  limit: number;
  /** Optional agent name filter applied (null = all agents). */
  agent: string | null;
  /** Total number of decisions returned. */
  count: number;
  /** Decision records, newest first. */
  decisions: SupervisorDecisionRecord[];
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * JSON response shape for GET /standup-quality (issue #591).
 * Per-agent standup quality history with sparkline data, trend direction,
 * average scores, and operator alert flags.
 */
export interface StandupQualityResponse {
  /** Rolling window in days. */
  days: number;
  /** Agent name filter applied (null = all agents). */
  agent: string | null;
  /** One entry per agent with chronological score arrays and trend metadata. */
  per_agent: StandupQualityAgentTrend[];
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * JSON response shape for GET /marginal-score-tasks (issue #597).
 * Tasks with quality scores in a configurable marginal range,
 * plus daily trend data and per-agent breakdown for dashboard rendering.
 */
export interface MarginalScoreTasksResponse {
  /** Rolling window in days. */
  days: number;
  /** Lower bound of marginal range (inclusive). */
  min_score: number;
  /** Upper bound of marginal range (exclusive). */
  max_score: number;
  /** Agent name filter applied (null = all agents). */
  agent: string | null;
  /** Total matching tasks across all pages. */
  total: number;
  /** Average quality score across all matching tasks. */
  avg_score: number | null;
  /** Pagination: max records per page. */
  limit: number;
  /** Pagination: offset. */
  offset: number;
  /** Task records for this page. */
  tasks: MarginalScoreTasksResult["tasks"];
  /** Daily marginal-task counts (oldest first), suitable for sparkline rendering. */
  trend: MarginalScoreTasksResult["trend"];
  /** Per-agent count and average score breakdown. */
  per_agent: MarginalScoreTasksResult["per_agent"];
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * JSON response shape for POST /marginal-score-tasks/:id/redispatch.
 * Confirms creation of a re-dispatch task for the given marginal-score task.
 */
export interface MarginalRedispatchResponse {
  /** ID of the original marginal-score task. */
  original_task_id: string;
  /** Newly created re-dispatch task ID. */
  new_task_id: string;
  /** Title of the new task. */
  new_task_title: string;
  /** ISO timestamp of when the re-dispatch was created. */
  created_at: string;
}

/**
 * JSON response shape for GET /misrouting.
 * Returns implementation tasks that were dispatched to a research-only agent.
 */
export interface MisroutingFeedResponse {
  /** The agent being inspected. */
  agent: string;
  /** Look-back window in days. */
  days: number;
  /** Total number of misrouted tasks in the window. */
  count: number;
  /** Quality score distribution across all misrouted tasks. */
  quality_histogram: MisroutingQualityHistogram;
  /** Misrouted task list (most recent first, max 500). */
  tasks: MisroutingTaskItem[];
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

/**
 * JSON response shape for GET /guard-health (issue #1163).
 * PR guard surge suppression effectiveness metrics and leak tracking.
 */
export interface GuardHealthResponse {
  /** Look-back window in hours. */
  window_hours: number;
  /** Guard surge metrics. */
  metrics: {
    /** Total guard hits in the window. */
    total_hits: number;
    /** Guard hits that occurred after suppression was recorded (potential leaks). */
    leaked_hits: number;
    /** Number of currently active suppressions. */
    active_suppressions: number;
    /** List of active suppressions with expiry times. */
    suppressions: Array<{
      repo: string;
      issue_number: number;
      expires_at: string;
      minutes_remaining: number;
    }>;
  };
  /** ISO timestamp of when this response was generated. */
  generated_at: string;
}

// ── Handler helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function parseWindowDays(req: IncomingMessage): number {
  const url = new URL(req.url ?? "/", "http://localhost");
  const raw = url.searchParams.get("days");
  if (!raw) return 7;
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 1) return 7;
  return Math.min(n, MAX_WINDOW_DAYS);
}

// ── Server factory ─────────────────────────────────────────────────────────────

/**
 * Create and start the metrics HTTP server.
 *
 * @param store  Open StateStore instance (shared with daemon — read-only here).
 * @param port   Port to listen on (default: 3472).
 * @returns The started Server instance so callers can close it on shutdown.
 */
export function startMetricsServer(store: StateStore, port = DEFAULT_METRICS_PORT): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET" });
      res.end();
      return;
    }

    // POST is allowed only for the redispatch action on marginal-score-tasks
    const isRedispatch =
      req.method === "POST" && /^\/marginal-score-tasks\/[^/]+\/redispatch$/.test(url.pathname);
    if (req.method !== "GET" && !isRedispatch) {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (url.pathname === "/health") {
      sendJson(res, 200, { status: "ok", service: "orchestrator-metrics", at: new Date().toISOString() });
      return;
    }

    // ── GET /dispatch-efficiency ─────────────────────────────────────────────
    if (url.pathname === "/dispatch-efficiency") {
      const days = parseWindowDays(req);
      try {
        const metrics = store.getDispatchBlockMetrics(days);
        const strategyBreakdown = store.getPRDetectionStrategyBreakdown(days);
        const body: DispatchEfficiencyResponse = {
          days: metrics.days,
          total_blocked: metrics.total_blocked,
          total_dispatches: metrics.total_dispatches,
          block_rate_pct: metrics.avg_block_rate_pct,
          trend: metrics.trend,
          daily: metrics.daily,
          pr_detection_strategy_breakdown: strategyBreakdown,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to compute dispatch block metrics", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to compute metrics" });
      }
      return;
    }

    // ── GET /semantic-memory-effectiveness ───────────────────────────────────
    if (url.pathname === "/semantic-memory-effectiveness") {
      const days = parseWindowDays(req);
      try {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const result = store.getSemanticMemoryEffectiveness(since);
        sendJson(res, 200, result);
      } catch (err) {
        log.warn("Failed to compute semantic memory effectiveness", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to compute metrics" });
      }
      return;
    }

    // ── GET /investigations ───────────────────────────────────────────────────
    if (url.pathname === "/investigations") {
      const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
      const statusFilter = url.searchParams.get("status") ?? undefined;

      const limit = isNaN(rawLimit) || rawLimit < 1 ? 20 : Math.min(rawLimit, MAX_INVESTIGATIONS_LIMIT);
      const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

      try {
        const { total, items } = store.getInvestigationFeed(limit, offset, statusFilter);
        const feedItems: InvestigationFeedItem[] = items.map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          agent_name: t.agent_name,
          verification_status: t.verification_status,
          quality_score: t.quality_score,
          result_excerpt: t.result ? t.result.slice(0, 500) : null,
          source_ref: t.source_ref,
          created_at: t.created_at,
          updated_at: t.updated_at,
        }));
        const body: InvestigationFeedResponse = {
          total,
          items: feedItems,
          limit,
          offset,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch investigation feed", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch investigations" });
      }
      return;
    }

    // ── GET /misrouting ───────────────────────────────────────────────────────
    if (url.pathname === "/misrouting") {
      const days = parseWindowDays(req);
      const agent = url.searchParams.get("agent") ?? "claude-research-agent";

      try {
        const result = store.getResearchAgentImplMisroutes(agent, days);
        const body: MisroutingFeedResponse = {
          agent: result.agent,
          days: result.days,
          count: result.count,
          quality_histogram: result.qualityHistogram,
          tasks: result.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            task_type: t.taskType,
            quality_score: t.qualityScore,
            status: t.status,
            created_at: t.createdAt,
          })),
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch misrouting feed", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch misrouting data" });
      }
      return;
    }

    // ── GET /verification-calibration ───────────────────────────────────────
    if (url.pathname === "/verification-calibration") {
      try {
        const body: VerificationCalibrationResponse = {
          generated_at: new Date().toISOString(),
          applied_thresholds: store.getAppliedVerificationCalibrationThresholds(),
          recommendations: store.getVerificationCalibrationRecommendations(50),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch verification calibration data", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch calibration data" });
      }
      return;
    }

    // ── GET /failure-interceptions ─────────────────────────────────────────────
    if (url.pathname === "/failure-interceptions") {
      const days = parseWindowDays(req);
      try {
        const stats: FailureInterceptionStats = store.getFailureInterceptionStats(days);
        const entries = store.getFailureInterceptions(500, days);
        const passed = entries.filter((e) => e.final_outcome === "passed").length;
        const failed = entries.filter((e) => e.final_outcome === "failed").length;
        const body: FailureInterceptionsResponse = {
          days,
          total_interceptions: stats.total,
          avg_similarity: stats.avg_similarity,
          model_upgrades_suggested: stats.model_upgrades,
          intercepted_tasks_passed: passed,
          intercepted_tasks_failed: failed,
          prevention_rate: stats.prevention_rate,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to compute failure interception metrics", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to compute metrics" });
      }
      return;
    }

    // ── GET /api/ulid-collisions ──────────────────────────────────────────────
    // Returns all ULID collision events recorded by createTask() (issue #1133).
    // Each entry is a collision where two tasks shared the same ULID; the
    // createTask() path retried with a fresh ULID so the second task still
    // succeeded — these events are informational but indicate ULID generator
    // anomalies that warrant operator investigation.
    if (url.pathname === "/api/ulid-collisions") {
      try {
        const collisions = store.getUlidCollisions(500);
        const totalCount = store.getUlidCollisionCount();
        sendJson(res, 200, {
          total_collisions: totalCount,
          collisions: collisions.map((c) => ({
            id: c.id,
            colliding_id: c.collidingId,
            existing_title: c.existingTitle,
            new_title: c.newTitle,
            detected_at: c.detectedAt,
          })),
          generated_at: new Date().toISOString(),
        });
      } catch (err) {
        log.warn("Failed to fetch ULID collision log", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch ULID collision log" });
      }
      return;
    }

    // ── GET /supervisor-decisions ──────────────────────────────────────────────
    // Exposes supervisor dispatch rationale to unblock dashboard #570 (issue #1140).
    // The supervisor_decisions table already exists — this endpoint surfaces it
    // without requiring any new write path on the orchestrator side.
    //
    // Query params:
    //   limit=N  — max records (default 100, max 500)
    //   agent=X  — filter by agent_name
    //   days=N   — rolling window cutoff (default 0 = no filter, use limit only)
    if (url.pathname === "/supervisor-decisions") {
      try {
        const rawLimit = parseInt(url.searchParams.get("limit") ?? "100", 10);
        const limit = isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);
        const agent = url.searchParams.get("agent") || null;
        const rawDays = parseInt(url.searchParams.get("days") ?? "0", 10);
        const days = isNaN(rawDays) || rawDays < 0 ? 0 : Math.min(rawDays, MAX_WINDOW_DAYS);

        const decisions = store.getSupervisorDecisionsFeed(limit, agent, days);
        const body: SupervisorDecisionsResponse = {
          days,
          limit,
          agent,
          count: decisions.length,
          decisions,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch supervisor decisions", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch supervisor decisions" });
      }
      return;
    }

    // ── GET /standup-quality ───────────────────────────────────────────────────
    // Per-agent standup quality history with sparkline arrays, trend direction,
    // and operator alert flags (issue #591).
    //
    // Query params:
    //   agent=<name>  — filter to a single agent (default: all agents)
    //   days=N        — rolling window in days (default 30, max 90)
    if (url.pathname === "/standup-quality") {
      try {
        const agent = url.searchParams.get("agent") || null;
        const rawDays = parseInt(url.searchParams.get("days") ?? "30", 10);
        const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, MAX_WINDOW_DAYS);
        const per_agent = store.getStandupQualityTrend(agent, days);
        const body: StandupQualityResponse = {
          days,
          agent,
          per_agent,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch standup quality trend", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch standup quality data" });
      }
      return;
    }

    // ── GET /marginal-score-tasks ─────────────────────────────────────────────
    // Returns tasks with quality scores in the configurable marginal range,
    // daily trend data for sparkline rendering, and per-agent breakdown.
    // Supports operator "re-dispatch" workflow (see POST below).
    //
    // Query params:
    //   days=N          — rolling window in days (default 30, max 90)
    //   min_score=0.50  — lower bound inclusive (default 0.50)
    //   max_score=0.75  — upper bound exclusive (default 0.75)
    //   agent=<name>    — filter to a single agent (default: all agents)
    //   limit=N         — max tasks per page (default 50, max 200)
    //   offset=N        — pagination offset (default 0)
    if (req.method === "GET" && url.pathname === "/marginal-score-tasks") {
      try {
        const rawDays = parseInt(url.searchParams.get("days") ?? "30", 10);
        const days = isNaN(rawDays) || rawDays < 1 ? 30 : Math.min(rawDays, MAX_WINDOW_DAYS);

        const rawMin = parseFloat(url.searchParams.get("min_score") ?? "0.5");
        const rawMax = parseFloat(url.searchParams.get("max_score") ?? "0.75");
        const minScore = isNaN(rawMin) || rawMin < 0 ? 0.5 : Math.min(rawMin, 1);
        const maxScore = isNaN(rawMax) || rawMax <= minScore ? minScore + 0.25 : Math.min(rawMax, 1);

        const agent = url.searchParams.get("agent") || null;
        const rawLimit = parseInt(url.searchParams.get("limit") ?? "50", 10);
        const limit = isNaN(rawLimit) || rawLimit < 1 ? 50 : Math.min(rawLimit, 200);
        const rawOffset = parseInt(url.searchParams.get("offset") ?? "0", 10);
        const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

        const result = store.getMarginalScoreTasks(days, minScore, maxScore, agent, limit, offset);
        const body: MarginalScoreTasksResponse = {
          days,
          min_score: minScore,
          max_score: maxScore,
          agent,
          total: result.total,
          avg_score: result.avg_score,
          limit,
          offset,
          tasks: result.tasks,
          trend: result.trend,
          per_agent: result.per_agent,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch marginal-score tasks", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch marginal-score tasks" });
      }
      return;
    }

    // ── POST /marginal-score-tasks/:id/redispatch ─────────────────────────────
    // Creates a re-dispatch task for the given marginal-score task.
    // The new task inherits the original's description, agent, and source_ref,
    // with a [redispatch] prefix in the title for easy identification.
    //
    // Query params (same defaults as GET):
    //   min_score=0.50  — lower bound (must match the marginal range)
    //   max_score=0.75  — upper bound
    //
    // Returns 201 with the new task ID, or 404 if the task is not found /
    // does not fall within the marginal range.
    if (isRedispatch) {
      try {
        const parts = url.pathname.split("/");
        // pathname = /marginal-score-tasks/:id/redispatch → parts[2] is the id
        const taskId = parts[2];

        const rawMin = parseFloat(url.searchParams.get("min_score") ?? "0.5");
        const rawMax = parseFloat(url.searchParams.get("max_score") ?? "0.75");
        const minScore = isNaN(rawMin) || rawMin < 0 ? 0.5 : Math.min(rawMin, 1);
        const maxScore = isNaN(rawMax) || rawMax <= minScore ? minScore + 0.25 : Math.min(rawMax, 1);

        const newTask = store.createMarginalRedispatchTask(taskId, minScore, maxScore);
        if (!newTask) {
          sendJson(res, 404, {
            error: "Task not found or not in the marginal score range",
            task_id: taskId,
            min_score: minScore,
            max_score: maxScore,
          });
          return;
        }

        const body: MarginalRedispatchResponse = {
          original_task_id: taskId,
          new_task_id: newTask.id,
          new_task_title: newTask.title,
          created_at: newTask.created_at,
        };
        sendJson(res, 201, body);
      } catch (err) {
        log.warn("Failed to create marginal-score redispatch task", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to create redispatch task" });
      }
      return;
    }

    // ── GET /guard-health ─────────────────────────────────────────────────────
    // PR guard surge suppression effectiveness: hit counts, leaks, and active suppressions.
    // Issue #1163.
    if (url.pathname === "/guard-health") {
      const windowHours = parseFloat(url.searchParams.get("hours") ?? "24");
      const validHours = isNaN(windowHours) || windowHours < 1 ? 24 : Math.min(windowHours, 720); // max 30 days
      const windowMs = validHours * 60 * 60 * 1000;

      try {
        const metrics = store.getGuardHealthMetrics(windowMs);
        const body: GuardHealthResponse = {
          window_hours: validHours,
          metrics,
          generated_at: new Date().toISOString(),
        };
        sendJson(res, 200, body);
      } catch (err) {
        log.warn("Failed to fetch guard health metrics", {
          error: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 500, { error: "Failed to fetch guard health metrics" });
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("error", (err) => {
    log.warn("Metrics server error", { error: err.message });
  });

  server.listen(port, "127.0.0.1", () => {
    log.info("Metrics server started", {
      port,
      endpoints: [
        "/health",
        "/dispatch-efficiency",
        "/semantic-memory-effectiveness",
        "/investigations",
        "/misrouting",
        "/verification-calibration",
        "/failure-interceptions",
        "/api/ulid-collisions",
        "/supervisor-decisions",
        "/standup-quality",
        "/marginal-score-tasks",
        "POST /marginal-score-tasks/:id/redispatch",
        "/guard-health",
      ],
    });
  });

  return server;
}
