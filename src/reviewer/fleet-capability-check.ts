/**
 * Fleet-wide agent capability check endpoint — cross-repo issue (research-agent#178)
 *
 * Problem: agents receive tasks dispatched by the orchestrator but only discover
 * they are misrouted after partially starting work. Task `01KPWCH3` is a concrete
 * example: an implementation task for agent-reviewer#441 (PR guard cooldown
 * enforcement) was dispatched to the research agent, which started work before
 * detecting the mismatch.
 *
 * Fix: expose a REST endpoint on the reviewer (the fleet's quality/oversight hub)
 * that ANY agent can call immediately upon receiving a task — before doing any
 * analysis, investigation, or implementation — to confirm they are the correct
 * handler:
 *
 *   GET /api/fleet-capability-check
 *       ?agent=claude-research-agent
 *       &task_type=implementation
 *       &source_ref=rapartlu%2Fagent-reviewer%23441
 *       &title=feat%3A+PR+guard+cooldown+enforcement
 *
 * Response when the agent should reject the task:
 *   {
 *     "agent": "claude-research-agent",
 *     "accept": false,
 *     "reason": "claude-research-agent does not handle implementation tasks...",
 *     "suggested_agents": ["claude-orchestrator-reviewer"],
 *     "checked_at": "2026-04-23T14:00:00.000Z"
 *   }
 *
 * Response when the agent should proceed:
 *   {
 *     "agent": "claude-research-agent",
 *     "accept": true,
 *     "reason": null,
 *     "suggested_agents": [],
 *     "checked_at": "2026-04-23T14:00:00.000Z"
 *   }
 *
 * ## Fleet capability map
 *
 * Each agent declares a set of task types it accepts and a set of repos where
 * it can perform implementation work. The map is defined in
 * {@link FLEET_CAPABILITY_MAP} and kept in sync with CLAUDE.md.
 *
 * ## Design constraints
 *
 * - The check is deterministic (no LLM, no DB) — sub-millisecond response.
 * - The check is conservative: if the agent is unknown, `accept: true` is
 *   returned so forward-compatibility is preserved when new agents are added.
 * - Implementation tasks for an agent's OWN repo are always accepted (the
 *   agent is the right implementer of its own features).
 *
 * ## Research agent specifics
 *
 * The research agent accepts: research, investigation, housekeeping.
 * It MUST NOT receive implementation tasks unless the target repo is
 * `rapartlu/research-agent` (its own codebase).
 *
 * Mount on the reviewer HTTP server:
 *
 *   app.get('/api/fleet-capability-check', (req, res) => {
 *     res.json(handleFleetCapabilityCheck(req.query as Record<string, string>));
 *   });
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("fleet-capability-check");

// ── Fleet capability map ───────────────────────────────────────────────────────

/**
 * Per-agent capability declaration.
 */
export interface AgentCapabilityEntry {
  /** Task types this agent accepts. */
  allowedTaskTypes: ReadonlySet<string>;
  /**
   * The agent's own GitHub repo (owner/repo). Implementation tasks targeting
   * this repo are ALWAYS accepted regardless of task_type.
   */
  ownRepo: string | null;
  /**
   * Human-readable description of what this agent does.
   * Surfaced in rejection messages so developers know where to re-dispatch.
   */
  description: string;
}

/**
 * Fleet-wide capability map.
 *
 * Each entry key is the agent name used in the orchestrator's agent registry.
 * Keep in sync with CLAUDE.md system architecture table and each agent's
 * own `capability-check.ts`.
 */
