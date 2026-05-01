/**
 * Cross-agent in-flight duplicate dispatch guard — issue #336
 *
 * Prevents the same GitHub issue from being dispatched to multiple agents
 * simultaneously. The existing `checkPRExistenceBeforeDispatch()` guard only
 * checks for open PRs; this guard checks for active *tasks* in the state store
 * that are still in-flight (pending / planning / dispatched / in_progress)
 * and assigned to a different agent.
 *
 * When a conflict is detected, the guard:
 *   1. Returns `resolution: 'already-in-flight'` so the orchestrator skips dispatch
 *   2. Logs a structured warning with the conflicting agent and task IDs
 *   3. Sends a Telegram alert (if notifier configured)
 *
 * Usage:
 *
 *   const guard = new CrossAgentInflightGuard(store, notifier);
 *
 *   const result = await guard.check({
 *     source_ref: "owner/repo#123",
 *     target_agent: "claude-orchestrator-reviewer",
 *   });
 *
 *   if (result.skip) {
 *     // already being worked on by result.conflicting_agent
 *     return;
 *   }
 */

import type { IStateStore, Task } from "../state/types.js";
import type { Notifier } from "../notify.js";
import { createLogger } from "../service/logger.js";
import { canonicalizeAgentVariantName } from "../state/agent-variant.js";

const log = createLogger("cross-agent-inflight-guard");

// ── Task statuses considered "in-flight" ──────────────────────────────────────

export const IN_FLIGHT_STATUSES = ["pending", "planning", "dispatched", "in_progress"] as const;
export type InFlightStatus = typeof IN_FLIGHT_STATUSES[number];

// ── Public types ──────────────────────────────────────────────────────────────

/**
 * Request payload for a cross-agent in-flight check.
 */
export interface InFlightCheckRequest {
  /**
   * GitHub issue reference to check for in-flight work.
   * Expected format: "owner/repo#123" (as stored in tasks.source_ref).
   *
   * The guard queries for exact string equality — make sure the caller
   * normalises the ref to this form before calling.
   */
  source_ref: string;

  /**
   * The agent being dispatched to.
   * Tasks belonging to this agent are NOT considered conflicts — same-agent
   * re-dispatch is governed by existing guards.
   */
  target_agent: string;

  /**
   * Optional task ID for telemetry and logging.
   */
  task_id?: string | null;
}

/**
 * Result from a cross-agent in-flight check.
 */
export interface InFlightCheckResult {
  /**
   * When true, the orchestrator should NOT dispatch the task.
   * Dispatch would create a cross-agent duplicate for the same issue.
   */
  skip: boolean;

  /**
   * - `'already-in-flight'` — another agent is actively working on this issue
   * - `'no-conflict'`       — no in-flight cross-agent task found; proceed
   * - `'check-failed'`      — query failed; guard is fail-open (skip = false)
   */
  resolution: "already-in-flight" | "no-conflict" | "check-failed";

  /**
   * Name of the agent that already has this issue in-flight.
   * Present only when `resolution === 'already-in-flight'`.
   */
  conflicting_agent?: string;

  /**
   * Task ID of the conflicting in-flight task.
   * Present only when `resolution === 'already-in-flight'`.
   */
  conflicting_task_id?: string;

  /**
   * All in-flight tasks from other agents for the same source_ref.
   * Useful for telemetry — may have > 1 entry when multiple agents
   * somehow got the same issue simultaneously.
   */
  conflicting_tasks?: Pick<Task, "id" | "agent_name" | "status">[];

  /** Human-readable explanation of the decision. */
  reason: string;

  /** Whether a Telegram alert was sent for this event. */
  alert_sent: boolean;
}

// ── Guard ─────────────────────────────────────────────────────────────────────

/**
 * Checks the tasks table for in-flight cross-agent duplicates before dispatch.
 *
 * Fail-open: if the store query throws, the guard returns `skip: false` so
 * a query error never blocks a legitimate dispatch.
 */
export class CrossAgentInflightGuard {
  constructor(
    private readonly store: IStateStore,
    private readonly notifier?: Notifier,
  ) {}

