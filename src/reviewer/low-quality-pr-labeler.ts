/**
 * Low-quality PR labeler — issue #428.
 *
 * Applies (or removes) the `low-quality` GitHub label on the PR associated with
 * a task whenever the task is approved below the 0.70 score threshold.
 *
 * ## Why labels instead of just Telegram alerts
 *
 * Telegram alerts are transient. A reviewer merging a PR two hours after the
 * approval may never see the alert. A `low-quality` label on the PR itself is
 * visible to anyone who opens it on GitHub — it communicates risk before the
 * merge button is clicked.
 *
 * ## Label lifecycle
 *
 * - **Add** `low-quality` when task is approved with score < LOW_QUALITY_LABEL_THRESHOLD (0.70).
 * - **Remove** `low-quality` when a subsequent revision pushes the score ≥ threshold
 *   (the revision replaces the original task, so the same PR should be re-checked
 *   after each verification cycle).
 * - **No-op** when the task has no `source_ref` pointing to a PR, or when the label
 *   state already matches what it should be.
 *
 * ## GitHub label creation
 *
 * The `low-quality` label is auto-created in the target repo on first use with a
 * warning-orange colour (`#e4a74b`).  Subsequent calls are idempotent — `gh label
 * create --force` updates colour/description if the label already exists.
 *
 * ## Usage
 *
 *   import { LowQualityPRLabeler } from './low-quality-pr-labeler.js';
 *
 *   const labeler = new LowQualityPRLabeler();
 *
 *   // After each approved verification (or after a revision):
 *   await labeler.applyLabel(result, task);
 *
 * Issue #428.
 */

import { execSync } from "node:child_process";
import type { VerificationResult } from "./verifier.js";
import type { Task } from "../state/types.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("low-quality-pr-labeler");

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Score threshold (exclusive lower bound for "clean" PRs).
 * Tasks approved below this value receive the `low-quality` label.
 * Tasks at or above this value have the label removed.
 */
export const LOW_QUALITY_LABEL_THRESHOLD = 0.70;

/** GitHub label name applied to sub-threshold PRs. */
export const LOW_QUALITY_LABEL_NAME = "low-quality";

/** Label colour (warning orange) for the auto-created GitHub label. */
export const LOW_QUALITY_LABEL_COLOR = "e4a74b";

/** Label description for auto-created GitHub label. */
export const LOW_QUALITY_LABEL_DESCRIPTION =
  "Approved below the 0.70 quality threshold — review carefully before merging.";

// ── PR ref parsing ────────────────────────────────────────────────────────────

/**
 * Parsed PR reference extracted from a task's `source_ref` field.
 */
export interface PrRef {
  /** Owner and repo, e.g. "rapartlu/agent-reviewer". */
  repo: string;
  /** PR number as a string, e.g. "428". */
  prNumber: string;
}

/**
 * Parse a PR reference from a task's `source_ref` field.
 *
 * Accepted source_ref formats:
 *   - `owner/repo/pull/NNN`  → { repo: "owner/repo", prNumber: "NNN" }
 *   - Anything else          → null (not a PR ref)
 *
 * Issue refs (`owner/repo#NNN`) and null values are explicitly ignored —
 * the labeler only operates on PRs, not on source issues.
 */
