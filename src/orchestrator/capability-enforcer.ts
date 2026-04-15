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
import { getAgentBaseUrl } from "../config/schema.js";
import { callCapabilityCheck } from "../client/capability-check-client.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("capability-enforcer");

/** Patterns that identify orchestrator implementation tasks by title. */
const IMPLEMENTATION_TITLE_PATTERNS: RegExp[] = [
  /\[orchestrator\]/i,
  /\[orchestrator dashboard\]/i,
  /\[orchestrator reviewer\]/i,
  /\[agent orchestrator\]/i,
  // Dashboard implementation patterns (routes, panels, widgets, follow-ups)
  /\[agent[\s-]?dashboard\]/i,
  /\[agent[\s-]?reviewer\]/i,
  // Cross-repo follow-up chains that land in the wrong agent
  /follow-up from #\d+/i,
  // Implementation work keywords appearing as the primary task label
  /^create\s+(route|endpoint|api|panel|widget|component)/i,
];

/**
 * Keyword fragments that, when found in a task title, strongly suggest
 * implementation work unsuitable for research-only agents.
 * Used as a secondary check when title patterns do not match.
 */
const IMPLEMENTATION_TITLE_KEYWORDS: string[] = [
  "routes",
  "endpoint",
  "panel",
  "widget",
  "migration",
  "deployment",
  "docker",
  "pr create",
  "open pr",
];

/**
 * Returns true when any implementation keyword appears in the title.
 * Only checked as a fallback after the pattern check fails.
 */
function titleHasImplementationKeyword(title: string): boolean {
  const lower = title.toLowerCase();
  return IMPLEMENTATION_TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

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
    // Secondary check: presence of implementation-flavored keywords in the title.
    if (titleHasImplementationKeyword(title)) return true;
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
  if (!substitute) {
    log.warn("Capability violation detected but no substitute agent available — allowing dispatch to original", { agentName, sourceRef });
    return null;
  }

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

// ── Remote capability check ───────────────────────────────────────────────

/**
 * Call the agent's `/capability-check` endpoint and return a reroute
 * descriptor when the agent rejects the task, or `null` when the agent
 * accepts it (or the endpoint is unavailable).
 *
 * This is a second-line enforcement that runs AFTER the local capability
 * tag check.  It catches cases where:
 *   • The agent is not yet tagged `research-only` in agents.yaml but its
 *     container already exposes the endpoint.
 *   • The task title does not match any local keyword pattern but the agent's
 *     own classifier rejects it.
 *
 * The call is non-blocking: a 404 (endpoint not implemented) or any network
 * error is treated as "accept" so the local enforcer remains the hard gate.
 *
 * @param params.config      Full orchestrator config (for URL and agent lookup)
 * @param params.agentName   Agent name as it appears in agents.yaml
 * @param params.taskType    Task type string (usually "implementation")
 * @param params.title       Issue/task title
 * @param params.sourceRef   Source reference e.g. "rapartlu/agent-orchestrator#837"
 */
export async function runRemoteCapabilityCheck(params: {
  config: OrchestratorConfig;
  agentName: string;
  taskType: string;
  title?: string;
  sourceRef?: string;
}): Promise<CapabilityEnforcementReroute | null> {
  const { config, agentName, taskType, title, sourceRef } = params;

  // Only check agents that have a docker port configured (i.e., reachable via HTTP).
  const agentBaseUrl = getAgentBaseUrl(config, agentName);
  if (!agentBaseUrl) {
    log.debug("Skipping remote capability check — no docker port configured", { agentName });
    return null;
  }

  const outcome = await callCapabilityCheck(agentBaseUrl, {
    title: title ?? "",
    task_type: taskType,
    source_ref: sourceRef,
  });

  if (outcome.status !== "rejected") {
    // accepted, not-supported, or error — all treated as "proceed"
    return null;
  }

  // Agent rejected the task.  Find the best substitute.
  const substitute = findImplementationAgent(config, agentName, sourceRef);
  if (!substitute) {
    log.warn("Remote capability rejection but no substitute agent available — allowing dispatch to original", { agentName, sourceRef });
    return null;
  }

  const redirectReason =
    `Agent "${agentName}" rejected the task via /capability-check` +
    (title ? ` ("${title}")` : "") +
    `: ${outcome.reason}. Rerouted to "${substitute}".`;

  log.warn("Remote capability check: agent rejected task — rerouting", {
    agentName,
    toAgent: substitute,
    reason: outcome.reason,
    sourceRef,
  });

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
): string | null {
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

  // No valid substitute found — return null so callers can fall back gracefully
  log.warn("No valid implementation agent found for reroute", { blockedAgent, sourceRef });
  return null;
}
