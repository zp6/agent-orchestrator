import { describe, expect, it } from "vitest";
import {
  buildIssueAgeHeatmap,
  classifyIssueAge,
  collectIssueAgeEscalations,
  formatIssueAgeHeatmap,
  hasRecentAgeDispatchDecision,
  hasRecentAgeNudge,
} from "../reviewer/issue-age.js";
import type { SupervisorDecisionRecord, Task } from "../state/types.js";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "01HZXTEST00000000000000000",
    title: "Open issue",
    description: null,
    status: "pending",
    agent_name: "claude-proxy",
    task_type: "implementation",
    source: "github",
    source_ref: "#999",
    result: null,
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    created_at: "2026-04-07T12:00:00.000Z",
    updated_at: "2026-04-07T12:00:00.000Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<SupervisorDecisionRecord>): SupervisorDecisionRecord {
  return {
    id: "decision-1",
    action: "dispatch",
    agent_name: "claude-proxy",
    task_id: "01HZXTEST00000000000000000",
    issue_ref: "#999",
    reason: "dispatch",
    message: "Implement issue #999",
    outcome: "pending",
    rationale: null,
    created_at: "2026-04-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("issue-age helpers", () => {
  it("classifies ages into escalation buckets", () => {
    expect(classifyIssueAge(0)).toBe("0-7d");
    expect(classifyIssueAge(7)).toBe("7-14d");
    expect(classifyIssueAge(14)).toBe("14-30d");
    expect(classifyIssueAge(30)).toBe("30d+");
  });

  it("builds a heatmap with color-coded buckets", () => {
    const now = Date.parse("2026-04-07T12:00:00.000Z");
    const tasks = [
      makeTask({
        id: "01HZXTEST00000000000000001",
        title: "Fresh issue",
        source_ref: "#101",
        created_at: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTask({
        id: "01HZXTEST00000000000000002",
        title: "Stale issue",
        source_ref: "#102",
        created_at: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTask({
        id: "01HZXTEST00000000000000003",
        title: "Very stale issue",
        source_ref: "#103",
        created_at: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];

    const heatmap = buildIssueAgeHeatmap(tasks, [], now);
    expect(heatmap.total).toBe(3);
    expect(heatmap.buckets[0].count).toBe(1);
    expect(heatmap.buckets[1].count).toBe(0);
    expect(heatmap.buckets[2].count).toBe(1);
    expect(heatmap.buckets[3].count).toBe(1);

    const lines = formatIssueAgeHeatmap(heatmap);
    expect(lines[0]).toContain("Issue age heatmap");
    expect(lines.join("\n")).toContain("30d+");
  });

  it("tracks dispatch attempts and escalation candidates", () => {
    const now = Date.parse("2026-04-07T12:00:00.000Z");
    const tasks = [
      makeTask({
        id: "01HZXTEST00000000000000011",
        title: "Needs dispatch",
        source_ref: "#201",
        created_at: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTask({
        id: "01HZXTEST00000000000000012",
        title: "Already tried",
        source_ref: "#202",
        created_at: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeTask({
        id: "01HZXTEST00000000000000013",
        title: "Ancient issue",
        source_ref: "#203",
        created_at: new Date(now - 40 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    ];

    const decisions = [
      makeDecision({
        task_id: "01HZXTEST00000000000000012",
        issue_ref: "#202",
        message: "Implement issue #202",
      }),
    ];

    const escalations = collectIssueAgeEscalations(tasks, decisions, now);
    expect(escalations.map((item) => item.taskId)).toContain("01HZXTEST00000000000000011");
    expect(escalations.map((item) => item.taskId)).toContain("01HZXTEST00000000000000013");

    const nudgeTask = escalations.find((item) => item.taskId === "01HZXTEST00000000000000011");
    expect(nudgeTask?.shouldNudge).toBe(true);
    expect(nudgeTask?.shouldForceDispatch).toBe(false);

    const forceTask = escalations.find((item) => item.taskId === "01HZXTEST00000000000000013");
    expect(forceTask?.shouldNudge).toBe(true);
    expect(forceTask?.shouldForceDispatch).toBe(true);
  });

  it("recognizes recent age decisions for rate limiting", () => {
    const now = Date.parse("2026-04-07T12:00:00.000Z");
    const task = makeTask({
      id: "01HZXTEST00000000000000021",
      source_ref: "#301",
      created_at: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const decisions = [
      makeDecision({
        action: "age-nudge",
        task_id: "01HZXTEST00000000000000021",
        issue_ref: "#301",
        created_at: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }),
      makeDecision({
        action: "dispatch",
        task_id: "01HZXTEST00000000000000021",
        issue_ref: "#301",
        reason: "dispatched due to age escalation",
        created_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      }),
    ];

    expect(hasRecentAgeNudge(task, decisions, now)).toBe(true);
    expect(hasRecentAgeDispatchDecision(task, decisions, now)).toBe(true);
  });
});
