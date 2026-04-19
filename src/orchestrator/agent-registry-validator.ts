/**
 * Agent identity validation (issue #860)
 *
 * Validates a target agent name against the registered agents in agents.yaml
 * before allowing a dispatch to proceed. Any dispatch targeting an unregistered
 * agent name is blocked with a structured alert rather than silently executed.
 */

import type { OrchestratorConfig } from "../config/schema.js";

export interface AgentRegistryValidationResult {
  /** "registered" if the agent is present in config.agents; "unregistered" otherwise. */
  status: "registered" | "unregistered";
  agentName: string;
  /** Sorted list of currently registered agent names (for diagnostics / alert bodies). */
  registeredAgents: string[];
  /** Human-readable explanation when status is "unregistered". */
  reason: string | null;
}

/**
 * Validate that `agentName` is present in `config.agents`.
 *
 * This is the authoritative registry check. It runs synchronously and requires
 * no I/O, so it can be inserted at the very first gate of the dispatch path
 * without adding latency.
 *
 * @param config - Parsed orchestrator config (loaded from agents.yaml).
 * @param agentName - The agent name resolved by the router or specified explicitly.
 * @returns A structured result indicating whether the agent is registered.
 */
export function validateAgentInRegistry(
  config: OrchestratorConfig,
  agentName: string,
): AgentRegistryValidationResult {
  const registeredAgents = Object.keys(config.agents).sort();

  if (config.agents[agentName]) {
    return {
      status: "registered",
      agentName,
      registeredAgents,
      reason: null,
    };
  }

  const reason =
    `Agent "${agentName}" is not registered in agents.yaml. ` +
    `Registered agents: ${registeredAgents.join(", ")}. ` +
    `If this agent was recently renamed or decommissioned, remove its references from routing rules and task sources.`;

  return {
    status: "unregistered",
    agentName,
    registeredAgents,
    reason,
  };
}

/**
 * Build the Telegram alert body for an unregistered-agent dispatch block.
 */
export function buildRegistryBlockAlert(
  agentName: string,
  sourceRef: string | undefined,
  registeredAgents: string[],
): string {
  const lines: string[] = [
    `⛔ **Agent identity validation failed** — dispatch blocked`,
    ``,
    `Target agent \`${agentName}\` is **not registered** in \`agents.yaml\`.`,
  ];

  if (sourceRef) {
    lines.push(`Source ref: ${sourceRef}`);
  }

  lines.push(
    ``,
    `Registered agents: ${registeredAgents.map((n) => `\`${n}\``).join(", ")}`,
    ``,
    `Action required: if this agent was renamed, update the routing rules or re-add it to \`agents.yaml\`. ` +
      `If it was decommissioned, remove any remaining task references pointing to it.`,
  );

  return lines.join("\n");
}
