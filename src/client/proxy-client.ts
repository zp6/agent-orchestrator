import Anthropic from "@anthropic-ai/sdk";
import type { ProxyConfig } from "../config/schema.js";

export function createProxyClient(
  proxyConfig: ProxyConfig,
  workingDir: string,
  options?: {
    conversationId?: string;
    apiKey?: string;
    baseUrl?: string;
  },
): Anthropic {
  const headers: Record<string, string> = {
    "x-working-dir": workingDir,
  };
  if (options?.conversationId) {
    headers["x-conversation-id"] = options.conversationId;
  }

  return new Anthropic({
    baseURL: options?.baseUrl ?? proxyConfig.url,
    apiKey: options?.apiKey ?? "not-set",
    defaultHeaders: headers,
    timeout: proxyConfig.timeout_ms,
    maxRetries: 2,
  });
}
