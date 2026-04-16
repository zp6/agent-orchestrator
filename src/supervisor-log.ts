/**
 * Supervisor decision log — queryable log of supervisor decisions for CLI and API consumers.
 *
 * This module provides `querySupervisorLog()` and `formatSupervisorLogForCLI()` which
 * the orchestrator dashboard's `orch supervisor-log [--last N]` command uses to surface
 * supervisor reasoning without requiring SSH access to raw logs.
 *
 * Usage (from the dashboard CLI):
 *
 *   import { querySupervisorLog, formatSupervisorLogForCLI } from 'claude-orchestrator-reviewer';
 *
 *   const decisions = querySupervisorLog(store, { limit: 5 });
 *   console.log(formatSupervisorLogForCLI(decisions));
 */

import type {
  IStateStore,
  SupervisorDecisionRecord,
  SupervisorDecisionQuery,
  DispatchRationale,
} from "./state/types.js";

export type { SupervisorDecisionQuery };

/**
 * Parse and summarise a JSON-encoded DispatchRationale for one-line display.
 *
 * Returns a compact string like:
 *   "issue=open pr=none idle=12m conf=0.85 [borrow]"
 *
 * Returns null when the rationale cannot be parsed or contains nothing notable.
 *
 * Exported for unit testing.
 */
