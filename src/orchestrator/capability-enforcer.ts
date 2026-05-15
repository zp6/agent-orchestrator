/**
 * Capability enforcement for the dispatcher.
 *
 * Two enforcement layers:
 *
 * 1. **Capability tags** (issue #817)
 *    Certain agents carry declarative `capability_tags` in agents.yaml that
 *    constrain which task types they may receive. The dispatcher calls
 *    `checkCapabilityEnforcement()` after initial agent selection and before
 *    any pre-flight checks. When a mismatch is detected the function returns a
 *    reroute descriptor; when no violation exists it returns null.
 *
 *    Currently recognised tags:
 *    • `research-only` – the agent may only receive tasks of type "research".
 *      Implementation tasks are identified by:
 *        1. taskType === "implementation"
 *        2. task title matching an orchestrator-work pattern
 *        3. source_ref pointing to a repo other than the agent's own github repo
 *
 * 2. **Agent-scope guard** (issue #974)
 *    Agents can declare explicit `allowed_types` in agents.yaml to restrict
 *    which task types they handle. The dispatcher calls `checkAgentScopeGuard()`
 *    BEFORE `checkCapabilityEnforcement()` to reject dispatch if the task_type
 *    is not in the allowed_types list. This prevents routing errors without
 *    consuming agent budget.
 *
 * • `review-only`  – the agent may only receive PR-review, verification, and
 *   supervision tasks.  Implementation tasks (same detection logic as
 *   `research-only`) are blocked and rerouted to the repo's home agent.
 *   This tag is used by `claude-orchestrator-reviewer` to prevent
 *   implementation work from being dispatched to the review/verify fleet.
 *
 * Rerouting
 * ─────────
 * When a violation is detected the enforcer walks the agent registry and picks
 * the best-fit agent: the one whose `github` field matches the source_ref repo,
 * or, failing that, the highest-confidence match from the deterministic router.
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
  // Code-authorship signals: verbs that unambiguously indicate writing/building code
  /\bcreate\s+pr\b/i,
  /\bopen\s+pr\b/i,
  /\bwrite\s+(a\s+)?(test|spec|function|class|module|script|migration|handler|hook|middleware|service|component)/i,
  /\bbuild\s+(a\s+)?(feature|api|endpoint|service|pipeline|integration|connector|plugin|tool)/i,
  /\bimplement\b/i,
];

/**
 * Keyword fragments that, when found in a task title, strongly suggest
 * implementation work unsuitable for research-only or review-only agents.
 * Used as a secondary check when title patterns do not match.
 *
 * These are intentionally conservative — generic words like "write" and
 * "build" are handled by the richer regex patterns above to avoid false
 * positives on titles such as "Write up research findings".
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
  "create pr",
  "write code",
  "write tests",
  "write the code",
  "build and",
  "build the",
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
  const isResearchOnly = tags.includes("research-only");
  const isReviewOnly = tags.includes("review-only");

  if (!isResearchOnly && !isReviewOnly) return null;

  if (!isImplementationTask(taskType, title, sourceRef, agent.github)) {
    // Task is genuinely research/review work — no enforcement needed.
    return null;
  }

  // Violation detected.  Find the best substitute implementation agent.
  const substitute = findImplementationAgent(config, agentName, sourceRef);
  if (!substitute) {
    log.warn("Capability violation detected but no substitute agent available — allowing dispatch to original", { agentName, sourceRef });
    return null;
  }

  const tagLabel = isReviewOnly ? "review-only" : "research-only";
  const redirectReason =
    `Agent "${agentName}" is tagged ${tagLabel} but received an implementation task` +
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

  // 2. First non-restricted agent (neither research-only nor review-only)
  for (const [name, a] of Object.entries(config.agents)) {
    if (name === blockedAgent) continue;
    const tags = a.capability_tags ?? [];
    if (!tags.includes("research-only") && !tags.includes("review-only")) return name;
  }

  // No valid substitute found — return null so callers can fall back gracefully
  log.warn("No valid implementation agent found for reroute", { blockedAgent, sourceRef });
  return null;
}

// ── Repo-ownership block (issue #1614) ───────────────────────────────────────

/**
 * Extract the owner/repo portion from a source_ref like "owner/repo#42".
 * Returns undefined when the ref has no "#" separator or doesn't look like
 * a GitHub repo ref (e.g. "linear-check:agentName:2026-01-01T00").
 *
 * Mirrors `extractRepoFromSourceRef` in dispatcher.ts — kept local to avoid a
 * circular dependency (dispatcher imports capability-enforcer, not vice versa).
 */
