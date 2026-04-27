import { describe, it, expect, vi } from "vitest";
import KeepAliveAgent from "agentkeepalive";

const anthropicMock = vi.hoisted(() =>
  vi.fn(
    class AnthropicMock {
      __options: unknown;

      constructor(opts: unknown) {
        this.__options = opts;
      }
    },
  ),
);

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicMock,
}));

const { createProxyClient } = await import("./proxy-client.js");

describe("createProxyClient", () => {
  it("creates a per-request HTTP agent with keepAlive disabled", () => {
    createProxyClient(
      { url: "http://localhost:3457", timeout_ms: 5000 },
      "/tmp/orchestrator",
      { baseUrl: "http://localhost:3474", apiKey: "test-key" },
    );

    expect(anthropicMock).toHaveBeenCalledOnce();
    const options = anthropicMock.mock.calls[0][0] as {
      httpAgent: (url: URL) => unknown;
    };

    const httpAgent1 = options.httpAgent(new URL("http://localhost:3474"));
    const httpAgent2 = options.httpAgent(new URL("http://localhost:3474"));
    const httpsAgent = options.httpAgent(new URL("https://api.example.com"));

    expect(httpAgent1).toBeInstanceOf(KeepAliveAgent.HttpAgent);
    expect(httpsAgent).toBeInstanceOf(KeepAliveAgent.HttpsAgent);
    expect((httpAgent1 as KeepAliveAgent.HttpAgent).options.keepAlive).toBe(false);
    expect((httpsAgent as KeepAliveAgent.HttpsAgent).options.keepAlive).toBe(false);
    expect(httpAgent2).not.toBe(httpAgent1);
  });
});
