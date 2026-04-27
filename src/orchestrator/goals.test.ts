/**
 * Tests for the goals metric evaluator — specifically the meetings_facilitated
 * metric which reads from meeting_outcome signals rather than the meetings table.
 *
 * Prior to issue #1197, meetings_facilitated read from store.getMeetings() which
 * only contains standup/bluesky runs. Facilitated meetings are tracked via
 * meeting_outcome signals written by the facilitator-agent, so the count was
 * permanently stuck at 0.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import { measureGoalProgress } from "./goals.js";
import type { GoalsConfig } from "./goals.js";

// Minimal goals config with one goal using the meetings_facilitated metric
function makeMeetingGoalsConfig(target: number): GoalsConfig {
  return {
    month: "2026-05",
    goals: [
      {
        id: "meeting-runs",
        title: "Run facilitated meetings",
        target: `${target} meetings per period`,
        owner: "meeting-facilitator-agent",
        key_results: [
          {
            description: "Meetings facilitated by the fleet",
            metric: `meetings_facilitated >= ${target}`,
          },
        ],
      },
    ],
  };
}

describe("meetings_facilitated metric", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns 0 when there are no meeting_outcome signals", () => {
    const goals = makeMeetingGoalsConfig(3);
    const progress = measureGoalProgress(goals, store);

    expect(progress).toHaveLength(1);
    expect(progress[0].completedKRs).toBe(0);
    // evaluateMetric returns 0/3 = 0 — KR not complete
    const kr = progress[0].keyResults[0];
    expect(kr.complete).toBe(false);
    expect(kr.value).toBe(0); // 0 meetings / 3 target = 0
  });

  it("counts meeting_outcome signals with decision=proceed", () => {
    // Write 2 proceed outcomes
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-1-meeting-facilitator-agent",
      value: { decision: "proceed", format: "rfc", topic: "Adopt JWT auth" },
      confidence: 0.9,
      ttl_hours: 168,
    });
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-2-meeting-facilitator-agent",
      value: { decision: "proceed", format: "retrospective", topic: "Q1 retrospective" },
      confidence: 0.9,
      ttl_hours: 168,
    });

    // Target = 2; raw count = 2; fraction = 2/2 = 1.0 → KR complete
    const goals = makeMeetingGoalsConfig(2);
    const progress = measureGoalProgress(goals, store);

    const kr = progress[0].keyResults[0];
    expect(kr.value).toBe(1.0); // fraction: 2 meets / 2 target
    expect(kr.complete).toBe(true);
    expect(progress[0].completedKRs).toBe(1);
    expect(progress[0].progressPct).toBe(100);
  });

  it("does not count meeting_outcome signals with decision=skip", () => {
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-skip-1",
      value: { decision: "skip", reason: "Similar meeting ran 3 days ago" },
      confidence: 0.9,
      ttl_hours: 168,
    });
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-skip-2",
      value: { decision: "skip", reason: "Weekly cap reached" },
      confidence: 0.9,
      ttl_hours: 168,
    });

    // Target = 1; raw count = 0 (skips don't count); fraction = 0/1 = 0
    const goals = makeMeetingGoalsConfig(1);
    const progress = measureGoalProgress(goals, store);

    const kr = progress[0].keyResults[0];
    expect(kr.value).toBe(0);
    expect(kr.complete).toBe(false);
  });

  it("partial progress: 1 of 3 meetings run, KR not yet complete", () => {
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-partial-1",
      value: { decision: "proceed", format: "triage", topic: "Backlog triage" },
      confidence: 0.9,
      ttl_hours: 168,
    });

    // Target = 3; raw count = 1; fraction = 1/3 ≈ 0.33 — below 1.0 → not complete
    const goals = makeMeetingGoalsConfig(3);
    const progress = measureGoalProgress(goals, store);

    const kr = progress[0].keyResults[0];
    expect(kr.value).toBeCloseTo(1 / 3); // fraction toward target
    expect(kr.complete).toBe(false);
    expect(progress[0].progressPct).toBe(0); // no KRs complete yet
  });

  it("ignores non-meeting_outcome signals in the store", () => {
    // Write a meeting_request signal (not an outcome)
    store.writeSignal({
      agent: "claude-agent-orchestrator",
      signal_type: "meeting_request",
      key: "meeting-request-pending",
      value: { topic: "API design review", urgency: "normal" },
      confidence: 0.8,
      ttl_hours: 168,
    });
    // Write a pattern_risk signal
    store.writeSignal({
      agent: "claude-orchestrator-reviewer",
      signal_type: "pattern_risk",
      key: "risk-1",
      value: { pattern: "high churn in proxy", score: 0.7 },
      confidence: 0.7,
      ttl_hours: 24,
    });

    // Target = 1; raw count = 0 (wrong signal types); fraction = 0
    const goals = makeMeetingGoalsConfig(1);
    const progress = measureGoalProgress(goals, store);

    const kr = progress[0].keyResults[0];
    expect(kr.value).toBe(0);
    expect(kr.complete).toBe(false);
  });

  it("handles malformed meeting_outcome signal values gracefully", () => {
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-malformed",
      value: "not valid json — just a string",
      confidence: 0.5,
      ttl_hours: 168,
    });
    store.writeSignal({
      agent: "meeting-facilitator-agent",
      signal_type: "meeting_outcome",
      key: "meeting-request-valid",
      value: { decision: "proceed", format: "triage", topic: "Valid meeting" },
      confidence: 0.9,
      ttl_hours: 168,
    });

    // Target = 1; 1 valid proceed + 1 malformed (skipped) = 1; fraction = 1/1 = 1.0
    const goals = makeMeetingGoalsConfig(1);
    const progress = measureGoalProgress(goals, store);

    const kr = progress[0].keyResults[0];
    expect(kr.value).toBe(1.0);
    expect(kr.complete).toBe(true);
  });
});
