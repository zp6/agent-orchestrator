/**
 * Stale-task sweeper (issue #1646).
 *
 * Sweeps tasks that have been stuck in `pending` or `paused` status for
 * more than a configurable number of days without being dispatched.
 *
 * Typical candidates: "Coordinated change from #X" cross-repo follow-up
 * tasks that were enqueued but never picked up by the dispatcher.
 *
 * Transition logic:
 *   - source_ref null OR source issue CLOSED → "superseded"
 *   - source issue OPEN AND stale > 30 days  → "superseded"
 *   - source issue OPEN AND 7–30 days stale  → "cancelled"
 */

import { StateStore, type Task } from "../state/store.js";
import { isIssueOpen } from "./github.js";

// ── Public interfaces ────────────────────────────────────────────────────────

export interface SweepCandidate {
  id: string;
  title: string;
  agent_name: string | null;
  status: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  stale_days: number;
}

export interface SweepTransition {
  task_id: string;
  title: string;
  agent_name: string | null;
  old_status: string;
  new_status: "superseded" | "cancelled";
  source_ref: string | null;
  reason: string;
}

export interface SweepResult {
  candidates: SweepCandidate[];
  transitions: SweepTransition[];
  superseded: number;
  cancelled: number;
  dry_run: boolean;
  threshold_days: number;
  swept_at: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a GitHub issue ref of the form "owner/repo#N".
 * Returns null if the ref is null, empty, or does not match the expected format.
 */
function parseGitHubIssueRef(
  sourceRef: string | null,
): { repo: string; number: number } | null {
  if (!sourceRef) return null;
  // Match "owner/repo#N" — the issue number must be a positive integer.
  const match = sourceRef.match(/^([^#\s]+)#(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[2], 10);
  if (isNaN(num) || num <= 0) return null;
  return { repo: match[1], number: num };
}

/**
 * Compute the number of days since `updatedAt` (ISO string).
 */
function staleDays(updatedAt: string): number {
  const ms = Date.now() - new Date(updatedAt).getTime();
  return ms / (1000 * 60 * 60 * 24);
}

// ── Core sweep logic ─────────────────────────────────────────────────────────

/**
 * Sweep stale pending/paused tasks.
 *
 * In dry-run mode (the default) no writes are made — the function returns
 * a SweepResult describing what *would* happen.
 *
 * In non-dry-run mode each candidate task is updated in state.db and an
 * audit entry is appended to task_logs.
 */
export async function sweepStalePendingTasks(params: {
  store: StateStore;
  thresholdDays?: number;
  dryRun?: boolean;
  statuses?: string[];
}): Promise<SweepResult> {
  const {
    store,
    thresholdDays = 7,
    dryRun = true,
    statuses = ["pending", "paused"],
  } = params;

  const sweepDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const swept_at = new Date().toISOString();

  // Fetch stale tasks from the store
  const staleTasks: Task[] = store.getStalePendingTasks(thresholdDays, statuses);

  const candidates: SweepCandidate[] = staleTasks.map((t) => ({
    id: t.id,
    title: t.title,
    agent_name: t.agent_name,
    status: t.status,
    source_ref: t.source_ref,
    created_at: t.created_at,
    updated_at: t.updated_at,
    stale_days: Math.floor(staleDays(t.updated_at)),
  }));

  const transitions: SweepTransition[] = [];

  for (const task of staleTasks) {
    const days = staleDays(task.updated_at);
    const parsed = parseGitHubIssueRef(task.source_ref);

    let newStatus: "superseded" | "cancelled";
    let reason: string;

    if (!parsed) {
      // No parseable source_ref → supersede immediately
      newStatus = "superseded";
      reason = `Auto-superseded: source issue closed without dispatch (sweep ${sweepDate})`;
    } else {
      // We have a parseable ref — check whether the issue is still open
      const issueOpen = isIssueOpen(parsed.repo, parsed.number);

      if (!issueOpen) {
        newStatus = "superseded";
        reason = `Auto-superseded: source issue closed without dispatch (sweep ${sweepDate})`;
      } else if (days > 30) {
        // Issue is open but task has been stale for more than 30 days
        newStatus = "superseded";
        reason = `Auto-superseded: pending >${Math.floor(days)}d without dispatch — source issue open but task stale (sweep ${sweepDate})`;
      } else {
        // Issue is open and within the 7–30 day window
        newStatus = "cancelled";
        reason = `Auto-cancelled: pending >${Math.floor(days)}d without dispatch (sweep ${sweepDate})`;
      }
    }

    transitions.push({
      task_id: task.id,
      title: task.title,
      agent_name: task.agent_name,
      old_status: task.status,
      new_status: newStatus,
      source_ref: task.source_ref,
      reason,
    });

    if (!dryRun) {
      store.updateTask(task.id, {
        status: newStatus,
        result: reason,
      });
      store.addLog({
        task_id: task.id,
        direction: "system",
        content: reason,
      });
    }
  }

  const superseded = transitions.filter((t) => t.new_status === "superseded").length;
  const cancelled = transitions.filter((t) => t.new_status === "cancelled").length;

  return {
    candidates,
    transitions,
    superseded,
    cancelled,
    dry_run: dryRun,
    threshold_days: thresholdDays,
    swept_at,
  };
}

/**
 * Return the count of tasks that are currently stale (pending/paused older
 * than thresholdDays). Used by the compliance signal.
 */
export function getStaleTaskCount(store: StateStore, thresholdDays = 7): number {
  return store.getStaleTaskCount(thresholdDays);
}
