/**
 * Tests for MeetingIntakeClient (issue #1134).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MeetingIntakeClient, type MeetingIntakeParams } from "./meeting-intake-client.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeParams(overrides: Partial<MeetingIntakeParams> = {}): MeetingIntakeParams {
  return {
    title: "Decide on auth approach",
    participants: ["agent-a", "agent-b"],
    agenda_items: ["Review options", "Vote"],
    ...overrides,
  };
}

// ── isEnabled ──────────────────────────────────────────────────────────────

describe("MeetingIntakeClient.isEnabled", () => {
  it("returns false when baseUrl is empty", () => {
    expect(new MeetingIntakeClient("").isEnabled).toBe(false);
  });

  it("returns true when baseUrl is set", () => {
    expect(new MeetingIntakeClient("http://localhost:3485").isEnabled).toBe(true);
  });
});

// ── create() ──────────────────────────────────────────────────────────────

describe("MeetingIntakeClient.create", () => {
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
    const client = new MeetingIntakeClient("");
    const result = await client.create(makeParams());
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to /api/meeting/start and returns the meeting_id on success", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ meeting_id: "mtg-1234-abc" }),
    });

    const client = new MeetingIntakeClient("http://localhost:3485");
    const result = await client.create(makeParams());

    expect(result).toBe("mtg-1234-abc");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3485/api/meeting/start",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("sends the correct JSON body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ meeting_id: "mtg-abc" }),
    });

    const client = new MeetingIntakeClient("http://localhost:3485");
    const params = makeParams({
      title: "RFC review",
      participants: ["agent-x"],
      agenda_items: ["Review proposal"],
    });
    await client.create(params);

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as unknown;
    expect(body).toEqual({
      title: "RFC review",
      participants: ["agent-x"],
      agenda_items: ["Review proposal"],
    });
  });

  it("strips trailing slash from baseUrl", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ meeting_id: "mtg-xyz" }),
    });

    const client = new MeetingIntakeClient("http://localhost:3485/");
    await client.create(makeParams());

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("http://localhost:3485/api/meeting/start");
  });

  it("returns null on non-2xx response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
    });

    const client = new MeetingIntakeClient("http://localhost:3485");
    const result = await client.create(makeParams());
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const client = new MeetingIntakeClient("http://localhost:3485");
    const result = await client.create(makeParams());
    expect(result).toBeNull();
  });

  it("returns null on timeout (AbortError)", async () => {
    fetchMock.mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    );

    const client = new MeetingIntakeClient("http://localhost:3485");
    const result = await client.create(makeParams());
    expect(result).toBeNull();
  });

  it("returns null when meeting_id is missing from response", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const client = new MeetingIntakeClient("http://localhost:3485");
    const result = await client.create(makeParams());
    expect(result).toBeNull();
  });
});
