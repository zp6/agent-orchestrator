/**
 * Tests for the cross-agent in-flight duplicate dispatch guard (issue #336).
 *
 * Verifies that:
 *   (1) pre-dispatch guard returns 'already-in-flight' when another agent
 *       has an active task for the same issue
 *   (2) same-agent in-flight tasks are NOT treated as conflicts
 *   (3) Telegram alert is sent when conflict detected
 *   (4) guard is fail-open on store errors
 *   (5) DuplicateDispatchSurgeDetector tracks cross-agent events separately
 *   (6) getMultiAgentCollisionCount returns correct counts from store
 *   (7) quality-system-health payload includes multi_agent_collisions metric
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CrossAgentInflightGuard,
  IN_FLIGHT_STATUSES,
  extractIssueNumberFromInflightRef,
} from "../reviewer/cross-agent-inflight-guard.js";
import { DuplicateDispatchSurgeDetector } from "../reviewer/duplicate-dispatch-surge-detector.js";
import type { IStateStore, Task } from "../state/types.js";
import type { Notifier } from "../notify.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: "Test task",
    status: "in_progress",
    task_type: "implementation",
    agent_name: "claude-agent-orchestrator",
    source_ref: "owner/repo#42",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStore(inFlightTasks: Task[] = [], collisionCount = 0): IStateStore {
  return {
    getInFlightTasksForIssue: vi.fn().mockReturnValue(inFlightTasks),
    getMultiAgentCollisionCount: vi.fn().mockReturnValue(collisionCount),
    // Stub remaining IStateStore methods to satisfy the interface
    getTask: vi.fn(),
    updateTask: vi.fn(),
    hasActiveTask: vi.fn(),
    listTasks: vi.fn().mockReturnValue([]),
    getChildTasks: vi.fn().mockReturnValue([]),
    getRecentCompleted: vi.fn().mockReturnValue([]),
    getUnverified: vi.fn().mockReturnValue([]),
    getApprovedTasksWithNullScores: vi.fn().mockReturnValue([]),
    getApprovedTasksWithNullScoresCount: vi.fn().mockReturnValue(0),
    getVerifiedTasksWithNullScores: vi.fn().mockReturnValue([]),
    getVerifiedTasksWithNullScoresCount: vi.fn().mockReturnValue(0),
    getDoneTasksWithNullScoreOlderThan: vi.fn().mockReturnValue([]),
    getScoreCoverage: vi.fn(),
    getAgentStats: vi.fn().mockReturnValue([]),
    getEfficiencyTrend: vi.fn(),
    getAgentQualityTrend: vi.fn(),
    getRoutingAccuracyStats: vi.fn().mockReturnValue([]),
    getAgentQualityByTaskType: vi.fn().mockReturnValue([]),
    getScoreDistributions: vi.fn().mockReturnValue([]),
    getCalibrationDriftAlerts: vi.fn().mockReturnValue([]),
    getQualityHealthReport: vi.fn(),
    getRecentVerifiedTasks: vi.fn().mockReturnValue([]),
    getAgentHealthBatch: vi.fn().mockReturnValue([]),
    getRecentSupervisorDecisions: vi.fn().mockReturnValue([]),
    querySupervisorDecisions: vi.fn().mockReturnValue([]),
    pruneOldSupervisorDecisions: vi.fn().mockReturnValue(0),
    recordSupervisorDecision: vi.fn(),
    queuePRForMerge: vi.fn(),
    getMergeQueue: vi.fn().mockReturnValue([]),
    isPRInMergeQueue: vi.fn().mockReturnValue(false),
    markQueuedPRMerging: vi.fn(),
    markQueuedPRMerged: vi.fn(),
    markQueuedPRFailed: vi.fn(),
    removeFromMergeQueue: vi.fn(),
    recordPRReview: vi.fn(),
    recordLlmCallEvent: vi.fn(),
    getTokenStats: vi.fn().mockReturnValue([]),
    getScoreCoverageMetric: vi.fn(),
    getDoneTasksWithNullScore: vi.fn().mockReturnValue([]),
    getTasksInOperatorReview: vi.fn().mockReturnValue([]),
    operatorOverride: vi.fn(),
    insertVerificationResult: vi.fn(),
    getLatestVerificationRecord: vi.fn(),
    getApprovedBelowThreshold: vi.fn().mockReturnValue([]),
    getAgentTrends: vi.fn().mockReturnValue([]),
    getIssueAgeRecords: vi.fn().mockReturnValue([]),
    createTask: vi.fn(),
  } as unknown as IStateStore;
}

function makeNotifier(): Notifier & { notifyOperatorCalls: { title: string; urgency: string }[] } {
  const calls: { title: string; urgency: string }[] = [];
  return {
    notifyOperatorCalls: calls,
    send: vi.fn().mockResolvedValue(undefined),
    escalation: vi.fn().mockResolvedValue(undefined),
    taskRejected: vi.fn().mockResolvedValue(undefined),
    notifyOperator: vi.fn().mockImplementation((title: string, _body: string, urgency: string) => {
      calls.push({ title, urgency });
      return Promise.resolve(true);
    }),
    supervisorDecision: vi.fn().mockResolvedValue(undefined),
    healthRecovery: vi.fn().mockResolvedValue(undefined),
    isConfigured: vi.fn().mockReturnValue(true),
  };
}

// ── Acceptance criterion (1): already-in-flight resolution ───────────────────

describe("CrossAgentInflightGuard — already-in-flight detection", () => {
  it("returns already-in-flight when another agent has an in-progress task for same issue", async () => {
    const conflictingTask = makeTask({
      agent_name: "claude-agent-orchestrator",
      source_ref: "owner/repo#42",
      status: "in_progress",
    });
    const store = makeStore([conflictingTask]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "claude-orchestrator-reviewer",
    });

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-flight");
    expect(result.conflicting_agent).toBe("claude-agent-orchestrator");
    expect(result.conflicting_task_id).toBe(conflictingTask.id);
  });

  it("returns already-in-flight for dispatched status (not just in_progress)", async () => {
    const task = makeTask({ agent_name: "claude-research-agent", status: "dispatched" });
    const store = makeStore([task]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#100",
      target_agent: "claude-orchestrator-reviewer",
    });

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-flight");
  });

  it("returns already-in-flight for pending status", async () => {
    const task = makeTask({ agent_name: "claude-proxy", status: "pending" });
    const store = makeStore([task]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({ source_ref: "owner/repo#200", target_agent: "other-agent" });

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-flight");
  });

  it("returns already-in-flight for planning status", async () => {
    const task = makeTask({ agent_name: "claude-agent-orchestrator", status: "planning" });
    const store = makeStore([task]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({ source_ref: "owner/repo#300", target_agent: "other-agent" });

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-flight");
  });

  it("returns no-conflict when no in-flight tasks exist for the issue", async () => {
    const store = makeStore([]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "claude-orchestrator-reviewer",
    });

    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("no-conflict");
  });

  it("returns no-conflict when no source_ref provided", async () => {
    const store = makeStore([]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "",
      target_agent: "claude-orchestrator-reviewer",
    });

    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("no-conflict");
  });

  it("includes all conflicting tasks in the result", async () => {
    const task1 = makeTask({ agent_name: "agent-a", status: "dispatched" });
    const task2 = makeTask({ agent_name: "agent-b", status: "in_progress" });
    const store = makeStore([task1, task2]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "agent-c",
    });

    expect(result.skip).toBe(true);
    expect(result.conflicting_tasks).toHaveLength(2);
    expect(result.conflicting_tasks?.map((t) => t.agent_name)).toContain("agent-a");
    expect(result.conflicting_tasks?.map((t) => t.agent_name)).toContain("agent-b");
  });
});

// ── Acceptance criterion (1): same-agent tasks are NOT conflicts ──────────────

describe("CrossAgentInflightGuard — same-agent tasks excluded", () => {
  it("ignores in-flight tasks owned by the target agent itself", async () => {
    // target_agent = "claude-orchestrator-reviewer", task also belongs to reviewer
    const ownTask = makeTask({
      agent_name: "claude-orchestrator-reviewer",
      status: "in_progress",
    });
    const store = makeStore([ownTask]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "claude-orchestrator-reviewer",
    });

    // Own task should not be counted as a cross-agent conflict
    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("no-conflict");
  });

  it("still detects conflict when mix of own and other-agent tasks exist", async () => {
    const ownTask = makeTask({
      agent_name: "claude-orchestrator-reviewer",
      status: "in_progress",
    });
    const otherTask = makeTask({
      agent_name: "claude-agent-orchestrator",
      status: "dispatched",
    });
    const store = makeStore([ownTask, otherTask]);
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "claude-orchestrator-reviewer",
    });

    expect(result.skip).toBe(true);
    expect(result.resolution).toBe("already-in-flight");
    expect(result.conflicting_agent).toBe("claude-agent-orchestrator");
  });
});

// ── Telegram alert ────────────────────────────────────────────────────────────

describe("CrossAgentInflightGuard — Telegram alert", () => {
  it("sends medium-urgency Telegram alert when conflict detected", async () => {
    const task = makeTask({ agent_name: "agent-a", status: "in_progress" });
    const store = makeStore([task]);
    const notifier = makeNotifier();
    const guard = new CrossAgentInflightGuard(store, notifier);

    await guard.check({
      source_ref: "owner/repo#42",
      target_agent: "agent-b",
    });

    expect(notifier.notifyOperatorCalls).toHaveLength(1);
    expect(notifier.notifyOperatorCalls[0]!.urgency).toBe("medium");
  });

  it("alert title contains 'collision' and the source_ref", async () => {
    const task = makeTask({ agent_name: "agent-x", status: "dispatched" });
    const store = makeStore([task]);
    const notifier = makeNotifier();
    const guard = new CrossAgentInflightGuard(store, notifier);

    await guard.check({ source_ref: "owner/repo#99", target_agent: "agent-y" });

    const { title } = notifier.notifyOperatorCalls[0]!;
    expect(title.toLowerCase()).toContain("collision");
    expect(title).toContain("owner/repo#99");
  });

  it("no Telegram alert when no conflict", async () => {
    const store = makeStore([]);
    const notifier = makeNotifier();
    const guard = new CrossAgentInflightGuard(store, notifier);

    await guard.check({ source_ref: "owner/repo#1", target_agent: "any-agent" });

    expect(notifier.notifyOperatorCalls).toHaveLength(0);
  });

  it("alert_sent is false when notifier not configured", async () => {
    const task = makeTask({ agent_name: "other", status: "in_progress" });
    const store = makeStore([task]);
    const unconfiguredNotifier = {
      ...makeNotifier(),
      isConfigured: vi.fn().mockReturnValue(false),
    };
    const guard = new CrossAgentInflightGuard(store, unconfiguredNotifier);

    const result = await guard.check({ source_ref: "owner/repo#1", target_agent: "me" });

    expect(result.alert_sent).toBe(false);
  });
});

// ── Fail-open behaviour ───────────────────────────────────────────────────────

describe("CrossAgentInflightGuard — fail-open on store errors", () => {
  it("returns check-failed with skip=false when store throws", async () => {
    const store = makeStore();
    (store.getInFlightTasksForIssue as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB connection lost");
    });
    const guard = new CrossAgentInflightGuard(store);

    const result = await guard.check({ source_ref: "owner/repo#1", target_agent: "some-agent" });

    expect(result.skip).toBe(false);
    expect(result.resolution).toBe("check-failed");
    expect(result.reason).toContain("DB connection lost");
  });
});

// ── Acceptance criterion (2): surge detector tracks cross-agent separately ────

describe("DuplicateDispatchSurgeDetector — cross-agent vs same-agent tracking", () => {
  it("getCrossAgentCollisionCount starts at 0", () => {
    const detector = new DuplicateDispatchSurgeDetector({
      telegramBotToken: "tok",
      telegramChatId: "cid",
    });
    expect(detector.getCrossAgentCollisionCount()).toBe(0);
  });

  it("cross-agent event increments getCrossAgentCollisionCount", async () => {
    const detector = new DuplicateDispatchSurgeDetector({
      telegramBotToken: "tok",
      telegramChatId: "cid",
    });
    // Stub sendTelegram to prevent network calls
    (detector as any).sendTelegram = vi.fn().mockResolvedValue(undefined);

    await detector.recordEvent({
      taskId: "t1",
      repo: "owner/repo",
      issueRef: "#42",
      timestamp: new Date(),
      isCrossAgent: true,
      agentName: "agent-b",
      conflictingAgent: "agent-a",
    });

    expect(detector.getCrossAgentCollisionCount()).toBe(1);
  });

  it("same-agent event does NOT increment getCrossAgentCollisionCount", async () => {
    const detector = new DuplicateDispatchSurgeDetector({
      telegramBotToken: "tok",
      telegramChatId: "cid",
    });
    (detector as any).sendTelegram = vi.fn().mockResolvedValue(undefined);

    // Same-agent event (isCrossAgent not set / undefined)
    await detector.recordEvent({
      taskId: "t1",
      repo: "owner/repo",
      issueRef: "#42",
      timestamp: new Date(),
    });

    expect(detector.getCrossAgentCollisionCount()).toBe(0);
  });

  it("multiple cross-agent events accumulate", async () => {
    const detector = new DuplicateDispatchSurgeDetector({
      telegramBotToken: "tok",
      telegramChatId: "cid",
    });
    (detector as any).sendTelegram = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      await detector.recordEvent({
        taskId: `t${i}`,
        repo: "owner/repo",
        issueRef: `#${100 + i}`,   // different issues to avoid cooldown
        timestamp: new Date(),
        isCrossAgent: true,
        agentName: "agent-b",
        conflictingAgent: "agent-a",
      });
    }

    expect(detector.getCrossAgentCollisionCount()).toBe(3);
  });

  it("getCrossAgentWindowEvents returns only cross-agent events within window", async () => {
    const detector = new DuplicateDispatchSurgeDetector({
      telegramBotToken: "tok",
      telegramChatId: "cid",
      windowMinutes: 30,
    });
    (detector as any).sendTelegram = vi.fn().mockResolvedValue(undefined);

    const now = new Date();
    const old = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago — outside 30-min window

    await detector.recordEvent({
      taskId: "recent-cross",
      repo: "r",
      issueRef: "#1",
      timestamp: now,
      isCrossAgent: true,
    });

    await detector.recordEvent({
      taskId: "old-cross",
      repo: "r",
      issueRef: "#2",
      timestamp: old,
      isCrossAgent: true,
    });

    await detector.recordEvent({
      taskId: "same-agent",
      repo: "r",
      issueRef: "#3",
      timestamp: now,
      isCrossAgent: false,
    });

    const windowEvents = detector.getCrossAgentWindowEvents(now);
    expect(windowEvents).toHaveLength(1);
    expect(windowEvents[0]!.taskId).toBe("recent-cross");
  });
});

// ── Acceptance criterion (3): dashboard multi_agent_collisions metric ─────────

describe("quality-system-health — multi_agent_collisions metric", () => {
  it("multi_agent_collisions is 0 when store returns 0", async () => {
    const { getQualitySystemHealthPayload } = await import(
      "../reviewer/quality-system-health.js"
    );

    const store = makeStore([], 0);
    const payload = getQualitySystemHealthPayload(store);

    expect(payload.multi_agent_collisions).toBe(0);
  });

  it("multi_agent_collisions reflects store.getMultiAgentCollisionCount()", async () => {
    const { getQualitySystemHealthPayload } = await import(
      "../reviewer/quality-system-health.js"
    );

    const store = makeStore([], 3);
    const payload = getQualitySystemHealthPayload(store);

    expect(payload.multi_agent_collisions).toBe(3);
    expect(store.getMultiAgentCollisionCount).toHaveBeenCalledWith(48);
  });

  it("multi_agent_collisions defaults to 0 when getMultiAgentCollisionCount throws", async () => {
    const { getQualitySystemHealthPayload } = await import(
      "../reviewer/quality-system-health.js"
    );

    const store = makeStore([], 0);
    (store.getMultiAgentCollisionCount as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("not implemented");
    });

    const payload = getQualitySystemHealthPayload(store);
    expect(payload.multi_agent_collisions).toBe(0);
  });
});

// ── Store: getMultiAgentCollisionCount ────────────────────────────────────────

describe("StateStore.getMultiAgentCollisionCount", () => {
  it("returns 0 when no tasks exist", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");
    expect(store.getMultiAgentCollisionCount(48)).toBe(0);
  });

  it("returns 0 when single agent worked on an issue", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();
    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
         VALUES ('t1', 'Task', 'done', 'agent-a', 'implementation', 'owner/repo#42', ?, ?)`,
      )
      .run(now, now);

    expect(store.getMultiAgentCollisionCount(48)).toBe(0);
  });

  it("returns 1 when two agents worked on the same issue within window", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
         VALUES (?, 'Task', 'in_progress', ?, 'implementation', 'owner/repo#42', ?, ?)`,
      )
      .run("t1", "agent-a", now, now);

    raw.db
      .prepare(
        `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
         VALUES (?, 'Task', 'dispatched', ?, 'implementation', 'owner/repo#42', ?, ?)`,
      )
      .run("t2", "agent-b", now, now);

    expect(store.getMultiAgentCollisionCount(48)).toBe(1);
  });

  it("counts multiple colliding issues independently", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    // Issue #42: collision between agent-a and agent-b
    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t1', 'Task', 'done', 'agent-a', 'implementation', 'owner/repo#42', ?, ?)`,
    ).run(now, now);
    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t2', 'Task', 'done', 'agent-b', 'implementation', 'owner/repo#42', ?, ?)`,
    ).run(now, now);

    // Issue #100: collision between agent-a and agent-c
    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t3', 'Task', 'done', 'agent-a', 'implementation', 'owner/repo#100', ?, ?)`,
    ).run(now, now);
    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t4', 'Task', 'done', 'agent-c', 'implementation', 'owner/repo#100', ?, ?)`,
    ).run(now, now);

    // Issue #200: only one agent — no collision
    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t5', 'Task', 'done', 'agent-a', 'implementation', 'owner/repo#200', ?, ?)`,
    ).run(now, now);

    expect(store.getMultiAgentCollisionCount(48)).toBe(2);
  });
});

// ── Store: getInFlightTasksForIssue ──────────────────────────────────────────

describe("StateStore.getInFlightTasksForIssue", () => {
  it("returns empty array when no tasks exist for source_ref", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");
    expect(store.getInFlightTasksForIssue("owner/repo#1")).toHaveLength(0);
  });

  it("returns in-flight tasks matching the source_ref", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t1', 'Task', 'in_progress', 'agent-a', 'implementation', 'owner/repo#42', ?, ?)`,
    ).run(now, now);

    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t2', 'Task', 'dispatched', 'agent-b', 'implementation', 'owner/repo#42', ?, ?)`,
    ).run(now, now);

    const result = store.getInFlightTasksForIssue("owner/repo#42");
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.id)).toContain("t1");
    expect(result.map((t) => t.id)).toContain("t2");
  });

  it("excludes done/failed/escalated tasks", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    for (const [id, status] of [
      ["t-done", "done"],
      ["t-failed", "failed"],
      ["t-escalated", "escalated"],
    ]) {
      raw.db.prepare(
        `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
         VALUES (?, 'Task', ?, 'agent-a', 'implementation', 'owner/repo#42', ?, ?)`,
      ).run(id, status, now, now);
    }

    const result = store.getInFlightTasksForIssue("owner/repo#42");
    expect(result).toHaveLength(0);
  });

  it("does not return tasks with a different source_ref", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    raw.db.prepare(
      `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
       VALUES ('t1', 'Task', 'in_progress', 'agent-a', 'implementation', 'owner/repo#99', ?, ?)`,
    ).run(now, now);

    expect(store.getInFlightTasksForIssue("owner/repo#42")).toHaveLength(0);
  });

  it("returns all four in-flight statuses", async () => {
    const { StateStore } = await import("../state/store.js");
    const store = new StateStore(":memory:");

    const raw = store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } };
    const now = new Date().toISOString();

    for (const [id, status] of [
      ["t-pending", "pending"],
      ["t-planning", "planning"],
      ["t-dispatched", "dispatched"],
      ["t-in-progress", "in_progress"],
    ]) {
      raw.db.prepare(
        `INSERT INTO tasks (id, title, status, agent_name, task_type, source_ref, created_at, updated_at)
         VALUES (?, 'Task', ?, 'agent-a', 'implementation', 'owner/repo#7', ?, ?)`,
      ).run(id, status, now, now);
    }

    const result = store.getInFlightTasksForIssue("owner/repo#7");
    expect(result).toHaveLength(4);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

describe("extractIssueNumberFromInflightRef", () => {
  it("extracts from owner/repo#123 format", () => {
    expect(extractIssueNumberFromInflightRef("owner/repo#123")).toBe(123);
  });

  it("extracts from github-issue:owner/repo#42 format", () => {
    expect(extractIssueNumberFromInflightRef("github-issue:owner/repo#42")).toBe(42);
  });

  it("extracts from #42 format", () => {
    expect(extractIssueNumberFromInflightRef("#42")).toBe(42);
  });

  it("extracts bare number", () => {
    expect(extractIssueNumberFromInflightRef("42")).toBe(42);
  });

  it("returns null for invalid formats", () => {
    expect(extractIssueNumberFromInflightRef("")).toBeNull();
    expect(extractIssueNumberFromInflightRef("owner/repo")).toBeNull();
  });
});

describe("IN_FLIGHT_STATUSES constant", () => {
  it("includes all four expected statuses", () => {
    expect(IN_FLIGHT_STATUSES).toContain("pending");
    expect(IN_FLIGHT_STATUSES).toContain("planning");
    expect(IN_FLIGHT_STATUSES).toContain("dispatched");
    expect(IN_FLIGHT_STATUSES).toContain("in_progress");
  });

  it("does not include terminal statuses", () => {
    for (const s of ["done", "failed", "escalated"]) {
      expect(IN_FLIGHT_STATUSES).not.toContain(s);
    }
  });
});
