/**
 * SubmissionAgent — Layer 3 of the fleet autonomous-revenue layer
 * (#1599 / #1512).
 *
 * Orchestrates the lifecycle of a security finding from raw draft to
 * platform-acknowledged submission:
 *
 *   1. queue(draft, adapter)  — sanitize + adapter.prepareSubmission(),
 *                                persist as `pending_submissions` row
 *                                (status='awaiting-approval').
 *   2. operator approves      — status -> 'approved' (CLI / Telegram).
 *   3. submitApproved(id)     — call adapter.submit(), persist `submissions`
 *                                row, mark pending row 'consumed'.
 *
 * **Why a queue rather than direct call?** Submissions are irreversible from
 * the platform's perspective and represent fleet identity. Per CLAUDE.md
 * operator-comms discipline, irreversible commitments are an explicit
 * Telegram-signal class — they require operator approval. The queue is the
 * boundary between agent-autonomy (drafting + sanitizing + ranking) and
 * operator-authority (approving the final submission).
 *
 * **Sandbox boundary:** the agent never re-feeds external response prose into
 * an LLM context. Only structured fields (id, status_url) cross out of the
 * adapter; only structured fields (status, reason) cross in.
 *
 * **Feature flag:** `SUBMISSION_AGENT_ENABLED` must be `"true"` for any
 * `submitApproved()` call to proceed. `queue()` runs unconditionally so
 * draft persistence remains useful even when the agent is disabled.
 */

import { sanitizeBountyContent } from "./bounty-sanitizer.js";
import type { StateStore, PendingSubmission, Submission } from "../state/store.js";
import type {
  FindingDraft,
  SubmissionAdapter,
  SubmitResult,
} from "./submission-adapters/types.js";

/** Result of `queue()` — either a queued row or a structured rejection. */
export type QueueResult =
  | { ok: true; pending: PendingSubmission }
  | { ok: false; reason: "sanitizer-flagged"; detail: string }
  | { ok: false; reason: "validation-failed"; detail: string }
  | { ok: false; reason: "platform-rejected"; detail: string };

/** Result of `submitApproved()`. */
export type SubmitApprovedResult =
  | { ok: true; submission: Submission }
  | { ok: false; reason: "feature-disabled"; detail: string }
  | { ok: false; reason: "not-found"; detail: string }
  | { ok: false; reason: "not-approved"; detail: string }
  | { ok: false; reason: "platform-rejected"; detail: string }
  | { ok: false; reason: "auth-missing"; detail: string }
  | { ok: false; reason: "network-error"; detail: string };

/** Whether the feature flag has been flipped on. */
export function isSubmissionAgentEnabled(): boolean {
  return process.env.SUBMISSION_AGENT_ENABLED === "true";
}

export class SubmissionAgent {
  private readonly store: StateStore;
  private readonly adapters: Map<string, SubmissionAdapter>;

  constructor(store: StateStore, adapters: SubmissionAdapter[]) {
    this.store = store;
    this.adapters = new Map();
    for (const adapter of adapters) {
      this.adapters.set(adapter.platform, adapter);
    }
  }

  /** Look up a registered adapter by platform name. */
  getAdapter(platform: string): SubmissionAdapter | undefined {
    return this.adapters.get(platform);
  }

  /** Names of registered adapters. */
  listPlatforms(): string[] {
    return [...this.adapters.keys()].sort();
  }

