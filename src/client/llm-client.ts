import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentBaseUrl } from "../config/schema.js";

/**
 * Preferred agent name for orchestrator LLM calls.
 * This should be a dedicated container that doesn't handle dispatched work,
 * so LLM calls (routing, reviewing, verifying, supervising) don't compete
 * with agent tasks.
 */
const PREFERRED_LLM_AGENT = "claude-agent-orchestrator";

/**
 * Get an Anthropic client for orchestrator LLM calls.
 * Prefers the dedicated orchestrator-llm container to avoid blocking on
 * busy agent containers. Falls back to the first available agent with
 * a Docker port + API key.
 */
export function createLLMClient(config: OrchestratorConfig): Anthropic {
  // Prefer dedicated orchestrator LLM container
  const preferred = config.agents[PREFERRED_LLM_AGENT];
  if (preferred?.docker?.port && preferred?.docker?.api_key) {
    const baseUrl = getAgentBaseUrl(config, PREFERRED_LLM_AGENT);
    const workingDir = getAgentDir(config, PREFERRED_LLM_AGENT);
    return createProxyClient(config.proxy, workingDir, {
      apiKey: preferred.docker.api_key,
      baseUrl,
    });
  }

  // Fallback: use any available agent
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

  // Last resort: use proxy URL directly
  return createProxyClient(config.proxy, config.orchestrator_dir, {});
}
