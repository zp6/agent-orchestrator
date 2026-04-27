/**
 * Tests for routing accuracy feedback loop (issue #67).
 *
 * Covers:
 *  - RoutingAccuracyTracker.getAccuracyStats()
 *  - RoutingAccuracyTracker.getQualityByTaskType()
 *  - RoutingAccuracyTracker.formatAccuracySection()
 *  - RoutingAccuracyTracker.formatQualityByTypeSection()
 *  - formatRoutingAccuracySection() standalone formatter
 *  - formatQualityByTaskTypeSection() standalone formatter
 *  - StateStore.getRoutingAccuracyStats()
 *  - StateStore.getAgentQualityByTaskType()
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import { RoutingAccuracyTracker } from "../reviewer/routing-accuracy.js";
import {
  formatRoutingAccuracySection,
  formatQualityByTaskTypeSection,
} from "../reviewer/supervisor.js";
import type { RoutingAccuracyStats, AgentQualityByTaskType } from "../state/types.js";

// ── Standalone formatter tests ────────────────────────────────────────────────

describe("formatRoutingAccuracySection", () => {
  it("returns empty array for empty stats", () => {
    expect(formatRoutingAccuracySection([])).toEqual([]);
  });

  it("formats a single agent with full data", () => {
    const stats: RoutingAccuracyStats[] = [
      {
        agent_name: "claude-agent-dashboard",
        total_routed: 24,
        verified_count: 22,
        avg_quality_score: 0.84,
        approval_rate: 0.91,
      },
    ];
    const lines = formatRoutingAccuracySection(stats, 30);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("claude-agent-dashboard");
    expect(lines[0]).toContain("avg score 0.84");
    expect(lines[0]).toContain("approval rate 91%");
    expect(lines[0]).toContain("22/24 verified");
    expect(lines[0]).toContain("last 30d");
  });

  it("handles null quality score and approval rate", () => {
    const stats: RoutingAccuracyStats[] = [
      {
        agent_name: "claude-new-agent",
        total_routed: 3,
        verified_count: 0,
        avg_quality_score: null,
        approval_rate: null,
      },
    ];
    const lines = formatRoutingAccuracySection(stats);
    expect(lines[0]).toContain("avg score n/a");
    expect(lines[0]).toContain("approval rate n/a");
    expect(lines[0]).toContain("0/3 verified");
  });

  it("formats multiple agents", () => {
    const stats: RoutingAccuracyStats[] = [
      { agent_name: "agent-a", total_routed: 10, verified_count: 8, avg_quality_score: 0.9, approval_rate: 0.875 },
      { agent_name: "agent-b", total_routed: 5, verified_count: 4, avg_quality_score: 0.65, approval_rate: 0.75 },
    ];
    const lines = formatRoutingAccuracySection(stats);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("agent-a");
    expect(lines[1]).toContain("agent-b");
  });
});

describe("formatQualityByTaskTypeSection", () => {
  it("returns empty array for empty input", () => {
    expect(formatQualityByTaskTypeSection([])).toEqual([]);
  });

  it("formats a single agent with two task types", () => {
    const byAgent: AgentQualityByTaskType[] = [
      {
        agent_name: "claude-agent-dashboard",
        by_task_type: [
          { task_type: "implementation", task_count: 18, avg_quality_score: 0.85, approval_rate: 0.9 },
          { task_type: "research", task_count: 4, avg_quality_score: 0.79, approval_rate: 0.75 },
        ],
      },
    ];
    const lines = formatQualityByTaskTypeSection(byAgent);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("claude-agent-dashboard");
    expect(lines[0]).toContain("implementation(0.85×18)");
    expect(lines[0]).toContain("research(0.79×4)");
  });

  it("handles null avg_quality_score", () => {
    const byAgent: AgentQualityByTaskType[] = [
      {
        agent_name: "agent-z",
        by_task_type: [
          { task_type: "implementation", task_count: 2, avg_quality_score: null, approval_rate: null },
        ],
      },
    ];
    const lines = formatQualityByTaskTypeSection(byAgent);
    expect(lines[0]).toContain("implementation(n/a×2)");
  });
});

// ── StateStore integration tests ──────────────────────────────────────────────

describe("StateStore routing accuracy queries", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");

    // Seed tasks: two agents, mixed types and outcomes
    const insert = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db.prepare(`
      INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
      VALUES (?, ?, 'done', ?, ?, ?, ?, datetime('now', '-1 day'), datetime('now', '-1 hour'))
    `);

    // agent-a: implementation tasks
    insert.run("T01", "impl task 1", "agent-a", "implementation", 0.9, "approved");
    insert.run("T02", "impl task 2", "agent-a", "implementation", 0.8, "approved");
    insert.run("T03", "impl task 3", "agent-a", "implementation", 0.4, "rejected");
    // agent-a: research task
    insert.run("T04", "research 1", "agent-a", "research", 0.75, "approved");
    // agent-b: implementation
    insert.run("T05", "impl task b1", "agent-b", "implementation", 0.6, "approved");
    insert.run("T06", "impl task b2", "agent-b", "implementation", null, null); // unverified
  });

  it("getRoutingAccuracyStats returns one row per agent", () => {
    const stats = store.getRoutingAccuracyStats(30);
    expect(stats).toHaveLength(2);
    const agentNames = stats.map((s) => s.agent_name).sort();
    expect(agentNames).toEqual(["agent-a", "agent-b"]);
  });

  it("computes correct totals for agent-a", () => {
    const stats = store.getRoutingAccuracyStats(30);
    const a = stats.find((s) => s.agent_name === "agent-a")!;
    expect(a.total_routed).toBe(4);
    expect(a.verified_count).toBe(4); // all approved/rejected
    // avg of 0.9, 0.8, 0.4, 0.75 = 2.85/4 ≈ 0.7125
    expect(a.avg_quality_score).toBeCloseTo(0.7125, 3);
    // 3 approved / 4 = 0.75
    expect(a.approval_rate).toBeCloseTo(0.75, 2);
  });

  it("handles unverified tasks correctly for agent-b", () => {
    const stats = store.getRoutingAccuracyStats(30);
    const b = stats.find((s) => s.agent_name === "agent-b")!;
    expect(b.total_routed).toBe(2);
    expect(b.verified_count).toBe(1); // one verified
    expect(b.avg_quality_score).toBeCloseTo(0.6, 2);
  });

  it("getAgentQualityByTaskType returns breakdown by task type", () => {
    const result = store.getAgentQualityByTaskType();
    const agentA = result.find((r) => r.agent_name === "agent-a")!;
    expect(agentA).toBeDefined();

    const impl = agentA.by_task_type.find((t) => t.task_type === "implementation")!;
    expect(impl).toBeDefined();
    expect(impl.task_count).toBe(3);
    expect(impl.avg_quality_score).toBeCloseTo((0.9 + 0.8 + 0.4) / 3, 3);

    const research = agentA.by_task_type.find((t) => t.task_type === "research")!;
    expect(research).toBeDefined();
    expect(research.task_count).toBe(1);
    expect(research.avg_quality_score).toBeCloseTo(0.75, 2);
  });

  it("getAgentQualityByTaskType respects a custom look-back window", () => {
    // Add a task updated 40 days ago — should be excluded when days=30 but included when days=60
    const insertOld = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db.prepare(`
      INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
      VALUES (?, ?, 'done', ?, ?, ?, ?, datetime('now', '-40 days'), datetime('now', '-40 days'))
    `);
    insertOld.run("T88", "old impl task", "agent-c", "implementation", 0.95, "approved");

    // With default 30-day window, agent-c should not appear
    const result30 = store.getAgentQualityByTaskType(30);
    expect(result30.find((r) => r.agent_name === "agent-c")).toBeUndefined();

    // With 60-day window, agent-c should appear with the correct data
    const result60 = store.getAgentQualityByTaskType(60);
    const agentC = result60.find((r) => r.agent_name === "agent-c");
    expect(agentC).toBeDefined();
    expect(agentC!.by_task_type).toHaveLength(1);
    expect(agentC!.by_task_type[0].task_type).toBe("implementation");
    expect(agentC!.by_task_type[0].task_count).toBe(1);
    expect(agentC!.by_task_type[0].avg_quality_score).toBeCloseTo(0.95, 2);
  });

  it("excludes tasks outside the look-back window", () => {
    // Add an old task (40 days ago)
    const insert = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db.prepare(`
      INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
      VALUES (?, ?, 'done', ?, ?, ?, ?, datetime('now', '-40 days'), datetime('now', '-40 days'))
    `);
    insert.run("T99", "old task", "agent-c", "implementation", 0.95, "approved");

    const stats = store.getRoutingAccuracyStats(30);
    const agentC = stats.find((s) => s.agent_name === "agent-c");
    expect(agentC).toBeUndefined();
  });
});

// ── RoutingAccuracyTracker tests ──────────────────────────────────────────────

describe("RoutingAccuracyTracker", () => {
  let store: StateStore;
  let tracker: RoutingAccuracyTracker;

  beforeEach(() => {
    store = new StateStore(":memory:");
    tracker = new RoutingAccuracyTracker(store);

    const insert = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db.prepare(`
      INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
      VALUES (?, ?, 'done', ?, ?, ?, ?, datetime('now', '-2 days'), datetime('now', '-1 hour'))
    `);
    insert.run("A1", "task 1", "alpha-agent", "implementation", 0.88, "approved");
    insert.run("A2", "task 2", "alpha-agent", "research", 0.70, "approved");
    insert.run("B1", "task 3", "beta-agent", "implementation", 0.55, "rejected");
  });

  it("formatAccuracySection returns non-empty lines", () => {
    const lines = tracker.formatAccuracySection();
    expect(lines.length).toBeGreaterThan(0);
    const combined = lines.join("\n");
    expect(combined).toContain("alpha-agent");
    expect(combined).toContain("beta-agent");
  });

  it("formatQualityByTypeSection returns per-type breakdown", () => {
    const lines = tracker.formatQualityByTypeSection();
    const combined = lines.join("\n");
    expect(combined).toContain("implementation");
    expect(combined).toContain("alpha-agent");
  });

  it("getAccuracyStats delegates to store", () => {
    const stats = tracker.getAccuracyStats(30);
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBe(2);
  });

  it("getQualityByTaskType delegates to store", () => {
    const result = tracker.getQualityByTaskType();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });
});
