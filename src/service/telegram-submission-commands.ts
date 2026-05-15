/**
 * telegram-submission-commands.ts (issue #1608)
 *
 * Pure command handlers for the submission queue, mirroring the CLI surface in
 * `src/cli/commands/submission.ts`:
 *
 *   /submissions                   → list awaiting-approval (paginated)
 *   /submission-show <id>          → full pending body
 *   /submission-approve <id>       → equivalent to `orch submission approve`
 *   /submission-reject <id> <why>  → equivalent to `orch submission reject --reason ...`
 *
 * Also exposes `tryHandleSubmissionApprove` / `tryHandleSubmissionReject` for
 * the existing `/approve` and `/reject` commands so an integer id is routed
 * to the submission queue while a ULID short-id falls through to the
 * borderline-task approval queue. Disambiguation is purely structural:
 * pending_submission ids are positive integers; task short-ids are Crockford
 * base32 ULIDs (start with a digit but contain at least one non-digit char).
 *
 * These functions are split out of `telegram.ts` so they're easy to unit-test
 * without booting the full polling loop.
 */

import type { StateStore, PendingSubmission } from "../state/store.js";
import {
  SubmissionAgent,
  isSubmissionAgentEnabled,
} from "../orchestrator/submission-agent.js";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Parses a numeric id arg from a command. Returns the int or null if the
 * arg is not a non-negative integer string.
 *
 * "12" → 12
 * "01KPFBW5" → null (ULID — has letters)
 * "12abc" → null (mixed)
 * "" → null
 * "-3" → null
 */
export function parseSubmissionId(arg: string | undefined): number | null {
  if (!arg) return null;
  if (!/^\d+$/.test(arg)) return null;
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function severityIcon(sev: string): string {
  switch (sev) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🟢";
    default:
      return "⚪️";
  }
}

function statusIcon(s: PendingSubmission["status"]): string {
  switch (s) {
    case "awaiting-approval":
      return "⏳";
    case "approved":
      return "✅";
    case "rejected":
      return "❌";
    case "consumed":
      return "📦";
    default:
      return "•";
  }
}

function formatPayout(usd: number | null): string {
  if (usd == null) return "n/a";
  return `$${usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

// ── /submissions ───────────────────────────────────────────────────────────

/**
 * Build the operator-facing summary of pending submissions.
 *
 * Default is awaiting-approval only, capped at 10 rows for Telegram width.
 */
export function buildSubmissionsList(
  store: StateStore,
  opts: { limit?: number } = {},
): string {
  const limit = opts.limit ?? 10;
  const rows = store.listPendingSubmissions({
    status: "awaiting-approval",
    limit,
  });
  if (rows.length === 0) {
    return "✅ No submissions awaiting approval.";
  }
  const lines = rows.map((r) => {
    const title = r.title.length > 60 ? `${r.title.slice(0, 57)}...` : r.title;
    return (
      `  ${statusIcon(r.status)} \`#${r.id}\` ${severityIcon(r.severity)} ${r.platform}/${r.program} — ${formatPayout(r.expected_payout_usd)}\n` +
      `      ${title}`
    );
  });
  return (
    `📨 *Pending Submissions (${rows.length})*\n\n${lines.join("\n")}\n\n` +
    `Show: \`/submission-show <id>\`\n` +
    `Approve: \`/submission-approve <id>\`\n` +
    `Reject: \`/submission-reject <id> <reason>\``
  );
}

// ── /submission-show <id> ──────────────────────────────────────────────────

/**
 * Render full pending body. Truncates body to ~3000 chars to stay safely under
 * the 4096 Telegram message limit; the operator can use `orch submission show`
 * for the full text.
 */
