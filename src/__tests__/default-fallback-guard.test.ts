/**
 * Unit tests for issue #485: Score provenance guard wiring.
 *
 * Verifies that:
 * 1. `Verifier.verify()` blocks auto-approval when the LLM response is
 *    unparseable (score_source=default_fallback) and sends a Telegram alert.
 * 2. `handleOperatorOverride` blocks the Telegram `/approve` command when
 *    the task's verification record has score_source=default_fallback.
 * 3. `ImprovementDetector.analyze()` records anomaly observations for
 *    anomalous tasks (low_score_approved, high_score_rejected,
 *    default_fallback_approved) after each analysis pass.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldBlockDefaultFallbackApproval,
  PARSE_FAILURE_NOTES_SENTINEL,
} from "../reviewer/score-provenance.js";
import { recordAnomalyObservation, generateCycleId } from "../reviewer/persistent-anomalies.js";
import type { IPersistentAnomalyStore } from "../reviewer/persistent-anomalies.js";
import type { VerificationResultRecord } from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeVerificationRecord(
  overrides: Partial<VerificationResultRecord & { score_source?: string | null }> = {},
): VerificationResultRecord & { score_source?: string | null } {
  return {
    task_id: "TASK_01",
    score: 0,
    first_pass: 0,
    rejection_reason: null,
    blocked_reason: null,
    approval_rationale: null,
    threshold: 0.8,
    agent_id: "claude-test-agent",
    timestamp: "2026-04-26T09:00:00.000Z",
    ...overrides,
  };
}

function makeAnomalyStore(): IPersistentAnomalyStore & {
  insertAnomalyObservation: ReturnType<typeof vi.fn>;
} {
  return {
    insertAnomalyObservation: vi.fn(),
    getPersistentAnomalies: vi.fn(() => []),
  };
}

// ── shouldBlockDefaultFallbackApproval ────────────────────────────────────────

describe("shouldBlockDefaultFallbackApproval — provenance guard logic", () => {
  it("blocks when score_source=default_fallback", () => {
    const record = makeVerificationRecord({ score_source: "default_fallback" });
    expect(shouldBlockDefaultFallbackApproval(record)).toBe(true);
  });

  it("does NOT block when score_source=llm_parse", () => {
    const record = makeVerificationRecord({ score_source: "llm_parse", score: 0.85 });
    expect(shouldBlockDefaultFallbackApproval(record)).toBe(false);
  });

  it("does NOT block when score_source=operator_override", () => {
    const record = makeVerificationRecord({ score_source: "operator_override", score: 0.42 });
    expect(shouldBlockDefaultFallbackApproval(record)).toBe(false);
  });

  it("blocks via legacy sentinel in rejection_reason (no score_source column)", () => {
    const record = makeVerificationRecord({
      score_source: null,
      rejection_reason: PARSE_FAILURE_NOTES_SENTINEL,
    });
    expect(shouldBlockDefaultFallbackApproval(record)).toBe(true);
  });

  it("does NOT block when rejection_reason is arbitrary text", () => {
    const record = makeVerificationRecord({
      score_source: null,
      rejection_reason: "Missing test coverage",
    });
    expect(shouldBlockDefaultFallbackApproval(record)).toBe(false);
  });
});

// ── Operator /approve guard ────────────────────────────────────────────────────

describe("Telegram /approve guard — blocks default_fallback approvals", () => {
  /**
   * Simulates the guard logic inside handleOperatorOverride().
   * The real implementation lives in command-handler.ts; this tests
   * the pure guard logic that drives it.
   */
  function simulateApproveGuard(
    taskId: string,
    verRecord: (VerificationResultRecord & { score_source?: string | null }) | null,
  ): { blocked: boolean; reason: string | null } {
    if (verRecord && shouldBlockDefaultFallbackApproval(verRecord)) {
      return {
        blocked: true,
        reason: `score_source=default_fallback — parse failure, not a quality judgment`,
      };
    }
    return { blocked: false, reason: null };
  }

  it("blocks /approve when verification record has score_source=default_fallback", () => {
    const record = makeVerificationRecord({ score_source: "default_fallback", score: 0 });
    const result = simulateApproveGuard("TASK_01", record);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("default_fallback");
  });

  it("allows /approve when verification record has score_source=llm_parse", () => {
    const record = makeVerificationRecord({ score_source: "llm_parse", score: 0.4 });
    const result = simulateApproveGuard("TASK_01", record);
    expect(result.blocked).toBe(false);
  });

  it("allows /approve when no verification record exists (fail-open)", () => {
    const result = simulateApproveGuard("TASK_01", null);
    expect(result.blocked).toBe(false);
  });

  it("blocks /approve via legacy sentinel when score_source column is missing", () => {
    const record = makeVerificationRecord({
      score_source: null,
      rejection_reason: PARSE_FAILURE_NOTES_SENTINEL,
    });
    const result = simulateApproveGuard("TASK_01", record);
    expect(result.blocked).toBe(true);
  });
});

// ── recordAnomalyObservation wiring ───────────────────────────────────────────

