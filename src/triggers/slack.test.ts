import { describe, it, expect, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

import { fetchSlackMessages } from "./slack.js";
import type { OrchestratorConfig } from "../config/schema.js";

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {},
};

describe("fetchSlackMessages", () => {
  it("parses Slack messages from proxy response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { channel: "engineering", channel_id: "C123", user: "paul", text: "@orchestrator check deploy", ts: "123.456" },
      ])}],
    });

    const messages = await fetchSlackMessages(config, { channels: ["engineering"] });
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toContain("@orchestrator");
  });

  it("returns empty array on empty response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });
    const messages = await fetchSlackMessages(config, {});
    expect(messages).toHaveLength(0);
  });

  it("returns empty array on malformed response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "No messages found" }],
    });
    const messages = await fetchSlackMessages(config, {});
    expect(messages).toHaveLength(0);
  });
});
