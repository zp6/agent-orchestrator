import { describe, it, expect } from "vitest";
import { HealthRecoveryTracker } from "../health-recovery.js";
import type { HealthRecoveryObservation } from "../health-recovery.js";

function makeHealth(
  agentName: string,
  overrides: Partial<HealthRecoveryObservation> = {},
): HealthRecoveryObservation {
  return {
    agent_name: agentName,
    consecutive_failures: 0,
    last_error_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("HealthRecoveryTracker", () => {
  it("emits a recovery event after three consecutive healthy observations", () => {
    const tracker = new HealthRecoveryTracker(3);
    const start = Date.parse("2026-04-07T10:00:00.000Z");

    expect(
      tracker.observe(
        makeHealth("claude-orchestrator-telegram", {
          consecutive_failures: 2,
          last_error_at: "2026-04-07T10:00:00.000Z",
        }),
        start,
      ),
    ).toBeNull();

    expect(
      tracker.observe(makeHealth("claude-orchestrator-telegram"), start + 60_000),
    ).toBeNull();
    expect(
      tracker.observe(makeHealth("claude-orchestrator-telegram"), start + 120_000),
    ).toBeNull();

    const event = tracker.observe(makeHealth("claude-orchestrator-telegram"), start + 180_000);
    expect(event).not.toBeNull();
    expect(event?.agentName).toBe("claude-orchestrator-telegram");
    expect(event?.degradedForMs).toBe(180_000);
    expect(event?.confirmationCycles).toBe(3);
  });

  it("does not emit twice for the same incident", () => {
    const tracker = new HealthRecoveryTracker(3);
    const start = Date.parse("2026-04-07T10:00:00.000Z");

    tracker.observe(
      makeHealth("claude-proxy", {
        consecutive_failures: 1,
        last_error_at: "2026-04-07T10:00:00.000Z",
      }),
      start,
    );
    tracker.observe(makeHealth("claude-proxy"), start + 60_000);
    tracker.observe(makeHealth("claude-proxy"), start + 120_000);
    const first = tracker.observe(makeHealth("claude-proxy"), start + 180_000);
    const second = tracker.observe(makeHealth("claude-proxy"), start + 240_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("resets the confirmation streak when health oscillates", () => {
    const tracker = new HealthRecoveryTracker(3);
    const start = Date.parse("2026-04-07T10:00:00.000Z");

    tracker.observe(
      makeHealth("claude-reviewer", {
        consecutive_failures: 1,
        last_error_at: "2026-04-07T10:00:00.000Z",
      }),
      start,
    );
    tracker.observe(makeHealth("claude-reviewer"), start + 60_000);
    tracker.observe(
      makeHealth("claude-reviewer", {
        consecutive_failures: 1,
        last_error_at: "2026-04-07T10:02:00.000Z",
      }),
      start + 120_000,
    );
    expect(tracker.observe(makeHealth("claude-reviewer"), start + 180_000)).toBeNull();
    expect(tracker.observe(makeHealth("claude-reviewer"), start + 240_000)).toBeNull();

    const event = tracker.observe(makeHealth("claude-reviewer"), start + 300_000);
    expect(event).not.toBeNull();
    expect(event?.degradedForMs).toBe(300_000);
  });
});
