/**
 * Universal Quality Gate (issue #405).
 *
 * Catches sub-0.80 approvals across ALL task types and ALL approval paths —
 * including cross-repo follow-ups, operator direct-approvals, and any other
 * path that bypasses the normal `verify()` callback chain.
 *
 * Unlike `QualityFloorBypassDetector` (which is called from within the verifier
 * callback and only sees tasks that go through `verify()`), this gate can be
 * called after ANY approval event — orchestrator short-circuit paths, operator
 * Telegram `/approve` commands, cross-repo follow-up task completions, etc.
 *
 * No task-type exemptions. Cross-repo follow-ups, housekeeping, implementation,
 * research — all checked with the same 0.80 floor.
 *
 * Usage (pure-function form — for one-off checks from any approval path):
 *
 *   import { checkApprovalQualityGate } from './universal-quality-gate.js';
 *
 *   const fired = await checkApprovalQualityGate(task, notifier);
 *
 * Usage (daemon-style — per-task dedup across many approvals):
 *
 *   import { UniversalQualityGateMonitor } from './universal-quality-gate.js';
 *
 *   const monitor = new UniversalQualityGateMonitor(notifier, {
 *     floor: 0.80,
 *     dashboardBaseUrl: 'https://dashboard.example.com',
 *   });
 *
 *   // After any approval event — verifier path, operator path, cross-repo path:
 *   const alerted = await monitor.checkAndAlert(task);
 *
 * Issue #405.
 */

import type { Notifier } from "../notify.js";
import type { Task } from "../state/types.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("universal-quality-gate");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Quality floor — approvals below this score trigger an alert.
 *
 * Deliberately set at 0.80 to match the verifier's standard approval threshold.
 * This is the same value used by `QualityFloorBypassDetector`.
 */
export const UNIVERSAL_QUALITY_FLOOR = 0.80;

// ── Config ────────────────────────────────────────────────────────────────────

export interface UniversalQualityGateConfig {
  /**
   * Score floor (exclusive upper bound). Default: 0.80.
   * Approvals with quality_score < floor trigger an alert.
   */
  floor?: number;
  /**
   * Base URL for audit trail links in the Telegram message.
   * E.g. "https://dashboard.example.com". Omit to suppress link.
   */
  dashboardBaseUrl?: string;
}

// ── Pure-function check ───────────────────────────────────────────────────────

/**
 * Check a single approved task against the universal quality floor and alert
 * via the notifier if it is sub-threshold.
 *
 * Returns true when an alert was sent; false when the task passes the floor,
 * has no quality_score, the notifier is unconfigured, or an error occurs.
 *
 * This function performs NO deduplication. Use `UniversalQualityGateMonitor`
 * for daemon scenarios where the same task may be checked multiple times.
 *
 * The only bypass exemption is `task.bypass_reason === 'operator_override'`
 * (explicit human approval). All other bypass_reason values — including
 * 'floor_not_enforced' and null — are treated as unexempt and will alert.
 *
 * @param task     Approved task record. Must have `verification_status = 'approved'`.
 * @param notifier Notifier instance to use for Telegram alerts.
 * @param config   Optional configuration overrides.
 */
