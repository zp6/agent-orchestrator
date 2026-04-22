/**
 * Tests for triage-health.ts (issue #409).
 *
 * Covers:
 *   1. getTriageHealthPayload() — empty store, single agent, multiple agents
 *   2. Pass/fail detection via quality_score and verification_status
 *   3. Missing-field extraction from result / verification_notes text
 *   4. Revision count estimation
 *   5. Trend computation (improving / degrading / stable)
 *   6. formatTriageHealthForTelegram() — Markdown output structure
 *   7. Agent filter narrows results correctly
 *   8. Fleet-level stats computed correctly
 */

import { describe, it, expect } from "vitest";
import {
  getTriageHealthPayload,
  formatTriageHealthForTelegram,
  TRIAGE_HEALTH_CURRENT_DAYS,
  TRIAGE_HEALTH_PRIOR_DAYS,
  TRIAGE_PASS_THRESHOLD,
  type ITriageHealthStore,
  type TriageHealthReport,
} from "../reviewer/triage-health.js";
import type { Task } from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

let _seq = 0;

function makeTask(
  overrides: Partial<Task> & {
    created_at?: string;
  } = {},
): Task {
  const id = `TASK${String(++_seq).padStart(4, "0")}`;
  return {
    id,
    title: `Triage task ${id}`,
    status: "done",
    task_type: "housekeeping",
    agent_name: "test-agent",
    quality_score: null,
    verification_status: null,
    result: null,
    verification_notes: null,
    description: null,
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[]): ITriageHealthStore {
  return {
    listTasks: () => tasks,
  };
}

/** Returns an ISO timestamp offset from now by `daysAgo`. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getTriageHealthPayload", () => {
  it("returns empty agents array when store has no housekeeping tasks", () => {
    const store = makeStore([
      makeTask({ task_type: "implementation", created_at: daysAgo(1) }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents).toHaveLength(0);
    expect(report.fleet.total).toBe(0);
    expect(report.fleet.pass_rate).toBeNull();
  });

  it("excludes non-terminal tasks from stats", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "in_progress",
        quality_score: 0.9,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    // in_progress is not terminal → excluded
    expect(report.agents).toHaveLength(0);
  });

  it("counts a task as passed when quality_score >= 0.80", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.85,
        created_at: daysAgo(2),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents).toHaveLength(1);
    const entry = report.agents[0];
    expect(entry.current.passed).toBe(1);
    expect(entry.current.failed).toBe(0);
    expect(entry.current.pass_rate).toBe(1.0);
  });

  it("counts a task as failed when quality_score < 0.80", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.65,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const entry = report.agents[0];
    expect(entry.current.failed).toBe(1);
    expect(entry.current.passed).toBe(0);
    expect(entry.current.pass_rate).toBe(0);
  });

  it("falls back to verification_status=approved when quality_score is null", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: null,
        verification_status: "approved",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].current.passed).toBe(1);
  });

  it("falls back to verification_status=rejected as failed", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: null,
        verification_status: "rejected",
        result: "Missing required fields: priority_reordering",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].current.failed).toBe(1);
  });

  it("extracts missing fields from rejection result text", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        verification_status: "rejected",
        result: "TRIAGE SCHEMA VIOLATION: Missing required fields: priority_reordering, outcome_summary",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const entry = report.agents[0];
    const fields = entry.current.missing_fields.map((f) => f.field);
    expect(fields).toContain("priority_reordering");
    expect(fields).toContain("outcome_summary");
  });

  it("does not surface missing fields from passing tasks", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.95,
        result: "All fields present. Good triage.",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    // passing task — no missing fields despite random text
    expect(report.agents[0].current.missing_fields).toHaveLength(0);
  });

  it("computes avg_revisions_per_task from result text", () => {
    const store = makeStore([
      makeTask({
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.85,
        result: "revision attempt 1 submitted, revision attempt 2 complete",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    // 2 "revision" matches + 2 "attempt" matches in the text
    const entry = report.agents[0];
    expect(entry.current.total_revisions).toBeGreaterThan(0);
  });

  it("groups tasks by agent and sorts worst-first", () => {
    const now = Date.now();
    const store = makeStore([
      makeTask({
        agent_name: "good-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.92,
        created_at: daysAgo(1),
      }),
      makeTask({
        agent_name: "bad-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.55,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store, undefined, now);
    expect(report.agents[0].agent_name).toBe("bad-agent");
    expect(report.agents[1].agent_name).toBe("good-agent");
  });

  it("filters by agentName when provided", () => {
    const store = makeStore([
      makeTask({
        agent_name: "agent-a",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.90,
        created_at: daysAgo(1),
      }),
      makeTask({
        agent_name: "agent-b",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.60,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store, "agent-a");
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].agent_name).toBe("agent-a");
  });

  it("marks trend as improving when current pass_rate > prior + 0.05", () => {
    const store = makeStore([
      // Current window (< 7d): all pass
      makeTask({
        agent_name: "agent-x",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.90,
        created_at: daysAgo(2),
      }),
      makeTask({
        agent_name: "agent-x",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.92,
        created_at: daysAgo(3),
      }),
      // Prior window (7–14d): mostly fail
      makeTask({
        agent_name: "agent-x",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        created_at: daysAgo(9),
      }),
      makeTask({
        agent_name: "agent-x",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.45,
        created_at: daysAgo(10),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].trend).toBe("improving");
  });

  it("marks trend as degrading when current pass_rate < prior - 0.05", () => {
    const store = makeStore([
      // Current window (< 7d): all fail
      makeTask({
        agent_name: "agent-y",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        created_at: daysAgo(2),
      }),
      // Prior window (7–14d): mostly pass
      makeTask({
        agent_name: "agent-y",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.95,
        created_at: daysAgo(9),
      }),
      makeTask({
        agent_name: "agent-y",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.92,
        created_at: daysAgo(10),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].trend).toBe("degrading");
  });

  it("marks trend as stable when change is <= 0.05", () => {
    const store = makeStore([
      makeTask({
        agent_name: "agent-z",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.82,
        created_at: daysAgo(2),
      }),
      makeTask({
        agent_name: "agent-z",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.80,
        created_at: daysAgo(9),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].trend).toBe("stable");
  });

  it("marks trend as stable when prior window is empty", () => {
    const store = makeStore([
      makeTask({
        agent_name: "agent-new",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.85,
        created_at: daysAgo(2),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].trend).toBe("stable");
    expect(report.agents[0].prior).toBeNull();
  });

  it("computes fleet stats across all agents", () => {
    const store = makeStore([
      makeTask({
        agent_name: "agent-1",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.90,
        created_at: daysAgo(1),
      }),
      makeTask({
        agent_name: "agent-2",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.60,
        created_at: daysAgo(2),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.fleet.total).toBe(2);
    expect(report.fleet.passed).toBe(1);
    expect(report.fleet.failed).toBe(1);
    expect(report.fleet.pass_rate).toBe(0.5);
  });

  it("surfaces up to 3 recent failure IDs", () => {
    const store = makeStore([
      makeTask({
        id: "FAIL-001",
        agent_name: "flaky-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        created_at: daysAgo(1),
      }),
      makeTask({
        id: "FAIL-002",
        agent_name: "flaky-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.55,
        created_at: daysAgo(2),
      }),
      makeTask({
        id: "FAIL-003",
        agent_name: "flaky-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.45,
        created_at: daysAgo(3),
      }),
      makeTask({
        id: "FAIL-004",
        agent_name: "flaky-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.42,
        created_at: daysAgo(4),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    expect(report.agents[0].recent_failures).toHaveLength(3);
  });

  it("report includes generated_at, current_window_days, prior_window_days", () => {
    const store = makeStore([]);
    const now = Date.now();
    const report = getTriageHealthPayload(store, undefined, now);
    expect(new Date(report.generated_at).getTime()).toBe(now);
    expect(report.current_window_days).toBe(TRIAGE_HEALTH_CURRENT_DAYS);
    expect(report.prior_window_days).toBe(TRIAGE_HEALTH_PRIOR_DAYS);
  });
});

describe("formatTriageHealthForTelegram", () => {
  it("includes header with window sizes", () => {
    const store = makeStore([]);
    const report = getTriageHealthPayload(store);
    const msg = formatTriageHealthForTelegram(report);
    expect(msg).toMatch(/Triage Health/);
    expect(msg).toMatch(/7d/);
  });

  it("shows 'No triage data found' when agent filter matches nothing", () => {
    const store = makeStore([]);
    const report = getTriageHealthPayload(store, "ghost-agent");
    const msg = formatTriageHealthForTelegram(report, "ghost-agent");
    expect(msg).toMatch(/No triage data found/);
  });

  it("shows trend icon for improving agent", () => {
    const store = makeStore([
      makeTask({
        agent_name: "coach-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.95,
        created_at: daysAgo(2),
      }),
      makeTask({
        agent_name: "coach-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.40,
        created_at: daysAgo(9),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const msg = formatTriageHealthForTelegram(report);
    expect(msg).toMatch(/📈/);
  });

  it("shows 📉 for degrading agent", () => {
    const store = makeStore([
      makeTask({
        agent_name: "slide-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.42,
        created_at: daysAgo(2),
      }),
      makeTask({
        agent_name: "slide-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.95,
        created_at: daysAgo(9),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const msg = formatTriageHealthForTelegram(report);
    expect(msg).toMatch(/📉/);
  });

  it("shows missing fields in output", () => {
    const store = makeStore([
      makeTask({
        agent_name: "schema-fail-agent",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        result: "TRIAGE SCHEMA VIOLATION: Missing required fields: outcome_summary",
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const msg = formatTriageHealthForTelegram(report);
    expect(msg).toMatch(/outcome_summary/);
  });

  it("shows fleet summary when tasks exist", () => {
    const store = makeStore([
      makeTask({
        agent_name: "fleet-member",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.85,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store);
    const msg = formatTriageHealthForTelegram(report);
    expect(msg).toMatch(/Fleet/);
  });

  it("passes agent filter to output — only shows matching agent", () => {
    const store = makeStore([
      makeTask({
        agent_name: "agent-alpha",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.85,
        created_at: daysAgo(1),
      }),
      makeTask({
        agent_name: "agent-beta",
        task_type: "housekeeping",
        status: "done",
        quality_score: 0.50,
        created_at: daysAgo(1),
      }),
    ]);
    const report = getTriageHealthPayload(store, "agent-alpha");
    const msg = formatTriageHealthForTelegram(report, "agent-alpha");
    expect(msg).toMatch(/agent-alpha/);
    expect(msg).not.toMatch(/agent-beta/);
  });
});
