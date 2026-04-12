/**
 * Routing Accuracy Tracker
 *
 * Closes the feedback loop between routing decisions and task outcomes.
 * When a task completes verification, the quality score and approval status
 * are already persisted on the `tasks` row by the Verifier.  This module
 * queries that data to surface per-agent accuracy metrics so the supervisor
 * can prefer higher-accuracy agents for future routing.
 *
 * Acceptance criteria (issue #67):
 *   ✔ getAccuracyStats()        — avg quality score per agent over N days
 *   ✔ getQualityByTaskType()    — per-agent breakdown by implementation/research
 *   ✔ formatAccuracySection()   — human-readable lines for supervisor context
 *   ✔ formatQualityByTypeSection() — per-type breakdown for supervisor context
 */

import type {
  IStateStore,
  RoutingAccuracyStats,
  AgentQualityByTaskType,
} from "../state/types.js";

export type { RoutingAccuracyStats, AgentQualityByTaskType };

export interface RoutingAccuracyProvider {
  getAccuracyStats(days?: number): RoutingAccuracyStats[];
  getQualityByTaskType(): AgentQualityByTaskType[];
}

export class RoutingAccuracyTracker implements RoutingAccuracyProvider {
  constructor(private store: IStateStore) {}

  /**
   * Return per-agent routing accuracy stats for the given look-back window
   * (default: 30 days).
   *
   * Stats are derived from verified tasks — tasks with quality_score set by
   * the Verifier.  Agents with no verified tasks in the window are included
   * so callers can see agents that have been routed but never verified.
   */
  getAccuracyStats(days = 30): RoutingAccuracyStats[] {
    return this.store.getRoutingAccuracyStats(days);
  }

  /**
   * Return per-agent quality scores broken down by task type (implementation /
   * research) over the last 30 days.
   */
  getQualityByTaskType(): AgentQualityByTaskType[] {
    return this.store.getAgentQualityByTaskType();
  }

  /**
   * Format routing accuracy stats as human-readable supervisor context lines.
   *
   * Example output:
   *   - claude-agent-dashboard: avg score 0.84, approval rate 91% (22/24 verified, last 30d)
   *   - claude-agent-orchestrator: avg score 0.71, approval rate 73% (8/11 verified, last 30d)
   */
  formatAccuracySection(days = 30): string[] {
    const stats = this.getAccuracyStats(days);
    if (stats.length === 0) return [];

    return stats.map((s) => {
      const score =
        s.avg_quality_score !== null && s.avg_quality_score !== undefined
          ? s.avg_quality_score.toFixed(2)
          : "n/a";
      const rate =
        s.approval_rate !== null && s.approval_rate !== undefined
          ? `${(s.approval_rate * 100).toFixed(0)}%`
          : "n/a";
      return `- ${s.agent_name}: avg score ${score}, approval rate ${rate} (${s.verified_count}/${s.total_routed} verified, last ${days}d)`;
    });
  }

  /**
   * Format per-agent quality breakdown by task type as supervisor context lines.
   *
   * Example output:
   *   - claude-agent-dashboard: implementation(0.85×18), research(0.79×4)
   *   - claude-agent-orchestrator: implementation(0.70×9), research(0.75×2)
   */
  formatQualityByTypeSection(): string[] {
    const byAgent = this.getQualityByTaskType();
    if (byAgent.length === 0) return [];

    return byAgent.map((agent) => {
      const parts = agent.by_task_type.map((t) => {
        const score =
          t.avg_quality_score !== null && t.avg_quality_score !== undefined
            ? t.avg_quality_score.toFixed(2)
            : "n/a";
        return `${t.task_type}(${score}×${t.task_count})`;
      });
      return `- ${agent.agent_name}: ${parts.join(", ")}`;
    });
  }
}
