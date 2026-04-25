/**
 * Unit tests for standup-quality-trend.ts (issue #498)
 */

import { describe, it, expect, vi } from "vitest";
import {
  recordStandupQualityScore,
  getStandupQualityTrend,
  parseStandupQualityParams,
  formatStandupQualityForTelegram,
  STANDUP_QUALITY_MIGRATION_SQL,
  STANDUP_QUALITY_DEFAULT_DAYS,
  STANDUP_QUALITY_MAX_DAYS,
  STANDUP_LOW_SCORE_THRESHOLD,
  STANDUP_DEGRADATION_STREAK,
} from "../reviewer/standup-quality-trend.js";
import type {
  IStandupQualityStore,
  StandupQualityRecord,
} from "../reviewer/standup-quality-trend.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<StandupQualityRecord> = {}): StandupQualityRecord {
  return {
    agent_id: "claude-test-agent",
    date: "2026-04-25",
    score: 0.85,
    action_item_count: 5,
    task_id: "TASK_01",
    recorded_at: "2026-04-25T10:00:00.000Z",
    ...overrides,
  };
}

function makeStore(
  records: StandupQualityRecord[] = [],
): IStandupQualityStore & { inserted: StandupQualityRecord[] } {
  const inserted: StandupQualityRecord[] = [];
  return {
    inserted,
    recordStandupQualityScore: vi.fn((r) => inserted.push(r as StandupQualityRecord)),
    getStandupQualityRecords: vi.fn(() => records),
  };
}

// ── STANDUP_QUALITY_MIGRATION_SQL ─────────────────────────────────────────────

describe("STANDUP_QUALITY_MIGRATION_SQL", () => {
  it("creates standup_quality_history table", () => {
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("CREATE TABLE IF NOT EXISTS standup_quality_history");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("agent_id");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("score");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("action_item_count");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("task_id");
  });

  it("creates an index on agent_id and date", () => {
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("CREATE INDEX IF NOT EXISTS");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("agent_id");
    expect(STANDUP_QUALITY_MIGRATION_SQL).toContain("date");
  });
});

// ── recordStandupQualityScore ─────────────────────────────────────────────────

