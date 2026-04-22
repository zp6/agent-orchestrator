/**
 * ResearchInvestigationClient — HTTP client for the research agent's investigation feed API.
 *
 * Introduced as part of the coordinated change for rapartlu/research-agent#128:
 * the research agent now exposes `/api/investigations` so operators and the
 * orchestrator can track what the research agent is investigating, what it found,
 * and which GitHub issues resulted from each investigation.
 *
 * The improvement detector uses this client to:
 *  1. Register a new investigation when it dispatches a research task.
 *  2. Activate the investigation when the research agent starts work.
 *  3. Complete the investigation (with finding summary + result issue URL) after
 *     `analyzeResearchFindings()` converts a report into a GitHub issue.
 *
 * All methods are fail-safe — network or parse errors are caught and logged;
 * the orchestrator daemon continues even when the research agent is unreachable.
 *
 * ## Research agent investigation lifecycle
 *
 *   pending → active → complete
 *                    ↘ cancelled
 *
 * ## Example usage (in the orchestrator dispatcher)
 *
 *   const client = new ResearchInvestigationClient('http://localhost:3478');
 *
 *   // When dispatching a research task:
 *   const inv = await client.register({
 *     title: 'Evaluate prompt-caching strategies',
 *     research_question: 'Which Anthropic caching options exist and how much do they save?',
 *     source_issue_url: 'https://github.com/rapartlu/agent-orchestrator/issues/42',
 *   });
 *
 *   // When the research agent starts:
 *   await client.activate(inv.id);
 *
 *   // When findings are analysed and an issue is filed:
 *   await client.complete(inv.id, {
 *     finding_summary: 'Prompt caching reduces token spend by 60–80% for long system prompts.',
 *     score: 91,
 *     result_issue_url: 'https://github.com/rapartlu/agent-orchestrator/issues/55',
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("research-investigation-client");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InvestigationStatus = "pending" | "active" | "complete" | "cancelled";

/** Shape returned by the research agent's GET /api/investigations endpoint. */
export interface Investigation {
  id: string;
  title: string;
  research_question: string;
  status: InvestigationStatus;
  source_issue_url?: string;
  finding_summary?: string;
  score?: number;
  result_issue_url?: string;
  created_at: string;
  updated_at: string;
}

/** Payload for registering a new investigation (POST /api/investigations). */
export interface RegisterInvestigationRequest {
  /** Short human-readable title, e.g. "Evaluate prompt-caching strategies". */
  title: string;
  /** The research question that will guide the investigation. */
  research_question: string;
  /** Optional GitHub issue URL that triggered this investigation. */
  source_issue_url?: string;
  /**
   * Optional stable ID to assign.  When omitted the research agent generates
   * a ULID automatically.  Supplying the orchestrator task ID here lets the
   * orchestrator correlate investigations with tasks without a separate lookup.
   */
  id?: string;
}

/** Payload for completing an investigation (PATCH /api/investigations/:id). */
export interface CompleteInvestigationRequest {
  /**
   * One-line summary of the key finding, e.g.
   * "Prompt caching reduces token spend by 60–80% for long system prompts."
   */
  finding_summary: string;
  /**
   * Relevance / quality score reported by the research agent (0–100).
   * Maps to the `score` field in the investigation feed.
   */
  score?: number;
  /**
   * URL of the GitHub issue created from this research finding, if any.
   * Surfaces the "🐙 #N" link in the `/research` Telegram command output.
   */
  result_issue_url?: string;
}

export interface ResearchInvestigationClientOptions {
  /**
   * Base URL of the research agent's HTTP server.
   * Defaults to `http://localhost:3478` (the standard fleet port).
   */
  baseUrl?: string;
  /** Fetch timeout in ms.  Defaults to 10 000 ms. */
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "http://localhost:3478";
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ResearchInvestigationClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: ResearchInvestigationClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Register a new investigation with the research agent.
   *
   * Returns the full `Investigation` object created by the research agent
   * (including the server-assigned `id` when none was provided), or `null`
   * if the request fails.
   *
   * @example
   *   const inv = await client.register({
   *     title: 'Evaluate rate-limiting patterns',
   *     research_question: 'What are the best rate-limiting strategies for high-throughput agents?',
   *   });
   *   if (inv) log.info('registered investigation', { id: inv.id });
   */
  async register(req: RegisterInvestigationRequest): Promise<Investigation | null> {
    return this.request<Investigation>("POST", "/api/investigations", req as unknown as Record<string, unknown>);
  }

