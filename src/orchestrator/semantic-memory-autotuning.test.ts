/**
 * Tests for semantic memory auto-tuning (issue #1029):
 *  1. Threshold auto-tune recommendations and persistence
 *  2. FTS5 query quality logging and statistics
 *  3. Per-agent effectiveness breakdown
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../state/store.js";

// ── Store lifecycle helpers ───────────────────────────────────────────────────

let store: StateStore;
let dbPath: string;

function makeDbPath(): string {
  const dir = join(tmpdir(), "orch-autotune-" + Math.random().toString(36).slice(2));
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.sqlite");
}

beforeEach(() => {
  dbPath = makeDbPath();
  store = new StateStore(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
  } catch {
    // cleanup best-effort
  }
});

// ── Task / log factories ──────────────────────────────────────────────────────

type TaskOverrides = {
  status?: string;
  verification_status?: string | null;
  quality_score?: number | null;
  revision_count?: number;
  agent_name?: string;
  created_at?: string;
  title?: string;
  result?: string;
  withMemoryMatch?: boolean;
};

function createTask(overrides: TaskOverrides = {}): string {
  const task = store.createTask({
    title: overrides.title ?? "Test task",
    description: "Test description for semantic memory testing",
    source: "github",
    source_ref: `owner/repo#${Math.floor(Math.random() * 99999)}`,
    task_type: "implementation",
  });

  const updates: Record<string, unknown> = {};
  if (overrides.status) updates.status = overrides.status;
  if (overrides.verification_status !== undefined) updates.verification_status = overrides.verification_status;
  if (overrides.quality_score !== undefined) updates.quality_score = overrides.quality_score;
  if (overrides.revision_count !== undefined) updates.revision_count = overrides.revision_count;
  if (overrides.agent_name) updates.agent_name = overrides.agent_name;
  if (overrides.created_at) updates.created_at = overrides.created_at;
  if (overrides.result) updates.result = overrides.result;

  if (Object.keys(updates).length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.updateTask(task.id, updates as any);
  }

  if (overrides.withMemoryMatch) {
    store.addLog({
      task_id: task.id,
      direction: "system",
      agent_name: overrides.agent_name ?? "orchestrator",
      content: "[semantic-memory] Attached 2 past success(es): t1(0.90), t2(0.85)",
    });
  }

  return task.id;
}

/** Return a timestamp slightly in the past to ensure rows fall inside 30-day window. */
function recent(): string {
  return new Date(Date.now() - 1000).toISOString();
}

// ── Settings persistence ───────────────────────────────────────────────────────

describe("getTunedMinQualityScore / setTunedMinQualityScore", () => {
  it("returns null when no threshold has been set", () => {
    expect(store.getTunedMinQualityScore()).toBeNull();
  });

  it("persists and retrieves a tuned threshold", () => {
    store.setTunedMinQualityScore(0.75);
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.75);
  });

  it("clamps threshold to [0.60, 0.95]", () => {
    store.setTunedMinQualityScore(0.10); // below floor
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.60);

    store.setTunedMinQualityScore(0.99); // above ceiling
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.95);
  });

  it("clears the override when null is passed", () => {
    store.setTunedMinQualityScore(0.75);
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.75);

    store.setTunedMinQualityScore(null);
    expect(store.getTunedMinQualityScore()).toBeNull();
  });

  it("upserts: a second call overwrites the first", () => {
    store.setTunedMinQualityScore(0.75);
    store.setTunedMinQualityScore(0.65);
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.65);
  });
});

// ── computeAutoTuneRecommendation ─────────────────────────────────────────────