export function parsePrRef(sourceRef: string | null | undefined): PrRef | null {
  if (!sourceRef) return null;

  // Pattern: owner/repo/pull/NNN
  const match = /^([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(sourceRef);
  if (!match) return null;

  return { repo: match[1], prNumber: match[2] };
}

// ── Label operations ──────────────────────────────────────────────────────────

/**
 * Ensure the `low-quality` label exists in the target repository.
 *
 * Uses `gh label create --force` so the call is idempotent — if the label
 * already exists it updates colour and description without error.
 *
 * @param repo  Owner/repo string, e.g. "rapartlu/agent-reviewer".
 * @throws      If the `gh` CLI is unavailable or authentication fails.
 */
export function ensureLowQualityLabel(repo: string): void {
  const cmd = [
    "gh label create",
    JSON.stringify(LOW_QUALITY_LABEL_NAME),
    `--repo ${JSON.stringify(repo)}`,
    `--color ${JSON.stringify(LOW_QUALITY_LABEL_COLOR)}`,
    `--description ${JSON.stringify(LOW_QUALITY_LABEL_DESCRIPTION)}`,
    "--force",
  ].join(" ");

  execSync(cmd, { stdio: "pipe" });
}

/**
 * Add the `low-quality` label to a GitHub PR.
 *
 * @param repo      Owner/repo string.
 * @param prNumber  PR number as a string.
 * @throws          If the `gh` CLI call fails.
 */
export function addLowQualityLabel(repo: string, prNumber: string): void {
  const cmd = `gh pr edit ${prNumber} --repo ${JSON.stringify(repo)} --add-label ${JSON.stringify(LOW_QUALITY_LABEL_NAME)}`;
  execSync(cmd, { stdio: "pipe" });
}

/**
 * Remove the `low-quality` label from a GitHub PR.
 *
 * No-ops if the label is not present on the PR (gh CLI returns exit 0 in
 * this case as of `gh` ≥ 2.40).
 *
 * @param repo      Owner/repo string.
 * @param prNumber  PR number as a string.
 * @throws          If the `gh` CLI call fails with a non-label-not-found error.
 */
export function removeLowQualityLabel(repo: string, prNumber: string): void {
  const cmd = `gh pr edit ${prNumber} --repo ${JSON.stringify(repo)} --remove-label ${JSON.stringify(LOW_QUALITY_LABEL_NAME)}`;
  execSync(cmd, { stdio: "pipe" });
}

// ── Main class ────────────────────────────────────────────────────────────────

export interface LowQualityPRLabelerOptions {
  /**
   * Score threshold (exclusive lower bound for a "clean" PR).
   * Default: LOW_QUALITY_LABEL_THRESHOLD = 0.70
   */
  threshold?: number;
  /**
   * When true, `ensureLowQualityLabel` is skipped — useful in tests or when
   * the label is already guaranteed to exist in every target repo.
   * Default: false
   */
  skipLabelCreation?: boolean;
}

/**
 * Applies or removes the `low-quality` GitHub label on PRs associated with
 * low-quality-approved tasks.
 *
 * ## When to call
 *
 * Call `applyLabel()` after every verification that results in an approval,
 * whether on the initial pass or on a revision:
 *
 * ```ts
 * const result = await verifier.verify(task);
 * if (result.approved) {
 *   await labeler.applyLabel(result, task);
 * }
 * ```
 *
 * The labeler resolves the correct action (add vs. remove) from the score
 * and is idempotent — calling it multiple times for the same task and score
 * is safe.
 */
export class LowQualityPRLabeler {
  private readonly threshold: number;
  private readonly skipLabelCreation: boolean;

  /**
   * Tracks repos where we've already called ensureLowQualityLabel so we
   * don't pay the gh CLI round-trip cost on every single call.
   */
  private readonly ensuredRepos = new Set<string>();

  constructor(opts: LowQualityPRLabelerOptions = {}) {
    this.threshold = opts.threshold ?? LOW_QUALITY_LABEL_THRESHOLD;
    this.skipLabelCreation = opts.skipLabelCreation ?? false;
  }

  /**
   * Apply or remove the `low-quality` label based on the task's quality score.
   *
   * - If `score < threshold` (0.70) → ensure label exists, then add it.
   * - If `score >= threshold`        → remove the label (no-op if not present).
   * - If the task has no PR `source_ref` → logs and returns false.
   *
   * @param result  The verification result (used for the score).
   * @param task    The full task record (used for source_ref).
   * @returns       `true` when a label was added or removed; `false` when
   *                no action was taken (no PR ref, or gh CLI error).
   */
  async applyLabel(result: VerificationResult, task: Task): Promise<boolean> {
    const prRef = parsePrRef(task.source_ref);
    if (!prRef) {
      log.info("No PR ref in source_ref — skipping label operation", {
        task_id: task.id.slice(0, 8),
        source_ref: task.source_ref ?? null,
      });
      return false;
    }

    const score = result.score ?? task.quality_score ?? null;
    if (score === null) {
      log.info("No score available — skipping label operation", {
        task_id: task.id.slice(0, 8),
        pr: `${prRef.repo}#${prRef.prNumber}`,
      });
      return false;
    }

    const isLowQuality = score < this.threshold;

    try {
      if (isLowQuality) {
        await this._ensureLabel(prRef.repo);
        addLowQualityLabel(prRef.repo, prRef.prNumber);
        log.info("Added low-quality label to PR", {
          repo: prRef.repo,
          pr: prRef.prNumber,
          score: score.toFixed(2),
          threshold: this.threshold,
          task_id: task.id.slice(0, 8),
        });
      } else {
        removeLowQualityLabel(prRef.repo, prRef.prNumber);
        log.info("Removed low-quality label from PR (score now above threshold)", {
          repo: prRef.repo,
          pr: prRef.prNumber,
          score: score.toFixed(2),
          threshold: this.threshold,
          task_id: task.id.slice(0, 8),
        });
      }
      return true;
    } catch (err) {
      log.error("Failed to apply low-quality label to PR", {
        repo: prRef.repo,
        pr: prRef.prNumber,
        action: isLowQuality ? "add" : "remove",
        error: err instanceof Error ? err.message : String(err),
        task_id: task.id.slice(0, 8),
      });
      return false;
    }
  }

  /**
   * Ensure the low-quality label exists in a repo, using a per-instance cache
   * so we only call `gh label create` once per repo per process lifetime.
   */
  private async _ensureLabel(repo: string): Promise<void> {
    if (this.skipLabelCreation || this.ensuredRepos.has(repo)) return;

    try {
      ensureLowQualityLabel(repo);
      this.ensuredRepos.add(repo);
    } catch (err) {
      // Non-fatal: if label creation fails (e.g. permissions), still attempt
      // to add the label — gh may add it anyway, or the label may already exist.
      log.warn("Failed to ensure low-quality label exists in repo", {
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Number of repos in which label existence has been confirmed this session.
   * Useful for tests and observability.
   */
  get ensuredRepoCount(): number {
    return this.ensuredRepos.size;
  }
}
