import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import {
  detectMultiRepoChangeSets,
  determineMergeOrder,
  extractPRFromTaskResult,
  createCoordinationGroup,
  checkAndAdvanceCoordination,
  validateChangeSetDescription,
  NO_CODE_CHANGES_FALLBACK,
  type MultiRepoChangeSet,
} from "./multi-repo-coordinator.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";

vi.mock("node:child_process");

const mockExecFileSync = vi.mocked(childProcess.execFileSync);

// ── Test fixtures ─────────────────────────────────────────────────────────────

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3471" },
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orch",
  agents: {
    "claude-agent-orchestrator": {
      dir: "claude-agent-orchestrator",
      description: "Core orchestrator",
      capabilities: ["implementation"],
      github: "rapartlu/agent-orchestrator",
      owns_topics: ["orchestrator", "planner", "dispatcher"],
    },
    "claude-orchestrator-dashboard": {
      dir: "claude-orchestrator-dashboard",
      description: "Dashboard and CLI",
      capabilities: ["implementation"],
      github: "rapartlu/agent-dashboard",
      owns_topics: ["dashboard", "cli", "metrics"],
    },
    "claude-orchestrator-reviewer": {
      dir: "claude-orchestrator-reviewer",
      description: "PR reviewer",
      capabilities: ["review"],
      github: "rapartlu/agent-reviewer",
      owns_topics: ["review", "verification"],
    },
  },
  providers: {
    claude: { model: "claude-3", limits: { hourly: 1000000, daily: 5000000, weekly: 25000000 } },
  },
} as unknown as OrchestratorConfig;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01TASK",
    title: "Test task",
    description: null,
    source: "github",
    source_ref: "rapartlu/agent-orchestrator#612",
    status: "done",
    agent_name: "claude-agent-orchestrator",
    conversation_id: null,
    result: null,
    parent_task_id: null,
    step_id: null,
    plan: null,
    task_type: "implementation",
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    retry_count: 0,
    next_retry_at: null,
    revision_count: 0,
    lineage_group_id: null,
    reported: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockStore(overrides: Partial<StateStore> = {}): StateStore {
  return {
    createTask: vi.fn().mockReturnValue({ id: "01CHILD" }),
    getTask: vi.fn().mockReturnValue(null),
    createCoordinationGroup: vi.fn(),
    getCoordinationGroup: vi.fn().mockReturnValue(null),
    getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue(null),
    getCoordinationGroupsByStatus: vi.fn().mockReturnValue([]),
    updateCoordinationGroup: vi.fn(),
    recordLineageMapping: vi.fn(),
    ...overrides,
  } as unknown as StateStore;
}

// ── detectMultiRepoChangeSets ─────────────────────────────────────────────────

