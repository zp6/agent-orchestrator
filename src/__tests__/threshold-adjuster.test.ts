/**
 * Tests for ThresholdAdjuster — Phase 2 verification calibration (issue #251).
 *
 * Covers:
 *  - recommendedMinScore(): merge_rate ≥ 0.85 and n ≥ 30 gating
 *  - adjustThreshold(): ±0.05 delta cap, justification logging, persistence
 *  - checkLowMergeRateAlerts(): 2+ consecutive bad-cycle Telegram alert
 *  - runAdjustmentCycle(): end-to-end across multiple (verifier, task_type) pairs
 *  - StateStore: getVerifierThreshold / setVerifierThreshold / upsertVerifierAlertState
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import {
  ThresholdAdjuster,
  THRESHOLD_ADJUSTER_MAX_DELTA,
  THRESHOLD_ADJUSTER_MIN_SAMPLES,
  THRESHOLD_ADJUSTER_TARGET_MERGE_RATE,
  THRESHOLD_ADJUSTER_LOW_MERGE_RATE,
  THRESHOLD_ADJUSTER_CONSECUTIVE_BAD_CYCLES,
} from "../reviewer/threshold-adjuster.js";
import type { PROutcome } from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

type RawDB = {
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
};

/**
 * Insert a minimal tasks row so FK constraints on pr_outcome_records are
 * satisfied (issue #366). Uses INSERT OR IGNORE so repeated calls are safe.
 */
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

function seedOutcomes(
  store: StateStore,
  agentName: string,
  taskType: "implementation" | "research" | "housekeeping",
  qualityScore: number,
  outcome: PROutcome,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    const taskId = `task-${Math.random().toString(36).slice(2)}`;
    // Parent task row must exist before the child pr_outcome_records row (issue #366).
    ensureTaskExists(store, taskId);
    store.recordPROutcome({
      task_id: taskId,
      agent_name: agentName,
      task_type: taskType,
      quality_score: qualityScore,
      score_bucket: Math.min(0.9, Math.floor(qualityScore * 10) / 10),
      repo: "owner/repo",
      pr_number: Math.floor(Math.random() * 100_000),
      outcome,
    });
  }
}

// ── Exported constants sanity checks ──────────────────────────────────────

describe("exported constants", () => {
  it("MAX_DELTA is 0.05", () => expect(THRESHOLD_ADJUSTER_MAX_DELTA).toBe(0.05));
  it("MIN_SAMPLES is 30", () => expect(THRESHOLD_ADJUSTER_MIN_SAMPLES).toBe(30));
  it("TARGET_MERGE_RATE is 0.85", () => expect(THRESHOLD_ADJUSTER_TARGET_MERGE_RATE).toBe(0.85));
  it("LOW_MERGE_RATE is 0.70", () => expect(THRESHOLD_ADJUSTER_LOW_MERGE_RATE).toBe(0.70));
  it("CONSECUTIVE_BAD_CYCLES is 2", () => expect(THRESHOLD_ADJUSTER_CONSECUTIVE_BAD_CYCLES).toBe(2));
});

// ── StateStore threshold persistence ──────────────────────────────────────

describe("StateStore.getVerifierThreshold / setVerifierThreshold", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns null when no threshold has been set", () => {
    expect(store.getVerifierThreshold("claude-reviewer", "implementation")).toBeNull();
  });

  it("persists and retrieves a threshold", () => {
    store.setVerifierThreshold("claude-reviewer", "implementation", 0.82, "test justification");
    const result = store.getVerifierThreshold("claude-reviewer", "implementation");
    expect(result).not.toBeNull();
    expect(result!.verifier_id).toBe("claude-reviewer");
    expect(result!.task_type).toBe("implementation");
    expect(result!.threshold).toBe(0.82);
    expect(result!.justification).toBe("test justification");
  });

  it("upserts — updates threshold on second write", () => {
    store.setVerifierThreshold("claude-reviewer", "implementation", 0.80, "first");
    store.setVerifierThreshold("claude-reviewer", "implementation", 0.85, "second");
    const result = store.getVerifierThreshold("claude-reviewer", "implementation");
    expect(result!.threshold).toBe(0.85);
    expect(result!.justification).toBe("second");
  });

  it("maintains separate rows for different task types", () => {
    store.setVerifierThreshold("claude-reviewer", "implementation", 0.80, "impl");
    store.setVerifierThreshold("claude-reviewer", "research", 0.75, "research");
    expect(store.getVerifierThreshold("claude-reviewer", "implementation")!.threshold).toBe(0.80);
    expect(store.getVerifierThreshold("claude-reviewer", "research")!.threshold).toBe(0.75);
  });
});