export async function checkApprovalQualityGate(
  task: Task,
  notifier: Notifier,
  config: UniversalQualityGateConfig = {},
): Promise<boolean> {
  const floor = config.floor ?? UNIVERSAL_QUALITY_FLOOR;
  const score = task.quality_score ?? null;

  if (score === null) {
    return false;
  }

  if (score >= floor) return false;

  // operator_override is the only explicit bypass exemption.
  if (task.bypass_reason === "operator_override") {
    return false;
  }

  if (!notifier.isConfigured()) {
    log.warn("Universal quality gate: notifier not configured — skipping alert", {
      task_id: task.id.slice(0, 8),
      score,
      task_type: task.task_type,
    });
    return false;
  }

  const message = formatUniversalQualityGateAlert(task, score, floor, config.dashboardBaseUrl);

  try {
    await notifier.notifyOperator("Universal Quality Gate Violation", message, "high");
    log.info("Universal quality gate alert sent", {
      task_id: task.id.slice(0, 8),
      score,
      task_type: task.task_type,
      agent_name: task.agent_name ?? null,
      bypass_reason: task.bypass_reason ?? null,
    });
    return true;
  } catch (err) {
    log.error("Universal quality gate: failed to send alert", {
      task_id: task.id.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Telegram message formatter ────────────────────────────────────────────────

/**
 * Format a Telegram Markdown alert message for a universal quality gate violation.
 *
 * Example output:
 *   🚨 *Universal Quality Gate Violation*
 *
 *   Task: `01KPRYG5…` — *Fix null handling in API layer*
 *   Type: cross-repo-followup
 *   Agent: claude-agent-orchestrator
 *   Score: *42.0%* (floor: 80%)
 *   Bypass: none
 *
 *   All task types are subject to the 0.80 quality floor.
 *   To override: /approve-override 01KPRYG5XXXXXXXXXXXXXXXX <reason>
 */
export function formatUniversalQualityGateAlert(
  task: Task,
  score: number,
  floor: number,
  dashboardBaseUrl?: string,
): string {
  const taskIdShort = task.id.slice(0, 8);
  const titleStr = (task.title ?? "(untitled)").slice(0, 80);
  const agentStr = task.agent_name ?? "unknown";
  const taskType = task.task_type ?? "unknown";
  const bypassStr = task.bypass_reason ?? "none";
  const scoreStr = (score * 100).toFixed(1);
  const floorStr = (floor * 100).toFixed(0);

  const lines: string[] = [
    `🚨 *Universal Quality Gate Violation*`,
    ``,
    `Task: \`${taskIdShort}…\` — *${titleStr}*`,
    `Type: ${taskType}`,
    `Agent: ${agentStr}`,
    `Score: *${scoreStr}%* (floor: ${floorStr}%)`,
    `Bypass: ${bypassStr}`,
  ];

  if (dashboardBaseUrl) {
    lines.push(``, `[View audit trail](${dashboardBaseUrl}/api/tasks/${task.id}/audit)`);
  }

  lines.push(
    ``,
    `All task types are subject to the ${floor.toFixed(2)} quality floor.`,
    `To override: /approve-override ${task.id} <reason>`,
  );

  return lines.join("\n");
}

// ── Daemon-style monitor ──────────────────────────────────────────────────────

/**
 * Daemon-style monitor that wraps `checkApprovalQualityGate()` with per-task
 * deduplication.
 *
 * Maintains an in-memory Set of alerted task IDs so the same task never
 * triggers more than one alert per process lifetime, even if `checkAndAlert()`
 * is called multiple times for the same task ID (e.g. from both the verifier
 * callback and the orchestrator direct-approval path).
 *
 * Also supports batch processing for daemon integration:
 *
 *   const results = await monitor.checkBatch(recentlyApprovedTasks);
 *   // { alerted: 2, skipped: 14 }
 */
export class UniversalQualityGateMonitor {
  private readonly alertedTaskIds = new Set<string>();
  private readonly floor: number;
  private readonly config: UniversalQualityGateConfig;

  constructor(
    private readonly notifier: Notifier,
    config: UniversalQualityGateConfig = {},
  ) {
    this.floor = config.floor ?? UNIVERSAL_QUALITY_FLOOR;
    this.config = config;
  }

  /**
   * Check a single approved task and alert if it violates the quality floor.
   *
   * Skips if this task ID has already triggered an alert in this process
   * lifetime (dedup protection).
   *
   * @returns true when an alert was newly sent; false when skipped or failed.
   */
  async checkAndAlert(task: Task): Promise<boolean> {
    if (this.alertedTaskIds.has(task.id)) {
      return false;
    }

    const score = task.quality_score ?? null;

    // Pre-check before calling the pure function to avoid a redundant notifier
    // isConfigured() call when the task passes the floor (fast path).
    if (score !== null && score < this.floor && task.bypass_reason !== "operator_override") {
      this.alertedTaskIds.add(task.id);
    }

    const fired = await checkApprovalQualityGate(task, this.notifier, this.config);

    // If the alert failed to send (notifier error), remove from dedup set so
    // a retry is possible on the next daemon cycle.
    if (!fired && this.alertedTaskIds.has(task.id) && (score === null || score >= this.floor)) {
      this.alertedTaskIds.delete(task.id);
    }

    return fired;
  }

  /**
   * Process a batch of recently-approved tasks.
   *
   * Runs alerts sequentially (not in parallel) to avoid flooding Telegram.
   * Returns a summary of how many were alerted vs. skipped.
   *
   * @param tasks Array of approved task records (any task type).
   */
  async checkBatch(tasks: Task[]): Promise<{ alerted: number; skipped: number }> {
    let alerted = 0;
    let skipped = 0;

    for (const task of tasks) {
      const fired = await this.checkAndAlert(task);
      if (fired) {
        alerted++;
      } else {
        skipped++;
      }
    }

    return { alerted, skipped };
  }

  /**
   * Number of unique tasks that have already triggered an alert in this session.
   * Useful for tests and monitoring.
   */
  get alertedCount(): number {
    return this.alertedTaskIds.size;
  }
}
