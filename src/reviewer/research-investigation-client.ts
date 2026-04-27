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

/**
 * Concise snapshot returned by GET /api/investigations/summary.
 *
 * Added in research-agent#140 — provides a lightweight alternative to
 * fetching the full investigation list when only high-level counts are needed
 * (e.g. dashboard card headers, Telegram status lines).
 */
export interface InvestigationsSummary {
  /** Number of investigations currently in pending or active state. */
  active_count: number;
  /**
   * The most recently completed investigation.
   * `null` when no investigation has been completed yet.
   */
  last_completed: { title: string; result_issue_url: string | null } | null;
  /**
   * Age in milliseconds of the oldest pending/active investigation.
   * `null` when there are no in-flight investigations.
   */
  oldest_in_flight_age: number | null;
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

// ---------------------------------------------------------------------------
// Misrouting types
// ---------------------------------------------------------------------------

/**
 * A single record of an implementation task that was mistakenly dispatched to
 * the research agent.  Returned by GET /misrouting on the research agent.
 */
export interface ResearchMisroutingRecord {
  /** Stable record ID assigned by the research agent. */
  id: string;
  /** Orchestrator task ID, if available. */
  task_id?: string;
  /** Human-readable task title. */
  title: string;
  /**
   * Category reported by the research agent: "feature", "fix", "implementation",
   * "cross-repo-followup", or similar.
   */
  category: string;
  /** Quality score (0–100) from the verifier, if a post-hoc record was filed. */
  quality_score?: number;
  /** GitHub source ref (e.g. "rapartlu/research-agent#154"). */
  source_ref?: string;
  /** ISO timestamp when the task was originally dispatched. */
  dispatched_at: string;
}

/**
 * The full payload returned by GET /misrouting on the research agent.
 *
 * Includes individual records plus aggregate histograms that the research
 * agent builds over time as post-hoc records are filed via
 * POST /api/misrouting/record.
 */
export interface ResearchMisroutingReport {
  /** Total number of misrouted records stored by the research agent. */
  total_count: number;
  /** Lookback window used by the research agent, in hours. */
  lookback_hours: number;
  /** Individual misrouting records. */
  entries: ResearchMisroutingRecord[];
  /**
   * Count of records grouped by category label.
   * Populated once the research agent has processed post-hoc submissions.
   * e.g. { "implementation": 3, "cross-repo-followup": 1 }
   */
  category_histogram: Record<string, number>;
  /**
   * Count of records grouped by quality-score bucket (e.g. "0-24", "25-49",
   * "50-74", "75-100").  Populated by post-hoc submissions.
   */
  quality_score_histogram?: Record<string, number>;
}

/**
 * Payload for POST /api/misrouting/record — filed by the reviewer after it
 * has verified a task that should have gone to the research agent.  Populates
 * the research agent's `category_histogram` and `quality_score_histogram`.
 */
export interface RecordMisroutingRequest {
  /** Orchestrator task ID. */
  task_id: string;
  /** Human-readable task title. */
  title: string;
  /**
   * Category determined by the reviewer:
   * "implementation", "feature", "fix", or "cross-repo-followup".
   */
  category: string;
  /** Final quality score (0–100) from the verifier, if available. */
  quality_score?: number;
  /** GitHub source ref (e.g. "rapartlu/research-agent#154"). */
  source_ref?: string;
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
   * Fetch a concise summary snapshot from GET /api/investigations/summary.
   *
   * Returns an `InvestigationsSummary` on success, or `null` when the
   * research agent is unreachable or returns a non-2xx status (e.g. running
   * an older version that does not yet expose this endpoint).
   *
   * Callers should degrade gracefully on `null` — the full `list()` endpoint
   * is always available as a fallback.
   *
   * @example
   *   const summary = await client.summary();
   *   if (summary) {
   *     log.info('investigations', { active: summary.active_count });
   *   }
   */
  async summary(): Promise<InvestigationsSummary | null> {
    return this.request<InvestigationsSummary>("GET", "/api/investigations/summary");
  }

  /**
   * Fetch the research agent's misrouting report from GET /misrouting.
   *
   * Returns the full `ResearchMisroutingReport` (including aggregate histograms)
   * or `null` when the research agent is unreachable or returns a non-2xx status.
   *
   * The report is used by the reviewer's daily misrouting digest to surface a
   * "Research agent implementation tasks" section alongside the standard
   * reviewer-misrouting entries.
   *
   * @example
   *   const report = await client.getMisroutingReport();
   *   if (report) {
   *     log.info('research misroutes', { total: report.total_count });
   *   }
   */
  async getMisroutingReport(): Promise<ResearchMisroutingReport | null> {
    return this.request<ResearchMisroutingReport>("GET", "/misrouting");
  }

  /**
   * File a post-hoc misrouting record with the research agent via
   * POST /api/misrouting/record.
   *
   * Call this after the reviewer verifies a task that was dispatched to the
   * research agent but turned out to be an implementation task.  The research
   * agent will incorporate the record into its `category_histogram` and
   * `quality_score_histogram`.
   *
   * Returns the created `ResearchMisroutingRecord` on success, or `null` on
   * failure (the reviewer continues regardless — this is best-effort telemetry).
   *
   * @example
   *   await client.recordMisrouting({
   *     task_id: task.id,
   *     title: task.title,
   *     category: 'implementation',
   *     quality_score: 65,
   *     source_ref: 'rapartlu/research-agent#154',
   *   });
   */
  async recordMisrouting(req: RecordMisroutingRequest): Promise<ResearchMisroutingRecord | null> {
    return this.request<ResearchMisroutingRecord>(
      "POST",
      "/api/misrouting/record",
      req as unknown as Record<string, unknown>,
    );
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
