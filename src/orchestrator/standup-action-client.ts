/**
 * Typed HTTP client for the standup action-item tracking API.
 *
 * Used by the orchestrator daemon to record the disposition of each standup
 * action item after processing: dispatched (with task ID), deferred (with
 * reason), or skipped (with reason).
 *
 * Data is posted to the dashboard server after each standup synthesis cycle.
 */

/** Valid disposition statuses for a standup action item. */
export type StandupActionItemStatus = "dispatched" | "deferred" | "skipped";

/** Parameters for a single action-item disposition record. */
export interface StandupActionItemInput {
  /** The standup date in YYYY-MM-DD format. */
  standup_date: string;
  /** The action item text as extracted from the standup. */
  action_item: string;
  /** Disposition outcome: dispatched, deferred, or skipped. */
  status: StandupActionItemStatus;
  /** The dispatched task ID (only for status=dispatched). */
  task_id?: string;
  /** Human-readable reason (required for deferred/skipped, optional for dispatched). */
  reason?: string;
  /** The agent the item was dispatched to (for status=dispatched). */
  agent_name?: string;
  /** GitHub issue or source reference, e.g. "rapartlu/agent-orchestrator#42". */
  source_ref?: string;
}

/** Response from a successful batch POST. */
export interface StandupActionBatchResponse {
  ids: number[];
  count: number;
  invalid: number;
}

/**
 * Lightweight HTTP client for the standup action-item tracking API.
 *
 * All methods are fire-and-forget safe — errors are caught and returned as
 * `null` so callers can choose to log or silently ignore them without
 * disrupting the daemon loop.
 */
export class StandupActionClient {
  private baseUrl: string;
  private timeoutMs: number;

  /**
   * @param baseUrl    - Dashboard server base URL, e.g. `"http://localhost:3473"`.
   * @param timeoutMs  - Request timeout in ms (default 5 000).
   */
  constructor(baseUrl: string, timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  /**
   * Record multiple standup action-item dispositions in a single request.
   *
   * Prefer this over calling `recordSingle()` in a loop — the batch endpoint
   * wraps all inserts in a single SQLite transaction.
   *
   * Returns the list of new row IDs on success, or `null` on failure.
   */
  async recordBatch(inputs: StandupActionItemInput[]): Promise<number[] | null> {
    if (inputs.length === 0) return [];
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
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
