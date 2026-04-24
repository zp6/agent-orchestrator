/**
 * Tests for StateStore pattern_risk read methods (issue #1149).
 *
 * Verifies that getRecentPatternRiskSignals() and getAgentPatternRiskSummaries()
 * correctly read and aggregate rows from the pattern_risk table.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";

describe("StateStore – pattern_risk methods", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  /** Insert a raw pattern_risk row directly via the store's underlying db. */
  function insertSignal(
    taskId: string,
    agentId: string,
    patternType: string,
    riskScore: number,
    detail = "",
    recordedAt = new Date().toISOString(),
  ) {
    // Access via a cast since the method is private-to-migrations only.
    // Use SQL directly through the store's exposed close() / test-only db path.
    const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
    db.prepare(
      `INSERT INTO pattern_risk (task_id, agent_id, pattern_type, risk_score, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(taskId, agentId, patternType, riskScore, detail, recordedAt);
  }

  describe("getRecentPatternRiskSignals()", () => {
    it("returns empty array when table is empty", () => {
      expect(store.getRecentPatternRiskSignals()).toEqual([]);
    });

    it("returns signals within the window", () => {
      insertSignal("T001", "agent-a", "repeated_failure", 0.8, "Detail A");
      const signals = store.getRecentPatternRiskSignals(48);
      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        task_id: "T001",
        agent_id: "agent-a",
        pattern_type: "repeated_failure",
        risk_score: 0.8,
        detail: "Detail A",
      });
    });

    it("excludes signals older than the window", () => {
      const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
      insertSignal("T_OLD", "agent-a", "repeated_failure", 0.9, "", old);
      expect(store.getRecentPatternRiskSignals(48)).toHaveLength(0);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        insertSignal(`T${i}`, "agent-a", "repeated_failure", 0.5);
      }
      const signals = store.getRecentPatternRiskSignals(48, 3);
      expect(signals).toHaveLength(3);
    });
  });

  describe("getAgentPatternRiskSummaries()", () => {
    it("returns empty array when table is empty", () => {
      expect(store.getAgentPatternRiskSummaries()).toEqual([]);
    });

    it("aggregates signals per agent", () => {
      insertSignal("T1", "agent-x", "repeated_failure", 0.8, "Detail 1");
      insertSignal("T2", "agent-x", "low_score_streak", 0.6, "Detail 2");
      insertSignal("T3", "agent-y", "dimension_gap", 0.4, "Detail Y");

      const summaries = store.getAgentPatternRiskSummaries();
      expect(summaries).toHaveLength(2);

      const agentX = summaries.find((s) => s.agent_id === "agent-x");
      expect(agentX).toBeDefined();
      expect(agentX!.signal_count).toBe(2);
      expect(agentX!.mean_risk_score).toBeCloseTo(0.7, 2);
      expect(agentX!.pattern_types).toContain("repeated_failure");
      expect(agentX!.pattern_types).toContain("low_score_streak");
    });

    it("sorts results by mean_risk_score descending", () => {
      insertSignal("T1", "low-risk-agent", "dimension_gap", 0.2);
      insertSignal("T2", "high-risk-agent", "repeated_failure", 0.9);

      const summaries = store.getAgentPatternRiskSummaries();
      expect(summaries[0].agent_id).toBe("high-risk-agent");
      expect(summaries[1].agent_id).toBe("low-risk-agent");
    });

    it("sets top_detail to the highest-risk signal's detail", () => {
      insertSignal("T1", "agent-a", "repeated_failure", 0.5, "medium detail");
      insertSignal("T2", "agent-a", "low_score_streak", 0.9, "high risk detail");
      insertSignal("T3", "agent-a", "dimension_gap", 0.3, "low risk detail");

      const [summary] = store.getAgentPatternRiskSummaries();
      expect(summary.top_detail).toBe("high risk detail");
    });

    it("excludes agents with no signals in the window", () => {
      const old = new Date(Date.now() - 72 * 3_600_000).toISOString();
      insertSignal("T_OLD", "old-agent", "repeated_failure", 0.8, "", old);
      expect(store.getAgentPatternRiskSummaries(48)).toHaveLength(0);
    });
  });
});