export const FLEET_CAPABILITY_MAP: Readonly<Record<string, AgentCapabilityEntry>> = {
  "claude-orchestrator-reviewer": {
    allowedTaskTypes: new Set([
      "review", "verification", "supervision", "improvement",
      "triage", "housekeeping", "research", "escalation",
    ]),
    ownRepo: "rapartlu/agent-reviewer",
    description: "PR review, task verification, quality oversight, improvement detection",
  },
  "claude-research-agent": {
    allowedTaskTypes: new Set([
      "research", "investigation", "housekeeping",
    ]),
    ownRepo: "rapartlu/research-agent",
    description: "Technology research, investigation, feasibility analysis",
  },
  "claude-agent-orchestrator": {
    allowedTaskTypes: new Set([
      "implementation", "housekeeping", "maintenance",
    ]),
    ownRepo: "rapartlu/agent-orchestrator",
    description: "Core daemon, dispatching infrastructure, state store",
  },
  "claude-orchestrator-dashboard": {
    allowedTaskTypes: new Set([
      "implementation", "housekeeping", "maintenance",
    ]),
    ownRepo: "rapartlu/agent-dashboard",
    description: "Dashboard UI, CLI commands, metrics visualization",
  },
  "claude-orchestrator-telegram": {
    allowedTaskTypes: new Set([
      "implementation", "housekeeping",
    ]),
    ownRepo: "rapartlu/agent-orchestrator",
    description: "Telegram command handling",
  },
  "claude-proxy": {
    allowedTaskTypes: new Set([
      "implementation", "housekeeping", "maintenance",
    ]),
    ownRepo: "rapartlu/agent-proxy",
    description: "Proxy server, container management, security scanning",
  },
  "meeting-facilitator-agent": {
    allowedTaskTypes: new Set([
      "implementation", "housekeeping", "facilitation",
    ]),
    ownRepo: "rapartlu/meeting-facilitator-agent",
    description: "Meeting facilitation, structured discussions",
  },
} as const;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FleetCapabilityCheckRequest {
  /** The agent receiving the task (e.g. "claude-research-agent"). */
  agent: string;
  /** Task type string (e.g. "implementation", "research"). */
  task_type: string;
  /** Task title — used for heuristic keyword matching when task_type is ambiguous. */
  title?: string;
  /**
   * Source reference e.g. "rapartlu/agent-reviewer#441".
   * Used to extract the target repo to check own-repo exemption.
   */
  source_ref?: string;
}

export interface FleetCapabilityCheckResponse {
  /** The agent that was checked. */
  agent: string;
  /**
   * Whether the agent should accept and work on this task.
   * `false` means the task should be rejected before starting any work.
   */
  accept: boolean;
  /**
   * Human-readable rejection reason.
   * `null` when `accept === true`.
   */
  reason: string | null;
  /**
   * Agent names that are better suited for this task.
   * Empty when `accept === true` or when no better candidate is known.
   */
  suggested_agents: string[];
  /** ISO-8601 timestamp when the check was performed. */
  checked_at: string;
}

// ── Pure logic ────────────────────────────────────────────────────────────────

/**
 * Extract the GitHub repo slug (owner/repo) from a source_ref like
 * "owner/repo#123". Returns null if the format does not match.
 */
export function extractRepoFromSourceRef(sourceRef: string | undefined | null): string | null {
  if (!sourceRef) return null;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return null;
  return sourceRef.slice(0, hashIdx);
}

/**
 * Find all agents in the fleet capable of handling a given task type and
 * target repo combination — used to populate `suggested_agents`.
 */
export function findCapableAgents(taskType: string, targetRepo: string | null): string[] {
  const candidates: string[] = [];
  for (const [agentName, entry] of Object.entries(FLEET_CAPABILITY_MAP)) {
    if (entry.allowedTaskTypes.has(taskType)) {
      candidates.push(agentName);
      continue;
    }
    // Own-repo exemption: the target repo's home agent is always a candidate
    if (targetRepo && entry.ownRepo === targetRepo) {
      candidates.push(agentName);
    }
  }
  return candidates;
}

/**
 * Evaluate whether the given agent should accept the described task.
 *
 * Decision logic:
 * 1. If the agent is unknown in the fleet map, accept (forward-compatible).
 * 2. If the target repo is the agent's own repo, accept (own-codebase work).
 * 3. If the task_type is in the agent's allowed set, accept.
 * 4. Otherwise reject, and populate `suggested_agents`.
 *
 * This function is pure — no side effects, no logging.
 */
