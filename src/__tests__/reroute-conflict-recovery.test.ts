import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  buildRoutingDecisions,
  classifyRoutingDecisionCategory,
  formatDecisionsForTelegram,
} from "../supervisor-log.js";
import {
  ConflictRecoveryAlertMonitor,
  formatConflictRecoveryAlert,
  getReroutesApiPayload,
} from "../reviewer/reroute-conflict-recovery.js";
import type { Notifier } from "../notify.js";
import type { SupervisorDecisionRecord } from "../state/types.js";

type RawDb = {
  db: {
    prepare: (sql: string) => {
      run: (...args: unknown[]) => void;
    };
  };
};

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function seedDecision(
  store: StateStore,
  id: string,
  opts: {
    action?: string;
    agent_name?: string;
    issue_ref?: string | null;
    reason: string;
    message?: string | null;
    created_at?: string;
    outcome?: string;
  },
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO routing_decisions (
      id, action, agent_name, task_id, reason, outcome, created_at, message, issue_ref, rationale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    id,
    opts.action ?? "dispatch",
    opts.agent_name ?? null,
    null,
    opts.reason,
    opts.outcome ?? "dispatched",
    opts.created_at ?? new Date().toISOString(),
    opts.message ?? null,
    opts.issue_ref ?? null,
    null,
  );
}

function makeNotifier(): Notifier {
  return {
    isConfigured: () => true,
    send: vi.fn().mockResolvedValue(undefined),
    escalation: vi.fn().mockResolvedValue(undefined),
    taskRejected: vi.fn().mockResolvedValue(undefined),
    notifyOperator: vi.fn().mockResolvedValue(true),
    supervisorDecision: vi.fn().mockResolvedValue(undefined),
    healthRecovery: vi.fn().mockResolvedValue(undefined),
  };
}

describe("routing decision category classification", () => {
  it("classifies conflict recovery dispatches", () => {
    expect(
      classifyRoutingDecisionCategory({
        id: "1",
        action: "dispatch",
        agent_name: "agent-a",
        task_id: null,
        issue_ref: "owner/repo#42",
        reason: "Dispatch [conflict recovery] after auto-rebase failed",
        outcome: "dispatched",
        created_at: new Date().toISOString(),
      }),
    ).toBe("conflict-re-dispatch");
  });

  it("filters the reroute timeline by category", () => {
    const decisions: SupervisorDecisionRecord[] = [
      {
        id: "1",
        action: "dispatch",
        agent_name: "agent-a",
        task_id: null,
        issue_ref: "owner/repo#42",
        reason: "Dispatch [conflict recovery] after auto-rebase failed",
        outcome: "dispatched",
        created_at: isoHoursAgo(3),
      },
      {
        id: "2",
        action: "dispatch",
        agent_name: "agent-b",
        task_id: null,
        issue_ref: "owner/repo#43",
        reason: "Dispatch after request changes",
        outcome: "dispatched",
        created_at: isoHoursAgo(2),
      },
    ];

    const entries = buildRoutingDecisions(decisions, 10, { category: "conflict-re-dispatch" });

    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("conflict-re-dispatch");
    expect(formatDecisionsForTelegram(entries)).toContain("conflict re-dispatch");
  });
});

describe("getReroutesApiPayload", () => {
  it("includes conflict recovery rates per agent and per repo", () => {
    const store = new StateStore(":memory:");
    seedDecision(store, "d1", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-a#10",
      reason: "Dispatch [conflict recovery] after auto-rebase failed",
      created_at: isoHoursAgo(4),
    });
    seedDecision(store, "d2", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-a#11",
      reason: "Normal dispatch for follow-up work",
      created_at: isoHoursAgo(3),
    });
    seedDecision(store, "d3", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-b#12",
      reason: "Normal dispatch for follow-up work",
      created_at: isoHoursAgo(2),
    });
    seedDecision(store, "d4", {
      agent_name: "agent-b",
      issue_ref: "owner/repo-b#13",
      reason: "Dispatch after request changes",
      created_at: isoHoursAgo(1),
    });

    const payload = getReroutesApiPayload(store, { hours: 24, limit: 10, category: "all" });

    const agentA = payload.per_agent_conflict_recovery.find((row) => row.agent_name === "agent-a")!;
    expect(agentA.total_dispatches).toBe(3);
    expect(agentA.conflict_recovered).toBe(1);
    expect(agentA.conflict_recovery_rate).toBeCloseTo(1 / 3, 5);
    expect(agentA.exceeds_threshold).toBe(true);

    const repoA = payload.per_repo_conflict_recovery.find((row) => row.repo === "owner/repo-a")!;
    expect(repoA.total_dispatches).toBe(2);
    expect(repoA.conflict_recovered).toBe(1);
    expect(repoA.conflict_recovery_rate).toBeCloseTo(0.5, 5);

    const conflictOnly = getReroutesApiPayload(store, {
      hours: 24,
      limit: 10,
      category: "conflict-re-dispatch",
    });
    expect(conflictOnly.timeline).toHaveLength(1);
    expect(conflictOnly.timeline[0].category).toBe("conflict-re-dispatch");
  });
});

describe("ConflictRecoveryAlertMonitor", () => {
  it("sends a Telegram alert when an agent exceeds the threshold and dedups repeats", async () => {
    const store = new StateStore(":memory:");
    seedDecision(store, "d1", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-a#10",
      reason: "Dispatch [conflict recovery] after auto-rebase failed",
      created_at: isoHoursAgo(4),
    });
    seedDecision(store, "d2", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-a#11",
      reason: "Normal dispatch for follow-up work",
      created_at: isoHoursAgo(3),
    });
    seedDecision(store, "d3", {
      agent_name: "agent-a",
      issue_ref: "owner/repo-b#12",
      reason: "Normal dispatch for follow-up work",
      created_at: isoHoursAgo(2),
    });

    const notifier = makeNotifier();
    const monitor = new ConflictRecoveryAlertMonitor(store, notifier, {
      hours: 24,
      threshold: 0.2,
      cooldownMs: 24 * 60 * 60 * 1000,
    });

    const now = Date.now();
    const first = await monitor.checkAndAlert(now);
    const second = await monitor.checkAndAlert(now + 60 * 60 * 1000);

    // #564 noise suppression: alert is logged but not dispatched to Telegram.
    // Return values still signal first=processed, second=deduplicated.
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("returns a structured preview for manual formatting", () => {
    const message = formatConflictRecoveryAlert({
      generated_at: "2026-04-16T16:00:00.000Z",
      hours: 24,
      threshold: 0.2,
      agents: [
        {
          agent_name: "agent-a",
          total_dispatches: 3,
          conflict_recovered: 1,
          conflict_recovery_rate: 1 / 3,
          exceeds_threshold: true,
          top_repo: {
            repo: "owner/repo-a",
            total_dispatches: 2,
            conflict_recovered: 1,
            conflict_recovery_rate: 0.5,
            exceeds_threshold: true,
          },
        },
      ],
    });

    expect(message).toContain("High conflict recovery rate");
    expect(message).toContain("last 24h");
    expect(message).toContain("agent-a");
    expect(message).toContain("owner/repo-a");
  });
});
