/**
 * Score-zero approval alerter — issue #375.
 *
 * Fires a real-time Telegram alert whenever a task with quality_score ≤ 0.05
 * is approved, regardless of the bypass path (hard-floor bypass, proposal routing,
 * scoring failure, operator override, etc.).
 *
 * A score this low indicates catastrophic failure — the work is functionally absent
 * or completely wrong — and operators must know immediately. Unlike the general
 * low-score alerter (threshold 0.70) this alert fires on every code path that
 * produces an approved result with score ≤ 0.05.
 *
 * **Suppression**: tasks whose `approvalRationale` begins with `short_circuit_` (e.g.
 * `short_circuit_no_action_needed`) are excluded. These are 'already-in-review' and
 * equivalent short-circuit exits that legitimately receive a score of 1.0 through a
 * different verification path; a 0 appearing there would be an instrumentation bug,
 * not an actual quality failure.
 *
 * Acceptance criteria (issue #375):
 *  1. Alert fires within one daemon cycle of the approval.
 *  2. Message includes: score, agent, task title, and bypass path.
 *  3. Alert is suppressed for short-circuit exits (e.g. 'already-in-review').
 *
 * Usage:
 *
 *   import { ScoreZeroApprovalAlerter } from 'claude-orchestrator-reviewer';
 *
 *   const alerter = new ScoreZeroApprovalAlerter(notifier);
 *
 *   // Call after each verification that results in an approved result:
 *   await alerter.checkAndAlert(verificationResult, task);
 */

import type { Notifier } from "../notify.js";
import type { VerificationResult, QualityDimensions } from "./verifier.js";
import type { Task } from "../state/types.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("score-zero-alert");

/**
 * Upper bound (inclusive) for triggering the score-zero alert.
 * Tasks approved with score ≤ this value receive a Telegram notification.
 * Expressed as a fraction (0.05 = 5%).
 */
export const SCORE_ZERO_ALERT_THRESHOLD = 0.05;

export interface ScoreZeroAlertOptions {
  /**
   * Override the score threshold (default: SCORE_ZERO_ALERT_THRESHOLD = 0.05).
   * Only raise this in tests; in production 0.05 is the right boundary.
   */
  scoreThreshold?: number;
}

/**
 * Real-time alerter that fires whenever a task is approved with score ≤ 0.05.
 *
 * Score-zero (or near-zero) approvals represent catastrophic quality failures —
 * the verifier approved work that scored at or near the theoretical minimum.
 * This is distinct from the general `LowScoreApprovalAlerter` (threshold 0.70)
 * and the `QualityFloorBypassDetector` (threshold 0.80, filters on bypass_reason).
 * The score-zero alert fires unconditionally on any bypass path.
 */
export class ScoreZeroApprovalAlerter {
  private readonly scoreThreshold: number;
  /** Per-task deduplication set — prevents multiple alerts for the same task ID. */
  private readonly alertedTaskIds = new Set<string>();

  constructor(
    private readonly notifier: Notifier | undefined,
    opts: ScoreZeroAlertOptions = {},
  ) {
    this.scoreThreshold = opts.scoreThreshold ?? SCORE_ZERO_ALERT_THRESHOLD;
  }

