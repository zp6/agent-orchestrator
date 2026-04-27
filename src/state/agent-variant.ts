/**
 * Agent variant helpers.
 *
 * The fleet has provider-specific sibling agents such as:
 *   - claude-orchestrator-reviewer
 *   - codex-orchestrator-reviewer
 *   - grok-orchestrator-reviewer
 *   - deepseek-orchestrator-reviewer
 *   - gemini-orchestrator-reviewer
 *
 * These should be treated as the same "family" for inflight checks so one
 * variant does not double-dispatch work already held by another.
 */

const VARIANT_PREFIXES = ["claude", "codex", "grok", "deepseek", "gemini"] as const;
const VARIANT_PREFIX_RE = new RegExp(`^(${VARIANT_PREFIXES.join("|")})-(.*)$`, "i");

/**
 * Remove the provider prefix from a variant agent name.
 */
export function canonicalizeAgentVariantName(agentName: string): string {
  const trimmed = agentName.trim();
  const match = trimmed.match(VARIANT_PREFIX_RE);
  return match ? match[2] : trimmed;
}

/**
 * Return the sibling variant names for an agent family.
 *
 * For variant-prefixed names this returns all provider forms for the same
 * canonical family. For non-variant names it returns the original name only.
 */
export function getAgentVariantFamily(agentName: string): string[] {
  const canonical = canonicalizeAgentVariantName(agentName);
  if (canonical === agentName.trim()) {
    return [canonical];
  }

  return VARIANT_PREFIXES.map((prefix) => `${prefix}-${canonical}`);
}
