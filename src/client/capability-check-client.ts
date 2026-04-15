/**
 * HTTP client for the agent-side `/capability-check` endpoint.
 *
 * Each Claude Code agent can expose a `GET /capability-check` endpoint that
 * inspects the incoming task title and type against its own capability profile
 * and returns `{ accept: true }` or `{ accept: false, reason: "..." }`.
 *
 * This is the orchestrator-side HTTP client that calls that endpoint.
 *
 * Design goals
 * ────────────
 * • Non-blocking: a missing endpoint (404) or network error is treated as
 *   "accept" so the existing capability enforcer remains the hard gate.
 * • Fast timeout (5 s): the check must not hold up the dispatch loop.
 * • Structured logging: all outcomes (accept, reject, not-supported, error)
 *   are logged at DEBUG level so operators can trace routing decisions.
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("capability-check-client");

// ── Request / response types ──────────────────────────────────────────────

export interface CapabilityCheckRequest {
  /** Human-readable task title (from the GitHub issue title). */
  title: string;
  /** Task type, usually "implementation" or "research". */
  task_type: string;
  /** Source reference, e.g. "rapartlu/agent-orchestrator#837". */
  source_ref?: string;
}

export interface CapabilityCheckResponse {
  /** Whether the agent accepts this task. */
  accept: boolean;
  /** Human-readable reason returned by the agent (present when accept is false). */
  reason?: string;
}

/** Outcome of a single capability-check call. */
export type CapabilityCheckOutcome =
  | { status: "accepted" }
  | { status: "rejected"; reason: string }
  | { status: "not-supported" }   // 404 — endpoint not implemented on this agent
  | { status: "error"; error: string };  // network / parse error

// ── HTTP client ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Call the agent's `/capability-check` endpoint and return a structured
 * outcome.  Never throws — all errors are captured in the `error` outcome.
 *
 * @param agentBaseUrl  Base URL of the agent (e.g. `http://localhost:3478`)
 * @param req           Capability check request payload
 * @param timeoutMs     Request timeout (default: 5 s)
 */
export async function callCapabilityCheck(
  agentBaseUrl: string,
  req: CapabilityCheckRequest,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CapabilityCheckOutcome> {
  const params = new URLSearchParams({
    title: req.title,
    task_type: req.task_type,
    ...(req.source_ref ? { source_ref: req.source_ref } : {}),
  });
  const url = `${agentBaseUrl}/capability-check?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (res.status === 404) {
      log.debug("Capability-check endpoint not supported by agent", { agentBaseUrl });
      return { status: "not-supported" };
    }

    if (!res.ok) {
      log.debug("Capability-check returned non-OK status", { agentBaseUrl, status: res.status });
      return { status: "error", error: `HTTP ${res.status}` };
    }

    const body = await res.json() as CapabilityCheckResponse;
    if (body.accept === false) {
      const reason = body.reason ?? "agent rejected the task (no reason given)";
      log.info("Capability-check: agent rejected task", { agentBaseUrl, reason, title: req.title });
      return { status: "rejected", reason };
    }

    log.debug("Capability-check: agent accepted task", { agentBaseUrl, title: req.title });
    return { status: "accepted" };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (error.includes("abort") || error.includes("AbortError")) {
      log.debug("Capability-check timed out — treating as accepted (non-blocking)", {
        agentBaseUrl,
        timeoutMs,
      });
    } else {
      log.debug("Capability-check request failed — treating as accepted (non-blocking)", {
        agentBaseUrl,
        error,
      });
    }
    return { status: "error", error };
  } finally {
    clearTimeout(timer);
  }
}