function extractRepo(sourceRef: string | undefined): string | undefined {
  if (!sourceRef) return undefined;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return undefined;
  const candidate = sourceRef.slice(0, hashIdx);
  if (!candidate.includes("/")) return undefined;
  return candidate;
}

export interface RepoOwnershipBlock {
  /** The original agent that was selected (doesn't own the target repo). */
  blockedAgent: string;
  /** The agent that owns the target repo and should receive the task instead. */
  toAgent: string;
  /** The target repo extracted from source_ref. */
  targetRepo: string;
  /** Human-readable reason recorded in routing decisions and logs. */
  redirectReason: string;
}

/**
 * Hard gate: block dispatch when the selected agent doesn't own the repo that
 * the task's source_ref points to.
 *
 * Only fires when ALL of the following are true:
 *  • The selected agent has a `github` field in agents.yaml (owns a repo).
 *  • The source_ref contains a GitHub repo slug ("owner/repo#N").
 *  • That slug does NOT match the agent's `github` field.
 *
 * When a block is triggered the function attempts to find the agent that does
 * own the target repo.  If none is found it returns null (allow-fallback) so
 * dispatch is never deadlocked.
 *
 * Issue #1614: "Hard repo-ownership block at task creation time"
 */
export function checkRepoOwnership(params: {
  config: OrchestratorConfig;
  agentName: string;
  sourceRef?: string;
}): RepoOwnershipBlock | null {
  const { config, agentName, sourceRef } = params;
  const agent = config.agents[agentName];
  if (!agent?.github) return null; // agent has no ownership claim — skip

  const targetRepo = extractRepo(sourceRef);
  if (!targetRepo) return null; // non-GitHub source_ref — skip

  if (agent.github === targetRepo) return null; // correct owner — no block

  // Violation: agent doesn't own this repo.  Find the true owner.
  const ownerAgent = findRepoOwnerAgent(config, targetRepo, agentName);
  if (!ownerAgent) {
    // No registered owner — allow rather than deadlock; operator can triage.
    log.warn("dispatch-blocked:wrong-repo — no owner agent found, allowing dispatch", {
      agentName,
      agentGithub: agent.github,
      targetRepo,
      sourceRef,
    });
    return null;
  }

  const redirectReason =
    `Agent "${agentName}" owns "${agent.github}" but received a task for "${targetRepo}". ` +
    `Redirected to "${ownerAgent}" (repo owner).`;

  log.warn("dispatch-blocked:wrong-repo", {
    blockedAgent: agentName,
    agentGithub: agent.github,
    targetRepo,
    toAgent: ownerAgent,
    sourceRef,
  });

  return {
    blockedAgent: agentName,
    toAgent: ownerAgent,
    targetRepo,
    redirectReason,
  };
}

/**
 * Find the agent whose `github` field matches `targetRepo`.
 * Skips the blocked agent itself. Returns null if none is found.
 */
function findRepoOwnerAgent(
  config: OrchestratorConfig,
  targetRepo: string,
  blockedAgent: string,
): string | null {
  for (const [name, a] of Object.entries(config.agents)) {
    if (name === blockedAgent) continue;
    if (a.github === targetRepo) return name;
  }
  return null;
}

// ── Agent-scope guard (pre-dispatch allowed_types check) ─────────────────────

export interface AgentScopeGuardReroute {
  /** The original agent that was selected before the guard check. */
  blockedAgent: string;
  /** The substitute agent that should receive the task instead. */
  toAgent: string;
  /** Human-readable reason recorded in the routing decisions log. */
  redirectReason: string;
  /** The task_type that was rejected. */
  rejectedType: string;
  /** The allowed types for the blocked agent. */
  allowedTypes: string[];
}

