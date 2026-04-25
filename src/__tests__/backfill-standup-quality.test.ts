/**
 * Tests for the standup_quality_history backfill feature.
 *
 * Covers:
 *  1. backfillStandupQualityHistory() — inserts history rows for verified standup tasks
 *  2. Idempotency — running twice produces no additional rows
 *  3. Does not touch non-standup task_types
 *  4. Does not touch tasks without quality_score
 *  5. Does not touch tasks that are not verified (pending/in_progress)
 *  6. recordStandupQualityScore() and getStandupQualityRecords() round-trip
 *  7. standup_quality_history table is created by migrate()
 *
 * Part of coordinated change 01KQ2ZHKAK9RR15HKV04CP4M48 (issue #498).
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-bsqh-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    task_type?: string;
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    created_at?: string;
  }) => {
    const id = `task-${String(++seq).padStart(4, "0")}`;
    const createdAt = overrides.created_at ?? "2026-01-15T10:00:00.000Z";
    const agentName = "agent_name" in overrides ? overrides.agent_name : "agent-a";
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
        "done",
        agentName,
        overrides.task_type ?? "standup",
        null,
        null,
        null,
        overrides.verification_status ?? null,
        overrides.quality_score ?? null,
        null,
        createdAt,
        createdAt,
      );
    return id;
  };

  const countHistory = () => {
    return (
      writer
        .prepare("SELECT COUNT(*) AS n FROM standup_quality_history")
        .get() as { n: number }
    ).n;
  };

  const getHistory = (taskId?: string) => {
    if (taskId) {
      return writer
        .prepare("SELECT * FROM standup_quality_history WHERE task_id = ?")
        .all(taskId) as Array<Record<string, unknown>>;
    }
    return writer
      .prepare("SELECT * FROM standup_quality_history ORDER BY recorded_at ASC")
      .all() as Array<Record<string, unknown>>;
  };

  return { store, writer, dir, insertTask, countHistory, getHistory };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("standup_quality_history table migration", () => {
  it("creates the standup_quality_history table on construction", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-bsqh-mig-"));
    const dbPath = join(dir, "state.db");
    const store = new StateStore(dbPath);
    const db = new Database(dbPath);

    const cols = db
      .prepare("PRAGMA table_info(standup_quality_history)")
      .all() as Array<{ name: string }>;

    expect(cols.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        "id",
        "agent_id",
        "date",
        "score",
        "action_item_count",
        "task_id",
        "recorded_at",
      ]),
    );

    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("backfillStandupQualityHistory", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("inserts a history row for each approved standup task with a quality score", () => {
    fixture.insertTask({
      task_type: "standup",
      agent_name: "agent-x",
      quality_score: 0.85,
      verification_status: "approved",
    });

    const result = fixture.store.backfillStandupQualityHistory();

    expect(result.rows_inserted).toBe(1);
    expect(fixture.countHistory()).toBe(1);
    const rows = fixture.getHistory();
    expect(rows[0]?.agent_id).toBe("agent-x");
    expect(rows[0]?.score).toBe(0.85);
    expect(rows[0]?.action_item_count).toBe(0);
  });

  it("inserts a history row for rejected standup tasks too", () => {
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.45,
      verification_status: "rejected",
    });

    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(1);
  });

  it("does not insert rows for standup tasks without quality_score", () => {
    fixture.insertTask({
      task_type: "standup",
      quality_score: null,
      verification_status: "approved",
    });

    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(0);
    expect(fixture.countHistory()).toBe(0);
  });

  it("does not insert rows for unverified standup tasks", () => {
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.80,
      verification_status: null,
    });
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.75,
      verification_status: "pending",
    });

    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(0);
  });

  it("does not insert rows for non-standup task types", () => {
    fixture.insertTask({
      task_type: "implementation",
      quality_score: 0.90,
      verification_status: "approved",
    });
    fixture.insertTask({
      task_type: "housekeeping",
      quality_score: 0.82,
      verification_status: "approved",
    });

    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(0);
  });

  it("is idempotent — second run inserts zero additional rows", () => {
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.88,
      verification_status: "approved",
    });
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.72,
      verification_status: "approved",
    });

    const first = fixture.store.backfillStandupQualityHistory();
    expect(first.rows_inserted).toBe(2);

    const second = fixture.store.backfillStandupQualityHistory();
    expect(second.rows_inserted).toBe(0);
    expect(fixture.countHistory()).toBe(2);
  });

  it("derives date from created_at", () => {
    fixture.insertTask({
      task_type: "standup",
      quality_score: 0.80,
      verification_status: "approved",
      created_at: "2026-03-10T14:30:00.000Z",
    });

    fixture.store.backfillStandupQualityHistory();
    const rows = fixture.getHistory();
    expect(rows[0]?.date).toBe("2026-03-10");
  });

  it("uses agent_name from task as agent_id", () => {
    fixture.insertTask({
      task_type: "standup",
      agent_name: "claude-orchestrator-dashboard",
      quality_score: 0.91,
      verification_status: "approved",
    });

    fixture.store.backfillStandupQualityHistory();
    const rows = fixture.getHistory();
    expect(rows[0]?.agent_id).toBe("claude-orchestrator-dashboard");
  });

  it("falls back to 'unknown' when agent_name is null", () => {
    fixture.insertTask({
      task_type: "standup",
      agent_name: null,
      quality_score: 0.75,
      verification_status: "approved",
    });

    fixture.store.backfillStandupQualityHistory();
    const rows = fixture.getHistory();
    expect(rows[0]?.agent_id).toBe("unknown");
  });

  it("clamps quality_score to [0, 1]", () => {
    // SQLite allows any REAL; ensure the backfill clamps edge cases
    fixture.insertTask({
      task_type: "standup",
      quality_score: 1.05,
      verification_status: "approved",
    });

    fixture.store.backfillStandupQualityHistory();
    const rows = fixture.getHistory();
    expect(rows[0]?.score).toBeLessThanOrEqual(1);
  });

  it("handles multiple agents in one pass", () => {
    const id1 = fixture.insertTask({
      task_type: "standup",
      agent_name: "agent-alpha",
      quality_score: 0.90,
      verification_status: "approved",
    });
    const id2 = fixture.insertTask({
      task_type: "standup",
      agent_name: "agent-beta",
      quality_score: 0.65,
      verification_status: "approved",
    });

    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(2);

    const alpha = fixture.getHistory(id1);
    const beta = fixture.getHistory(id2);
    expect(alpha[0]?.agent_id).toBe("agent-alpha");
    expect(beta[0]?.agent_id).toBe("agent-beta");
  });

  it("returns zero when no standup tasks exist", () => {
    const result = fixture.store.backfillStandupQualityHistory();
    expect(result.rows_inserted).toBe(0);
  });

  it("skips tasks already in standup_quality_history", () => {
    const id = fixture.insertTask({
      task_type: "standup",
      quality_score: 0.80,
      verification_status: "approved",
      created_at: "2026-03-01T09:00:00.000Z",
    });

    // Pre-populate with an existing history row for this task
    fixture.writer
      .prepare(
        `INSERT INTO standup_quality_history
           (agent_id, date, score, action_item_count, task_id, recorded_at)
         VALUES ('agent-a', '2026-03-01', 0.80, 3, ?, '2026-03-01T09:00:00.000Z')`,
      )
      .run(id);

    const result = fixture.store.backfillStandupQualityHistory();
    // Should skip because task_id already appears in standup_quality_history
    expect(result.rows_inserted).toBe(0);
    expect(fixture.countHistory()).toBe(1);
  });
});

describe("recordStandupQualityScore and getStandupQualityRecords", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    fixture.store.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("round-trips a quality score record", () => {
    fixture.store.recordStandupQualityScore({
      agent_id: "agent-x",
      date: "2026-04-01",
      score: 0.88,
      action_item_count: 3,
      task_id: "task-0001",
      recorded_at: "2026-04-01T08:00:00.000Z",
    });

    const records = fixture.store.getStandupQualityRecords("agent-x");
    expect(records).toHaveLength(1);
    expect(records[0]?.agent_id).toBe("agent-x");
    expect(records[0]?.score).toBe(0.88);
    expect(records[0]?.action_item_count).toBe(3);
    expect(records[0]?.task_id).toBe("task-0001");
  });

  it("filters by agent_id", () => {
    fixture.store.recordStandupQualityScore({
      agent_id: "agent-a",
      date: "2026-04-01",
      score: 0.90,
      action_item_count: 2,
      task_id: "task-0001",
      recorded_at: "2026-04-01T08:00:00.000Z",
    });
    fixture.store.recordStandupQualityScore({
      agent_id: "agent-b",
      date: "2026-04-01",
      score: 0.70,
      action_item_count: 1,
      task_id: "task-0002",
      recorded_at: "2026-04-01T09:00:00.000Z",
    });

    const aRecords = fixture.store.getStandupQualityRecords("agent-a");
    expect(aRecords).toHaveLength(1);
    expect(aRecords[0]?.agent_id).toBe("agent-a");

    const allRecords = fixture.store.getStandupQualityRecords(null);
    expect(allRecords).toHaveLength(2);
  });

  it("filters by since timestamp", () => {
    fixture.store.recordStandupQualityScore({
      agent_id: "agent-a",
      date: "2026-03-01",
      score: 0.80,
      action_item_count: 0,
      task_id: "task-0001",
      recorded_at: "2026-03-01T00:00:00.000Z",
    });
    fixture.store.recordStandupQualityScore({
      agent_id: "agent-a",
      date: "2026-04-01",
      score: 0.90,
      action_item_count: 1,
      task_id: "task-0002",
      recorded_at: "2026-04-01T00:00:00.000Z",
    });

    const recent = fixture.store.getStandupQualityRecords(null, "2026-04-01T00:00:00.000Z");
    expect(recent).toHaveLength(1);
    expect(recent[0]?.task_id).toBe("task-0002");
  });

  it("returns empty array when no records match", () => {
    const records = fixture.store.getStandupQualityRecords("nonexistent-agent");
    expect(records).toHaveLength(0);
  });
});
