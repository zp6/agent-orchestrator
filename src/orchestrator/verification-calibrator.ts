/**
 * Verification calibration — track what happens after verification
 * and use the data to tune score thresholds per verifier agent.
 *
 * Compares verification scores against actual PR outcomes:
 *   - Verified approved + PR merged → score was accurate
 *   - Verified approved + PR got review changes → score was too generous
 *   - Verified rejected + task re-dispatched → check if rejection was valid
 *
 * Produces a calibration table: (verifier_agent, score_range) → actual_merge_rate
 */
import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("verification-calibrator");

export interface CalibrationBucket {
  verifierAgent: string;
  scoreRange: string; // e.g. "0.7-0.8"
  taskCount: number;
  mergedCount: number;
  changesRequestedCount: number;
  mergeRate: number; // 0-1
}

export interface CalibrationReport {
  buckets: CalibrationBucket[];
  recommendations: CalibrationRecommendation[];
  generatedAt: string;
}

export interface CalibrationRecommendation {
  verifierAgent: string;
  currentThreshold: number;
  suggestedThreshold: number;
  confidence: number;
  taskCount: number;
  mergeRate: number;
  changesRequestedCount: number;
  reason: string;
}

/**
 * Build calibration data by cross-referencing verified tasks with PR outcomes.
 *
 * For each verified-approved task:
 *   1. Find if a PR was created (via source_ref → PR lookup)
 *   2. Check if PR was merged, got changes requested, or was closed
 *   3. Bucket by verifier agent + score range
 */