/**
 * Check whether the selected agent's allowed_types permits the given task.
 *
 * This guard runs BEFORE `checkCapabilityEnforcement()` so that routing
 * violations are caught at dispatch time without consuming agent budget.
 *
 * Returns an `AgentScopeGuardReroute` descriptor when the agent must be
 * bypassed, or `null` when no violation is detected or the agent has no
 * allowed_types constraint.
 *
 * Issue #974: "Pre-dispatch agent-scope guard in orchestrator"
 */
export function checkAgentScopeGuard(params: {
  config: OrchestratorConfig;
  agentName: string;
  taskType: string;
  title?: string;
  sourceRef?: string;
}): AgentScopeGuardReroute | null {
  const { config, agentName, taskType, title, sourceRef } = params;
  const agent = config.agents[agentName];
  if (!agent) return null;

  // No allowed_types constraint — permit any task type (legacy behaviour)
  const allowedTypes = agent.allowed_types ?? [];
  if (allowedTypes.length === 0) return null;

  // Check if the task type is in the allowed list
  if (allowedTypes.includes(taskType)) {
    return null; // Type is allowed — no violation
  }

  // Violation detected: task type not in allowed_types.
  // Find the best substitute agent that CAN handle this task type.
  const substitute = findAgentByAllowedType(config, taskType, agentName);
  if (!substitute) {
    log.warn(
      "Agent-scope violation detected but no suitable substitute agent available — allowing dispatch to original",
      { agentName, taskType, allowedTypes, sourceRef }
    );
    return null;
  }

  const redirectReason =
    `Agent "${agentName}" has allowed_types: [${allowedTypes.join(", ")}] but received task type "${taskType}"` +
    (title ? ` ("${title}")` : "") +
    `. Rerouted to "${substitute}".`;

  log.warn("Agent-scope guard: task type not in allowed_types — rerouting", {
    blockedAgent: agentName,
    toAgent: substitute,
    taskType,
    allowedTypes,
    sourceRef,
  });

  return {
    blockedAgent: agentName,
    toAgent: substitute,
    redirectReason,
    rejectedType: taskType,
    allowedTypes,
  };
}

/**
 * Find the best agent that allows the given task_type.
 *
 * Priority:
 * 1. The agent whose `github` field matches the source_ref repo AND whose
 *    allowed_types includes the taskType (or has no allowed_types constraint).
 * 2. The first agent whose allowed_types includes the taskType.
 * 3. The first agent with no allowed_types constraint (handles any type).
 * 4. null if no suitable agent is found.
 */
function findAgentByAllowedType(
  config: OrchestratorConfig,
  taskType: string,
  blockedAgent: string,
  sourceRef?: string,
): string | null {
  // Extract owner/repo from "owner/repo#N"
  let targetRepo: string | undefined;
  if (sourceRef) {
    const hashIdx = sourceRef.lastIndexOf("#");
    if (hashIdx > 0) targetRepo = sourceRef.slice(0, hashIdx);
  }

  // 1. Exact repo match + allowed type + no research-only constraint
  if (targetRepo) {
    for (const [name, a] of Object.entries(config.agents)) {
      if (name === blockedAgent) continue;
      if (a.github !== targetRepo) continue;

      const tags = a.capability_tags ?? [];
      if (tags.includes("research-only")) continue; // Skip research-only agents

      const allowedTypes = a.allowed_types ?? [];
      if (allowedTypes.length === 0 || allowedTypes.includes(taskType)) {
        return name;
      }
    }
  }

  // 2. Any agent whose allowed_types includes this taskType
  for (const [name, a] of Object.entries(config.agents)) {
    if (name === blockedAgent) continue;
    const allowedTypes = a.allowed_types ?? [];
    if (allowedTypes.includes(taskType)) return name;
  }

  // 3. Any agent with no allowed_types constraint (handles anything)
  for (const [name, a] of Object.entries(config.agents)) {
    if (name === blockedAgent) continue;
    const allowedTypes = a.allowed_types ?? [];
    if (allowedTypes.length === 0) {
      const tags = a.capability_tags ?? [];
      // Skip research-only agents unless they handle all types
      if (!tags.includes("research-only")) return name;
    }
  }

  log.warn("No valid agent found for task type", { blockedAgent, taskType, sourceRef });
  return null;
}