// ── StateStore alert state persistence ────────────────────────────────────

describe("StateStore.getVerifierAlertStates / upsertVerifierAlertState", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty array when no state recorded", () => {
    expect(store.getVerifierAlertStates("claude-reviewer")).toEqual([]);
  });

  it("persists and retrieves alert state", () => {
    store.upsertVerifierAlertState({
      verifier_id: "claude-reviewer",
      task_type: "implementation",
      score_bucket: 0.7,
      consecutive_bad_cycles: 1,
    });
    const states = store.getVerifierAlertStates("claude-reviewer");
    expect(states).toHaveLength(1);
    expect(states[0].consecutive_bad_cycles).toBe(1);
    expect(states[0].score_bucket).toBe(0.7);
  });

  it("upserts — consecutive_bad_cycles is updated on second write", () => {
    store.upsertVerifierAlertState({
      verifier_id: "claude-reviewer",
      task_type: "implementation",
      score_bucket: 0.7,
      consecutive_bad_cycles: 1,
    });
    store.upsertVerifierAlertState({
      verifier_id: "claude-reviewer",
      task_type: "implementation",
      score_bucket: 0.7,
      consecutive_bad_cycles: 2,
    });
    const states = store.getVerifierAlertStates("claude-reviewer");
    expect(states).toHaveLength(1);
    expect(states[0].consecutive_bad_cycles).toBe(2);
  });

  it("returns only states for the requested verifier", () => {
    store.upsertVerifierAlertState({
      verifier_id: "claude-reviewer",
      task_type: "implementation",
      score_bucket: 0.7,
      consecutive_bad_cycles: 1,
    });
    store.upsertVerifierAlertState({
      verifier_id: "codex-reviewer",
      task_type: "implementation",
      score_bucket: 0.8,
      consecutive_bad_cycles: 3,
    });
    const states = store.getVerifierAlertStates("claude-reviewer");
    expect(states).toHaveLength(1);
    expect(states[0].verifier_id).toBe("claude-reviewer");
  });
});

// ── recommendedMinScore ────────────────────────────────────────────────────

describe("ThresholdAdjuster.recommendedMinScore", () => {
  let store: StateStore;
  let adjuster: ThresholdAdjuster;

  beforeEach(() => {
    store = new StateStore(":memory:");
    adjuster = new ThresholdAdjuster(store);
  });

  it("returns null when calibration table is empty", () => {
    expect(adjuster.recommendedMinScore("claude-reviewer", "implementation")).toBeNull();
  });

  it("returns null when n < 30 (Phase 2 gating)", () => {
    // 29 merged outcomes at 0.8 bucket — just below the 30-sample floor
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 29);
    expect(adjuster.recommendedMinScore("claude-reviewer", "implementation")).toBeNull();
  });

  it("returns null when merge_rate < 0.85 even with sufficient samples", () => {
    // 30 outcomes but only 50% merge rate
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 15);
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "rejected", 15);
    expect(adjuster.recommendedMinScore("claude-reviewer", "implementation")).toBeNull();
  });

  it("returns the bucket when both n ≥ 30 and merge_rate ≥ 0.85", () => {
    // 30 merged at 0.8 bucket → 100% merge rate
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 30);
    const rec = adjuster.recommendedMinScore("claude-reviewer", "implementation");
    expect(rec).toBe(0.8);
  });

  it("picks the LOWEST qualifying bucket (most permissive threshold)", () => {
    // Bucket 0.7: 30 samples, 90% merge rate → qualifies
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 27);
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "rejected", 3);
    // Bucket 0.8: 30 samples, 100% merge rate → also qualifies but is higher
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 30);
    const rec = adjuster.recommendedMinScore("claude-reviewer", "implementation");
    expect(rec).toBe(0.7);
  });
});

