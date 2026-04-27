/**
 * Investigations feed formatter (issue #134 — coordinated change with research-agent#134).
 *
 * ## Problem
 *
 * The research agent now exposes an `/api/investigations` feed (built in
 * research-agent#128 / reviewer PR #418), but operators have no user-facing
 * command to see what the research agent is currently investigating.  They must
 * dig through task history to understand research state.
 *
 * ## Solution
 *
 * - `/investigations` Telegram command — calls the research agent's
 *   `GET /api/investigations` feed and renders a formatted list of
 *   pending / active / completed investigations with titles, dispatch times,
 *   result issue URLs, and finding summaries.
 *
 * - `getInvestigationsFeedPayload(investigations)` — pure function that converts
 *   a raw `Investigation[]` into a typed `InvestigationsFeedPayload` object
 *   suitable for the `/api/investigations` dashboard REST endpoint.
 *
 * - `formatInvestigationsForTelegram(investigations)` — renders the payload as
 *   a Telegram Markdown message.  Returns a plain "no active investigations"
 *   message when the feed is empty or all investigations are cancelled.
 *
 * ## Design
 *
 * Both public functions are pure / synchronous — they receive an already-fetched
 * `Investigation[]` from the caller so they are trivially testable without
 * HTTP mocking.  Network I/O is performed in the Telegram command handler which
 * calls `ResearchInvestigationClient.list()` before calling these helpers.
 *
 * ## Status ordering
 *
 * Active → Pending → Complete (newest first) → Cancelled (omitted by default)
 */

import type { Investigation, InvestigationStatus } from "./research-investigation-client.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Summary row for a single investigation in the feed payload. */
export interface InvestigationSummary {
  id: string;
  title: string;
  status: InvestigationStatus;
  /** ISO-8601 timestamp when the investigation was created. */
  created_at: string;
  /** ISO-8601 timestamp of the last status update. */
  updated_at: string;
  /** Source GitHub issue URL that triggered the investigation, if any. */
  source_issue_url?: string;
  /** One-line finding summary (present once complete). */
  finding_summary?: string;
  /** 0–100 quality score reported by the research agent (present once complete). */
  score?: number;
  /** GitHub issue URL created from findings (present once complete). */
  result_issue_url?: string;
}

