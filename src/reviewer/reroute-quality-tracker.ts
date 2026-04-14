/**
 * Reroute Quality Tracker
 *
 * Correlates rerouting decisions with quality outcomes to identify which
 * routing patterns consistently degrade output quality. When a task is
 * auto-rerouted and later verified with a quality score, this tracker
 * measures whether the reroute improved or degraded quality compared to
 * the original agent's baseline performance.
 *
 * Acceptance criteria (issue #107):
 *   ✓ parseRerouteDecision() — extract source/dest agents from supervisor decision
 *   ✓ getRerouteQualityStats() — per-reroute-pair quality comparison
 *   ✓ getRerouteQualityReport() — human-readable degradation patterns
 *   ✓ formatRerouteQualitySection() — supervisor context with problem patterns
 */

import type { IStateStore } from "../state/types.js";

export interface RerouteDecision {
  taskId: string | null;
  sourceRef: string;
  fromAgent: string;
  toAgent: string;
  reason: "failed-attempts" | "rejection-threshold" | "unknown";
  decidedAt: string;
  quality_score?: number | null;
  approval_status?: "approved" | "rejected" | null;
}

export interface RerouteQualityStats {
  fromAgent: string;
  toAgent: string;
  taskType: string;
  reroute_count: number;
  avg_from_agent_score: number | null;
  avg_to_agent_score: number | null;
  quality_delta: number | null;
  approval_rate: number | null;
  is_degraded: boolean;
}

export interface RerouteQualityReport {
  totalReroutes: number;
  degradedReroutes: number;
  degradationRate: number;
  patterns: RerouteQualityStats[];
  worst_patterns: RerouteQualityStats[];
}

export interface RerouteQualityProvider {
  getRerouteDecisions(days?: number): RerouteDecision[];
  getRerouteQualityStats(days?: number): RerouteQualityStats[];
  getRerouteQualityReport(days?: number): RerouteQualityReport;
  formatRerouteQualitySection(days?: number): string[];
}

export class RerouteQualityTracker implements RerouteQualityProvider {
  constructor(private store: IStateStore) {}

  /**
   * Extract reroute decisions from supervisor_decisions table.
   *
   * Parses the rationale field which contains patterns like:
   *   "Auto-rerouted owner/repo#42 from claude-agent-a to claude-agent-b after 3 failed attempt(s)"
   *   "Substituted claude-agent-x with claude-agent-y after 2 consecutive rejected attempt(s)"
   *
   * @param days Look-back window (default: 30 days)
   * @returns Array of parsed reroute decisions with quality scores from completed tasks
   */
  getRerouteDecisions(days = 30): RerouteDecision[] {
    // Query supervisor_decisions for reroute events
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - days);
    const sinceIso = sinceDate.toISOString();

    // Query for both failure-based and rejection-based reroutes
    const failedAttemptsDecisions = this.store.querySupervisorDecisions({
      action: "dispatch",
      since: sinceIso,
      limit: 1000,
    });

    const reroutes = failedAttemptsDecisions
      .filter((d) => {
        const reason = String(d.reason || "").toLowerCase();
        return (
          reason.includes("auto-reroute-failed-attempts") ||
          reason.includes("auto-reroute")
        );
      })
      .map((d) => {
        const parsed = this.parseRerouteDecision(d);
        if (!parsed) return null;

        // Fetch quality score for the rerouted task
        let quality_score: number | null = null;
        let approval_status: "approved" | "rejected" | null = null;

        if (d.task_id) {
          const task = this.store.getTask(d.task_id);
          if (task && task.quality_score !== undefined) {
            quality_score = task.quality_score;
            approval_status = task.verification_status as
              | "approved"
              | "rejected"
              | null;
          }
        }

        return {
          ...parsed,
          quality_score,
          approval_status,
        };
      })
      .filter((d) => d !== null) as RerouteDecision[];

