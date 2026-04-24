/**
 * Tests for PatternRiskConsumer (issue #1149).
 *
 * Verifies that pattern_risk signals written by the daemon are correctly read,
 * aggregated, and formatted as LLM-prompt context by the consumer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PatternRiskConsumer } from "../reviewer/pattern-risk-consumer.js";
import type { IPatternRiskStore, PatternRiskSignal, AgentPatternRiskSummary } from "../state/types.js";

/** Minimal stub that returns a fixed list of summaries. */
function makeStore(summaries: AgentPatternRiskSummary[]): IPatternRiskStore {
  return {
    getRecentPatternRiskSignals: vi.fn(() => [] as PatternRiskSignal[]),
    getAgentPatternRiskSummaries: vi.fn(() => summaries),
  };
}

describe("PatternRiskConsumer", () => {
  describe("buildRiskContext()", () => {
    it("returns empty string when there are no signals", () => {
      const consumer = new PatternRiskConsumer(makeStore([]));
      expect(consumer.buildRiskContext()).toBe("");
    });

    it("includes header when signals are present", () => {
      const summaries: AgentPatternRiskSummary[] = [
        {
          agent_id: "claude-agent-orchestrator",
          latest_risk_score: 0.8,
          mean_risk_score: 0.75,
          pattern_types: ["repeated_failure", "low_score_streak"],
          top_detail: "Agent failed test_coverage 3 consecutive times",
          signal_count: 5,
        },
      ];
      const consumer = new PatternRiskConsumer(makeStore(summaries));
      const ctx = consumer.buildRiskContext();

      expect(ctx).toContain("Pattern Risk Signals");
      expect(ctx).toContain("claude-agent-orchestrator");
      expect(ctx).toContain("mean_risk_score=0.75");
      expect(ctx).toContain("signals=5");
      expect(ctx).toContain("repeated_failure");
      expect(ctx).toContain("low_score_streak");
      expect(ctx).toContain("Agent failed test_coverage 3 consecutive times");
    });

    it("lists multiple agents sorted by mean_risk_score (store handles sort)", () => {
      const summaries: AgentPatternRiskSummary[] = [
        {
          agent_id: "claude-proxy",
          latest_risk_score: 0.9,
          mean_risk_score: 0.85,
          pattern_types: ["repeated_failure"],
          top_detail: "High risk proxy agent",
          signal_count: 3,
        },
        {
          agent_id: "claude-orchestrator-reviewer",
          latest_risk_score: 0.4,
          mean_risk_score: 0.35,
          pattern_types: ["dimension_gap"],
          top_detail: "Low risk reviewer agent",
          signal_count: 2,
        },
      ];
      const consumer = new PatternRiskConsumer(makeStore(summaries));
      const ctx = consumer.buildRiskContext();

      const proxyIdx = ctx.indexOf("claude-proxy");
      const reviewerIdx = ctx.indexOf("claude-orchestrator-reviewer");
      // store returns them in the order provided; both should appear
      expect(proxyIdx).toBeGreaterThan(-1);
      expect(reviewerIdx).toBeGreaterThan(-1);
    });

    it("omits top_detail line when detail is empty", () => {
      const summaries: AgentPatternRiskSummary[] = [
        {
          agent_id: "some-agent",
          latest_risk_score: 0.6,
          mean_risk_score: 0.6,
          pattern_types: ["repeated_failure"],
          top_detail: "",
          signal_count: 1,
        },
      ];
      const consumer = new PatternRiskConsumer(makeStore(summaries));
      const ctx = consumer.buildRiskContext();
      // Should not contain the "→" detail bullet when detail is empty
      expect(ctx).not.toContain("→");
    });

    it("respects custom windowHours parameter", () => {
      const store = makeStore([]);
      const consumer = new PatternRiskConsumer(store);
      consumer.buildRiskContext(72);
      expect(store.getAgentPatternRiskSummaries).toHaveBeenCalledWith(72);
    });
  });

  describe("getSummaries()", () => {
    it("returns empty array when store throws (graceful degradation)", () => {
      const store: IPatternRiskStore = {
        getRecentPatternRiskSignals: vi.fn(),
        getAgentPatternRiskSummaries: vi.fn(() => {
          throw new Error("no such table: pattern_risk");
        }),
      };
      const consumer = new PatternRiskConsumer(store);
      expect(consumer.getSummaries()).toEqual([]);
    });

    it("forwards windowHours to store", () => {
      const store = makeStore([]);
      const consumer = new PatternRiskConsumer(store);
      consumer.getSummaries(24);
      expect(store.getAgentPatternRiskSummaries).toHaveBeenCalledWith(24);
    });
  });
});