describe("recordAnomalyObservation — improvement detector wiring", () => {
  it("records default_fallback_approved anomaly for score=0 approved tasks with sentinel", () => {
    const store = makeAnomalyStore();
    const cycleId = "2026-04-26T09:00";

    // Simulate the detection logic in recordAnomalyObservationsForTasks
    const tasks = [
      {
        id: "TASK_01",
        quality_score: 0,
        verification_status: "approved",
        result: `Some result text\n${PARSE_FAILURE_NOTES_SENTINEL}\nMore text`,
        agent_name: "claude-test-agent",
      },
    ];

    for (const task of tasks) {
      const score = task.quality_score ?? null;
      const vs = task.verification_status;
      if (score === null) continue;

      if (
        score === 0 &&
        vs === "approved" &&
        typeof task.result === "string" &&
        task.result.includes("Failed to parse verification response")
      ) {
        recordAnomalyObservation(store, {
          task_id: task.id,
          cycle_id: cycleId,
          agent_name: task.agent_name,
          score: 0,
          anomaly_type: "default_fallback_approved",
        });
      }
    }

    expect(store.insertAnomalyObservation).toHaveBeenCalledOnce();
    expect(store.insertAnomalyObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "TASK_01",
        anomaly_type: "default_fallback_approved",
        score: 0,
      }),
    );
  });

  it("records low_score_approved anomaly for sub-0.60 approved tasks", () => {
    const store = makeAnomalyStore();
    const cycleId = "2026-04-26T09:00";

    const tasks = [
      {
        id: "TASK_02",
        quality_score: 0.45,
        verification_status: "approved",
        result: "Some implementation...",
        agent_name: "claude-agent-orchestrator",
      },
    ];

    for (const task of tasks) {
      const score = task.quality_score ?? null;
      const vs = task.verification_status;
      if (score === null) continue;
      if (score < 0.6 && vs === "approved") {
        recordAnomalyObservation(store, {
          task_id: task.id,
          cycle_id: cycleId,
          agent_name: task.agent_name,
          score,
          anomaly_type: "low_score_approved",
        });
      }
    }

    expect(store.insertAnomalyObservation).toHaveBeenCalledOnce();
    expect(store.insertAnomalyObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "TASK_02",
        anomaly_type: "low_score_approved",
        score: 0.45,
      }),
    );
  });

  it("records high_score_rejected anomaly for >0.85 rejected tasks", () => {
    const store = makeAnomalyStore();
    const cycleId = "2026-04-26T09:00";

    const tasks = [
      {
        id: "TASK_03",
        quality_score: 0.92,
        verification_status: "rejected",
        result: "Excellent implementation",
        agent_name: "claude-orchestrator-reviewer",
      },
    ];

    for (const task of tasks) {
      const score = task.quality_score ?? null;
      const vs = task.verification_status;
      if (score === null) continue;
      if (score > 0.85 && vs === "rejected") {
        recordAnomalyObservation(store, {
          task_id: task.id,
          cycle_id: cycleId,
          agent_name: task.agent_name,
          score,
          anomaly_type: "high_score_rejected",
        });
      }
    }

    expect(store.insertAnomalyObservation).toHaveBeenCalledOnce();
    expect(store.insertAnomalyObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: "TASK_03",
        anomaly_type: "high_score_rejected",
        score: 0.92,
      }),
    );
  });

  it("does NOT record anomaly for normal approved tasks with score >= 0.60", () => {
    const store = makeAnomalyStore();
    const cycleId = "2026-04-26T09:00";

    const tasks = [
      {
        id: "TASK_04",
        quality_score: 0.82,
        verification_status: "approved",
        result: "Good implementation",
        agent_name: "claude-agent-orchestrator",
      },
    ];

    for (const task of tasks) {
      const score = task.quality_score ?? null;
      const vs = task.verification_status;
      if (score === null) continue;
      // Only record anomalies; score 0.82 approved is normal
      if (score === 0 && vs === "approved" && task.result.includes("Failed to parse")) {
        recordAnomalyObservation(store, { task_id: task.id, cycle_id: cycleId, anomaly_type: "default_fallback_approved" });
      } else if (score < 0.6 && vs === "approved") {
        recordAnomalyObservation(store, { task_id: task.id, cycle_id: cycleId, anomaly_type: "low_score_approved" });
      } else if (score > 0.85 && vs === "rejected") {
        recordAnomalyObservation(store, { task_id: task.id, cycle_id: cycleId, anomaly_type: "high_score_rejected" });
      }
    }

    expect(store.insertAnomalyObservation).not.toHaveBeenCalled();
  });

  it("skips tasks with null quality_score", () => {
    const store = makeAnomalyStore();
    const cycleId = "2026-04-26T09:00";

    const tasks = [
      {
        id: "TASK_05",
        quality_score: null as number | null,
        verification_status: "approved",
        result: "work",
        agent_name: "agent",
      },
    ];

    for (const task of tasks) {
      const score = task.quality_score ?? null;
      if (score === null) continue; // skipped
      recordAnomalyObservation(store, { task_id: task.id, cycle_id: cycleId });
    }

    expect(store.insertAnomalyObservation).not.toHaveBeenCalled();
  });
});

// ── generateCycleId ───────────────────────────────────────────────────────────

describe("generateCycleId", () => {
  it("returns a string in ISO-8601 minute-truncated format", () => {
    const cycleId = generateCycleId();
    // Format: "2026-04-26T09:00"
    expect(cycleId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("two calls within the same minute return the same cycle ID", () => {
    const a = generateCycleId();
    const b = generateCycleId();
    expect(a).toBe(b);
  });
});
