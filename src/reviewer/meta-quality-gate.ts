/**
 * Meta-quality gate — issue #357
 *
 * Detects tasks whose scope is about quality enforcement, calibration, or
 * threshold management — and applies a stricter approval floor to them.
 *
 * ## Motivation
 *
 * A task that implements "score bypass alerting" or "quality gate enforcement"
 * must itself demonstrate the quality bar it is meant to enforce.  If such a
 * task is approved at 0.55 it sends a contradictory signal: "our quality
 * enforcement work doesn't need to meet quality standards."  This is a
 * credibility-destroying pattern observed in tasks 01KPJQ5E (0.42) and
 * 01KPJPHA (0.55) in issue #357.
 *
 * ## How it works
 *
 * 1. `isMetaQualityTask(title)` scans the task title for a set of
 *    quality-related keywords.
 * 2. If the task matches AND would otherwise be approved at a score below
 *    `META_QUALITY_FLOOR` (0.85), the gate fires:
 *      a. The `approved` flag is overridden to `false`.
 *      b. The notes are prefixed with a 🔬 META-QUALITY banner explaining
 *         the elevated requirement.
 *      c. A Telegram escalation is sent (medium urgency) naming the
 *         specific credibility issue so the operator is aware.
 *      d. `metaQualityRejected: true` is set on the returned result.
 * 3. The gate is a no-op when the score already meets the floor (≥ 0.85)
 *    or when the task was already going to be rejected by the standard gates.
 *
 * ## Integration
 *
 * Called inside `Verifier.verify()` as the final gate, chained after
 * `applyPriorityQualityGate()`:
 *
 * ```typescript
 * const afterPriorityGate = await this.applyPriorityQualityGate(...);
 * return this.applyMetaQualityGate(taskId, task, afterPriorityGate);
 * ```
 */

import type { Notifier } from "../notify.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("meta-quality-gate");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum score for a task classified as meta-quality to be approved.
 *
 * Higher than the standard 0.80 floor because quality-enforcement work is
 * expected to model the quality bar it sets for other tasks.
 */
export const META_QUALITY_FLOOR = 0.85;

/**
 * Keywords that identify a task as being about quality enforcement or
 * calibration.  A task title matching any of these phrases is subject to
 * the elevated META_QUALITY_FLOOR.
 *
 * Matching is case-insensitive, whole-word-aware (e.g. "bypass" alone matches
 * "score bypass alerting" but not "bypass road").
 */
export const META_QUALITY_KEYWORDS: string[] = [
  "score bypass",
  "bypass alert",
  "bypass detection",
  "quality gate",
  "quality floor",
  "quality enforcement",
  "quality calibration",
  "quality threshold",
  "score threshold",
  "score floor",
  "score calibration",
  "threshold enforcement",
  "enforcement",          // broad — matches "bypass enforcement", "floor enforcement"
  "calibration",          // matches "verifier calibration", "score calibration"
  "bypass reason",
  "low-score alert",
  "low score alert",
  "approval floor",
  "verification floor",
  "meta-review",
  "meta review",
];

// ── Keyword detection ─────────────────────────────────────────────────────────

/**
 * Returns `true` when the task title contains at least one keyword that
 * identifies it as a quality-enforcement or calibration task.
 *
 * Matching is:
 *   - Case-insensitive
 *   - Substring-based (a keyword anywhere in the title counts)
 *
 * @param title — Task title string (may be empty)
 */
export function isMetaQualityTask(title: string): boolean {
  if (!title) return false;
  const lower = title.toLowerCase();
  return META_QUALITY_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * Return the first keyword in `META_QUALITY_KEYWORDS` that matches `title`,
 * or `null` if no keyword matches.
 *
 * Useful for producing a human-readable explanation of why the gate fired.
 */
export function matchedMetaQualityKeyword(title: string): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  return META_QUALITY_KEYWORDS.find((kw) => lower.includes(kw.toLowerCase())) ?? null;
}

// ── Gate application ──────────────────────────────────────────────────────────

/**
 * Input accepted by `applyMetaQualityGateToResult()`.
 */
export interface MetaQualityGateInput {
  /** Task ID (for logging and Telegram message). */
  taskId: string;
  /** Task title (keyword-scanned). */
  taskTitle: string;
  /** Agent name (for Telegram message). */
  agentName: string | null | undefined;
  /** Current approval flag from the verifier. */
  approved: boolean;
  /** Current quality score (0–1). */
  score: number;
  /** Current verification notes (will be prefixed with banner when gate fires). */
  notes: string;
  /** Current revision guidance (passed through unchanged). */
  revision?: string;
}

/**
 * Output returned by `applyMetaQualityGateToResult()`.
 */
