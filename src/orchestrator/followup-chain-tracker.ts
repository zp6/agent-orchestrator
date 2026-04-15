/**
 * Follow-up chain tracker (issue #838).
 *
 * Given a root GitHub issue (`owner/repo#N`), walks the `lineage_mappings`
 * table to build a tree of all follow-up issues spawned from it — directly
 * or transitively.  Each node carries:
 *   - The GitHub source ref
 *   - The tasks dispatched for that issue
 *   - The agents that worked on it
 *   - Average quality score
 *   - Cumulative token counts (input + output)
 *   - The depth from the root
 *
 * Depth warnings fire when depth > 3 (configurable via MAX_DEPTH_WARNING).
 * The walk stops at MAX_CHAIN_DEPTH (default 5) to prevent runaway traversal.
 */

import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("followup-chain-tracker");

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum depth the traversal will descend before stopping. */
export const MAX_CHAIN_DEPTH = 5;

/** Chains with depth exceeding this value should render a warning badge. */
export const MAX_DEPTH_WARNING = 3;

/** Estimated cost per 1 000 tokens (USD) — rough blended rate for claude-sonnet. */
export const COST_PER_1K_TOKENS_USD = 0.003;

// ── Types ────────────────────────────────────────────────────────────────────

/** A single node in the follow-up chain tree. */
export interface ChainNode {
  /** GitHub source ref, e.g. "owner/repo#42" */
  source_ref: string;
  /** Depth from root (root = 0). */
  depth: number;
  /** Whether this node was discovered via lineage_mappings (false = synthesised root). */
  is_synthetic_root: boolean;
  /** Task IDs for root-level tasks dispatched for this source_ref. */
  task_ids: string[];
  /** Distinct agent names that worked on this issue. */
  agent_names: string[];
  /** Average quality score across verified tasks, or null if none verified. */
  avg_quality_score: number | null;
  /** Cumulative input tokens across all task logs for this issue. */
  tokens_in: number;
  /** Cumulative output tokens across all task logs for this issue. */
  tokens_out: number;
  /** Total tokens (in + out). */
  total_tokens: number;
  /** Number of approved tasks (proxy for merged PRs). */
  pr_count: number;
  /** Direct children of this node (follow-up issues spawned by this issue). */
  children: ChainNode[];
}

/** Summary statistics for the entire chain rooted at a given issue. */
export interface ChainSummary {
  /** Root source ref. */
  root_source_ref: string;
  /** Maximum depth reached in the tree. */
  max_depth: number;
  /** Total number of issues in the tree (including root). */
  total_issues: number;
  /** Total number of tasks dispatched across the whole tree. */
  total_tasks: number;
  /** Total approved tasks across the tree (proxy for merged PRs). */
  total_prs: number;
  /** Distinct agent names across the whole tree. */
  agent_names: string[];
  /** Total tokens consumed across the whole tree. */
  total_tokens: number;
  /** Estimated USD cost based on blended token rate. */
  estimated_cost_usd: number;
  /** Average quality score across all verified tasks in the tree, or null. */
  avg_quality_score: number | null;
  /** True when max_depth > MAX_DEPTH_WARNING — operator should investigate. */
  depth_warning: boolean;
}