describe("computeAutoTuneRecommendation", () => {
  it("returns 'keep' when there is insufficient data (<20 dispatches)", () => {
    // Only 5 tasks — not enough for reliable signal
    for (let i = 0; i < 5; i++) {
      createTask({ status: "done", created_at: recent() });
    }

    const rec = store.computeAutoTuneRecommendation(0.80);
    expect(rec.action).toBe("keep");
    expect(rec.recommended_threshold).toBe(0.80);
    expect(rec.reason).toMatch(/insufficient data/i);
  });

  it("recommends 'lower' when hit rate is below 20%", () => {
    // 30 tasks, none with memory logs → hit rate = 0%
    for (let i = 0; i < 30; i++) {
      createTask({ status: "done", created_at: recent() });
    }

    const rec = store.computeAutoTuneRecommendation(0.80);
    expect(rec.action).toBe("lower");
    expect(rec.recommended_threshold).toBeCloseTo(0.75);
    expect(rec.reason).toMatch(/below 20%/i);
  });

  it("does not lower threshold below 0.60 floor", () => {
    for (let i = 0; i < 25; i++) {
      createTask({ status: "done", created_at: recent() });
    }

    // Already at floor
    const rec = store.computeAutoTuneRecommendation(0.60);
    expect(rec.recommended_threshold).toBeCloseTo(0.60);
    expect(rec.action).toBe("keep");
  });

  it("recommends 'raise' when hit rate ≥30% and improvement_delta is negative", () => {
    // 20 tasks: 10 with memory logs (50% hit rate)
    // Memory-assisted tasks do WORSE (high revision count → low FPR)
    for (let i = 0; i < 10; i++) {
      createTask({
        status: "done",
        verification_status: "approved",
        quality_score: 0.82,
        revision_count: 2, // needs revisions → bad first-pass
        created_at: recent(),
        withMemoryMatch: true,
      });
    }
    // Unmatched tasks do BETTER (all first-pass)
    for (let i = 0; i < 10; i++) {
      createTask({
        status: "done",
        verification_status: "approved",
        quality_score: 0.90,
        revision_count: 0,
        created_at: recent(),
      });
    }

    const rec = store.computeAutoTuneRecommendation(0.80);
    expect(rec.action).toBe("raise");
    expect(rec.recommended_threshold).toBeCloseTo(0.85);
    expect(rec.reason).toMatch(/negative/i);
  });

  it("does not raise threshold above 0.95 ceiling", () => {
    for (let i = 0; i < 10; i++) {
      createTask({
        status: "done", verification_status: "approved",
        quality_score: 0.80, revision_count: 2, created_at: recent(), withMemoryMatch: true,
      });
    }
    for (let i = 0; i < 10; i++) {
      createTask({
        status: "done", verification_status: "approved",
        quality_score: 0.90, revision_count: 0, created_at: recent(),
      });
    }

    const rec = store.computeAutoTuneRecommendation(0.95); // already at ceiling
    expect(rec.recommended_threshold).toBeCloseTo(0.95);
    expect(rec.action).toBe("keep");
  });

  it("returns 'keep' when performing well (hit rate ≥20%, delta ≥15%)", () => {
    // Memory-assisted tasks all pass first time; unmatched tasks all need revisions
    for (let i = 0; i < 15; i++) {
      createTask({
        status: "done",
        verification_status: "approved",
        quality_score: 0.92,
        revision_count: 0,
        created_at: recent(),
        withMemoryMatch: true,
      });
    }
    for (let i = 0; i < 15; i++) {
      createTask({
        status: "done",
        verification_status: "approved",
        quality_score: 0.72,
        revision_count: 2,
        created_at: recent(),
      });
    }

    const rec = store.computeAutoTuneRecommendation(0.80);
    // hit_rate = 50%, delta ≈ 1.0 → well above 0.10 threshold → keeps
    expect(rec.action).toBe("keep");
    expect(rec.recommended_threshold).toBeCloseTo(0.80);
  });

  it("populates basis correctly", () => {
    for (let i = 0; i < 25; i++) {
      createTask({ status: "done", created_at: recent() });
    }

    const rec = store.computeAutoTuneRecommendation(0.80);
    expect(rec.basis.hit_rate).not.toBeUndefined();
    expect(rec.basis.matched_tasks).toBeGreaterThanOrEqual(0);
    expect(rec.basis.unmatched_tasks).toBeGreaterThanOrEqual(0);
    expect(rec.current_threshold).toBeCloseTo(0.80);
  });
});

// ── applyAutoTuneIfBeneficial ─────────────────────────────────────────────────

describe("applyAutoTuneIfBeneficial", () => {
  it("persists the new threshold when action is 'lower'", () => {
    // 0% hit rate with 30 tasks → should lower from 0.80 to 0.75
    for (let i = 0; i < 30; i++) {
      createTask({ status: "done", created_at: recent() });
    }

    const result = store.applyAutoTuneIfBeneficial(0.80);
    expect(result.action).toBe("lower");
    expect(store.getTunedMinQualityScore()).toBeCloseTo(0.75);
  });

  it("does not modify threshold when action is 'keep'", () => {
    // No tasks → insufficient data → keep
    store.applyAutoTuneIfBeneficial(0.80);
    // Threshold should remain null (not set)
    expect(store.getTunedMinQualityScore()).toBeNull();
  });

  it("returns a complete result even when no change is made", () => {
    const result = store.applyAutoTuneIfBeneficial(0.80);
    expect(result).toHaveProperty("action");
    expect(result).toHaveProperty("current_threshold");
    expect(result).toHaveProperty("recommended_threshold");
    expect(result).toHaveProperty("reason");
    expect(result).toHaveProperty("basis");
  });
});