/** Structured payload returned by `getInvestigationsFeedPayload()`. */
export interface InvestigationsFeedPayload {
  /** ISO-8601 timestamp when the payload was built. */
  generated_at: string;
  /** Counts broken down by status. */
  counts: {
    pending: number;
    active: number;
    complete: number;
    cancelled: number;
    total: number;
  };
  /** Active investigations (in-flight work). */
  active: InvestigationSummary[];
  /** Pending investigations (queued, not yet started). */
  pending: InvestigationSummary[];
  /** Completed investigations, newest first (last 20 at most). */
  recent_complete: InvestigationSummary[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum completed investigations to include in the payload / Telegram output. */
export const MAX_RECENT_COMPLETE = 20;

/** Maximum completed investigations shown in Telegram output (keeps messages short). */
export const MAX_COMPLETE_IN_TELEGRAM = 5;

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

function toSummary(inv: Investigation): InvestigationSummary {
  const s: InvestigationSummary = {
    id: inv.id,
    title: inv.title,
    status: inv.status,
    created_at: inv.created_at,
    updated_at: inv.updated_at,
  };
  if (inv.source_issue_url) s.source_issue_url = inv.source_issue_url;
  if (inv.finding_summary) s.finding_summary = inv.finding_summary;
  if (inv.score !== undefined) s.score = inv.score;
  if (inv.result_issue_url) s.result_issue_url = inv.result_issue_url;
  return s;
}

/** Compare by `updated_at` descending (newest first). */
function byUpdatedDesc(a: Investigation, b: Investigation): number {
  return b.updated_at.localeCompare(a.updated_at);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a raw `Investigation[]` from the research agent API into a typed
 * `InvestigationsFeedPayload` for the `/api/investigations` dashboard endpoint.
 *
 * @param investigations  Raw list returned by `ResearchInvestigationClient.list()`.
 *                        Pass an empty array to get a zero-count payload.
 */
export function getInvestigationsFeedPayload(
  investigations: Investigation[],
): InvestigationsFeedPayload {
  const pending = investigations.filter((i) => i.status === "pending").sort(byUpdatedDesc);
  const active = investigations.filter((i) => i.status === "active").sort(byUpdatedDesc);
  const complete = investigations.filter((i) => i.status === "complete").sort(byUpdatedDesc);
  const cancelled = investigations.filter((i) => i.status === "cancelled");

  return {
    generated_at: new Date().toISOString(),
    counts: {
      pending: pending.length,
      active: active.length,
      complete: complete.length,
      cancelled: cancelled.length,
      total: investigations.length,
    },
    active: active.map(toSummary),
    pending: pending.map(toSummary),
    recent_complete: complete.slice(0, MAX_RECENT_COMPLETE).map(toSummary),
  };
}

/**
 * Format a `Investigation[]` as a Telegram Markdown message for the
 * `/investigations` command.
 *
 * Cancelled investigations are omitted to keep the output focused on
 * actionable state.  Returns a concise "no active investigations" notice
 * when all investigations are absent or cancelled.
 *
 * @param investigations  Raw list returned by `ResearchInvestigationClient.list()`.
 * @param agentLabel      Optional label to show in the header (e.g. the base URL).
 */
export function formatInvestigationsForTelegram(
  investigations: Investigation[],
  agentLabel?: string,
): string {
  const active = investigations.filter((i) => i.status === "active").sort(byUpdatedDesc);
  const pending = investigations.filter((i) => i.status === "pending").sort(byUpdatedDesc);
  const complete = investigations
    .filter((i) => i.status === "complete")
    .sort(byUpdatedDesc)
    .slice(0, MAX_COMPLETE_IN_TELEGRAM);

  const hasWork = active.length > 0 || pending.length > 0 || complete.length > 0;
  if (!hasWork) {
    return "🔬 *Research Investigations*\n\nNo active investigations at this time.";
  }

  const lines: string[] = [
    `🔬 *Research Investigations*${agentLabel ? ` — ${agentLabel}` : ""}`,
    "",
  ];

  // Active
  if (active.length > 0) {
    lines.push(`*🟡 Active (${active.length})*`);
    for (const inv of active) {
      lines.push(`• *${escapeMarkdown(inv.title)}*`);
      lines.push(`  Started: ${formatDate(inv.updated_at)}`);
      if (inv.source_issue_url) {
        lines.push(`  Source: ${inv.source_issue_url}`);
      }
    }
    lines.push("");
  }

  // Pending
  if (pending.length > 0) {
    lines.push(`*⏳ Pending (${pending.length})*`);
    for (const inv of pending) {
      lines.push(`• *${escapeMarkdown(inv.title)}*`);
      lines.push(`  Queued: ${formatDate(inv.created_at)}`);
      if (inv.source_issue_url) {
        lines.push(`  Source: ${inv.source_issue_url}`);
      }
    }
    lines.push("");
  }

  // Recent complete
  if (complete.length > 0) {
    const totalComplete = investigations.filter((i) => i.status === "complete").length;
    const suffix =
      totalComplete > MAX_COMPLETE_IN_TELEGRAM
        ? ` — showing ${MAX_COMPLETE_IN_TELEGRAM} of ${totalComplete}`
        : "";
    lines.push(`*✅ Recently Completed${suffix}*`);
    for (const inv of complete) {
      lines.push(`• *${escapeMarkdown(inv.title)}*`);
      if (inv.finding_summary) {
        // Truncate long summaries for Telegram
        const summary =
          inv.finding_summary.length > 120
            ? inv.finding_summary.slice(0, 117) + "…"
            : inv.finding_summary;
        lines.push(`  _${escapeMarkdown(summary)}_`);
      }
      if (inv.result_issue_url) {
        lines.push(`  📌 Result: ${inv.result_issue_url}`);
      }
      if (inv.score !== undefined) {
        lines.push(`  Score: ${inv.score}/100`);
      }
      lines.push(`  Completed: ${formatDate(inv.updated_at)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Escape Telegram Markdown special characters.
 * Only escapes characters that cause parse errors in Markdown mode.
 */
function escapeMarkdown(text: string): string {
  // In legacy Markdown mode, escape *, _, `, [
  return text.replace(/[*_`[\]]/g, "\\$&");
}

/**
 * Format an ISO timestamp as a short human-readable date+time.
 * e.g. "2026-04-22 14:35 UTC"
 */
function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
    );
  } catch {
    return iso;
  }
}
