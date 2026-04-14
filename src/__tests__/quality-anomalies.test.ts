import { describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import { getQualityAnomaliesApiPayload } from "../reviewer/quality-anomalies.js";

type RawDb = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

function seedTask(
  store: StateStore,
  id: string,
  agentName: string,
  score: number,
  status: "approved" | "rejected" | null,
  daysAgo: number,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (
      id, title, description, status, agent_name, task_type, source, source_ref,
      result, verification_status, quality_score, verification_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'done', ?, 'implementation', ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))
  `);

  insert.run(
    id,
    `task ${id}`,
    null,
    agentName,
    null,
    null,
    null,
    status,
    score,
    null,
    `-${daysAgo} days`,
    `-${daysAgo} days`,
  );
}

describe("StateStore.getQualityAnomalies", () => {
  it("returns only score/decision contradictions", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "low-approved", "agent-a", 0.59, "approved", 1);
    seedTask(store, "high-rejected", "agent-b", 0.86, "rejected", 1);
    seedTask(store, "boundary-low", "agent-c", 0.60, "approved", 1);
    seedTask(store, "boundary-high", "agent-d", 0.85, "rejected", 1);
    seedTask(store, "clean-approved", "agent-e", 0.91, "approved", 1);
    seedTask(store, "clean-rejected", "agent-f", 0.42, "rejected", 1);

    const anomalies = store.getQualityAnomalies({ days: 7 });

    expect(anomalies.map((row) => row.task_id)).toEqual(["low-approved", "high-rejected"]);
    expect(anomalies[0].anomaly_type).toBe("low_score_approved");
    expect(anomalies[1].anomaly_type).toBe("high_score_rejected");
  });

  it("filters by date range", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "old", "agent-a", 0.58, "approved", 10);
    seedTask(store, "in-range", "agent-b", 0.87, "rejected", 3);
    seedTask(store, "new", "agent-c", 0.57, "approved", 0);

    const since = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();

    const anomalies = store.getQualityAnomalies({ since, until });
    expect(anomalies.map((row) => row.task_id)).toEqual(["in-range"]);
  });

  it("respects the result limit", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "a", "agent-a", 0.59, "approved", 1);
    seedTask(store, "b", "agent-b", 0.86, "rejected", 1);
    seedTask(store, "c", "agent-c", 0.58, "approved", 1);

    const anomalies = store.getQualityAnomalies({ days: 7, limit: 2 });
    expect(anomalies).toHaveLength(2);
  });
});

describe("getQualityAnomaliesApiPayload", () => {
  it("includes summary counts and query metadata", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "low-approved", "agent-a", 0.59, "approved", 1);
    seedTask(store, "high-rejected", "agent-b", 0.86, "rejected", 1);

    const payload = getQualityAnomaliesApiPayload(store, {
      days: 14,
      limit: 25,
    });

    expect(payload.generated_at).toBeTruthy();
    expect(payload.query.days).toBe(14);
    expect(payload.query.limit).toBe(25);
    expect(payload.total).toBe(2);
    expect(payload.low_score_approved).toBe(1);
    expect(payload.high_score_rejected).toBe(1);
    expect(payload.anomalies.map((row) => row.task_id)).toEqual(["low-approved", "high-rejected"]);
  });
});
