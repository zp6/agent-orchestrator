import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("duplicate-guard");

/**
 * How long after a task completes before the same source_ref can be
 * dispatched again. Rejected tasks are exempt — they are re-dispatched
 * immediately so the agent can revise the work.
 */
export const RECENCY_WINDOW_HOURS = 4;

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
  const task = store.findTaskBySourceRef(source, sourceRef);
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

    // Suppress within the recency window to avoid piling on before the
    // result is reviewed or the issue is closed.
    const ageHours =
      (Date.now() - new Date(task.updated_at).getTime()) / 3_600_000;
    if (ageHours < RECENCY_WINDOW_HOURS) {
      log.info("Duplicate suppressed: recent completed task", {
        sourceRef,
        taskId: task.id,
        status: task.status,
        ageHours: ageHours.toFixed(2),
      });
      return {
        isDuplicate: true,
        reason: `recent ${task.status} task ${task.id} (${ageHours.toFixed(1)}h ago; window: ${RECENCY_WINDOW_HOURS}h)`,
        existingTask: task,
      };
    }
  }

  return { isDuplicate: false };
}
