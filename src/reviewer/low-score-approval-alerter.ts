/**
 * Low-score approval real-time alerter — sends Telegram notifications when
 * tasks are approved with quality score < 0.70.
 *
 * Operators receive immediate structured alerts with:
 *   - Task title and ID
 *   - Quality score (prominently flagged if critical)
 *   - Per-dimension breakdown (if available from verification notes)
 *   - Approval rationale (marginal_approval reason or operator override reason)
 *   - Task type and agent name
 *   - Clickable links to task and PR (if available)
 *
 * Issue #331: High-severity real-time notification requirement.
 * Threshold: score < 0.70 (configurable, defaults to 0.70)
 * Latency goal: Alert sent within 60 seconds of approval
 *
 * Usage:
 *
 *   import { LowScoreApprovalAlerter } from 'claude-orchestrator-reviewer';
 *
 *   const alerter = new LowScoreApprovalAlerter(store, notifier, {
 *     scoreThreshold: 0.70,  // tasks approved below this score trigger alerts
 *   });
 *
 *   // Call after each task verification
 *   await alerter.checkAndAlert(verificationResult, task);
 */

import type { Notifier } from "../notify.js";
import type { VerificationResult, QualityDimensions } from "./verifier.js";
import type { Task } from "../state/types.js";
import { extractPrUrl } from "../telegram/command-handler.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("low-score-approval-alerter");

/** Threshold below which an approved task triggers a real-time Telegram alert. */
export const LOW_SCORE_APPROVAL_ALERT_THRESHOLD = 0.70;

export interface LowScoreApprovalAlerterOptions {
  /**
   * Score threshold for triggering alerts.
   * Default: 0.70 (LOW_SCORE_APPROVAL_ALERT_THRESHOLD)
   */
  scoreThreshold?: number;
}

/**
 * Real-time alerter for low-score approvals.
 * Sends Telegram notifications when a task is approved with quality_score < threshold.
 */
export class LowScoreApprovalAlerter {
  private scoreThreshold: number;

  constructor(
    private notifier: Notifier | undefined,
    opts: LowScoreApprovalAlerterOptions = {},
  ) {
    this.scoreThreshold = opts.scoreThreshold ?? LOW_SCORE_APPROVAL_ALERT_THRESHOLD;
  }

  /**
   * Check a verification result and alert if it's a low-score approval.
   *
   * @param result    The VerificationResult from task verification.
   * @param task      The Task record (needed for title, agent, repo context).
   */
  async checkAndAlert(result: VerificationResult, task: Task): Promise<void> {
    // Only alert if approved and below threshold
    if (!result.approved || !result.score || result.score >= this.scoreThreshold) {
      return;
    }

    if (!this.notifier || !this.notifier.isConfigured()) {
      log.warn("Notifier not configured — skipping low-score approval alert", {
        task_id: task.id,
        score: result.score,
      });
      return;
    }

    try {
      const message = this.formatAlertMessage(result, task);
      await this.notifier.send(message);
      log.info("Low-score approval alert sent", {
        task_id: task.id.slice(0, 8),
        score: result.score,
      });
    } catch (err) {
      log.error("Failed to send low-score approval alert", {
        task_id: task.id.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Format a low-score approval alert message for Telegram.
   * Includes task details, score, dimensions, and bypass reason.
   */
  private formatAlertMessage(result: VerificationResult, task: Task): string {
    const isCritical = result.score < 0.60;
    const scoreEmoji = isCritical ? "🔴" : "🟡";
    const taskTitle = task.title ? task.title.slice(0, 100) : `Task ${task.id.slice(0, 8)}`;

    // Build dimension breakdown from VerificationResult.dimensions
    const dimensionText = this.formatDimensions(result.dimensions);

    // Build approval rationale (use marginalReason if available, or approvalRationale)
    const rationale = result.marginalReason || result.approvalRationale || "";
    const rationaleText = rationale ? `\n_Reason:_ ${rationale.slice(0, 150)}` : "";

    // Build PR/task link section
    const prUrl = extractPrUrl(task);
    const links = [];
    if (prUrl) links.push(`[PR](${prUrl})`);
    links.push(`[Task](/tasks/${task.id})`);
    const linksText = links.length > 0 ? `\n\n${links.join(" • ")}` : "";

    // Build the full alert
    const lines = [
      `${scoreEmoji} *Low-Score Approval*`,
      ``,
      `*Task:* ${taskTitle}`,
      `*Score:* ${(result.score * 100).toFixed(0)}% ${isCritical ? "⚠️ CRITICAL" : ""}`,
      `*Agent:* ${task.agent_name || "unassigned"}`,
      `*Type:* ${task.task_type || "unknown"}`,
    ];

    if (dimensionText) {
      lines.push(`*Dimensions:*`);
      lines.push(dimensionText);
    }

    if (rationaleText) {
      lines.push(rationaleText);
    }

    lines.push(linksText);

    return lines.join("\n");
  }

  /**
   * Format per-dimension scores as a readable text block.
   */
  private formatDimensions(dimensions: QualityDimensions | undefined): string {
    if (!dimensions || Object.keys(dimensions).length === 0) {
      return "_(no dimension data)_";
    }

    // Map dimension names to readable labels
    const labels: Record<string, string> = {
      correctness: "Correctness",
      completeness: "Completeness",
      test_coverage: "Test Coverage",
      code_quality: "Code Quality",
    };

    return Object.entries(dimensions)
      .map(([key, value]) => {
        const label = labels[key] || key;
        const pct = typeof value === "number" ? (value * 100).toFixed(0) : "N/A";
        return `  • ${label}: ${pct}%`;
      })
      .join("\n");
  }
}

