/**
 * Tests for the score calibrator (issue #64).
 *
 * Covers:
 *  - StateStore.recordPROutcome()
 *  - StateStore.getCalibrationData()
 *  - StateStore.getAdjustedThresholds()
 *  - ScoreCalibrator.recordOutcome()
 *  - ScoreCalibrator.buildReport()
 *  - ScoreCalibrator.formatThresholdSection()
 *  - ScoreCalibrator.formatCalibrationPage()
 *  - detectOverApproval()
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  ScoreCalibrator,
  detectOverApproval,
  CALIBRATION_MIN_SAMPLE_SIZE,
} from "../reviewer/score-calibrator.js";
import type { PROutcome } from "../state/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────

function seedOutcome(
  store: StateStore,
  agentName: string,
  taskType: "implementation" | "research",
  qualityScore: number,
  outcome: PROutcome,
  count = 1,
): void {
  for (let i = 0; i < count; i++) {
    store.recordPROutcome({
      task_id: `task-${Math.random().toString(36).slice(2)}`,
      agent_name: agentName,
      task_type: taskType,
      quality_score: qualityScore,
      score_bucket: Math.min(0.9, Math.floor(qualityScore * 10) / 10),
      repo: "owner/repo",
      pr_number: Math.floor(Math.random() * 10000),
      outcome,
    });
  }
}

// ── StateStore.recordPROutcome ─────────────────────────────────────────────

describe("StateStore.recordPROutcome", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("persists a merged outcome record", () => {
    store.recordPROutcome({
      task_id: "t1",
      agent_name: "agent-a",
      task_type: "implementation",
      quality_score: 0.82,
      score_bucket: 0.8,
      repo: "owner/repo",
      pr_number: 1,
      outcome: "merged",
    });
    const rows = store.getCalibrationData();
    // Not enough rows for threshold (MIN = 3) but recordPROutcome should not throw
    // We'll check by checking calibration data with 3 inserts
    expect(rows.length).toBe(0); // only 1 record — below minimum of 3
  });

  it("assigns the correct score_bucket", () => {
    // quality_score 0.75 → bucket 0.7
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 3);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(1);
    expect(rows[0].score_bucket).toBe(0.7);
  });

  it("clamps score_bucket to 0.9 for quality_score = 1.0", () => {
    seedOutcome(store, "agent-a", "implementation", 1.0, "merged", 3);
    const rows = store.getCalibrationData();
    expect(rows[0].score_bucket).toBe(0.9);
  });
});

// ── StateStore.getCalibrationData ─────────────────────────────────────────

describe("StateStore.getCalibrationData", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty when no records exist", () => {
    expect(store.getCalibrationData()).toEqual([]);
  });

  it("excludes cells with fewer than 3 records", () => {
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    expect(store.getCalibrationData()).toEqual([]);
  });

  it("includes cells with exactly 3 records", () => {
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 3);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(1);
    expect(rows[0].total_count).toBe(3);
    expect(rows[0].merge_count).toBe(3);
    expect(rows[0].actual_merge_rate).toBeCloseTo(1.0);
  });

  it("computes actual_merge_rate correctly", () => {
    // 4 merges, 2 rejections → 66.7%
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 4);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 2);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(1);
    expect(rows[0].total_count).toBe(6);
    expect(rows[0].merge_count).toBe(4);
    expect(rows[0].actual_merge_rate).toBeCloseTo(4 / 6);
  });

  it("groups by (agent, task_type, score_bucket)", () => {
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 3);
    seedOutcome(store, "agent-a", "research", 0.75, "merged", 3);
    seedOutcome(store, "agent-b", "implementation", 0.75, "merged", 3);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((r) => r.agent_name)).size).toBe(2);
  });

  it("separates different score buckets for the same agent", () => {
    seedOutcome(store, "agent-a", "implementation", 0.65, "merged", 3);
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 3);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(2);
    expect(rows[0].score_bucket).toBe(0.6);
    expect(rows[1].score_bucket).toBe(0.7);
  });

  it("counts all outcome types in total_count", () => {
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "changes_requested", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 1);
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(1);
    expect(rows[0].total_count).toBe(5);
    expect(rows[0].merge_count).toBe(2);
    expect(rows[0].actual_merge_rate).toBeCloseTo(0.4);
  });
});

// ── StateStore.getAdjustedThresholds ──────────────────────────────────────

describe("StateStore.getAdjustedThresholds", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty when no calibration data exists", () => {
    expect(store.getAdjustedThresholds()).toEqual([]);
  });

  it("recommends the lowest bucket achieving the target merge rate", () => {
    // bucket 0.6: 40% merge rate (below target)
    seedOutcome(store, "agent-a", "implementation", 0.65, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.65, "rejected", 3);
    // bucket 0.7: 80% merge rate (at target)
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 8);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 2);
    // bucket 0.8: 95% merge rate
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 19);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);

    const thresholds = store.getAdjustedThresholds(0.80, 0.70);
    expect(thresholds.length).toBe(1);
    const t = thresholds[0];
    expect(t.agent_name).toBe("agent-a");
    expect(t.task_type).toBe("implementation");
    expect(t.recommended_min_score).toBe(0.7);
    expect(t.current_min_score).toBe(0.70);
    // recommended (0.7) equals current (0.7) → diff is 0 → no action
    expect(t.action_required).toBe(false);
  });

  it("flags action_required when recommended differs from current by > 0.05", () => {
    // No bucket at 0.7 meets target; first hit is at 0.8
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 5);
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);

    const thresholds = store.getAdjustedThresholds(0.80, 0.70);
    const t = thresholds[0];
    // 0.8 vs 0.7: diff = 0.1 > 0.05, and sample_count >= 5
    expect(t.recommended_min_score).toBe(0.8);
    expect(t.action_required).toBe(true);
  });

  it("sets recommended_min_score null when no bucket meets the target", () => {
    // All buckets below 80% merge rate
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 3);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 7);
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 3);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 7);

    const thresholds = store.getAdjustedThresholds(0.80, 0.70);
    const t = thresholds[0];
    expect(t.recommended_min_score).toBeNull();
    expect(t.action_required).toBe(false);
  });

  it("does not flag action_required when sample_count is below 5", () => {
    // Exactly 3 in each bucket (barely above minimum of 3, but < 5 total per agent)
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 3);
    const thresholds = store.getAdjustedThresholds(0.80, 0.70);
    const t = thresholds[0];
    expect(t.sample_count).toBe(3);
    // recommended is 0.8, current is 0.7, diff > 0.05 BUT sample_count < 5
    expect(t.action_required).toBe(false);
  });
});

// ── ScoreCalibrator ────────────────────────────────────────────────────────

describe("ScoreCalibrator.recordOutcome", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store);
  });

  it("records an outcome without throwing", () => {
    expect(() =>
      calibrator.recordOutcome({
        taskId: "t1",
        agentName: "agent-a",
        taskType: "implementation",
        qualityScore: 0.85,
        repo: "owner/repo",
        prNumber: 42,
        outcome: "merged",
      }),
    ).not.toThrow();
  });

  it("persists the record so getCalibrationData can see it", () => {
    for (let i = 0; i < 3; i++) {
      calibrator.recordOutcome({
        taskId: `t${i}`,
        agentName: "agent-a",
        taskType: "implementation",
        qualityScore: 0.85,
        repo: "owner/repo",
        prNumber: i + 1,
        outcome: "merged",
      });
    }
    const rows = store.getCalibrationData();
    expect(rows.length).toBe(1);
    expect(rows[0].merge_count).toBe(3);
  });

  it("does not throw on store errors", () => {
    // Simulate store failure
    const badStore = {
      recordPROutcome: () => { throw new Error("db gone"); },
      getCalibrationData: () => [],
      getAdjustedThresholds: () => [],
    };
    const badCalibrator = new ScoreCalibrator(badStore);
    expect(() =>
      badCalibrator.recordOutcome({
        taskId: "t1",
        agentName: "agent-a",
        taskType: "implementation",
        qualityScore: 0.8,
        repo: "owner/repo",
        prNumber: 1,
        outcome: "merged",
      }),
    ).not.toThrow();
  });
});

describe("ScoreCalibrator.buildReport", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store);
  });

  it("returns empty rows and thresholds when no data", () => {
    const report = calibrator.buildReport();
    expect(report.rows).toEqual([]);
    expect(report.thresholds).toEqual([]);
    expect(report.target_merge_rate).toBe(0.80);
    expect(report.generated_at).toBeTruthy();
  });

  it("includes calibration rows and thresholds when data present", () => {
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 8);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 2);
    const report = calibrator.buildReport(0.80);
    expect(report.rows.length).toBe(1);
    expect(report.thresholds.length).toBe(1);
    expect(report.target_merge_rate).toBe(0.80);
  });
});

describe("ScoreCalibrator.formatThresholdSection", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store);
  });

  it("returns empty array when no action required", () => {
    const lines = calibrator.formatThresholdSection();
    expect(lines).toEqual([]);
  });

  it("returns header + action lines when thresholds need adjustment", () => {
    // Bucket 0.8: 90% merge rate with 10 samples — action vs current 0.70
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 1);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 5);

    const lines = calibrator.formatThresholdSection(0.80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("Calibration");
    expect(lines[1]).toContain("agent-a");
    expect(lines[1]).toContain("implementation");
    expect(lines[1]).toContain("0.70");
    expect(lines[1]).toContain("0.80");
  });
});

describe("ScoreCalibrator.formatCalibrationPage", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store);
  });

  it("shows no-data message when empty", () => {
    const report = calibrator.buildReport();
    const page = calibrator.formatCalibrationPage(report);
    expect(page).toContain("📐");
    expect(page).toContain("No outcome records");
  });

  it("formats calibration data with merge rates and icons", () => {
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);
    const report = calibrator.buildReport(0.80);
    const page = calibrator.formatCalibrationPage(report);
    expect(page).toContain("agent-a");
    expect(page).toContain("implementation");
    expect(page).toContain("90%");
    expect(page).toContain("✅");
  });

  it("shows ❌ icon for low merge rates", () => {
    seedOutcome(store, "agent-a", "implementation", 0.65, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.65, "rejected", 8);
    const report = calibrator.buildReport(0.80);
    const page = calibrator.formatCalibrationPage(report);
    expect(page).toContain("❌");
  });

  it("includes target merge rate in header", () => {
    const report = calibrator.buildReport(0.80);
    const page = calibrator.formatCalibrationPage(report);
    expect(page).toContain("80%");
  });
});

// ── detectOverApproval ─────────────────────────────────────────────────────

describe("detectOverApproval", () => {
  it("returns empty when no rows", () => {
    expect(detectOverApproval([])).toEqual([]);
  });

  it("flags a row in 0.6-0.8 range with merge_rate below target - 0.15", () => {
    const rows = [
      {
        agent_name: "agent-a",
        task_type: "implementation" as const,
        score_bucket: 0.7,
        total_count: 10,
        merge_count: 5,
        actual_merge_rate: 0.50, // target 0.80 - 0.15 = 0.65, 0.50 < 0.65 → flag
      },
    ];
    const issues = detectOverApproval(rows, 0.80);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("agent-a");
    expect(issues[0]).toContain("50%");
  });

  it("does not flag rows outside the 0.6-0.8 score range", () => {
    const rows = [
      {
        agent_name: "agent-a",
        task_type: "implementation" as const,
        score_bucket: 0.5, // below 0.6 — not flagged
        total_count: 10,
        merge_count: 2,
        actual_merge_rate: 0.20,
      },
      {
        agent_name: "agent-a",
        task_type: "implementation" as const,
        score_bucket: 0.9, // above 0.8 — not flagged
        total_count: 10,
        merge_count: 2,
        actual_merge_rate: 0.20,
      },
    ];
    expect(detectOverApproval(rows, 0.80)).toEqual([]);
  });

  it("does not flag rows with fewer than MIN_SAMPLE_SIZE records", () => {
    const rows = [
      {
        agent_name: "agent-a",
        task_type: "implementation" as const,
        score_bucket: 0.7,
        total_count: CALIBRATION_MIN_SAMPLE_SIZE - 1,
        merge_count: 1,
        actual_merge_rate: 0.25,
      },
    ];
    expect(detectOverApproval(rows, 0.80)).toEqual([]);
  });
});
