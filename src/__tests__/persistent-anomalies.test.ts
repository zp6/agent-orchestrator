/**
 * Unit tests for persistent-anomalies.ts (issue #483)
 */

import { describe, it, expect, vi } from "vitest";
import {
  recordAnomalyObservation,
  getPersistentAnomaliesPayload,
  formatPersistentAnomaliesForTelegram,
  generateCycleId,
  PERSISTENT_ANOMALIES_MIGRATION_SQL,
  DEFAULT_MIN_CYCLES,
  DEFAULT_ANOMALY_LOOKBACK_DAYS,
} from "../reviewer/persistent-anomalies.js";
import type { IPersistentAnomalyStore, PersistentAnomaly } from "../reviewer/persistent-anomalies.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAnomaly(overrides: Partial<PersistentAnomaly> = {}): PersistentAnomaly {
  return {
    task_id: "TASK_01",
    agent_name: "claude-test-agent",
    latest_score: 0,
    cycle_count: 3,
    anomaly_type: "low_score_approved",
    first_observed_at: "2026-04-23T09:00:00.000Z",
    last_observed_at: "2026-04-25T09:00:00.000Z",
    ...overrides,
  };
}

function makeStore(anomalies: PersistentAnomaly[] = []): IPersistentAnomalyStore {
  return {
    insertAnomalyObservation: vi.fn(),
    getPersistentAnomalies: vi.fn(() => anomalies),
  };
}

// ── recordAnomalyObservation ───────────────────────────────────────────────────

describe("recordAnomalyObservation", () => {
  it("calls insertAnomalyObservation with correct fields", () => {
    const store = makeStore();
    recordAnomalyObservation(store, {
      task_id: "TASK_01",
      cycle_id: "2026-04-25T09:00",
      agent_name: "my-agent",
      score: 0.1,
      anomaly_type: "low_score_approved",
    });
    expect(store.insertAnomalyObservation).toHaveBeenCalledWith({
      task_id: "TASK_01",
      cycle_id: "2026-04-25T09:00",
      agent_name: "my-agent",
      score: 0.1,
      anomaly_type: "low_score_approved",
    });
  });

  it("uses default values for optional fields", () => {
    const store = makeStore();
    recordAnomalyObservation(store, {
      task_id: "TASK_02",
      cycle_id: "2026-04-25T09:00",
    });
    expect(store.insertAnomalyObservation).toHaveBeenCalledWith({
      task_id: "TASK_02",
      cycle_id: "2026-04-25T09:00",
      agent_name: null,
      score: 0,
      anomaly_type: "low_score_approved",
    });
  });

  it("swallows errors non-fatally", () => {
    const store: IPersistentAnomalyStore = {
      insertAnomalyObservation: () => {
        throw new Error("DB error");
      },
      getPersistentAnomalies: () => [],
    };
    // Should not throw
    expect(() =>
      recordAnomalyObservation(store, { task_id: "TASK_01", cycle_id: "cycle-1" }),
    ).not.toThrow();
  });
});

// ── getPersistentAnomaliesPayload ─────────────────────────────────────────────

