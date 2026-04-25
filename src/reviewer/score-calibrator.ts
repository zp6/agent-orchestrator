/**
 * Score Calibrator
 *
 * Closes the feedback loop between verification scores and actual PR outcomes.
 * Implements issue #64 (follow-up from rapartlu/agent-orchestrator#609):
 *
 *   ✔ Outcome recording: links each verified task's quality_score to the
 *     eventual PR result (merged / changes_requested / rejected / redispatched).
 *
 *   ✔ Calibration model: computes a `(agent, score_bucket, task_type) →
 *     actual_merge_rate` lookup table from recorded outcome events.
 *
 *   ✔ Threshold adjustment: recommends per-agent min_score thresholds based on
 *     which score bucket first achieves the target merge rate (default 80%).
 *
 *   ✔ Supervisor context section: surfaces action-required threshold changes so
 *     the supervisor can escalate to the operator.
 *
 *   ✔ Telegram formatter: enhances /verification-calibration page with the
 *     calibration table and threshold recommendations.
 *
 * Usage (from the orchestrator daemon):
 *
 *   // After a PR is merged:
 *   scoreCalibrator.recordOutcome({
 *     taskId: task.id,
 *     agentName: task.agent_name,
 *     taskType: task.task_type,
 *     qualityScore: task.quality_score,
 *     repo: 'owner/repo',
 *     prNumber: 42,
 *     outcome: 'merged',
 *   });
 *
 *   // In supervisor context building:
 *   const sections = scoreCalibrator.formatThresholdSection();
 */

import type {
  IScoreOutcomeStore,
  ICalibrationRecommendationStore,
  PROutcome,
  ScoreCalibrationRow,
  AdjustedThreshold,
  CalibrationRecommendation,
  CalibrationRecommendationStatus,
  TaskType,
} from "../state/types.js";
import { createLogger } from "../service/logger.js";

export type { PROutcome, ScoreCalibrationRow, AdjustedThreshold, CalibrationRecommendation, CalibrationRecommendationStatus };

/** Minimum PR outcome records per (agent, task_type) cell before making a recommendation. */
const MIN_SAMPLE_SIZE = 5;

/** Default merge-rate target — the fraction of PRs we want to reliably pass at a given score. */
const DEFAULT_TARGET_MERGE_RATE = 0.80;

/** Diff threshold: only flag recommendations that move the threshold by more than this much. */
const THRESHOLD_ACTION_DIFF = 0.05;

/**
 * Bootstrap threshold for the calibration Phase 2 model (30 samples).
 * Confidence = min(1.0, sample_count / CALIBRATION_BOOTSTRAP_SAMPLES).
 * Recommendations at or above AUTO_APPLY_CONFIDENCE_THRESHOLD are auto-applied.
 */
const CALIBRATION_BOOTSTRAP_SAMPLES = 30;

/**
 * Confidence level at or above which a recommendation is auto-applied without
 * operator review (≥ 0.95 ≈ ≥28/30 samples).
 */
const AUTO_APPLY_CONFIDENCE_THRESHOLD = 0.95;

export interface RecordOutcomeOpts {
  taskId: string;
  agentName: string;
  taskType: TaskType;
  qualityScore: number;
  repo: string;
  prNumber: number;
  outcome: PROutcome;
}

export interface CalibrationReport {
  generated_at: string;
  rows: ScoreCalibrationRow[];
  thresholds: AdjustedThreshold[];
  target_merge_rate: number;
}

export class ScoreCalibrator {
  private log = createLogger("score-calibrator");

  constructor(
    private store: IScoreOutcomeStore,
    private recommendationStore?: ICalibrationRecommendationStore,
  ) {}

