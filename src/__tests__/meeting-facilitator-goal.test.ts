/**
 * Tests for the meeting-facilitator monthly goal widget (issue #411, #456).
 *
 * Covers:
 *  - StateStore.getMeetingFacilitatorGoalWidget() — goal structure, progress
 *    calculation, met flags, and overall_progress
 *  - getMeetingFacilitatorGoalPayload() — delegation and option forwarding
 *  - formatMeetingGoalForTelegram() — Telegram message formatting (issue #456)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import { getMeetingFacilitatorGoalPayload } from "../reviewer/meeting-facilitator-goal.js";
import { formatMeetingGoalForTelegram } from "../telegram/command-handler.js";
import type { MeetingFacilitatorGoalWidget } from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Raw DB access for fixture inserts (bypasses StateStore public API). */
type RawStore = {
  db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
};

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-mf-goal-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const raw = store as unknown as RawStore;

  let seq = 0;

  const insertTask = (opts: {
    agentName?: string;
    taskType?: string;
    status?: string;
    verificationStatus?: string | null;
    createdAt?: string;
  }) => {
    const id = `task-mf-${++seq}`;
    const now = new Date().toISOString();
    raw.db
      .prepare(
        `INSERT INTO tasks
           (id, title, status, agent_name, task_type, verification_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${id}`,
        opts.status ?? "done",
        opts.agentName ?? "claude-meeting-facilitator",
        opts.taskType ?? "housekeeping",
        opts.verificationStatus ?? null,
        opts.createdAt ?? now,
        now,
      );
    return id;
  };

  return {
    store,
    insertTask,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** ISO timestamp for the first day of the current UTC month. */
function currentMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** ISO timestamp for a date N months ago (for out-of-window inserts). */
function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString();
}

// ── StateStore.getMeetingFacilitatorGoalWidget ─────────────────────────────

