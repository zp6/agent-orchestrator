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
          team: {
            issues: {
              nodes: [mockIssue],
            },
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
    expect(body.query).toContain('team(key: "NEX")');

    expect(result).toEqual([mockIssue]);
  });

  it("listIssues includes state filter when stateName is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          team: {
            issues: { nodes: [] },
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
          team: {
            issues: { nodes: [] },
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
          team: {
            issues: { nodes: [] },
          },
        },
      }),
    });

    const result = await client.listIssues();
    expect(result).toEqual([]);
  });
});