export function buildCalibrationReport(
  store: StateStore,
  minScoreThreshold = 0.7,
): CalibrationReport {
  const generatedAt = new Date().toISOString();

  // Get all verified tasks from the last 30 days
  const tasks = store.getRecentVerified(500, 0);
  if (tasks.length === 0) {
    return { buckets: [], recommendations: [], generatedAt };
  }

  // Group by verifier agent and score bucket
  const bucketMap = new Map<string, {
    taskCount: number;
    mergedCount: number;
    changesRequestedCount: number;
  }>();

  for (const task of tasks) {
    if (task.quality_score === null || !task.agent_name) continue;

    const score = task.quality_score;
    const bucket = scoreToBucket(score);
    // Use the agent that did the verification (from verification_notes or agent_name)
    const verifier = task.agent_name;
    const key = `${verifier}|${bucket}`;

    const entry = bucketMap.get(key) ?? { taskCount: 0, mergedCount: 0, changesRequestedCount: 0 };
    entry.taskCount++;

    // Check outcome: did the task lead to a successful result?
    // A "successful" verification = task done + no subsequent revision needed
    const revisionCount = task.revision_count ?? 0;
    if (task.status === "done" && task.verification_status === "approved" && revisionCount === 0) {
      entry.mergedCount++; // clean pass — no revisions needed
    } else if (revisionCount > 0) {
      entry.changesRequestedCount++; // needed revision = score was too generous
    }

    bucketMap.set(key, entry);
  }

  // Build buckets
  const buckets: CalibrationBucket[] = [];
  for (const [key, data] of bucketMap) {
    const [verifierAgent, scoreRange] = key.split("|");
    const mergeRate = data.taskCount > 0
      ? data.mergedCount / data.taskCount
      : 0;
    buckets.push({
      verifierAgent,
      scoreRange,
      taskCount: data.taskCount,
      mergedCount: data.mergedCount,
      changesRequestedCount: data.changesRequestedCount,
      mergeRate,
    });
  }

  // Sort by verifier then score range
  buckets.sort((a, b) => a.verifierAgent.localeCompare(b.verifierAgent) || a.scoreRange.localeCompare(b.scoreRange));

  // Generate recommendations
  const recommendations = generateRecommendations(buckets, minScoreThreshold);

  // Persist recommendations so they can be reviewed and, when confidence is
  // high enough, feed back into the daemon's threshold checks.
  try {
    const result = store.recordVerificationCalibrationRecommendations(recommendations, generatedAt);
    if (result.persisted > 0) {
      log.info("Calibration recommendations persisted", {
        persisted: result.persisted,
        autoApplied: result.autoApplied,
      });
    }
  } catch (err) {
    log.warn("Failed to persist calibration recommendations", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("Calibration report built", {
    totalTasks: tasks.length,
    buckets: buckets.length,
    recommendations: recommendations.length,
  });

  return { buckets, recommendations, generatedAt };
}

function scoreToBucket(score: number): string {
  if (score < 0.5) return "0.0-0.5";
  if (score < 0.6) return "0.5-0.6";
  if (score < 0.7) return "0.6-0.7";
  if (score < 0.8) return "0.7-0.8";
  if (score < 0.9) return "0.8-0.9";
  return "0.9-1.0";
}

function generateRecommendations(
  buckets: CalibrationBucket[],
  currentThreshold: number,
): CalibrationRecommendation[] {
  const recommendations: CalibrationRecommendation[] = [];

  // Group by verifier
  const byVerifier = new Map<string, CalibrationBucket[]>();
  for (const b of buckets) {
    const existing = byVerifier.get(b.verifierAgent) ?? [];
    existing.push(b);
    byVerifier.set(b.verifierAgent, existing);
  }

  for (const [verifier, verifierBuckets] of byVerifier) {
    // Find the lowest score range where merge rate >= 80%
    const sorted = [...verifierBuckets]
      .filter((b) => b.taskCount >= 3) // need enough data
      .sort((a, b) => a.scoreRange.localeCompare(b.scoreRange));

    let suggestedThreshold = currentThreshold;
    let selectedBucket: CalibrationBucket | undefined;
    for (const bucket of sorted) {
      const lowerBound = parseFloat(bucket.scoreRange.split("-")[0]);
      if (bucket.mergeRate >= 0.8) {
        suggestedThreshold = lowerBound;
        selectedBucket = bucket;
        break;
      }
    }

    // Check if threshold below current has bad merge rate
    const belowThreshold = sorted.filter((b) => {
      const lower = parseFloat(b.scoreRange.split("-")[0]);
      return lower < currentThreshold && b.mergeRate < 0.5;
    });

    if (suggestedThreshold !== currentThreshold) {
      const direction = suggestedThreshold < currentThreshold ? "lower" : "raise";
      const supportingTasks = sorted.reduce((sum, bucket) => sum + bucket.taskCount, 0);
      const selectedMergeRate = selectedBucket?.mergeRate ?? 0;
      const confidence = computeRecommendationConfidence(supportingTasks, selectedBucket ?? null, currentThreshold, suggestedThreshold);
      const matchBucket = scoreToBucket(suggestedThreshold);
      const matchRate = sorted.find((b) => b.scoreRange === matchBucket)?.mergeRate ?? 0;
      recommendations.push({
        verifierAgent: verifier,
        currentThreshold,
        suggestedThreshold,
        confidence,
        taskCount: supportingTasks,
        mergeRate: selectedMergeRate,
        changesRequestedCount: sorted.reduce((sum, bucket) => sum + bucket.changesRequestedCount, 0),
        reason: `${direction} threshold: score range ${matchBucket} has ${(matchRate * 100).toFixed(0)}% merge rate`,
      });
    } else if (belowThreshold.length > 0) {
      const supportingTasks = sorted.reduce((sum, bucket) => sum + bucket.taskCount, 0);
      const suggestedThreshold = Math.min(0.95, currentThreshold + 0.05);
      recommendations.push({
        verifierAgent: verifier,
        currentThreshold,
        suggestedThreshold,
        confidence: computeRecommendationConfidence(supportingTasks, null, currentThreshold, suggestedThreshold),
        taskCount: supportingTasks,
        mergeRate: belowThreshold[0]?.mergeRate ?? 0,
        changesRequestedCount: sorted.reduce((sum, bucket) => sum + bucket.changesRequestedCount, 0),
        reason: `raise threshold: scores below ${currentThreshold} have <50% merge rate for this verifier`,
      });
    }
  }

  return recommendations;
}

function computeRecommendationConfidence(
  taskCount: number,
  bucket: CalibrationBucket | null,
  currentThreshold: number,
  suggestedThreshold: number,
): number {
  const supportScore = Math.min(1, taskCount / 20);
  const mergeSignal = bucket ? Math.min(1, Math.abs(bucket.mergeRate - 0.8) / 0.2) : 0;
  const stepSize = Math.min(1, Math.abs(suggestedThreshold - currentThreshold) / 0.1);
  const raw = 0.35 + supportScore * 0.4 + mergeSignal * 0.2 + stepSize * 0.05;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}

/**
 * Format calibration report for Telegram display.
 */
export function formatCalibrationForTelegram(report: CalibrationReport): string {
  if (report.buckets.length === 0) return "No calibration data yet.";

  const lines: string[] = ["*Verification Calibration*"];

  // Group by verifier
  const byVerifier = new Map<string, CalibrationBucket[]>();
  for (const b of report.buckets) {
    const existing = byVerifier.get(b.verifierAgent) ?? [];
    existing.push(b);
    byVerifier.set(b.verifierAgent, existing);
  }

  for (const [verifier, buckets] of byVerifier) {
    const name = verifier.replace("claude-", "").replace("codex-", "⚡");
    lines.push(`  *${name}*`);
    for (const b of buckets) {
      const bar = "█".repeat(Math.round(b.mergeRate * 5)) + "░".repeat(5 - Math.round(b.mergeRate * 5));
      lines.push(`    ${b.scoreRange}: ${bar} ${Math.round(b.mergeRate * 100)}% merge (n=${b.taskCount})`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push("  *Recommendations:*");
    for (const r of report.recommendations) {
      lines.push(`    ${r.verifierAgent}: ${r.currentThreshold} → ${r.suggestedThreshold} (${Math.round(r.confidence * 100)}% confidence, ${r.reason})`);
    }
  }

  return lines.join("\n");
}
