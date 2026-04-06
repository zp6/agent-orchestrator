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

/**
 * Get the model for a given LLM task kind.
 * Priority: config.llm.models[task] → config.llm.default_model → built-in defaults.
 * When no explicit override is configured, returns undefined so callers
 * can fall back to the pool member's model.
 */
export function getLLMModel(config: OrchestratorConfig, task: LLMTaskKind): string | undefined {
  return (
    config.llm?.models?.[task] ??
    config.llm?.default_model ??
    undefined
  );
}

/** Default model when no agent config or LLM override is available. */
const DEFAULT_MODEL = "claude-sonnet-4-6";

/** Round-robin counter for pool-based LLM routing. */
let rrIndex = 0;

/** Return type for createLLMClient — includes the selected agent's model. */
export interface LLMClientResult {
  client: Anthropic;
  /** The model configured for the selected pool member (provider-aware). */
  model: string;
}

/**
 * Get an Anthropic client for orchestrator LLM calls.
 * Prefers a dedicated reviewer-style container to avoid blocking on
 * busy agent containers. If the preferred reviewer belongs to a pool,
 * round-robins across pool members so LLM calls are distributed across
 * providers (Claude, Codex, etc.).
 *
 * Returns both the client and the selected agent's model so callers
 * don't need to hardcode model strings.
 */
export function createLLMClient(config: OrchestratorConfig): LLMClientResult {
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
      const model = preferred.model ?? DEFAULT_MODEL;
      return {
        client: createProxyClient(config.proxy, workingDir, {
          apiKey: preferred.docker!.api_key!,
          baseUrl,
        }),
        model,
      };
    }
  }

  // Fallback: use any available agent
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.docker?.port && agent.docker?.api_key) {
      const baseUrl = getAgentBaseUrl(config, name);
      const workingDir = getAgentDir(config, name);
      return {
        client: createProxyClient(config.proxy, workingDir, {
          apiKey: agent.docker.api_key,
          baseUrl,
        }),
        model: agent.model ?? DEFAULT_MODEL,
      };
    }
  }

  // Last resort: use proxy URL directly
  return {
    client: createProxyClient(config.proxy, config.orchestrator_dir, {}),
    model: DEFAULT_MODEL,
  };
}
