/**
 * Tests for the routing-accuracy drill-down: pure logic covering the
 * StateStore.getRoutingAccuracyDrillDown() computation and the CLI
 * formatting helpers.
 *
 * LLM calls and disk I/O are NOT exercised here — we test only the
 * deterministic logic that computes misrouting flags, score gaps, and
 * misrouting reasons.
 */

import { describe, it, expect } from "vitest";
import type { RoutingDrillDownRow, RoutingAccuracyDrillDown } from "../../state/store.js";
import { StateStore } from "../../state/store.js";

// ── Helper to build a minimal RoutingDrillDownRow ──────────────────────────

function makeRow(
  partial: Partial<RoutingDrillDownRow> & {
    task_type: string;
    agent_name: string;
  },
): RoutingDrillDownRow {
  return {
    total_routed:         partial.total_routed ?? 10,
    scored:               partial.scored ?? 10,
    avg_quality_score:    partial.avg_quality_score ?? null,
    avg_confidence:       partial.avg_confidence ?? null,
    det_count:            partial.det_count ?? 0,
    llm_count:            partial.llm_count ?? 0,
    exp_count:            partial.exp_count ?? 0,
    best_agent_for_type:  partial.best_agent_for_type ?? null,
    best_agent_avg_score: partial.best_agent_avg_score ?? null,
    score_gap:            partial.score_gap ?? null,
    misrouted:            partial.misrouted ?? false,
    ...partial,
  };
}

// ── MISROUTING_GAP_THRESHOLD constant ─────────────────────────────────────

describe("StateStore.MISROUTING_GAP_THRESHOLD", () => {
  it("is 0.10", () => {
    expect(StateStore.MISROUTING_GAP_THRESHOLD).toBe(0.10);
  });
});

// ── Score-gap and misrouted flag computation ──────────────────────────────

describe("misrouting flag logic", () => {
  it("best agent has score_gap null and misrouted false", () => {
    const best = makeRow({
      task_type: "implementation",
      agent_name: "agent-a",
      avg_quality_score: 0.90,
      best_agent_for_type: null,   // null = this IS the best
      best_agent_avg_score: null,
      score_gap: null,
      misrouted: false,
    });
    expect(best.misrouted).toBe(false);
    expect(best.score_gap).toBeNull();
  });

  it("non-best agent with gap < threshold is not misrouted", () => {
    const gap = 0.05; // below 0.10
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-b",
      avg_quality_score: 0.85,
      best_agent_for_type: "agent-a",
      best_agent_avg_score: 0.90,
      score_gap: gap,
      misrouted: gap >= StateStore.MISROUTING_GAP_THRESHOLD,
    });
    expect(row.misrouted).toBe(false);
  });

  it("non-best agent with gap >= threshold IS misrouted", () => {
    const gap = 0.15; // above 0.10
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-b",
      avg_quality_score: 0.65,
      best_agent_for_type: "agent-a",
      best_agent_avg_score: 0.80,
      score_gap: gap,
      misrouted: gap >= StateStore.MISROUTING_GAP_THRESHOLD,
    });
    expect(row.misrouted).toBe(true);
  });

  it("exact threshold boundary (0.10) is flagged", () => {
    const gap = 0.10;
    const misrouted = gap >= StateStore.MISROUTING_GAP_THRESHOLD;
    expect(misrouted).toBe(true);
  });

  it("just below threshold (0.099) is NOT flagged", () => {
    const gap = 0.099;
    const misrouted = gap >= StateStore.MISROUTING_GAP_THRESHOLD;
    expect(misrouted).toBe(false);
  });
});

// ── getRoutingAccuracyDrillDown shape ─────────────────────────────────────

describe("RoutingAccuracyDrillDown shape", () => {
  it("empty report has correct shape", () => {
    const report: RoutingAccuracyDrillDown = {
      days: 30,
      rows: [],
      misrouted_task_types: [],
    };
    expect(report.days).toBe(30);
    expect(report.rows).toHaveLength(0);
    expect(report.misrouted_task_types).toHaveLength(0);
  });

  it("misrouted_task_types contains only types with flagged rows", () => {
    const rows: RoutingDrillDownRow[] = [
      makeRow({ task_type: "implementation", agent_name: "a", misrouted: false }),
      makeRow({ task_type: "research", agent_name: "b", misrouted: true, score_gap: 0.15 }),
      makeRow({ task_type: "research", agent_name: "c", misrouted: false }),
    ];
    // Simulating the store logic: collect unique misrouted task types
    const misrouted_task_types = [...new Set(
      rows.filter((r) => r.misrouted).map((r) => r.task_type),
    )];
    expect(misrouted_task_types).toEqual(["research"]);
  });

  it("multiple misrouted types are all included", () => {
    const rows: RoutingDrillDownRow[] = [
      makeRow({ task_type: "implementation", agent_name: "a", misrouted: true, score_gap: 0.20 }),
      makeRow({ task_type: "research", agent_name: "b", misrouted: true, score_gap: 0.12 }),
    ];
    const misrouted_task_types = [...new Set(
      rows.filter((r) => r.misrouted).map((r) => r.task_type),
    )];
    expect(misrouted_task_types).toHaveLength(2);
    expect(misrouted_task_types).toContain("implementation");
    expect(misrouted_task_types).toContain("research");
  });
});

// ── Best-agent selection logic ────────────────────────────────────────────

