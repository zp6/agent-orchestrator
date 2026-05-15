import { describe, it, expect } from "vitest";
import {
  CoronerClient,
  CoronerClientError,
  makeCoronerClient,
  type TaskFailedEvent,
  type CoronerLogPage,
  type CoronerStats,
  type CoronerHealth,
} from "./coroner-client.js";

// ── Fetch mock helpers ────────────────────────────────────────────────────────

function okFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function errorFetch(status: number, body = ""): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      statusText: "Error",
    })) as unknown as typeof fetch;
}

function networkErrorFetch(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

function captureFetch(): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}

// ── makeCoronerClient ─────────────────────────────────────────────────────────

describe("makeCoronerClient", () => {
  it("returns a CoronerClient instance", () => {
    const client = makeCoronerClient("http://localhost:3471");
    expect(client).toBeInstanceOf(CoronerClient);
  });

  it("strips trailing slash from base URL", async () => {
    const { fetch, calls } = captureFetch();
    const client = makeCoronerClient("http://localhost:3471/", { fetchImpl: fetch });
    await client.health();
    expect(calls[0]!.url).toBe("http://localhost:3471/v1/coroner/health");
  });
});

// ── deliverFailureEvent ───────────────────────────────────────────────────────

describe("CoronerClient.deliverFailureEvent", () => {
  it("POSTs to /v1/coroner/webhook with type=task.failed", async () => {
    const { fetch, calls } = captureFetch();
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: fetch });

    const event: TaskFailedEvent = {
      taskId: "task-abc",
      agentName: "claude-agent-foo",
      failureReason: "Timed out after 10 minutes",
      taskTitle: "Fix bug #42",
      sourceRef: "owner/repo#42",
      retryCount: 3,
    };

    const result = await client.deliverFailureEvent(event);
    expect(result).toBe(true);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("http://localhost:3471/v1/coroner/webhook");
    const body = JSON.parse(call.init?.body as string);
    expect(body.type).toBe("task.failed");
    expect(body.taskId).toBe("task-abc");
    expect(body.agentName).toBe("claude-agent-foo");
    expect(body.failureReason).toBe("Timed out after 10 minutes");
    expect(typeof body.timestamp).toBe("string");
  });

  it("injects timestamp when none provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: fetch });

    await client.deliverFailureEvent({
      taskId: "t1",
      agentName: "a1",
      failureReason: "Error",
    });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(typeof body.timestamp).toBe("string");
    expect(new Date(body.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("preserves explicit timestamp when provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: fetch });

    const ts = "2026-01-01T12:00:00.000Z";
    await client.deliverFailureEvent({
      taskId: "t1",
      agentName: "a1",
      failureReason: "Error",
      timestamp: ts,
    });

    const body = JSON.parse(calls[0]!.init?.body as string);
    expect(body.timestamp).toBe(ts);
  });

  it("returns false on HTTP error without throwing", async () => {
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: errorFetch(500) });
    const result = await client.deliverFailureEvent({ taskId: "t", agentName: "a", failureReason: "err" });
    expect(result).toBe(false);
  });

  it("returns false on network error without throwing", async () => {
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: networkErrorFetch() });
    const result = await client.deliverFailureEvent({ taskId: "t", agentName: "a", failureReason: "err" });
    expect(result).toBe(false);
  });
});

// ── log ───────────────────────────────────────────────────────────────────────

describe("CoronerClient.log", () => {
  const page: CoronerLogPage = {
    items: [
      {
        id: "pm-1",
        taskId: "task-1",
        agentName: "claude-agent-foo",
        failureReason: "Connection timed out",
        causeOfDeath: "Agent container restarted mid-task",
        publishedAt: "2026-05-15T10:00:00.000Z",
      },
    ],
    total: 1,
    offset: 0,
    limit: 20,
  };

  it("calls /v1/coroner/log with no params", async () => {
    const { fetch, calls } = captureFetch();
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: fetch });
    // Override with actual body
    (fetch as unknown as { calls: typeof calls }).calls = calls;

    const realFetch = (async () =>
      new Response(JSON.stringify(page), { status: 200 })) as unknown as typeof fetch;
    const c2 = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: realFetch });
    const result = await c2.log();
    expect(result.total).toBe(1);
    expect(result.items[0]!.agentName).toBe("claude-agent-foo");
  });

  it("appends query params when options provided", async () => {
    const { fetch, calls } = captureFetch();
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: fetch });
    await client.log({ limit: 5, offset: 10, agent: "claude-agent-bar" });
    const url = calls[0]!.url;
    expect(url).toContain("limit=5");
    expect(url).toContain("offset=10");
    expect(url).toContain("agent=claude-agent-bar");
  });

  it("throws CoronerClientError on HTTP 404", async () => {
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: errorFetch(404, "not found") });
    await expect(client.log()).rejects.toBeInstanceOf(CoronerClientError);
  });
});

// ── stats ─────────────────────────────────────────────────────────────────────

describe("CoronerClient.stats", () => {
  it("fetches /v1/coroner/stats and returns parsed stats", async () => {
    const stats: CoronerStats = { total: 42, byAgent: { "agent-a": 10, "agent-b": 32 }, last24hCount: 5 };
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: okFetch(stats) });
    const result = await client.stats();
    expect(result.total).toBe(42);
    expect(result.byAgent["agent-a"]).toBe(10);
    expect(result.last24hCount).toBe(5);
  });

  it("throws CoronerClientError on non-ok response", async () => {
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: errorFetch(503, "service unavailable") });
    await expect(client.stats()).rejects.toThrow(CoronerClientError);
  });
});

// ── health ────────────────────────────────────────────────────────────────────

describe("CoronerClient.health", () => {
  it("fetches /v1/coroner/health and returns parsed health", async () => {
    const health: CoronerHealth = {
      ok: true,
      ollamaReachable: true,
      modelAvailable: true,
      model: "llama3.2",
    };
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: okFetch(health) });
    const result = await client.health();
    expect(result.ok).toBe(true);
    expect(result.ollamaReachable).toBe(true);
    expect(result.model).toBe("llama3.2");
  });

  it("returns unhealthy response without throwing", async () => {
    const health: CoronerHealth = {
      ok: false,
      ollamaReachable: false,
      error: "Ollama not running",
    };
    const client = new CoronerClient({ baseUrl: "http://localhost:3471", fetchImpl: okFetch(health) });
    const result = await client.health();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Ollama not running");
  });
});

// ── CoronerClientError ────────────────────────────────────────────────────────

describe("CoronerClientError", () => {
  it("carries status code and message", () => {
    const err = new CoronerClientError("Not found", 404);
    expect(err.message).toBe("Not found");
    expect(err.status).toBe(404);
    expect(err.name).toBe("CoronerClientError");
  });

  it("works without status", () => {
    const err = new CoronerClientError("Network error");
    expect(err.status).toBeUndefined();
  });
});
