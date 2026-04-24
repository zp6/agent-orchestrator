/**
 * HTTP client for the meeting-facilitator-agent's intake endpoint (issue #1134).
 *
 * Calls POST /api/meeting/start on the facilitator agent to create a
 * persistent meeting intake record in the facilitator's state.db.
 *
 * API provided by the meeting-facilitator-agent server (rapartlu/meeting-facilitator-agent PR #20):
 *   POST /api/meeting/start — create a meeting intake record, returns { meeting_id }
 *
 * ### Usage in daemon.ts
 *
 * ```ts
 * const baseUrl = getAgentBaseUrl(this.config, facilitatorName) ?? "";
 * const client = new MeetingIntakeClient(baseUrl);
 * const meetingId = await client.create({ title, participants, agenda_items });
 * ```
 *
 * All methods swallow errors — a facilitator outage must never block signal dispatch.
 */

/** Parameters for POST /api/meeting/start. */
export interface MeetingIntakeParams {
  /** Meeting title derived from the request topic. */
  title: string;
  /** Agent names selected as participants. */
  participants: string[];
  /** Agenda items for the meeting. */
  agenda_items: string[];
}

/** Successful response from POST /api/meeting/start. */
export interface MeetingIntakeResponse {
  meeting_id: string;
}

/**
 * Lightweight HTTP client for the meeting intake API.
 *
 * Fire-and-forget safe — errors are caught and returned as `null` so the
 * daemon's meeting dispatch flow is never blocked by a facilitator outage.
 */
export class MeetingIntakeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * @param baseUrl   - Meeting-facilitator-agent base URL, e.g. "http://localhost:3485".
   *                    Pass an empty string to disable (no-op).
   * @param timeoutMs - Request timeout in ms (default 5 000).
   */
  constructor(baseUrl: string, timeoutMs = 5_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  /** Returns true when a facilitator URL is configured. */
  get isEnabled(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Create a meeting intake record on the facilitator.
   *
   * Returns the meeting ID on success, or `null` if disabled or the request
   * fails. Errors are swallowed — facilitator outages must not block dispatch.
   */
  async create(params: MeetingIntakeParams): Promise<string | null> {
    if (!this.isEnabled) return null;
    try {
      const res = await this.post<MeetingIntakeResponse>("/api/meeting/start", params);
      return res?.meeting_id ?? null;
    } catch {
      return null;
    }
  }

  /** POST JSON to the facilitator API. Throws on non-2xx. */
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