// ── FTS5 query quality logging ─────────────────────────────────────────────────

describe("getSemanticMemoryQueryStats", () => {
  it("returns zero counts when no queries have been logged", () => {
    const stats = store.getSemanticMemoryQueryStats();
    expect(stats.total_queries).toBe(0);
    expect(stats.zero_match_queries).toBe(0);
    expect(stats.zero_match_rate).toBeNull();
    expect(stats.avg_matches_returned).toBeNull();
    expect(stats.top_empty_patterns).toHaveLength(0);
  });

  it("records queries via querySemanticMemory() and counts them", () => {
    // Index one task so we can get at least one hit
    createTask({
      status: "done",
      verification_status: "approved",
      quality_score: 0.90,
      result: "TypeScript implementation of a REST API using Express and JWT authentication",
    });
    store.indexApprovedTasksIntoMemory(0.80);

    // Run two queries
    store.querySemanticMemory("TypeScript Express REST API authentication", 3, undefined, {
      taskId: "ctx-task-1",
      agentName: "agent-a",
    });
    store.querySemanticMemory("xyzzy frobnicator quux plugh nonsense", 3);

    const stats = store.getSemanticMemoryQueryStats();
    // Both queries should have been logged (one may produce matches, one won't)
    expect(stats.total_queries).toBeGreaterThanOrEqual(1);
  });

  it("correctly reports zero-match queries and surfaces top patterns", () => {
    // Use querySemanticMemory with terms guaranteed to produce zero matches
    // (no tasks indexed yet, so all queries return zero)
    store.querySemanticMemory("typescript express authentication route middleware", 3);
    store.querySemanticMemory("typescript express authentication route middleware", 3);
    store.querySemanticMemory("typescript express authentication route middleware", 3);
    store.querySemanticMemory("python fastapi database schema migration", 3);

    const stats = store.getSemanticMemoryQueryStats();
    expect(stats.total_queries).toBe(4);
    expect(stats.zero_match_queries).toBe(4);
    expect(stats.zero_match_rate).toBeCloseTo(1.0);
    // The repeated pattern should surface in top_empty_patterns
    expect(stats.top_empty_patterns.length).toBeGreaterThanOrEqual(1);
    expect(stats.top_empty_patterns[0].count).toBeGreaterThanOrEqual(3);
  });

  it("respects the sinceISO window parameter", () => {
    // Run a query now (should be included)
    store.querySemanticMemory("recent query typescript express", 3);

    // Manually insert an old query log row
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    const oldTs = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO semantic_memory_query_log
        (logged_at, task_id, agent_name, fts5_query, term_count, match_count)
      VALUES (?, NULL, 'agent', '"ancient" OR "query"', 2, 0)
    `).run(oldTs);

    // 30-day window should only include the recent query
    const stats = store.getSemanticMemoryQueryStats();
    expect(stats.total_queries).toBe(1);
  });

  it("computes avg_matches_returned correctly", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (store as any).db;
    const now = new Date().toISOString();
    const ins = db.prepare(`
      INSERT INTO semantic_memory_query_log
        (logged_at, task_id, agent_name, fts5_query, term_count, match_count)
      VALUES (?, NULL, 'agent', '"term"', 1, ?)
    `);
    ins.run(now, 3);
    ins.run(now, 1);
    ins.run(now, 0);

    const stats = store.getSemanticMemoryQueryStats();
    expect(stats.total_queries).toBe(3);
    expect(stats.avg_matches_returned).toBeCloseTo((3 + 1 + 0) / 3);
  });
});

// ── Per-agent effectiveness ────────────────────────────────────────────────────

describe("getPerAgentSemanticMemoryEffectiveness", () => {
  it("returns empty array when there are no agents with ≥5 tasks", () => {
    // Only 3 tasks for agent-a
    for (let i = 0; i < 3; i++) {
      createTask({ agent_name: "agent-a", status: "done", created_at: recent() });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    expect(results).toHaveLength(0);
  });

  it("includes agents with ≥5 tasks and excludes those with <5", () => {
    // agent-a: 10 tasks (included)
    for (let i = 0; i < 10; i++) {
      createTask({ agent_name: "agent-a", status: "done", created_at: recent() });
    }
    // agent-tiny: 2 tasks (excluded)
    for (let i = 0; i < 2; i++) {
      createTask({ agent_name: "agent-tiny", status: "done", created_at: recent() });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    const names = results.map((r) => r.agent_name);
    expect(names).toContain("agent-a");
    expect(names).not.toContain("agent-tiny");
  });

  it("computes correct cohort stats per agent", () => {
    // agent-a: 10 tasks — 5 with memory (all first-pass), 5 without (all need revisions)
    for (let i = 0; i < 5; i++) {
      createTask({
        agent_name: "agent-a",
        status: "done",
        verification_status: "approved",
        revision_count: 0,
        quality_score: 0.90,
        created_at: recent(),
        withMemoryMatch: true,
      });
    }
    for (let i = 0; i < 5; i++) {
      createTask({
        agent_name: "agent-a",
        status: "done",
        verification_status: "approved",
        revision_count: 2,
        quality_score: 0.72,
        created_at: recent(),
      });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    const agentA = results.find((r) => r.agent_name === "agent-a");
    expect(agentA).toBeDefined();
    expect(agentA!.total_dispatches).toBe(10);
    expect(agentA!.memory_hit_count).toBe(5);
    expect(agentA!.memory_hit_rate).toBeCloseTo(0.5);
    expect(agentA!.matched.first_pass_rate).toBeCloseTo(1.0);
    expect(agentA!.unmatched.first_pass_rate).toBeCloseTo(0.0);
    // 10 tasks < 20 threshold → insufficient_data (not enough for reliable signal)
    expect(agentA!.recommended_threshold_adjustment).toBe("insufficient_data");
  });

  it("recommends 'lower' for an agent with 0% hit rate and ≥20 tasks", () => {
    // agent-b: 25 tasks, none with memory → hit rate 0% → lower
    for (let i = 0; i < 25; i++) {
      createTask({
        agent_name: "agent-b",
        status: "done",
        created_at: recent(),
      });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    const agentB = results.find((r) => r.agent_name === "agent-b")!;
    expect(agentB.recommended_threshold_adjustment).toBe("lower");
  });

  it("returns 'insufficient_data' for agents with 5–19 tasks", () => {
    // 8 tasks: enough to be included (≥5) but not enough for tuning (< 20)
    for (let i = 0; i < 8; i++) {
      createTask({
        agent_name: "agent-small",
        status: "done",
        created_at: recent(),
      });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    const a = results.find((r) => r.agent_name === "agent-small")!;
    expect(a.recommended_threshold_adjustment).toBe("insufficient_data");
  });

  it("sorts agents by total_dispatches descending", () => {
    for (let i = 0; i < 5; i++) {
      createTask({ agent_name: "agent-small", status: "done", created_at: recent() });
    }
    for (let i = 0; i < 20; i++) {
      createTask({ agent_name: "agent-large", status: "done", created_at: recent() });
    }
    for (let i = 0; i < 10; i++) {
      createTask({ agent_name: "agent-mid", status: "done", created_at: recent() });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    expect(results[0].agent_name).toBe("agent-large");
    expect(results[1].agent_name).toBe("agent-mid");
    expect(results[2].agent_name).toBe("agent-small");
  });

  it("computes hit rate per agent independently", () => {
    // agent-1: 4/10 hits
    for (let i = 0; i < 10; i++) {
      createTask({
        id: undefined,
        agent_name: "agent-1",
        status: "done",
        created_at: recent(),
        withMemoryMatch: i < 4,
      });
    }
    // agent-2: 8/10 hits
    for (let i = 0; i < 10; i++) {
      createTask({
        agent_name: "agent-2",
        status: "done",
        created_at: recent(),
        withMemoryMatch: i < 8,
      });
    }

    const results = store.getPerAgentSemanticMemoryEffectiveness();
    const a1 = results.find((r) => r.agent_name === "agent-1")!;
    const a2 = results.find((r) => r.agent_name === "agent-2")!;
    expect(a1.memory_hit_rate).toBeCloseTo(0.4);
    expect(a2.memory_hit_rate).toBeCloseTo(0.8);
  });
});