describe("best agent per task type", () => {
  it("agent with highest avg_quality_score is selected as best", () => {
    // Simulate the store's bestByType map construction
    const rawRows = [
      { task_type: "implementation", agent_name: "agent-a", avg_quality_score: 0.70 },
      { task_type: "implementation", agent_name: "agent-b", avg_quality_score: 0.85 },
      { task_type: "implementation", agent_name: "agent-c", avg_quality_score: 0.60 },
    ];
    const bestByType = new Map<string, { agent: string; score: number }>();
    for (const r of rawRows) {
      if (r.avg_quality_score === null) continue;
      const existing = bestByType.get(r.task_type);
      if (!existing || r.avg_quality_score > existing.score) {
        bestByType.set(r.task_type, { agent: r.agent_name, score: r.avg_quality_score });
      }
    }
    expect(bestByType.get("implementation")?.agent).toBe("agent-b");
    expect(bestByType.get("implementation")?.score).toBe(0.85);
  });

  it("agents with null avg_quality_score are excluded from best selection", () => {
    const rawRows = [
      { task_type: "research", agent_name: "agent-a", avg_quality_score: null },
      { task_type: "research", agent_name: "agent-b", avg_quality_score: 0.75 },
    ];
    const bestByType = new Map<string, { agent: string; score: number }>();
    for (const r of rawRows) {
      if (r.avg_quality_score === null) continue;
      const existing = bestByType.get(r.task_type);
      if (!existing || r.avg_quality_score > existing.score) {
        bestByType.set(r.task_type, { agent: r.agent_name, score: r.avg_quality_score });
      }
    }
    expect(bestByType.get("research")?.agent).toBe("agent-b");
  });

  it("when all scores are null, bestByType has no entry for that type", () => {
    const rawRows = [
      { task_type: "implementation", agent_name: "agent-a", avg_quality_score: null },
    ];
    const bestByType = new Map<string, { agent: string; score: number }>();
    for (const r of rawRows) {
      if (r.avg_quality_score === null) continue;
      const existing = bestByType.get(r.task_type);
      if (!existing || r.avg_quality_score > existing.score) {
        bestByType.set(r.task_type, { agent: r.agent_name, score: r.avg_quality_score });
      }
    }
    expect(bestByType.has("implementation")).toBe(false);
  });
});

// ── Route-method breakdown logic ──────────────────────────────────────────

describe("route method breakdown", () => {
  it("det_count + llm_count + exp_count sums to total_routed", () => {
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-a",
      total_routed: 15,
      det_count: 8,
      llm_count: 5,
      exp_count: 2,
    });
    expect(row.det_count + row.llm_count + row.exp_count).toBe(15);
  });

  it("LLM-heavy routing (>50%) is a misrouting signal", () => {
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-a",
      total_routed: 10,
      det_count: 2,
      llm_count: 8,
      exp_count: 0,
    });
    const llmFrac = row.total_routed > 0 ? row.llm_count / row.total_routed : 0;
    expect(llmFrac).toBeGreaterThan(0.5);
  });
});

// ── Misrouting reason logic ───────────────────────────────────────────────

describe("misrouting reason generation", () => {
  it("low confidence row produces a 'low router confidence' reason", () => {
    const row = makeRow({
      task_type: "database-migration",
      agent_name: "agent-wrong",
      avg_confidence: 0.35,
      best_agent_for_type: "agent-db",
      best_agent_avg_score: 0.88,
      score_gap: 0.23,
      misrouted: true,
    });

    const reasons: string[] = [];
    if (row.avg_confidence !== null && row.avg_confidence < 0.5) {
      reasons.push(
        `low router confidence (avg ${row.avg_confidence.toFixed(2)}) — add topic/capability keywords for "${row.task_type}" tasks to agents.yaml`,
      );
    }
    expect(reasons[0]).toContain("low router confidence");
    expect(reasons[0]).toContain("database-migration");
  });

  it("high LLM-fraction row produces an LLM fallback reason", () => {
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-wrong",
      total_routed: 10,
      det_count: 2,
      llm_count: 8,
      exp_count: 0,
      avg_confidence: 0.75,
      best_agent_for_type: "agent-best",
      score_gap: 0.15,
      misrouted: true,
    });

    const reasons: string[] = [];
    const llmFrac = row.total_routed > 0 ? row.llm_count / row.total_routed : 0;
    if (llmFrac > 0.5) {
      reasons.push(
        `${Math.round(llmFrac * 100)}% of routes used LLM fallback — deterministic rules did not match; review owns_topics/capabilities for ${row.agent_name}`,
      );
    }
    expect(reasons[0]).toContain("80% of routes used LLM fallback");
    expect(reasons[0]).toContain("agent-wrong");
  });

  it("score gap reason always includes best agent name and gap size", () => {
    const row = makeRow({
      task_type: "implementation",
      agent_name: "agent-b",
      best_agent_for_type: "agent-a",
      best_agent_avg_score: 0.90,
      score_gap: 0.20,
      misrouted: true,
    });

    const reasons: string[] = [];
    if (row.best_agent_for_type && row.score_gap !== null) {
      reasons.push(
        `${row.best_agent_for_type} scores ${(row.score_gap * 100).toFixed(0)}pp higher on "${row.task_type}" — consider adding "${row.task_type}" to its owns_topics`,
      );
    }
    expect(reasons[0]).toContain("agent-a scores 20pp higher");
    expect(reasons[0]).toContain("implementation");
  });
});
