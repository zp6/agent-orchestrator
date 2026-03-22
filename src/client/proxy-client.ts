import Anthropic from "@anthropic-ai/sdk";
import type { ProxyConfig } from "../config/schema.js";

export function createProxyClient(
  proxyConfig: ProxyConfig,
  workingDir: string,
  conversationId?: string,
): Anthropic {
  const headers: Record<string, string> = {
    "x-working-dir": workingDir,
  };
  if (conversationId) {
    headers["x-conversation-id"] = conversationId;
  }

  return new Anthropic({
    baseURL: proxyConfig.url,
    apiKey: "orchestrator",
    defaultHeaders: headers,
    timeout: proxyConfig.timeout_ms,
  });
}
