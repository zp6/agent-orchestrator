import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentBaseUrl, getPoolMembers } from "../config/schema.js";

/**
 * Preferred agent (or pool member) for orchestrator LLM calls.
 * If this agent has a `pool`, all pool members are candidates and
 * requests are round-robined across them.
 */
const PREFERRED_LLM_AGENT = "claude-orchestrator-reviewer";

/** Round-robin counter for pool-based LLM routing. */
let rrIndex = 0;

/**
 * Get an Anthropic client for orchestrator LLM calls.
 * If the preferred agent belongs to a pool, round-robins across all
 * pool members so LLM calls are distributed instead of hammering one.
 */
export function createLLMClient(config: OrchestratorConfig): Anthropic {
  // Get pool members (or just the single agent if no pool)
  const candidates = getPoolMembers(config, PREFERRED_LLM_AGENT)
    .filter((name) => {
      const a = config.agents[name];
      return a?.docker?.port && a?.docker?.api_key;
    });

  if (candidates.length > 0) {
    // Round-robin across pool members
    const name = candidates[rrIndex % candidates.length];
    rrIndex++;
    const baseUrl = getAgentBaseUrl(config, name);
    const workingDir = getAgentDir(config, name);
    return createProxyClient(config.proxy, workingDir, {
      apiKey: config.agents[name].docker!.api_key!,
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
