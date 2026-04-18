/**
 * Tests for the hard score floor enforced at the persisting layer (issue #266).
 *
 * Verifies that StateStore.updateTask() never allows a task to reach
 * verification_status = 'approved' with quality_score < 0.60, regardless of
 * which code path calls updateTask().
 *
 * Key invariants:
 *   - score >= 0.60 + approved → stays approved
 *   - score < 0.60 + approved  → downgraded to needs_revision
 *   - score exactly 0.60       → stays approved (inclusive floor)
 *   - null score + approved (task has null score) → downgraded to needs_revision
 *   - null score + approved (task already has score >= 0.60) → stays approved
 *   - score < 0.60 + needs_revision → not affected (only 'approved' is guarded)
 *   - score < 0.60 + rejected  → not affected (only 'approved' is guarded)
 *   - downgraded tasks get a [floor-downgrade:...] prefix in verification_notes
 *   - APPROVAL_SCORE_FLOOR === 0.60 (exported constant)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore, APPROVAL_SCORE_FLOOR } from "../state/store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type RawDB = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
      get: (...args: unknown[]) => unknown;
    };
  };
};

/**
 * Insert a minimal done task with the given verification_status and
 * quality_score directly into the DB, bypassing updateTask() guards.
 * Used to set up preconditions that simulate pre-existing DB state.
 */
function seedTask(
  store: StateStore,
  id: string,
  opts: {
    quality_score?: number | null;
    verification_status?: string | null;
    verification_notes?: string | null;
  } = {},
): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT INTO tasks
         (id, title, status, agent_name, task_type,
          quality_score, verification_status, verification_notes,
          created_at, updated_at)
       VALUES (?, ?, 'done', 'test-agent', 'implementation', ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(
      id,
      `Task ${id}`,
      opts.quality_score ?? null,
      opts.verification_status ?? null,
      opts.verification_notes ?? null,
    );
}

// ── Constants ─────────────────────────────────────────────────────────────────

describe("APPROVAL_SCORE_FLOOR constant", () => {
  it("equals 0.60", () => {
    expect(APPROVAL_SCORE_FLOOR).toBe(0.60);
  });

  it("matches StateStore.NULL_SCORE_APPROVED_SENTINEL > APPROVAL_SCORE_FLOOR", () => {
    // The sentinel for null-score approved tasks (0.75) must be above the
    // floor so it is not itself flagged.
    expect(StateStore.NULL_SCORE_APPROVED_SENTINEL).toBeGreaterThan(APPROVAL_SCORE_FLOOR);
  });
});

// ── Score floor enforcement ────────────────────────────────────────────────────