  /**
   * Mark a pending investigation as active (the research agent has started work).
   *
   * Returns the updated `Investigation`, or `null` on failure.
   */
  async activate(id: string): Promise<Investigation | null> {
    return this.request<Investigation>("PATCH", `/api/investigations/${encodeURIComponent(id)}`, {
      action: "activate",
    });
  }

  /**
   * Mark an active investigation as complete and record the findings.
   *
   * @param id                The investigation ID returned by `register()`.
   * @param completionData    Finding summary, optional quality score, and optional result issue URL.
   *
   * Returns the updated `Investigation`, or `null` on failure.
   *
   * @example
   *   await client.complete(inv.id, {
   *     finding_summary: 'Prompt caching reduces token spend by 60–80%.',
   *     score: 91,
   *     result_issue_url: 'https://github.com/rapartlu/agent-orchestrator/issues/55',
   *   });
   */
  async complete(id: string, data: CompleteInvestigationRequest): Promise<Investigation | null> {
    return this.request<Investigation>("PATCH", `/api/investigations/${encodeURIComponent(id)}`, {
      action: "complete",
      ...data,
    });
  }

  /**
   * Cancel a pending or active investigation (e.g. the research task was dropped
   * or the improvement was superseded).
   *
   * Returns the updated `Investigation`, or `null` on failure.
   */
  async cancel(id: string, reason?: string): Promise<Investigation | null> {
    return this.request<Investigation>("PATCH", `/api/investigations/${encodeURIComponent(id)}`, {
      action: "cancel",
      ...(reason ? { finding_summary: reason } : {}),
    });
  }

  /**
   * Fetch the current list of investigations.
   *
   * @param status  Optional filter: "pending" | "active" | "complete" | "cancelled".
   * @param limit   Maximum number of results (default: 20).
   *
   * Returns an empty array on failure so callers can degrade gracefully.
   */
  async list(
    opts: { status?: InvestigationStatus; limit?: number } = {},
  ): Promise<Investigation[]> {
    const params = new URLSearchParams();
    if (opts.status) params.set("status", opts.status);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));

    const qs = params.toString();
    const path = `/api/investigations${qs ? `?${qs}` : ""}`;
    const result = await this.request<Investigation[]>("GET", path);
    return result ?? [];
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: controller.signal,
      };

      if (body !== undefined && method !== "GET") {
        init.body = JSON.stringify(body);
      }

      const res = await fetch(url, init);

      if (!res.ok) {
        const text = await res.text().catch(() => "(unreadable)");
        log.warn("Research investigation API returned non-2xx", {
          method,
          url,
          status: res.status,
          body: text.slice(0, 200),
        });
        return null;
      }

      return (await res.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("signal")) {
        log.warn("Research investigation API timed out", { method, url, timeoutMs: this.timeoutMs });
      } else {
        log.warn("Research investigation API request failed", { method, url, error: msg });
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a `ResearchInvestigationClient` pointing at the default research agent
 * port (3478), or override via the `RESEARCH_AGENT_URL` environment variable.
 *
 * @example
 *   const client = createResearchInvestigationClient();
 *   // or, in tests / staging:
 *   const client = createResearchInvestigationClient('http://localhost:9999');
 */
export function createResearchInvestigationClient(
  baseUrl?: string,
  opts?: Omit<ResearchInvestigationClientOptions, "baseUrl">,
): ResearchInvestigationClient {
  const resolved =
    baseUrl ?? process.env["RESEARCH_AGENT_URL"] ?? DEFAULT_BASE_URL;
  return new ResearchInvestigationClient({ ...opts, baseUrl: resolved });
}
