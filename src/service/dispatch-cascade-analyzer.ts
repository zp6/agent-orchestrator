/**
 * Dispatch cascade analyzer — tracks parent→child task relationships and
 * enforces per-trigger follow-up caps to prevent unbounded task spawning.
 *
 * A "cascade" is a chain of tasks spawned from a single trigger (e.g., PR review).
 * Each task can spawn child tasks (cross-repo follow-ups), creating a tree.
 * This module provides visibility into the tree structure and enforces a
 * configurable cap on cross-repo follow-up depth.
 *
 * Issue #984: Dispatch cascade explorer in dashboard.
 *
 * Usage:
 *
 *   import { DispatchCascadeAnalyzer } from './dispatch-cascade-analyzer.js';
 *
 *   const analyzer = new DispatchCascadeAnalyzer(store, {
 *     maxCrossRepoFollowupDepth: 2,  // e.g., max 2 follow-ups per PR review
 *   });
 *
 *   // Check if a new dispatch would exceed the cap
 *   const cascade = analyzer.analyzeCascade(sourceTaskId);
 *   if (!cascade.canAddFollowUp()) {
 *     // Block dispatch and alert operator
 *     notifier.send(cascade.formatCapExceededAlert());
 *   }
 *
 *   // Get full tree for dashboard
 *   const tree = analyzer.buildCascadeTree(sourceTaskId);
 *   // Render tree in UI
 */

import type { Task, StateStore } from "../state/store.js";
import { createLogger } from "./logger.js";

const log = createLogger("dispatch-cascade-analyzer");

/** Configuration for cascade analysis. */
export interface DispatchCascadeAnalyzerOptions {
  /**
   * Maximum depth of cross-repo follow-ups allowed from a single trigger.
   * Default: 2 (e.g., PR review → implementation → follow-up, no deeper).
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

/** Summary of a dispatch cascade. */
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

/**
 * Hard ceiling on tree depth to prevent stack overflow from extremely deep
 * (but non-cyclic) cascades or buggy data.  Visited-set guards handle cycles;
 * this is the belt-and-suspenders fallback.
 */
export const MAX_CASCADE_DEPTH = 50;

/**
 * Analyzer for dispatch cascades.
 * Provides tree traversal, depth analysis, and cap enforcement.
 */
export class DispatchCascadeAnalyzer {
  private maxCrossRepoFollowupDepth: number;
  private taskCache: Map<string, Task> = new Map();

  constructor(
    private store: StateStore,
    opts: DispatchCascadeAnalyzerOptions = {},
  ) {
    this.maxCrossRepoFollowupDepth = opts.maxCrossRepoFollowupDepth ?? 2;
  }

  /**
   * Analyze the dispatch cascade starting from a given task.
   * Returns whether new follow-ups can be dispatched and tree structure.
   */
  analyzeCascade(taskId: string): CascadeSummary | null {
    try {
      // Get the root task (walk up parent chain)
      const rootTask = this.findRootTask(taskId);
      if (!rootTask) {
        log.warn("Could not find root task for cascade analysis", { task_id: taskId });
        return null;
      }

      // Build the cascade tree
      const tree = this.buildCascadeTree(rootTask.id);
      if (!tree) {
        return null;
      }

      // Analyze the tree
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
          ? `Maximum ${this.maxCrossRepoFollowupDepth} cross-repo follow-ups already spawned from this trigger`
          : null,
        tree,
      };
    } catch (err) {
      log.error("Error analyzing cascade", { task_id: taskId, error: String(err) });
      return null;
    } finally {
      // Clear the per-call task cache to prevent unbounded memory growth
      this.taskCache.clear();
    }
  }

  /**
   * Build a cascade tree starting from a root task ID.
   */
  buildCascadeTree(rootTaskId: string): CascadeNode | null {
    const rootTask = this.getTask(rootTaskId);
    if (!rootTask) return null;

    return this.buildNode(rootTask, 0, null, new Set<string>());
  }

  /**
   * Format a Telegram alert message when the cascade cap is exceeded.
   */
  public formatCapExceededAlert(cascade: CascadeSummary): string {
    return `⚠️ *Dispatch Cascade Cap Exceeded*

*Trigger:* ${cascade.root_title}
*Source:* Task ${cascade.root_task_id.slice(0, 8)}

*Cascade Stats:*
• Total tasks: ${cascade.total_tasks}
• Cross-repo follow-ups: ${cascade.cross_repo_followup_count}/${this.maxCrossRepoFollowupDepth}
• Max depth: ${cascade.max_depth} levels

*Issue:* The configured cap (${this.maxCrossRepoFollowupDepth} cross-repo follow-ups) has been reached.
No new follow-up tasks will be dispatched until this cascade is resolved.

*Action:* Review the cascade tree in the dashboard and consider:
1. Merging or closing completed tasks to free up capacity
2. Adjusting the follow-up cap if broader scope is needed
3. Breaking the cascade into smaller, sequential changes`;
  }