// ── adjustThreshold ────────────────────────────────────────────────────────

describe("ThresholdAdjuster.adjustThreshold", () => {
  let store: StateStore;
  let adjuster: ThresholdAdjuster;

  beforeEach(() => {
    store = new StateStore(":memory:");
    adjuster = new ThresholdAdjuster(store);
  });

  it("returns null when calibration data is insufficient (n < 30)", () => {
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 10);
    expect(adjuster.adjustThreshold("claude-reviewer", "implementation")).toBeNull();
  });

  it("returns a result with adjusted=false when threshold is already optimal", () => {
    // Bucket 0.8 qualifies with 100% merge rate; default threshold is also 0.80
    seedOutcomes(store, "claude-reviewer", "implementation", 0.85, "merged", 30);
    const result = adjuster.adjustThreshold("claude-reviewer", "implementation");
    expect(result).not.toBeNull();
    expect(result!.adjusted).toBe(false);
    expect(result!.delta).toBe(0);
    expect(result!.new_threshold).toBe(0.80);
  });

  it("raises threshold by at most MAX_DELTA (0.05) per cycle", () => {
    // Bucket 0.9 qualifies → recommended = 0.9
    // Current default threshold = 0.80 → rawDelta = 0.10 → clamped to 0.05
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    const result = adjuster.adjustThreshold("claude-reviewer", "implementation");
    expect(result).not.toBeNull();
    expect(result!.delta).toBe(0.05);
    expect(result!.new_threshold).toBe(0.85);
    expect(result!.adjusted).toBe(true);
  });

  it("lowers threshold by at most MAX_DELTA (0.05) per cycle", () => {
    // Pre-set a high threshold of 0.90
    store.setVerifierThreshold("claude-reviewer", "implementation", 0.90, "pre-seeded");
    // Bucket 0.7 qualifies → recommended = 0.70
    // rawDelta = 0.70 − 0.90 = −0.20 → clamped to −0.05
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 30);
    const result = adjuster.adjustThreshold("claude-reviewer", "implementation");
    expect(result).not.toBeNull();
    expect(result!.delta).toBe(-0.05);
    expect(result!.new_threshold).toBe(0.85);
    expect(result!.adjusted).toBe(true);
  });

  it("persists the new threshold to the store", () => {
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    adjuster.adjustThreshold("claude-reviewer", "implementation");
    const persisted = store.getVerifierThreshold("claude-reviewer", "implementation");
    expect(persisted).not.toBeNull();
    expect(persisted!.threshold).toBe(0.85);
  });

  it("includes the calibration row details in the justification", () => {
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    const result = adjuster.adjustThreshold("claude-reviewer", "implementation");
    expect(result!.justification).toContain("merge_rate=");
    expect(result!.justification).toContain("n=30");
    expect(result!.justification).toContain("min=30");
  });

  it("does not adjust when n < 30 — Phase 2 gate holds", () => {
    // Exactly 29 samples — below gate
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 29);
    const result = adjuster.adjustThreshold("claude-reviewer", "implementation");
    expect(result).toBeNull();
    expect(store.getVerifierThreshold("claude-reviewer", "implementation")).toBeNull();
  });
});

// ── checkLowMergeRateAlerts ────────────────────────────────────────────────

