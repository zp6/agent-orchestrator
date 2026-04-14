/**
 * Tests for StandupActionClient (issue #798).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StandupActionClient, type StandupActionItemInput } from "./standup-action-client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<StandupActionItemInput> = {}): StandupActionItemInput {
  return {
    standup_date: "2026-04-13",
    action_item: "Investigate slow dispatch cycle",
    status: "deferred",
    reason: "Logged for manual review",
    ...overrides,
  };
}

// ── isEnabled ──────────────────────────────────────────────────────────────

describe("StandupActionClient.isEnabled", () => {
  it("returns false when baseUrl is empty", () => {
    expect(new StandupActionClient("").isEnabled).toBe(false);
  });

  it("returns true when baseUrl is set", () => {
    expect(new StandupActionClient("http://localhost:3000").isEnabled).toBe(true);
  });
});

// ── record() ──────────────────────────────────────────────────────────────

describe("StandupActionClient.record", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when client is disabled (empty baseUrl)", async () => {
    const client = new StandupActionClient("");
    const result = await client.record(makeInput());
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /api/standup-items and returns the id on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 42 }),
    });

    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.record(makeInput());

    expect(result).toBe(42);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/standup-items");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.standup_date).toBe("2026-04-13");
    expect(body.status).toBe("deferred");
  });

  it("returns null and swallows errors on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.record(makeInput());
    expect(result).toBeNull();
  });

  it("returns null on non-2xx HTTP response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.record(makeInput());
    expect(result).toBeNull();
  });
});

// ── recordBatch() ──────────────────────────────────────────────────────────

describe("StandupActionClient.recordBatch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns empty array without making a request for empty input", async () => {
    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.recordBatch([]);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null when client is disabled", async () => {
    const client = new StandupActionClient("");
    const result = await client.recordBatch([makeInput()]);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /api/standup-items/batch with a records wrapper", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ids: [10, 11, 12], count: 3 }),
    });

    const inputs = [
      makeInput({ status: "dispatched", task_id: "01TASK01", agent_name: "claude-proxy" }),
      makeInput({ status: "deferred", reason: "Low priority" }),
      makeInput({ status: "skipped", reason: "Already handled" }),
    ];

    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.recordBatch(inputs);

    expect(result).toEqual([10, 11, 12]);
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/standup-items/batch");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.records).toHaveLength(3);
    expect(body.records[0].status).toBe("dispatched");
    expect(body.records[0].task_id).toBe("01TASK01");
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ids: [1], count: 1 }),
    });

    const client = new StandupActionClient("http://localhost:3000/");
    await client.recordBatch([makeInput()]);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/standup-items/batch");
  });

  it("returns null and swallows errors on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("dashboard is down"));
    const client = new StandupActionClient("http://localhost:3000");
    const result = await client.recordBatch([makeInput()]);
    expect(result).toBeNull();
  });
});
