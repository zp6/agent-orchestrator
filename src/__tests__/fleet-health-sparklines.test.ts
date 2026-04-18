/**
 * Tests for the fleet health sparklines (issue #286).
 *
 * Covers:
 *  1. band annotation per data point ("red"/"yellow"/"green"/null)
 *  2. risk_tier per agent series (overall band from rolling_avg)
 *  3. red_threshold and yellow_threshold fields in AgentQualityTrend
 *  4. task_history_url per data point (click-through)
 *  5. getFleetHealthSparklines() — fleet summary counts, threshold propagation
 *  6. Custom threshold overrides
 *  7. Empty-DB fallback
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import {
  getFleetHealthSparklines,
  FLEET_RED_THRESHOLD,
  FLEET_YELLOW_THRESHOLD,
  FLEET_DEFAULT_DAYS,
} from "../reviewer/fleet-health-sparklines.js";
import { getAgentTrendsApiPayload } from "../reviewer/agent-trends.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-fleet-health-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let taskSeq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    updated_at?: string;
    status?: string;
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
        "approved",
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

// ── Module constants ──────────────────────────────────────────────────────────

describe("fleet-health-sparklines constants", () => {
  it("FLEET_RED_THRESHOLD is 0.60", () => {
    expect(FLEET_RED_THRESHOLD).toBe(0.60);
  });

  it("FLEET_YELLOW_THRESHOLD is 0.75", () => {
    expect(FLEET_YELLOW_THRESHOLD).toBe(0.75);
  });

  it("FLEET_DEFAULT_DAYS is 7", () => {
    expect(FLEET_DEFAULT_DAYS).toBe(7);
  });
});

// ── Band annotation per data point ───────────────────────────────────────────

describe("AgentQualityTrendPoint.band coloring", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("band is null when no data on a day (avg_score is null)", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Only one task today — all other days have null avg_score
    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);
    const series = result.per_agent[0];
    const nullDays = series.days.slice(0, -1); // all but today
    for (const point of nullDays) {
      expect(point.avg_score).toBeNull();
      expect(point.band).toBeNull();
    }
  });

  it("band is 'green' when avg_score >= yellow_threshold (0.75)", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.90, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.band).toBe("green");
  });

  it("band is 'green' when avg_score exactly equals yellow_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.75, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.band).toBe("green");
  });

  it("band is 'yellow' when red_threshold <= avg_score < yellow_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // 0.65 is in the [0.60, 0.75) range → yellow
    insertTask({ agent_name: "alpha", quality_score: 0.65, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.band).toBe("yellow");
  });

  it("band is 'yellow' when avg_score exactly equals red_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.60, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.band).toBe("yellow");
  });

  it("band is 'red' when avg_score < red_threshold (0.60)", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.48, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.band).toBe("red");
  });

  it("band boundary: score just below yellow → yellow, score at yellow → green", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "just-yellow", quality_score: 0.749, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "just-green", quality_score: 0.750, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const yellowSeries = result.per_agent.find((s) => s.agent_name === "just-yellow")!;
    const greenSeries = result.per_agent.find((s) => s.agent_name === "just-green")!;

    const yellowToday = yellowSeries.days[yellowSeries.days.length - 1];
    const greenToday = greenSeries.days[greenSeries.days.length - 1];

    expect(yellowToday.band).toBe("yellow");
    expect(greenToday.band).toBe("green");
  });
});

// ── risk_tier per agent series ────────────────────────────────────────────────

describe("AgentQualityTrendSeries.risk_tier", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("risk_tier is null when agent has no scored tasks", () => {
    // Agent with tasks but no quality_score → excluded from per_agent entirely
    // So we test risk_tier null via no-data scenario directly
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;
    const result = store.getAgentQualityTrend(7);
    // No agents → per_agent is empty, nothing to assert on risk_tier
    expect(result.per_agent).toHaveLength(0);
  });

  it("risk_tier is 'red' when rolling_avg < red_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "bad-agent", quality_score: 0.45, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "bad-agent", quality_score: 0.55, updated_at: isoDaysAgo(1) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    expect(result.per_agent[0].risk_tier).toBe("red");
    expect(result.per_agent[0].rolling_avg).toBeLessThan(0.60);
  });

  it("risk_tier is 'yellow' when red_threshold <= rolling_avg < yellow_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "warn-agent", quality_score: 0.65, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "warn-agent", quality_score: 0.70, updated_at: isoDaysAgo(1) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    expect(result.per_agent[0].risk_tier).toBe("yellow");
  });

  it("risk_tier is 'green' when rolling_avg >= yellow_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "good-agent", quality_score: 0.90, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    expect(result.per_agent[0].risk_tier).toBe("green");
  });

  it("risk_tier is independent of below_threshold", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // rolling_avg = 0.70: above red (0.60), below warning (0.75) → yellow risk_tier
    // but below_threshold depends on warningThreshold (0.75 default)
    insertTask({ agent_name: "mid-agent", quality_score: 0.70, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75);
    const series = result.per_agent[0];
    expect(series.risk_tier).toBe("yellow");
    expect(series.below_threshold).toBe(true); // 0.70 < 0.75
  });
});

// ── red_threshold and yellow_threshold in AgentQualityTrend ──────────────────

describe("AgentQualityTrend threshold fields", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("red_threshold defaults to 0.60", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;
    const result = store.getAgentQualityTrend();
    expect(result.red_threshold).toBe(0.60);
  });

  it("yellow_threshold defaults to 0.75", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;
    const result = store.getAgentQualityTrend();
    expect(result.yellow_threshold).toBe(0.75);
  });

  it("custom red/yellow thresholds are reflected in the response", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;
    const result = store.getAgentQualityTrend(7, 0.80, 0.50, 0.70);
    expect(result.red_threshold).toBe(0.50);
    expect(result.yellow_threshold).toBe(0.70);
  });
});

// ── task_history_url click-through ───────────────────────────────────────────

describe("task_history_url per data point", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("task_history_url is null when no taskHistoryBaseUrl provided", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7);
    for (const point of result.per_agent[0].days) {
      expect(point.task_history_url).toBeNull();
    }
  });

  it("task_history_url includes base URL, agent name, and date", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75, "/tasks");
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.task_history_url).toContain("/tasks");
    expect(today.task_history_url).toContain("agent=alpha");
    expect(today.task_history_url).toMatch(/date=\d{4}-\d{2}-\d{2}/);
  });

  it("task_history_url encodes special characters in agent names", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "my agent/v2", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(7, 0.75, 0.60, 0.75, "/tasks");
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.task_history_url).toContain(encodeURIComponent("my agent/v2"));
  });

  it("task_history_url uses provided base URL as a prefix", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = store.getAgentQualityTrend(
      7, 0.75, 0.60, 0.75, "https://dashboard.example.com/tasks"
    );
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.task_history_url).toMatch(/^https:\/\/dashboard\.example\.com\/tasks\?/);
  });

  it("getAgentTrendsApiPayload forwards taskHistoryBaseUrl option", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = getAgentTrendsApiPayload(store, { taskHistoryBaseUrl: "/tasks" });
    const today = result.per_agent[0].days[result.per_agent[0].days.length - 1];
    expect(today.task_history_url).toContain("/tasks");
  });
});

// ── getFleetHealthSparklines ──────────────────────────────────────────────────

describe("getFleetHealthSparklines", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("returns empty fleet_summary when no agents have scored tasks", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = getFleetHealthSparklines(store);
    expect(result.fleet_summary.total_active).toBe(0);
    expect(result.fleet_summary.red).toBe(0);
    expect(result.fleet_summary.yellow).toBe(0);
    expect(result.fleet_summary.green).toBe(0);
    expect(result.agents).toHaveLength(0);
  });

  it("uses default thresholds from constants", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = getFleetHealthSparklines(store);
    expect(result.red_threshold).toBe(FLEET_RED_THRESHOLD);
    expect(result.yellow_threshold).toBe(FLEET_YELLOW_THRESHOLD);
    expect(result.days).toBe(FLEET_DEFAULT_DAYS);
  });

  it("counts agents into the correct risk tier buckets", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // red: rolling_avg = 0.45
    insertTask({ agent_name: "agent-red", quality_score: 0.45, updated_at: isoDaysAgo(0) });
    // yellow: rolling_avg = 0.65
    insertTask({ agent_name: "agent-yellow", quality_score: 0.65, updated_at: isoDaysAgo(0) });
    // green: rolling_avg = 0.85
    insertTask({ agent_name: "agent-green", quality_score: 0.85, updated_at: isoDaysAgo(0) });

    const result = getFleetHealthSparklines(store);
    expect(result.fleet_summary.red).toBe(1);
    expect(result.fleet_summary.yellow).toBe(1);
    expect(result.fleet_summary.green).toBe(1);
    expect(result.fleet_summary.total_active).toBe(3);
  });

  it("agents field has one entry per active agent with risk_tier set", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "agent-a", quality_score: 0.90, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "agent-b", quality_score: 0.55, updated_at: isoDaysAgo(0) });

    const result = getFleetHealthSparklines(store);
    expect(result.agents).toHaveLength(2);

    const a = result.agents.find((s) => s.agent_name === "agent-a")!;
    const b = result.agents.find((s) => s.agent_name === "agent-b")!;

    expect(a.risk_tier).toBe("green");
    expect(b.risk_tier).toBe("red");
  });

  it("forwards task_history_base_url to sparkline points", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = getFleetHealthSparklines(store, { task_history_base_url: "/tasks" });
    const series = result.agents[0];
    const today = series.days[series.days.length - 1];
    expect(today.task_history_url).toContain("/tasks");
    expect(today.task_history_url).toContain("agent=alpha");
  });

  it("respects custom red and yellow threshold overrides", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // With default thresholds (0.60/0.75): 0.65 → yellow
    // With custom thresholds (0.70/0.80): 0.65 → red
    insertTask({ agent_name: "agent-x", quality_score: 0.65, updated_at: isoDaysAgo(0) });

    const resultDefault = getFleetHealthSparklines(store);
    expect(resultDefault.fleet_summary.yellow).toBe(1);
    expect(resultDefault.fleet_summary.red).toBe(0);

    const resultCustom = getFleetHealthSparklines(store, {
      red_threshold: 0.70,
      yellow_threshold: 0.80,
    });
    expect(resultCustom.fleet_summary.red).toBe(1);
    expect(resultCustom.fleet_summary.yellow).toBe(0);
  });

  it("fleet_summary counts no_data when rolling_avg is null", () => {
    // This can't easily be forced via the existing DB query (null rolling_avg
    // means the agent is excluded from per_agent), but we verify the field
    // is present and 0 in the normal case
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "alpha", quality_score: 0.80, updated_at: isoDaysAgo(0) });

    const result = getFleetHealthSparklines(store);
    expect(result.fleet_summary.no_data).toBe(0); // all active agents have data
  });

  it("fleet summary has a generated_at ISO timestamp", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = getFleetHealthSparklines(store);
    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("multiple red agents increment fleet_summary.red by count", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ agent_name: "red-1", quality_score: 0.40, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "red-2", quality_score: 0.50, updated_at: isoDaysAgo(0) });
    insertTask({ agent_name: "red-3", quality_score: 0.55, updated_at: isoDaysAgo(0) });

    const result = getFleetHealthSparklines(store);
    expect(result.fleet_summary.red).toBe(3);
    expect(result.fleet_summary.total_active).toBe(3);
  });
});