describe("StateStore.getMeetingFacilitatorGoalWidget", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("returns null-state widget when no tasks exist", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const widget = store.getMeetingFacilitatorGoalWidget();

    expect(widget.all_goals_met).toBe(false);
    expect(widget.overall_progress).toBe(0);
    expect(widget.goals).toHaveLength(2);

    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;
    expect(meetings.current).toBe(0);
    expect(meetings.met).toBe(false);
    expect(meetings.progress).toBe(0);

    const core = widget.goals.find((g) => g.key === "core_logic_shipped")!;
    expect(core.current).toBe(0);
    expect(core.met).toBe(false);
    expect(core.progress).toBe(0);
  });

  it("month_start is the first day of the current UTC month", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const widget = store.getMeetingFacilitatorGoalWidget();
    expect(widget.month_start).toBe(currentMonthStart());
  });

  it("generated_at is a valid ISO-8601 timestamp", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const widget = store.getMeetingFacilitatorGoalWidget();
    expect(() => new Date(widget.generated_at)).not.toThrow();
    expect(widget.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts done tasks in current month toward meetings_facilitated", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({ status: "done" });
    insertTask({ status: "done" });
    insertTask({ status: "in_progress" }); // excluded: not done

    const widget = store.getMeetingFacilitatorGoalWidget();
    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;

    expect(meetings.current).toBe(2);
    expect(meetings.progress).toBeCloseTo(2 / 5);
    expect(meetings.met).toBe(false);
  });

  it("meetings_facilitated goal met when count reaches 5", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    for (let i = 0; i < 5; i++) {
      insertTask({ status: "done" });
    }

    const widget = store.getMeetingFacilitatorGoalWidget();
    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;

    expect(meetings.current).toBe(5);
    expect(meetings.progress).toBe(1);
    expect(meetings.met).toBe(true);
  });

  it("progress is capped at 1 when count exceeds target", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    for (let i = 0; i < 8; i++) {
      insertTask({ status: "done" });
    }

    const widget = store.getMeetingFacilitatorGoalWidget();
    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;

    expect(meetings.progress).toBe(1);
    expect(meetings.met).toBe(true);
  });

  it("excludes tasks from previous months from meetings_facilitated", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // 3 tasks in current month
    for (let i = 0; i < 3; i++) {
      insertTask({ status: "done" });
    }
    // 5 tasks from last month — should not count
    for (let i = 0; i < 5; i++) {
      insertTask({ status: "done", createdAt: monthsAgo(1) });
    }

    const widget = store.getMeetingFacilitatorGoalWidget();
    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;

    expect(meetings.current).toBe(3);
  });

  it("core_logic_shipped detects approved implementation tasks", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({
      taskType: "implementation",
      status: "done",
      verificationStatus: "approved",
    });

    const widget = store.getMeetingFacilitatorGoalWidget();
    const core = widget.goals.find((g) => g.key === "core_logic_shipped")!;

    expect(core.current).toBe(1);
    expect(core.met).toBe(true);
    expect(core.progress).toBe(1);
  });

  it("core_logic_shipped not met when implementation task is not approved", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    insertTask({
      taskType: "implementation",
      status: "done",
      verificationStatus: "needs_revision",
    });

    const widget = store.getMeetingFacilitatorGoalWidget();
    const core = widget.goals.find((g) => g.key === "core_logic_shipped")!;

    expect(core.current).toBe(0);
    expect(core.met).toBe(false);
  });

  it("core_logic_shipped matches across all months (not limited to current month)", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Approved implementation task from 2 months ago — should still count
    insertTask({
      taskType: "implementation",
      status: "done",
      verificationStatus: "approved",
      createdAt: monthsAgo(2),
    });

    const widget = store.getMeetingFacilitatorGoalWidget();
    const core = widget.goals.find((g) => g.key === "core_logic_shipped")!;

    expect(core.met).toBe(true);
  });

  it("all_goals_met only true when both goals are met", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Only meetings goal met (5 done tasks), no core logic
    for (let i = 0; i < 5; i++) {
      insertTask({ status: "done" });
    }

    const widget = store.getMeetingFacilitatorGoalWidget();
    expect(widget.all_goals_met).toBe(false);
  });

  it("all_goals_met is true when both goals are satisfied", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Core logic shipped
    insertTask({
      taskType: "implementation",
      status: "done",
      verificationStatus: "approved",
    });
    // 5 meetings facilitated
    for (let i = 0; i < 5; i++) {
      insertTask({ status: "done" });
    }

    const widget = store.getMeetingFacilitatorGoalWidget();
    expect(widget.all_goals_met).toBe(true);
  });

  it("overall_progress is average of individual goal progresses", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Core logic: met (progress 1.0).
    // The implementation task is also 'done', so it counts as 1 meeting too.
    insertTask({
      taskType: "implementation",
      status: "done",
      verificationStatus: "approved",
    });
    // core_logic: 1/1 = 1.0, meetings: 1/5 = 0.2 → overall = (1.0 + 0.2) / 2 = 0.6
    const widget = store.getMeetingFacilitatorGoalWidget();
    expect(widget.overall_progress).toBeCloseTo(0.6);
  });

  it("ignores tasks for other agents", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Tasks for a different agent
    insertTask({ agentName: "claude-implementer", status: "done" });
    insertTask({ agentName: "claude-implementer", status: "done" });

    const widget = store.getMeetingFacilitatorGoalWidget();
    const meetings = widget.goals.find((g) => g.key === "meetings_facilitated")!;

    expect(meetings.current).toBe(0);
  });

  it("respects custom agentNamePattern override", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    // Insert tasks for a different pattern
    insertTask({ agentName: "custom-facilitator-v2", status: "done" });
    insertTask({ agentName: "custom-facilitator-v2", status: "done" });

    // Default pattern should not match
    const widgetDefault = store.getMeetingFacilitatorGoalWidget();
    expect(
      widgetDefault.goals.find((g) => g.key === "meetings_facilitated")!.current,
    ).toBe(0);

    // Custom pattern should match
    const widgetCustom = store.getMeetingFacilitatorGoalWidget("%custom-facilitator%");
    expect(
      widgetCustom.goals.find((g) => g.key === "meetings_facilitated")!.current,
    ).toBe(2);
  });
});

// ── getMeetingFacilitatorGoalPayload ──────────────────────────────────────

describe("getMeetingFacilitatorGoalPayload", () => {
  let cleanup = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
  });

  it("delegates to store.getMeetingFacilitatorGoalWidget with defaults", () => {
    const { store, cleanup: c } = makeStoreFixture();
    cleanup = c;

    const result = getMeetingFacilitatorGoalPayload(store);

    expect(result).toHaveProperty("month_start");
    expect(result).toHaveProperty("generated_at");
    expect(result).toHaveProperty("goals");
    expect(result.goals).toHaveLength(2);
  });

  it("forwards agentNamePattern option to store method", () => {
    const { store, insertTask, cleanup: c } = makeStoreFixture();
    cleanup = c;

    for (let i = 0; i < 5; i++) {
      insertTask({ agentName: "special-facilitator", status: "done" });
    }

    const result = getMeetingFacilitatorGoalPayload(store, {
      agentNamePattern: "%special-facilitator%",
    });

    const meetings = result.goals.find((g) => g.key === "meetings_facilitated")!;
    expect(meetings.met).toBe(true);
  });
});

