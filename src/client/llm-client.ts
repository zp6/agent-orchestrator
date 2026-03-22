import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentBaseUrl } from "../config/schema.js";

/**
 * Get an Anthropic client for orchestrator LLM calls (routing, planning, reviewing, etc).
 * Uses the first available agent with a Docker port + API key as the proxy endpoint.
 * The working dir is set to the agent's own project dir (that's what the container has).
 */
export function createLLMClient(config: OrchestratorConfig): Anthropic {
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.docker?.port && agent.docker?.api_key) {
      const baseUrl = getAgentBaseUrl(config, name);
      const workingDir = getAgentDir(config, name);
      return createProxyClient(config.proxy, workingDir, {
        apiKey: agent.docker.api_key,
        baseUrl,
      });
    }
  }

  // Fallback: use proxy URL directly
  return createProxyClient(config.proxy, config.orchestrator_dir, {});
}
