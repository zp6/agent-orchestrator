/**
 * Verifier threshold auto-adjuster — Phase 2 of verification calibration.
 *
 * Implements the recommendations from findings/verification-calibration.md §4 and §5:
 *
 *   §4  recommendedMinScore(): find the lowest score bucket whose empirical
 *       merge_rate ≥ 0.85 with ≥ 30 samples and use it as the new threshold.
 *
 *   §4  adjustThreshold(): apply the recommendation with a ±0.05-per-cycle cap
 *       and persist the new threshold alongside a full audit justification.
 *
 *   §5  checkLowMergeRateAlerts(): emit a Telegram warning (medium urgency)
 *       when merge_rate < 0.70 persists for 2+ consecutive adjustment cycles.
 *
 * Phase 2 gating (per the research report Bootstrap note):
 *   No adjustment fires until a bucket has ≥ MIN_SAMPLES_FOR_ADJUSTMENT (30)
 *   outcome records.  This prevents premature movement on sparse data collected
 *   during the Phase 1 warm-up period.
 *
 * Usage (from the daemon or a scheduled job):
 *
 *   const adjuster = new ThresholdAdjuster(store, notifier);
 *
 *   // Once per daemon cycle (after score-calibrator outcome recording):
 *   const results = await adjuster.runAdjustmentCycle();
 *
 *   // Or for a specific verifier:
 *   const rec = adjuster.recommendedMinScore("claude-orchestrator-reviewer", "implementation");
 *   const result = adjuster.adjustThreshold("claude-orchestrator-reviewer", "implementation");
 */

import type { IThresholdAdjustmentStore, TaskType, ScoreCalibrationRow } from "../state/types.js";
import type { Notifier } from "../notify.js";
import { createLogger } from "../service/logger.js";

// ── Constants (§4 and §5 of verification-calibration.md) ──────────────────

/** Target merge rate for threshold recommendations (§4). */
const TARGET_MERGE_RATE = 0.85;

/**
 * Minimum sample count per (verifier, task_type, score_bucket) cell before
 * auto-adjustment is applied (§4, Bootstrap note).  Mirrors the 30-sample
 * threshold specified in the research report.
 */
const MIN_SAMPLES_FOR_ADJUSTMENT = 30;

/** Maximum threshold shift allowed in a single cycle (§4 conservative adjustment). */
const MAX_DELTA_PER_CYCLE = 0.05;

/** Merge rate below which a bucket is considered "unhealthy" (§5). */
const LOW_MERGE_RATE_ALERT_THRESHOLD = 0.70;

/** Number of consecutive bad cycles before a Telegram alert fires (§5). */
const CONSECUTIVE_BAD_CYCLES_ALERT = 2;

/**
 * Default approval threshold applied when no persisted threshold exists for
 * a (verifier, task_type) pair.  Matches APPROVAL_THRESHOLD in verifier.ts.
 */
const DEFAULT_THRESHOLD = 0.80;

// ── Public types ───────────────────────────────────────────────────────────

export interface ThresholdAdjustmentResult {
  verifier_id: string;
  task_type: TaskType;
  /** Threshold value before this cycle's adjustment. */
  previous_threshold: number;
  /** Threshold value after this cycle's adjustment (may equal previous if no change). */
  new_threshold: number;
  /**
   * Signed delta actually applied this cycle (clamped to ±MAX_DELTA_PER_CYCLE).
   * 0.0 when the threshold was already at the recommended value.
   */
  delta: number;
  /** Full audit justification — includes bucket, merge_rate, n, raw delta, clamped delta. */
  justification: string;
  /** True when new_threshold ≠ previous_threshold (i.e. the DB was actually updated). */
  adjusted: boolean;
}

// ── ThresholdAdjuster ──────────────────────────────────────────────────────

export class ThresholdAdjuster {
  private log = createLogger("threshold-adjuster");

  constructor(
    private store: IThresholdAdjustmentStore,
    private notifier?: Notifier,
  ) {}

  /**
   * Find the lowest score bucket for (verifierId, taskType) whose empirical
   * merge_rate ≥ TARGET_MERGE_RATE (0.85) and total_count ≥ MIN_SAMPLES_FOR_ADJUSTMENT (30).
   *
   * Returns null when:
   * - No calibration data exists for this pair.
   * - No bucket satisfies both the merge-rate AND sample-count constraints.
   *
   * Scanning ascending ensures we pick the most permissive (lowest) threshold
   * that still achieves the target — minimising unnecessary rejections while
   * keeping the quality gate calibrated.
   */
  recommendedMinScore(verifierId: string, taskType: TaskType): number | null {
    const rows = this.store
      .getCalibrationTable()
      .filter((r) => r.agent_name === verifierId && r.task_type === taskType)
      .sort((a, b) => a.score_bucket - b.score_bucket);

    for (const row of rows) {
      if (
        row.total_count >= MIN_SAMPLES_FOR_ADJUSTMENT &&
        row.actual_merge_rate >= TARGET_MERGE_RATE
      ) {
        return row.score_bucket;
      }
    }
    return null;
  }

