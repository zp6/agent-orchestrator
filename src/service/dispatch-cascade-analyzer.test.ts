/**
 * Tests for DispatchCascadeAnalyzer and CascadeCapEnforcer.
 *
 * Covers:
 * - findRootTask cycle detection (visited-set guard)
 * - buildNode cycle detection (shared visited Set)
 * - buildNode MAX_CASCADE_DEPTH ceiling
 * - canDispatchFollowUp fail-open behaviour
 * - taskCache cleared after each analyzeCascade call
 * - CascadeCapEnforcer delegation and alerting
 * - formatCapExceededAlert is public (no bracket-notation hack)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  DispatchCascadeAnalyzer,
  MAX_CASCADE_DEPTH,
} from "./dispatch-cascade-analyzer.js";
import { CascadeCapEnforcer, createCascadeCapEnforcer } from "./cascade-cap-enforcer.js";
import type { Task } from "../state/store.js";

// ── Test helpers ──────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: null,
    status: "done",
    agent_name: "test-agent",
    task_type: "implementation",
    source: null,
    source_ref: null,
    result: null,
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    parent_task_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

interface MockStore {
  getTask: ReturnType<typeof vi.fn>;
  getChildTasks: ReturnType<typeof vi.fn>;
}

function makeStore(tasks: Task[], childMap: Record<string, Task[]> = {}): MockStore {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  return {
    getTask: vi.fn((id: string) => taskMap.get(id) ?? null),
    getChildTasks: vi.fn((parentId: string) => childMap[parentId] ?? []),
  };
}

// ── findRootTask ──────────────────────────────────────────────────────────

describe("findRootTask", () => {
  it("walks up the parent chain to find the root", () => {
    const root = makeTask({ id: "root", parent_task_id: null });
    const mid = makeTask({ id: "mid", parent_task_id: "root" });
    const leaf = makeTask({ id: "leaf", parent_task_id: "mid" });
    const store = makeStore([root, mid, leaf]);

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const cascade = analyzer.analyzeCascade("leaf");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("root");
  });

  it("handles a single task with no parent", () => {
    const task = makeTask({ id: "solo", parent_task_id: null });
    const store = makeStore([task]);

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const cascade = analyzer.analyzeCascade("solo");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("solo");
  });

  it("breaks on circular parent reference (A → B → A) without hanging", () => {
    // A's parent is B, B's parent is A — a cycle
    const a = makeTask({ id: "a", parent_task_id: "b" });
    const b = makeTask({ id: "b", parent_task_id: "a" });
    const store = makeStore([a, b]);

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    // Must not hang — should break and use one of the cycle nodes as root
    const cascade = analyzer.analyzeCascade("a");

    // Cascade should be non-null because findRootTask breaks instead of returning null
    expect(cascade).not.toBeNull();
    // The root should be one of the cycle members (whichever we stopped at)
    expect(["a", "b"]).toContain(cascade!.root_task_id);
  });

  it("breaks on self-referencing parent (A → A)", () => {
    const a = makeTask({ id: "a", parent_task_id: "a" });
    const store = makeStore([a]);

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const cascade = analyzer.analyzeCascade("a");

    // Self-referencing: parent_task_id="a" is already in seen (current.id was added)
    // Actually current.id won't be in seen on first iteration because seen.add happens
    // after the check. Let me trace: seen={}, current=A, parent_task_id="a",
    // seen.has("a")=false, seen.add("a"), getTask("a")=A, current=A again.
    // Next iteration: seen={"a"}, current=A, parent_task_id="a", seen.has("a")=true → break.
    // So we get a result (not null) but it's safe — no infinite loop.
    expect(cascade).not.toBeNull();
  });

  it("breaks on long cycle (A → B → C → A)", () => {
    const a = makeTask({ id: "a", parent_task_id: "b" });
    const b = makeTask({ id: "b", parent_task_id: "c" });
    const c = makeTask({ id: "c", parent_task_id: "a" });
    const store = makeStore([a, b, c]);

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const cascade = analyzer.analyzeCascade("a");

    expect(cascade).not.toBeNull();
  });
});

// ── buildNode ─────────────────────────────────────────────────────────────

describe("buildNode — cycle detection via shared visited Set", () => {
  it("produces a leaf node when a child references a visited task", () => {
    const root = makeTask({ id: "root", parent_task_id: null });
    const child = makeTask({ id: "child", parent_task_id: "root" });
    // child claims root as its child too — cycle in child graph
    const store = makeStore([root, child], {
      root: [child],
      child: [root], // cycle back to root
    });

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const tree = analyzer.buildCascadeTree("root");

    expect(tree).not.toBeNull();
    expect(tree!.task_id).toBe("root");
    expect(tree!.children).toHaveLength(1);
    // The child's children should include root as a leaf (no further recursion)
    const childNode = tree!.children[0];
    expect(childNode.task_id).toBe("child");
    // root appears as a leaf in child's children — cycle truncated
    const cyclicLeaf = childNode.children.find((c) => c.task_id === "root");
    expect(cyclicLeaf).toBeDefined();
    expect(cyclicLeaf!.children).toHaveLength(0); // leaf, no further recursion
  });

  it("handles diamond-shaped graph (A→B, A→C, B→D, C→D) without duplication", () => {
    const a = makeTask({ id: "a" });
    const b = makeTask({ id: "b", parent_task_id: "a" });
    const c = makeTask({ id: "c", parent_task_id: "a" });
    const d = makeTask({ id: "d", parent_task_id: "b" }); // also child of c
    const store = makeStore([a, b, c, d], {
      a: [b, c],
      b: [d],
      c: [d], // d visited via b already; should be leaf here
    });

    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const tree = analyzer.buildCascadeTree("a");

    expect(tree).not.toBeNull();
    // d should appear once as a full node (via b) and once as a leaf (via c)
    const bNode = tree!.children.find((n) => n.task_id === "b");
    const cNode = tree!.children.find((n) => n.task_id === "c");
    expect(bNode!.children).toHaveLength(1);
    expect(bNode!.children[0].task_id).toBe("d");
    // d via c should be a leaf (already visited)
    const dViaC = cNode!.children.find((n) => n.task_id === "d");
    expect(dViaC).toBeDefined();
    expect(dViaC!.children).toHaveLength(0);
  });
});

describe("buildNode — MAX_CASCADE_DEPTH ceiling", () => {
  it("truncates tree at MAX_CASCADE_DEPTH to prevent stack overflow", () => {
    // Build a chain of depth MAX_CASCADE_DEPTH + 5
    const depth = MAX_CASCADE_DEPTH + 5;
    const tasks: Task[] = [];
    const childMap: Record<string, Task[]> = {};

    for (let i = 0; i < depth; i++) {
      const parentId = i === 0 ? null : `task-${i - 1}`;
      tasks.push(makeTask({ id: `task-${i}`, parent_task_id: parentId }));
      if (i > 0) {
        childMap[`task-${i - 1}`] = [tasks[i]];
      }
    }

    const store = makeStore(tasks, childMap);
    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const tree = analyzer.buildCascadeTree("task-0");

    expect(tree).not.toBeNull();

    // Walk to the deepest node
    let node = tree!;
    let maxReached = 0;
    while (node.children.length > 0) {
      node = node.children[0];
      maxReached = node.depth;
    }

    // The deepest node should be at most MAX_CASCADE_DEPTH
    expect(maxReached).toBeLessThanOrEqual(MAX_CASCADE_DEPTH);
  });
});

// ── canDispatchFollowUp ───────────────────────────────────────────────────

describe("canDispatchFollowUp — fail-open behaviour", () => {
  it("returns allowed: true when analyzeCascade returns null (store.getTask missing)", () => {
    // Store that has no getTask method — analysis will fail
    const emptyStore = {} as never;
    const analyzer = new DispatchCascadeAnalyzer(emptyStore, {});

    const result = analyzer.canDispatchFollowUp("nonexistent-task");
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("dispatch allowed");
  });

  it("returns allowed: true when task lookup throws", () => {
    const throwingStore = {
      getTask: () => {
        throw new Error("DB connection lost");
      },
    } as never;
    const analyzer = new DispatchCascadeAnalyzer(throwingStore, {});

    const result = analyzer.canDispatchFollowUp("any-task");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed: false when cascade is at capacity", () => {
    // Create a root with 2 follow-up children (cap = 2)
    const root = makeTask({ id: "root", title: "PR review" });
    const f1 = makeTask({ id: "f1", title: "follow-up: impl A", parent_task_id: "root" });
    const f2 = makeTask({ id: "f2", title: "follow-up: impl B", parent_task_id: "root" });
    const store = makeStore([root, f1, f2], {
      root: [f1, f2],
    });

    const analyzer = new DispatchCascadeAnalyzer(store as never, {
      maxCrossRepoFollowupDepth: 2,
    });

    const result = analyzer.canDispatchFollowUp("root");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("2 cross-repo");
  });

  it("returns allowed: true when cascade is under capacity", () => {
    const root = makeTask({ id: "root", title: "PR review" });
    const f1 = makeTask({ id: "f1", title: "follow-up: impl A", parent_task_id: "root" });
    const store = makeStore([root, f1], {
      root: [f1],
    });

    const analyzer = new DispatchCascadeAnalyzer(store as never, {
      maxCrossRepoFollowupDepth: 3,
    });

    const result = analyzer.canDispatchFollowUp("root");
    expect(result.allowed).toBe(true);
  });
});

// ── taskCache ─────────────────────────────────────────────────────────────

describe("taskCache", () => {
  it("is cleared after each analyzeCascade call", () => {
    const root = makeTask({ id: "root" });
    const store = makeStore([root]);
    const analyzer = new DispatchCascadeAnalyzer(store as never, {});

    analyzer.analyzeCascade("root");
    // First call: store.getTask called once for "root"
    expect(store.getTask).toHaveBeenCalledTimes(1);

    store.getTask.mockClear();
    analyzer.analyzeCascade("root");
    // Second call: store.getTask should be called again (cache was cleared)
    expect(store.getTask).toHaveBeenCalledTimes(1);
  });
});

// ── formatCapExceededAlert ────────────────────────────────────────────────

describe("formatCapExceededAlert", () => {
  it("is callable as a public method (no bracket-notation hack)", () => {
    const store = makeStore([]);
    const analyzer = new DispatchCascadeAnalyzer(store as never, { maxCrossRepoFollowupDepth: 2 });

    // This would fail to compile if the method were private
    const message = analyzer.formatCapExceededAlert({
      root_task_id: "task-abc12345",
      root_title: "Test cascade",
      total_tasks: 5,
      max_depth: 3,
      cross_repo_followup_count: 2,
      is_at_capacity: true,
      reason_at_capacity: "Cap reached",
      tree: {
        task_id: "task-abc12345",
        title: "Test cascade",
        agent_name: "test-agent",
        status: "done",
        depth: 0,
        is_cross_repo_followup: false,
        children: [],
        parent_task_id: null,
      },
    });

    expect(message).toContain("Dispatch Cascade Cap Exceeded");
    expect(message).toContain("Test cascade");
    expect(message).toContain("2/2");
  });
});

// ── CascadeCapEnforcer ────────────────────────────────────────────────────

describe("CascadeCapEnforcer", () => {
  it("allows non-follow-up dispatches without checking cascade", () => {
    const store = {} as never; // no methods — would fail if called
    const enforcer = new CascadeCapEnforcer(store, undefined, {});

    const result = enforcer.canDispatch(makeTask({ id: "t1" }), false);
    expect(result.allowed).toBe(true);
  });

  it("allows follow-ups when cascade is under cap", () => {
    const root = makeTask({ id: "root", title: "PR review" });
    const store = makeStore([root]);
    const enforcer = new CascadeCapEnforcer(store as never, undefined, {
      maxCrossRepoFollowupDepth: 5,
    });

    const result = enforcer.canDispatch(root, true);
    expect(result.allowed).toBe(true);
  });

  it("blocks follow-ups when cascade is at cap", () => {
    const root = makeTask({ id: "root", title: "PR review" });
    const f1 = makeTask({ id: "f1", title: "follow-up A", parent_task_id: "root" });
    const store = makeStore([root, f1], { root: [f1] });
    const enforcer = new CascadeCapEnforcer(store as never, undefined, {
      maxCrossRepoFollowupDepth: 1,
    });

    const result = enforcer.canDispatch(root, true);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("follow-up");
  });

  it("sends Telegram alert when cap is exceeded and notifier is provided", async () => {
    const root = makeTask({ id: "root", title: "PR review" });
    const f1 = makeTask({ id: "f1", title: "follow-up A", parent_task_id: "root" });
    const store = makeStore([root, f1], { root: [f1] });
    const notifyFn = vi.fn().mockResolvedValue(undefined);
    const enforcer = new CascadeCapEnforcer(store as never, notifyFn, {
      maxCrossRepoFollowupDepth: 1,
    });

    enforcer.canDispatch(root, true);

    // Wait for async alert to fire
    await vi.waitFor(() => {
      expect(notifyFn).toHaveBeenCalledTimes(1);
    });
    expect(notifyFn.mock.calls[0][0]).toContain("Dispatch Cascade Cap Exceeded");
  });

  it("createCascadeCapEnforcer factory returns a working enforcer", () => {
    const store = makeStore([makeTask({ id: "t1" })]);
    const enforcer = createCascadeCapEnforcer(store as never, undefined, {
      maxCrossRepoFollowupDepth: 5,
    });

    expect(enforcer).toBeInstanceOf(CascadeCapEnforcer);
    const result = enforcer.canDispatch(makeTask({ id: "t1" }), true);
    expect(result.allowed).toBe(true);
  });
});

// ── analyzeCascade summary ────────────────────────────────────────────────

describe("analyzeCascade", () => {
  it("returns correct summary for a simple cascade tree", () => {
    const root = makeTask({ id: "root", title: "PR review" });
    const f1 = makeTask({ id: "f1", title: "follow-up: fix A", parent_task_id: "root" });
    const f2 = makeTask({ id: "f2", title: "implement B", parent_task_id: "root" });
    const store = makeStore([root, f1, f2], { root: [f1, f2] });

    const analyzer = new DispatchCascadeAnalyzer(store as never, { maxCrossRepoFollowupDepth: 3 });
    const cascade = analyzer.analyzeCascade("f1");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("root");
    expect(cascade!.total_tasks).toBe(3);
    expect(cascade!.max_depth).toBe(1);
    expect(cascade!.cross_repo_followup_count).toBe(1); // f1 has "follow-up" in title
    expect(cascade!.is_at_capacity).toBe(false);
  });

  it("returns null gracefully when start task does not exist", () => {
    const store = makeStore([]);
    const analyzer = new DispatchCascadeAnalyzer(store as never, {});
    const cascade = analyzer.analyzeCascade("nonexistent");

    expect(cascade).toBeNull();
  });
});
