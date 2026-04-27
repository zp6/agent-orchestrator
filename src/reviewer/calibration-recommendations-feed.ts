/**
 * Calibration recommendations feed — REST API payload builders.
 *
 * Exposes persisted `calibration_recommendations` rows for dashboard operator
 * review and supports operator-driven resolution (approve / dismiss).
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   import {
 *     getCalibrationRecommendationsFeed,
 *     resolveCalibrationRecommendationById,
 *   } from 'claude-orchestrator-reviewer';
 *
 *   // GET /api/calibration-recommendations
 *   app.get('/api/calibration-recommendations', (req, res) => {
 *     const status = req.query.status as CalibrationRecommendationStatus | undefined;
 *     res.json(getCalibrationRecommendationsFeed(store, { status }));
 *   });
 *
 *   // POST /api/calibration-recommendations/:id/resolve
 *   app.post('/api/calibration-recommendations/:id/resolve', (req, res) => {
 *     const { status, notes } = req.body as { status: string; notes?: string };
 *     const result = resolveCalibrationRecommendationById(store, req.params.id, status, notes);
 *     if (!result.ok) return res.status(result.status).json({ error: result.error });
 *     res.json(result.recommendation);
 *   });
 *
 * Issue #477.
 */

import type {
  ICalibrationRecommendationStore,
  CalibrationRecommendation,
  CalibrationRecommendationStatus,
} from "../state/types.js";

// ── Feed types ──────────────────────────────────────────────────────────────

/**
 * Options for `getCalibrationRecommendationsFeed()`.
 */
export interface CalibrationRecommendationsFeedOptions {
  /**
   * Filter by status. When omitted, all recommendations are returned.
   */
  status?: CalibrationRecommendationStatus;
}

/**
 * Summary counts by status for the feed header.
 */
export interface CalibrationRecommendationsSummary {
  total: number;
  pending: number;
  applied: number;
  dismissed: number;
  auto_applied: number;
}

/**
 * Full calibration recommendations feed payload.
 */
export interface CalibrationRecommendationsFeed {
  /** ISO-8601 generation timestamp. */
  generated_at: string;
  /** Status filter applied (or null when all statuses are returned). */
  status_filter: CalibrationRecommendationStatus | null;
  summary: CalibrationRecommendationsSummary;
  recommendations: CalibrationRecommendation[];
}

// ── Resolve result types ────────────────────────────────────────────────────

/** Successful resolve result. */
export interface CalibrationResolveOk {
  ok: true;
  recommendation: CalibrationRecommendation;
}

/** Failed resolve result. */
export interface CalibrationResolveError {
  ok: false;
  status: 400 | 404;
  error: string;
}

export type CalibrationResolveResult = CalibrationResolveOk | CalibrationResolveError;

// ── Valid non-pending statuses for resolution ───────────────────────────────

const VALID_RESOLVE_STATUSES = new Set<string>(["applied", "dismissed", "auto_applied"]);

// ── Feed builder ────────────────────────────────────────────────────────────

/**
 * Build the calibration recommendations feed payload for dashboard display.
 *
 * @param store    A store implementing `ICalibrationRecommendationStore`.
 * @param opts     Optional filters.
 */
export function getCalibrationRecommendationsFeed(
  store: ICalibrationRecommendationStore,
  opts: CalibrationRecommendationsFeedOptions = {},
): CalibrationRecommendationsFeed {
  const recommendations = store.getCalibrationRecommendations(opts.status);

  // Compute summary from the unfiltered list when no status filter is applied,
  // or from the returned set when filtered.
  const summarySource = opts.status
    ? store.getCalibrationRecommendations()
    : recommendations;

  const summary: CalibrationRecommendationsSummary = {
    total: summarySource.length,
    pending: 0,
    applied: 0,
    dismissed: 0,
    auto_applied: 0,
  };
  for (const r of summarySource) {
    summary[r.status] = (summary[r.status] ?? 0) + 1;
  }

  return {
    generated_at: new Date().toISOString(),
    status_filter: opts.status ?? null,
    summary,
    recommendations,
  };
}

// ── Resolve handler ─────────────────────────────────────────────────────────

/**
 * Resolve a calibration recommendation by ID (operator approval or dismissal).
 *
 * Validates the requested status and delegates to the store. Returns a typed
 * result object so the caller can map it to HTTP responses without importing
 * store internals.
 *
 * @param store    A store implementing `ICalibrationRecommendationStore`.
 * @param id       The recommendation ID to resolve.
 * @param status   The new status (`applied`, `dismissed`, or `auto_applied`).
 * @param notes    Optional human-readable resolution note.
 */
export function resolveCalibrationRecommendationById(
  store: ICalibrationRecommendationStore,
  id: string,
  status: string,
  notes?: string,
): CalibrationResolveResult {
  if (!VALID_RESOLVE_STATUSES.has(status)) {
    return {
      ok: false,
      status: 400,
      error: `Invalid status "${status}". Must be one of: applied, dismissed, auto_applied`,
    };
  }

  const resolveStatus = status as Exclude<CalibrationRecommendationStatus, "pending">;
  const updated = store.resolveCalibrationRecommendation(id, resolveStatus, notes);

  if (!updated) {
    return {
      ok: false,
      status: 404,
      error: `Calibration recommendation "${id}" not found`,
    };
  }

  // Fetch the updated record to return to the caller
  const records = store.getCalibrationRecommendations();
  const recommendation = records.find((r) => r.id === id);

  if (!recommendation) {
    return {
      ok: false,
      status: 404,
      error: `Calibration recommendation "${id}" not found after update`,
    };
  }

  return { ok: true, recommendation };
}
