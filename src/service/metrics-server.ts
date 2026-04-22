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
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { StateStore, type DispatchBlockMetrics, type SemanticMemoryEffectivenessResult } from "../state/store.js";
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

    if (req.method !== "GET") {
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
        const body: DispatchEfficiencyResponse = {
          days: metrics.days,
          total_blocked: metrics.total_blocked,
          total_dispatches: metrics.total_dispatches,
          block_rate_pct: metrics.avg_block_rate_pct,
          trend: metrics.trend,
          daily: metrics.daily,
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

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("error", (err) => {
    log.warn("Metrics server error", { error: err.message });
  });

  server.listen(port, "127.0.0.1", () => {
    log.info("Metrics server started", {
      port,
      endpoints: ["/health", "/dispatch-efficiency", "/semantic-memory-effectiveness", "/investigations"],
    });
  });

  return server;
}
