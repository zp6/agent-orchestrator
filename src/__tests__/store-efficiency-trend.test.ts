import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-efficiency-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  const insertTask = (overrides: {
    id: string;
    title: string;
    status: "done" | "failed";
    agent_name?: string | null;
    created_at?: string;
    updated_at?: string;
  }) => {
    writer
      .prepare(
        `INSERT INTO tasks (
           id, title, description, status, agent_name, task_type, source, source_ref,
           result, verification_status, quality_score, verification_notes, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        overrides.id,
        overrides.title,
        null,
        overrides.status,
        overrides.agent_name ?? null,
        "implementation",
        null,
        null,
        null,
        null,
        null,
        null,
        overrides.created_at ?? new Date().toISOString(),
        overrides.updated_at ?? new Date().toISOString(),
      );
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

describe("StateStore.getEfficiencyTrend", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("returns zero-filled system days and no agent series for an empty database", () => {
    const fixture = makeStoreFixture();
    cleanup = fixture.cleanup;

    const result = fixture.store.getEfficiencyTrend();

    expect(result.days).toBe(7);
    expect(result.warning_threshold).toBe(0.75);
    expect(result.critical_threshold).toBe(0.5);
    expect(result.system).toHaveLength(7);
    expect(result.per_agent).toEqual([]);
    for (const point of result.system) {
      expect(point.done).toBe(0);
      expect(point.failed).toBe(0);
      expect(point.total).toBe(0);
      expect(point.efficiency_rate).toBeNull();
    }
  });

  it("computes system and per-agent efficiency across a rolling window", () => {
    const fixture = makeStoreFixture();
    cleanup = fixture.cleanup;

    fixture.insertTask({
      id: "today-alpha-done",
      title: "Alpha done today",
      status: "done",
      agent_name: "alpha",
      updated_at: isoDaysAgo(0),
      created_at: isoDaysAgo(0),
    });
    fixture.insertTask({
      id: "today-alpha-failed",
      title: "Alpha failed today",
      status: "failed",
      agent_name: "alpha",
      updated_at: isoDaysAgo(0),
      created_at: isoDaysAgo(0),
    });
    fixture.insertTask({
      id: "today-beta-done",
      title: "Beta done today",
      status: "done",
      agent_name: "beta",
      updated_at: isoDaysAgo(0),
      created_at: isoDaysAgo(0),
    });
    fixture.insertTask({
      id: "two-days-ago-beta-failed",
      title: "Beta failed two days ago",
      status: "failed",
      agent_name: "beta",
      updated_at: isoDaysAgo(2),
      created_at: isoDaysAgo(2),
    });

    const result = fixture.store.getEfficiencyTrend(3, 0.8, 0.6);

    expect(result.days).toBe(3);
    expect(result.warning_threshold).toBe(0.8);
    expect(result.critical_threshold).toBe(0.6);
    expect(result.system).toHaveLength(3);
    expect(result.per_agent).toHaveLength(2);
    expect(result.per_agent.map((series) => series.agent_name)).toEqual(["alpha", "beta"]);

    const [twoDaysAgo, yesterday, today] = result.system;
    expect(twoDaysAgo.done).toBe(0);
    expect(twoDaysAgo.failed).toBe(1);
    expect(twoDaysAgo.total).toBe(1);
    expect(twoDaysAgo.efficiency_rate).toBe(0);
    expect(yesterday.total).toBe(0);
    expect(yesterday.efficiency_rate).toBeNull();
    expect(today.done).toBe(2);
    expect(today.failed).toBe(1);
    expect(today.total).toBe(3);
    expect(today.efficiency_rate).toBeCloseTo(2 / 3);

    const alpha = result.per_agent[0];
    expect(alpha.days).toHaveLength(3);
    expect(alpha.days[0].total).toBe(0);
    expect(alpha.days[1].total).toBe(0);
    expect(alpha.days[2].done).toBe(1);
    expect(alpha.days[2].failed).toBe(1);
    expect(alpha.days[2].efficiency_rate).toBe(0.5);

    const beta = result.per_agent[1];
    expect(beta.days).toHaveLength(3);
    expect(beta.days[0].failed).toBe(1);
    expect(beta.days[0].efficiency_rate).toBe(0);
    expect(beta.days[1].total).toBe(0);
    expect(beta.days[2].done).toBe(1);
    expect(beta.days[2].efficiency_rate).toBe(1);
  });
});