describe("detectMultiRepoChangeSets", () => {
  it("returns empty array for research tasks", () => {
    const task = makeTask({
      task_type: "research",
      title: "Research dashboard metrics and agent-dashboard updates",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    expect(result).toEqual([]);
  });

  it("detects peer repo by name in task title", () => {
    const task = makeTask({
      title: "Add multi-repo coordination: update agent-dashboard to display coordination groups",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((cs) => cs.repo === "rapartlu/agent-dashboard")).toBe(true);
  });

  it("detects peer repo by full github slug in description", () => {
    const task = makeTask({
      title: "Multi-repo feature",
      description:
        "This requires changes to rapartlu/agent-dashboard to add a new route. " +
        "The dashboard should display the new coordination status.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    expect(result.some((cs) => cs.repo === "rapartlu/agent-dashboard")).toBe(true);
  });

  it("does NOT fire when no action verb is present near the mention", () => {
    // "see also: dashboard" is a mere reference — no action verb nearby
    const task = makeTask({
      title: "Internal orchestrator refactor",
      description: "See also: dashboard for related context. No changes needed elsewhere.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    expect(result).toEqual([]);
  });

  it("does not include the own repo", () => {
    const task = makeTask({
      title: "Update rapartlu/agent-orchestrator planner to produce multi-repo plans",
      description: "The orchestrator needs to detect and implement cross-repo features.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    // Own repo must not appear
    expect(result.every((cs) => cs.repo !== "rapartlu/agent-orchestrator")).toBe(true);
  });

  it("deduplicates the same peer repo even if mentioned multiple times", () => {
    const task = makeTask({
      title: "Update agent-dashboard CLI and agent-dashboard metrics",
      description: "The agent-dashboard should add CLI and metrics support.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    const dashboardResults = result.filter((cs) => cs.repo === "rapartlu/agent-dashboard");
    expect(dashboardResults.length).toBe(1);
  });

  it("assigns sequential merge orders starting from 1", () => {
    const task = makeTask({
      title: "Expose API in orchestrator and display it in agent-dashboard",
      description:
        "The orchestrator should expose a new API endpoint. " +
        "The agent-dashboard should display and consume it.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-orchestrator-dashboard", config);
    if (result.length > 0) {
      const orders = result.map((cs) => cs.mergeOrder).sort((a, b) => a - b);
      expect(orders[0]).toBe(1);
      for (let i = 1; i < orders.length; i++) {
        expect(orders[i]).toBe(orders[i - 1]! + 1);
      }
    }
  });
});

// ── validateChangeSetDescription (agent-reviewer#668 regression) ──────────────

describe("validateChangeSetDescription", () => {
  const ctx = { repo: "rapartlu/agent-reviewer", sourceRef: "rapartlu/agent-orchestrator#1465" };

  it("returns the trimmed description when it is well-formed and contains the matched token", () => {
    const result = validateChangeSetDescription(
      "  Update the agent-reviewer client to handle new fields.  ",
      "agent-reviewer",
      ctx,
    );
    expect(result).toBe("Update the agent-reviewer client to handle new fields.");
  });

  it("falls back to review-only sentinel when the description is empty", () => {
    expect(validateChangeSetDescription("", "agent-reviewer", ctx)).toBe(NO_CODE_CHANGES_FALLBACK);
    expect(validateChangeSetDescription("   \n  ", "agent-reviewer", ctx)).toBe(NO_CODE_CHANGES_FALLBACK);
  });

  it("falls back when the description looks like a fleet-antibody fragment (the #668 failure)", () => {
    // Exact failure mode reported by claude-orchestrator-reviewer in #668
    const truncatedAntibody = "Direct commits to main bypass code review, break the merge queue, and can corrupt ..";
    expect(validateChangeSetDescription(truncatedAntibody, "agent-reviewer", ctx)).toBe(
      NO_CODE_CHANGES_FALLBACK,
    );
  });

  it("falls back when the description references an antibody marker (Fleet Antibodies section)", () => {
    const text = "⚠️ Fleet Antibodies — Known failure patterns for this repo (auto-injected)";
    expect(validateChangeSetDescription(text, "agent-reviewer", ctx)).toBe(NO_CODE_CHANGES_FALLBACK);
  });

  it("falls back when the description ends mid-sentence with an ellipsis", () => {
    expect(
      validateChangeSetDescription("The reviewer should detect malformed dispatches and ...", "review", ctx),
    ).toBe(NO_CODE_CHANGES_FALLBACK);
    expect(
      validateChangeSetDescription("The reviewer should detect malformed dispatches and …", "review", ctx),
    ).toBe(NO_CODE_CHANGES_FALLBACK);
    expect(
      validateChangeSetDescription("The reviewer should detect malformed dispatches and ..", "review", ctx),
    ).toBe(NO_CODE_CHANGES_FALLBACK);
  });

  it("falls back when the matched token is missing from the snippet", () => {
    const description = "Add a new endpoint that returns coordination group state.";
    expect(validateChangeSetDescription(description, "agent-reviewer", ctx)).toBe(NO_CODE_CHANGES_FALLBACK);
  });

  it("permits the snippet through when matchedToken is null (dispatch-boundary mode)", () => {
    const description = "Add a new endpoint that returns coordination group state.";
    expect(validateChangeSetDescription(description, null, ctx)).toBe(description);
  });

  it("does not loop on the fallback sentinel itself", () => {
    expect(validateChangeSetDescription(NO_CODE_CHANGES_FALLBACK, null, ctx)).toBe(NO_CODE_CHANGES_FALLBACK);
    expect(validateChangeSetDescription(NO_CODE_CHANGES_FALLBACK, "agent-reviewer", ctx)).toBe(
      NO_CODE_CHANGES_FALLBACK,
    );
  });
});

// ── extractContextForRepo (paragraph-boundary regression) ─────────────────────

describe("detectMultiRepoChangeSets — paragraph isolation", () => {
  it("does not pull text from a previous paragraph into the change-set description", () => {
    // Reproduces the agent-reviewer#668 failure: an unrelated antibody-style
    // bullet precedes the actual repo mention in a separate paragraph. The
    // extraction must walk back only to the paragraph boundary, and the
    // antibody fragment must trigger the dispatch-boundary fallback.
    const task = makeTask({
      title: "Multi-repo feature",
      description:
        "Direct commits to main bypass code review, break the merge queue, and can corrupt repository state.\n\n" +
        "Add a new agent-dashboard route that displays the coordination state.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    const dash = result.find((cs) => cs.repo === "rapartlu/agent-dashboard");
    expect(dash).toBeDefined();
    // The description must NOT contain the previous-paragraph antibody text
    expect(dash!.description.toLowerCase()).not.toContain("merge queue");
    expect(dash!.description.toLowerCase()).not.toContain("bypass code review");
  });

  it("substitutes the safe fallback when the only nearby text is an antibody fragment", () => {
    // Construct a task where the matched token sits inside a paragraph that
    // looks like an antibody hint. Validation must catch it.
    const task = makeTask({
      title: "Coordination feature",
      description:
        "We need to update the agent-dashboard.\n\n" +
        "Direct commits to main bypass code review, break the merge queue, and can corrupt the dashboard state.",
    });
    const result = detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config);
    const dash = result.find((cs) => cs.repo === "rapartlu/agent-dashboard");
    if (dash) {
      // Either the snippet from the FIRST paragraph (clean) is selected, OR
      // the antibody-tainted second paragraph is replaced by the fallback.
      // Both are acceptable outcomes; what's NOT acceptable is shipping the
      // antibody text verbatim.
      const lower = dash.description.toLowerCase();
      const isFallback = dash.description === NO_CODE_CHANGES_FALLBACK;
      const hasAntibodyPhrase = lower.includes("merge queue") || lower.includes("bypass code review");
      expect(isFallback || !hasAntibodyPhrase).toBe(true);
    }
  });
});

// ── determineMergeOrder ───────────────────────────────────────────────────────

describe("determineMergeOrder", () => {
  it("puts orchestrator/core/api repos before dashboard/consumer repos", () => {
    const input: MultiRepoChangeSet[] = [
      { repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "dash changes", mergeOrder: 0 },
      { repo: "rapartlu/agent-orchestrator", agentName: "claude-agent-orchestrator", description: "core changes", mergeOrder: 0 },
    ];
    const result = determineMergeOrder(input);
    const orchestratorEntry = result.find((cs) => cs.repo === "rapartlu/agent-orchestrator");
    const dashboardEntry = result.find((cs) => cs.repo === "rapartlu/agent-dashboard");
    expect(orchestratorEntry!.mergeOrder).toBeLessThan(dashboardEntry!.mergeOrder);
  });

  it("assigns mergeOrder 1 to the first repo", () => {
    const input: MultiRepoChangeSet[] = [
      { repo: "rapartlu/agent-proxy", agentName: "proxy-agent", description: "proxy", mergeOrder: 0 },
      { repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "dash", mergeOrder: 0 },
    ];
    const result = determineMergeOrder(input);
    expect(result.some((cs) => cs.mergeOrder === 1)).toBe(true);
    expect(result.some((cs) => cs.mergeOrder === 2)).toBe(true);
  });

  it("is deterministic: same input always produces same output", () => {
    const input: MultiRepoChangeSet[] = [
      { repo: "z-consumer", agentName: "z", description: "", mergeOrder: 0 },
      { repo: "a-consumer", agentName: "a", description: "", mergeOrder: 0 },
    ];
    const r1 = determineMergeOrder(input);
    const r2 = determineMergeOrder(input);
    expect(r1.map((cs) => cs.repo)).toEqual(r2.map((cs) => cs.repo));
  });

  it("returns an empty array when given an empty array", () => {
    expect(determineMergeOrder([])).toEqual([]);
  });
});

// ── extractPRFromTaskResult ───────────────────────────────────────────────────

describe("extractPRFromTaskResult", () => {
  it("extracts a PR from a full GitHub URL", () => {
    const result = "Done! PR created: https://github.com/rapartlu/agent-dashboard/pull/42";
    const pr = extractPRFromTaskResult(result, "rapartlu/agent-dashboard");
    expect(pr).toEqual({ number: 42, url: "https://github.com/rapartlu/agent-dashboard/pull/42" });
  });

  it("returns null when result is empty", () => {
    expect(extractPRFromTaskResult("", "rapartlu/agent-dashboard")).toBeNull();
  });

  it("returns null when the URL is for a different repo", () => {
    const result = "https://github.com/rapartlu/agent-orchestrator/pull/99";
    expect(extractPRFromTaskResult(result, "rapartlu/agent-dashboard")).toBeNull();
  });

  it("falls back to short PR reference with repo mention", () => {
    const result = "Created PR #7 on agent-dashboard with the new route.";
    const pr = extractPRFromTaskResult(result, "rapartlu/agent-dashboard");
    expect(pr?.number).toBe(7);
  });

  it("handles multi-digit PR numbers", () => {
    const result = "https://github.com/rapartlu/agent-dashboard/pull/1234 is now open.";
    const pr = extractPRFromTaskResult(result, "rapartlu/agent-dashboard");
    expect(pr?.number).toBe(1234);
  });
});

// ── createCoordinationGroup ───────────────────────────────────────────────────

describe("createCoordinationGroup", () => {
  it("creates child tasks for each change set and persists the group", () => {
    const store = makeMockStore();
    const task = makeTask();
    const changeSets: MultiRepoChangeSet[] = [
      {
        repo: "rapartlu/agent-dashboard",
        agentName: "claude-orchestrator-dashboard",
        description: "Add coordination status page",
        mergeOrder: 1,
      },
    ];

    const group = createCoordinationGroup(task, changeSets, store);

    expect(store.createTask).toHaveBeenCalledOnce();
    expect(store.createCoordinationGroup).toHaveBeenCalledOnce();
    expect(group.changeSets).toEqual(changeSets);
    expect(group.parentTaskId).toBe(task.id);
    expect(group.status).toBe("pending");
    expect(typeof group.childTaskIds["rapartlu/agent-dashboard"]).toBe("string");
  });

  it("creates one child task per repo in the change sets", () => {
    const store = makeMockStore({
      createTask: vi
        .fn()
        .mockReturnValueOnce({ id: "child-1" })
        .mockReturnValueOnce({ id: "child-2" }),
    });
    const task = makeTask();
    const changeSets: MultiRepoChangeSet[] = [
      { repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "dash", mergeOrder: 2 },
      { repo: "rapartlu/agent-reviewer", agentName: "claude-orchestrator-reviewer", description: "review", mergeOrder: 1 },
    ];

    const group = createCoordinationGroup(task, changeSets, store);

    expect(store.createTask).toHaveBeenCalledTimes(2);
    expect(Object.keys(group.childTaskIds)).toHaveLength(2);
  });

  it("uses the parent source_ref for child tasks", () => {
    const store = makeMockStore();
    const task = makeTask({ source_ref: "rapartlu/agent-orchestrator#612" });
    const changeSets: MultiRepoChangeSet[] = [
      { repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "d", mergeOrder: 1 },
    ];

    createCoordinationGroup(task, changeSets, store);

    const createTaskCall = vi.mocked(store.createTask).mock.calls[0]![0];
    expect(createTaskCall.source_ref).toBe("rapartlu/agent-orchestrator#612");
    expect(createTaskCall.parent_task_id).toBe(task.id);
  });
});

// ── checkAndAdvanceCoordination ───────────────────────────────────────────────

describe("checkAndAdvanceCoordination", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gh pr view returns an empty body (no existing cross-ref marker)
    mockExecFileSync.mockReturnValue("" as unknown as Buffer);
  });

  it("returns early when task is not part of any coordination group", async () => {
    const store = makeMockStore({
      getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue(null),
    });
    await checkAndAdvanceCoordination("non-existent-task", store, config);
    expect(store.updateCoordinationGroup).not.toHaveBeenCalled();
  });

  it("returns early when group is in a terminal state", async () => {
    const store = makeMockStore({
      getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue({
        id: "group-1",
        parentTaskId: "parent",
        parentSourceRef: null,
        changeSets: [{ repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "", mergeOrder: 1 }],
        childTaskIds: { "rapartlu/agent-dashboard": "child-1" },
        childPRNumbers: {},
        childPRUrls: {},
        status: "merged",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });

    await checkAndAdvanceCoordination("child-1", store, config);
    expect(store.updateCoordinationGroup).not.toHaveBeenCalled();
  });

  it("transitions to in_progress when child tasks are still running", async () => {
    const group = {
      id: "group-1",
      parentTaskId: "parent",
      parentSourceRef: null,
      changeSets: [{ repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "", mergeOrder: 1 }],
      childTaskIds: { "rapartlu/agent-dashboard": "child-1" },
      childPRNumbers: {},
      childPRUrls: {},
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = makeMockStore({
      getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue(group),
      getTask: vi.fn().mockReturnValue({ id: "child-1", status: "in_progress", result: null }),
      getCoordinationGroup: vi.fn().mockReturnValue(group),
    });

    await checkAndAdvanceCoordination("child-1", store, config);
    expect(store.updateCoordinationGroup).toHaveBeenCalledWith("group-1", { status: "in_progress" });
  });

  it("transitions to failed when a child task fails", async () => {
    const group = {
      id: "group-2",
      parentTaskId: "parent",
      parentSourceRef: null,
      changeSets: [{ repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "", mergeOrder: 1 }],
      childTaskIds: { "rapartlu/agent-dashboard": "child-2" },
      childPRNumbers: {},
      childPRUrls: {},
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = makeMockStore({
      getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue(group),
      getTask: vi.fn().mockReturnValue({ id: "child-2", status: "failed", result: null }),
      getCoordinationGroup: vi.fn().mockReturnValue(group),
    });

    await checkAndAdvanceCoordination("child-2", store, config);
    expect(store.updateCoordinationGroup).toHaveBeenCalledWith("group-2", { status: "failed" });
  });

  it("transitions to ready_to_merge when all child tasks complete successfully", async () => {
    const group = {
      id: "group-3",
      parentTaskId: "parent",
      parentSourceRef: "rapartlu/agent-orchestrator#612",
      changeSets: [{ repo: "rapartlu/agent-dashboard", agentName: "claude-orchestrator-dashboard", description: "", mergeOrder: 1 }],
      childTaskIds: { "rapartlu/agent-dashboard": "child-3" },
      childPRNumbers: {},
      childPRUrls: {},
      status: "in_progress",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // gh pr view returns a body without the cross-ref marker
    mockExecFileSync.mockReturnValue("Original PR body" as unknown as Buffer);

    const store = makeMockStore({
      getCoordinationGroupByChildTaskId: vi.fn().mockReturnValue(group),
      getTask: vi.fn().mockReturnValue({
        id: "child-3",
        status: "done",
        result: "PR created: https://github.com/rapartlu/agent-dashboard/pull/55",
      }),
      getCoordinationGroup: vi.fn().mockReturnValue({
        ...group,
        childPRNumbers: { "rapartlu/agent-dashboard": 55 },
        childPRUrls: { "rapartlu/agent-dashboard": "https://github.com/rapartlu/agent-dashboard/pull/55" },
      }),
    });

    await checkAndAdvanceCoordination("child-3", store, config);

    // Should have called updateCoordinationGroup with ready_to_merge at some point
    const calls = vi.mocked(store.updateCoordinationGroup).mock.calls;
    const readyCall = calls.find((c) => c[1] && (c[1] as { status?: string }).status === "ready_to_merge");
    expect(readyCall).toBeDefined();
  });
});
