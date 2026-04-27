/**
 * Quality-floor bypass detector (issue #367).
 *
 * Fires a Telegram alert whenever a task reaches verification='approved'
 * with quality_score < 0.80 and no explicit bypass_reason in the audit trail.
 *
 * The threshold (0.80) is deliberately higher than the hard floor (0.60) so
 * that the detection catches "soft bypass" approvals — cases where the system
 * didn't hard-block but the score is still concerning.
 *
 * Usage:
 *
 *   import { QualityFloorBypassDetector } from './quality-floor-bypass-detector.js';
 *
 *   const detector = new QualityFloorBypassDetector(notifier, {
 *     threshold: 0.80,
 *     dashboardBaseUrl: 'https://dashboard.example.com',
 *   });
 *
 *   // Call after each task verification that results in an approval
 *   const alerted = await detector.checkAndAlert(verificationResult, task);
 */

import type { Notifier } from "../notify.js";
import type { VerificationResult } from "./verifier.js";
import type { Task } from "../state/types.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("quality-floor-bypass-detector");

/** Default quality floor threshold — approvals below this trigger an alert. */
export const QUALITY_FLOOR_THRESHOLD = 0.80;

export interface BypassDetectorConfig {
  /** Score floor (exclusive upper bound). Default: 0.80 */
  threshold?: number;
  /** Minimum ms between re-alerts for the same task. Default: 2 * 60 * 1000 (2 min) */
  cooldownMs?: number;
  /** Base URL for audit trail links (e.g. "https://dashboard.example.com"). */
  dashboardBaseUrl?: string;
}

/**
 * Detects and alerts on quality floor bypasses.
 *
 * A bypass is defined as: a task approved with quality_score < threshold (0.80)
 * that does NOT have bypass_reason === 'operator_override' in the audit trail.
 *
 * The 'floor_not_enforced' bypass_reason is intentionally NOT treated as an
 * explicit override — it marks historical gaps and should still trigger the alert
 * so operators are aware of the audit gap.
 */
export class QualityFloorBypassDetector {
  private readonly alertedTaskIds = new Set<string>();
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly dashboardBaseUrl: string;

  constructor(
    private readonly notifier: Notifier,
    config: BypassDetectorConfig = {},
  ) {
    this.threshold = config.threshold ?? QUALITY_FLOOR_THRESHOLD;
    this.cooldownMs = config.cooldownMs ?? 2 * 60 * 1000;
    this.dashboardBaseUrl = config.dashboardBaseUrl ?? "";
  }

  /**
   * Check a just-approved verification result and alert if it bypasses the quality floor.
   *
   * @param result  The verification result containing the score and decision.
   * @param task    The full task record (for bypass_reason, agent name, etc.).
   * @returns       true if an alert was sent; false if skipped (not a bypass, deduplicated, or notifier unconfigured).
   */
  async checkAndAlert(result: VerificationResult, task: Task): Promise<boolean> {
    // Only alert on approved tasks
    if (!result.approved) return false;

    // Resolve the score: prefer result.score, fall back to task.quality_score
    const score = result.score ?? task.quality_score ?? null;
    if (score === null || score >= this.threshold) return false;

    // Only bypass_reason === 'operator_override' is treated as an explicit bypass.
    // 'floor_not_enforced' is an audit-gap marker, not a legitimate override.
    const hasExplicitBypass = task.bypass_reason === "operator_override";
    if (hasExplicitBypass) return false;

    // Deduplicate: don't re-alert for the same task within the cooldown window.
    if (this.alertedTaskIds.has(task.id)) return false;
    this.alertedTaskIds.add(task.id);

    if (!this.notifier.isConfigured()) {
      log.warn("Notifier not configured — skipping quality floor bypass alert", {
        task_id: task.id.slice(0, 8),
        score,
      });
      return false;
    }

    const auditLink = this.dashboardBaseUrl
      ? `${this.dashboardBaseUrl}/api/tasks/${task.id}/audit`
      : null;

    const bypassNote = task.bypass_reason
      ? `bypass_reason: \`${task.bypass_reason}\``
      : "NO AUDIT ENTRY FOUND";

    const approvingAgent =
      (result as unknown as { reviewer?: string }).reviewer ??
      task.agent_name ??
      "unknown";

    const auditSection = auditLink ? `Audit: ${auditLink}\n` : "";

    const message =
      `⚠️ *Quality Floor Bypass Detected*\n\n` +
      `Task: \`${task.id}\`\n` +
      `Score: ${(score * 100).toFixed(1)}% (floor: ${(this.threshold * 100).toFixed(0)}%)\n` +
      `Approved by: ${approvingAgent}\n` +
      `Audit: ${bypassNote}\n` +
      auditSection +
      `\nTo acknowledge:\n` +
      `/override confirm ${task.id} <reason>`;

    try {
      await this.notifier.notifyOperator("Quality Floor Bypass", message, "high");
      log.info("Quality floor bypass alert sent", {
        task_id: task.id.slice(0, 8),
        score,
        bypass_reason: task.bypass_reason ?? null,
      });
    } catch (err) {
      // Remove from dedup set so a retry is possible if the alert failed to send
      this.alertedTaskIds.delete(task.id);
      log.error("Failed to send quality floor bypass alert", {
        task_id: task.id.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    return true;
  }
}
