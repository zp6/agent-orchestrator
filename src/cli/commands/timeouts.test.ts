import { describe, it, expect } from "vitest";
import {
  colorTimeoutRate,
  formatSuggestedTimeout,
  buildRecommendations,
} from "./timeouts.js";
import type { AgentTimeoutAnalytics } from "../../state/store.js";

/** Strip ANSI escape codes for assertion-friendly comparison. */
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("colorTimeoutRate", () => {
  it("returns em-dash for null", () => {
    expect(strip(colorTimeoutRate(null))).toBe("—");
  });

  it("returns '0%' for zero", () => {
    expect(strip(colorTimeoutRate(0))).toBe("0%");
  });

  it("rounds and appends % sign", () => {
    expect(strip(colorTimeoutRate(33.6))).toBe("34%");
  });

  it("handles 100%", () => {
    expect(strip(colorTimeoutRate(100))).toBe("100%");
  });
});

describe("formatSuggestedTimeout", () => {
  it("returns em-dash for null", () => {
    expect(strip(formatSuggestedTimeout(null))).toBe("—");
  });

  it("formats 5 minutes correctly", () => {
    expect(strip(formatSuggestedTimeout(5 * 60 * 1000))).toBe("5m");
  });

  it("formats 12 minutes correctly", () => {
    expect(strip(formatSuggestedTimeout(12 * 60 * 1000))).toBe("12m");
  });

  it("rounds to nearest minute", () => {
    // 7.5 minutes → rounds to 8m
    expect(strip(formatSuggestedTimeout(7.5 * 60 * 1000))).toBe("8m");
  });
});

describe("buildRecommendations", () => {
  const makeAgent = (
    overrides: Partial<AgentTimeoutAnalytics>,
  ): AgentTimeoutAnalytics => ({
    agent_name: "test-agent",
    total_tasks: 10,
    timed_out_tasks: 0,
    timeout_rate_pct: 0,
    avg_duration_ms: null,
    p95_duration_ms: null,
    suggested_timeout_ms: null,
    ...overrides,
  });

  it("returns empty list when no agents have issues", () => {
    const agents = [
      makeAgent({ timed_out_tasks: 0, suggested_timeout_ms: null }),
    ];
    const recs = buildRecommendations(agents);
    expect(recs).toHaveLength(0);
  });

  it("includes a recommendation for agents with timeouts and a suggested value", () => {
    const agents = [
      makeAgent({
        agent_name: "my-agent",
        timed_out_tasks: 3,
        timeout_rate_pct: 30,
        p95_duration_ms: 8 * 60 * 1000,
        suggested_timeout_ms: 10 * 60 * 1000,
      }),
    ];
    const recs = buildRecommendations(agents);
    expect(recs).toHaveLength(1);
    const rec = strip(recs[0]);
    expect(rec).toContain("my-agent");
    expect(rec).toContain("30% timeout rate");
    expect(rec).toContain("10m");
  });

  it("includes a recommendation for agents with timeouts but no p95", () => {
    const agents = [
      makeAgent({
        agent_name: "busy-agent",
        timed_out_tasks: 2,
        timeout_rate_pct: 20,
        p95_duration_ms: null,
        suggested_timeout_ms: null,
      }),
    ];
    const recs = buildRecommendations(agents);
    expect(recs).toHaveLength(1);
    const rec = strip(recs[0]);
    expect(rec).toContain("busy-agent");
    expect(rec).toContain("consider raising timeout_ms");
  });

  it("includes agents with no timeouts but a computable p95 suggestion", () => {
    const agents = [
      makeAgent({
        agent_name: "fast-agent",
        timed_out_tasks: 0,
        timeout_rate_pct: 0,
        p95_duration_ms: 3 * 60 * 1000,
        suggested_timeout_ms: 4 * 60 * 1000,
      }),
    ];
    const recs = buildRecommendations(agents);
    expect(recs).toHaveLength(1);
    const rec = strip(recs[0]);
    expect(rec).toContain("fast-agent");
    expect(rec).toContain("no timeouts");
  });

  it("handles multiple agents and filters correctly", () => {
    const agents = [
      makeAgent({
        agent_name: "clean-agent",
        timed_out_tasks: 0,
        suggested_timeout_ms: null,
      }),
      makeAgent({
        agent_name: "troubled-agent",
        timed_out_tasks: 5,
        timeout_rate_pct: 50,
        suggested_timeout_ms: 15 * 60 * 1000,
      }),
    ];
    const recs = buildRecommendations(agents);
    // clean-agent has no timeouts and no suggestion → excluded
    expect(recs).toHaveLength(1);
    expect(strip(recs[0])).toContain("troubled-agent");
  });
});

