import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("duplicate-guard");

/**
 * Default recency window (hours) after a task completes before the same
 * source_ref can be dispatched again.  Rejected tasks are exempt — they are
 * re-dispatched immediately so the agent can revise the work.
 *
 * 24 hours: prevents the double-dispatch pattern observed in issue #330,
 * where the same GitHub issue was dispatched twice within a short window
 * because the first task completed and the issue wasn't yet closed before
 * the next poll cycle picked it up again.
 *
 * Configurable via `triggers.recency_window_hours` in agents.yaml.
 */
export const RECENCY_WINDOW_HOURS = 24;

/**
 * Module-level override set from agents.yaml `triggers.recency_window_hours`.
 * When set, takes precedence over the hardcoded RECENCY_WINDOW_HOURS default.
 */
let configuredRecencyWindowHours: number | undefined;

/**
 * Set the recency window from the loaded config.  Called once at daemon startup.
 */
export function setRecencyWindowHours(hours: number | undefined): void {
  configuredRecencyWindowHours = hours;
}

/**
 * Get the effective recency window (config override or default).
 */
export function getRecencyWindowHours(): number {
  return configuredRecencyWindowHours ?? RECENCY_WINDOW_HOURS;
}

const INFRA_ERROR_PATTERNS = [
  "Persistent session process not available",
  "Persistent session process died",
  "Connection error",
  "connection-error-exhausted",
  "fetch failed",
  "ENOENT",
  "FOREIGN KEY constraint failed",
  "spawn claude",
  "E2BIG",
  "database connection is not open",
];

/**
 * Returns true if the task result indicates an infrastructure/connection
 * failure rather than the agent attempting and failing the work.
 */
function isInfrastructureError(result: string | null | undefined): boolean {
  if (!result) return false;
  return INFRA_ERROR_PATTERNS.some((p) => result.includes(p));
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  /** Human-readable reason, present only when isDuplicate is true. */
  reason?: string;
  /** The conflicting task, present only when isDuplicate is true. */
  existingTask?: Task;
}

/**
 * Determine whether dispatching a new task for (source, sourceRef) would
 * create a duplicate.
 *
 * Returns `isDuplicate: true` when:
 *   1. An active task (pending / planning / dispatched / in_progress) already
 *      covers this source_ref — wait for it to finish.
 *   2. A completed or failed task for this source_ref was last updated within
 *      RECENCY_WINDOW_HOURS and was NOT explicitly rejected by the verifier.
 *      Rejected tasks are allowed to be re-dispatched immediately so the agent
 *      can address the verifier's feedback.
 *
 * This replaces the `processed_triggers`-only check used in earlier versions.
 * `processed_triggers` is only populated after a task fully completes, so any
 * restart during a long-running task would clear `inFlightDispatches` and
 * allow a duplicate dispatch before the task wrote its completion record.
 * Querying the `tasks` table directly is restart-safe.
 */
export function checkDuplicate(
  store: StateStore,
  source: string,
  sourceRef: string,
): DuplicateCheckResult {
  const task = store.findDispatchCandidateBySourceRef(source, sourceRef);
  if (!task) {
    return { isDuplicate: false };
  }

  // Active task — always block. Wait for it to reach a terminal state.
  if (
    task.status === "pending" ||
    task.status === "planning" ||
    task.status === "dispatched" ||
    task.status === "in_progress"
  ) {
    log.info("Duplicate suppressed: active task exists", {
      sourceRef,
      taskId: task.id,
      status: task.status,
    });
    return {
      isDuplicate: true,
      reason: `active task ${task.id} with status "${task.status}"`,
      existingTask: task,
    };
  }

  // Escalated task — block within recency window, then allow re-dispatch.
  // Previously this was permanent, causing issues to get stuck forever once escalated.
  // Now escalated tasks follow the same recency window as completed tasks.
  if (task.status === "escalated") {
    const ageHours =
      (Date.now() - new Date(task.updated_at).getTime()) / (1000 * 60 * 60);
    const windowHours = getRecencyWindowHours();
    if (ageHours < windowHours) {
      log.warn("Duplicate suppressed: source_ref is escalated (within recency window)", {
        sourceRef,
        taskId: task.id,
        ageHours: ageHours.toFixed(1),
        windowHours,
      });
      return {
        isDuplicate: true,
        reason: `escalated task ${task.id} — escalated ${ageHours.toFixed(1)}h ago (window: ${windowHours}h)`,
        existingTask: task,
      };
    }
    log.info("Escalated task outside recency window — allowing re-dispatch", {
      sourceRef,
      taskId: task.id,
      ageHours: ageHours.toFixed(1),
    });
    return { isDuplicate: false };
  }

  // Terminal state (done / failed): allow re-dispatch if the task was
  // explicitly rejected by the verifier — the agent should revise the work.
  if (task.status === "done" || task.status === "failed") {
    if (task.verification_status === "rejected") {
      log.info("Allowing re-dispatch: prior task was verifier-rejected", {
        sourceRef,
        taskId: task.id,
      });
      return { isDuplicate: false };
    }

    // Verified-and-approved tasks are definitively complete.  Re-dispatching
    // would be a no-op that burns agent tokens only to confirm the work is
    // already done (see issue #387 — third dispatch of #28 scored 0.72 doing
    // exactly this).  Only allow re-dispatch if new PR review feedback has
    // arrived since the task completed, which means the reviewer found issues
    // the agent needs to address.
    if (task.status === "done" && task.verification_status === "approved") {
      const hasNewFeedback = store.hasPrFeedbackSince(sourceRef, task.updated_at);
      if (!hasNewFeedback) {
        log.info("Duplicate suppressed: task already verified-approved with no new feedback", {
          sourceRef,
          taskId: task.id,
          completedAt: task.updated_at,
        });
        return {
          isDuplicate: true,
          reason: `already completed: verified-approved task ${task.id} with no new PR feedback since ${task.updated_at}`,
          existingTask: task,
        };
      }
      log.info("Allowing re-dispatch: verified-approved task has new PR feedback", {
        sourceRef,
        taskId: task.id,
        completedAt: task.updated_at,
      });
      return { isDuplicate: false };
    }

    // Infrastructure errors (proxy down, spawn failures, connection errors)
    // should not block re-dispatch — the agent never attempted the work.
    // Only suppress when the agent actually tried and the result needs review.
    if (task.status === "failed" && isInfrastructureError(task.result)) {
      log.info("Allowing re-dispatch: prior failure was infrastructure error", {
        sourceRef,
        taskId: task.id,
        result: task.result?.substring(0, 100),
      });
      return { isDuplicate: false };
    }

    // Suppress within the recency window to avoid piling on before the
    // result is reviewed or the issue is closed.
    const ageHours =
      (Date.now() - new Date(task.updated_at).getTime()) / 3_600_000;
    const recencyWindow = getRecencyWindowHours();
    if (ageHours < recencyWindow) {
      log.warn("Duplicate dispatch blocked: same source_ref completed within recency window", {
        sourceRef,
        taskId: task.id,
        status: task.status,
        ageHours: ageHours.toFixed(2),
        windowHours: recencyWindow,
      });
      return {
        isDuplicate: true,
        reason: `recent ${task.status} task ${task.id} (${ageHours.toFixed(1)}h ago; window: ${recencyWindow}h)`,
        existingTask: task,
      };
    }
  }

  return { isDuplicate: false };
}