  /**
   * Check a verification result and send a Telegram alert if the score is ≤ 0.05
   * and the task was approved.
   *
   * @param result  The VerificationResult returned by the verifier.
   * @param task    The full Task record (for title, agent, bypass_reason, etc.).
   * @returns       `true` when an alert was sent, `false` when skipped.
   */
  async checkAndAlert(result: VerificationResult, task: Task): Promise<boolean> {
    // Only alert on approved tasks.
    if (!result.approved) return false;

    // Resolve score: `result.score` may be 0 (falsy but valid), so check for null/undefined explicitly.
    const score = result.score ?? null;
    if (score === null || score > this.scoreThreshold) return false;

    // Suppress short-circuit exits ('already-in-review', zero-action standups, etc.)
    // These tasks receive score 1.0 through a separate path — a 0 here would be
    // an instrumentation artifact, not a real quality failure.
    if (this.isShortCircuitExit(result, task)) {
      log.info("Suppressing score-zero alert for short-circuit exit", {
        task_id: task.id.slice(0, 8),
        score,
        approvalRationale: result.approvalRationale,
      });
      return false;
    }

    // Dedup: never re-alert for the same task ID.
    if (this.alertedTaskIds.has(task.id)) {
      log.info("Score-zero alert already sent for this task — deduplicated", { task_id: task.id.slice(0, 8) });
      return false;
    }
    this.alertedTaskIds.add(task.id);

    if (!this.notifier || !this.notifier.isConfigured()) {
      log.warn("Notifier not configured — skipping score-zero alert", {
        task_id: task.id.slice(0, 8),
        score,
      });
      return false;
    }

    const message = this.formatAlertMessage(result, task, score);

    try {
      await this.notifier.notifyOperator(
        "Score-Zero Approval",
        message,
        "high",
      );
      log.info("Score-zero approval alert sent", {
        task_id: task.id.slice(0, 8),
        score,
        agent: task.agent_name ?? "unknown",
      });
      return true;
    } catch (err) {
      // Remove from dedup set so a future retry can attempt the alert.
      this.alertedTaskIds.delete(task.id);
      log.error("Failed to send score-zero approval alert", {
        task_id: task.id.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Return true when this result represents a short-circuit exit that
   * legitimately bypasses LLM scoring (e.g. already-in-review, pre-dispatch block).
   * These tasks get score 1.0 through `recordShortCircuitScore()`; a 0 appearing
   * here would be an instrumentation artifact.
   */
  private isShortCircuitExit(result: VerificationResult, task: Task): boolean {
    // Canonical marker set by recordShortCircuitScore(): "short_circuit_<dimension>"
    if (result.approvalRationale?.startsWith("short_circuit_")) return true;

    // Defensive fallback: check the raw task result text for the well-known prefix.
    const resultText = task.result ?? "";
    if (resultText.startsWith("already-in-review:")) return true;
    if (/already[\s-]handled/i.test(resultText)) return true;

    return false;
  }

  /**
   * Build the Telegram alert message for a score-zero approval.
   * Includes task title, score, agent, bypass path, and dimension breakdown.
   */
  private formatAlertMessage(result: VerificationResult, task: Task, score: number): string {
    const scorePct = (score * 100).toFixed(1);
    const taskTitle = (task.title ?? `Task ${task.id.slice(0, 8)}`).slice(0, 100);
    const agentName = task.agent_name ?? "unknown";
    const taskType = task.task_type ?? "unknown";

    // Bypass path: prefer explicit bypass_reason; fall back to approvalRationale.
    const bypassPath = task.bypass_reason ?? result.approvalRationale ?? "NONE RECORDED";

    const lines: string[] = [
      `🔴 *Score-Zero Approval Detected*`,
      ``,
      `*Task:* ${taskTitle}`,
      `*Score:* ${scorePct}% ⚠️ CRITICAL`,
      `*Agent:* ${agentName}`,
      `*Type:* ${taskType}`,
      `*Bypass path:* \`${bypassPath}\``,
    ];

    // Include per-dimension breakdown when available.
    const dimText = this.formatDimensions(result.dimensions);
    if (dimText) {
      lines.push(``, `*Dimensions:*`, dimText);
    }

    // Include the verifier's notes (first 200 chars) for operator triage.
    if (result.notes && result.notes.length > 0) {
      lines.push(``, `_Notes:_ ${result.notes.slice(0, 200)}${result.notes.length > 200 ? "…" : ""}`);
    }

    lines.push(``, `/override confirm ${task.id} <reason>`);

    return lines.join("\n");
  }

  /**
   * Format per-dimension scores as a compact readable list.
   * Returns an empty string when no dimensions are available.
   */
  private formatDimensions(dimensions: QualityDimensions | undefined): string {
    if (!dimensions) return "";

    const LABELS: Record<string, string> = {
      correctness: "Correctness",
      completeness: "Completeness",
      test_coverage: "Test Coverage",
      code_quality: "Code Quality",
    };

    return Object.entries(dimensions)
      .map(([key, value]) => {
        const label = LABELS[key] ?? key;
        const pct = typeof value === "number" ? (value * 100).toFixed(0) : "N/A";
        return `  • ${label}: ${pct}%`;
      })
      .join("\n");
  }
}