  /**
   * Run one threshold adjustment for a specific (verifier, taskType) pair.
   *
   * Algorithm:
   *  1. Compute `recommended = recommendedMinScore(verifierId, taskType)`.
   *  2. If null → skip (insufficient calibration data); return null.
   *  3. Compute `rawDelta = recommended − currentThreshold`.
   *  4. Clamp delta to [−0.05, +0.05].
   *  5. If `newThreshold ≠ currentThreshold` → persist and log.
   *
   * Every non-null call returns a result with full justification — whether or
   * not the threshold actually changed — so callers can surface the reasoning.
   *
   * @returns ThresholdAdjustmentResult, or null if skipped (insufficient data).
   */
  adjustThreshold(verifierId: string, taskType: TaskType): ThresholdAdjustmentResult | null {
    const recommended = this.recommendedMinScore(verifierId, taskType);

    if (recommended === null) {
      this.log.info("Skipping threshold adjustment — insufficient calibration data", {
        verifier: verifierId,
        task_type: taskType,
        required_samples: MIN_SAMPLES_FOR_ADJUSTMENT,
        required_merge_rate: TARGET_MERGE_RATE,
      });
      return null;
    }

    const persisted = this.store.getVerifierThreshold(verifierId, taskType);
    const currentThreshold = persisted?.threshold ?? DEFAULT_THRESHOLD;

    // Clamp the delta
    const rawDelta = recommended - currentThreshold;
    const clampedDelta =
      Math.max(-MAX_DELTA_PER_CYCLE, Math.min(MAX_DELTA_PER_CYCLE, rawDelta));
    // Round to two decimal places to avoid floating-point drift
    const newThreshold = Math.round((currentThreshold + clampedDelta) * 100) / 100;

    // Build an auditable justification referencing the qualifying calibration row
    const rows = this.store.getCalibrationTable();
    const justifyingRow: ScoreCalibrationRow | undefined = rows.find(
      (r) =>
        r.agent_name === verifierId &&
        r.task_type === taskType &&
        r.score_bucket === recommended &&
        r.total_count >= MIN_SAMPLES_FOR_ADJUSTMENT &&
        r.actual_merge_rate >= TARGET_MERGE_RATE,
    );

    const sign = (n: number) => (n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2));
    const justification = justifyingRow
      ? `Calibration row: bucket=${justifyingRow.score_bucket.toFixed(1)}-${(justifyingRow.score_bucket + 0.1).toFixed(1)}, ` +
        `merge_rate=${(justifyingRow.actual_merge_rate * 100).toFixed(1)}% ` +
        `(target≥${TARGET_MERGE_RATE * 100}%), ` +
        `n=${justifyingRow.total_count} (min=${MIN_SAMPLES_FOR_ADJUSTMENT}). ` +
        `Recommended=${recommended.toFixed(2)}, ` +
        `rawDelta=${sign(rawDelta)}, clampedDelta=${sign(clampedDelta)}.`
      : `Recommended=${recommended.toFixed(2)}, clampedDelta=${sign(clampedDelta)}.`;

    const adjusted = newThreshold !== currentThreshold;

    if (adjusted) {
      this.store.setVerifierThreshold(verifierId, taskType, newThreshold, justification);
      this.log.info("Threshold adjusted", {
        verifier: verifierId,
        task_type: taskType,
        previous: currentThreshold,
        new: newThreshold,
        delta: clampedDelta,
      });
    } else {
      this.log.info("Threshold unchanged (already at recommended value)", {
        verifier: verifierId,
        task_type: taskType,
        threshold: currentThreshold,
        recommended,
      });
    }

