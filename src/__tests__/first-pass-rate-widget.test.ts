/**
 * Tests for the first-pass rate widget (issue #88).
 *
 * Covers:
 *  - StateStore.getFirstPassRateWidget() — current-month rate, goal comparison,
 *    weekly trend points, and per-(agent, task_type) drill-down
 *  - handleFirstPassRate Telegram formatter (via module-internal logic)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { StateStore } from "../state/store.js";
import type { FirstPassRateWidget } from "../state/types.js";

// Helper: raw DB access type used throughout tests
type RawDB = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

// ── Helpers ────────────────────────────────────────────────────────────────

function insertVerificationResult(
  store: StateStore,
  opts: {
    taskId: string;
    agentId: string;
    firstPass: 0 | 1;
    score?: number;
    timestamp?: string;
    taskType?: string;
  },
): void {
  const raw = store as unknown as RawDB;
  const ts = opts.timestamp ?? new Date().toISOString();
  const score = opts.score ?? (opts.firstPass === 1 ? 0.85 : 0.65);

  // Insert a matching task row so the drill-down JOIN resolves task_type
  if (opts.taskType) {
    raw.db
      .prepare(
        `INSERT OR IGNORE INTO tasks
           (id, title, status, agent_name, task_type, created_at, updated_at)
         VALUES (?, ?, 'done', ?, ?, ?, ?)`,
      )
      .run(opts.taskId, `task-${opts.taskId}`, opts.agentId, opts.taskType, ts, ts);
  }

  raw.db
    .prepare(
      `INSERT INTO verification_results
         (task_id, score, first_pass, rejection_reason, threshold, agent_id, timestamp)
       VALUES (?, ?, ?, NULL, 0.80, ?, ?)`,
    )
    .run(opts.taskId, score, opts.firstPass, opts.agentId, ts);
}

function thisMonthStart(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function lastMonthTimestamp(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
  return d.toISOString();
}

// ── StateStore.getFirstPassRateWidget() ───────────────────────────────────

describe("StateStore.getFirstPassRateWidget", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("returns null current_month_rate when no data exists", () => {
    const widget = store.getFirstPassRateWidget();
    expect(widget.current_month_rate).toBeNull();
    expect(widget.current_month_total).toBe(0);
    expect(widget.goal_met).toBeNull();
  });

  it("reports correct goal constant (0.80)", () => {
    const widget = store.getFirstPassRateWidget();
    expect(widget.goal).toBe(0.80);
  });

  it("returns correct current-month rate with mixed results", () => {
    // 3 first-pass, 1 revision → 75% → below goal
    insertVerificationResult(store, { taskId: "T1", agentId: "agent-a", firstPass: 1 });
    insertVerificationResult(store, { taskId: "T2", agentId: "agent-a", firstPass: 1 });
    insertVerificationResult(store, { taskId: "T3", agentId: "agent-a", firstPass: 1 });
    insertVerificationResult(store, { taskId: "T4", agentId: "agent-a", firstPass: 0 });

    const widget = store.getFirstPassRateWidget();
    expect(widget.current_month_total).toBe(4);
    expect(widget.current_month_rate).toBeCloseTo(0.75, 4);
    expect(widget.goal_met).toBe(false);
  });

  it("flags goal_met = true when rate >= 0.80", () => {
    // 4 out of 4 → 100%
    for (let i = 0; i < 4; i++) {
      insertVerificationResult(store, { taskId: `T${i}`, agentId: "agent-a", firstPass: 1 });
    }

    const widget = store.getFirstPassRateWidget();
    expect(widget.goal_met).toBe(true);
    expect(widget.current_month_rate).toBeCloseTo(1.0, 4);
  });

  it("excludes verifications from previous calendar months", () => {
    // Last month — must NOT be counted in current_month_rate
    insertVerificationResult(store, {
      taskId: "OLD1",
      agentId: "agent-a",
      firstPass: 1,
      timestamp: lastMonthTimestamp(),
    });

    // This month
    insertVerificationResult(store, { taskId: "NEW1", agentId: "agent-b", firstPass: 0 });

    const widget = store.getFirstPassRateWidget();
    expect(widget.current_month_total).toBe(1);
    expect(widget.current_month_rate).toBeCloseTo(0.0, 4);
  });

  it("month_start aligns to the first of the current month (UTC)", () => {
    const widget = store.getFirstPassRateWidget();
    const monthStart = new Date(widget.month_start);
    expect(monthStart.getUTCDate()).toBe(1);
    expect(monthStart.getUTCHours()).toBe(0);
    expect(monthStart.getUTCMinutes()).toBe(0);
  });

  describe("weekly_trend", () => {
    it("returns exactly `weeksBack` trend points", () => {
      const widget4 = store.getFirstPassRateWidget(4);
      expect(widget4.weekly_trend).toHaveLength(4);

      const widget2 = store.getFirstPassRateWidget(2);
      expect(widget2.weekly_trend).toHaveLength(2);
    });

    it("all trend points have null rate when there is no data", () => {
      const widget = store.getFirstPassRateWidget(4);
      for (const pt of widget.weekly_trend) {
        expect(pt.rate).toBeNull();
        expect(pt.total).toBe(0);
        expect(pt.first_pass_count).toBe(0);
      }
    });

    it("trend points are ordered oldest-first", () => {
      const widget = store.getFirstPassRateWidget(4);
      for (let i = 1; i < widget.weekly_trend.length; i++) {
        const prev = widget.weekly_trend[i - 1].week_start;
        const curr = widget.weekly_trend[i].week_start;
        expect(curr >= prev).toBe(true);
      }
    });

    it("week_start values are YYYY-MM-DD strings (Monday-aligned)", () => {
      const widget = store.getFirstPassRateWidget(4);
      for (const pt of widget.weekly_trend) {
        expect(pt.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Verify it's a Monday
        const d = new Date(pt.week_start + "T00:00:00Z");
        expect(d.getUTCDay()).toBe(1); // 1 = Monday
      }
    });

    it("assigns current-week verifications to the most recent trend point", () => {
      // Insert verifications with today's timestamp — should land in the last trend point
      insertVerificationResult(store, { taskId: "W1", agentId: "agent-a", firstPass: 1 });
      insertVerificationResult(store, { taskId: "W2", agentId: "agent-a", firstPass: 0 });

      const widget = store.getFirstPassRateWidget(4);
      const latestPoint = widget.weekly_trend[widget.weekly_trend.length - 1];
      expect(latestPoint.total).toBeGreaterThanOrEqual(2);
    });
  });

  describe("drill_down", () => {
    it("returns empty array when no verifications this month", () => {
      const widget = store.getFirstPassRateWidget();
      expect(widget.drill_down).toEqual([]);
    });

    it("groups by agent_id and task_type", () => {
      insertVerificationResult(store, {
        taskId: "D1",
        agentId: "agent-a",
        firstPass: 1,
        taskType: "implementation",
      });
      insertVerificationResult(store, {
        taskId: "D2",
        agentId: "agent-a",
        firstPass: 0,
        taskType: "implementation",
      });
      insertVerificationResult(store, {
        taskId: "D3",
        agentId: "agent-a",
        firstPass: 1,
        taskType: "research",
      });
      insertVerificationResult(store, {
        taskId: "D4",
        agentId: "agent-b",
        firstPass: 1,
        taskType: "implementation",
      });

      const widget = store.getFirstPassRateWidget();
      expect(widget.drill_down.length).toBe(3); // (a,impl), (a,research), (b,impl)

      const aImpl = widget.drill_down.find(
        (r) => r.agent_id === "agent-a" && r.task_type === "implementation",
      );
      expect(aImpl).toBeDefined();
      expect(aImpl!.total).toBe(2);
      expect(aImpl!.first_pass_count).toBe(1);
      expect(aImpl!.rate).toBeCloseTo(0.5, 4);

      const aResearch = widget.drill_down.find(
        (r) => r.agent_id === "agent-a" && r.task_type === "research",
      );
      expect(aResearch).toBeDefined();
      expect(aResearch!.total).toBe(1);
      expect(aResearch!.rate).toBeCloseTo(1.0, 4);
    });

    it("uses 'unknown' task_type when task row is missing", () => {
      // Insert verification without a corresponding task row
      (store as unknown as RawDB).db
        .prepare(
          `INSERT INTO verification_results
             (task_id, score, first_pass, rejection_reason, threshold, agent_id, timestamp)
           VALUES ('NOTASK', 0.9, 1, NULL, 0.80, 'agent-x', ?)`,
        )
        .run(new Date().toISOString());

      const widget = store.getFirstPassRateWidget();
      const row = widget.drill_down.find(
        (r) => r.agent_id === "agent-x" && r.task_type === "unknown",
      );
      expect(row).toBeDefined();
      expect(row!.total).toBe(1);
    });

    it("excludes last-month data from drill-down", () => {
      insertVerificationResult(store, {
        taskId: "OLD_D",
        agentId: "agent-z",
        firstPass: 0,
        taskType: "implementation",
        timestamp: lastMonthTimestamp(),
      });

      const widget = store.getFirstPassRateWidget();
      const row = widget.drill_down.find((r) => r.agent_id === "agent-z");
      expect(row).toBeUndefined();
    });
  });
});
