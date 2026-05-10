/**
 * Immunefi adapter — Phase A of #1599 (Layer 3 of the fleet autonomous-revenue
 * layer / #1512).
 *
 * Targets crypto-direct payer programs on Immunefi (USDC payout, no KYC):
 * IPOR, Sky/MakerDAO, ENS, Ethena, etc. The actual network call is stubbed in
 * Phase A — the fleet does not yet hold an `IMMUNEFI_API_TOKEN`. When the
 * token is present, `submit()` will POST to Immunefi's submission API; when
 * absent, it returns `{ ok: false, reason: "auth-missing" }` so the
 * SubmissionAgent can surface the gap rather than silently failing.
 *
 * **Sandbox guarantee (CLAUDE.md):** this module never feeds external response
 * strings back to the agent's tool-calling layer. Network responses are
 * extracted into structured `SubmissionResult` fields and the raw body is
 * discarded. Even on platform errors, only the platform's HTTP status code
 * and a fixed error label propagate upward — never the raw error body.
 */

import { sanitizeBountyContent } from "../bounty-sanitizer.js";
import type {
  FindingDraft,
  PrepareResult,
  PreparedSubmission,
  SubmissionAdapter,
  SubmitResult,
} from "./types.js";

/**
 * No-KYC crypto-direct payer programs on Immunefi.
 *
 * This is the allow-list for Phase A. Programs not on this list are rejected
 * by `prepareSubmission()` because they may require KYC for payout — which
 * violates the discipline scope of #1599.
 *
 * To extend: each addition must be verified in Immunefi's program docs to
 * confirm USDC/DAI/ETH payout with no KYC requirement.
 */
export const IMMUNEFI_NO_KYC_PROGRAMS: ReadonlySet<string> = new Set([
  "ipor",
  "skydao",
  "sky",
  "makerdao",
  "ens",
  "ethena",
]);

/** Maximum body length Immunefi accepts (rough estimate; tighten if needed). */
const MAX_BODY_BYTES = 100_000;
/** Maximum title length. */
const MAX_TITLE_CHARS = 200;

/**
 * Default Immunefi API endpoint. Can be overridden via
 * `IMMUNEFI_API_BASE_URL` for staging/test runs (Phase B).
 */
const DEFAULT_API_BASE = "https://api.immunefi.com";

export class ImmunefiAdapter implements SubmissionAdapter {
  readonly platform = "immunefi";

  /** Allow-list override for tests. */
  private readonly allowedPrograms: ReadonlySet<string>;

  constructor(opts?: { allowedPrograms?: ReadonlySet<string> }) {
    this.allowedPrograms = opts?.allowedPrograms ?? IMMUNEFI_NO_KYC_PROGRAMS;
  }

  async prepareSubmission(draft: FindingDraft): Promise<PrepareResult> {
    // 1. Validate program is on the no-KYC allow-list.
    const programKey = draft.program.toLowerCase().trim();
    if (!this.allowedPrograms.has(programKey)) {
      return {
        ok: false,
        reason: "validation-failed",
        detail:
          `Program "${draft.program}" is not in the no-KYC allow-list. ` +
          `Phase A only submits to programs that pay USDC/DAI/ETH on-chain ` +
          `without KYC. See IMMUNEFI_NO_KYC_PROGRAMS in the immunefi adapter.`,
      };
    }

    // 2. Length checks (cheap, deterministic).
    if (draft.title.length > MAX_TITLE_CHARS) {
      return {
        ok: false,
        reason: "validation-failed",
        detail: `Title exceeds ${MAX_TITLE_CHARS} chars (${draft.title.length}).`,
      };
    }
    const bodyBytes = Buffer.byteLength(draft.body, "utf-8");
    if (bodyBytes > MAX_BODY_BYTES) {
      return {
        ok: false,
        reason: "validation-failed",
        detail: `Body exceeds ${MAX_BODY_BYTES} bytes (${bodyBytes}).`,
      };
    }

    // 3. Sanitize body and title for prompt-injection patterns. Both are
    // user-controlled text that may have come from external sources.
    const titleScan = sanitizeBountyContent(draft.title);
    if (!titleScan.safe) {
      return {
        ok: false,
        reason: "sanitizer-flagged",
        detail: `Title flagged: ${titleScan.reason ?? "unknown"}`,
      };
    }
    const bodyScan = sanitizeBountyContent(draft.body);
    if (!bodyScan.safe) {
      return {
        ok: false,
        reason: "sanitizer-flagged",
        detail: `Body flagged: ${bodyScan.reason ?? "unknown"}`,
      };
    }

    // 4. Build the prepared payload. The brand prevents callers from forging
    // a payload that bypasses prepareSubmission().
    const payload: PreparedSubmission = {
      _brand: "PreparedSubmission",
      program: programKey,
      title: draft.title.trim(),
      severity: draft.severity,
      body: draft.body,
      expected_payout_usd: draft.expected_payout_usd,
      meta: {
        adapter: this.platform,
        program_normalised: programKey,
        body_bytes: bodyBytes,
        prepared_at: new Date().toISOString(),
      },
    };
    return { ok: true, payload };
  }

  async submit(payload: PreparedSubmission): Promise<SubmitResult> {
    // Phase A: the fleet does not yet hold an Immunefi API token. Without it,
    // we cannot submit. Return a structured auth-missing result so the
    // SubmissionAgent can surface the gap to the operator rather than
    // silently failing.
    const apiToken = process.env.IMMUNEFI_API_TOKEN;
    if (!apiToken) {
      return {
        ok: false,
        reason: "auth-missing",
        detail:
          "IMMUNEFI_API_TOKEN env var not set. Phase A cannot complete the " +
          "actual network submission until the token is provisioned. " +
          "Phase B (separate issue) implements the live submission path.",
      };
    }

    // Phase B: live network call. Implemented behind the auth gate so Phase A
    // can ship the data plane without making any external network calls.
    const baseUrl = process.env.IMMUNEFI_API_BASE_URL ?? DEFAULT_API_BASE;
    try {
      const response = await fetch(`${baseUrl}/v1/submissions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          program: payload.program,
          title: payload.title,
          severity: payload.severity,
          body: payload.body,
        }),
      });

      if (!response.ok) {
        // We discard the response body — it's external untrusted data and
        // we do NOT want to risk a prompt-injected error message reaching
        // an LLM context. We surface only the HTTP status.
        return {
          ok: false,
          reason: "platform-rejected",
          detail: `Immunefi rejected submission with HTTP ${response.status}.`,
        };
      }

      // Parse only the fields we explicitly need. Everything else discarded.
      const data = (await response.json()) as {
        submission_id?: unknown;
        status_url?: unknown;
      };
      const submissionId =
        typeof data.submission_id === "string" ? data.submission_id : null;
      const statusUrl =
        typeof data.status_url === "string" ? data.status_url : null;
      if (!submissionId || !statusUrl) {
        return {
          ok: false,
          reason: "platform-rejected",
          detail: "Immunefi returned 200 but response was missing submission_id or status_url.",
        };
      }

      return {
        ok: true,
        result: {
          submission_id: submissionId,
          status_url: statusUrl,
          platform: this.platform,
          submitted_at: new Date().toISOString(),
        },
      };
    } catch (err) {
      // Discard error message detail — could be DNS leak, internal endpoint
      // info, or external prose. Keep it bounded.
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        reason: "network-error",
        detail: isAbort ? "Request aborted." : "Network call to Immunefi failed.",
      };
    }
  }
}