  /**
   * Queue a draft for operator approval.
   *
   * Defense-in-depth: even though the adapter sanitizes via
   * `bounty-sanitizer`, we run the same sanitizer here on the raw draft text
   * BEFORE the adapter sees it. That way a buggy/incomplete adapter still
   * cannot silently let injected text through. False positives are cheap;
   * false negatives let prompt-injection reach the operator's review.
   */
  async queue(draft: FindingDraft, platform: string): Promise<QueueResult> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      return {
        ok: false,
        reason: "validation-failed",
        detail: `No adapter registered for platform "${platform}". Available: ${this.listPlatforms().join(", ") || "(none)"}.`,
      };
    }

    // Top-level sanitizer pass (belt-and-braces; adapter does this too).
    const titleScan = sanitizeBountyContent(draft.title);
    if (!titleScan.safe) {
      return {
        ok: false,
        reason: "sanitizer-flagged",
        detail: `Title flagged before adapter: ${titleScan.reason ?? "unknown"}`,
      };
    }
    const bodyScan = sanitizeBountyContent(draft.body);
    if (!bodyScan.safe) {
      return {
        ok: false,
        reason: "sanitizer-flagged",
        detail: `Body flagged before adapter: ${bodyScan.reason ?? "unknown"}`,
      };
    }

    // Adapter prep (adds platform-specific validation + sanitizer).
    const prep = await adapter.prepareSubmission(draft);
    if (!prep.ok) {
      return prep;
    }

    // Persist as awaiting-approval. The DB row is the operator's view.
    const pending = this.store.addPendingSubmission({
      platform: adapter.platform,
      program: prep.payload.program,
      title: prep.payload.title,
      severity: prep.payload.severity,
      body: prep.payload.body,
      expected_payout_usd: prep.payload.expected_payout_usd,
      meta: prep.payload.meta,
    });
    return { ok: true, pending };
  }

  /**
   * Approve a queued submission (transition `awaiting-approval` -> `approved`).
   * Idempotent: returns true the first time, false on subsequent calls.
   */
  approve(pendingId: number): boolean {
    return this.store.approvePendingSubmission(pendingId);
  }

  /**
   * Reject a queued submission (transition `awaiting-approval` -> `rejected`).
   * Idempotent.
   */
  reject(pendingId: number, reason: string): boolean {
    return this.store.rejectPendingSubmission(pendingId, reason);
  }

  /**
   * Submit an approved pending submission to the external platform.
   *
   * Refuses to proceed unless:
   *   - `SUBMISSION_AGENT_ENABLED=true`
   *   - Pending row exists
   *   - Pending row is in `approved` state (not awaiting, not consumed, not rejected)
   *
   * On success, records a `submissions` row and marks the pending row `consumed`.
   * On platform rejection, the pending row stays `approved` so the operator
   * can investigate without re-approving.
   */
  async submitApproved(pendingId: number): Promise<SubmitApprovedResult> {
    if (!isSubmissionAgentEnabled()) {
      return {
        ok: false,
        reason: "feature-disabled",
        detail: "SUBMISSION_AGENT_ENABLED is not 'true'. Set the env var to enable network submission.",
      };
    }

    const pending = this.store.getPendingSubmission(pendingId);
    if (!pending) {
      return {
        ok: false,
        reason: "not-found",
        detail: `Pending submission #${pendingId} not found.`,
      };
    }
    if (pending.status !== "approved") {
      return {
        ok: false,
        reason: "not-approved",
        detail: `Pending submission #${pendingId} is in status '${pending.status}', not 'approved'.`,
      };
    }

    const adapter = this.adapters.get(pending.platform);
    if (!adapter) {
      return {
        ok: false,
        reason: "platform-rejected",
        detail: `No adapter registered for platform "${pending.platform}".`,
      };
    }

    // Re-sanitize before submission (defense-in-depth — the row may have been
    // edited externally between queue and submit).
    const bodyScan = sanitizeBountyContent(pending.body);
    if (!bodyScan.safe) {
      return {
        ok: false,
        reason: "platform-rejected",
        detail: `Body flagged at submit time: ${bodyScan.reason ?? "unknown"}. Refusing to submit.`,
      };
    }

    // Reconstruct the prepared payload. We don't trust the meta blob's brand
    // round-trip; we run prepareSubmission again to re-derive the payload.
    const prep = await adapter.prepareSubmission({
      program: pending.program,
      title: pending.title,
      severity: pending.severity as FindingDraft["severity"],
      body: pending.body,
      expected_payout_usd: pending.expected_payout_usd ?? undefined,
    });
    if (!prep.ok) {
      return {
        ok: false,
        reason: "platform-rejected",
        detail: `Re-prepare failed at submit time (${prep.reason}): ${prep.detail}`,
      };
    }

    const result: SubmitResult = await adapter.submit(prep.payload);
    if (!result.ok) {
      return { ok: false, reason: result.reason, detail: result.detail };
    }

    // Persist + transition.
    const submission = this.store.recordSubmission({
      pending_id: pending.id,
      platform: result.result.platform,
      program: pending.program,
      title: pending.title,
      severity: pending.severity,
      platform_submission_id: result.result.submission_id,
      status_url: result.result.status_url,
      expected_payout_usd: pending.expected_payout_usd,
      submitted_at: result.result.submitted_at,
    });
    this.store.markPendingSubmissionConsumed(pending.id);

    return { ok: true, submission };
  }
}