  /**
   * Check if a new follow-up can be dispatched from the given task.
   * Fails open — if analysis cannot be performed, dispatch is allowed
   * (with a warning log) to avoid blocking work due to analysis errors.
   */
  canDispatchFollowUp(taskId: string): { allowed: boolean; reason?: string } {
    const cascade = this.analyzeCascade(taskId);
    if (!cascade) {
      log.warn("Could not analyze cascade — failing open, dispatch allowed", { task_id: taskId });
      return { allowed: true, reason: "Cascade analysis unavailable — dispatch allowed by default" };
    }

    if (cascade.is_at_capacity) {
      return {
        allowed: false,
        reason: cascade.reason_at_capacity || "Cascade cap reached",
      };
    }

    return { allowed: true };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private getTask(taskId: string): Task | null {
    // Check cache first
    if (this.taskCache.has(taskId)) {
      return this.taskCache.get(taskId) ?? null;
    }

    // Try to fetch from store (implementation depends on store interface)
    try {
      // Attempt to fetch task (may require custom method on store)
      const task = (this.store as unknown as { getTask?: (id: string) => Task | null }).getTask?.(taskId);
      if (task) {
        this.taskCache.set(taskId, task);
      }
      return task ?? null;
    } catch {
      return null;
    }
  }

  private findRootTask(taskId: string): Task | null {
    const seen = new Set<string>();
    let current = this.getTask(taskId);
    while (current && current.parent_task_id) {
      // If the parent we're about to follow is a node we've already visited,
      // we have a circular parent_task_id chain — return null so the caller
      // (analyzeCascade) treats this cascade as unanalyzable and fails open.
      if (seen.has(current.parent_task_id)) {
        log.warn("Cycle detected in parent_task_id chain — aborting root walk", {
          task_id: taskId,
          cycle_at: current.parent_task_id,
          visited_count: seen.size,
        });
        return null;
      }
      seen.add(current.id);
      const parent = this.getTask(current.parent_task_id);
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  private buildNode(
    task: Task,
    depth: number,
    parentId: string | null,
    visited: Set<string>,
  ): CascadeNode {
    // Mark this node as visited before recursing into its children
    visited.add(task.id);

    // Hard depth ceiling — prevents stack overflow from extremely deep
    // (non-cyclic) trees or corrupted data
    if (depth >= MAX_CASCADE_DEPTH) {
      log.warn("Cascade tree exceeded MAX_CASCADE_DEPTH — truncating", {
        task_id: task.id,
        depth,
        max: MAX_CASCADE_DEPTH,
      });
      return {
        task_id: task.id,
        title: task.title,
        agent_name: task.agent_name,
        status: task.status,
        depth,
        is_cross_repo_followup: this.isCrossRepoTask(task),
        children: [],
        parent_task_id: parentId,
      };
    }

    // Get all children — check for cycles BEFORE recursing (shared visited Set)
    const allChildren = this.getChildTasks(task.id);
    const childNodes = allChildren.map((child) => {
      if (visited.has(child.id)) {
        log.warn("Cycle detected in task child graph — returning leaf node", {
          task_id: child.id,
          depth: depth + 1,
        });
        // Return a leaf to safely terminate this branch without recursing
        return {
          task_id: child.id,
          title: child.title,
          agent_name: child.agent_name,
          status: child.status,
          depth: depth + 1,
          is_cross_repo_followup: this.isCrossRepoTask(child),
          children: [],
          parent_task_id: task.id,
        } as CascadeNode;
      }
      return this.buildNode(child, depth + 1, task.id, visited);
    });

    // Determine if this is a cross-repo follow-up
    const isCrossRepoFollowup = this.isCrossRepoTask(task);

    return {
      task_id: task.id,
      title: task.title,
      agent_name: task.agent_name,
      status: task.status,
      depth,
      is_cross_repo_followup: isCrossRepoFollowup,
      children: childNodes,
      parent_task_id: parentId,
    };
  }

  private getChildTasks(parentTaskId: string): Task[] {
    // This requires querying the store for tasks with parent_task_id = parentTaskId
    // Implementation depends on store interface
    try {
      const children = (this.store as unknown as { getChildTasks?: (id: string) => Task[] }).getChildTasks?.(
        parentTaskId,
      );
      return children ?? [];
    } catch {
      return [];
    }
  }

  private isCrossRepoTask(task: Task): boolean {
    // A task is a cross-repo follow-up if its title contains [follow-up] or similar markers
    // Or if we can detect it from the task metadata
    const lowerTitle = task.title.toLowerCase();
    return lowerTitle.includes("follow-up") || lowerTitle.includes("followup");
  }

  private computeMaxDepth(node: CascadeNode): number {
    if (node.children.length === 0) return node.depth;
    return Math.max(node.depth, ...node.children.map((child) => this.computeMaxDepth(child)));
  }

  private countCrossRepoFollowups(node: CascadeNode): number {
    let count = 0;
    if (node.is_cross_repo_followup) count += 1;
    for (const child of node.children) {
      count += this.countCrossRepoFollowups(child);
    }
    return count;
  }

  private countNodes(node: CascadeNode): number {
    return 1 + node.children.reduce((sum, child) => sum + this.countNodes(child), 0);
  }
}