export function buildSubmissionShow(store: StateStore, id: number): string {
  const pending = store.getPendingSubmission(id);
  if (!pending) {
    return `❌ No pending submission with id \`#${id}\`.`;
  }
  const body =
    pending.body.length > 3000
      ? `${pending.body.slice(0, 3000)}\n\n... (truncated; \`orch submission show ${id}\` for full body)`
      : pending.body;

  const lines = [
    `${statusIcon(pending.status)} *Submission #${pending.id}*`,
    ``,
    `*Status:* ${pending.status}`,
    `*Platform:* ${pending.platform}/${pending.program}`,
    `*Severity:* ${severityIcon(pending.severity)} ${pending.severity}`,
    `*Title:* ${pending.title}`,
    `*Expected payout:* ${formatPayout(pending.expected_payout_usd)}`,
    `*Created:* ${pending.created_at}`,
  ];
  if (pending.rejection_reason) {
    lines.push(`*Rejection reason:* ${pending.rejection_reason}`);
  }
  lines.push("", "*Body:*", "```", body, "```");
  return lines.join("\n");
}

// ── approve / reject (callable from explicit AND /approve fallthrough) ─────

export interface SubmissionApproveResult {
  /** Whether this command was for a submission (vs. a ULID task). */
  matched: boolean;
  /** Operator-facing reply text. Only meaningful when matched=true. */
  reply: string;
}

/**
 * Tries to interpret `idArg` as a pending_submission id and approve it.
 *
 * Returns `{matched: false}` if `idArg` is not an integer (caller should
 * fall through to the existing borderline-task approve flow).
 *
 * Side effect: on success, transitions awaiting-approval → approved and
 * notes the operator decision in stdout via `reply`.
 */
export function tryHandleSubmissionApprove(
  store: StateStore,
  idArg: string | undefined,
): SubmissionApproveResult {
  const id = parseSubmissionId(idArg);
  if (id == null) return { matched: false, reply: "" };

  const pending = store.getPendingSubmission(id);
  if (!pending) {
    // We're confident this is targeting a submission (numeric id); surface
    // the right error rather than falling through to the task handler.
    return {
      matched: true,
      reply:
        `❌ No pending submission with id \`#${id}\`.\n` +
        `Use \`/submissions\` to see what's awaiting approval.`,
    };
  }

  if (pending.status !== "awaiting-approval") {
    return {
      matched: true,
      reply: `⚠️ Submission \`#${id}\` is already *${pending.status}*.`,
    };
  }

  const ok = store.approvePendingSubmission(id);
  if (!ok) {
    // Lost a race between read and update — re-read to report current state
    const reread = store.getPendingSubmission(id);
    return {
      matched: true,
      reply: `⚠️ Submission \`#${id}\` could not be approved (now *${reread?.status ?? "unknown"}*).`,
    };
  }

  return {
    matched: true,
    reply:
      `✅ Submission \`#${id}\` approved by operator.\n` +
      `*Platform:* ${pending.platform}/${pending.program}\n` +
      `*Title:* ${pending.title.slice(0, 120)}\n\n` +
      `Run \`orch submission submit ${id}\` to ship it (requires SUBMISSION_AGENT_ENABLED=true).`,
  };
}

// ── /submit <id> ─────────────────────────────────────────────────────────

/**
 * One-step approve-and-ship Telegram command (issue #1611).
 *
 * When `SUBMISSION_AGENT_ENABLED` is not set, returns a dry-run preview
 * without touching state — operators can practice the command before live mode.
 *
 * When the flag is on:
 *   1. If status is `awaiting-approval`, calls `store.approvePendingSubmission`.
 *   2. If status is already `approved`, skips the approve step.
 *   3. Calls `agent.submitApproved(id)`.
 *   4. Returns the platform status URL on success, or a structured error on failure.
 */
