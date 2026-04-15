/**
 * Routing Mismatch Detector
 *
 * Detects tasks where the executed agent doesn't match the intended agent
 * (extracted from the task title's [agent-name] prefix).
 *
 * Usage:
 *   const intended = extractIntendedAgent("[claude-research-agent] Research task", config);
 *   const isMismatch = intended && intended !== task.agent_name;
 */

import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

/**
 * Extract intended agent name from task title.
 *
 * Looks for [agent-name] prefix at the start of the title.
 * Example: "[claude-research-agent] Research: findings discovery" → "claude-research-agent"
 *
 * @param title Task title
 * @param config OrchestratorConfig with agents list for validation
 * @returns Agent name if found and valid, null otherwise
 */
export function extractIntendedAgent(
  title: string,
  config: OrchestratorConfig,
): string | null {
  if (!title) return null;

  // Match [agent-name] at the start of the title
  const match = title.match(/^\s*\[([a-z0-9-]+)\]/i);
  if (!match) return null;

  const agentName = match[1];

  // Validate that the agent exists in config
  if (!config.agents[agentName]) return null;

  return agentName;
}

/**
 * Detect if a task has a routing mismatch.
 *
 * A mismatch occurs when:
 * - Task title has a valid [agent-name] prefix (intended agent)
 * - The actual agent that executed the task differs
 * - The task is not a meta-task (executed by orchestrator)
 *
 * @param task Task to check
 * @param config OrchestratorConfig for agent validation
 * @returns true if there is a routing mismatch
 */
export function isRoutingMismatch(
  task: Task,
  config: OrchestratorConfig,
): boolean {
  const intendedAgent = extractIntendedAgent(task.title, config);

  if (!intendedAgent) return false;
  if (!task.agent_name) return false;

  // Task executed by a different agent than intended
  return intendedAgent !== task.agent_name;
}

/**
 * Details about a routing mismatch for reporting.
 */
export interface RoutingMismatchDetail {
  taskId: string;
  taskTitle: string;
  intendedAgent: string;
  actualAgent: string;
  qualityScore: number | null;
  taskStatus: string;
  createdAt: string;
  verificationStatus?: string | null;
}

/**
 * Detect routing mismatch details from a task.
 *
 * @param task Task to analyze
 * @param config OrchestratorConfig for validation
 * @returns Mismatch detail if mismatch detected, null otherwise
 */
export function getRoutingMismatchDetail(
  task: Task,
  config: OrchestratorConfig,
): RoutingMismatchDetail | null {
  const intendedAgent = extractIntendedAgent(task.title, config);

  if (!intendedAgent || !task.agent_name || intendedAgent === task.agent_name) {
    return null;
  }

  return {
    taskId: task.id,
    taskTitle: task.title,
    intendedAgent,
    actualAgent: task.agent_name,
    qualityScore: task.quality_score ?? null,
    taskStatus: task.status,
    createdAt: task.created_at,
    verificationStatus: task.verification_status,
  };
}

/**
 * Mismatch summary statistics.
 */
export interface RoutingMismatchStats {
  totalTasksAnalyzed: number;
  mismatchCount: number;
  mismatchRate: number;
  byAgentPair: Array<{
    intendedAgent: string;
    actualAgent: string;
    count: number;
    avgQualityScore: number | null;
    mostRecentAt: string;
  }>;
  lowQualityMismatches: number;
}
