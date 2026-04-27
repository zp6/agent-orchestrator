/**
 * Tests for score-integrity audit module — issue #263
 *
 * Covers:
 *  - getScoreIntegrityReport(): bucket assignment, violation detection,
 *    null-score exclusion, days filter, pct calculation, enforcement_active flag
 *  - isEnforcementActive(): always returns true
 *  - SCORE_BUCKETS: constant structure
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import {
  getScoreIntegrityReport,
  isEnforcementActive,
  SCORE_BUCKETS,
  DEFAULT_MIN_SCORE,
} from "../reviewer/score-integrity.js";

// ── DB helper type ────────────────────────────────────────────────────────────

type RawDb = {
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
};

function seedTask(
  store: StateStore,
  id: string,
  agentName: string,
  qualityScore: number | null,
  verificationStatus: "approved" | "rejected" | null,
  daysAgo: number = 1,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (
      id, title, status, agent_name, task_type,
      quality_score, verification_status, verification_notes,
      created_at, updated_at
    ) VALUES (?, ?, 'done', ?, 'implementation', ?, ?, ?, datetime('now', ?), datetime('now', ?))
  `);

  insert.run(
    id,
    `task ${id}`,
    agentName,
    qualityScore,
    verificationStatus,
    `Notes for ${id}`,
    `-${daysAgo} days`,
    `-${daysAgo} days`,
  );
}

// Expose the raw db for getScoreIntegrityReport
function getRawDb(store: StateStore): import("better-sqlite3").Database {
  return (store as unknown as RawDb).db as unknown as import("better-sqlite3").Database;
}

// ── SCORE_BUCKETS constant ────────────────────────────────────────────────────

describe("SCORE_BUCKETS", () => {
  it("has 4 buckets in ascending order", () => {
    expect(SCORE_BUCKETS).toHaveLength(4);
    expect(SCORE_BUCKETS[0].label).toBe("0.00–0.59");
    expect(SCORE_BUCKETS[1].label).toBe("0.60–0.74");
    expect(SCORE_BUCKETS[2].label).toBe("0.75–0.79");
    expect(SCORE_BUCKETS[3].label).toBe("0.80+");
  });

  it("covers the full [0, 1] range", () => {
    expect(SCORE_BUCKETS[0].min).toBe(0);
    expect(SCORE_BUCKETS[3].max).toBe(1.0);
  });
});

// ── isEnforcementActive ───────────────────────────────────────────────────────

describe("isEnforcementActive", () => {
  it("returns true (gate is always active)", () => {
    expect(isEnforcementActive()).toBe(true);
  });
});

// ── DEFAULT_MIN_SCORE ─────────────────────────────────────────────────────────

describe("DEFAULT_MIN_SCORE", () => {
  it("is 0.60 (mirrors StateStore.SUB_THRESHOLD_REJECTION_LIMIT)", () => {
    expect(DEFAULT_MIN_SCORE).toBe(0.60);
  });
});

// ── getScoreIntegrityReport ───────────────────────────────────────────────────

describe("getScoreIntegrityReport — empty DB", () => {
  it("returns zeroed report when no approved tasks exist", () => {
    const store = new StateStore(":memory:");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(0);
    expect(report.total_violations).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.buckets.every((b) => b.count === 0)).toBe(true);
    expect(report.buckets.every((b) => b.pct === 0)).toBe(true);
    expect(report.enforcement_active).toBe(true);
    expect(report.min_score_threshold).toBe(DEFAULT_MIN_SCORE);
  });
});

describe("getScoreIntegrityReport — bucket assignment", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("places score 0.85 in the 0.80+ bucket", () => {
    seedTask(store, "t1", "agent-a", 0.85, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(1);
    const highBucket = report.buckets.find((b) => b.label === "0.80+")!;
    expect(highBucket.count).toBe(1);
    expect(highBucket.pct).toBe(100);
    // Other buckets should be zero
    expect(report.buckets.filter((b) => b.label !== "0.80+").every((b) => b.count === 0)).toBe(true);
  });

  it("places score 0.55 in the 0.00–0.59 bucket", () => {
    seedTask(store, "t2", "agent-b", 0.55, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    const lowBucket = report.buckets.find((b) => b.label === "0.00–0.59")!;
    expect(lowBucket.count).toBe(1);
  });

  it("places score 0.62 in the 0.60–0.74 bucket", () => {
    seedTask(store, "t3", "agent-c", 0.62, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    const midBucket = report.buckets.find((b) => b.label === "0.60–0.74")!;
    expect(midBucket.count).toBe(1);
  });

  it("places score 0.77 in the 0.75–0.79 bucket", () => {
    seedTask(store, "t4", "agent-d", 0.77, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    const midHighBucket = report.buckets.find((b) => b.label === "0.75–0.79")!;
    expect(midHighBucket.count).toBe(1);
  });
});

describe("getScoreIntegrityReport — violations", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("lists approved task with score 0.55 as a violation (below default 0.60 threshold)", () => {
    seedTask(store, "v1", "agent-a", 0.55, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_violations).toBe(1);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].task_id).toBe("v1");
    expect(report.violations[0].agent).toBe("agent-a");
    expect(report.violations[0].quality_score).toBe(0.55);
    expect(report.violations[0].score_explanation).toBe("Notes for v1");
  });

  it("does NOT count score 0.62 as a violation when threshold is 0.60", () => {
    seedTask(store, "ok1", "agent-b", 0.62, "approved");
    const report = getScoreIntegrityReport(getRawDb(store), { minScore: 0.60 });

    expect(report.total_violations).toBe(0);
    expect(report.violations).toHaveLength(0);
  });

  it("counts multiple violations correctly", () => {
    seedTask(store, "low1", "agent-a", 0.40, "approved");
    seedTask(store, "low2", "agent-b", 0.55, "approved");
    seedTask(store, "ok1",  "agent-c", 0.85, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_violations).toBe(2);
    expect(report.violations.map((v) => v.task_id).sort()).toEqual(["low1", "low2"]);
  });

  it("respects a custom minScore override for violations", () => {
    seedTask(store, "edge", "agent-a", 0.70, "approved");
    const report = getScoreIntegrityReport(getRawDb(store), { minScore: 0.75 });

    expect(report.total_violations).toBe(1);
    expect(report.violations[0].task_id).toBe("edge");
    expect(report.min_score_threshold).toBe(0.75);
  });
});

describe("getScoreIntegrityReport — non-approved tasks excluded", () => {
  it("does not count rejected tasks in any bucket", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "r1", "agent-a", 0.90, "rejected");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(0);
    expect(report.buckets.every((b) => b.count === 0)).toBe(true);
  });

  it("does not count pending/null-status tasks", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "p1", "agent-a", 0.88, null);
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(0);
  });
});

describe("getScoreIntegrityReport — null quality_score excluded", () => {
  it("does not include approved tasks with null score in buckets or violations", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "ns1", "agent-a", null, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(0);
    expect(report.buckets.every((b) => b.count === 0)).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

describe("getScoreIntegrityReport — pct calculation", () => {
  it("computes pct correctly: 1 in 0.80+ out of 2 total → 50%", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "high", "agent-a", 0.85, "approved");
    seedTask(store, "mid",  "agent-b", 0.65, "approved");
    const report = getScoreIntegrityReport(getRawDb(store));

    expect(report.total_approved).toBe(2);
    const highBucket = report.buckets.find((b) => b.label === "0.80+")!;
    const midBucket  = report.buckets.find((b) => b.label === "0.60–0.74")!;
    expect(highBucket.pct).toBe(50);
    expect(midBucket.pct).toBe(50);
  });
});

describe("getScoreIntegrityReport — days filter", () => {
  it("excludes tasks older than the look-back window", () => {
    const store = new StateStore(":memory:");
    // Task created 40 days ago — should be excluded with default 30-day window
    seedTask(store, "old", "agent-a", 0.88, "approved", 40);
    // Task created 1 day ago — should be included
    seedTask(store, "new", "agent-b", 0.75, "approved", 1);

    const report = getScoreIntegrityReport(getRawDb(store));  // default 30 days
    expect(report.total_approved).toBe(1);
    expect(report.violations).toHaveLength(0);
  });

  it("includes older tasks when days is expanded", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "old", "agent-a", 0.88, "approved", 40);

    const report = getScoreIntegrityReport(getRawDb(store), { days: 60 });
    expect(report.total_approved).toBe(1);
  });
});

describe("getScoreIntegrityReport — report metadata", () => {
  it("includes enforcement_active=true and a generated_at timestamp", () => {
    const store = new StateStore(":memory:");
    const before = new Date().toISOString();
    const report = getScoreIntegrityReport(getRawDb(store));
    const after = new Date().toISOString();

    expect(report.enforcement_active).toBe(true);
    expect(report.generated_at >= before).toBe(true);
    expect(report.generated_at <= after).toBe(true);
  });
});