export function evaluateFleetCapability(
  req: FleetCapabilityCheckRequest,
  now: Date = new Date(),
): FleetCapabilityCheckResponse {
  const entry = FLEET_CAPABILITY_MAP[req.agent];
  const checkedAt = now.toISOString();

  // 1. Unknown agent → accept (don't block new agents not yet in the map).
  if (!entry) {
    return {
      agent: req.agent,
      accept: true,
      reason: null,
      suggested_agents: [],
      checked_at: checkedAt,
    };
  }

  const targetRepo = extractRepoFromSourceRef(req.source_ref);

  // 2. Own-repo work is always accepted.
  if (entry.ownRepo && targetRepo === entry.ownRepo) {
    return {
      agent: req.agent,
      accept: true,
      reason: null,
      suggested_agents: [],
      checked_at: checkedAt,
    };
  }

  // 3. Task type is in the allowed set → accept.
  if (entry.allowedTaskTypes.has(req.task_type)) {
    return {
      agent: req.agent,
      accept: true,
      reason: null,
      suggested_agents: [],
      checked_at: checkedAt,
    };
  }

  // 4. Reject — build a helpful reason and suggest better-suited agents.
  const suggestedAgents = findCapableAgents(req.task_type, targetRepo);

  const allowedList = [...entry.allowedTaskTypes].join(", ");
  const repoHint = targetRepo ? ` targeting \`${targetRepo}\`` : "";
  const suggestionHint = suggestedAgents.length
    ? ` Consider: ${suggestedAgents.join(", ")}.`
    : "";

  const reason =
    `${req.agent} does not handle task type "${req.task_type}"${repoHint}. ` +
    `This agent accepts: ${allowedList} (${entry.description}).` +
    suggestionHint +
    ` Reject this task before starting any work and return it to the orchestrator for rerouting.`;

  return {
    agent: req.agent,
    accept: false,
    reason,
    suggested_agents: suggestedAgents,
    checked_at: checkedAt,
  };
}

// ── HTTP handler ──────────────────────────────────────────────────────────────

/**
 * Parse query parameters from a `GET /api/fleet-capability-check` request into
 * a `FleetCapabilityCheckRequest`.
 *
 * Accepts both string values (from URL query strings) and an `agent` body field.
 */
export function parseFleetCapabilityCheckQuery(
  params: Record<string, string | undefined>,
): FleetCapabilityCheckRequest {
  return {
    agent: params.agent ?? "",
    task_type: params.task_type ?? "implementation",
    title: params.title ?? undefined,
    source_ref: params.source_ref ?? undefined,
  };
}

/**
 * Handle an incoming fleet capability check request.
 *
 * Mount as:
 *   app.get('/api/fleet-capability-check', (req, res) => {
 *     res.json(handleFleetCapabilityCheck(req.query as Record<string, string>));
 *   });
 *
 * The research agent calls this at the very start of any received task:
 *
 *   const check = await fetch(
 *     `http://reviewer:3474/api/fleet-capability-check?` +
 *     `agent=claude-research-agent&task_type=${task.task_type}` +
 *     `&source_ref=${encodeURIComponent(task.source_ref ?? '')}`
 *   ).then(r => r.json());
 *
 *   if (!check.accept) {
 *     return { status: 'rejected', reason: check.reason };
 *   }
 */
export function handleFleetCapabilityCheck(
  queryParams: Record<string, string | undefined>,
  now: Date = new Date(),
): FleetCapabilityCheckResponse {
  const req = parseFleetCapabilityCheckQuery(queryParams);

  const result = evaluateFleetCapability(req, now);

  if (!result.accept) {
    log.info("Fleet capability check: task rejected", {
      agent: req.agent,
      task_type: req.task_type,
      source_ref: req.source_ref,
      suggested_agents: result.suggested_agents,
    });
  }

  return result;
}