describe("ThresholdAdjuster.checkLowMergeRateAlerts", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("does not alert on first bad cycle (only 1 cycle, threshold is 2)", async () => {
    const notifyOperator = vi.fn().mockResolvedValue(true);
    const notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };
    const adjuster = new ThresholdAdjuster(store, notifier);

    // Bucket with low merge rate (60%)
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 3);
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "rejected", 2);

    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");

    // First cycle: consecutive_bad_cycles becomes 1 — below threshold of 2
    expect(notifyOperator).not.toHaveBeenCalled();
    const states = store.getVerifierAlertStates("claude-reviewer");
    expect(states[0].consecutive_bad_cycles).toBe(1);
  });

  it("alerts on second consecutive bad cycle", async () => {
    const notifyOperator = vi.fn().mockResolvedValue(true);
    const notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };
    const adjuster = new ThresholdAdjuster(store, notifier);

    // Seed low merge rate data
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 3);
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "rejected", 2);

    // First cycle
    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");
    expect(notifyOperator).not.toHaveBeenCalled();

    // Second cycle — same data still bad
    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");
    expect(notifyOperator).toHaveBeenCalledOnce();

    const [title, body, urgency] = notifyOperator.mock.calls[0];
    expect(title).toContain("Low merge rate");
    expect(body).toContain("60.0%");
    expect(urgency).toBe("medium");
  });

  it("resets counter when bucket recovers above 0.70", async () => {
    const notifyOperator = vi.fn().mockResolvedValue(false);
    const notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };
    const adjuster = new ThresholdAdjuster(store, notifier);

    // Bucket 0.7 with bad merge rate — runs one bad cycle
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 2);
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "rejected", 3);
    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");

    let states = store.getVerifierAlertStates("claude-reviewer");
    expect(states[0].consecutive_bad_cycles).toBe(1);

    // Add more merged outcomes to push merge rate above 0.70
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "merged", 10);
    // Now bucket 0.7 has 12 merged + 3 rejected = 80% merge rate → recovered
    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");

    states = store.getVerifierAlertStates("claude-reviewer");
    expect(states[0].consecutive_bad_cycles).toBe(0);
  });

  it("skips buckets with fewer than 3 outcome records", async () => {
    const notifyOperator = vi.fn().mockResolvedValue(true);
    const notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };
    const adjuster = new ThresholdAdjuster(store, notifier);

    // Only 2 records — below minimum for alert consideration
    seedOutcomes(store, "claude-reviewer", "implementation", 0.75, "rejected", 2);

    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");
    await adjuster.checkLowMergeRateAlerts("claude-reviewer", "implementation");

    expect(notifyOperator).not.toHaveBeenCalled();
  });
});

// ── runAdjustmentCycle (integration) ──────────────────────────────────────

describe("ThresholdAdjuster.runAdjustmentCycle", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns empty array when calibration table is empty", async () => {
    const adjuster = new ThresholdAdjuster(store);
    const results = await adjuster.runAdjustmentCycle();
    expect(results).toEqual([]);
  });

  it("processes all (verifier, task_type) pairs in the table", async () => {
    // Pair 1: claude-reviewer / implementation — 30 samples → qualifies
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    // Pair 2: claude-reviewer / research — only 10 samples → skipped
    seedOutcomes(store, "claude-reviewer", "research", 0.95, "merged", 10);

    const adjuster = new ThresholdAdjuster(store);
    const results = await adjuster.runAdjustmentCycle();

    // Only the qualifying pair produces a result
    expect(results).toHaveLength(1);
    expect(results[0].verifier_id).toBe("claude-reviewer");
    expect(results[0].task_type).toBe("implementation");
  });

  it("threshold cannot move more than 0.05 in a single cycle", async () => {
    // Recommended bucket is 0.9 but default threshold is 0.80 → raw delta = +0.10
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    const adjuster = new ThresholdAdjuster(store);
    const results = await adjuster.runAdjustmentCycle();
    expect(results[0].delta).toBeLessThanOrEqual(0.05);
    expect(results[0].delta).toBeGreaterThanOrEqual(-0.05);
    expect(results[0].new_threshold).toBe(0.85); // 0.80 + 0.05
  });

  it("n < 30 prevents auto-adjustment across the cycle", async () => {
    // 29 samples — one below the gate
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 29);
    const adjuster = new ThresholdAdjuster(store);
    const results = await adjuster.runAdjustmentCycle();
    expect(results).toHaveLength(0);
    expect(store.getVerifierThreshold("claude-reviewer", "implementation")).toBeNull();
  });

  it("accumulates results across multiple verifiers", async () => {
    seedOutcomes(store, "claude-reviewer", "implementation", 0.95, "merged", 30);
    seedOutcomes(store, "codex-reviewer", "implementation", 0.95, "merged", 30);
    const adjuster = new ThresholdAdjuster(store);
    const results = await adjuster.runAdjustmentCycle();
    // Both verifiers are separate pairs → 2 results
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.verifier_id).sort();
    expect(ids).toEqual(["claude-reviewer", "codex-reviewer"]);
  });
});
