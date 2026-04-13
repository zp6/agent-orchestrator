/**
 * Iteration cost → automatic improvement issue routing (issue #748).
 *
 * Reads per-agent PR iteration metrics from state.db and, when a rolling
 * average exceeds the threshold, produces a DetectedImprovement that the
 * IssueCreator can file as a GitHub issue with the 'iteration-cost-triggered'
 * label so operators can distinguish them from LLM-generated improvement
 * suggestions.
 */

import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { DetectedImprovement } from "../client/reviewer-client.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("iteration-cost-detector");

/**
 * Rolling-average revision rounds per PR above which an agent is flagged.
 * Default: 1.5 rounds — i.e. an agent whose PRs require feedback more than
 * 50% of the time on average is surfaced for review.
 */
export const ITERATION_COST_THRESHOLD = 1.5;

/**
 * Minimum number of recent tasks the agent must have before the average is
 * considered statistically meaningful enough to file an issue.
 */
export const ITERATION_COST_MIN_TASKS = 10;

/**
 * How many calendar days of history to look back when computing the rolling
 * average (passed directly to getAgentIterationCostMetrics).
 */
export const ITERATION_COST_WINDOW_DAYS = 30;

/** Severity thresholds relative to ITERATION_COST_THRESHOLD. */
const HIGH_SEVERITY_MULTIPLIER = 2.0; // e.g. avg >= 3.0 → high
const MEDIUM_SEVERITY_MULTIPLIER = 1.3; // e.g. avg >= 1.95 → medium

export interface IterationCostMetric {
  agent_name: string;
  task_count: number;
  avg_revision_count: number;
  sample_task_ids: string[];
}

/**
 * Classify severity based on how far the average exceeds the threshold.
 */
function classifySeverity(
  avg: number,
): DetectedImprovement["severity"] {
  if (avg >= ITERATION_COST_THRESHOLD * HIGH_SEVERITY_MULTIPLIER) return "high";
  if (avg >= ITERATION_COST_THRESHOLD * MEDIUM_SEVERITY_MULTIPLIER) return "medium";
  return "low";
}

/**
 * Format the improvement description with actionable context.
 */
function buildDescription(metric: IterationCostMetric): string {
  const avg = metric.avg_revision_count.toFixed(2);
  const threshold = ITERATION_COST_THRESHOLD.toFixed(1);
  const pctOver = Math.round(
    ((metric.avg_revision_count - ITERATION_COST_THRESHOLD) / ITERATION_COST_THRESHOLD) * 100,
  );

  return (
    `Agent **${metric.agent_name}** is averaging **${avg} revision rounds per PR** ` +
    `over the last ${metric.task_count} implementation tasks (threshold: ${threshold} rounds, ` +
    `${pctOver}% over). ` +
    `This indicates the agent is frequently producing PRs that require reviewer feedback loops. ` +
    `Investigate: (1) whether task descriptions are underspecified, ` +
    `(2) whether the agent's CLAUDE.md conventions need updating, or ` +
    `(3) whether the reviewer feedback is being injected correctly at dispatch time.`
  );
}

/**
 * Detect agents whose rolling PR iteration cost exceeds the threshold and
 * return them as DetectedImprovement objects ready for IssueCreator.
 *
 * This function is intentionally synchronous (no LLM call) — it reads
 * only from the local state.db so it can run on every improvement check
 * cycle without adding latency.
 *
 * Only agents that are registered in the config are included (orphaned task
 * records for decommissioned agents are skipped).
 *
 * @param store  - StateStore instance.
 * @param config - OrchestratorConfig for agent validation.
 * @returns Array of DetectedImprovement (may be empty).
 */
export function detectHighIterationAgents(
  store: StateStore,
  config: OrchestratorConfig,
): DetectedImprovement[] {
  const knownAgents = new Set(Object.keys(config.agents));

  let metrics: IterationCostMetric[];
  try {
    metrics = store.getAgentIterationCostMetrics(
      ITERATION_COST_WINDOW_DAYS,
      ITERATION_COST_MIN_TASKS,
    );
  } catch (err) {
    log.warn("Failed to query agent iteration cost metrics", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const improvements: DetectedImprovement[] = [];

  for (const metric of metrics) {
    // Skip unknown/decommissioned agents
    if (!knownAgents.has(metric.agent_name)) continue;

    if (metric.avg_revision_count <= ITERATION_COST_THRESHOLD) continue;

    const severity = classifySeverity(metric.avg_revision_count);

    log.info("High iteration cost detected", {
      agent: metric.agent_name,
      avg: metric.avg_revision_count.toFixed(2),
      threshold: ITERATION_COST_THRESHOLD,
      severity,
      taskCount: metric.task_count,
    });

    improvements.push({
      title: `High PR iteration cost for ${metric.agent_name} (avg ${metric.avg_revision_count.toFixed(1)} rounds/PR)`,
      description: buildDescription(metric),
      affected_agents: [metric.agent_name],
      severity,
      evidence: metric.sample_task_ids.map((id) => ({
        taskId: id,
        detail: `High-revision task (agent: ${metric.agent_name}, avg rounds over last ${metric.task_count} tasks: ${metric.avg_revision_count.toFixed(2)})`,
      })),
    });
  }

  return improvements;
}
