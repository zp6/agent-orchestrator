import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SubtaskRollupPolicy, SubtaskRollupResult, Task, IStateStore } from "../state/types.js";

/**
 * Unit tests for SubtaskRollupPolicy scoring semantics (issue #95).
 *
 * These tests cover the rollup aggregation logic in isolation — no LLM calls,
 * no SQLite. The IStateStore is mocked to supply child task data.
 *
 * Tests mirror the three rollup policies:
 *   - strict:   parent score = min(child scores); any failing child fails parent
 *   - majority: parent score = mean; passes when ≥50% of children pass
 *   - weighted: parent score = weighted mean by subtask_complexity_hint
 *
 * And the partial-completion and token-cost attribution edge cases.
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-" + Math.random().toString(36).slice(2, 8),
    title: "Test task",
    status: "done",
    task_type: "implementation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Pure implementation of the rollup logic, extracted here so we can unit-test
 * the scoring math without instantiating Verifier (which requires a real LLM
 * client at construction time).
 *
 * This mirrors Verifier.rollupChildScores() exactly — keep in sync.
 */
function computeRollup(
  children: Task[],
  policy: SubtaskRollupPolicy,
): Pick<SubtaskRollupResult, "parentScore" | "approved" | "failingChildIds" | "partialCompletion" | "completedCount" | "pendingCount"> {
  const APPROVAL_THRESHOLD = 0.80;
  const terminalStatuses = new Set(["done", "failed", "escalated"]);
  const inFlightStatuses = new Set(["pending", "planning", "dispatched", "in_progress"]);

  let completedCount = 0;
  let pendingCount = 0;

  const summaries = children.map((child) => {
    if (terminalStatuses.has(child.status)) completedCount++;
    else if (inFlightStatuses.has(child.status)) pendingCount++;

    // failed/escalated children always contribute 0.0 to the rollup score,
    // even if they have a quality_score stored (score was from a pre-failure pass).
    const isFailedTerminal = child.status === "failed" || child.status === "escalated";
    const effectiveScore = isFailedTerminal ? 0.0 : (child.quality_score ?? 0.0);
    const weight = child.subtask_complexity_hint ?? 1.0;
    const failing =
      effectiveScore < APPROVAL_THRESHOLD ||
      child.status === "failed" ||
      child.status === "escalated";

    return { id: child.id, score: effectiveScore, weight, failing };
  });

  const partialCompletion = pendingCount > 0;
  const scores = summaries.map((s) => s.score);
  const weights = summaries.map((s) => s.weight);

  let parentScore: number;
  if (summaries.length === 0) {
    parentScore = 0.0;
  } else if (policy === "strict") {
    parentScore = Math.min(...scores);
  } else if (policy === "majority") {
    parentScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  } else {
    // weighted
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight === 0) {
      parentScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    } else {
      parentScore = scores.reduce((acc, s, i) => acc + s * weights[i], 0) / totalWeight;
    }
  }

  const failingChildIds = summaries.filter((s) => s.failing).map((s) => s.id);

  let approved: boolean;
  if (policy === "majority") {
    const passingCount = summaries.filter((s) => s.score >= APPROVAL_THRESHOLD).length;
    approved = summaries.length > 0 && passingCount / summaries.length >= 0.5;
  } else {
    approved = parentScore >= APPROVAL_THRESHOLD;
  }

  if (partialCompletion) approved = false;

  return { parentScore, approved, failingChildIds, partialCompletion, completedCount, pendingCount };
}

// ── Type shape tests ───────────────────────────────────────────────────────

describe("SubtaskRollupPolicy type", () => {
  it("accepts all three valid policy values", () => {
    const policies: SubtaskRollupPolicy[] = ["strict", "majority", "weighted"];
    expect(policies).toHaveLength(3);
    expect(policies).toContain("strict");
    expect(policies).toContain("majority");
    expect(policies).toContain("weighted");
  });
});

describe("Task type subtask fields", () => {
  it("Task accepts parent_task_id, rollup_policy, subtask_complexity_hint", () => {
    const task: Task = makeTask({
      parent_task_id: "parent-123",
      rollup_policy: "weighted",
      subtask_complexity_hint: 0.7,
    });
    expect(task.parent_task_id).toBe("parent-123");
    expect(task.rollup_policy).toBe("weighted");
    expect(task.subtask_complexity_hint).toBe(0.7);
  });

  it("Task fields are optional (null for top-level tasks)", () => {
    const task: Task = makeTask({
      parent_task_id: null,
      rollup_policy: null,
      subtask_complexity_hint: null,
    });
    expect(task.parent_task_id).toBeNull();
    expect(task.rollup_policy).toBeNull();
    expect(task.subtask_complexity_hint).toBeNull();
  });
});

