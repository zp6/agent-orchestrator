import { describe, expect, it } from "vitest";
import { Supervisor, extractTaskRef } from "../reviewer/supervisor.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore } from "../state/types.js";

const config: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp",
  agents: {
    "claude-orchestrator-reviewer": {
      description: "Reviewer agent",
      dir: "reviewer",
      github: "rapartlu/agent-reviewer",
    },
  },
};

function makeStore(): IStateStore {
  return {
    getTask: () => null,
    updateTask: () => undefined,
    hasActiveTask: () => false,
    listTasks: () => [],
    getRecentCompleted: () => [],
    getUnverified: () => [],
    getAgentStats: () => [],
    getAgentHealthBatch: () => [],
    getRecentSupervisorDecisions: () => [],
    querySupervisorDecisions: () => [],
    pruneOldSupervisorDecisions: () => 0,
    queuePRForMerge: () => ({ repo: "x", pr_number: 1, branch: "main", status: "queued", position: 0 }),
    getMergeQueue: () => [],
    isPRInMergeQueue: () => false,
    markQueuedPRMerging: () => undefined,
    markQueuedPRMerged: () => undefined,
    markQueuedPRFailed: () => undefined,
    removeFromMergeQueue: () => undefined,
    recordPRReview: () => undefined,
  };
}

describe("extractTaskRef", () => {
  it("extracts task ids from bracketed task references", () => {
    expect(extractTaskRef("Please verify [task:01KNJDAK]")).toBe("01KNJDAK");
  });

  it("extracts task ids from free text task id references", () => {
    expect(extractTaskRef("verify task id: 01KNJF3N because it is pending")).toBe("01KNJF3N");
  });
});

describe("Supervisor decision validation", () => {
  it("keeps verify decisions with explicit taskId", () => {
    const supervisor = new Supervisor(config, makeStore());
    const decisions = (supervisor as any).filterVagueDispatches([
      { action: "verify", taskId: "01KNJDAK", reason: "Unverified task remains pending" },
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].taskId).toBe("01KNJDAK");
  });

  it("hydrates missing verify taskId from free text", () => {
    const supervisor = new Supervisor(config, makeStore());
    const decisions = (supervisor as any).filterVagueDispatches([
      {
        action: "verify",
        message: "Please verify [task:01KNJF3N]",
        reason: "Task 01KNJF3N is done but still unverified",
      },
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].taskId).toBe("01KNJF3N");
  });

  it("drops verify decisions without a task target", () => {
    const supervisor = new Supervisor(config, makeStore());
    const decisions = (supervisor as any).filterVagueDispatches([
      { action: "verify", reason: "A recent task should be checked" },
    ]);
    expect(decisions).toEqual([]);
  });

  it("drops create-issue decisions that lack an agent target", () => {
    const supervisor = new Supervisor(config, makeStore());
    const decisions = (supervisor as any).filterVagueDispatches([
      { action: "create-issue", message: "Open an issue for the repeated auth failure", reason: "Persistent failures" },
    ]);
    expect(decisions).toEqual([]);
  });
});