  /**
   * Record the eventual PR outcome for a verified task.
   *
   * Call this from the daemon when:
   * - A PR is merged (outcome = "merged")
   * - A PR receives change-request reviews (outcome = "changes_requested")
   * - A PR is closed without merge (outcome = "rejected")
   * - The task is re-dispatched after the PR failed (outcome = "redispatched")
   */
  recordOutcome(opts: RecordOutcomeOpts): void {
    try {
      this.store.recordPROutcome({
        task_id: opts.taskId,
        agent_name: opts.agentName,
        task_type: opts.taskType,
        quality_score: opts.qualityScore,
        score_bucket: Math.min(0.9, Math.floor(opts.qualityScore * 10) / 10),
        repo: opts.repo,
        pr_number: opts.prNumber,
        outcome: opts.outcome,
      });
      this.log.info("Recorded PR outcome", {
        task_id: opts.taskId,
        agent: opts.agentName,
        score: opts.qualityScore,
        outcome: opts.outcome,
      });
    } catch (err) {
      this.log.error("Failed to record PR outcome", {
        task_id: opts.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build the full calibration report: calibration table + threshold recommendations.
   *
   * Side-effect: persists `action_required` threshold entries to
   * `calibration_recommendations` (when a `recommendationStore` was supplied)
   * so the dashboard can surface them for operator review. A deduplication guard
   * prevents duplicate pending rows for the same `(agent_name, task_type)` pair.
   */
  buildReport(targetMergeRate = DEFAULT_TARGET_MERGE_RATE): CalibrationReport {
    const rows = this.store.getCalibrationData();
    const thresholds = this.store.getAdjustedThresholds(targetMergeRate);

    // Persist action-required recommendations (if store available)
    if (this.recommendationStore) {
      for (const t of thresholds) {
        if (!t.action_required || t.recommended_min_score === null) continue;

        const confidence = Math.min(1.0, t.sample_count / CALIBRATION_BOOTSTRAP_SAMPLES);
        const status: CalibrationRecommendationStatus =
          confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD ? "auto_applied" : "pending";

        try {
          this.recommendationStore.upsertCalibrationRecommendation({
            agent_name: t.agent_name,
            task_type: t.task_type,
            current_min_score: t.current_min_score,
            recommended_min_score: t.recommended_min_score,
            sample_count: t.sample_count,
            confidence,
            status,
          });
        } catch (err) {
          this.log.error("Failed to persist calibration recommendation", {
            agent: t.agent_name,
            task_type: t.task_type,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return {
      generated_at: new Date().toISOString(),
      rows,
      thresholds,
      target_merge_rate: targetMergeRate,
    };
  }

  /**
   * Mark all pending recommendations with confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD
   * as `auto_applied`.
   *
   * Called as a post-build sweep to handle recommendations that were inserted
   * as `pending` in an earlier cycle and have since accumulated sufficient
   * samples to cross the confidence threshold.
   *
   * @returns number of recommendations auto-applied in this sweep.
   */
  autoApplyHighConfidenceRecommendations(): number {
    if (!this.recommendationStore) return 0;

    const pending = this.recommendationStore.getCalibrationRecommendations("pending");
    let applied = 0;

    for (const rec of pending) {
      if (rec.confidence >= AUTO_APPLY_CONFIDENCE_THRESHOLD) {
        try {
          const updated = this.recommendationStore.resolveCalibrationRecommendation(
            rec.id,
            "auto_applied",
            `Auto-applied: confidence ${(rec.confidence * 100).toFixed(0)}% >= ${AUTO_APPLY_CONFIDENCE_THRESHOLD * 100}% threshold (${rec.sample_count} samples)`,
          );
          if (updated) applied++;
        } catch (err) {
          this.log.error("Failed to auto-apply calibration recommendation", {
            id: rec.id,
            agent: rec.agent_name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (applied > 0) {
      this.log.info("Auto-applied calibration recommendations", { count: applied });
    }
    return applied;
  }

  /**
   * Format the threshold adjustment section for supervisor context.
   *
   * Only surfaces agents where action_required is true — i.e., the recommended
   * threshold differs from the current one by more than 5 percentage points
   * with at least 5 outcome records as evidence.
   *
   * Returns an empty array when no action is needed (everything calibrated).
   *
   * Example output:
   *   [Calibration] Threshold adjustments recommended:
   *   - claude-agent-dashboard (implementation): raise 0.70 → 0.80 (12 samples, merge rate 82% at 0.8+)
   *   - codex-reviewer (implementation): raise 0.70 → 0.85 (8 samples, merge rate 80% at 0.85+)
   */
  formatThresholdSection(targetMergeRate = DEFAULT_TARGET_MERGE_RATE): string[] {
    const thresholds = this.store.getAdjustedThresholds(targetMergeRate);
    const actionable = thresholds.filter((t) => t.action_required);
    if (actionable.length === 0) return [];

    const lines: string[] = ["[Calibration] Threshold adjustments recommended:"];
    for (const t of actionable) {
      const dir =
        t.recommended_min_score !== null && t.recommended_min_score > t.current_min_score
          ? "raise"
          : "lower";
      const rec =
        t.recommended_min_score !== null ? t.recommended_min_score.toFixed(2) : "n/a";
      lines.push(
        `- ${t.agent_name} (${t.task_type}): ${dir} ${t.current_min_score.toFixed(2)} → ${rec}` +
        ` (${t.sample_count} samples)`,
      );
    }
    return lines;
  }

  /**
   * Format the full calibration page for Telegram /verification-calibration.
   *
   * Intended to be appended after the score distribution histogram produced
   * by CalibrationDriftMonitor.formatDistributionPage().
   *
   * Example:
   *   📐 *Score Calibration* (target merge rate: 80%)
   *
   *   *claude-agent-dashboard*
   *   implementation:
   *     0.6─0.7  12 outcomes · merge rate 50% ❌
   *     0.7─0.8  18 outcomes · merge rate 72% ⚠️
   *     0.8─0.9  24 outcomes · merge rate 88% ✅
   *     0.9─1.0   9 outcomes · merge rate 96% ✅
   *   Recommended threshold: 0.80 (currently 0.70) ⚠️ action required
   */
  formatCalibrationPage(report: CalibrationReport): string {
    const targetPct = `${Math.round(report.target_merge_rate * 100)}%`;
    const lines: string[] = [
      `📐 *Score Calibration* (target merge rate: ${targetPct})`,
      `_Generated: ${report.generated_at.replace("T", " ").slice(0, 19)}_`,
      ``,
    ];

    if (report.rows.length === 0) {
      lines.push(
        "No outcome records yet. Call `scoreCalibrator.recordOutcome()` when PRs are merged or rejected.",
      );
      return lines.join("\n").trimEnd();
    }

    // Group rows by agent + task_type
    type AgentTypeKey = string;
    const grouped = new Map<AgentTypeKey, ScoreCalibrationRow[]>();
    for (const row of report.rows) {
      const key: AgentTypeKey = `${row.agent_name}|${row.task_type}`;
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }

    // Build threshold lookup
    const thresholdMap = new Map<AgentTypeKey, AdjustedThreshold>();
    for (const t of report.thresholds) {
      thresholdMap.set(`${t.agent_name}|${t.task_type}`, t);
    }

    // Emit per-agent section
    let currentAgent = "";
    for (const [key, rows] of grouped) {
      const [agentName, taskType] = key.split("|") as [string, string];
      if (agentName !== currentAgent) {
        if (currentAgent !== "") lines.push(``);
        lines.push(`*${agentName}*`);
        currentAgent = agentName;
      }

      lines.push(`  _${taskType}:_`);
      const sorted = [...rows].sort((a, b) => a.score_bucket - b.score_bucket);
      for (const row of sorted) {
        const lo = row.score_bucket.toFixed(1);
        const hi = (row.score_bucket + 0.1).toFixed(1);
        const pct = `${Math.round(row.actual_merge_rate * 100)}%`;
        const icon =
          row.actual_merge_rate >= report.target_merge_rate
            ? "✅"
            : row.actual_merge_rate >= report.target_merge_rate - 0.1
            ? "⚠️"
            : "❌";
        lines.push(
          `    \`${lo}─${hi}\` ${String(row.total_count).padStart(3)} outcomes · merge rate ${pct} ${icon}`,
        );
      }

      const threshold = thresholdMap.get(key);
      if (threshold) {
        if (threshold.recommended_min_score !== null) {
          const rec = threshold.recommended_min_score.toFixed(2);
          const cur = threshold.current_min_score.toFixed(2);
          const actionTag = threshold.action_required ? " ⚠️ *action required*" : "";
          lines.push(`  → Recommended threshold: ${rec} (current: ${cur})${actionTag}`);
        } else if (threshold.sample_count < MIN_SAMPLE_SIZE) {
          lines.push(
            `  → Insufficient data (${threshold.sample_count}/${MIN_SAMPLE_SIZE} needed)`,
          );
        } else {
          lines.push(`  → No bucket achieves ${targetPct} merge rate — review verifier calibration`);
        }
      }
    }

    return lines.join("\n").trimEnd();
  }
}

// ── Formatting helpers ─────────────────────────────────────────────────────

/**
 * Infer whether a calibration sample suggests over-approval (scores inflate
 * without corresponding PR merge success).
 *
 * Used by the improvement detector to flag verifiers whose mid-range scores
 * (0.7-0.8) have a merge rate significantly below the target.
 */
export function detectOverApproval(
  rows: ScoreCalibrationRow[],
  targetMergeRate = DEFAULT_TARGET_MERGE_RATE,
): string[] {
  const issues: string[] = [];
  for (const row of rows) {
    // Flag buckets in the 0.6-0.8 range where merge rate is under target
    if (
      row.score_bucket >= 0.6 &&
      row.score_bucket < 0.8 &&
      row.total_count >= MIN_SAMPLE_SIZE &&
      row.actual_merge_rate < targetMergeRate - 0.15
    ) {
      const pct = `${Math.round(row.actual_merge_rate * 100)}%`;
      issues.push(
        `${row.agent_name} (${row.task_type}): score ${row.score_bucket.toFixed(1)}–${(row.score_bucket + 0.1).toFixed(1)} ` +
        `only merges ${pct} of the time (target ${Math.round(targetMergeRate * 100)}%)`,
      );
    }
  }
  return issues;
}

export const CALIBRATION_MIN_SAMPLE_SIZE = MIN_SAMPLE_SIZE;
export const CALIBRATION_TARGET_MERGE_RATE = DEFAULT_TARGET_MERGE_RATE;
export const CALIBRATION_THRESHOLD_ACTION_DIFF = THRESHOLD_ACTION_DIFF;
