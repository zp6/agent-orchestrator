/**
 * LLM client for the reviewer.
 *
 * Unlike the orchestrator, which routes calls through Claude Code proxy
 * containers, the reviewer runs standalone and talks directly to the
 * Anthropic API using ANTHROPIC_API_KEY from the environment.
 *
 * If ANTHROPIC_BASE_URL is set, it is used as the base URL (e.g. for a
 * local proxy or testing). This is the only routing the reviewer needs.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Wraps a system prompt string in a cache_control block so Anthropic's
 * prompt caching feature applies to it. On the first request the prompt is
 * computed normally; on subsequent requests with the same prompt the cached
 * version is used, saving ~80–90% of system-prompt input tokens.
 *
 * Usage:
 *   system: buildCachedSystemContent(MY_SYSTEM_PROMPT)
 */
export function buildCachedSystemContent(
  text: string,
): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

let _client: Anthropic | null = null;

/**
 * Returns a shared Anthropic client instance.
 * Reads credentials from environment:
 *   ANTHROPIC_API_KEY  — required
 *   ANTHROPIC_BASE_URL — optional; overrides the default API endpoint
 */
export function createLLMClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for the reviewer LLM client",
    );
  }

  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _client;
}

/** Reset the cached client (useful in tests). */
export function resetLLMClient(): void {
  _client = null;
}