/** Full result returned by `buildFollowupChain`. */
export interface FollowupChainResult {
  root: ChainNode;
  summary: ChainSummary;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Recursively build the chain tree starting at `sourceRef`.
 * `visited` guards against cycles (lineage_mappings cycles are unexpected but
 * possible if data is malformed).
 */
function buildNode(
  store: StateStore,
  sourceRef: string,
  depth: number,
  maxDepth: number,
  visited: Set<string>,
): ChainNode {
  visited.add(sourceRef);

  // Gather stats for this node from the store
  const stats = store.getChainStats([sourceRef]);

  // Fetch task IDs associated with this source_ref
  const tasks = store.findAllTasksBySourceRef(sourceRef);
  const taskIds = tasks.map((t) => t.id);

  const node: ChainNode = {
    source_ref: sourceRef,
    depth,
    is_synthetic_root: depth === 0,
    task_ids: taskIds,
    agent_names: stats.agent_names,
    avg_quality_score: stats.avg_quality_score,
    tokens_in: stats.total_tokens_in,
    tokens_out: stats.total_tokens_out,
    total_tokens: stats.total_tokens_in + stats.total_tokens_out,
    pr_count: stats.pr_count,
    children: [],
  };

  // Stop recursion at max depth
  if (depth >= maxDepth) {
    if (depth === maxDepth) {
      log.debug("Reached max chain depth, stopping", { sourceRef, depth });
    }
    return node;
  }

  // Walk children
  const children = store.getLineageChildren(sourceRef);
  for (const child of children) {
    if (visited.has(child.source_ref)) {
      log.warn("Cycle detected in lineage_mappings, skipping", {
        parent: sourceRef,
        child: child.source_ref,
      });
      continue;
    }
    node.children.push(
      buildNode(store, child.source_ref, depth + 1, maxDepth, visited),
    );
  }

  return node;
}

/** Recursively gather summary statistics from a built tree. */
function gatherSummary(
  node: ChainNode,
  acc: {
    issues: number;
    tasks: number;
    prs: number;
    tokens: number;
    maxDepth: number;
    agents: Set<string>;
    qualityScores: number[];
  },
): void {
  acc.issues += 1;
  acc.tasks += node.task_ids.length;
  acc.prs += node.pr_count;
  acc.tokens += node.total_tokens;
  if (node.depth > acc.maxDepth) acc.maxDepth = node.depth;
  for (const a of node.agent_names) acc.agents.add(a);
  if (node.avg_quality_score !== null) acc.qualityScores.push(node.avg_quality_score);

  for (const child of node.children) {
    gatherSummary(child, acc);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the full follow-up chain tree rooted at `rootSourceRef`.
 *
 * @param store         - StateStore instance (opened by caller).
 * @param rootSourceRef - GitHub source ref, e.g. "owner/repo#42".
 * @param maxDepth      - Maximum tree depth (default MAX_CHAIN_DEPTH = 5).
 * @returns FollowupChainResult with root node + summary stats.
 */
export function buildFollowupChain(
  store: StateStore,
  rootSourceRef: string,
  maxDepth: number = MAX_CHAIN_DEPTH,
): FollowupChainResult {
  const clampedDepth = Math.min(Math.max(maxDepth, 1), MAX_CHAIN_DEPTH);

  log.debug("Building followup chain", { rootSourceRef, maxDepth: clampedDepth });

  const visited = new Set<string>();
  const root = buildNode(store, rootSourceRef, 0, clampedDepth, visited);

  const acc = {
    issues: 0,
    tasks: 0,
    prs: 0,
    tokens: 0,
    maxDepth: 0,
    agents: new Set<string>(),
    qualityScores: [] as number[],
  };
  gatherSummary(root, acc);

  const avgQuality =
    acc.qualityScores.length > 0
      ? acc.qualityScores.reduce((s, v) => s + v, 0) / acc.qualityScores.length
      : null;

  const summary: ChainSummary = {
    root_source_ref: rootSourceRef,
    max_depth: acc.maxDepth,
    total_issues: acc.issues,
    total_tasks: acc.tasks,
    total_prs: acc.prs,
    agent_names: [...acc.agents],
    total_tokens: acc.tokens,
    estimated_cost_usd: (acc.tokens / 1000) * COST_PER_1K_TOKENS_USD,
    avg_quality_score: avgQuality,
    depth_warning: acc.maxDepth > MAX_DEPTH_WARNING,
  };

  log.info("Follow-up chain built", {
    root: rootSourceRef,
    totalIssues: summary.total_issues,
    totalTasks: summary.total_tasks,
    maxDepth: summary.max_depth,
    depthWarning: summary.depth_warning,
  });

  return { root, summary };
}

/**
 * Flatten a chain tree into a list ordered by depth (BFS order).
 * Useful for JSON output and dashboard rendering.
 */
export function flattenChain(root: ChainNode): ChainNode[] {
  const result: ChainNode[] = [];
  const queue: ChainNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const child of node.children) {
      queue.push(child);
    }
  }
  return result;
}
