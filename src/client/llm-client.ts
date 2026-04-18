import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig, LLMTaskKind } from "../config/schema.js";
import { getAgentDir, getAgentBaseUrl, getPoolMembers } from "../config/schema.js";
import { createLogger } from "../service/logger.js";
import {
  isRateLimitError,
  isProviderAvailable,
  markProviderExhausted,
  markProviderAvailable,
  parseResetTime,
} from "../service/provider-state.js";

const log = createLogger("llm-client");

// Re-export for backwards compatibility with any callers that imported it from here.
export type { LLMTaskKind };

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

/**
 * High-frequency LLM task kinds that benefit most from Claude's prompt caching.
 * When the global provider is "auto" and no explicit per-task override is set,
 * these tasks will prefer Claude over Codex to avoid re-tokenising full system
 * prompts on every request (Codex CLI does not support prompt caching).
 */
const CLAUDE_PREFERRED_TASKS = new Set<LLMTaskKind>([
  "router",
  "planner",
  "verifier",
  "supervisor",
  "improvement",
  "issue_matcher",
]);

function getPreferredLLMAgents(config: OrchestratorConfig, taskKind?: LLMTaskKind): string[] {
  const globalProvider = config.llm?.provider ?? "auto";
  const preferred = config.llm?.preferred_agent;

  // Resolve the effective provider for this task kind:
  //   1. Explicit per-task override from config.llm.task_providers
  //   2. Implicit default: Claude for cache-friendly tasks when provider is "auto"
  //   3. Fall back to the global provider setting
  let effectiveProvider = globalProvider;
  if (taskKind) {
    const taskOverride = config.llm?.task_providers?.[taskKind];
    if (taskOverride && taskOverride !== "auto") {
      effectiveProvider = taskOverride;
    } else if (!taskOverride && globalProvider === "auto" && CLAUDE_PREFERRED_TASKS.has(taskKind)) {
      // Default: steer cache-friendly tasks to Claude when no explicit override exists
      effectiveProvider = "claude";
    }
  }

  // Codex agents are currently disabled (out of tokens) — route only to Claude.
  const providerDefaults = ["claude-orchestrator-reviewer"];

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

// ── Token usage recording ───────────────────────────────────────────────────

/**
 * Callback signature for recording LLM token usage.
 * Set via `setLLMUsageRecorder()` at daemon startup so that every
 * `messages.create()` call through `createLLMClient()` is automatically tracked.
 */
export type LLMUsageRecorder = (
  provider: string,
  agentName: string,
  tokensIn: number,
  tokensOut: number,
  cacheReadTokens?: number,
  cacheCreationTokens?: number,
) => void;

let usageRecorder: LLMUsageRecorder | null = null;

/**
 * Register a callback that will be invoked after every successful LLM call
 * made through `createLLMClient()`. Typically called once at daemon startup
 * with `store.recordTokenUsage.bind(store)`.
 */
export function setLLMUsageRecorder(recorder: LLMUsageRecorder): void {
  usageRecorder = recorder;
}

/**
 * Wrap an Anthropic client so that `messages.create()` automatically records
 * token usage via the registered recorder.  Uses a Proxy on the `messages`
 * namespace to intercept calls transparently — callers see a normal Anthropic
 * client and don't need any changes.
 */
function wrapClientWithUsageTracking(
  client: Anthropic,
  provider: string,
  agentName: string,
): Anthropic {
  if (!usageRecorder) return client;

  const originalMessages = client.messages;
  const originalCreate = originalMessages.create.bind(originalMessages);

  const wrappedMessages = Object.create(originalMessages);
  wrappedMessages.create = async function (...args: Parameters<typeof originalCreate>) {
    let response;
    try {
      response = await originalCreate(...args);
    } catch (err) {
      if (isRateLimitError(err)) {
        const resetAt = parseResetTime(err);
        markProviderExhausted(provider, err instanceof Error ? err.message : String(err), resetAt ?? undefined);
        log.warn("LLM rate limit — provider exhausted", { provider, agentName });
      }
      throw err;
    }
    markProviderAvailable(provider);
    try {
      const usage = (response as Anthropic.Message).usage;
      if (usage && usageRecorder) {
        const u = usage as unknown as Record<string, number | null>;
        const cacheRead = u.cache_read_input_tokens ?? 0;
        const cacheCreate = u.cache_creation_input_tokens ?? 0;
        usageRecorder(provider, agentName, usage.input_tokens, usage.output_tokens, cacheRead, cacheCreate);
      }
    } catch (err) {
      log.warn("Failed to record LLM token usage", {
        provider,
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return response;
  };

  // Replace the messages property with our wrapped version
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "messages") return wrappedMessages;
      return Reflect.get(target, prop);
    },
  });
}

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
 * When `taskKind` is provided the provider preference is resolved per-task:
 * high-frequency tasks ("verifier", "supervisor", "router", etc.) default to
 * Claude when the global provider is "auto", so they benefit from prompt
 * caching.  This can be overridden via `config.llm.task_providers`.
 *
 * Returns both the client and the selected agent's model so callers
 * don't need to hardcode model strings.
 */
export function createLLMClient(config: OrchestratorConfig, taskKind?: LLMTaskKind): LLMClientResult {
  for (const agentName of getPreferredLLMAgents(config, taskKind)) {
    const candidates = getPoolMembers(config, agentName)
      .filter((name) => {
        const agent = config.agents[name];
        if (!agent?.docker?.port || !agent?.docker?.api_key) return false;
        // Skip agents whose provider is exhausted (rate limited)
        const prov = agent.provider ?? "claude";
        return isProviderAvailable(prov);
      });

    if (candidates.length > 0) {
      const selected = candidates[rrIndex % candidates.length];
      rrIndex++;
      const preferred = config.agents[selected];
      const baseUrl = getAgentBaseUrl(config, selected);
      const workingDir = getAgentDir(config, selected);
      const model = preferred.model ?? DEFAULT_MODEL;
      const provider = preferred.provider ?? "claude";
      return {
        client: wrapClientWithUsageTracking(
          createProxyClient(config.proxy, workingDir, {
            apiKey: preferred.docker!.api_key!,
            baseUrl,
            provider,
          }),
          provider,
          selected,
        ),
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
        client: wrapClientWithUsageTracking(
          createProxyClient(config.proxy, workingDir, {
            apiKey: agent.docker.api_key,
            baseUrl,
            provider: agent.provider,
          }),
          agent.provider ?? "claude",
          name,
        ),
        model: agent.model ?? DEFAULT_MODEL,
      };
    }
  }

  // Last resort: use proxy URL directly
  return {
    client: wrapClientWithUsageTracking(
      createProxyClient(config.proxy, config.orchestrator_dir, {}),
      "claude",
      "unknown",
    ),
    model: DEFAULT_MODEL,
  };
}