  /**
   * Check whether another agent already has an in-flight task for the same
   * issue reference.
   *
   * @param req - Dispatch context: source_ref and target_agent.
   * @returns Result indicating whether dispatch should be skipped.
   */
  async check(req: InFlightCheckRequest): Promise<InFlightCheckResult> {
    const { source_ref, target_agent, task_id } = req;

    if (!source_ref) {
      return {
        skip: false,
        resolution: "no-conflict",
        reason: "No source_ref — cross-agent check skipped",
        alert_sent: false,
      };
    }

    let inFlightTasks: Task[];
    try {
      inFlightTasks = this.store.getInFlightTasksForIssue(source_ref);
    } catch (err) {
      log.error("Cross-agent in-flight check failed — failing open", {
        source_ref,
        target_agent,
        task_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        skip: false,
        resolution: "check-failed",
        reason: `Store query failed: ${err instanceof Error ? err.message : String(err)}`,
        alert_sent: false,
      };
    }

    // Filter out tasks owned by the target agent (or a sibling variant of the same
    // canonical family) — only genuine cross-family conflicts matter.
    //
    // Without canonicalization, `claude-research-agent` and `grok-research-agent`
    // would appear as different agents, causing the guard to block a sibling variant
    // from being dispatched to an issue that the other sibling is already handling.
    // Both variants should be treated as the same family (issue #606).
    const targetCanonical = canonicalizeAgentVariantName(target_agent);
    const crossAgentTasks = inFlightTasks.filter(
      (t) => t.agent_name != null &&
        canonicalizeAgentVariantName(t.agent_name) !== targetCanonical,
    );

    if (crossAgentTasks.length === 0) {
      return {
        skip: false,
        resolution: "no-conflict",
        reason: `No cross-agent in-flight tasks found for ${source_ref}`,
        alert_sent: false,
      };
    }

    // At least one cross-agent in-flight task exists — conflict detected.
    const primary = crossAgentTasks[0]!;
    const conflictingAgent = primary.agent_name ?? "unknown";
    const conflictingTaskId = primary.id;
    const allAgents = [...new Set(crossAgentTasks.map((t) => t.agent_name ?? "unknown"))];

    log.warn("Cross-agent in-flight duplicate detected — blocking dispatch", {
      source_ref,
      target_agent,
      conflicting_agents: allAgents,
      conflicting_task_ids: crossAgentTasks.map((t) => t.id),
      in_flight_count: crossAgentTasks.length,
      task_id,
    });

    const reason = [
      `Issue ${source_ref} is already in-flight with agent(s): ${allAgents.join(", ")}.`,
      `Task ${conflictingTaskId} (status: ${primary.status}) is blocking dispatch to ${target_agent}.`,
    ].join(" ");

    const alertSent = await this.sendAlert(
      source_ref,
      target_agent,
      conflictingAgent,
      conflictingTaskId,
      crossAgentTasks,
      task_id ?? null,
    );

    return {
      skip: true,
      resolution: "already-in-flight",
      conflicting_agent: conflictingAgent,
      conflicting_task_id: conflictingTaskId,
      conflicting_tasks: crossAgentTasks.map((t) => ({
        id: t.id,
        agent_name: t.agent_name ?? null,
        status: t.status,
      })),
      reason,
      alert_sent: alertSent,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async sendAlert(
    sourceRef: string,
    targetAgent: string,
    conflictingAgent: string,
    conflictingTaskId: string,
    allConflicting: Task[],
    newTaskId: string | null,
  ): Promise<boolean> {
    if (!this.notifier?.isConfigured()) return false;

    const agentList = [...new Set(allConflicting.map((t) => t.agent_name ?? "unknown"))];
    const statusList = allConflicting
      .map((t) => `\`${t.id.slice(0, 8)}\` (${t.agent_name ?? "?"}, ${t.status})`)
      .join(", ");

    const body = [
      `🔁 *Multi-agent collision detected* — \`${sourceRef}\` is already in-flight.`,
      ``,
      `*Requested agent:* \`${targetAgent}\``,
      `*Already in-flight:* ${agentList.map((a) => `\`${a}\``).join(", ")}`,
      `*Conflicting tasks:* ${statusList}`,
      ...(newTaskId ? [`*Blocked task:* \`${newTaskId.slice(0, 12)}\``] : []),
      ``,
      `Dispatch skipped — \`${conflictingTaskId.slice(0, 8)}\` will resolve this issue first.`,
    ].join("\n");

    try {
      await this.notifier!.notifyOperator(
        `Multi-agent collision: ${sourceRef} already in-flight`,
        body,
        "medium",
      );
      return true;
    } catch (err) {
      // Alert failure must never block dispatch decisions.
      log.error("Failed to send cross-agent collision alert", {
        sourceRef,
        conflictingAgent,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}

// ── Helper exports ────────────────────────────────────────────────────────────

/**
 * Parse a source_ref string to extract the issue number, if present.
 *
 * Supports:
 *   - "owner/repo#123"            → 123
 *   - "github-issue:owner/repo#123" → 123
 *   - "#123"                      → 123
 *   - "123"                       → 123
 *
 * Returns null for refs that don't contain a recognisable issue number.
 */
export function extractIssueNumberFromInflightRef(sourceRef: string): number | null {
  if (!sourceRef) return null;

  // Strip "github-issue:" prefix if present
  const cleaned = sourceRef.replace(/^github-issue:/i, "");

  // Match "#123" at end, or just a bare number
  const hashMatch = cleaned.match(/#(\d+)$/);
  if (hashMatch) return parseInt(hashMatch[1]!, 10);

  const bareNumber = cleaned.match(/^(\d+)$/);
  if (bareNumber) return parseInt(bareNumber[1]!, 10);

  return null;
}
