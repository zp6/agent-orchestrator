/**
 * Unit tests for DispatchCascadeAnalyzer (issue #344 / #984).
 *
 * Covers:
 *   - Normal cascade analysis (linear chain, tree, deep tree)
 *   - Cycle safety: findRootTask must return null (NOT break + return a cycle member)
 *   - Fail-open: canDispatchFollowUp allows dispatch when cascade is null
 *   - Cap enforcement: blocks dispatch when cross-repo follow-up count >= max
 *   - Alert formatting
 *   - Task cache is cleared between calls
 */

import { describe, it, expect } from "vitest";
import {
  DispatchCascadeAnalyzer,
  MAX_CASCADE_DEPTH,
  DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH,
  type CascadeNode,
  type CascadeSummary,
} from "../reviewer/dispatch-cascade-analyzer.js";
import type { Task } from "../state/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _idSeq = 0;
function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? `task-${++_idSeq}`;
  return {
    id,
    title: "Test task",
    status: "done",
    task_type: "implementation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    parent_task_id: null,
    agent_name: "test-agent",
    ...overrides,
  };
}

/**
 * Build a minimal store mock from a flat list of tasks.
 * Supports getTask() and getChildTasks().
 */
function makeStore(tasks: Task[]): Pick<{ getTask: (id: string) => Task | null; getChildTasks: (pid: string) => Task[] }, "getTask" | "getChildTasks"> {
  const byId = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  return {
    getTask: (id: string) => byId.get(id) ?? null,
    getChildTasks: (parentId: string) =>
      tasks.filter((t) => t.parent_task_id === parentId),
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("MAX_CASCADE_DEPTH is 50", () => {
    expect(MAX_CASCADE_DEPTH).toBe(50);
  });

  it("DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH is 2", () => {
    expect(DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH).toBe(2);
  });
});

// ── findRootTask / analyzeCascade ─────────────────────────────────────────────

