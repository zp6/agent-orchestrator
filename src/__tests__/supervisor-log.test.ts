import { describe, it, expect } from "vitest";
import { querySupervisorLog, formatSupervisorLogForCLI } from "../supervisor-log.js";
import type { IStateStore, SupervisorDecisionRecord, SupervisorDecisionQuery } from "../state/types.js";

// Minimal stub implementing only the IStateStore methods we touch
function makeStore(decisions: SupervisorDecisionRecord[]): IStateStore {
  return {
    querySupervisorDecisions: (_opts: SupervisorDecisionQuery) => decisions,
    // Unused stubs to satisfy interface
    getTask: () => null,
    updateTask: () => {},
    hasActiveTask: () => false,
    listTasks: () => [],
    getRecentCompleted: () => [],
    getUnverified: () => [],
    getAgentStats: () => [],
    getRecentSupervisorDecisions: () => [],
    pruneOldSupervisorDecisions: () => 0,
    queuePRForMerge: () => ({ repo: "", pr_number: 0, branch: "", status: "queued", position: 0, created_at: "" }),
    getMergeQueue: () => [],
    isPRInMergeQueue: () => false,
    markQueuedPRMerging: () => {},
    markQueuedPRMerged: () => {},
    markQueuedPRFailed: () => {},
    removeFromMergeQueue: () => {},
    recordPRReview: () => {},
  } as unknown as IStateStore;
}

const SAMPLE_DECISIONS: SupervisorDecisionRecord[] = [
  {
    id: "01ABC",
    action: "dispatch",
    agent_name: "claude-proxy",
    task_id: null,
    issue_ref: "#42",
    reason: "Agent is idle and issue #42 is unblocked.",
    message: "Implement issue #42 from rapartlu/claude-proxy.",
    outcome: "dispatched",
    created_at: "2026-04-05T14:32:00.000Z",
  },
  {
    id: "01DEF",
    action: "none",
    agent_name: null,
    task_id: null,
    issue_ref: null,
    reason: "All agents busy — no action needed.",
    message: null,
    outcome: "pending",
    created_at: "2026-04-05T14:02:00.000Z",
  },
];

describe("querySupervisorLog", () => {
  it("delegates to store.querySupervisorDecisions and returns results", () => {
    const store = makeStore(SAMPLE_DECISIONS);
    const result = querySupervisorLog(store, { limit: 10 });
    expect(result).toHaveLength(2);
    expect(result[0].action).toBe("dispatch");
  });

  it("returns empty array when store has no decisions", () => {
    const store = makeStore([]);
    const result = querySupervisorLog(store);
    expect(result).toHaveLength(0);
  });
});

describe("formatSupervisorLogForCLI", () => {
  it("returns a placeholder message for empty input", () => {
    const out = formatSupervisorLogForCLI([]);
    expect(out).toBe("No supervisor decisions recorded yet.");
  });

  it("includes timestamp, action, agent and issue ref", () => {
    const out = formatSupervisorLogForCLI(SAMPLE_DECISIONS);
    expect(out).toContain("2026-04-05 14:32");
    expect(out).toContain("dispatch");
    expect(out).toContain("claude-proxy");
    expect(out).toContain("#42");
  });

  it("includes reason and outcome for each decision", () => {
    const out = formatSupervisorLogForCLI(SAMPLE_DECISIONS);
    expect(out).toContain("Agent is idle and issue #42 is unblocked.");
    expect(out).toContain("dispatched");
  });

  it("includes message when present", () => {
    const out = formatSupervisorLogForCLI(SAMPLE_DECISIONS);
    expect(out).toContain("Implement issue #42");
  });

  it("handles decisions without agent_name or issue_ref gracefully", () => {
    const out = formatSupervisorLogForCLI([SAMPLE_DECISIONS[1]]);
    expect(out).toContain("none");
    expect(out).toContain("All agents busy");
  });
});
