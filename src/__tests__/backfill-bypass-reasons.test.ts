/**
 * Tests for the bypass_reason backfill feature (issue #295).
 *
 * Covers:
 *  1. backfillBypassReasons() — classifies operator_override vs floor_not_enforced
 *  2. Idempotency — running twice produces no additional changes
 *  3. Does not touch tasks above the 0.60 floor
 *  4. Does not touch tasks that are not approved
 *  5. Backfills verification_results table alongside tasks
 *  6. operatorOverride() sets bypass_reason on new overrides
 *  7. insertVerificationResult() persists bypass_reason column
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-bbr-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    verification_notes?: string | null;
    bypass_reason?: string | null;
    status?: string;
  }) => {
    const id = `task-${String(++seq).padStart(4, "0")}`;
    writer
      .prepare(
        `INSERT INTO tasks (
           id, title, description, status, agent_name, task_type, source, source_ref,
           result, verification_status, quality_score, verification_notes, bypass_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        id,
        `Task ${id}`,
        null,
        overrides.status ?? "done",
        overrides.agent_name ?? "agent-a",
        "implementation",
        null,
        null,
        null,
        overrides.verification_status ?? null,
        overrides.quality_score ?? null,
        overrides.verification_notes ?? null,
        overrides.bypass_reason ?? null,
      );
    return id;
  };

  const insertVerificationResult = (overrides: {
    task_id: string;
    score: number;
    first_pass?: number;
    bypass_reason?: string | null;
  }) => {
    writer
      .prepare(
        `INSERT INTO verification_results
           (task_id, score, first_pass, rejection_reason, blocked_reason, approval_rationale, threshold, agent_id, timestamp, bypass_reason)
         VALUES (?, ?, ?, NULL, NULL, NULL, 0.80, 'agent-a', datetime('now'), ?)`,
      )
      .run(
        overrides.task_id,
        overrides.score,
        overrides.first_pass ?? 1,
        overrides.bypass_reason ?? null,
      );
  };

  const getTask = (id: string) => {
    return writer
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
  };

  const getVerificationResults = (taskId: string) => {
    return writer
      .prepare("SELECT * FROM verification_results WHERE task_id = ?")
      .all(taskId) as Array<Record<string, unknown>>;
  };

  return { store, writer, dir, insertTask, insertVerificationResult, getTask, getVerificationResults };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("backfillBypassReasons", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("classifies operator-override tasks from verification_notes", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: APPROVED at 2024-01-01] Reviewed manually",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(1);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("operator_override");
  });

  it("classifies tasks with operator_override in notes", () => {
    const id = fixture.insertTask({
      quality_score: 0.55,
      verification_status: "approved",
      verification_notes: "bypass_reason: operator_override",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(1);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("operator_override");
  });

  it("classifies remaining sub-0.60 approved tasks as floor_not_enforced", () => {
    const id = fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: "Some normal notes, no override marker",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(1);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("floor_not_enforced");
  });

  it("classifies tasks with null verification_notes as floor_not_enforced", () => {
    const id = fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      verification_notes: null,
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(1);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("floor_not_enforced");
  });

  it("does not touch tasks with score >= 0.60", () => {
    const id = fixture.insertTask({
      quality_score: 0.75,
      verification_status: "approved",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(0);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBeNull();
  });

  it("does not touch non-approved tasks", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "rejected",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(0);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBeNull();
  });

  it("does not touch tasks that already have bypass_reason set", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      bypass_reason: "operator_override",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(0);
    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("operator_override");
  });

  it("is idempotent — second run produces zero changes", () => {
    fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: APPROVED] ok",
    });
    fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
    });

    const first = fixture.store.backfillBypassReasons();
    expect(first.tasks_updated).toBe(2);

    const second = fixture.store.backfillBypassReasons();
    expect(second.tasks_updated).toBe(0);
    expect(second.verification_results_updated).toBe(0);
  });

  it("handles mixed tasks correctly", () => {
    const id1 = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: APPROVED] manual review",
    });
    const id2 = fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: null,
    });
    const id3 = fixture.insertTask({
      quality_score: 0.75,
      verification_status: "approved",
    });
    const id4 = fixture.insertTask({
      quality_score: 0.30,
      verification_status: "rejected",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(2);
    expect(fixture.getTask(id1)?.bypass_reason).toBe("operator_override");
    expect(fixture.getTask(id2)?.bypass_reason).toBe("floor_not_enforced");
    expect(fixture.getTask(id3)?.bypass_reason).toBeNull();
    expect(fixture.getTask(id4)?.bypass_reason).toBeNull();
  });

  it("backfills verification_results with operator_override", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: APPROVED] ok",
    });
    fixture.insertVerificationResult({ task_id: id, score: 0.45, first_pass: 1 });

    const result = fixture.store.backfillBypassReasons();

    expect(result.verification_results_updated).toBe(1);
    const vrs = fixture.getVerificationResults(id);
    expect(vrs[0]?.bypass_reason).toBe("operator_override");
  });

  it("backfills verification_results with floor_not_enforced", () => {
    const id = fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: null,
    });
    fixture.insertVerificationResult({ task_id: id, score: 0.50, first_pass: 1 });

    const result = fixture.store.backfillBypassReasons();

    expect(result.verification_results_updated).toBe(1);
    const vrs = fixture.getVerificationResults(id);
    expect(vrs[0]?.bypass_reason).toBe("floor_not_enforced");
  });

  it("does not backfill verification_results that already have bypass_reason", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
    });
    fixture.insertVerificationResult({
      task_id: id,
      score: 0.45,
      first_pass: 1,
      bypass_reason: "operator_override",
    });

    const result = fixture.store.backfillBypassReasons();

    // Task should be updated but VR should not
    expect(result.tasks_updated).toBe(1);
    expect(result.verification_results_updated).toBe(0);
  });

  it("returns zero counts when no tasks need backfill", () => {
    // Only above-floor tasks
    fixture.insertTask({
      quality_score: 0.80,
      verification_status: "approved",
    });

    const result = fixture.store.backfillBypassReasons();

    expect(result.tasks_updated).toBe(0);
    expect(result.verification_results_updated).toBe(0);
  });
});

describe("operatorOverride sets bypass_reason", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("sets bypass_reason to operator_override on approve", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "needs_operator_review",
    });

    fixture.store.operatorOverride(id, "approve", "Reviewed manually");

    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBe("operator_override");
    expect(task?.verification_status).toBe("approved");
  });

  it("sets bypass_reason to null on reject", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "needs_operator_review",
    });

    fixture.store.operatorOverride(id, "reject", "Not good enough");

    const task = fixture.getTask(id);
    expect(task?.bypass_reason).toBeNull();
    expect(task?.verification_status).toBe("rejected");
  });
});

describe("insertVerificationResult persists bypass_reason", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("stores bypass_reason when provided", () => {
    const id = fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
    });

    fixture.store.insertVerificationResult({
      task_id: id,
      score: 0.45,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: null,
      threshold: 0.80,
      agent_id: "agent-a",
      timestamp: new Date().toISOString(),
      bypass_reason: "operator_override",
    });

    const vrs = fixture.getVerificationResults(id);
    expect(vrs[0]?.bypass_reason).toBe("operator_override");
  });

  it("stores null bypass_reason when not provided", () => {
    const id = fixture.insertTask({
      quality_score: 0.80,
      verification_status: "approved",
    });

    fixture.store.insertVerificationResult({
      task_id: id,
      score: 0.80,
      first_pass: 1,
      rejection_reason: null,
      blocked_reason: null,
      approval_rationale: null,
      threshold: 0.80,
      agent_id: "agent-a",
      timestamp: new Date().toISOString(),
    });

    const vrs = fixture.getVerificationResults(id);
    expect(vrs[0]?.bypass_reason).toBeNull();
  });
});

describe("bypass_reason column migration", () => {
  it("adds bypass_reason column to both tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-bbr-mig-"));
    const dbPath = join(dir, "state.db");
    const store = new StateStore(dbPath);
    const db = new Database(dbPath);

    const taskCols = db
      .prepare("PRAGMA table_info(tasks)")
      .all() as Array<{ name: string }>;
    expect(taskCols.some((c) => c.name === "bypass_reason")).toBe(true);

    const vrCols = db
      .prepare("PRAGMA table_info(verification_results)")
      .all() as Array<{ name: string }>;
    expect(vrCols.some((c) => c.name === "bypass_reason")).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