describe("analyzeCascade — linear chains", () => {
  it("returns the task itself as root when it has no parent", () => {
    const root = makeTask({ id: "solo", parent_task_id: null });
    const store = makeStore([root]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("solo");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("solo");
    expect(cascade!.total_tasks).toBe(1);
  });

  it("walks up the parent chain to find root (A → B → C where C is root)", () => {
    const root = makeTask({ id: "C", parent_task_id: null });
    const mid = makeTask({ id: "B", parent_task_id: "C" });
    const leaf = makeTask({ id: "A", parent_task_id: "B" });
    const store = makeStore([root, mid, leaf]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("A");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("C");
    expect(cascade!.total_tasks).toBe(3);
    expect(cascade!.max_depth).toBe(2);
  });

  it("returns null when the task does not exist in the store", () => {
    const store = makeStore([]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    expect(analyzer.analyzeCascade("nonexistent")).toBeNull();
  });
});

// ── Cycle safety — the key correctness fix ────────────────────────────────────

describe("cycle safety — findRootTask must return null, not break", () => {
  it("returns null for a 2-node cycle (A → B → A)", () => {
    // A's parent is B, B's parent is A — a cycle
    const a = makeTask({ id: "a", parent_task_id: "b" });
    const b = makeTask({ id: "b", parent_task_id: "a" });
    const store = makeStore([a, b]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    // Must not hang — cycle is detected and findRootTask returns null
    const cascade = analyzer.analyzeCascade("a");

    // CORRECT behaviour: cascade is null (unanalyzable cycle)
    // WRONG behaviour (pre-fix): cascade was non-null with an arbitrary cycle member as root
    expect(cascade).toBeNull();
  });

  it("returns null for a self-referencing task (A → A)", () => {
    const a = makeTask({ id: "a", parent_task_id: "a" });
    const store = makeStore([a]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("a");

    expect(cascade).toBeNull();
  });

  it("returns null for a long cycle (A → B → C → A)", () => {
    const a = makeTask({ id: "a", parent_task_id: "b" });
    const b = makeTask({ id: "b", parent_task_id: "c" });
    const c = makeTask({ id: "c", parent_task_id: "a" });
    const store = makeStore([a, b, c]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("a");

    expect(cascade).toBeNull();
  });

  it("does not hang for cycles (terminates in O(n) not infinite loop)", () => {
    // Build a 20-node cycle to confirm O(n) termination
    const tasks: Task[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push(makeTask({ id: `node-${i}`, parent_task_id: `node-${(i + 1) % 20}` }));
    }
    const store = makeStore(tasks);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const start = Date.now();
    const cascade = analyzer.analyzeCascade("node-0");
    const elapsed = Date.now() - start;

    expect(cascade).toBeNull();
    expect(elapsed).toBeLessThan(500); // must complete well within 500ms
  });
});

// ── canDispatchFollowUp — fail-open contract ──────────────────────────────────

describe("canDispatchFollowUp — fail-open", () => {
  it("allows dispatch (fail-open) when cascade is null (cycle detected)", () => {
    const a = makeTask({ id: "a", parent_task_id: "b" });
    const b = makeTask({ id: "b", parent_task_id: "a" });
    const store = makeStore([a, b]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const result = analyzer.canDispatchFollowUp("a");

    expect(result.allowed).toBe(true);
    expect(result.cascade).toBeNull();
    // No blocking reason when fail-open
    expect(result.reason).toBeUndefined();
  });

  it("allows dispatch when task does not exist in store", () => {
    const store = makeStore([]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const result = analyzer.canDispatchFollowUp("ghost-task");

    expect(result.allowed).toBe(true);
    expect(result.cascade).toBeNull();
  });
});

// ── Cap enforcement ───────────────────────────────────────────────────────────

describe("canDispatchFollowUp — cap enforcement", () => {
  it("allows dispatch when no cross-repo follow-ups exist", () => {
    const root = makeTask({ id: "root", title: "PR Review", parent_task_id: null });
    const store = makeStore([root]);
    const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 2 });

    const result = analyzer.canDispatchFollowUp("root");

    expect(result.allowed).toBe(true);
    expect(result.cascade!.cross_repo_followup_count).toBe(0);
    expect(result.cascade!.is_at_capacity).toBe(false);
  });

  it("allows dispatch when cross-repo count is below cap", () => {
    const root = makeTask({ id: "root", title: "PR Review", parent_task_id: null });
    const child = makeTask({
      id: "child",
      title: "[follow-up] implement fix",
      parent_task_id: "root",
    });
    const store = makeStore([root, child]);
    const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 2 });

    const result = analyzer.canDispatchFollowUp("child");

    expect(result.allowed).toBe(true);
    expect(result.cascade!.cross_repo_followup_count).toBe(1);
    expect(result.cascade!.is_at_capacity).toBe(false);
  });

  it("blocks dispatch when cross-repo count reaches cap", () => {
    const root = makeTask({ id: "root", title: "PR Review #42", parent_task_id: null });
    const followUp1 = makeTask({
      id: "fu1",
      title: "[follow-up] fix in repo-a",
      parent_task_id: "root",
    });
    const followUp2 = makeTask({
      id: "fu2",
      title: "[follow-up] fix in repo-b",
      parent_task_id: "root",
    });
    const store = makeStore([root, followUp1, followUp2]);
    const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 2 });

    const result = analyzer.canDispatchFollowUp("fu1");

    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.alertMessage).toBeTruthy();
    expect(result.cascade!.cross_repo_followup_count).toBe(2);
    expect(result.cascade!.is_at_capacity).toBe(true);
  });

  it("uses DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH (2) when no option provided", () => {
    const root = makeTask({ id: "root", parent_task_id: null });
    const fu1 = makeTask({ id: "fu1", title: "follow-up A", parent_task_id: "root" });
    const fu2 = makeTask({ id: "fu2", title: "follow-up B", parent_task_id: "root" });
    const store = makeStore([root, fu1, fu2]);
    const analyzer = new DispatchCascadeAnalyzer(store); // default cap

    const result = analyzer.canDispatchFollowUp("fu1");
    // 2 follow-ups at cap=2 → blocked
    expect(result.cascade!.is_at_capacity).toBe(true);
  });

  it("custom cap is respected", () => {
    const root = makeTask({ id: "root", parent_task_id: null });
    const fu = makeTask({ id: "fu", title: "[follow-up] x", parent_task_id: "root" });
    const store = makeStore([root, fu]);
    const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 5 });

    const result = analyzer.canDispatchFollowUp("fu");
    // 1 follow-up at cap=5 → allowed
    expect(result.allowed).toBe(true);
  });
});

// ── CascadeSummary tree structure ─────────────────────────────────────────────

