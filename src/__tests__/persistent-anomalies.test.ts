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
  PersistentAnomaliesDigestScheduler,
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

// ── PersistentAnomaliesDigestScheduler ────────────────────────────────────────

describe("PersistentAnomaliesDigestScheduler", () => {
  const DAY1 = new Date("2026-04-25T08:00:00.000Z").getTime();
  const DAY2 = new Date("2026-04-26T08:00:00.000Z").getTime();

  function makeNotifier() {
    return { send: vi.fn().mockResolvedValue(undefined) };
  }

  it("sends the digest on first call", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    const sent = await scheduler.checkAndSend(DAY1);
    expect(sent).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("deduplicates within the same calendar day", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    await scheduler.checkAndSend(DAY1);
    const second = await scheduler.checkAndSend(DAY1 + 60_000); // 1 minute later, same day
    expect(second).toBe(false);
    expect(notifier.send).toHaveBeenCalledTimes(1);
  });

  it("sends again on the next calendar day", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    await scheduler.checkAndSend(DAY1);
    const second = await scheduler.checkAndSend(DAY2);
    expect(second).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it("returns false and skips send when there are no anomalies", async () => {
    const store = makeStore([]);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    const sent = await scheduler.checkAndSend(DAY1);
    expect(sent).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("returns false when no notifier is configured", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const scheduler = new PersistentAnomaliesDigestScheduler(store, undefined);

    const sent = await scheduler.checkAndSend(DAY1);
    expect(sent).toBe(false);
  });

  it("advances dedup key even without notifier so next-day check is correct", async () => {
    const store = makeStore([makeAnomaly()]);
    const scheduler = new PersistentAnomaliesDigestScheduler(store, undefined);

    // Day 1 — no notifier
    await scheduler.checkAndSend(DAY1);
    // Day 2 same-instance — if we now add a notifier externally this verifies
    // the date key advanced to day 1; this test just confirms no infinite retry
    const notifier = makeNotifier();
    (scheduler as unknown as { notifier: unknown }).notifier = notifier;
    // Still should send on day 2
    const sent = await scheduler.checkAndSend(DAY2);
    expect(sent).toBe(true);
  });

  it("appends dashboard URL link when configured and anomalies exist", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier, {
      dashboardUrl: "https://dash.example.com",
    });

    await scheduler.checkAndSend(DAY1);
    const sentText: string = notifier.send.mock.calls[0][0] as string;
    expect(sentText).toContain("https://dash.example.com/persistent-anomalies");
  });

  it("does not append dashboard link when there are no anomalies", async () => {
    // No-anomaly path bails before send, but verify no side-effect
    const store = makeStore([]);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier, {
      dashboardUrl: "https://dash.example.com",
    });

    await scheduler.checkAndSend(DAY1);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("handles notifier errors non-fatally and returns false", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = { send: vi.fn().mockRejectedValue(new Error("network error")) };
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    await expect(scheduler.checkAndSend(DAY1)).resolves.toBe(false);
  });

  it("does not advance dedup key on notifier error (retry next invocation)", async () => {
    const anomalies = [makeAnomaly()];
    const store = makeStore(anomalies);
    const notifier = { send: vi.fn().mockRejectedValueOnce(new Error("fail")) };
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier);

    await scheduler.checkAndSend(DAY1); // fails
    // lastSentDateKey should NOT have been set — next call same day retries
    notifier.send.mockResolvedValueOnce(undefined);
    const retried = await scheduler.checkAndSend(DAY1 + 30_000);
    expect(retried).toBe(true);
    expect(notifier.send).toHaveBeenCalledTimes(2);
  });

  it("passes custom opts to getPersistentAnomaliesPayload", async () => {
    const store = makeStore([makeAnomaly()]);
    const notifier = makeNotifier();
    const scheduler = new PersistentAnomaliesDigestScheduler(store, notifier, {
      minCycles: 5,
      days: 14,
      limit: 10,
    });

    await scheduler.checkAndSend(DAY1);
    expect(store.getPersistentAnomalies).toHaveBeenCalledWith(5, 14, 10);
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
