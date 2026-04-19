/**
 * Dispatch cascade analyzer for the reviewer agent (issue #344 / #984).
 *
 * A "cascade" is a chain of tasks spawned from a single trigger (e.g., a PR
 * review that spawns cross-repo implementation follow-ups, which in turn spawn
 * their own follow-ups).  Unchecked cascades can produce unbounded task trees
 * that exhaust agent capacity and obscure the originating trigger.
 *
 * This module gives the reviewer's **supervisor** visibility into cascade
 * structure so it can:
 *   - Surface cascade depth and cross-repo follow-up counts in supervision context
 *   - Gate new follow-up dispatches when a configured cap is exceeded (fail-open
 *     when cascade is unanalyzable — correctness concerns must not block work)
 *   - Format operator-facing alerts via the notifier when the cap is hit
 *
 * ## Cycle safety
 *
 * Two independent guards prevent infinite loops:
 *
 * 1. **`findRootTask`** — uses a `seen` Set of visited task IDs.  If the next
 *    parent is already in `seen`, the chain is cyclic and the function returns
 *    **`null`** (NOT `break` — which incorrectly returned the last visited node
 *    as a synthetic "root", producing misleading cascade data).  `analyzeCascade`
 *    treats a `null` root as "unanalyzable" and returns `null`, causing
 *    `canDispatchFollowUp` to **fail open** (allow the dispatch with a warning).
 *
 * 2. **`buildNode`** — receives a shared `visited` Set through all recursive
 *    calls.  If a child task ID is already visited, the recursion is terminated
 *    with a leaf node instead of re-entering the subtree.
 *
 * A hard depth ceiling (`MAX_CASCADE_DEPTH = 50`) is the belt-and-suspenders
 * third defence against extremely deep but technically non-cyclic trees.
 *
 * ## Usage
 *
 * ```ts
 * const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 2 });
 *
 * const result = analyzer.canDispatchFollowUp(taskId);
 * if (!result.allowed) {
 *   await notifier.send(result.alertMessage ?? "Cascade cap exceeded");
 * }
 * ```
 *
 * @see https://github.com/rapartlu/agent-reviewer/issues/344
 * @see https://github.com/rapartlu/agent-orchestrator/pull/990 (reference implementation)
 */

import { createLogger } from "../service/logger.js";
import type { Task, IStateStore } from "../state/types.js";

const log = createLogger("dispatch-cascade-analyzer");

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Hard ceiling on cascade tree depth.
 * Prevents stack overflow from extremely deep (but non-cyclic) trees or
 * corrupted parent_task_id data.  The visited-Set in findRootTask and buildNode
 * handles true cycles; this is the belt-and-suspenders fallback.
 */
export const MAX_CASCADE_DEPTH = 50;

/** Default maximum cross-repo follow-up dispatches per cascade root. */
export const DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH = 2;

// ── Types ──────────────────────────────────────────────────────────────────

/** Configuration for cascade analysis. */
export interface DispatchCascadeAnalyzerOptions {
  /**
   * Maximum number of cross-repo follow-up tasks allowed from a single root
   * trigger before new dispatches are blocked.  Default: 2.
   */
  maxCrossRepoFollowupDepth?: number;
}

/** A single node in the cascade tree. */
export interface CascadeNode {
  task_id: string;
  title: string;
  agent_name: string | null;
  status: string;
  depth: number;
  is_cross_repo_followup: boolean;
  children: CascadeNode[];
  parent_task_id: string | null;
}

/** Aggregated summary of a dispatch cascade. */
export interface CascadeSummary {
  root_task_id: string;
  root_title: string;
  total_tasks: number;
  max_depth: number;
  cross_repo_followup_count: number;
  is_at_capacity: boolean;
  reason_at_capacity: string | null;
  tree: CascadeNode;
}

/** Result of the pre-dispatch follow-up check. */
export interface FollowUpDispatchResult {
  /** Whether the new follow-up dispatch is allowed. */
  allowed: boolean;
  /** Human-readable reason when blocked. */
  reason?: string;
  /** Pre-formatted Telegram alert to send when blocked (non-null when allowed=false). */
  alertMessage?: string;
  /** Cascade summary when successfully analyzed (null when unanalyzable — fail-open). */
  cascade: CascadeSummary | null;
}

// ── Analyzer ──────────────────────────────────────────────────────────────

/**
 * Analyzes dispatch cascades for the reviewer's supervisor.
 *
 * Reads task hierarchy from the shared `IStateStore` (state.db) and provides
 * depth analysis, cross-repo follow-up counting, and cap enforcement.
 */
export class DispatchCascadeAnalyzer {
  private readonly maxCrossRepoFollowupDepth: number;