describe("analyzeCascade — tree structure", () => {
  it("correctly computes max_depth for a branching tree", () => {
    // root
    // ├─ A (depth 1)
    // │  └─ A1 (depth 2)
    // └─ B (depth 1)
    const root = makeTask({ id: "root", parent_task_id: null });
    const a = makeTask({ id: "A", parent_task_id: "root" });
    const a1 = makeTask({ id: "A1", parent_task_id: "A" });
    const b = makeTask({ id: "B", parent_task_id: "root" });
    const store = makeStore([root, a, a1, b]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("A1");

    expect(cascade).not.toBeNull();
    expect(cascade!.root_task_id).toBe("root");
    expect(cascade!.max_depth).toBe(2);
    expect(cascade!.total_tasks).toBe(4);
  });

  it("counts only cross-repo follow-up tasks in cross_repo_followup_count", () => {
    const root = makeTask({ id: "root", title: "PR review", parent_task_id: null });
    const impl = makeTask({ id: "impl", title: "Implement feature", parent_task_id: "root" });
    const crossRepo = makeTask({
      id: "cr",
      title: "[follow-up] fix in reviewer",
      parent_task_id: "root",
    });
    const store = makeStore([root, impl, crossRepo]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("root");

    // Only "cr" is a cross-repo follow-up; "impl" is not
    expect(cascade!.cross_repo_followup_count).toBe(1);
  });

  it("truncates tree at MAX_CASCADE_DEPTH without hanging", () => {
    // Build a chain of MAX_CASCADE_DEPTH + 5 tasks
    const tasks: Task[] = [];
    for (let i = 0; i <= MAX_CASCADE_DEPTH + 5; i++) {
      tasks.push(
        makeTask({
          id: `deep-${i}`,
          parent_task_id: i === 0 ? null : `deep-${i - 1}`,
        }),
      );
    }
    const store = makeStore(tasks);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade = analyzer.analyzeCascade("deep-0");
    // Should complete without error; tree is truncated at MAX_CASCADE_DEPTH
    expect(cascade).not.toBeNull();
    expect(cascade!.max_depth).toBeLessThanOrEqual(MAX_CASCADE_DEPTH);
  });
});

// ── isCrossRepoFollowup detection ─────────────────────────────────────────────

describe("cross-repo follow-up detection", () => {
  const cases: Array<[string, boolean]> = [
    ["[follow-up] fix in repo-a", true],
    ["follow-up: missing validation", true],
    ["[revision] re-implement cascade", true],
    ["cross-repo follow-up for issue #42", true],
    ["Implement feature X", false],
    ["PR Review for #123", false],
    ["Housekeeping triage", false],
  ];

  for (const [title, expected] of cases) {
    it(`"${title}" → is_cross_repo_followup=${expected}`, () => {
      const root = makeTask({ id: "root", parent_task_id: null });
      const task = makeTask({ id: "t", title, parent_task_id: "root" });
      const store = makeStore([root, task]);
      const analyzer = new DispatchCascadeAnalyzer(store);

      const cascade = analyzer.analyzeCascade("root");
      const node = cascade!.tree.children.find((c: CascadeNode) => c.task_id === "t");
      expect(node?.is_cross_repo_followup).toBe(expected);
    });
  }
});

// ── formatCapExceededAlert ────────────────────────────────────────────────────

describe("formatCapExceededAlert", () => {
  it("includes root trigger title, counts, and action prompt", () => {
    const root = makeTask({ id: "root", title: "Review PR #419 (routing config view)" });
    const fu1 = makeTask({ id: "fu1", title: "[follow-up] fix A", parent_task_id: "root" });
    const fu2 = makeTask({ id: "fu2", title: "[follow-up] fix B", parent_task_id: "root" });
    const store = makeStore([root, fu1, fu2]);
    const analyzer = new DispatchCascadeAnalyzer(store, { maxCrossRepoFollowupDepth: 2 });

    const cascade = analyzer.analyzeCascade("fu1") as CascadeSummary;
    const alert = analyzer.formatCapExceededAlert(cascade);

    expect(alert).toContain("Dispatch Cascade Cap Exceeded");
    expect(alert).toContain("Review PR #419");
    expect(alert).toContain("Cross-repo follow-ups: 2/2");
    expect(alert).toContain("configured cap (2");
    expect(alert).toContain("Action");
  });
});

// ── Task cache cleared between calls ─────────────────────────────────────────

describe("task cache isolation", () => {
  it("returns consistent results across multiple calls (cache cleared between calls)", () => {
    const root = makeTask({ id: "root", parent_task_id: null });
    const child = makeTask({ id: "child", parent_task_id: "root" });
    const store = makeStore([root, child]);
    const analyzer = new DispatchCascadeAnalyzer(store);

    const cascade1 = analyzer.analyzeCascade("root");
    const cascade2 = analyzer.analyzeCascade("child");

    expect(cascade1).not.toBeNull();
    expect(cascade2).not.toBeNull();
    expect(cascade1!.root_task_id).toBe("root");
    expect(cascade2!.root_task_id).toBe("root");
    // Both calls return the same root despite taskCache being cleared between them
    expect(cascade1!.total_tasks).toBe(cascade2!.total_tasks);
  });
});
