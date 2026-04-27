import { describe, it, expect } from "vitest";
import { LinearClient, type LinearIssue } from "./linear-client.js";

function mockFetch(payload: unknown, opts: { ok?: boolean; status?: number } = {}) {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
}

const sampleIssues: LinearIssue[] = [
  { id: "i1", identifier: "NEX-1", title: "First", description: "a", state: { name: "Backlog" }, updatedAt: "2026-04-27T10:00:00Z" },
  { id: "i2", identifier: "NEX-2", title: "Second", description: null, state: { name: "Todo" }, updatedAt: "2026-04-27T11:00:00Z" },
  { id: "i3", identifier: "NEX-3", title: "Third", description: "c", state: { name: "Backlog" }, updatedAt: "2026-04-27T12:00:00Z" },
];

describe("LinearClient.listIssues", () => {
  it("requires an apiKey", () => {
    expect(() => new LinearClient({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("returns all issues when no stateName filter is given", async () => {
    const client = new LinearClient({
      apiKey: "test-key",
      fetchImpl: mockFetch({ data: { team: { issues: { nodes: sampleIssues } } } }) as unknown as typeof fetch,
    });
    const issues = await client.listIssues();
    expect(issues).toHaveLength(3);
    expect(issues[0].identifier).toBe("NEX-1");
  });

  it("filters by state name when provided", async () => {
    const client = new LinearClient({
      apiKey: "test-key",
      fetchImpl: mockFetch({ data: { team: { issues: { nodes: sampleIssues } } } }) as unknown as typeof fetch,
    });
    const issues = await client.listIssues("Backlog");
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.state.name === "Backlog")).toBe(true);
  });

  it("throws on non-OK HTTP response", async () => {
    const client = new LinearClient({
      apiKey: "test-key",
      fetchImpl: mockFetch({}, { ok: false, status: 401 }) as unknown as typeof fetch,
    });
    await expect(client.listIssues()).rejects.toThrow(/HTTP 401/);
  });

  it("throws on GraphQL errors", async () => {
    const client = new LinearClient({
      apiKey: "test-key",
      fetchImpl: mockFetch({ errors: [{ message: "Authentication failed" }] }) as unknown as typeof fetch,
    });
    await expect(client.listIssues()).rejects.toThrow(/Authentication failed/);
  });

  it("sends bare apiKey in Authorization header (no Bearer prefix)", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client = new LinearClient({
      apiKey: "lin_api_test",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ data: { team: { issues: { nodes: [] } } } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.listIssues();
    expect(capturedHeaders?.Authorization).toBe("lin_api_test");
    expect(capturedHeaders?.Authorization).not.toMatch(/^Bearer/);
  });
});
