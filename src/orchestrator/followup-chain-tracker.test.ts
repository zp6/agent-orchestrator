import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildFollowupChain,
  flattenChain,
  MAX_CHAIN_DEPTH,
  MAX_DEPTH_WARNING,
  COST_PER_1K_TOKENS_USD,
} from "./followup-chain-tracker.js";

// ── Logger mock ──────────────────────────────────────────────────────────────
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal StateStore mock. */
function makeStore(opts: {
  children?: Record<string, Array<{ source_ref: string; lineage_group_id: string; parent_source_ref: string; created_at: string }>>;
  tasks?: Record<string, Array<{ id: string }>>;
  stats?: Record<string, {
    task_count: number;
    agent_names: string[];
    avg_quality_score: number | null;
    total_tokens_in: number;
    total_tokens_out: number;
    pr_count: number;
  }>;
}) {
  return {
    getLineageChildren: vi.fn((sourceRef: string) => opts.children?.[sourceRef] ?? []),
    findAllTasksBySourceRef: vi.fn((sourceRef: string) => opts.tasks?.[sourceRef] ?? []),
    getChainStats: vi.fn((sourceRefs: string[]) => {
      const ref = sourceRefs[0] ?? "";
      return opts.stats?.[ref] ?? {
        task_count: 0,
        agent_names: [],
        avg_quality_score: null,
        total_tokens_in: 0,
        total_tokens_out: 0,
        pr_count: 0,
      };
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildFollowupChain", () => {
  it("returns a single root node with no children when there are no follow-ups", () => {
    const store = makeStore({
      tasks: { "owner/repo#1": [{ id: "task-1" }] },
      stats: {
        "owner/repo#1": {
          task_count: 1,
          agent_names: ["agent-a"],
          avg_quality_score: 0.9,
          total_tokens_in: 500,
          total_tokens_out: 250,
          pr_count: 1,
        },
      },
    });

    const result = buildFollowupChain(store as any, "owner/repo#1");

    expect(result.root.source_ref).toBe("owner/repo#1");
    expect(result.root.depth).toBe(0);
    expect(result.root.children).toHaveLength(0);
    expect(result.root.task_ids).toEqual(["task-1"]);
    expect(result.root.agent_names).toEqual(["agent-a"]);
    expect(result.root.total_tokens).toBe(750);
    expect(result.summary.total_issues).toBe(1);
    expect(result.summary.depth_warning).toBe(false);
    expect(result.summary.max_depth).toBe(0);
  });

  it("builds a two-level chain correctly", () => {
    const store = makeStore({
      children: {
        "owner/repo#1": [
          { source_ref: "owner/repo#2", lineage_group_id: "g1", parent_source_ref: "owner/repo#1", created_at: "2024-01-01" },
          { source_ref: "owner/repo#3", lineage_group_id: "g1", parent_source_ref: "owner/repo#1", created_at: "2024-01-02" },
        ],
      },
      tasks: {
        "owner/repo#1": [{ id: "t1" }],
        "owner/repo#2": [{ id: "t2" }],
        "owner/repo#3": [{ id: "t3" }],
      },
      stats: {
        "owner/repo#1": { task_count: 1, agent_names: ["agent-a"], avg_quality_score: 0.85, total_tokens_in: 1000, total_tokens_out: 500, pr_count: 1 },
        "owner/repo#2": { task_count: 1, agent_names: ["agent-b"], avg_quality_score: 0.7,  total_tokens_in: 200,  total_tokens_out: 100, pr_count: 0 },
        "owner/repo#3": { task_count: 1, agent_names: ["agent-a"], avg_quality_score: null, total_tokens_in: 300,  total_tokens_out: 150, pr_count: 0 },
      },
    });

    const result = buildFollowupChain(store as any, "owner/repo#1");

    expect(result.root.children).toHaveLength(2);
    expect(result.root.children[0].source_ref).toBe("owner/repo#2");
    expect(result.root.children[0].depth).toBe(1);
    expect(result.root.children[1].source_ref).toBe("owner/repo#3");
    expect(result.summary.total_issues).toBe(3);
    expect(result.summary.total_tasks).toBe(3);
    expect(result.summary.total_tokens).toBe(1000 + 500 + 200 + 100 + 300 + 150);
    expect(result.summary.max_depth).toBe(1);
    expect(result.summary.depth_warning).toBe(false);
    // Two quality scores: 0.85 + 0.7; null is excluded
    expect(result.summary.avg_quality_score).toBeCloseTo((0.85 + 0.7) / 2);
  });

  it("fires depth_warning when max_depth > MAX_DEPTH_WARNING", () => {
    // Build a chain of depth MAX_DEPTH_WARNING + 1 (i.e. 4 levels deep from root)
    const chainLength = MAX_DEPTH_WARNING + 2; // 6 nodes: root + 5 levels (last at depth 5 > 3)
    const children: Record<string, any[]> = {};
    const stats: Record<string, any> = {};
    const tasks: Record<string, any[]> = {};

    for (let i = 1; i <= chainLength; i++) {
      const ref = `owner/repo#${i}`;
      const nextRef = `owner/repo#${i + 1}`;
      stats[ref] = { task_count: 1, agent_names: [`agent-${i}`], avg_quality_score: null, total_tokens_in: 100, total_tokens_out: 50, pr_count: 0 };
      tasks[ref] = [{ id: `t${i}` }];
      if (i < chainLength) {
        children[ref] = [{ source_ref: nextRef, lineage_group_id: "g1", parent_source_ref: ref, created_at: `2024-01-01` }];
      }
    }

    const store = makeStore({ children, stats, tasks });
    const result = buildFollowupChain(store as any, "owner/repo#1");

    expect(result.summary.max_depth).toBeGreaterThan(MAX_DEPTH_WARNING);
    expect(result.summary.depth_warning).toBe(true);
  });

  it("stops at MAX_CHAIN_DEPTH (5) even if deeper children exist", () => {
    const children: Record<string, any[]> = {};
    const stats: Record<string, any> = {};
    const tasks: Record<string, any[]> = {};

    // Build 8 levels deep
    for (let i = 1; i <= 8; i++) {
      const ref = `owner/repo#${i}`;
      const nextRef = `owner/repo#${i + 1}`;
      stats[ref] = { task_count: 1, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 };
      tasks[ref] = [];
      if (i < 8) {
        children[ref] = [{ source_ref: nextRef, lineage_group_id: "g1", parent_source_ref: ref, created_at: `2024-01-01` }];
      }
    }

    const store = makeStore({ children, stats, tasks });
    const result = buildFollowupChain(store as any, "owner/repo#1");

    // Should stop at depth 5 (0-indexed)
    expect(result.summary.max_depth).toBe(MAX_CHAIN_DEPTH);
    // Total nodes: root (0) + 5 levels = 6 nodes
    expect(result.summary.total_issues).toBe(MAX_CHAIN_DEPTH + 1);
  });

  it("guards against cycles in lineage_mappings", () => {
    // owner/repo#1 → #2 → #1 (cycle)
    const store = makeStore({
      children: {
        "owner/repo#1": [{ source_ref: "owner/repo#2", lineage_group_id: "g1", parent_source_ref: "owner/repo#1", created_at: "2024-01-01" }],
        "owner/repo#2": [{ source_ref: "owner/repo#1", lineage_group_id: "g1", parent_source_ref: "owner/repo#2", created_at: "2024-01-02" }],
      },
      stats: {
        "owner/repo#1": { task_count: 1, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
        "owner/repo#2": { task_count: 1, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
      },
      tasks: {
        "owner/repo#1": [{ id: "t1" }],
        "owner/repo#2": [{ id: "t2" }],
      },
    });

    // Should not throw; cycle is skipped
    expect(() => buildFollowupChain(store as any, "owner/repo#1")).not.toThrow();
    const result = buildFollowupChain(store as any, "owner/repo#1");
    expect(result.summary.total_issues).toBe(2); // root + one child
  });

  it("computes cost estimate correctly", () => {
    const store = makeStore({
      stats: {
        "owner/repo#1": {
          task_count: 1,
          agent_names: [],
          avg_quality_score: null,
          total_tokens_in: 10_000,
          total_tokens_out: 5_000,
          pr_count: 0,
        },
      },
      tasks: { "owner/repo#1": [] },
    });

    const result = buildFollowupChain(store as any, "owner/repo#1");
    const expectedCost = (15_000 / 1000) * COST_PER_1K_TOKENS_USD;
    expect(result.summary.estimated_cost_usd).toBeCloseTo(expectedCost);
  });
});

// ── flattenChain tests ────────────────────────────────────────────────────────

describe("flattenChain", () => {
  it("returns BFS-ordered flat list", () => {
    const store = makeStore({
      children: {
        "a": [
          { source_ref: "b", lineage_group_id: "g", parent_source_ref: "a", created_at: "" },
          { source_ref: "c", lineage_group_id: "g", parent_source_ref: "a", created_at: "" },
        ],
        "b": [
          { source_ref: "d", lineage_group_id: "g", parent_source_ref: "b", created_at: "" },
        ],
      },
      stats: {
        a: { task_count: 0, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
        b: { task_count: 0, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
        c: { task_count: 0, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
        d: { task_count: 0, agent_names: [], avg_quality_score: null, total_tokens_in: 0, total_tokens_out: 0, pr_count: 0 },
      },
      tasks: { a: [], b: [], c: [], d: [] },
    });

    const result = buildFollowupChain(store as any, "a");
    const flat = flattenChain(result.root);

    expect(flat.map((n) => n.source_ref)).toEqual(["a", "b", "c", "d"]);
  });
});
