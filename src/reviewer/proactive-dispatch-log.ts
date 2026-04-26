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
 * Filter options for getProactiveDispatches().
 */
export interface ProactiveDispatchOptions {
  /** Filter to dispatches targeting a specific agent (e.g. "claude-orchestrator-dashboard"). */
  agentName?: string;
  /**
   * Only include dispatches from the last N days/hours.
   * Accepts formats: "7d" (7 days), "24h" (24 hours), "2h30m" (compound).
   * Converted to an ISO-8601 timestamp before querying the store.
   */
  since?: string;
}

/**
 * Parse a "since" duration string (e.g. "7d", "24h", "2h30m") into an
 * ISO-8601 cutoff timestamp relative to now.
 *
 * Returns null when the input is missing or cannot be parsed.
 *
 * Exported for unit testing.
 */
export function parseSinceDuration(since: string | undefined, now = Date.now()): string | null {
  if (!since) return null;
  // Match optional day, hour, and minute components (e.g. "1d", "24h", "1h30m", "7d12h")
  const match = since.match(/^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (!match) return null;

  const days = parseInt(match[1] ?? "0", 10);
  const hours = parseInt(match[2] ?? "0", 10);
  const minutes = parseInt(match[3] ?? "0", 10);
  const totalMs = (days * 24 * 60 + hours * 60 + minutes) * 60_000;
  if (totalMs === 0) return null;

  return new Date(now - totalMs).toISOString();
}

/**
 * Retrieve the last N proactive supervisor dispatches, enriched with quality
 * scores and verification outcomes from the task store.
 *
 * Only "dispatch" and "follow-up" supervisor actions are included — pure
 * "verify", "none", or "redeploy" cycles are filtered out.
 *
 * @param store    State store (orchestrator's or reviewer's StateStore).
 * @param limit    Maximum dispatches to return (default 10, max 25).
 * @param options  Optional filters: agentName and/or since.
 */
export function getProactiveDispatches(
  store: IStateStore,
  limit = 10,
  options: ProactiveDispatchOptions = {},
): ProactiveDispatch[] {
  const cap = Math.min(limit, 25);

  const sinceTimestamp = parseSinceDuration(options.since);

  const decisions = querySupervisorLog(store, {
    action: "dispatch",
    limit: cap,
    agentName: options.agentName,
    since: sinceTimestamp ?? undefined,
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
 * @param options     Active filters (shown in the header for context).
 * @returns           Telegram Markdown-formatted string.
 */
export function formatProactiveDispatchesForTelegram(
  dispatches: ProactiveDispatch[],
  options: ProactiveDispatchOptions = {},
): string {
  // Build filter description for the header
  const filterParts: string[] = [];
  if (options.agentName) filterParts.push(`agent=${options.agentName}`);
  if (options.since) filterParts.push(`since=${options.since}`);
  const filterSuffix = filterParts.length > 0 ? ` · ${filterParts.join(" ")}` : "";

  if (dispatches.length === 0) {
    return `🤖 *Supervisor Dispatches*${filterSuffix}\n\nNo proactive dispatches found${filterParts.length > 0 ? " matching filters" : ""}.`;
  }

  const lines: string[] = [`🤖 *Supervisor Dispatches* (${dispatches.length}${filterSuffix})`, ``];

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
