import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ResearchInvestigationClient,
  createResearchInvestigationClient,
} from "../reviewer/research-investigation-client.js";
import type {
  Investigation,
  RegisterInvestigationRequest,
} from "../reviewer/research-investigation-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvestigation(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "01KPRYX2ABC",
    title: "Evaluate prompt-caching strategies",
    research_question: "Which caching options exist for Anthropic models?",
    status: "pending",
    source_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/42",
    created_at: "2026-04-22T09:00:00.000Z",
    updated_at: "2026-04-22T09:00:00.000Z",
    ...overrides,
  };
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResearchInvestigationClient — register()", () => {
  let client: ResearchInvestigationClient;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478" });
    fetchSpy = mockFetch(201, makeInvestigation());
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to /api/investigations and returns the created investigation", async () => {
    const req: RegisterInvestigationRequest = {
      title: "Evaluate prompt-caching strategies",
      research_question: "Which caching options exist for Anthropic models?",
      source_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/42",
    };

    const result = await client.register(req);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3478/api/investigations");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject(req);

    expect(result).not.toBeNull();
    expect(result!.id).toBe("01KPRYX2ABC");
    expect(result!.status).toBe("pending");
  });

  it("returns null when the server responds with 500", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      }),
    );

    const result = await client.register({
      title: "Test",
      research_question: "Some question?",
    });

    expect(result).toBeNull();
  });

  it("returns null and does not throw when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(
      client.register({ title: "Test", research_question: "Q?" }),
    ).resolves.toBeNull();
  });
});

describe("ResearchInvestigationClient — activate()", () => {
  let client: ResearchInvestigationClient;

  beforeEach(() => {
    client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /api/investigations/:id with action=activate", async () => {
    const activeInv = makeInvestigation({ status: "active" });
    const fetchSpy = mockFetch(200, activeInv);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.activate("01KPRYX2ABC");

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3478/api/investigations/01KPRYX2ABC");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ action: "activate" });

    expect(result!.status).toBe("active");
  });

  it("URL-encodes special characters in the investigation ID", async () => {
    vi.stubGlobal("fetch", mockFetch(200, makeInvestigation({ status: "active" })));

    await client.activate("id with spaces");

    const [url] = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain("id%20with%20spaces");
  });
});

describe("ResearchInvestigationClient — complete()", () => {
  let client: ResearchInvestigationClient;

  beforeEach(() => {
    client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /api/investigations/:id with action=complete and finding data", async () => {
    const doneInv = makeInvestigation({
      status: "complete",
      finding_summary: "Prompt caching reduces spend by 60–80%.",
      score: 91,
      result_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/55",
    });
    const fetchSpy = mockFetch(200, doneInv);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.complete("01KPRYX2ABC", {
      finding_summary: "Prompt caching reduces spend by 60–80%.",
      score: 91,
      result_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/55",
    });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.action).toBe("complete");
    expect(body.finding_summary).toBe("Prompt caching reduces spend by 60–80%.");
    expect(body.score).toBe(91);
    expect(body.result_issue_url).toBe(
      "https://github.com/rapartlu/agent-orchestrator/issues/55",
    );

    expect(result!.status).toBe("complete");
    expect(result!.score).toBe(91);
  });

  it("completes without optional fields (no score, no result_issue_url)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, makeInvestigation({ status: "complete" })));

    const result = await client.complete("01KPRYX2ABC", {
      finding_summary: "No clear winner found.",
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe("complete");
  });
});

describe("ResearchInvestigationClient — cancel()", () => {
  let client: ResearchInvestigationClient;

  beforeEach(() => {
    client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PATCHes /api/investigations/:id with action=cancel", async () => {
    const fetchSpy = mockFetch(200, makeInvestigation({ status: "cancelled" }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.cancel("01KPRYX2ABC", "Superseded by newer investigation");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.action).toBe("cancel");
    expect(body.finding_summary).toBe("Superseded by newer investigation");

    expect(result!.status).toBe("cancelled");
  });

  it("cancels without a reason", async () => {
    const fetchSpy = mockFetch(200, makeInvestigation({ status: "cancelled" }));
    vi.stubGlobal("fetch", fetchSpy);

    await client.cancel("01KPRYX2ABC");

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("finding_summary");
  });
});

describe("ResearchInvestigationClient — list()", () => {
  let client: ResearchInvestigationClient;

  beforeEach(() => {
    client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs /api/investigations and returns investigations array", async () => {
    const investigations = [makeInvestigation(), makeInvestigation({ id: "01KPRYX3DEF" })];
    const fetchSpy = mockFetch(200, investigations);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await client.list();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:3478/api/investigations");
    expect(init.method).toBe("GET");
    expect(result).toHaveLength(2);
  });

  it("appends status and limit query params when provided", async () => {
    const fetchSpy = mockFetch(200, []);
    vi.stubGlobal("fetch", fetchSpy);

    await client.list({ status: "active", limit: 5 });

    const [url] = fetchSpy.mock.calls[0] as [string];
    expect(url).toContain("status=active");
    expect(url).toContain("limit=5");
  });

  it("returns empty array when server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const result = await client.list();

    expect(result).toEqual([]);
  });

  it("returns empty array on non-2xx response", async () => {
    vi.stubGlobal("fetch", mockFetch(503, { error: "Service Unavailable" }));

    const result = await client.list();

    expect(result).toEqual([]);
  });
});

describe("ResearchInvestigationClient — timeout behaviour", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns null when request exceeds timeoutMs", async () => {
    // Simulate a request that never resolves
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init.signal as AbortSignal;
            if (signal) {
              signal.addEventListener("abort", () =>
                reject(new DOMException("The operation was aborted.", "AbortError")),
              );
            }
          }),
      ),
    );

    const client = new ResearchInvestigationClient({
      baseUrl: "http://localhost:3478",
      timeoutMs: 50,
    });

    const result = await client.register({ title: "T", research_question: "Q?" });

    expect(result).toBeNull();
  });
});

describe("createResearchInvestigationClient()", () => {
  afterEach(() => {
    delete process.env["RESEARCH_AGENT_URL"];
  });

  it("uses the explicit baseUrl when provided", () => {
    const client = createResearchInvestigationClient("http://custom:9999");
    // Access private field via any cast for testing
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe("http://custom:9999");
  });

  it("falls back to RESEARCH_AGENT_URL env var when no baseUrl is passed", () => {
    process.env["RESEARCH_AGENT_URL"] = "http://envhost:4000";
    const client = createResearchInvestigationClient();
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe("http://envhost:4000");
  });

  it("falls back to localhost:3478 when neither baseUrl nor env var is set", () => {
    const client = createResearchInvestigationClient();
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe("http://localhost:3478");
  });

  it("strips trailing slash from baseUrl", () => {
    const client = new ResearchInvestigationClient({ baseUrl: "http://localhost:3478/" });
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe("http://localhost:3478");
  });
});