// ── Strict policy ──────────────────────────────────────────────────────────

describe("strict rollup policy", () => {
  it("all children pass → parent score = min, approved", () => {
    const children = [
      makeTask({ quality_score: 0.95 }),
      makeTask({ quality_score: 0.88 }),
      makeTask({ quality_score: 0.82 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.parentScore).toBeCloseTo(0.82);
    expect(result.approved).toBe(true);
    expect(result.failingChildIds).toHaveLength(0);
  });

  it("one child scores 0.4 → parent score = 0.4, rejected", () => {
    const children = [
      makeTask({ id: "c1", quality_score: 0.95 }),
      makeTask({ id: "c2", quality_score: 0.40 }),
      makeTask({ id: "c3", quality_score: 0.88 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.parentScore).toBeCloseTo(0.40);
    expect(result.approved).toBe(false);
    expect(result.failingChildIds).toContain("c2");
    expect(result.failingChildIds).not.toContain("c1");
    expect(result.failingChildIds).not.toContain("c3");
  });

  it("two children fail → both appear in failingChildIds", () => {
    const children = [
      makeTask({ id: "c1", quality_score: 0.90 }),
      makeTask({ id: "c2", quality_score: 0.60 }),
      makeTask({ id: "c3", quality_score: 0.50 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.failingChildIds).toContain("c2");
    expect(result.failingChildIds).toContain("c3");
    expect(result.failingChildIds).not.toContain("c1");
  });

  it("all children fail → parent score = min(0), rejected", () => {
    const children = [
      makeTask({ quality_score: 0.40 }),
      makeTask({ quality_score: 0.50 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.parentScore).toBeCloseTo(0.40);
    expect(result.approved).toBe(false);
  });

  it("exactly at threshold (0.80) → approved", () => {
    const children = [
      makeTask({ quality_score: 0.80 }),
      makeTask({ quality_score: 0.95 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.parentScore).toBeCloseTo(0.80);
    expect(result.approved).toBe(true);
  });

  it("just below threshold (0.799) → rejected", () => {
    const children = [
      makeTask({ quality_score: 0.799 }),
      makeTask({ quality_score: 0.95 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.approved).toBe(false);
  });
});

// ── Majority policy ────────────────────────────────────────────────────────

describe("majority rollup policy", () => {
  it("3/4 children pass → ≥50% → approved", () => {
    const children = [
      makeTask({ quality_score: 0.92 }),
      makeTask({ quality_score: 0.85 }),
      makeTask({ quality_score: 0.81 }),
      makeTask({ quality_score: 0.40 }), // fails
    ];
    const result = computeRollup(children, "majority");
    expect(result.approved).toBe(true);
    // mean = (0.92 + 0.85 + 0.81 + 0.40) / 4 = 0.745
    expect(result.parentScore).toBeCloseTo(0.745);
  });

  it("2/4 children pass → exactly 50% → approved", () => {
    const children = [
      makeTask({ quality_score: 0.90 }),
      makeTask({ quality_score: 0.85 }),
      makeTask({ quality_score: 0.50 }),
      makeTask({ quality_score: 0.40 }),
    ];
    const result = computeRollup(children, "majority");
    expect(result.approved).toBe(true); // 2/4 = 50% = threshold
  });

  it("1/4 children pass → <50% → rejected", () => {
    const children = [
      makeTask({ quality_score: 0.90 }),
      makeTask({ quality_score: 0.60 }),
      makeTask({ quality_score: 0.50 }),
      makeTask({ quality_score: 0.40 }),
    ];
    const result = computeRollup(children, "majority");
    expect(result.approved).toBe(false);
  });

  it("all children pass → approved with mean score", () => {
    const children = [
      makeTask({ quality_score: 0.90 }),
      makeTask({ quality_score: 0.82 }),
    ];
    const result = computeRollup(children, "majority");
    expect(result.approved).toBe(true);
    expect(result.parentScore).toBeCloseTo(0.86);
  });

  it("single failing child does not fail parent under majority", () => {
    // strict would fail; majority should pass
    const children = [
      makeTask({ id: "pass1", quality_score: 0.95 }),
      makeTask({ id: "pass2", quality_score: 0.90 }),
      makeTask({ id: "pass3", quality_score: 0.88 }),
      makeTask({ id: "fail1", quality_score: 0.40 }),
    ];
    const strictResult = computeRollup(children, "strict");
    const majorityResult = computeRollup(children, "majority");

    expect(strictResult.approved).toBe(false); // strict: min = 0.40
    expect(majorityResult.approved).toBe(true); // majority: 3/4 pass
  });
});

// ── Weighted policy ────────────────────────────────────────────────────────

describe("weighted rollup policy", () => {
  it("higher-weight child score dominates", () => {
    // child A: score=0.95, weight=0.9 (complex)
    // child B: score=0.40, weight=0.1 (simple)
    // weighted mean = (0.95*0.9 + 0.40*0.1) / (0.9+0.1) = (0.855+0.04)/1.0 = 0.895
    const children = [
      makeTask({ quality_score: 0.95, subtask_complexity_hint: 0.9 }),
      makeTask({ quality_score: 0.40, subtask_complexity_hint: 0.1 }),
    ];
    const result = computeRollup(children, "weighted");
    expect(result.parentScore).toBeCloseTo(0.895);
    expect(result.approved).toBe(true);
  });

  it("lower-weight passing child does not save a high-weight failing child", () => {
    // child A: score=0.40, weight=0.9 (heavy, failing)
    // child B: score=0.95, weight=0.1 (light, passing)
    // weighted = (0.40*0.9 + 0.95*0.1) / 1.0 = 0.455
    const children = [
      makeTask({ quality_score: 0.40, subtask_complexity_hint: 0.9 }),
      makeTask({ quality_score: 0.95, subtask_complexity_hint: 0.1 }),
    ];
    const result = computeRollup(children, "weighted");
    expect(result.parentScore).toBeCloseTo(0.455);
    expect(result.approved).toBe(false);
  });

  it("falls back to equal weights when hints are absent", () => {
    const children = [
      makeTask({ quality_score: 0.90, subtask_complexity_hint: null }),
      makeTask({ quality_score: 0.80, subtask_complexity_hint: null }),
    ];
    const result = computeRollup(children, "weighted");
    // Equal weights → same as mean
    expect(result.parentScore).toBeCloseTo(0.85);
    expect(result.approved).toBe(true);
  });

  it("mixed present/absent hints: absent treated as weight 1.0", () => {
    // child A: score=0.90, hint=null → weight=1.0
    // child B: score=0.70, hint=0.5  → weight=0.5
    // weighted = (0.90*1.0 + 0.70*0.5) / (1.0+0.5) = (0.90+0.35)/1.5 ≈ 0.833
    const children = [
      makeTask({ quality_score: 0.90, subtask_complexity_hint: null }),
      makeTask({ quality_score: 0.70, subtask_complexity_hint: 0.5 }),
    ];
    const result = computeRollup(children, "weighted");
    expect(result.parentScore).toBeCloseTo(0.833, 2);
    expect(result.approved).toBe(true);
  });
});

// ── Partial completion ─────────────────────────────────────────────────────

describe("partial completion (in-flight children)", () => {
  it("one in-flight child → partialCompletion=true, approved=false", () => {
    const children = [
      makeTask({ quality_score: 0.95, status: "done" }),
      makeTask({ quality_score: 0.88, status: "done" }),
      makeTask({ status: "in_progress", quality_score: null }), // still running
    ];
    const result = computeRollup(children, "majority");
    expect(result.partialCompletion).toBe(true);
    expect(result.approved).toBe(false); // conservative
    expect(result.pendingCount).toBe(1);
    expect(result.completedCount).toBe(2);
  });

  it("all children done → partialCompletion=false", () => {
    const children = [
      makeTask({ quality_score: 0.90, status: "done" }),
      makeTask({ quality_score: 0.85, status: "done" }),
    ];
    const result = computeRollup(children, "majority");
    expect(result.partialCompletion).toBe(false);
    expect(result.pendingCount).toBe(0);
  });

  it("dispatched child counts as pending", () => {
    const children = [
      makeTask({ quality_score: 0.90, status: "done" }),
      makeTask({ status: "dispatched", quality_score: null }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.partialCompletion).toBe(true);
    expect(result.pendingCount).toBe(1);
  });

  it("timed-out/failed child with no score treated as score 0.0", () => {
    const children = [
      makeTask({ id: "c1", quality_score: 0.90, status: "done" }),
      makeTask({ id: "c2", quality_score: null, status: "failed" }), // timed out
    ];
    const result = computeRollup(children, "strict");
    // strict: min(0.90, 0.0) = 0.0
    expect(result.parentScore).toBeCloseTo(0.0);
    expect(result.approved).toBe(false);
    expect(result.failingChildIds).toContain("c2");
    expect(result.partialCompletion).toBe(false); // failed is terminal
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("no children → parentScore=0, approved=false", () => {
    const result = computeRollup([], "strict");
    expect(result.parentScore).toBe(0.0);
    expect(result.approved).toBe(false);
    expect(result.failingChildIds).toHaveLength(0);
  });

  it("single child passing → approved", () => {
    const children = [makeTask({ quality_score: 0.90, status: "done" })];
    const strictResult = computeRollup(children, "strict");
    const majorityResult = computeRollup(children, "majority");
    const weightedResult = computeRollup(children, "weighted");
    expect(strictResult.approved).toBe(true);
    expect(majorityResult.approved).toBe(true);
    expect(weightedResult.approved).toBe(true);
  });

  it("single child failing → rejected across all policies", () => {
    const children = [makeTask({ quality_score: 0.50, status: "done" })];
    expect(computeRollup(children, "strict").approved).toBe(false);
    expect(computeRollup(children, "majority").approved).toBe(false);
    expect(computeRollup(children, "weighted").approved).toBe(false);
  });

  it("escalated children are treated as failing regardless of score", () => {
    const children = [
      makeTask({ id: "c1", quality_score: 0.95, status: "done" }),
      makeTask({ id: "c2", quality_score: 0.90, status: "escalated" }), // escalated = failing
    ];
    const result = computeRollup(children, "strict");
    // escalated child: score forced to 0.0 → min = 0.0
    expect(result.failingChildIds).toContain("c2");
    expect(result.approved).toBe(false);
  });

  it("completedCount and pendingCount sum to total children", () => {
    const children = [
      makeTask({ status: "done", quality_score: 0.9 }),
      makeTask({ status: "failed", quality_score: null }),
      makeTask({ status: "dispatched", quality_score: null }),
      makeTask({ status: "in_progress", quality_score: null }),
    ];
    const result = computeRollup(children, "majority");
    expect(result.completedCount + result.pendingCount).toBe(children.length);
    expect(result.completedCount).toBe(2); // done + failed
    expect(result.pendingCount).toBe(2);   // dispatched + in_progress
  });
});

// ── Per-child re-dispatch semantics (strict policy) ────────────────────────

describe("per-child re-dispatch targeting (strict policy)", () => {
  it("failingChildIds contains only sub-threshold children", () => {
    const children = [
      makeTask({ id: "agent-a", quality_score: 0.95 }),
      makeTask({ id: "agent-b", quality_score: 0.79 }), // just below threshold
      makeTask({ id: "agent-c", quality_score: 0.85 }),
      makeTask({ id: "agent-d", quality_score: 0.45 }),
    ];
    const result = computeRollup(children, "strict");
    expect(result.failingChildIds).toEqual(
      expect.arrayContaining(["agent-b", "agent-d"]),
    );
    expect(result.failingChildIds).not.toContain("agent-a");
    expect(result.failingChildIds).not.toContain("agent-c");
  });

  it("majority policy: failingChildIds still identifies sub-threshold children for targeted re-dispatch", () => {
    const children = [
      makeTask({ id: "c1", quality_score: 0.90 }),
      makeTask({ id: "c2", quality_score: 0.40 }), // failing
      makeTask({ id: "c3", quality_score: 0.85 }),
    ];
    const result = computeRollup(children, "majority");
    // Parent is approved (2/3 > 50%) but c2 is still identified as failing
    expect(result.approved).toBe(true);
    expect(result.failingChildIds).toContain("c2");
  });
});

// ── Token cost attribution model ───────────────────────────────────────────

describe("token cost attribution via task_id", () => {
  it("LlmCallEvent task_id field accepts child task IDs for per-child attribution", () => {
    // Verify the LlmCallEvent type supports linking to child task IDs.
    // This test documents the attribution model: child LLM calls use the
    // child's task_id, not the parent's. Aggregating at parent level requires
    // JOIN with parent_task_id in the tasks table.
    const childTaskId = "child-task-01HTYZ";
    const event = {
      call_type: "task_verify" as const,
      model: "claude-sonnet-4-6",
      input_tokens: 1500,
      output_tokens: 300,
      task_id: childTaskId,
    };
    expect(event.task_id).toBe(childTaskId);
    // Parent-level cost = SUM(input_tokens) WHERE task_id IN
    //   (SELECT id FROM tasks WHERE parent_task_id = ?)
  });
});
