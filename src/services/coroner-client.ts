/**
 * HTTP client for the proxy's coroner API (issue #1725).
 *
 * The proxy runs a coroner webhook subscriber (proxy PR #603) that:
 *   - Receives task.failed events
 *   - Runs postmortem analysis via local Ollama
 *   - Persists cause-of-death records
 *
 * This client lets the orchestrator:
 *   1. Deliver failure events to the coroner webhook
 *   2. Read postmortem history and stats via the CLI
 *
 * Auth: none (coroner endpoints are internal-only; proxy is on localhost).
 * Base URL: config.proxy.url (default http://localhost:3471)
 */

export interface CoronerPostmortem {
  id?: string;
  taskId: string;
  agentName: string;
  failureReason: string;
  causeOfDeath?: string;
  publishedAt: string;
}

export interface CoronerStats {
  total: number;
  byAgent: Record<string, number>;
  last24hCount: number;
}

export interface CoronerHealth {
  ok: boolean;
  ollamaReachable: boolean;
  modelAvailable?: boolean;
  model?: string;
  error?: string;
}

export interface CoronerLogPage {
  items: CoronerPostmortem[];
  total: number;
  offset: number;
  limit: number;
}

export interface TaskFailedEvent {
  taskId: string;
  agentName: string;
  failureReason: string;
  taskTitle?: string;
  sourceRef?: string | null;
  retryCount?: number;
  timestamp?: string;
}

export class CoronerClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "CoronerClientError";
  }
}

export class CoronerClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...init.headers,
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CoronerClientError(
          `Coroner API error (${path}): ${res.status} ${text || res.statusText}`,
          res.status,
        );
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Deliver a task.failed event to the coroner webhook.
   * Fire-and-forget at the call site — this returns a Promise that callers can
   * choose to await or not. Never throws; returns false on any error so the
   * daemon failure path is never blocked.
   */
  async deliverFailureEvent(event: TaskFailedEvent): Promise<boolean> {
    try {
      await this.request("/v1/coroner/webhook", {
        method: "POST",
        body: JSON.stringify({
          type: "task.failed",
          ...event,
          timestamp: event.timestamp ?? new Date().toISOString(),
        }),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch paginated postmortem log. */
  async log(opts: { limit?: number; offset?: number; agent?: string } = {}): Promise<CoronerLogPage> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    if (opts.agent) params.set("agent", opts.agent);
    const qs = params.toString();
    return this.request<CoronerLogPage>(`/v1/coroner/log${qs ? "?" + qs : ""}`);
  }

  /** Fetch failure stats (total, by-agent, last-24h). */
  async stats(): Promise<CoronerStats> {
    return this.request<CoronerStats>("/v1/coroner/stats");
  }

  /** Check Ollama reachability and model availability. */
  async health(): Promise<CoronerHealth> {
    return this.request<CoronerHealth>("/v1/coroner/health");
  }
}

/**
 * Build a CoronerClient from the orchestrator proxy URL.
 * Used by both the daemon (for delivery) and the CLI (for inspection).
 */
export function makeCoronerClient(
  proxyUrl: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): CoronerClient {
  return new CoronerClient({ baseUrl: proxyUrl, ...opts });
}