  /**
   * Per-call task cache.  Populated during a single `analyzeCascade` call and
   * cleared in `finally` to prevent unbounded memory growth across many calls.
   */
  private taskCache: Map<string, Task> = new Map();

  constructor(
    private readonly store: Pick<IStateStore, "getTask" | "getChildTasks">,
    opts: DispatchCascadeAnalyzerOptions = {},
  ) {
    this.maxCrossRepoFollowupDepth =
      opts.maxCrossRepoFollowupDepth ?? DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Analyze the cascade that contains `taskId` and return a summary.
   *
   * Returns `null` when the cascade is unanalyzable (e.g. root not found, cycle
   * detected, store error).  Callers **must** treat `null` as fail-open —
   * `canDispatchFollowUp` does this automatically.
   */
  analyzeCascade(taskId: string): CascadeSummary | null {
    try {
      const rootTask = this.findRootTask(taskId);
      if (!rootTask) {
        log.warn("Could not find root task for cascade analysis — failing open", {
          task_id: taskId,
        });
        return null;
      }

      const tree = this.buildCascadeTree(rootTask.id);
      if (!tree) {
        log.warn("Could not build cascade tree — failing open", {
          root_task_id: rootTask.id,
          task_id: taskId,
        });
        return null;
      }

      const maxDepth = this.computeMaxDepth(tree);
      const crossRepoCount = this.countCrossRepoFollowups(tree);
      const isAtCapacity = crossRepoCount >= this.maxCrossRepoFollowupDepth;

      return {
        root_task_id: rootTask.id,
        root_title: rootTask.title,
        total_tasks: this.countNodes(tree),
        max_depth: maxDepth,
        cross_repo_followup_count: crossRepoCount,
        is_at_capacity: isAtCapacity,
        reason_at_capacity: isAtCapacity
          ? `Maximum ${this.maxCrossRepoFollowupDepth} cross-repo follow-ups already spawned from trigger "${rootTask.title}"`
          : null,
        tree,
      };
    } catch (err) {
      log.error("Unexpected error in analyzeCascade — failing open", {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      // Clear per-call cache to prevent unbounded memory growth
      this.taskCache.clear();
    }
  }

  /**
   * Check whether a new follow-up dispatch from `taskId` is allowed.
   *
   * **Fail-open contract**: when the cascade is unanalyzable (null cascade),
   * this returns `{ allowed: true }` with a warning so analysis failures never
   * silently block legitimate dispatches.
   */
  canDispatchFollowUp(taskId: string): FollowUpDispatchResult {
    const cascade = this.analyzeCascade(taskId);

    if (cascade === null) {
      // Unanalyzable — fail open
      log.warn("Cascade unanalyzable — allowing dispatch (fail-open)", { task_id: taskId });
      return { allowed: true, cascade: null };
    }

    if (cascade.is_at_capacity) {
      const alertMessage = this.formatCapExceededAlert(cascade);
      log.warn("Cascade cap exceeded — blocking follow-up dispatch", {
        task_id: taskId,
        root_task_id: cascade.root_task_id,
        cross_repo_followup_count: cascade.cross_repo_followup_count,
        max: this.maxCrossRepoFollowupDepth,
      });
      return {
        allowed: false,
        reason: cascade.reason_at_capacity ?? "Cascade cap exceeded",
        alertMessage,
        cascade,
      };
    }

    return { allowed: true, cascade };
  }

  /**
   * Build a cascade tree rooted at `rootTaskId`.
   * Returns `null` when the root task does not exist in the store.
   */
  buildCascadeTree(rootTaskId: string): CascadeNode | null {
    const rootTask = this.getTask(rootTaskId);
    if (!rootTask) return null;
    return this.buildNode(rootTask, 0, null, new Set<string>());
  }

  /**
   * Format a Telegram-friendly alert when the cascade cap is exceeded.
   *
   * @param cascade - The analyzed cascade (must have `is_at_capacity === true`).
   */
  public formatCapExceededAlert(cascade: CascadeSummary): string {
    const lines = [
      "⚠️ *Dispatch Cascade Cap Exceeded*",
      "",
      `*Root trigger:* ${cascade.root_title}`,
      `*Root task ID:* \`${cascade.root_task_id}\``,
      "",
      "*Cascade stats:*",
      `• Total tasks: ${cascade.total_tasks}`,
      `• Cross-repo follow-ups: ${cascade.cross_repo_followup_count}/${this.maxCrossRepoFollowupDepth}`,
      `• Max depth: ${cascade.max_depth} levels`,
      "",
      `*Issue:* The configured cap (${this.maxCrossRepoFollowupDepth} cross-repo follow-ups) has been reached.`,
      "No new follow-up tasks will be dispatched until this cascade is resolved.",
      "",
      "*Action:* Review the cascade tree and consider merging/closing tasks.",
    ];
    return lines.join("\n");
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Walk up the `parent_task_id` chain to find the root task.
   *
   * **Cycle safety**: uses a `seen` Set.  If the next parent ID has already been
   * visited, the chain is circular — the function returns **`null`** (not the
   * last visited node) so `analyzeCascade` can correctly fail open.  Using
   * `break` here would be wrong: it would return a cycle member as the "root",
   * producing a subtree rooted at an arbitrary cycle node instead of signalling
   * that the cascade is unanalyzable.
   */
  private findRootTask(taskId: string): Task | null {
    const seen = new Set<string>();
    let current = this.getTask(taskId);

    while (current && current.parent_task_id) {
      if (seen.has(current.parent_task_id)) {
        log.warn("Cycle detected in parent_task_id chain — aborting root walk", {
          task_id: taskId,
          cycle_at: current.parent_task_id,
          visited_count: seen.size,
        });
        return null;  // NOT break — break returns a cycle member as synthetic root
      }
      seen.add(current.id);
      const parent = this.getTask(current.parent_task_id);
      if (!parent) break;
      current = parent;
    }

    return current;
  }

  /**
   * Recursively build a cascade node for `task` and all its descendants.
   *
   * @param visited - Shared Set across the entire buildNode recursion.  Prevents
   *                  re-entering subtrees when a child appears in multiple paths
   *                  (should not happen in a well-formed tree, but guards against
   *                  corrupted data).
   */
  private buildNode(
    task: Task,
    depth: number,
    parentId: string | null,
    visited: Set<string>,
  ): CascadeNode {
    visited.add(task.id);

    // Hard depth ceiling — belt-and-suspenders guard against extremely deep trees
    if (depth >= MAX_CASCADE_DEPTH) {
      log.warn("Cascade tree exceeded MAX_CASCADE_DEPTH — truncating subtree", {
        task_id: task.id,
        depth,
        max: MAX_CASCADE_DEPTH,
      });
      return {
        task_id: task.id,
        title: task.title,
        agent_name: task.agent_name ?? null,
        status: task.status,
        depth,
        is_cross_repo_followup: this.isCrossRepoFollowup(task),
        children: [],
        parent_task_id: parentId,
      };
    }

    const allChildren = this.getChildTasks(task.id);
    const childNodes: CascadeNode[] = allChildren.map((child) => {
      if (visited.has(child.id)) {
        log.warn("Cycle detected in task child graph — returning leaf node", {
          task_id: child.id,
          parent_id: task.id,
          depth: depth + 1,
        });
        return {
          task_id: child.id,
          title: child.title,
          agent_name: child.agent_name ?? null,
          status: child.status,
          depth: depth + 1,
          is_cross_repo_followup: this.isCrossRepoFollowup(child),
          children: [],
          parent_task_id: task.id,
        } as CascadeNode;
      }
      return this.buildNode(child, depth + 1, task.id, visited);
    });

    return {
      task_id: task.id,
      title: task.title,
      agent_name: task.agent_name ?? null,
      status: task.status,
      depth,
      is_cross_repo_followup: this.isCrossRepoFollowup(task),
      children: childNodes,
      parent_task_id: parentId,
    };
  }

  /**
   * Classify a task as a cross-repo follow-up.
   * Detects the `[follow-up]` / `[revision]` / "cross-repo" markers that the
   * orchestrator injects when spawning follow-up tasks for another agent's repo.
   */
  private isCrossRepoFollowup(task: Task): boolean {
    const lower = task.title.toLowerCase();
    return (
      lower.includes("[follow-up]") ||
      lower.includes("follow-up") ||
      lower.includes("followup") ||
      lower.includes("cross-repo") ||
      lower.includes("[revision]")
    );
  }

  private getTask(taskId: string): Task | null {
    if (this.taskCache.has(taskId)) {
      return this.taskCache.get(taskId) ?? null;
    }
    const task = this.store.getTask(taskId) ?? null;
    if (task) {
      this.taskCache.set(taskId, task);
    }
    return task;
  }

  private getChildTasks(parentTaskId: string): Task[] {
    try {
      return this.store.getChildTasks(parentTaskId);
    } catch {
      return [];
    }
  }

  private computeMaxDepth(node: CascadeNode): number {
    if (node.children.length === 0) return node.depth;
    return Math.max(node.depth, ...node.children.map((c) => this.computeMaxDepth(c)));
  }

  private countCrossRepoFollowups(node: CascadeNode): number {
    let count = node.is_cross_repo_followup ? 1 : 0;
    for (const child of node.children) {
      count += this.countCrossRepoFollowups(child);
    }
    return count;
  }

  private countNodes(node: CascadeNode): number {
    return 1 + node.children.reduce((sum, c) => sum + this.countNodes(c), 0);
  }
}
