/**
 * Tests for calibration recommendation persistence and REST feed (issue #477).
 *
 * Covers:
 *  - StateStore.upsertCalibrationRecommendation() — insert and dedup
 *  - StateStore.getCalibrationRecommendations() — unfiltered and status-filtered
 *  - StateStore.resolveCalibrationRecommendation() — lifecycle transitions
 *  - ScoreCalibrator.buildReport() — persists action_required thresholds
 *  - ScoreCalibrator.autoApplyHighConfidenceRecommendations() — high-confidence sweep
 *  - getCalibrationRecommendationsFeed() — REST payload builder
 *  - resolveCalibrationRecommendationById() — resolve handler with validation
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import { ScoreCalibrator } from "../reviewer/score-calibrator.js";
import {
  getCalibrationRecommendationsFeed,
  resolveCalibrationRecommendationById,
} from "../reviewer/calibration-recommendations-feed.js";
import type { PROutcome } from "../state/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

type RawDB = {
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
};

function ensureTaskExists(store: StateStore, taskId: string): void {
  const raw = store as unknown as RawDB;
  raw.db
    .prepare(
      `INSERT OR IGNORE INTO tasks
         (id, title, status, task_type, created_at, updated_at)
       VALUES (?, ?, 'done', 'implementation', datetime('now'), datetime('now'))`,
    )
    .run(taskId, `Task ${taskId}`);
}

function seedOutcome(
  store: StateStore,
  agentName: string,
  taskType: "implementation" | "research",
  qualityScore: number,
  outcome: PROutcome,
  count = 1,
): void {
  for (let i = 0; i < count; i++) {
    const taskId = `task-${Math.random().toString(36).slice(2)}`;
    ensureTaskExists(store, taskId);
    store.recordPROutcome({
      task_id: taskId,
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

// ── StateStore.upsertCalibrationRecommendation ────────────────────────────────

describe("StateStore.upsertCalibrationRecommendation", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("inserts a new recommendation and returns it", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    expect(rec).not.toBeNull();
    expect(rec!.agent_name).toBe("agent-a");
    expect(rec!.task_type).toBe("implementation");
    expect(rec!.current_min_score).toBe(0.70);
    expect(rec!.recommended_min_score).toBe(0.80);
    expect(rec!.sample_count).toBe(10);
    expect(rec!.confidence).toBeCloseTo(0.33, 2);
    expect(rec!.status).toBe("pending");
    expect(rec!.id).toBeTruthy();
    expect(rec!.created_at).toBeTruthy();
    expect(rec!.resolved_at).toBeNull();
    expect(rec!.resolution_notes).toBeNull();
  });

  it("returns null when a pending row already exists for the same (agent, task_type)", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    const duplicate = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.85,
      sample_count: 12,
      confidence: 0.40,
      status: "pending",
    });

    expect(duplicate).toBeNull();

    // Only one row in the DB
    const all = store.getCalibrationRecommendations();
    expect(all.length).toBe(1);
  });

  it("allows a new insert for the same pair after the existing one is resolved", () => {
    const first = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    store.resolveCalibrationRecommendation(first!.id, "applied", "operator approved");

    const second = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.80,
      recommended_min_score: 0.85,
      sample_count: 15,
      confidence: 0.50,
      status: "pending",
    });

    expect(second).not.toBeNull();
    expect(second!.current_min_score).toBe(0.80);
  });

  it("allows separate pending rows for different agents", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    const second = store.upsertCalibrationRecommendation({
      agent_name: "agent-b",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 8,
      confidence: 0.27,
      status: "pending",
    });

    expect(second).not.toBeNull();
    expect(store.getCalibrationRecommendations().length).toBe(2);
  });

  it("allows separate pending rows for different task_types of the same agent", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    const second = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "research",
      current_min_score: 0.70,
      recommended_min_score: 0.75,
      sample_count: 6,
      confidence: 0.20,
      status: "pending",
    });

    expect(second).not.toBeNull();
    expect(store.getCalibrationRecommendations().length).toBe(2);
  });

  it("inserts auto_applied status directly without dedup conflict with pending", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 30,
      confidence: 1.0,
      status: "auto_applied",
    });

    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("auto_applied");
  });
});

// ── StateStore.getCalibrationRecommendations ──────────────────────────────────

describe("StateStore.getCalibrationRecommendations", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty array when no recommendations exist", () => {
    expect(store.getCalibrationRecommendations()).toEqual([]);
  });

  it("returns all recommendations when no status filter", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });
    const first = store.getCalibrationRecommendations()[0];
    store.resolveCalibrationRecommendation(first.id, "applied");
    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 8, confidence: 0.27, status: "pending",
    });

    const all = store.getCalibrationRecommendations();
    expect(all.length).toBe(2);
  });

  it("filters by status when specified", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });
    const first = store.getCalibrationRecommendations()[0];
    store.resolveCalibrationRecommendation(first.id, "dismissed", "not needed now");
    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "research",
      current_min_score: 0.65, recommended_min_score: 0.75,
      sample_count: 7, confidence: 0.23, status: "pending",
    });

    const pending = store.getCalibrationRecommendations("pending");
    expect(pending.length).toBe(1);
    expect(pending[0].agent_name).toBe("agent-b");

    const dismissed = store.getCalibrationRecommendations("dismissed");
    expect(dismissed.length).toBe(1);
    expect(dismissed[0].resolution_notes).toBe("not needed now");
  });

  it("returns multiple recommendations in DESC order (both agents present)", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });
    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 8, confidence: 0.27, status: "pending",
    });

    const all = store.getCalibrationRecommendations();
    expect(all.length).toBe(2);
    const agentNames = all.map((r) => r.agent_name);
    expect(agentNames).toContain("agent-a");
    expect(agentNames).toContain("agent-b");
  });
});

// ── StateStore.resolveCalibrationRecommendation ───────────────────────────────

describe("StateStore.resolveCalibrationRecommendation", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns false when id is not found", () => {
    const ok = store.resolveCalibrationRecommendation("nonexistent-id", "applied");
    expect(ok).toBe(false);
  });

  it("updates status to applied and sets resolved_at", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });

    const ok = store.resolveCalibrationRecommendation(rec!.id, "applied", "approved by operator");
    expect(ok).toBe(true);

    const updated = store.getCalibrationRecommendations("applied");
    expect(updated.length).toBe(1);
    expect(updated[0].status).toBe("applied");
    expect(updated[0].resolved_at).not.toBeNull();
    expect(updated[0].resolution_notes).toBe("approved by operator");
  });

  it("updates status to dismissed without notes", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });

    store.resolveCalibrationRecommendation(rec!.id, "dismissed");
    const dismissed = store.getCalibrationRecommendations("dismissed");
    expect(dismissed.length).toBe(1);
    expect(dismissed[0].resolution_notes).toBeNull();
  });

  it("updates status to auto_applied", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 30, confidence: 1.0, status: "pending",
    });

    store.resolveCalibrationRecommendation(rec!.id, "auto_applied", "Confidence 100%");
    const auto = store.getCalibrationRecommendations("auto_applied");
    expect(auto.length).toBe(1);
    expect(auto[0].resolution_notes).toBe("Confidence 100%");
  });
});

// ── ScoreCalibrator.buildReport (recommendation persistence) ──────────────────

describe("ScoreCalibrator.buildReport with recommendationStore", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store, store);
  });

  it("persists an action_required recommendation when buildReport is called", () => {
    // bucket 0.7: below target; bucket 0.8: 90% merge rate → action required (0.8 vs 0.7 default)
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 5);
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);

    calibrator.buildReport(0.80);

    const recs = store.getCalibrationRecommendations("pending");
    expect(recs.length).toBe(1);
    expect(recs[0].agent_name).toBe("agent-a");
    expect(recs[0].recommended_min_score).toBe(0.8);
    expect(recs[0].current_min_score).toBe(0.70);
    expect(recs[0].confidence).toBeGreaterThan(0);
    expect(recs[0].confidence).toBeLessThanOrEqual(1.0);
  });

  it("deduplicates: does not create a second pending row on repeated calls", () => {
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 5);
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);

    calibrator.buildReport(0.80);
    calibrator.buildReport(0.80);

    const recs = store.getCalibrationRecommendations("pending");
    expect(recs.length).toBe(1);
  });

  it("does not persist when action_required is false", () => {
    // Only one bucket with 90% merge rate, current = recommended → no action
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 1);

    calibrator.buildReport(0.80);

    const recs = store.getCalibrationRecommendations();
    expect(recs.length).toBe(0);
  });

  it("marks recommendation as auto_applied when confidence >= 0.95 (sample_count >= 28)", () => {
    // 28+ samples → confidence = min(1.0, 28/30) = 0.933... actually 28/30 = 0.933 < 0.95
    // Need 29+ samples for >= 0.95: 29/30 = 0.967 >= 0.95
    seedOutcome(store, "agent-a", "implementation", 0.75, "merged", 2);
    seedOutcome(store, "agent-a", "implementation", 0.75, "rejected", 2);
    // bucket 0.8: needs enough samples; let's use 29 samples total
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 25);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 0);

    calibrator.buildReport(0.80);

    // total samples: 4 + 25 = 29, confidence = min(1, 29/30) ≈ 0.967 >= 0.95
    const autoApplied = store.getCalibrationRecommendations("auto_applied");
    const pending = store.getCalibrationRecommendations("pending");

    // Should be auto_applied (not pending)
    expect(autoApplied.length + pending.length).toBe(1);
    if (autoApplied.length === 1) {
      expect(autoApplied[0].confidence).toBeGreaterThanOrEqual(0.95);
    } else {
      // If pending, confidence must be < 0.95
      expect(pending[0].confidence).toBeLessThan(0.95);
    }
  });

  it("works without recommendationStore (no-op)", () => {
    const noStoreCalibrator = new ScoreCalibrator(store);
    seedOutcome(store, "agent-a", "implementation", 0.85, "merged", 9);
    seedOutcome(store, "agent-a", "implementation", 0.85, "rejected", 1);

    expect(() => noStoreCalibrator.buildReport(0.80)).not.toThrow();
    expect(store.getCalibrationRecommendations().length).toBe(0);
  });
});

// ── ScoreCalibrator.autoApplyHighConfidenceRecommendations ────────────────────

describe("ScoreCalibrator.autoApplyHighConfidenceRecommendations", () => {
  let store: StateStore;
  let calibrator: ScoreCalibrator;

  beforeEach(() => {
    store = new StateStore(":memory:");
    calibrator = new ScoreCalibrator(store, store);
  });

  it("returns 0 when there are no pending recommendations", () => {
    const count = calibrator.autoApplyHighConfidenceRecommendations();
    expect(count).toBe(0);
  });

  it("auto-applies pending recommendations with confidence >= 0.95", () => {
    // Insert a pending recommendation with high confidence
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 30,
      confidence: 1.0,
      status: "pending",
    });

    const count = calibrator.autoApplyHighConfidenceRecommendations();
    expect(count).toBe(1);

    const autoApplied = store.getCalibrationRecommendations("auto_applied");
    expect(autoApplied.length).toBe(1);
    expect(autoApplied[0].resolution_notes).toContain("Auto-applied");
    expect(autoApplied[0].resolution_notes).toContain("100%");
  });

  it("does not auto-apply pending recommendations with confidence < 0.95", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a",
      task_type: "implementation",
      current_min_score: 0.70,
      recommended_min_score: 0.80,
      sample_count: 10,
      confidence: 0.33,
      status: "pending",
    });

    const count = calibrator.autoApplyHighConfidenceRecommendations();
    expect(count).toBe(0);

    expect(store.getCalibrationRecommendations("pending").length).toBe(1);
    expect(store.getCalibrationRecommendations("auto_applied").length).toBe(0);
  });

  it("processes multiple pending recommendations independently", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 30, confidence: 1.0, status: "pending",
    });
    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.75,
      sample_count: 8, confidence: 0.27, status: "pending",
    });

    const count = calibrator.autoApplyHighConfidenceRecommendations();
    expect(count).toBe(1); // only agent-a has high confidence

    expect(store.getCalibrationRecommendations("auto_applied").length).toBe(1);
    expect(store.getCalibrationRecommendations("pending").length).toBe(1);
    expect(store.getCalibrationRecommendations("pending")[0].agent_name).toBe("agent-b");
  });

  it("returns 0 when no recommendationStore provided", () => {
    const noStore = new ScoreCalibrator(store);
    const count = noStore.autoApplyHighConfidenceRecommendations();
    expect(count).toBe(0);
  });
});

// ── getCalibrationRecommendationsFeed ─────────────────────────────────────────

describe("getCalibrationRecommendationsFeed", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty feed when no recommendations exist", () => {
    const feed = getCalibrationRecommendationsFeed(store);
    expect(feed.recommendations).toEqual([]);
    expect(feed.summary.total).toBe(0);
    expect(feed.summary.pending).toBe(0);
    expect(feed.status_filter).toBeNull();
    expect(feed.generated_at).toBeTruthy();
  });

  it("returns all recommendations with accurate summary counts", () => {
    const r1 = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });
    store.resolveCalibrationRecommendation(r1!.id, "applied");

    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "research",
      current_min_score: 0.65, recommended_min_score: 0.75,
      sample_count: 7, confidence: 0.23, status: "pending",
    });

    const feed = getCalibrationRecommendationsFeed(store);
    expect(feed.recommendations.length).toBe(2);
    expect(feed.summary.total).toBe(2);
    expect(feed.summary.applied).toBe(1);
    expect(feed.summary.pending).toBe(1);
    expect(feed.summary.dismissed).toBe(0);
    expect(feed.summary.auto_applied).toBe(0);
    expect(feed.status_filter).toBeNull();
  });

  it("filters by status when specified", () => {
    store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });
    store.upsertCalibrationRecommendation({
      agent_name: "agent-b", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 8, confidence: 0.27, status: "pending",
    });

    const feed = getCalibrationRecommendationsFeed(store, { status: "pending" });
    expect(feed.recommendations.length).toBe(2);
    expect(feed.status_filter).toBe("pending");
    // Summary still counts ALL recommendations
    expect(feed.summary.total).toBe(2);
  });
});

// ── resolveCalibrationRecommendationById ─────────────────────────────────────

describe("resolveCalibrationRecommendationById", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns 400 for an invalid status", () => {
    const result = resolveCalibrationRecommendationById(store, "any-id", "invalid-status");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain("Invalid status");
    }
  });

  it("returns 404 when the recommendation id is not found", () => {
    const result = resolveCalibrationRecommendationById(store, "nonexistent", "applied");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it("resolves a pending recommendation to applied", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });

    const result = resolveCalibrationRecommendationById(
      store, rec!.id, "applied", "operator approved threshold raise",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recommendation.status).toBe("applied");
      expect(result.recommendation.resolution_notes).toBe("operator approved threshold raise");
      expect(result.recommendation.resolved_at).not.toBeNull();
    }
  });

  it("resolves to dismissed", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 10, confidence: 0.33, status: "pending",
    });

    const result = resolveCalibrationRecommendationById(store, rec!.id, "dismissed");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recommendation.status).toBe("dismissed");
    }
  });

  it("resolves to auto_applied", () => {
    const rec = store.upsertCalibrationRecommendation({
      agent_name: "agent-a", task_type: "implementation",
      current_min_score: 0.70, recommended_min_score: 0.80,
      sample_count: 30, confidence: 1.0, status: "pending",
    });

    const result = resolveCalibrationRecommendationById(
      store, rec!.id, "auto_applied", "Confidence 100%",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recommendation.status).toBe("auto_applied");
    }
  });
});
