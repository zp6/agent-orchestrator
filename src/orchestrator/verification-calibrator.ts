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
  // Get all verified tasks from the last 30 days
  const tasks = store.getRecentVerified(500, 0);
  if (tasks.length === 0) {
    return { buckets: [], recommendations: [], generatedAt: new Date().toISOString() };
  }

  // Group by verifier agent and score bucket
  const bucketMap = new Map<string, {
    taskCount: number;
    mergedCount: number;
    changesRequestedCount: number;
  }>();

  for (const task of tasks) {
    if (!task.quality_score || !task.agent_name) continue;

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

  log.info("Calibration report built", {
    totalTasks: tasks.length,
    buckets: buckets.length,
    recommendations: recommendations.length,
  });

  return { buckets, recommendations, generatedAt: new Date().toISOString() };
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
    for (const bucket of sorted) {
      const lowerBound = parseFloat(bucket.scoreRange.split("-")[0]);
      if (bucket.mergeRate >= 0.8) {
        suggestedThreshold = lowerBound;
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
      recommendations.push({
        verifierAgent: verifier,
        currentThreshold,
        suggestedThreshold,
        reason: `${direction} threshold: score range ${scoreToBucket(suggestedThreshold)} has ${(sorted.find((b) => b.scoreRange === scoreToBucket(suggestedThreshold))?.mergeRate ?? 0 * 100).toFixed(0)}% merge rate`,
      });
    } else if (belowThreshold.length > 0) {
      recommendations.push({
        verifierAgent: verifier,
        currentThreshold,
        suggestedThreshold: currentThreshold + 0.05,
        reason: `raise threshold: scores below ${currentThreshold} have <50% merge rate for this verifier`,
      });
    }
  }

  return recommendations;
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
      lines.push(`    ${r.verifierAgent}: ${r.currentThreshold} → ${r.suggestedThreshold} (${r.reason})`);
    }
  }

  return lines.join("\n");
}