export function formatRationaleSummary(rationaleJson: string | null | undefined): string | null {
  if (!rationaleJson) return null;
  let parsed: DispatchRationale;
  try {
    const raw = JSON.parse(rationaleJson) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    parsed = raw as DispatchRationale;
  } catch {
    return null;
  }

  const parts: string[] = [];

  if (parsed.issue_state_at_dispatch) {
    parts.push(`issue=${parsed.issue_state_at_dispatch}`);
  }
  if (parsed.existing_pr_check_result) {
    parts.push(`pr=${parsed.existing_pr_check_result}`);
  }
  if (typeof parsed.agent_idle_duration_ms === "number") {
    const minutes = Math.round(parsed.agent_idle_duration_ms / 60_000);
    parts.push(`idle=${minutes}m`);
  }
  if (typeof parsed.confidence_score === "number") {
    parts.push(`conf=${parsed.confidence_score.toFixed(2)}`);
  }
  if (parsed.borrow === true) {
    parts.push("[borrow]");
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Query the supervisor decision log from state.db.
 *
 * @param store  Any IStateStore (orchestrator's or reviewer's own StateStore).
 * @param opts   Optional filter options (limit, action, agentName, since).
 * @returns      Decisions newest-first, up to opts.limit (default 20, max 100).
 */
export function querySupervisorLog(
  store: IStateStore,
  opts: SupervisorDecisionQuery = {},
): SupervisorDecisionRecord[] {
  return store.querySupervisorDecisions(opts);
}

/**
 * Format supervisor decisions for terminal (orch CLI) output.
 *
 * Each decision is printed as a block:
 *
 *   [2026-04-05 14:32] dispatch  → claude-proxy  (#42)
 *   Reason:  Agent is idle, issue #42 directly addresses the failing health check endpoint.
 *   Message: Implement issue #42 from rapartlu/claude-proxy: add /health endpoint.
 *   Outcome: dispatched
 *
 * @param decisions  Array of SupervisorDecisionRecord (newest-first).
 * @returns          Multi-line string ready to print to stdout.
 */
export function formatSupervisorLogForCLI(decisions: SupervisorDecisionRecord[]): string {
  if (decisions.length === 0) {
    return "No supervisor decisions recorded yet.";
  }

  const ACTION_LABEL: Record<string, string> = {
    dispatch: "dispatch      ",
    verify: "verify        ",
    redeploy: "redeploy      ",
    "create-issue": "create-issue  ",
    "follow-up": "follow-up     ",
    "borrow-blocked": "borrow-blocked",
    none: "none          ",
  };

  const lines: string[] = [];

  for (const d of decisions) {
    const ts = d.created_at
      ? new Date(d.created_at).toISOString().replace("T", " ").slice(0, 16)
      : "           ";
    const actionLabel = ACTION_LABEL[d.action] ?? d.action.padEnd(14);
    const agent = d.agent_name ? ` → ${d.agent_name}` : "";
    const issueRef = d.issue_ref ? `  (${d.issue_ref})` : "";

    lines.push(`[${ts}] ${actionLabel}${agent}${issueRef}`);
    lines.push(`  Reason:  ${d.reason}`);
    if (d.message) {
      lines.push(`  Message: ${d.message}`);
    }
    lines.push(`  Outcome: ${d.outcome}`);

    // Show borrow annotation and rationale summary when present
    if (d.rationale) {
      const rationaleNote = formatRationaleSummary(d.rationale);
      if (rationaleNote) {
        lines.push(`  Rationale: ${rationaleNote}`);
      }
    }

    lines.push("");
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

// ── Routing decision grouping ─────────────────────────────────────────────

/**
 * A grouped routing decision entry: one dispatch (or no-op) with the
 * skipped alternatives from within the same 60-second window.
 */
export interface RoutingDecisionEntry {
  /** ISO-8601 timestamp of the chosen dispatch (or the "none" decision). */
  timestamp: string;
  /** Agent the work was routed to, or null for no-op cycles. */
  agent_name: string | null;
  /** Issue/task reference that was chosen, or null. */
  chosen_issue: string | null;
  /** Issues that were considered but skipped in the same window. */
  skipped_issues: string[];
  /** One-sentence rationale extracted from the dispatch reason. */
  rationale: string;
  /** Raw action: "dispatch", "none", "follow-up", etc. */
  action: string;
  /** Outcome: "dispatched", "skipped", "escalated", etc. */
  outcome: string;
}

/**
 * Group supervisor decisions into routing decision entries.
 *
 * For each "dispatch" decision, collects "none"/"skipped" records within
 * a ±60s window as the alternatives that were passed over. If a cycle
 * produced only skips (no dispatch), the first skip is used as the entry.
 *
 * @param decisions  Raw decisions, newest-first (from querySupervisorLog).
 * @param limit      Maximum entries to return (default 10, max 25).
 */
export function buildRoutingDecisions(
  decisions: SupervisorDecisionRecord[],
  limit = 10,
): RoutingDecisionEntry[] {
  const cap = Math.min(limit, 25);
  const WINDOW_MS = 60_000; // 60-second grouping window

  const entries: RoutingDecisionEntry[] = [];
  const used = new Set<number | string>(); // by index or id

  // Work oldest-to-newest for grouping, then reverse output
  const ordered = [...decisions].reverse();

  for (let i = 0; i < ordered.length && entries.length < cap; i++) {
    const d = ordered[i];
    if (used.has(d.id)) continue;

    const ts = new Date(d.created_at).getTime();

    if (d.action === "dispatch" || d.action === "follow-up") {
      used.add(d.id);

      // Collect skips within the window
      const skipped: string[] = [];
      for (let j = 0; j < ordered.length; j++) {
        if (i === j) continue;
        const other = ordered[j];
        if (used.has(other.id)) continue;
        const otherTs = new Date(other.created_at).getTime();
        if (Math.abs(otherTs - ts) <= WINDOW_MS && other.outcome === "skipped") {
          const ref = other.issue_ref ?? other.reason.match(/#\d+/)?.[0] ?? null;
          if (ref && !skipped.includes(ref)) skipped.push(ref);
          used.add(other.id);
        }
      }

      entries.push({
        timestamp: d.created_at,
        agent_name: d.agent_name ?? null,
        chosen_issue: d.issue_ref ?? null,
        skipped_issues: skipped,
        rationale: extractOneLineSentence(d.reason),
        action: d.action,
        outcome: d.outcome,
      });
    } else if (d.outcome === "skipped" || d.action === "none") {
      // No-dispatch cycle — emit as a "skipped all" entry
      const windowSkips: string[] = [];
      for (let j = 0; j < ordered.length; j++) {
        const other = ordered[j];
        if (used.has(other.id)) continue;
        const otherTs = new Date(other.created_at).getTime();
        if (Math.abs(otherTs - ts) <= WINDOW_MS && other.outcome === "skipped") {
          const ref = other.issue_ref ?? other.reason.match(/#\d+/)?.[0] ?? null;
          if (ref && !windowSkips.includes(ref)) windowSkips.push(ref);
          used.add(other.id);
        }
      }
      used.add(d.id);

      entries.push({
        timestamp: d.created_at,
        agent_name: d.agent_name ?? null,
        chosen_issue: null,
        skipped_issues: windowSkips,
        rationale: extractOneLineSentence(d.reason),
        action: d.action,
        outcome: d.outcome,
      });
    }
  }

  // Return newest-first
  return entries.reverse();
}

/** Extract a single sentence (up to 120 chars) from a reason string. */
function extractOneLineSentence(reason: string): string {
  const sentence = reason.split(/[.!?\n]/)[0].trim();
  return sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;
}

/**
 * Format routing decision entries for Telegram (Markdown).
 *
 * Example output per entry:
 *
 *   🚀 *dispatch* → `claude-agent-orchestrator`
 *   Issue: #42 · Skipped: #41, #39
 *   _2026-04-16 10:32_
 *   Agent is idle and issue #42 addresses the failing health check
 *
 * @param entries  From buildRoutingDecisions(), newest-first.
 * @returns        Telegram Markdown-formatted string.
 */
export function formatDecisionsForTelegram(entries: RoutingDecisionEntry[]): string {
  if (entries.length === 0) {
    return "🤖 *Routing Decisions*\n\nNo dispatch decisions recorded yet.";
  }

  const ACTION_ICON: Record<string, string> = {
    dispatch: "🚀",
    "follow-up": "↩️",
    none: "⏸",
    verify: "🔍",
    redeploy: "🔄",
  };

  const lines: string[] = [`🤖 *Routing Decisions* (last ${entries.length})`, ``];

  for (const e of entries) {
    const icon = ACTION_ICON[e.action] ?? "🤖";
    const agent = e.agent_name ? ` → \`${e.agent_name.slice(0, 28)}\`` : "";
    const ts = new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 16);

    lines.push(`${icon} *${e.action}*${agent}`);

    const chosen = e.chosen_issue ? `Chosen: ${e.chosen_issue}` : "No dispatch";
    const skipped =
      e.skipped_issues.length > 0 ? ` · Skipped: ${e.skipped_issues.slice(0, 3).join(", ")}` : "";
    lines.push(`  ${chosen}${skipped}`);
    lines.push(`  _${ts}_ · ${e.outcome}`);
    lines.push(`  ${e.rationale}`);
    lines.push(``);
  }

  // Trim trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}

/**
 * Format routing decision entries for CLI output (plain text).
 *
 * @param entries  From buildRoutingDecisions(), newest-first.
 * @returns        Multi-line string suitable for stdout.
 */
export function formatDecisionsForCLI(entries: RoutingDecisionEntry[]): string {
  if (entries.length === 0) {
    return "No routing decisions recorded yet.";
  }

  const lines: string[] = [];

  for (const e of entries) {
    const ts = new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 16);
    const agent = e.agent_name ?? "(none)";
    const chosen = e.chosen_issue ?? "—";
    const skipped =
      e.skipped_issues.length > 0 ? e.skipped_issues.slice(0, 5).join(", ") : "(none)";

    lines.push(`[${ts}] ${e.action.padEnd(10)} → ${agent}`);
    lines.push(`  Chosen:  ${chosen}`);
    lines.push(`  Skipped: ${skipped}`);
    lines.push(`  Reason:  ${e.rationale}`);
    lines.push(`  Outcome: ${e.outcome}`);
    lines.push(``);
  }

  if (lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
