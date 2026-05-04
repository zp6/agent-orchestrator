import { describe, it, expect, beforeEach, vi } from "vitest";
import { LinearClient, type LinearIssue } from "./linear-client.js";

describe("LinearClient", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let client: LinearClient;

  beforeEach(() => {
    mockFetch = vi.fn();
    client = new LinearClient({
      apiKey: "lin_api_test123",
      teamKey: "NEX",
      endpoint: "https://api.linear.app/graphql",
      fetchImpl: mockFetch as any,
    });
  });

  it("constructs with required parameters", () => {
    const c = new LinearClient({ apiKey: "test-key" });
    expect(c).toBeDefined();
  });

  it("listIssues sends POST request with correct headers and auth", async () => {
    const mockIssue: LinearIssue = {
      id: "issue-1",
      identifier: "NEX-123",
      title: "Test issue",
      description: null,
      state: { name: "Todo" },
      updatedAt: "2026-05-03T00:00:00Z",
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [{
              issues: {
                nodes: [mockIssue],
              },
            }],
          },
        },
      }),
    });

    const result = await client.listIssues();

    expect(mockFetch).toHaveBeenCalledWith("https://api.linear.app/graphql", expect.objectContaining({
      method: "POST",
      headers: {
        Authorization: "lin_api_test123",
        "Content-Type": "application/json",
      },
    }));

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    // Linear's `team` field requires `id`; team-key lookup uses `teams(filter:)`.
    expect(body.query).toContain('teams(filter: { key: { eq: "NEX" } })');
    expect(body.query).not.toContain('team(key:');

    expect(result).toEqual([mockIssue]);
  });

  it("listIssues includes state filter when stateName is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [{ issues: { nodes: [] } }],
          },
        },
      }),
    });

    await client.listIssues("In Progress");

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.query).toContain('state: { name: { eq: "In Progress" } }');
  });

  it("listIssues omits state filter when stateName is undefined", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [{ issues: { nodes: [] } }],
          },
        },
      }),
    });

    await client.listIssues();

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.query).not.toContain("state: { name:");
  });

  it("returns empty array when team has no issues", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          teams: {
            nodes: [{ issues: { nodes: [] } }],
          },
        },
      }),
    });

    const result = await client.listIssues();
    expect(result).toEqual([]);
  });

  it("returns empty array when no team matches the configured key", async () => {
    // Defensive: if the team filter returns no nodes (e.g., wrong key, deleted team),
    // listIssues should return [] rather than throw.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          teams: { nodes: [] },
        },
      }),
    });

    const result = await client.listIssues();
    expect(result).toEqual([]);
  });

  // ── getIssue ──────────────────────────────────────────────────────────────

  it("getIssue fetches a single issue by id", async () => {
    const mockIssue: LinearIssue = {
      id: "issue-abc",
      identifier: "NEX-42",
      title: "Fix the thing",
      description: "Details here",
      state: { name: "In Progress" },
      updatedAt: "2026-05-04T00:00:00Z",
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issue: mockIssue } }),
    });

    const result = await client.getIssue("issue-abc");
    expect(result).toEqual(mockIssue);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.query).toContain('issue(id: "issue-abc")');
    expect(body.query).toContain("identifier");
  });

  it("getIssue returns null when issue is not found", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { issue: null } }),
    });

    const result = await client.getIssue("nonexistent");
    expect(result).toBeNull();
  });

  it("getIssue throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: "Not Found" });
    await expect(client.getIssue("issue-abc")).rejects.toThrow("Linear API error: 404");
  });

  // ── commentOnIssue ────────────────────────────────────────────────────────

  it("commentOnIssue posts commentCreate mutation with issueId and body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { commentCreate: { success: true, comment: { id: "comment-1" } } },
      }),
    });

    await client.commentOnIssue("issue-abc", "Work complete. PR #1473 open.");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.query).toContain("commentCreate");
    expect(body.query).toContain('"issue-abc"');
    expect(body.query).toContain("Work complete");
  });

  it("commentOnIssue sends correct auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { commentCreate: { success: true, comment: { id: "c1" } } },
      }),
    });

    await client.commentOnIssue("issue-abc", "done");
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("lin_api_test123");
  });

  it("commentOnIssue throws when success is false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: { commentCreate: { success: false, comment: null } },
      }),
    });

    await expect(client.commentOnIssue("issue-abc", "test")).rejects.toThrow(
      "commentCreate returned success: false",
    );
  });

  it("commentOnIssue throws on GraphQL errors", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        errors: [{ message: "Not authorized" }],
      }),
    });

    await expect(client.commentOnIssue("issue-abc", "test")).rejects.toThrow(
      "GraphQL errors: Not authorized",
    );
  });

  it("commentOnIssue throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized" });
    await expect(client.commentOnIssue("issue-abc", "test")).rejects.toThrow(
      "Linear API error: 401",
    );
  });
});
