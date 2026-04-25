/**
 * Proactive dispatch rationale log — queryable log of supervisor-initiated
 * dispatch decisions, enriched with task quality scores and PR merge outcomes.
 *
 * The `/supervisor-dispatches` Telegram command uses this module to show
 * operators the last N proactive dispatches alongside:
 *   - The structured dispatch rationale (idle signal, confidence, borrow flag)
 *   - The resulting quality score from task verification
 *   - Whether the resulting PR was approved/merged
 *
 * This closes the ROI loop for the supervisor's idle-utilisation heuristic:
 * operators can see whether proactively dispatched work actually landed.
 *
 * @see supervisor-log.ts for the underlying querySupervisorLog() and
 *   DispatchRationale types.
 */

import type { IStateStore, SupervisorDecisionRecord, DispatchRationale } from "../state/types.js";
import { querySupervisorLog, formatRationaleSummary } from "../supervisor-log.js";

/**
 * A proactive dispatch record enriched with task outcome data.
 */
export interface ProactiveDispatch {
  /** The underlying supervisor decision record. */
  decision: SupervisorDecisionRecord;
  /** Parsed dispatch rationale (null if unparseable). */
  rationale: DispatchRationale | null;
  /** Quality score from task verification (null if not yet verified or task not found). */
  quality_score: number | null;
  /** Verification status of the resulting task (e.g. "approved", "rejected"). */
  verification_status: string | null;
  /** Compact rationale summary string for display. */
  rationale_summary: string | null;
}

/**
 * Parse a JSON-encoded DispatchRationale string.
 *
 * Returns null when the input is missing or invalid.
 */
function parseDispatchRationale(json: string | null | undefined): DispatchRationale | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== "object" || raw === null) return null;
    return raw as DispatchRationale;
  } catch {
    return null;
  }
}

/**
 * Retrieve the last N proactive supervisor dispatches, enriched with quality
 * scores and verification outcomes from the task store.
 *
 * Only "dispatch" and "follow-up" supervisor actions are included — pure
 * "verify", "none", or "redeploy" cycles are filtered out.
 *
 * @param store  State store (orchestrator's or reviewer's StateStore).
 * @param limit  Maximum dispatches to return (default 10, max 25).
 */
export function getProactiveDispatches(store: IStateStore, limit = 10): ProactiveDispatch[] {
  const cap = Math.min(limit, 25);

  const decisions = querySupervisorLog(store, {
    action: "dispatch",
    limit: cap,
  });

  return decisions.map((decision): ProactiveDispatch => {
    const rationale = parseDispatchRationale(decision.rationale);
    const rationale_summary = formatRationaleSummary(decision.rationale);

    // Enrich with task quality score if we have a task_id
    let quality_score: number | null = null;
    let verification_status: string | null = null;

    if (decision.task_id) {
      try {
        const task = store.getTask(decision.task_id);
        if (task) {
          quality_score = task.quality_score ?? null;
          verification_status = task.verification_status ?? null;
        }
      } catch {
        // Task lookup failure — leave scores null
      }
    }

    return {
      decision,
      rationale,
      quality_score,
      verification_status,
      rationale_summary,
    };
  });
}

/**
 * Format a quality score for compact display.
 *
 * Examples:
 *   0.92 → "92%"
 *   0.74 → "74% ⚠️"  (below 0.80 floor)
 *   null → "—"
 */
function formatScore(score: number | null): string {
  if (score === null) return "—";
  const pct = Math.round(score * 100);
  return pct < 80 ? `${pct}% ⚠️` : `${pct}%`;
}

/**
 * Format a verification status + quality score into a merged/not-merged badge.
 *
 * "approved"  → ✅ merged (or approved)
 * "rejected"  → ❌ rejected
 * "pending"   → ⏳ pending
 * null        → 🔍 unverified
 */
function formatOutcomeBadge(verificationStatus: string | null, score: number | null): string {
  if (!verificationStatus) return `🔍 unverified · ${formatScore(score)}`;

  switch (verificationStatus) {
    case "approved":
      return `✅ approved · ${formatScore(score)}`;
    case "rejected":
      return `❌ rejected · ${formatScore(score)}`;
    case "needs_operator_review":
      return `🚦 operator-review · ${formatScore(score)}`;
    case "pending":
    case "in_progress":
      return `⏳ in progress`;
    default:
      return `${verificationStatus} · ${formatScore(score)}`;
  }
}

/**
 * Format proactive dispatch entries for Telegram (Markdown).
 *
 * Example output per entry:
 *
 *   🚀 *dispatch* → `claude-orchestrator-dashboard`
 *   Issue: rapartlu/agent-dashboard#570
 *   _2026-04-25 14:32_ · ✅ approved · 88%
 *   idle=12m conf=0.85 [borrow]
 *   _High-value observability panel; idle dashboard agent_
 *
 * @param dispatches  From getProactiveDispatches(), newest-first.
 * @returns           Telegram Markdown-formatted string.
 */
export function formatProactiveDispatchesForTelegram(dispatches: ProactiveDispatch[]): string {
  if (dispatches.length === 0) {
    return "🤖 *Supervisor Dispatches*\n\nNo proactive dispatches recorded yet.";
  }

  const lines: string[] = [`🤖 *Supervisor Dispatches* (last ${dispatches.length})`, ``];

  for (const pd of dispatches) {
    const { decision, rationale, rationale_summary, quality_score, verification_status } = pd;

    const ts = decision.created_at
      ? new Date(decision.created_at).toISOString().replace("T", " ").slice(0, 16)
      : "—";
    const agent = decision.agent_name
      ? ` → \`${decision.agent_name.slice(0, 30)}\``
      : "";
    const issueRef = decision.issue_ref ?? "—";

    lines.push(`🚀 *${decision.action}*${agent}`);
    lines.push(`  Issue: ${issueRef}`);
    lines.push(`  _${ts}_ · ${formatOutcomeBadge(verification_status, quality_score)}`);

    // Structured rationale breakdown
    if (rationale) {
      const rationaleDetails: string[] = [];
      if (typeof rationale.agent_idle_duration_ms === "number") {
        const minutes = Math.round(rationale.agent_idle_duration_ms / 60_000);
        rationaleDetails.push(`idle=${minutes}m`);
      }
      if (typeof rationale.confidence_score === "number") {
        rationaleDetails.push(`conf=${rationale.confidence_score.toFixed(2)}`);
      }
      if (rationale.existing_pr_check_result) {
        rationaleDetails.push(`pr=${rationale.existing_pr_check_result}`);
      }
      if (rationale.borrow === true) {
        rationaleDetails.push("[borrow]");
      }
      if (rationaleDetails.length > 0) {
        lines.push(`  ${rationaleDetails.join(" ")}`);
      }
      if (rationale.llm_reasoning) {
        const truncated =
          rationale.llm_reasoning.length > 120
            ? rationale.llm_reasoning.slice(0, 117) + "…"
            : rationale.llm_reasoning;
        lines.push(`  _${truncated}_`);
      }
    } else if (rationale_summary) {
      lines.push(`  ${rationale_summary}`);
    }

    // Fallback: show one-sentence reason from the decision record
    if (!rationale?.llm_reasoning) {
      const shortReason = decision.reason.split(/[.!\n]/)[0].trim();
      const truncated = shortReason.length > 100 ? shortReason.slice(0, 97) + "…" : shortReason;
      if (truncated) lines.push(`  _${truncated}_`);
    }

    lines.push(``);
  }

  // Trim trailing blank line
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}
