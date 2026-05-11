/**
 * submission-pinger.ts (issue #1608)
 *
 * Auto-pages the operator on Telegram when a new `pending_submissions` row
 * lands in `awaiting-approval` state with a non-null `expected_payout_usd`.
 *
 * Why this is signal not noise (CLAUDE.md → Operator Communication
 * Discipline):
 *   - External-platform submissions are **irreversible** once shipped.
 *   - They represent fleet identity (a draft accidentally pushed to Immunefi
 *     is now permanently associated with the fleet's Immunefi account).
 *   - Operator review is the security gate before submission.
 *   - This is the canonical "irreversible commitment requiring operator
 *     sign-off" Telegram-signal class.
 *
 * Dedup contract: each pending row gets paged at most ONCE. The dedupe is
 * persistent (column `pending_submissions.operator_pinged_at`) so daemon
 * restarts do not re-page the operator. This is also resilient to multiple
 * daemon instances accidentally racing — the UPDATE returns `changes=0` for
 * the loser and we skip the send.
 *
 * Out of scope:
 *   - Inline-keyboard buttons (text commands sufficient for v1)
 *   - Multi-operator approval (single operator until #1264 severance done)
 *   - Re-paging on stale awaiting-approval rows (operator can `/submissions`
 *     to see them)
 */

import type { PendingSubmission, StateStore } from "../state/store.js";
import { notifyOperator } from "./notify.js";
import { createLogger } from "./logger.js";

const log = createLogger("submission-pinger");

/**
 * One-line summary suitable for inclusion in a Telegram alert body.
 * Truncates the title to 200 chars per the issue spec.
 */
export function formatSubmissionPing(p: PendingSubmission): string {
  const title = p.title.length > 200 ? `${p.title.slice(0, 197)}...` : p.title;
  const payout =
    p.expected_payout_usd != null
      ? `$${p.expected_payout_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "n/a";
  return [
    `New submission awaiting approval`,
    ``,
    `ID: #${p.id}`,
    `Platform: ${p.platform}/${p.program}`,
    `Severity: ${p.severity}`,
    `Expected payout: ${payout}`,
    `Title: ${title}`,
    ``,
    `Approve: /submission-approve ${p.id}`,
    `Reject: /submission-reject ${p.id} <reason>`,
    `Show full body: /submission-show ${p.id}`,
  ].join("\n");
}

/**
 * Scan for fresh awaiting-approval rows with non-null payout, page the
 * operator once each, and stamp `operator_pinged_at` so we never re-page.
 *
 * Returns the count of pings actually sent (after dedupe).
 *
 * Usage: call from the daemon cycle (cheap when there's nothing to ping;
 * the SELECT is index-backed by `idx_pending_submissions_status`).
 */
export async function pingPendingSubmissions(
  store: StateStore,
  notify: typeof notifyOperator = notifyOperator,
): Promise<number> {
  const rows = store.listSubmissionsAwaitingPing();
  if (rows.length === 0) return 0;

  let sent = 0;
  for (const row of rows) {
    // Race-safe: stamp BEFORE notifying. If two daemon instances ever race,
    // only one wins the UPDATE and only one sends. The notify is best-effort
    // (network may fail) — accepting that to keep the dedupe rock-solid.
    const claimed = store.markPendingSubmissionPinged(row.id);
    if (!claimed) continue; // already pinged in this race window

    const body = formatSubmissionPing(row);
    try {
      // rateLimitKey scoped per-id so unrelated submissions don't collide.
      // The 15-min in-memory rate-limit map is irrelevant here because we
      // only ping each id once anyway, but pass the key for trace clarity.
      await notify(
        "Submission awaiting approval",
        body,
        "warning",
        `submission-ping:${row.id}`,
      );
      sent += 1;
      log.info("Submission ping sent", {
        pendingId: row.id,
        platform: row.platform,
        program: row.program,
        severity: row.severity,
        expectedPayoutUsd: row.expected_payout_usd,
      });
    } catch (err) {
      log.error("Submission ping failed", {
        pendingId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Intentionally do NOT roll back operator_pinged_at: the rate-limit
      // semantics in CLAUDE.md prefer "best-effort, never spam" over
      // "always retry, risk double-paging". Operator can still see the row
      // via `/submissions` and `orch submission list`.
    }
  }
  return sent;
}
