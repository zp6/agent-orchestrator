/**
 * Prompt caching utilities — issue #1031
 *
 * Converts system prompts into cacheable TextBlockParam arrays with
 * Anthropic's `cache_control: { type: 'ephemeral' }` marker.
 *
 * When the Claude API sees a system prompt block with cache_control set,
 * it caches the tokenised representation across requests within a 5-minute
 * TTL window.  Subsequent requests that send the same prefix pay only the
 * cache-read cost (~10% of input tokens) instead of full input pricing.
 *
 * High-frequency calls (supervisor, verifier, router, PR review) send the
 * same static system prompt dozens of times per hour, so caching yields
 * substantial savings.
 *
 * For dynamic prompts (e.g. router registry prompt that embeds agent config),
 * the prompt is split into a static cacheable prefix and a dynamic suffix.
 * Only the prefix gets the cache marker — changes to the suffix don't
 * invalidate the cached prefix.
 */

import type Anthropic from "@anthropic-ai/sdk";

type TextBlockParam = Anthropic.Messages.TextBlockParam;

/**
 * Wrap a static system prompt string as a cacheable TextBlockParam array.
 *
 * The entire prompt is placed in a single text block with
 * `cache_control: { type: 'ephemeral' }` so the Claude API caches the
 * tokenised system prompt across calls within the 5-minute TTL.
 *
 * @param systemPrompt  The static system prompt string.
 * @returns Array suitable for the `system` parameter of `messages.create()`.
 */
export function cacheableSystemPrompt(systemPrompt: string): TextBlockParam[] {
  return [
    {
      type: "text" as const,
      text: systemPrompt,
      cache_control: { type: "ephemeral" as const },
    },
  ];
}

/**
 * Wrap a dynamic system prompt that has a cacheable static prefix and a
 * variable suffix.  The prefix gets the cache marker; the suffix is sent
 * as a separate block so changes to it don't invalidate the cached prefix.
 *
 * Use this for prompts like the router registry where the instruction text
 * is fixed but the agent list changes when config is reloaded.
 *
 * @param staticPrefix   The fixed instruction portion of the prompt.
 * @param dynamicSuffix  The variable portion (agent list, config, context).
 * @returns Array suitable for the `system` parameter of `messages.create()`.
 */
export function cacheableSplitPrompt(
  staticPrefix: string,
  dynamicSuffix: string,
): TextBlockParam[] {
  return [
    {
      type: "text" as const,
      text: staticPrefix,
      cache_control: { type: "ephemeral" as const },
    },
    {
      type: "text" as const,
      text: dynamicSuffix,
    },
  ];
}
