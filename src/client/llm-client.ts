import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentBaseUrl, getPoolMembers } from "../config/schema.js";

export type LLMTaskKind =
  | "default"
  | "router"
  | "planner"
  | "reviewer"
  | "verifier"
  | "supervisor"
  | "improvement"
  | "issue_matcher";

const DEFAULT_MODEL_BY_TASK: Record<LLMTaskKind, string> = {
  default: "claude-sonnet-4-6",
  router: "claude-sonnet-4-6",
  planner: "claude-sonnet-4-6",
  reviewer: "claude-sonnet-4-6",
  verifier: "claude-sonnet-4-6",
  supervisor: "claude-sonnet-4-6",
  improvement: "claude-sonnet-4-6",
  issue_matcher: "claude-haiku-4-5",
};

function getPreferredLLMAgents(config: OrchestratorConfig): string[] {
  const provider = config.llm?.provider ?? "auto";
  const preferred = config.llm?.preferred_agent;

  const providerDefaults =
    provider === "codex"
      ? ["codex-orchestrator-reviewer", "claude-orchestrator-reviewer"]
      : provider === "claude"
        ? ["claude-orchestrator-reviewer", "codex-orchestrator-reviewer"]
        : ["claude-orchestrator-reviewer", "codex-orchestrator-reviewer"];

  const fallbackReviewers = Object.keys(config.agents).filter((name) =>
    name.endsWith("orchestrator-reviewer"),
  );

  return [preferred, ...providerDefaults, ...fallbackReviewers].filter(
    (name, index, items): name is string => Boolean(name) && items.indexOf(name) === index,
  );
}

export function getLLMModel(config: OrchestratorConfig, task: LLMTaskKind): string {
  return (
    config.llm?.models?.[task] ??
    config.llm?.default_model ??
    DEFAULT_MODEL_BY_TASK[task]
  );
}

/** Round-robin counter for pool-based LLM routing. */
let rrIndex = 0;

/**
 * Get an Anthropic client for orchestrator LLM calls.
 * Prefers a dedicated reviewer-style container to avoid blocking on
 * busy agent containers. If the preferred reviewer belongs to a pool,
 * round-robins across pool members. Falls back to the first available
 * agent with a Docker port + API key.
 */
export function createLLMClient(config: OrchestratorConfig): Anthropic {
  for (const agentName of getPreferredLLMAgents(config)) {
    const candidates = getPoolMembers(config, agentName)
      .filter((name) => {
        const agent = config.agents[name];
        return agent?.docker?.port && agent?.docker?.api_key;
      });

    if (candidates.length > 0) {
      const selected = candidates[rrIndex % candidates.length];
      rrIndex++;
      const preferred = config.agents[selected];
      const baseUrl = getAgentBaseUrl(config, selected);
      const workingDir = getAgentDir(config, selected);
      return createProxyClient(config.proxy, workingDir, {
        apiKey: preferred.docker!.api_key!,
        baseUrl,
      });
    }
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
