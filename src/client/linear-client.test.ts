import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearClient } from "./linear-client.js";

describe("LinearClient", () => {
  const apiKey = "lin_test_api_key";
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists NEX issues with bare auth and an optional state filter", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: {
          issues: {
            nodes: [
              {
                id: "issue-1",
                identifier: "NEX-11",
                title: "OSS tool spike",
                description: "Spike OSS tool support.",
                state: { name: "Backlog" },
                updatedAt: "2026-04-27T12:00:00.000Z",
              },
            ],
          },
        },
      }),
    });

    const client = new LinearClient(apiKey);
    const issues = await client.listIssues("Backlog");

    expect(issues).toEqual([
      {
        id: "issue-1",
        identifier: "NEX-11",
        title: "OSS tool spike",
        description: "Spike OSS tool support.",
        state: { name: "Backlog" },
        updatedAt: "2026-04-27T12:00:00.000Z",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.headers).toMatchObject({
      Authorization: apiKey,
      "Content-Type": "application/json",
    });

    const body = JSON.parse(String(init.body)) as {
      variables: { teamKey: string; stateName: string };
      query: string;
    };
    expect(body.variables).toEqual({
      teamKey: "NEX",
      stateName: "Backlog",
    });
    expect(body.query).toContain("state: { name: { eq: $stateName } }");
    expect(body.query).toContain("updatedAt");
  });
});
