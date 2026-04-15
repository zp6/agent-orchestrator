import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

type RawDb = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

function seedTask(
  store: StateStore,
  id: string,
  agentName: string,
  qualityScore: number | null,
  daysAgo: number,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
    VALUES (?, ?, 'done', ?, 'implementation', ?, ?, datetime('now', ?), datetime('now', ?))
  `);
  insert.run(
    id,
    `task ${id}`,
    agentName,
    qualityScore,
    qualityScore === null ? null : "approved",
    `-${daysAgo} days`,
    `-${daysAgo} days`,
  );
}

describe("StateStore.getQualityHealthReport", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("returns per-agent stats for the most recent tasks only", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-quality-health-"));
    const dbPath = join(dir, "state.db");
    const store = new StateStore(dbPath);
    const writer = new Database(dbPath);
    cleanup = () => {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    };

    for (let i = 0; i < 5; i++) {
      seedTask(store, `A-old-${i}`, "agent-a", null, 20 + i);
    }

    const recentScores = [
      0.61,
      null,
      0.63,
      null,
      0.65,
      0.66,
      0.67,
      null,
      0.68,
      0.69,
      0.92,
      0.93,
      null,
      0.95,
      0.96,
      0.97,
      0.98,
      0.99,
      0.90,
      0.91,
    ];

    recentScores.forEach((score, index) => {
      seedTask(store, `A-${index}`, "agent-a", score, index);
    });

    for (let i = 0; i < 12; i++) {
      seedTask(store, `B-${i}`, "agent-b", 0.80 + i * 0.005, i);
    }

    const report = store.getQualityHealthReport(20, 0.75);

    expect(report.window_tasks).toBe(20);
    expect(report.threshold).toBe(0.75);
    expect(report.total_task_count).toBe(32);
    expect(report.per_agent).toHaveLength(2);

    const agentA = report.per_agent.find((row) => row.agent_name === "agent-a")!;
    expect(agentA.task_count).toBe(20);
    expect(agentA.null_score_count).toBe(4);
    expect(agentA.null_score_rate).toBeCloseTo(0.2, 5);
    expect(agentA.below_threshold_count).toBe(7);
    expect(agentA.below_threshold_rate).toBeCloseTo(7 / 16, 5);
    expect(agentA.trending_downward).toBe(true);
    expect(agentA.trend_delta).toBeLessThan(0);

    const agentB = report.per_agent.find((row) => row.agent_name === "agent-b")!;
    expect(agentB.task_count).toBe(12);
    expect(agentB.null_score_count).toBe(0);
    expect(agentB.trending_downward).toBe(false);
    expect(agentB.rolling_avg_score).toBeGreaterThan(agentA.rolling_avg_score ?? 0);

    const expectedSystemAvg =
      [
        0.61,
        0.63,
        0.65,
        0.66,
        0.67,
        0.68,
        0.69,
        0.92,
        0.93,
        0.95,
        0.96,
        0.97,
        0.98,
        0.99,
        0.9,
        0.91,
        ...Array.from({ length: 12 }, (_, i) => 0.80 + i * 0.005),
      ].reduce((sum, value) => sum + value, 0) / 28;

    expect(report.scored_task_count).toBe(28);
    expect(report.null_score_count).toBe(4);
    expect(report.below_threshold_count).toBe(7);
    expect(report.system_avg_score).toBeCloseTo(expectedSystemAvg, 5);
  });

  it("returns an empty report when there are no agent-scoped tasks", () => {
    const store = new StateStore(":memory:");
    const report = store.getQualityHealthReport();

    expect(report.per_agent).toEqual([]);
    expect(report.system_avg_score).toBeNull();
    expect(report.total_task_count).toBe(0);
    expect(report.scored_task_count).toBe(0);
  });
});
