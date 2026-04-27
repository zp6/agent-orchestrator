import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import { getAgentTrendsApiPayload } from "../reviewer/agent-trends.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-trends-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let taskSeq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    status?: string;
    updated_at?: string;
  }) => {
    const id = `task-${++taskSeq}`;
    writer
      .prepare(
        `INSERT INTO tasks (
           id, title, description, status, agent_name, task_type, source, source_ref,
           result, verification_status, quality_score, verification_notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${id}`,
        null,
        overrides.status ?? "done",
        overrides.agent_name ?? null,
        "implementation",
        null,
        null,
        null,
        overrides.verification_status ?? null,
        overrides.quality_score ?? null,
        null,
        isoDaysAgo(0),
        overrides.updated_at ?? isoDaysAgo(0),
      );
    return id;
  };

  return {
    store,
    insertTask,
    cleanup: () => {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateStore.getAgentQualityTrend", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("returns an empty per_agent array when the database has no scored tasks", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = store.getAgentQualityTrend();

    expect(result.days).toBe(7);
    expect(result.warning_threshold).toBe(0.75);
    expect(result.per_agent).toEqual([]);
    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns default params when none are supplied", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = store.getAgentQualityTrend();
    expect(result.days).toBe(7);
    expect(result.warning_threshold).toBe(0.75);
  });

  it("respects custom days and warningThreshold params", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = store.getAgentQualityTrend(14, 0.80);
    expect(result.days).toBe(14);
    expect(result.warning_threshold).toBe(0.80);
  });

  it("includes agents with scored tasks and excludes those without", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // alpha: has a quality_score → should appear
    insertTask({ agent_name: "alpha", quality_score: 0.90, updated_at: isoDaysAgo(0) });
    // beta: no quality_score → should NOT appear
    insertTask({ agent_name: "beta", quality_score: null, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);

    expect(result.per_agent).toHaveLength(1);
    expect(result.per_agent[0].agent_name).toBe("alpha");
  });

  it("agents are sorted alphabetically", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "zeta", quality_score: 0.80, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "alpha", quality_score: 0.85, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "mu", quality_score: 0.70, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);

    const names = result.per_agent.map((s) => s.agent_name);
    expect(names).toEqual(["alpha", "mu", "zeta"]);
  });

  it("each series has exactly `days` data points", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.88, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(5);

    expect(result.per_agent[0].days).toHaveLength(5);
  });

  it("data points have null avg_score on days with no scored tasks", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Only one task: today
    insertTask({ agent_name: "alpha", quality_score: 0.90, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);
    const series = result.per_agent[0];

    // All days except today should be null
    const nonToday = series.days.slice(0, -1);
    for (const point of nonToday) {
      expect(point.avg_score).toBeNull();
      expect(point.scored_task_count).toBe(0);
    }

    const today = series.days[series.days.length - 1];
    expect(today.avg_score).toBeCloseTo(0.90, 5);
    expect(today.scored_task_count).toBe(1);
  });

  it("averages multiple scores on the same day", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "alpha", quality_score: 0.60, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];

    expect(today.avg_score).toBeCloseTo(0.70, 5);
    expect(today.scored_task_count).toBe(2);
  });

  it("computes rolling_avg across all scored tasks in the window", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.90, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "alpha", quality_score: 0.70, updated_at: isoDaysAgo(1) });
    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(2) });

    const result = store.getAgentQualityTrend(7);
    const series = result.per_agent[0];

    expect(series.rolling_avg).toBeCloseTo((0.90 + 0.70 + 0.80) / 3, 5);
  });

  it("below_threshold is false when rolling_avg >= warningThreshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.85, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75);
    expect(result.per_agent[0].below_threshold).toBe(false);
  });

  it("below_threshold is true when rolling_avg < warningThreshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.60, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "alpha", quality_score: 0.65, updated_at: isoDaysAgo(1) });

    const result = store.getAgentQualityTrend(7, 0.75);
    expect(result.per_agent[0].below_threshold).toBe(true);
    expect(result.per_agent[0].rolling_avg).toBeLessThan(0.75);
  });

  it("below_threshold is false when rolling_avg equals warningThreshold exactly", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.75, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75);
    // 0.75 is NOT below 0.75 — equal means safe
    expect(result.per_agent[0].below_threshold).toBe(false);
  });

  it("tasks outside the look-back window are excluded", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // 10 days ago — outside a 7-day window
    insertTask({ agent_name: "alpha", quality_score: 0.30, updated_at: isoDaysAgo(10) });
    // 1 day ago — inside window
    insertTask({ agent_name: "alpha", quality_score: 0.90, updated_at: isoDaysAgo(1) });

    const result = store.getAgentQualityTrend(7);
    const series = result.per_agent[0];

    // Only the in-window task contributes to rolling_avg
    expect(series.rolling_avg).toBeCloseTo(0.90, 5);
  });

  it("tasks with null quality_score do not contribute to trend data", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Unscored task for same agent — should not appear in per_agent
    insertTask({ agent_name: "alpha", quality_score: null, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "beta", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);
    const names = result.per_agent.map((s) => s.agent_name);

    expect(names).not.toContain("alpha");
    expect(names).toContain("beta");
  });

  it("handles multiple agents with mixed above/below threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "good-agent", quality_score: 0.92, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "good-agent", quality_score: 0.88, updated_at: isoDaysAgo(1) });
    insertTask({ agent_name: "bad-agent", quality_score: 0.50, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "bad-agent", quality_score: 0.55, updated_at: isoDaysAgo(2) });

    const result = store.getAgentQualityTrend(7, 0.75);

    const goodSeries = result.per_agent.find((s) => s.agent_name === "good-agent")!;
    const badSeries = result.per_agent.find((s) => s.agent_name === "bad-agent")!;

    expect(goodSeries.below_threshold).toBe(false);
    expect(badSeries.below_threshold).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getAgentTrendsApiPayload (wrapper function)
// ---------------------------------------------------------------------------

describe("getAgentTrendsApiPayload", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("delegates to getAgentQualityTrend with default options", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.88, updated_at: isoDaysAgo(0) });

    const payload = getAgentTrendsApiPayload(store);

    expect(payload.days).toBe(7);
    expect(payload.warning_threshold).toBe(0.75);
    expect(payload.per_agent).toHaveLength(1);
    expect(payload.per_agent[0].agent_name).toBe("alpha");
  });

  it("forwards custom days and warningThreshold options", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.72, updated_at: isoDaysAgo(0) });

    const payload = getAgentTrendsApiPayload(store, { days: 14, warningThreshold: 0.80 });

    expect(payload.days).toBe(14);
    expect(payload.warning_threshold).toBe(0.80);
    expect(payload.per_agent[0].below_threshold).toBe(true); // 0.72 < 0.80
  });

  it("response has generated_at in ISO-8601 format", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const payload = getAgentTrendsApiPayload(store);
    expect(payload.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