describe("Score floor enforcement in updateTask() (issue #266)", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  // ── Above-floor approvals ────────────────────────────────────────────────

  it("score 0.65 with approved → stays approved", () => {
    seedTask(store, "T01");
    store.updateTask("T01", { verification_status: "approved", quality_score: 0.65 });
    const task = store.getTask("T01");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(0.65);
  });

  it("score 1.0 with approved → unaffected", () => {
    seedTask(store, "T02");
    store.updateTask("T02", { verification_status: "approved", quality_score: 1.0 });
    const task = store.getTask("T02");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(1.0);
  });

  it("score exactly 0.60 with approved → stays approved (inclusive floor)", () => {
    seedTask(store, "T03");
    store.updateTask("T03", { verification_status: "approved", quality_score: 0.60 });
    const task = store.getTask("T03");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(0.60);
  });

  // ── Below-floor approvals: downgrade ────────────────────────────────────

  it("score 0.59 with approved → downgraded to needs_revision", () => {
    seedTask(store, "T04");
    store.updateTask("T04", { verification_status: "approved", quality_score: 0.59 });
    const task = store.getTask("T04");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("score 0.00 with approved → downgraded to needs_revision", () => {
    seedTask(store, "T05");
    store.updateTask("T05", { verification_status: "approved", quality_score: 0.00 });
    const task = store.getTask("T05");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("score 0.38 with approved → downgraded to needs_revision", () => {
    seedTask(store, "T06");
    store.updateTask("T06", { verification_status: "approved", quality_score: 0.38 });
    const task = store.getTask("T06");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("score 0.05 with approved → downgraded to needs_revision", () => {
    seedTask(store, "T07");
    store.updateTask("T07", { verification_status: "approved", quality_score: 0.05 });
    const task = store.getTask("T07");
    expect(task?.verification_status).toBe("needs_revision");
  });

  // ── Non-approved statuses: not affected ─────────────────────────────────

  it("score 0.50 with needs_revision → not affected (only 'approved' is guarded)", () => {
    seedTask(store, "T08");
    store.updateTask("T08", { verification_status: "needs_revision", quality_score: 0.50 });
    const task = store.getTask("T08");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("score 0.30 with rejected → not affected", () => {
    seedTask(store, "T09");
    store.updateTask("T09", { verification_status: "rejected", quality_score: 0.30 });
    const task = store.getTask("T09");
    expect(task?.verification_status).toBe("rejected");
  });

  // ── Null score + approved ────────────────────────────────────────────────

  it("null score + approved (task has null score) → downgraded to needs_revision", () => {
    // Task starts with null quality_score — cannot verify floor is met
    seedTask(store, "T10", { quality_score: null });
    store.updateTask("T10", { verification_status: "approved" });
    const task = store.getTask("T10");
    expect(task?.verification_status).toBe("needs_revision");
  });

  it("null score + approved (task already has score 0.80) → stays approved", () => {
    // Task already has a good score from a previous update — approve is valid
    seedTask(store, "T11", { quality_score: 0.80, verification_status: null });
    store.updateTask("T11", { verification_status: "approved" });
    const task = store.getTask("T11");
    expect(task?.verification_status).toBe("approved");
  });

  // ── floor-downgrade note in verification_notes ───────────────────────────

  it("score_explanation gets [floor-downgrade: score X.XX < 0.60] prefix when downgraded", () => {
    seedTask(store, "T12", { verification_notes: "Existing notes." });
    store.updateTask("T12", {
      verification_status: "approved",
      quality_score: 0.45,
      verification_notes: "Verifier pass notes.",
    });
    const task = store.getTask("T12");
    expect(task?.verification_status).toBe("needs_revision");
    expect(task?.verification_notes).toMatch(/^\[floor-downgrade: score 0\.45 < 0\.60\]/);
    expect(task?.verification_notes).toContain("Verifier pass notes.");
  });

  it("floor-downgrade note is written even when no verification_notes supplied", () => {
    seedTask(store, "T13");
    store.updateTask("T13", { verification_status: "approved", quality_score: 0.12 });
    const task = store.getTask("T13");
    expect(task?.verification_status).toBe("needs_revision");
    expect(task?.verification_notes).toMatch(/^\[floor-downgrade: score 0\.12 < 0\.60\]/);
  });

  it("null-score downgrade gets floor-downgrade note about null score", () => {
    seedTask(store, "T14", { quality_score: null });
    store.updateTask("T14", { verification_status: "approved" });
    const task = store.getTask("T14");
    expect(task?.verification_status).toBe("needs_revision");
    expect(task?.verification_notes).toMatch(/\[floor-downgrade: null score cannot verify floor/);
  });

  // ── Score-only update path ────────────────────────────────────────────────
  // When only quality_score is updated (no verification_status in the call),
  // and the existing DB record is 'approved', the guard must also fire.

  it("score-only update below floor on an approved task → downgraded to needs_revision", () => {
    // Task is already approved with a good score
    seedTask(store, "T15", { quality_score: 0.80, verification_status: "approved" });
    // Score-only update drops below floor
    store.updateTask("T15", { quality_score: 0.55 });
    const task = store.getTask("T15");
    expect(task?.verification_status).toBe("needs_revision");
    expect(task?.quality_score).toBe(0.55);
    expect(task?.verification_notes).toMatch(/\[floor-downgrade: score 0\.55 < 0\.60\]/);
  });

  it("score-only update above floor on an approved task → stays approved", () => {
    seedTask(store, "T16", { quality_score: 0.80, verification_status: "approved" });
    store.updateTask("T16", { quality_score: 0.90 });
    const task = store.getTask("T16");
    expect(task?.verification_status).toBe("approved");
    expect(task?.quality_score).toBe(0.90);
  });
});
