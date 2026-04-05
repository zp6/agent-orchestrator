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

import type { IStateStore, SupervisorDecisionRecord, SupervisorDecisionQuery } from "./state/types.js";

export type { SupervisorDecisionQuery };

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
    dispatch: "dispatch    ",
    verify: "verify      ",
    redeploy: "redeploy    ",
    "create-issue": "create-issue",
    "follow-up": "follow-up   ",
    none: "none        ",
  };

  const lines: string[] = [];

  for (const d of decisions) {
    const ts = d.created_at
      ? new Date(d.created_at).toISOString().replace("T", " ").slice(0, 16)
      : "           ";
    const actionLabel = ACTION_LABEL[d.action] ?? d.action.padEnd(12);
    const agent = d.agent_name ? ` → ${d.agent_name}` : "";
    const issueRef = d.issue_ref ? `  (${d.issue_ref})` : "";

    lines.push(`[${ts}] ${actionLabel}${agent}${issueRef}`);
    lines.push(`  Reason:  ${d.reason}`);
    if (d.message) {
      lines.push(`  Message: ${d.message}`);
    }
    lines.push(`  Outcome: ${d.outcome}`);
    lines.push("");
  }

  // Remove trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}