describe("recordStandupQualityScore", () => {
  it("inserts a record with correct fields", () => {
    const store = makeStore();
    recordStandupQualityScore(store, "claude-agent-x", 0.85, 8, "TASK_ABC");
    expect(store.recordStandupQualityScore).toHaveBeenCalledOnce();
    const [record] = store.inserted;
    expect(record.agent_id).toBe("claude-agent-x");
    expect(record.score).toBe(0.85);
    expect(record.action_item_count).toBe(8);
    expect(record.task_id).toBe("TASK_ABC");
    expect(record.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(record.recorded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("clamps score to [0, 1]", () => {
    const store = makeStore();
    recordStandupQualityScore(store, "agent", 1.5, 3, "T1");
    expect(store.inserted[0].score).toBe(1);

    const store2 = makeStore();
    recordStandupQualityScore(store2, "agent", -0.5, 3, "T2");
    expect(store2.inserted[0].score).toBe(0);
  });

  it("clamps action_item_count to >= 0", () => {
    const store = makeStore();
    recordStandupQualityScore(store, "agent", 0.8, -3, "T1");
    expect(store.inserted[0].action_item_count).toBe(0);
  });

  it("swallows store errors gracefully", () => {
    const store: IStandupQualityStore = {
      recordStandupQualityScore: () => { throw new Error("DB down"); },
      getStandupQualityRecords: vi.fn(() => []),
    };
    expect(() => recordStandupQualityScore(store, "agent", 0.8, 5, "T1")).not.toThrow();
  });
});

// ── getStandupQualityTrend ────────────────────────────────────────────────────

describe("getStandupQualityTrend", () => {
  it("returns empty payload when no records exist", () => {
    const store = makeStore([]);
    const result = getStandupQualityTrend(store);
    expect(result.records).toEqual([]);
    expect(result.avg_score).toBeNull();
    expect(result.low_score_streak).toBe(0);
    expect(result.is_degrading).toBe(false);
    expect(result.window_days).toBe(STANDUP_QUALITY_DEFAULT_DAYS);
    expect(result.agent_id).toBeNull();
    expect(result.generated_at).toBeTruthy();
  });

  it("computes avg_score correctly", () => {
    const records = [
      makeRecord({ score: 0.8 }),
      makeRecord({ score: 0.6 }),
      makeRecord({ score: 1.0 }),
    ];
    const store = makeStore(records);
    const result = getStandupQualityTrend(store);
    expect(result.avg_score).toBeCloseTo(0.8, 2);
  });

  it("detects is_degrading when last 3 scores all below threshold", () => {
    const records = [
      makeRecord({ score: 0.9 }),
      makeRecord({ score: 0.5, task_id: "T2" }),
      makeRecord({ score: 0.4, task_id: "T3" }),
      makeRecord({ score: 0.6, task_id: "T4" }),
    ];
    const store = makeStore(records);
    const result = getStandupQualityTrend(store);
    expect(result.low_score_streak).toBe(STANDUP_DEGRADATION_STREAK);
    expect(result.is_degrading).toBe(true);
  });

  it("does not flag is_degrading when last score is above threshold", () => {
    const records = [
      makeRecord({ score: 0.5 }),
      makeRecord({ score: 0.4, task_id: "T2" }),
      makeRecord({ score: 0.85, task_id: "T3" }),
    ];
    const store = makeStore(records);
    const result = getStandupQualityTrend(store);
    expect(result.low_score_streak).toBe(0);
    expect(result.is_degrading).toBe(false);
  });

  it("reports partial streak when fewer than STANDUP_DEGRADATION_STREAK consecutive lows", () => {
    const records = [
      makeRecord({ score: 0.9 }),
      makeRecord({ score: 0.8, task_id: "T2" }),
      makeRecord({ score: 0.5, task_id: "T3" }),
      makeRecord({ score: 0.6, task_id: "T4" }),
    ];
    const store = makeStore(records);
    const result = getStandupQualityTrend(store);
    expect(result.low_score_streak).toBe(2);
    expect(result.is_degrading).toBe(false);
  });

  it("applies agentId filter as non-null string", () => {
    const store = makeStore([makeRecord()]);
    getStandupQualityTrend(store, "claude-agent-x", 14);
    expect(store.getStandupQualityRecords).toHaveBeenCalledWith("claude-agent-x", expect.any(String));
  });

  it("passes null agentId when not specified", () => {
    const store = makeStore([]);
    getStandupQualityTrend(store, null, 7);
    expect(store.getStandupQualityRecords).toHaveBeenCalledWith(null, expect.any(String));
  });

  it("clamps window_days to valid range", () => {
    const store = makeStore([]);
    expect(getStandupQualityTrend(store, null, 0).window_days).toBe(1);
    expect(getStandupQualityTrend(store, null, -10).window_days).toBe(1);
    expect(getStandupQualityTrend(store, null, 200).window_days).toBe(STANDUP_QUALITY_MAX_DAYS);
  });

  it("returns empty payload when store throws", () => {
    const store: IStandupQualityStore = {
      recordStandupQualityScore: vi.fn(),
      getStandupQualityRecords: () => { throw new Error("DB error"); },
    };
    const result = getStandupQualityTrend(store);
    expect(result.records).toEqual([]);
    expect(result.avg_score).toBeNull();
  });
});

// ── parseStandupQualityParams ─────────────────────────────────────────────────

describe("parseStandupQualityParams", () => {
  it("returns defaults for empty args", () => {
    expect(parseStandupQualityParams("")).toEqual({
      agent_id: null,
      days: STANDUP_QUALITY_DEFAULT_DAYS,
    });
  });

  it("parses numeric-only arg as days", () => {
    expect(parseStandupQualityParams("14")).toEqual({ agent_id: null, days: 14 });
  });

  it("parses agent-only arg", () => {
    expect(parseStandupQualityParams("claude-agent-x")).toEqual({
      agent_id: "claude-agent-x",
      days: STANDUP_QUALITY_DEFAULT_DAYS,
    });
  });

  it("parses agent and days together", () => {
    expect(parseStandupQualityParams("claude-agent-x 14")).toEqual({
      agent_id: "claude-agent-x",
      days: 14,
    });
  });

  it("handles reversed order (days then agent)", () => {
    expect(parseStandupQualityParams("14 claude-agent-x")).toEqual({
      agent_id: "claude-agent-x",
      days: 14,
    });
  });

  it("clamps days below minimum to 1", () => {
    expect(parseStandupQualityParams("0")).toEqual({ agent_id: null, days: 1 });
    expect(parseStandupQualityParams("-5")).toEqual({ agent_id: null, days: 1 });
  });

  it("clamps days above maximum", () => {
    expect(parseStandupQualityParams("999")).toEqual({
      agent_id: null,
      days: STANDUP_QUALITY_MAX_DAYS,
    });
  });
});

// ── formatStandupQualityForTelegram ───────────────────────────────────────────

describe("formatStandupQualityForTelegram", () => {
  it("shows 'No standup records' when records is empty", () => {
    const payload = getStandupQualityTrend(makeStore([]), null, 7);
    const output = formatStandupQualityForTelegram(payload);
    expect(output).toContain("No standup records");
  });

  it("includes sparkline chars in output", () => {
    const records = [
      makeRecord({ score: 0.9 }),
      makeRecord({ score: 0.5, task_id: "T2" }),
    ];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    // Sparkline is wrapped in <code>
    expect(output).toMatch(/<code>[▁▂▃▄▅▆▇█]+<\/code>/);
  });

  it("shows degradation alert when is_degrading is true", () => {
    const records = [
      makeRecord({ score: 0.5 }),
      makeRecord({ score: 0.4, task_id: "T2" }),
      makeRecord({ score: 0.6, task_id: "T3" }),
    ];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).toContain("Degradation alert");
    expect(output).toContain("🔴");
  });

  it("shows partial streak warning without degradation alert", () => {
    const records = [
      makeRecord({ score: 0.9 }),
      makeRecord({ score: 0.5, task_id: "T2" }),
      makeRecord({ score: 0.6, task_id: "T3" }),
    ];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).not.toContain("Degradation alert");
    expect(output).toContain("recent standup");
    expect(output).toContain("2 recent standup");
  });

  it("shows agent label when agent_id is set", () => {
    const records = [makeRecord({ agent_id: "claude-agent-x" })];
    const store = makeStore(records);
    const payload = getStandupQualityTrend(store, "claude-agent-x", 7);
    const output = formatStandupQualityForTelegram(payload);
    expect(output).toContain("claude-agent-x");
  });

  it("shows 'all agents' label when agent_id is null", () => {
    const records = [makeRecord()];
    const payload = getStandupQualityTrend(makeStore(records));
    const output = formatStandupQualityForTelegram(payload);
    expect(output).toContain("all agents");
  });

  it("includes avg score in output", () => {
    const records = [makeRecord({ score: 0.8 })];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).toContain("80%");
    expect(output).toContain("avg");
  });

  it("uses ✅ emoji for avg score >= 0.80", () => {
    const records = [makeRecord({ score: 0.9 })];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).toContain("✅");
  });

  it("uses ⚠️ emoji for avg score in [0.70, 0.80)", () => {
    const records = [makeRecord({ score: 0.75 })];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).toContain("⚠️");
  });

  it("uses 🔴 emoji for avg score below 0.70", () => {
    const records = [
      makeRecord({ score: 0.5 }),
      makeRecord({ score: 0.4, task_id: "T2" }),
      makeRecord({ score: 0.6, task_id: "T3" }),
    ];
    const output = formatStandupQualityForTelegram(
      getStandupQualityTrend(makeStore(records))
    );
    expect(output).toContain("🔴");
  });
});

// ── Constants sanity ──────────────────────────────────────────────────────────

describe("constants", () => {
  it("has sensible defaults", () => {
    expect(STANDUP_QUALITY_DEFAULT_DAYS).toBe(7);
    expect(STANDUP_QUALITY_MAX_DAYS).toBe(90);
    expect(STANDUP_LOW_SCORE_THRESHOLD).toBe(0.7);
    expect(STANDUP_DEGRADATION_STREAK).toBe(3);
  });
});