    return {
      verifier_id: verifierId,
      task_type: taskType,
      previous_threshold: currentThreshold,
      new_threshold: newThreshold,
      delta: clampedDelta,
      justification,
      adjusted,
    };
  }

  /**
   * Check every calibrated (verifier, taskType, bucket) triplet for a
   * "low merge rate" condition and emit a Telegram alert when the condition
   * persists for ≥ CONSECUTIVE_BAD_CYCLES_ALERT (2) consecutive cycles.
   *
   * A bucket must have ≥ 3 outcome records before it is considered.
   * When a bucket recovers above the LOW_MERGE_RATE_ALERT_THRESHOLD (0.70)
   * its consecutive-bad-cycle counter is reset to 0.
   */
  async checkLowMergeRateAlerts(verifierId: string, taskType: TaskType): Promise<void> {
    const rows = this.store
      .getCalibrationTable()
      .filter((r) => r.agent_name === verifierId && r.task_type === taskType);

    const alertStates = this.store.getVerifierAlertStates(verifierId);

    for (const row of rows) {
      // Only alert on buckets with meaningful data
      if (row.total_count < 3) continue;

      const isBad = row.actual_merge_rate < LOW_MERGE_RATE_ALERT_THRESHOLD;
      const state = alertStates.find(
        (s) => s.task_type === taskType && s.score_bucket === row.score_bucket,
      );
      const previousBadCycles = state?.consecutive_bad_cycles ?? 0;
      const newBadCycles = isBad ? previousBadCycles + 1 : 0;

      this.store.upsertVerifierAlertState({
        verifier_id: verifierId,
        task_type: taskType,
        score_bucket: row.score_bucket,
        consecutive_bad_cycles: newBadCycles,
      });

      if (isBad && newBadCycles >= CONSECUTIVE_BAD_CYCLES_ALERT && this.notifier) {
        const lo = row.score_bucket.toFixed(1);
        const hi = (row.score_bucket + 0.1).toFixed(1);
        const bucket = `${lo}-${hi}`;
        const mergePct = (row.actual_merge_rate * 100).toFixed(1);

        // NOISE SUPPRESSION (#564): Threshold monitoring is operational.
        // Operator should query /threshold-metrics or /verifier-health if interested; no push notifications.
        this.log.warn("Low merge rate detected (not sending to Telegram per #564)", {
          verifierId,
          taskType,
          bucket: `${lo}-${hi}`,
          mergePct,
          message: `score bucket ${bucket} has merge rate ${mergePct}%, ` +
            `below the ${LOW_MERGE_RATE_ALERT_THRESHOLD * 100}% floor ` +
            `for ${newBadCycles} consecutive calibration cycles (n=${row.total_count})`,
        });

        this.log.warn("Low merge rate alert fired", {
          verifier: verifierId,
          task_type: taskType,
          bucket,
          merge_rate: row.actual_merge_rate,
          consecutive_bad_cycles: newBadCycles,
        });
      }
    }
  }

  /**
   * Run a complete adjustment cycle across all (verifier, taskType) pairs
   * present in the calibration table.
   *
   * For each pair:
   *  1. `adjustThreshold()` — recommend + apply threshold change (capped ±0.05)
   *  2. `checkLowMergeRateAlerts()` — fire Telegram alert if merge_rate < 0.70 × 2+ cycles
   *
   * @returns All non-null adjustment results (one per pair that had sufficient data).
   */
  async runAdjustmentCycle(): Promise<ThresholdAdjustmentResult[]> {
    const rows = this.store.getCalibrationTable();

    // Deduplicate (verifier_id, task_type) pairs from the calibration table
    const pairs = new Map<string, { verifierId: string; taskType: TaskType }>();
    for (const row of rows) {
      const key = `${row.agent_name}|${row.task_type}`;
      if (!pairs.has(key)) {
        pairs.set(key, { verifierId: row.agent_name, taskType: row.task_type as TaskType });
      }
    }

    const results: ThresholdAdjustmentResult[] = [];

    for (const { verifierId, taskType } of pairs.values()) {
      const result = this.adjustThreshold(verifierId, taskType);
      if (result !== null) results.push(result);
      await this.checkLowMergeRateAlerts(verifierId, taskType);
    }

    this.log.info("Adjustment cycle complete", {
      pairs_evaluated: pairs.size,
      adjustments_made: results.filter((r) => r.adjusted).length,
    });

    return results;
  }
}

// ── Exported constants (for tests and documentation) ──────────────────────

export const THRESHOLD_ADJUSTER_TARGET_MERGE_RATE = TARGET_MERGE_RATE;
export const THRESHOLD_ADJUSTER_MIN_SAMPLES = MIN_SAMPLES_FOR_ADJUSTMENT;
export const THRESHOLD_ADJUSTER_MAX_DELTA = MAX_DELTA_PER_CYCLE;
export const THRESHOLD_ADJUSTER_LOW_MERGE_RATE = LOW_MERGE_RATE_ALERT_THRESHOLD;
export const THRESHOLD_ADJUSTER_CONSECUTIVE_BAD_CYCLES = CONSECUTIVE_BAD_CYCLES_ALERT;