export interface MetaQualityGateOutput {
  /** Possibly overridden to `false` when gate fires. */
  approved: boolean;
  /**
   * True when the gate fired (task was meta-quality AND was approved below floor).
   * Callers should surface this flag in the `VerificationResult`.
   */
  metaQualityRejected: boolean;
  /**
   * Enriched notes: includes the 🔬 META-QUALITY banner when gate fires.
   * Unchanged when gate does not fire.
   */
  notes: string;
  /** Revision guidance: includes meta-quality-specific advice when gate fires. */
  revision?: string;
}

/**
 * Apply the meta-quality gate to a verification result.
 *
 * This is the pure business-logic core, separated from the Telegram side-effect
 * so it can be unit-tested without a real notifier.
 *
 * @param input   — See `MetaQualityGateInput`
 * @returns       — See `MetaQualityGateOutput`
 */
export function applyMetaQualityGateToResult(input: MetaQualityGateInput): MetaQualityGateOutput {
  const { approved, score, notes, revision, taskTitle } = input;

  // Gate only fires when:
  //   1. The task is a meta-quality task (title keyword match)
  //   2. It would otherwise be APPROVED
  //   3. The score is below META_QUALITY_FLOOR (0.85)
  if (!isMetaQualityTask(taskTitle) || !approved || score >= META_QUALITY_FLOOR) {
    return { approved, metaQualityRejected: false, notes, revision };
  }

  const scorePct = (score * 100).toFixed(0);
  const floorPct = (META_QUALITY_FLOOR * 100).toFixed(0);
  const matchedKw = matchedMetaQualityKeyword(taskTitle) ?? "quality enforcement";

  const banner =
    `🔬 META-QUALITY GATE — task rejected despite passing standard threshold\n` +
    `This task is about "${matchedKw}" and must score ≥ ${floorPct}% to be approved.\n` +
    `Actual score: ${scorePct}% (${Number(floorPct) - Number(scorePct)} points below the meta-quality floor).\n\n`;

  const metaRevision =
    `This task implements quality enforcement or calibration logic. ` +
    `It is held to a higher bar (${floorPct}%) than standard tasks (80%) because ` +
    `quality-enforcement code must itself demonstrate the quality it is meant to ensure.\n\n` +
    `To pass, the implementation must be complete, correct, and testable at ≥ ${floorPct}% quality. ` +
    `Focus on the gaps that prevented a higher score, then resubmit.` +
    (revision ? `\n\nOriginal guidance:\n${revision}` : "");

  log.warn("Meta-quality gate fired — overriding approval", {
    taskId: input.taskId,
    score,
    floor: META_QUALITY_FLOOR,
    matchedKeyword: matchedKw,
    agent: input.agentName ?? "unknown",
  });

  return {
    approved: false,
    metaQualityRejected: true,
    notes: `${banner}${notes}`,
    revision: metaRevision,
  };
}

/**
 * Build the Telegram operator alert body for a meta-quality gate rejection.
 *
 * Separate function so it can be tested independently and reused by the
 * Verifier's private method.
 */
export function buildMetaQualityAlertBody(
  taskId: string,
  agentName: string | null | undefined,
  score: number,
  matchedKeyword: string,
): string {
  const scorePct = (score * 100).toFixed(0);
  const floorPct = (META_QUALITY_FLOOR * 100).toFixed(0);

  return [
    `A quality-enforcement task scored below the elevated meta-quality floor.`,
    ``,
    `*Task:* \`${taskId}\``,
    `*Agent:* \`${agentName ?? "unknown"}\``,
    `*Matched keyword:* "${matchedKeyword}"`,
    `*Score:* ${scorePct}% (floor: ${floorPct}%)`,
    ``,
    `This task was about "${matchedKeyword}" — approving quality-enforcement work at ${scorePct}% would contradict the quality bar it is meant to enforce.`,
    ``,
    `The task has been rejected. The agent will resubmit after addressing the score gaps.`,
  ].join("\n");
}

/**
 * Send the meta-quality Telegram alert and log the event.
 *
 * Extracted as a standalone async function so `applyMetaQualityGateToResult`
 * can remain synchronous (and thus trivially testable).
 *
 * @param notifier  — Optional Notifier (no-op when undefined)
 * @param taskId    — Task ID
 * @param agentName — Agent name
 * @param score     — Quality score that triggered the gate
 * @param keyword   — Matched meta-quality keyword
 */
export async function sendMetaQualityAlert(
  notifier: Notifier | undefined,
  taskId: string,
  agentName: string | null | undefined,
  score: number,
  keyword: string,
): Promise<void> {
  if (!notifier) return;
  try {
    const body = buildMetaQualityAlertBody(taskId, agentName, score, keyword);
    // NOISE SUPPRESSION (#564): Meta-quality gate is operational monitoring.
    // Operator should query /meta-quality or /quality-health if interested; no push notifications.
    log.warn("Meta-quality gate violation detected (not sending to Telegram per #564)", {
      taskId,
      agentName,
      score,
      keyword,
      message: body.slice(0, 200),
    });
  } catch (err) {
    log.error("Failed to process meta-quality gate", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