// ── formatMeetingGoalForTelegram (issue #456) ─────────────────────────────

/** Build a synthetic widget for formatter tests — avoids DB setup. */
function makeWidget(overrides: Partial<MeetingFacilitatorGoalWidget> & {
  meetingsCurrent?: number;
  meetingsMet?: boolean;
  coreCurrent?: number;
  coreMet?: boolean;
} = {}): MeetingFacilitatorGoalWidget {
  const meetingsCurrent = overrides.meetingsCurrent ?? 0;
  const meetingsTarget = 5;
  const meetingsMet = overrides.meetingsMet ?? meetingsCurrent >= meetingsTarget;
  const meetingsProgress = Math.min(meetingsCurrent / meetingsTarget, 1);

  const coreCurrent = overrides.coreCurrent ?? 0;
  const coreTarget = 1;
  const coreMet = overrides.coreMet ?? coreCurrent >= coreTarget;
  const coreProgress = Math.min(coreCurrent / coreTarget, 1);

  const allGoalsMet = meetingsMet && coreMet;
  const overallProgress = (meetingsProgress + coreProgress) / 2;

  return {
    month_start: "2026-04-01T00:00:00.000Z",
    generated_at: "2026-04-24T13:00:00.000Z",
    overall_progress: overallProgress,
    all_goals_met: allGoalsMet,
    goals: [
      {
        key: "core_logic_shipped",
        description: "At least one approved implementation task",
        target: coreTarget,
        current: coreCurrent,
        progress: coreProgress,
        met: coreMet,
      },
      {
        key: "meetings_facilitated",
        description: "Five or more facilitated meetings",
        target: meetingsTarget,
        current: meetingsCurrent,
        progress: meetingsProgress,
        met: meetingsMet,
      },
    ],
    ...overrides,
  };
}

describe("formatMeetingGoalForTelegram", () => {
  it("includes the month label in the header", () => {
    const output = formatMeetingGoalForTelegram(makeWidget());
    expect(output).toContain("2026-04");
  });

  it("shows amber warning banner when overall progress is 0%", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 0, coreCurrent: 0 }));
    expect(output).toContain("⚠️");
    expect(output).toContain("No progress this month");
  });

  it("shows in-progress banner when partial progress exists", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 2, coreCurrent: 0 }));
    expect(output).toContain("🔄");
    expect(output).toContain("In progress");
  });

  it("shows all-goals-met banner when both goals are satisfied", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 5, coreCurrent: 1, meetingsMet: true, coreMet: true }));
    expect(output).toContain("✅");
    expect(output).toContain("All goals met");
  });

  it("shows ⚠️ icon next to a goal with zero progress", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 0 }));
    expect(output).toContain("⚠️");
    // Meetings facilitated line should show ⚠️ for 0 progress
    expect(output).toContain("Meetings facilitated");
  });

  it("shows ✅ icon next to a met goal", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 5, meetingsMet: true }));
    expect(output).toContain("✅");
    expect(output).toContain("Meetings facilitated");
  });

  it("shows progress fraction for each goal", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 3, coreCurrent: 0 }));
    expect(output).toContain("3/5"); // meetings 3 of 5
    expect(output).toContain("0/1"); // core 0 of 1
  });

  it("includes a generated timestamp", () => {
    const output = formatMeetingGoalForTelegram(makeWidget());
    expect(output).toContain("Generated");
    expect(output).toContain("2026-04-24");
  });

  it("labels both goal keys in human-readable form", () => {
    const output = formatMeetingGoalForTelegram(makeWidget());
    expect(output).toContain("Meetings facilitated");
    expect(output).toContain("Core logic shipped");
  });

  it("renders a progress bar string for each goal", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 0 }));
    // Progress bar uses block characters
    expect(output).toMatch(/░{10}/); // all empty when at 0%
  });

  it("renders a full progress bar when goal is met", () => {
    const output = formatMeetingGoalForTelegram(makeWidget({ meetingsCurrent: 5, meetingsMet: true }));
    expect(output).toMatch(/█{10}/); // all filled when at 100%
  });
});