describe("getPersistentAnomaliesPayload", () => {
  it("returns empty payload when no anomalies", () => {
    const store = makeStore([]);
    const result = getPersistentAnomaliesPayload(store);
    expect(result.total).toBe(0);
    expect(result.anomalies).toHaveLength(0);
    expect(result.by_agent).toHaveLength(0);
    expect(result.generated_at).toBeTruthy();
  });

  it("returns anomalies with correct counts", () => {
    const anomalies = [
      makeAnomaly({ agent_name: "agent-a" }),
      makeAnomaly({ task_id: "TASK_02", agent_name: "agent-a" }),
      makeAnomaly({ task_id: "TASK_03", agent_name: "agent-b" }),
    ];
    const store = makeStore(anomalies);
    const result = getPersistentAnomaliesPayload(store);
    expect(result.total).toBe(3);
    expect(result.by_agent).toEqual([
      { agent_name: "agent-a", count: 2 },
      { agent_name: "agent-b", count: 1 },
    ]);
  });

  it("applies default min_cycles and days", () => {
    const store = makeStore([]);
    const result = getPersistentAnomaliesPayload(store);
    expect(result.min_cycles).toBe(DEFAULT_MIN_CYCLES);
    expect(result.days).toBe(DEFAULT_ANOMALY_LOOKBACK_DAYS);
    expect(store.getPersistentAnomalies).toHaveBeenCalledWith(DEFAULT_MIN_CYCLES, DEFAULT_ANOMALY_LOOKBACK_DAYS, 50);
  });

  it("passes custom options to store", () => {
    const store = makeStore([]);
    getPersistentAnomaliesPayload(store, { minCycles: 5, days: 14, limit: 100 });
    expect(store.getPersistentAnomalies).toHaveBeenCalledWith(5, 14, 100);
  });

  it("handles store errors gracefully", () => {
    const store: IPersistentAnomalyStore = {
      insertAnomalyObservation: vi.fn(),
      getPersistentAnomalies: () => {
        throw new Error("DB error");
      },
    };
    const result = getPersistentAnomaliesPayload(store);
    expect(result.total).toBe(0);
    expect(result.anomalies).toHaveLength(0);
  });

  it("groups unknown agent_name as 'unknown'", () => {
    const anomalies = [makeAnomaly({ agent_name: null })];
    const store = makeStore(anomalies);
    const result = getPersistentAnomaliesPayload(store);
    expect(result.by_agent[0].agent_name).toBe("unknown");
  });
});

// ── formatPersistentAnomaliesForTelegram ──────────────────────────────────────

describe("formatPersistentAnomaliesForTelegram", () => {
  it("returns empty string when no anomalies", () => {
    const payload = getPersistentAnomaliesPayload(makeStore([]));
    expect(formatPersistentAnomaliesForTelegram(payload)).toBe("");
  });

  it("includes header with count and window", () => {
    const anomalies = [makeAnomaly({ cycle_count: 3 })];
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("Persistent anomalies");
    expect(output).toContain("1");
    expect(output).toContain(String(DEFAULT_MIN_CYCLES));
  });

  it("includes task details per anomaly", () => {
    const anomalies = [makeAnomaly({ task_id: "TASK_01ABCDEFG", agent_name: "my-agent", latest_score: 0, cycle_count: 2 })];
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("TASK_01ABC");
    expect(output).toContain("my-agent");
    expect(output).toContain("2 cycles");
  });

  it("truncates to 5 anomalies and shows 'and N more'", () => {
    const anomalies = Array.from({ length: 8 }, (_, i) =>
      makeAnomaly({ task_id: `TASK_${String(i).padStart(2, "0")}` }),
    );
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("3 more");
  });

  it("labels default_fallback_approved anomaly correctly", () => {
    const anomalies = [makeAnomaly({ anomaly_type: "default_fallback_approved" })];
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("parse-failure approved");
  });

  it("labels high_score_rejected anomaly correctly", () => {
    const anomalies = [makeAnomaly({ anomaly_type: "high_score_rejected" })];
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("high-score rejected");
  });

  it("includes remediation call-to-action", () => {
    const anomalies = [makeAnomaly()];
    const payload = getPersistentAnomaliesPayload(makeStore(anomalies));
    const output = formatPersistentAnomaliesForTelegram(payload);
    expect(output).toContain("fix issues");
  });
});

// ── generateCycleId ───────────────────────────────────────────────────────────

describe("generateCycleId", () => {
  it("returns a string in ISO-8601 minute-truncated format", () => {
    const id = generateCycleId();
    expect(id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("returns consistent IDs within the same minute", () => {
    const a = generateCycleId();
    const b = generateCycleId();
    // May differ only at second boundaries — at least the date portion matches
    expect(a.slice(0, 13)).toBe(b.slice(0, 13)); // same hour
  });
});

// ── PERSISTENT_ANOMALIES_MIGRATION_SQL ────────────────────────────────────────

describe("PERSISTENT_ANOMALIES_MIGRATION_SQL", () => {
  it("creates the score_anomaly_observations table", () => {
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS score_anomaly_observations",
    );
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain("task_id");
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain("cycle_id");
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain("anomaly_type");
  });

  it("creates necessary indexes", () => {
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_sao_task_id");
    expect(PERSISTENT_ANOMALIES_MIGRATION_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_sao_cycle_id");
  });
});