    return reroutes;
  }

  /**
   * Parse a supervisor_decision record to extract reroute information.
   *
   * @returns Parsed reroute decision or null if not a valid reroute decision
   */
  private parseRerouteDecision(
    decision: any
  ): Omit<RerouteDecision, "quality_score" | "approval_status"> | null {
    const rationale = decision.rationale || "";

    // Pattern: "Auto-rerouted owner/repo#42 from claude-agent-x to claude-agent-y after N failed attempt(s)"
    const failedAttemptsMatch = rationale.match(
      /Auto-rerouted\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i
    );
    if (failedAttemptsMatch) {
      return {
        taskId: decision.task_id || null,
        sourceRef: failedAttemptsMatch[1],
        fromAgent: failedAttemptsMatch[2],
        toAgent: failedAttemptsMatch[3],
        reason: "failed-attempts",
        decidedAt: decision.created_at,
      };
    }

    // Pattern: "Substituted claude-agent-x with claude-agent-y after N consecutive rejected attempt(s)"
    const rejectionMatch = rationale.match(
      /Substituted\s+(\S+)\s+with\s+(\S+)/i
    );
    if (rejectionMatch) {
      return {
        taskId: decision.task_id || null,
        sourceRef: decision.source_ref || "unknown",
        fromAgent: rejectionMatch[1],
        toAgent: rejectionMatch[2],
        reason: "rejection-threshold",
        decidedAt: decision.created_at,
      };
    }

    return null;
  }

  /**
   * Get quality statistics for each reroute pattern (from-agent, to-agent, task-type combo).
   *
   * Compares the average quality score of the rerouted agent (to-agent) with the
   * baseline quality of the original agent (from-agent) for the same task type.
   *
   * @param days Look-back window (default: 30 days)
   * @returns Statistics for each reroute pattern, sorted by degradation
   */
  getRerouteQualityStats(days = 30): RerouteQualityStats[] {
    const decisions = this.getRerouteDecisions(days);

    // Group by (fromAgent, toAgent, taskType)
    const groups = new Map<string, RerouteQualityStats>();

    for (const decision of decisions) {
      // Infer task type from source_ref if available, default to "unknown"
      const taskType = decision.sourceRef?.includes("research")
        ? "research"
        : "implementation";

      const key = `${decision.fromAgent}|${decision.toAgent}|${taskType}`;

      if (!groups.has(key)) {
        groups.set(key, {
          fromAgent: decision.fromAgent,
          toAgent: decision.toAgent,
          taskType,
          reroute_count: 0,
          avg_from_agent_score: null,
          avg_to_agent_score: null,
          quality_delta: null,
          approval_rate: null,
          is_degraded: false,
        });
      }

      const stats = groups.get(key)!;
      stats.reroute_count += 1;

      // Accumulate quality score for to-agent (reroute target)
      if (decision.quality_score !== undefined && decision.quality_score !== null) {
        const current = stats.avg_to_agent_score ?? 0;
        stats.avg_to_agent_score =
          (current * (stats.reroute_count - 1) + decision.quality_score) /
          stats.reroute_count;
      }

      // Track approval rate
      if (decision.approval_status !== undefined) {
        const approved =
          decision.approval_status === "approved" ? 1 : 0;
        const current = stats.approval_rate ?? 0;
        stats.approval_rate =
          (current * (stats.reroute_count - 1) + approved) /
          stats.reroute_count;
      }
    }

    // Calculate baseline quality for from-agent per task type
    const agentQualityByType = this.store.getAgentQualityByTaskType(days);

    for (const stats of groups.values()) {
      // Find baseline for the from-agent
      const agentData = agentQualityByType.find(
        (a) => a.agent_name === stats.fromAgent
      );
      if (agentData) {
        const typeData = agentData.by_task_type.find(
          (t) => t.task_type === stats.taskType
        );
        stats.avg_from_agent_score = typeData?.avg_quality_score ?? null;
      }

      // Calculate quality delta
      if (stats.avg_to_agent_score !== null && stats.avg_from_agent_score !== null) {
        stats.quality_delta =
          stats.avg_to_agent_score - stats.avg_from_agent_score;
        stats.is_degraded =
          stats.quality_delta < -0.05; // 5-point degradation threshold
      }
    }

    return Array.from(groups.values())
      .sort((a, b) => {
        // Sort by degradation (most degraded first)
        const deltaA = a.quality_delta ?? 0;
        const deltaB = b.quality_delta ?? 0;
        return deltaA - deltaB; // ascending order = most negative first
      });
  }

  /**
   * Generate a comprehensive reroute quality degradation report.
   *
   * Identifies patterns where rerouting consistently reduces quality and
   * summarizes the impact.
   *
   * @param days Look-back window (default: 30 days)
   * @returns Report with overall statistics and worst-performing reroute patterns
   */
  getRerouteQualityReport(days = 30): RerouteQualityReport {
    const allStats = this.getRerouteQualityStats(days);

    const degraded = allStats.filter((s) => s.is_degraded);
    const totalReroutes = allStats.reduce((sum, s) => sum + s.reroute_count, 0);

    return {
      totalReroutes,
      degradedReroutes: degraded.length,
      degradationRate: totalReroutes > 0 ? degraded.length / totalReroutes : 0,
      patterns: allStats,
      worst_patterns: degraded.slice(0, 5), // Top 5 worst patterns
    };
  }

  /**
   * Format reroute quality report as supervisor context lines.
   *
   * Highlights problematic routing patterns that degrade quality.
   *
   * Example output:
   *   - ⚠ Reroute degradation: claude-orchestrator-dashboard→claude-proxy (implementation)
   *     from 0.85 to 0.65 (-20pts, 3 reroutes, 67% approval)
   *   - ⚠ Reroute degradation: claude-agent-orchestrator→claude-orchestrator-reviewer
   *     from 0.79 to 0.71 (-8pts, 5 reroutes, 60% approval)
   */
  formatRerouteQualitySection(days = 30): string[] {
    const report = this.getRerouteQualityReport(days);

    if (report.totalReroutes === 0) {
      return [];
    }

    if (report.worst_patterns.length === 0) {
      return [
        `✓ No quality degradation from rerouting (${report.totalReroutes} reroutes, ${(report.degradationRate * 100).toFixed(0)}% degraded)`,
      ];
    }

    const lines: string[] = [];

    if (report.degradationRate > 0) {
      lines.push(
        `⚠ Rerouting quality impact: ${report.degradedReroutes}/${report.totalReroutes} reroutes degrade quality (${(report.degradationRate * 100).toFixed(0)}% degradation rate)`
      );
    }

    for (const pattern of report.worst_patterns) {
      const fromScore = pattern.avg_from_agent_score?.toFixed(2) ?? "n/a";
      const toScore = pattern.avg_to_agent_score?.toFixed(2) ?? "n/a";
      const delta =
        pattern.quality_delta !== null
          ? `${pattern.quality_delta >= 0 ? "+" : ""}${(pattern.quality_delta * 100).toFixed(0)}pts`
          : "n/a";
      const approval =
        pattern.approval_rate !== null
          ? `${(pattern.approval_rate * 100).toFixed(0)}% approval`
          : "n/a";

      lines.push(
        `  - ${pattern.fromAgent} → ${pattern.toAgent} (${pattern.taskType}): ` +
          `${fromScore} → ${toScore} (${delta}, ${pattern.reroute_count} reroutes, ${approval})`
      );
    }

    return lines;
  }
}