describe("getTimeoutAnalytics (StateStore)", () => {
  it("returns empty analytics when database has no tasks", async () => {
    const { StateStore } = await import("../../state/store.js");
    const store = new StateStore(":memory:");
    const analytics = store.getTimeoutAnalytics(7);
    expect(analytics.total_tasks).toBe(0);
    expect(analytics.total_timed_out).toBe(0);
    expect(analytics.per_agent).toHaveLength(0);
    expect(analytics.timeout_tasks).toHaveLength(0);
    store.close();
  });

  it("computes timeout rate and suggested timeout from seeded tasks", async () => {
    const { StateStore } = await import("../../state/store.js");
    const store = new StateStore(":memory:");

    // Create tasks with known durations by manipulating created_at / updated_at
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;

    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Insert 4 completed tasks for "agent-a" with 5m, 6m, 7m, 8m durations
    const durations = [5, 6, 7, 8]; // minutes
    for (let i = 0; i < durations.length; i++) {
      const created = new Date(yesterday.getTime() + i * 1000).toISOString();
      const done = new Date(
        yesterday.getTime() + i * 1000 + durations[i] * 60 * 1000,
      ).toISOString();
      db.prepare(
        `INSERT INTO tasks (id, title, description, source, status, agent_name, task_type,
          retry_count, created_at, updated_at)
         VALUES (?, ?, NULL, 'manual', 'done', 'agent-a', 'implementation', ?, ?, ?)`,
      ).run(`ID${i}`, `Task ${i}`, i === 0 ? 1 : 0, created, done);
    }

    const analytics = store.getTimeoutAnalytics(7);

    expect(analytics.per_agent).toHaveLength(1);
    const agentA = analytics.per_agent[0];
    expect(agentA.agent_name).toBe("agent-a");
    expect(agentA.total_tasks).toBe(4);
    expect(agentA.timed_out_tasks).toBe(1); // only task 0 has retry_count=1
    expect(agentA.timeout_rate_pct).toBeCloseTo(25, 1);

    // p95 of [5, 6, 7, 8] minutes → ceil(0.95 * 4) = 4th value = 8 minutes
    expect(agentA.p95_duration_ms).toBeCloseTo(8 * 60 * 1000, -3); // within 1s

    // suggested = ceil(8*1.2 / 1) rounded up to next minute = ceil(9.6) = 10 minutes
    expect(agentA.suggested_timeout_ms).toBe(10 * 60 * 1000);

    // The one timed-out task appears in timeout_tasks
    expect(analytics.timeout_tasks).toHaveLength(1);
    expect(analytics.timeout_tasks[0].id).toBe("ID0");

    store.close();
  });

  it("respects the days window and excludes old tasks", async () => {
    const { StateStore } = await import("../../state/store.js");
    const store = new StateStore(":memory:");
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;

    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    db.prepare(
      `INSERT INTO tasks (id, title, description, source, status, agent_name, task_type,
        retry_count, created_at, updated_at)
       VALUES (?, ?, NULL, 'manual', 'failed', 'agent-b', 'implementation', 1, ?, ?)`,
    ).run("OLD1", "Old task", tenDaysAgo, tenDaysAgo);

    db.prepare(
      `INSERT INTO tasks (id, title, description, source, status, agent_name, task_type,
        retry_count, created_at, updated_at)
       VALUES (?, ?, NULL, 'manual', 'failed', 'agent-b', 'implementation', 1, ?, ?)`,
    ).run("NEW1", "Recent task", yesterday, yesterday);

    // 7-day window should only see NEW1
    const analytics = store.getTimeoutAnalytics(7);
    expect(analytics.total_tasks).toBe(1);
    expect(analytics.timeout_tasks.map((t) => t.id)).toEqual(["NEW1"]);

    store.close();
  });
});
