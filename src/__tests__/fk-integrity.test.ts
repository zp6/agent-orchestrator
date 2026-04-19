/**
 * FK integrity tests (issue #366).
 *
 * Verifies that:
 *  1. PRAGMA foreign_keys=ON is set at StateStore construction time.
 *  2. Inserting a child row (verification_results, pr_outcome_records,
 *     semantic_task_memory) before the parent tasks row throws immediately.
 *  3. runStartupIntegrityCheck() passes on a clean database.
 *  4. runStartupIntegrityCheck() detects orphaned rows that were inserted
 *     while FK enforcement was temporarily disabled.
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

function makeTmpStore(): { store: StateStore; db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-fk-test-"));
  const dbPath = join(dir, "test.db");
  const store = new StateStore(dbPath);
  // Access the underlying db connection for low-level pragma / direct inserts.
  const db = (store as unknown as { db: Database.Database }).db;
  return {
    store,
    db,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("FK integrity", () => {
  let fixture: ReturnType<typeof makeTmpStore>;

  beforeEach(() => {
    fixture = makeTmpStore();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  // ── Pragma enforcement ───────────────────────────────────────────────────

  it("has PRAGMA foreign_keys=ON set at construction time", () => {
    const result = fixture.db.pragma("foreign_keys", { simple: true });
    expect(result).toBe(1);
  });

  // ── Child-before-parent INSERT throws ───────────────────────────────────

  it("throws on FK violation when inserting verification_results before parent task", () => {
    expect(() => {
      fixture.db
        .prepare(
          `INSERT INTO verification_results
             (task_id, score, first_pass, threshold, agent_id, timestamp)
           VALUES ('nonexistent-task-id', 0.85, 1, 0.70, 'test-agent', datetime('now'))`,
        )
        .run();
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("throws on FK violation when inserting pr_outcome_records before parent task", () => {
    expect(() => {
      fixture.db
        .prepare(
          `INSERT INTO pr_outcome_records
             (id, task_id, agent_name, quality_score, score_bucket, repo, pr_number, outcome)
           VALUES ('rec-orphan', 'ghost-task', 'agent-x', 0.9, 0.9, 'owner/repo', 1, 'merged')`,
        )
        .run();
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("throws on FK violation when inserting semantic_task_memory before parent task", () => {
    expect(() => {
      fixture.db
        .prepare(
          `INSERT INTO semantic_task_memory (topic, task_id, confidence, outcome)
           VALUES ('typescript', 'ghost-task-id', 0.8, 'success')`,
        )
        .run();
    }).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("succeeds when the parent task row exists first", () => {
    // Insert parent task first (correct order).
    fixture.db
      .prepare(
        `INSERT INTO tasks (id, title, status, task_type, created_at, updated_at)
         VALUES ('task-parent', 'Test task', 'done', 'implementation', datetime('now'), datetime('now'))`,
      )
      .run();

    // Child insert should succeed without throwing.
    expect(() => {
      fixture.db
        .prepare(
          `INSERT INTO verification_results
             (task_id, score, first_pass, threshold, agent_id, timestamp)
           VALUES ('task-parent', 0.85, 1, 0.70, 'test-agent', datetime('now'))`,
        )
        .run();
    }).not.toThrow();
  });

  // ── runStartupIntegrityCheck ─────────────────────────────────────────────

  it("runStartupIntegrityCheck passes on a clean database", () => {
    const alerts: string[] = [];
    fixture.store.runStartupIntegrityCheck({ send: (msg) => alerts.push(msg) });
    expect(alerts).toHaveLength(0);
  });

  it("runStartupIntegrityCheck detects orphaned rows inserted while FK enforcement was disabled", () => {
    // Temporarily disable FK enforcement to simulate the pre-#366 state where
    // orphaned rows could be created without an error.
    fixture.db.pragma("foreign_keys = OFF");

    fixture.db
      .prepare(
        `INSERT INTO verification_results
           (task_id, score, first_pass, threshold, agent_id, timestamp)
         VALUES ('ghost-task', 0.5, 0, 0.70, 'test-agent', datetime('now'))`,
      )
      .run();

    // Re-enable FK enforcement (mirrors what PRAGMA foreign_keys=ON at startup does).
    fixture.db.pragma("foreign_keys = ON");

    const alerts: string[] = [];
    fixture.store.runStartupIntegrityCheck({ send: (msg) => alerts.push(msg) });

    // At least one alert must mention foreign_key_check.
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some((m) => /foreign_key_check/i.test(m))).toBe(true);
  });

  it("runStartupIntegrityCheck logs OK to console and sends no alerts on clean db", () => {
    const alerts: string[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: string) => logs.push(msg);
    try {
      fixture.store.runStartupIntegrityCheck({ send: (msg) => alerts.push(msg) });
    } finally {
      console.log = origLog;
    }
    expect(alerts).toHaveLength(0);
    expect(logs.some((l) => /startup integrity check.*OK/i.test(l))).toBe(true);
  });
});
