/**
 * Capability tag enforcement for the dispatcher.
 *
 * Certain agents carry declarative `capability_tags` in agents.yaml that
 * constrain which task types they may receive.  The dispatcher calls
 * `checkCapabilityEnforcement()` after initial agent selection and before
 * any pre-flight checks.  When a mismatch is detected the function returns a
 * reroute descriptor; when no violation exists it returns null.
 *
 * Currently recognised tags
 * ─────────────────────────
 * • `research-only`  – the agent may only receive tasks of type "research".
 *   Implementation tasks are identified by:
 *     1. taskType === "implementation" (default for almost all GitHub-sourced tasks)
 *     2. task title matching an orchestrator-work pattern (e.g. "[Orchestrator]",
 *        "[orchestrator dashboard]", "[orchestrator reviewer]")
 *     3. source_ref pointing to a repo other than the agent's own github repo
 *        (cross-repo implementation work)
 *
 * Rerouting
 * ─────────
 * When a violation is detected the enforcer walks the agent registry and picks
 * the best-fit implementation agent: the one whose `github` field matches the
 * source_ref repo, or, failing that, the highest-confidence match from the
 * deterministic router.
 */

import type { OrchestratorConfig } from "../config/schema.js";

/** Patterns that identify orchestrator implementation tasks by title. */
const IMPLEMENTATION_TITLE_PATTERNS: RegExp[] = [
  /\[orchestrator\]/i,
  /\[orchestrator dashboard\]/i,
  /\[orchestrator reviewer\]/i,
  /\[agent orchestrator\]/i,
];

/**
 * Returns true when the task title or type suggests implementation work that a
 * research-only agent should not receive.
 */
export function isImplementationTask(
  taskType: string,
  title?: string,
  sourceRef?: string,
  agentGithub?: string,
): boolean {
  // Any explicit implementation-typed task is off-limits for research-only agents.
  if (taskType === "implementation") return true;

  // Orchestrator-pattern titles are implementation work regardless of task type.
  if (title) {
    for (const pattern of IMPLEMENTATION_TITLE_PATTERNS) {
      if (pattern.test(title)) return true;
    }
  }

  // Cross-repo source refs pointing to a different repo are implementation work.
  if (sourceRef && agentGithub) {
    const hashIdx = sourceRef.lastIndexOf("#");
    if (hashIdx > 0) {
      const refRepo = sourceRef.slice(0, hashIdx);
      if (refRepo !== agentGithub) return true;
    }
  }

  return false;
}

export interface CapabilityEnforcementReroute {
  /** The original agent that was selected before enforcement. */
  blockedAgent: string;
  /** The substitute agent that should receive the task instead. */
  toAgent: string;
  /** Human-readable reason recorded in the routing decisions log. */
  redirectReason: string;
}

/**
 * Check whether the selected agent's capability tags permit the given task.
 *
 * Returns a `CapabilityEnforcementReroute` descriptor when the agent must be
 * bypassed, or `null` when no enforcement is needed.
 */
export function checkCapabilityEnforcement(params: {
  config: OrchestratorConfig;
  agentName: string;
  taskType: string;
  title?: string;
  sourceRef?: string;
}): CapabilityEnforcementReroute | null {
  const { config, agentName, taskType, title, sourceRef } = params;
  const agent = config.agents[agentName];
  if (!agent) return null;

  const tags = agent.capability_tags ?? [];
  if (!tags.includes("research-only")) return null;

  if (!isImplementationTask(taskType, title, sourceRef, agent.github)) {
    // Task is genuinely research work — no enforcement needed.
    return null;
  }

  // Violation detected.  Find the best substitute implementation agent.
  const substitute = findImplementationAgent(config, agentName, sourceRef);

  const redirectReason =
    `Agent "${agentName}" is tagged research-only but received an implementation task` +
    (title ? ` ("${title}")` : "") +
    `. Rerouted to "${substitute}".`;

  return {
    blockedAgent: agentName,
    toAgent: substitute,
    redirectReason,
  };
}

/**
 * Find the best implementation agent for the given source_ref.
 *
 * Priority:
 * 1. The agent whose `github` field matches the source_ref repo exactly.
 * 2. The first agent without `research-only` capability tag (fallback).
 * 3. The blocked agent itself if no other candidate is found (last resort;
 *    prevents an infinite loop while still surfacing the mismatch in logs).
 */
function findImplementationAgent(
  config: OrchestratorConfig,
  blockedAgent: string,
  sourceRef?: string,
): string {
  // Extract owner/repo from "owner/repo#N"
  let targetRepo: string | undefined;
  if (sourceRef) {
    const hashIdx = sourceRef.lastIndexOf("#");
    if (hashIdx > 0) targetRepo = sourceRef.slice(0, hashIdx);
  }

  // 1. Exact repo match
  if (targetRepo) {
    for (const [name, a] of Object.entries(config.agents)) {
      if (name === blockedAgent) continue;
      if (a.github === targetRepo) return name;
    }
  }

  // 2. First non-research-only agent
  for (const [name, a] of Object.entries(config.agents)) {
    if (name === blockedAgent) continue;
    const tags = a.capability_tags ?? [];
    if (!tags.includes("research-only")) return name;
  }

  // 3. Last resort: return blocked agent (shouldn't happen in a well-configured setup)
  return blockedAgent;
}
