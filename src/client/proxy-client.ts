import Anthropic from "@anthropic-ai/sdk";
import KeepAliveAgent from "agentkeepalive";
import type { ProxyConfig } from "../config/schema.js";

function createEphemeralHttpAgent(url: URL): KeepAliveAgent.HttpAgent | KeepAliveAgent.HttpsAgent {
  if (url.protocol === "https:") {
    return new KeepAliveAgent.HttpsAgent({ keepAlive: false });
  }

  return new KeepAliveAgent.HttpAgent({ keepAlive: false });
}

export function createProxyClient(
  proxyConfig: ProxyConfig,
  workingDir: string,
  options?: {
    conversationId?: string;
    apiKey?: string;
    baseUrl?: string;
    provider?: string;
  },
): Anthropic {
  const headers: Record<string, string> = {
    "x-working-dir": workingDir,
  };
  if (options?.conversationId) {
    headers["x-conversation-id"] = options.conversationId;
  }
  if (options?.provider) {
    headers["x-provider"] = options.provider;
  }

  return new Anthropic({
    baseURL: options?.baseUrl ?? proxyConfig.url,
    apiKey: options?.apiKey ?? "not-set",
    defaultHeaders: headers,
    timeout: proxyConfig.timeout_ms,
    maxRetries: 2,
    // Use a fresh socket per request so OrbStack recovery can't leave us
    // pinned to a stale keep-alive connection from the previous outage.
    httpAgent: createEphemeralHttpAgent as never,
  });
}
