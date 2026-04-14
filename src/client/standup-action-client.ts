/**
 * HTTP client for the standup action-item disposition API (issue #798).
 *
 * Records what the orchestrator did with each action item produced during
 * a standup synthesis cycle so the `/standup-items` dashboard view shows
 * real data after every standup run.
 *
 * API provided by the agent-dashboard server (PR #191):
 *   POST /api/standup-items          — single disposition record
 *   POST /api/standup-items/batch    — bulk records (one transaction)
 *
 * ### Usage in team-meeting.ts
 *
 * ```ts
 * const client = new StandupActionClient(config.dashboard?.url ?? "");
 * await client.recordBatch(dispositions);   // fire-and-forget safe
 * ```
 *
 * All methods swallow errors — a dashboard outage must never block standup
 * processing.
 */

/** Disposition status for a standup action item. */
export type StandupActionItemStatus = "dispatched" | "deferred" | "skipped";

/** Parameters for a single standup action-item record. */
export interface StandupActionItemInput {
  /** The standup date in YYYY-MM-DD format. */
  standup_date: string;
  /** The action item text as extracted from the standup synthesis. */
  action_item: string;
  /** Disposition outcome. */
  status: StandupActionItemStatus;
  /** The dispatched task ID (only for status=dispatched). */
  task_id?: string;
  /** Human-readable reason (for deferred/skipped, or extra context). */
  reason?: string;
  /** The agent the item was dispatched to (for status=dispatched). */
  agent_name?: string;
  /** GitHub issue or source reference, e.g. "rapartlu/agent-orchestrator#42". */
  source_ref?: string;
}

/** Response from a successful single-record POST. */
export interface StandupActionCreateResponse {
  id: number;
}

/** Response from a successful batch POST. */
export interface StandupActionBatchResponse {
  /** Row IDs of newly created records, in input order. */
  ids: number[];
  /** Number of records successfully written. */
  count: number;
}

/**
 * Lightweight HTTP client for the standup action-item API.
 *
 * All methods are fire-and-forget safe — errors are caught and returned as
 * `null` so the standup handler is never blocked by a dashboard outage.
 */
export class StandupActionClient {
  private baseUrl: string;
  private timeoutMs: number;

  /**
   * @param baseUrl   - Dashboard server base URL, e.g. "http://localhost:3000".
   *                    Pass an empty string to disable recording (no-op).
   * @param timeoutMs - Request timeout in ms (default 5 000).
   */
  constructor(baseUrl: string, timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  /** Returns true when a dashboard URL is configured. */
  get isEnabled(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Record a single standup action item disposition.
   *
   * Returns the new row `id` on success, or `null` if disabled or the request
   * fails.  Errors are swallowed — dashboard outages must not block standups.
   */
  async record(input: StandupActionItemInput): Promise<number | null> {
    if (!this.isEnabled) return null;
    try {
      const res = await this.post<StandupActionCreateResponse>(
        "/api/standup-items",
        input,
      );
      return res?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Record multiple action item dispositions in a single request.
   *
   * Prefer this over calling `record()` in a loop — the batch endpoint wraps
   * all inserts in a single SQLite transaction on the dashboard side.
   *
   * Returns the list of new row IDs on success, or `null` on failure.
   * Returns an empty array when `inputs` is empty (no request is made).
   */
  async recordBatch(inputs: StandupActionItemInput[]): Promise<number[] | null> {
    if (inputs.length === 0) return [];
    if (!this.isEnabled) return null;
    try {
      const res = await this.post<StandupActionBatchResponse>(
        "/api/standup-items/batch",
        { records: inputs },
      );
      return res?.ids ?? null;
    } catch {
      return null;
    }
  }

  /** POST JSON to a dashboard API path.  Throws on non-2xx. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