export async function handleSubmitCommand(
  store: StateStore,
  agent: SubmissionAgent,
  idArg: string | undefined,
): Promise<{ reply: string }> {
  const id = parseSubmissionId(idArg);
  if (id == null) {
    return { reply: "Usage: /submit <id>\nExample: /submit 7" };
  }

  // Feature flag off — dry-run preview only, no state changes.
  if (!isSubmissionAgentEnabled()) {
    const pending = store.getPendingSubmission(id);
    if (!pending) {
      return {
        reply:
          `❌ No pending submission with id \`#${id}\`.\n` +
          `Use \`/submissions\` to see what's awaiting approval.`,
      };
    }
    const stateNote =
      pending.status !== "awaiting-approval"
        ? `\n⚠️ Status is *${pending.status}* — must be awaiting-approval to ship.`
        : "";
    return {
      reply:
        `🔍 *Dry run* — SUBMISSION_AGENT_ENABLED is not set.\n\n` +
        `Would approve-and-ship *${pending.title.slice(0, 80)}*\n` +
        `Platform: ${pending.platform}/${pending.program} | ` +
        `Severity: ${pending.severity} | ` +
        `Expected payout: ${formatPayout(pending.expected_payout_usd)}` +
        stateNote +
        `\n\nSet \`SUBMISSION_AGENT_ENABLED=true\` to ship for real.`,
    };
  }

  // Read current state.
  const pending = store.getPendingSubmission(id);
  if (!pending) {
    return {
      reply:
        `❌ No pending submission with id \`#${id}\`.\n` +
        `Use \`/submissions\` to see what's awaiting approval.`,
    };
  }

  // Approve if still awaiting; pass through if already approved; reject otherwise.
  if (pending.status === "awaiting-approval") {
    const ok = store.approvePendingSubmission(id);
    if (!ok) {
      const reread = store.getPendingSubmission(id);
      return {
        reply: `⚠️ Submission \`#${id}\` could not be approved (now *${reread?.status ?? "unknown"}*).`,
      };
    }
  } else if (pending.status !== "approved") {
    return {
      reply: `⚠️ Submission \`#${id}\` is *${pending.status}* — cannot approve-and-ship.`,
    };
  }

  // Ship.
  const result = await agent.submitApproved(id);
  if (!result.ok) {
    return {
      reply:
        `✅ Submission \`#${id}\` approved.\n` +
        `❌ Ship failed (${result.reason}): ${result.detail}`,
    };
  }

  const s = result.submission;
  return {
    reply:
      `✅ Submission \`#${id}\` approved + shipped to *${s.platform}/${s.program}*\n\n` +
      `*Title:* ${s.title.slice(0, 100)}\n` +
      `*Status URL:* ${s.status_url}`,
  };
}

/**
 * Tries to interpret `idArg` as a pending_submission id and reject it.
 *
 * Reject requires a reason (audit trail). Returns `{matched: false}` for
 * non-numeric ids so the caller can fall through to the task reject flow.
 */
export function tryHandleSubmissionReject(
  store: StateStore,
  idArg: string | undefined,
  reason: string,
): SubmissionApproveResult {
  const id = parseSubmissionId(idArg);
  if (id == null) return { matched: false, reply: "" };

  if (!reason.trim()) {
    return {
      matched: true,
      reply:
        `Usage: /submission-reject <id> <reason>\n` +
        `Example: /submission-reject ${id} "Severity inflated; finding is medium not high"`,
    };
  }

  const pending = store.getPendingSubmission(id);
  if (!pending) {
    return {
      matched: true,
      reply: `❌ No pending submission with id \`#${id}\`.`,
    };
  }
  if (pending.status !== "awaiting-approval") {
    return {
      matched: true,
      reply: `⚠️ Submission \`#${id}\` is already *${pending.status}*.`,
    };
  }

  const ok = store.rejectPendingSubmission(id, reason);
  if (!ok) {
    const reread = store.getPendingSubmission(id);
    return {
      matched: true,
      reply: `⚠️ Submission \`#${id}\` could not be rejected (now *${reread?.status ?? "unknown"}*).`,
    };
  }

  return {
    matched: true,
    reply:
      `❌ Submission \`#${id}\` rejected.\n` +
      `*Platform:* ${pending.platform}/${pending.program}\n` +
      `*Reason:* ${reason}`,
  };
}
