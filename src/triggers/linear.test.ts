import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

import { fetchLinearIssues } from "./linear.js";
import type { OrchestratorConfig } from "../config/schema.js";

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {},
};

describe("fetchLinearIssues", () => {
  it("parses Linear issues from proxy response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { id: "abc", identifier: "ENG-42", title: "Fix auth", description: "Tokens expire", url: "https://linear.app/ENG-42", team: "ENG", status: "In Progress", labels: ["bug"] },
      ])}],
    });

    const issues = await fetchLinearIssues(config, { teams: ["ENG"] });
    expect(issues).toHaveLength(1);
    expect(issues[0].identifier).toBe("ENG-42");
  });

  it("returns empty array on empty response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });
    const issues = await fetchLinearIssues(config, {});
    expect(issues).toHaveLength(0);
  });

  it("returns empty array on malformed response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json" }],
    });
    const issues = await fetchLinearIssues(config, {});
    expect(issues).toHaveLength(0);
  });
});
