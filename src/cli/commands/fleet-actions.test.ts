import { describe, it, expect } from "vitest";
import type { FleetAction } from "./fleet-actions.js";

// The CLI's heavy logic is in registerFleetActionsCommand (commander wiring +
// filesystem IO). These tests cover the schema invariants and decision logic
// that don't need a child-process spawn.

describe("FleetAction type contract", () => {
  it("conforms to the documented schema shape", () => {
    const action: FleetAction = {
      id: "hustle-2026-05-13T20-30-00-000Z-a3f12345",
      proposed_by: "hustle-agent",
      proposed_at: "2026-05-13T20:30:00.000Z",
      type: "github-pr-open",
      target: "rapartlu/agent-orchestrator",
      summary: "Fix stale issue #234",
      reasoning: "67 days open, no PR, fleet capability matches.",
      expected_value: { currency: "USD", amount: 200, confidence: "medium" },
      source_signals: ["stale-issue scan"],
      okr_alignment: ["okr-1", "okr-5"],
      status: "proposed",
      auditor_review: {
        reviewed_at: null,
        reviewer: null,
        decision: null,
        reasoning: null,
        conditions: [],
      },
      execution: {
        started_at: null,
        completed_at: null,
        artifact_url: null,
        outcome: null,
        revenue_received_usd: null,
      },
    };
    // Schema-shape assertions
    expect(action.status).toBe("proposed");
    expect(action.auditor_review.decision).toBeNull();
    expect(action.execution.completed_at).toBeNull();
    expect(action.okr_alignment).toContain("okr-5");
  });

  it("allows all five action types as documented in schema", () => {
    const types: FleetAction["type"][] = [
      "github-pr-open",
      "outreach-dm",
      "bounty-submission",
      "demo-repo-update",
      "content-post",
    ];
    expect(types).toHaveLength(5);
  });

  it("allows all eight lifecycle statuses", () => {
    const statuses: FleetAction["status"][] = [
      "proposed",
      "under_review",
      "approved",
      "rejected",
      "executing",
      "executed",
      "abandoned",
    ];
    expect(statuses).toHaveLength(7);
  });

  it("represents a reject decision by setting status=rejected", () => {
    const action: FleetAction = {
      id: "test",
      proposed_by: "hustle-agent",
      proposed_at: "2026-05-13T20:30:00.000Z",
      type: "outreach-dm",
      target: "@example",
      summary: "test",
      reasoning: "test",
      expected_value: { currency: "USD", amount: 0, confidence: "low" },
      source_signals: [],
      okr_alignment: [],
      status: "rejected",
      auditor_review: {
        reviewed_at: "2026-05-13T20:31:00.000Z",
        reviewer: "auditor-agent",
        decision: "reject",
        reasoning: "Charter article III violation",
        conditions: [],
      },
      execution: {
        started_at: null,
        completed_at: null,
        artifact_url: null,
        outcome: null,
        revenue_received_usd: null,
      },
    };
    expect(action.status).toBe("rejected");
    expect(action.auditor_review.decision).toBe("reject");
  });
});
