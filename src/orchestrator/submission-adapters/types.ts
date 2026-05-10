/**
 * Submission adapter interface — Layer 3 of the fleet autonomous-revenue layer
 * (#1599 / #1512).
 *
 * Each adapter wraps a single external platform (Immunefi, Sherlock, etc.) and
 * normalises submission flow behind a stable contract:
 *
 *   prepareSubmission(draft) -> sanitized payload + per-platform validation
 *   submit(payload)          -> network call, returns { submission_id, status_url }
 *
 * The adapter is the ONLY component that talks to the external network. All
 * sanitization, approval gating, and state persistence happen at higher layers
 * (`SubmissionAgent`).
 *
 * **Sandbox boundary (CLAUDE.md):** the adapter MUST NOT pipe response bodies
 * back into the agent's tool-calling context. External response strings are
 * data, not instructions. Adapters return structured `SubmissionResult`
 * objects, never raw external prose.
 */

/**
 * Input draft from upstream (revenue-executor agent or operator).
 *
 * `body` is markdown that may contain user-controlled text. It is sanitized
 * before any persistence or network call.
 */
export interface FindingDraft {
  /** Platform-specific program identifier (e.g. "ipor", "skydao"). */
  program: string;
  /** Human-readable title (≤ 200 chars). */
  title: string;
  /** Severity classification. */
  severity: "critical" | "high" | "medium" | "low" | "informational";
  /** Markdown finding body. */
  body: string;
  /** Expected payout band in USD (optional, helps treasury planning). */
  expected_payout_usd?: number;
}

/**
 * Sanitized + platform-validated payload ready for `submit()`.
 *
 * Distinct type so callers can't accidentally bypass `prepareSubmission()`.
 */
export interface PreparedSubmission {
  readonly _brand: "PreparedSubmission";
  program: string;
  title: string;
  severity: FindingDraft["severity"];
  body: string;
  expected_payout_usd?: number;
  /** Adapter-specific metadata (program-id mapping, target asset, etc.). */
  meta: Record<string, string | number | boolean>;
}

/**
 * Result of a successful submission.
 */
export interface SubmissionResult {
  /** Platform's opaque submission identifier. */
  submission_id: string;
  /** URL where the operator can monitor status (browser-friendly). */
  status_url: string;
  /** Platform name (matches adapter.platform). */
  platform: string;
  /** ISO timestamp of acceptance by the platform. */
  submitted_at: string;
}

/**
 * Result of `prepareSubmission()`.
 *
 * Either `ok: true` with a payload, or `ok: false` with a reason. Reasons are
 * structured so callers can decide whether to surface to the operator
 * (validation failure) or quarantine the draft (sanitizer flag).
 */
export type PrepareResult =
  | { ok: true; payload: PreparedSubmission }
  | { ok: false; reason: "sanitizer-flagged"; detail: string }
  | { ok: false; reason: "validation-failed"; detail: string }
  | { ok: false; reason: "platform-rejected"; detail: string };

/**
 * Outcome of `submit()`.
 *
 * The adapter NEVER throws on platform-side rejections — those are returned as
 * `{ ok: false, reason: "platform-rejected" }`. Throwing is reserved for
 * programming errors (the caller passed a non-prepared payload, etc.).
 */
export type SubmitResult =
  | { ok: true; result: SubmissionResult }
  | { ok: false; reason: "platform-rejected" | "network-error" | "auth-missing"; detail: string };

/**
 * Adapter contract.
 *
 * Implementations live in `src/orchestrator/submission-adapters/{name}.ts`.
 */
export interface SubmissionAdapter {
  /** Stable platform identifier (e.g. "immunefi"). Lowercase, no spaces. */
  readonly platform: string;

  /**
   * Sanitize the draft and validate against platform-specific rules.
   *
   * Returns either a prepared payload or a structured failure reason. Never
   * throws on bad input — bad input returns `{ ok: false }`.
   */
  prepareSubmission(draft: FindingDraft): Promise<PrepareResult>;

  /**
   * Submit a prepared payload to the external platform.
   *
   * The submission is irreversible from the platform's perspective. Callers
   * MUST have checked operator approval before invoking this method.
   */
  submit(payload: PreparedSubmission): Promise<SubmitResult>;
}
