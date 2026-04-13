import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewerClient } from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { StateStore, type Task } from "../state/store.js";
import {
  buildSupervisorContext,
  detectImprovements,
  extractIssueRefs,
  gateResolvedIssues,
  isConcreteDispatch,
  isDecisionAlreadyResolved,
  reviewSupervisorState,
  verifyAndReviseTask,
  verifyTask,
} from "./reviewer-ops.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const mockCreate = vi.fn();
const mockDispatch = vi.fn();
const mockLiveValidateForDispatch = vi.fn().mockReturnValue(null);

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

vi.mock("../orchestrator/dispatcher.js", () => ({
  Dispatcher: function MockDispatcher(this: { dispatch: typeof mockDispatch }) {
    this.dispatch = mockDispatch;
  },
  extractRepoFromSourceRef: (ref: string | null | undefined) => {
    if (!ref) return undefined;
    const m = ref.match(/^([^/]+\/[^/#]+)/);
    return m ? m[1] : undefined;
  },
}));

vi.mock("./notify.js", () => ({
  notifyOperator: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../orchestrator/learned-rules.js", () => ({
  extractAndStoreRules: vi.fn().mockReturnValue([]),
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("[]"),
}));

vi.mock("../triggers/issue-state-bridge.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    cachedGetIssueState: vi.fn().mockImplementation(() => { throw new Error("cache miss"); }),
    liveValidateForDispatch: (...args: unknown[]) => mockLiveValidateForDispatch(...args),
  };
});

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": {
      dir: "a",
      description: "Agent A",
      capabilities: ["test"],
      owns_topics: ["a"],
      github: "owner/a",
      pool: "orchestrator",
      auto_reroute_rejection_threshold: 3,
    },
    "agent-b": {
      dir: "b",
      description: "Agent B",
      capabilities: ["test"],
      owns_topics: ["b"],
      github: "owner/b",
      pool: "orchestrator",
    },
  },
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "test-id",
    title: "Test",
    description: null,
    source: "manual",
    source_ref: null,
    status: "done",
    agent_name: "agent-a",
    conversation_id: null,
    result: "Done",
    parent_task_id: null,
    step_id: null,
    plan: null,
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    revision_count: 0,
    task_type: "implementation",
    next_retry_at: null,
    retry_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("reviewer-ops", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `orch-reviewer-ops-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("verifyTask approves high-quality work and updates state", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: true, score: 0.9, notes: "Good" }) }],
    });

    const task = store.createTask({ title: "Test", description: "Do something", source: "manual", agent_name: "agent-a" });
    store.updateTask(task.id, { status: "done", result: "Done" });

    const result = await verifyTask(store, new ReviewerClient(config), task.id);

    expect(result.approved).toBe(true);
    expect(store.getTask(task.id)?.verification_status).toBe("approved");
  });

  it("verifyAndReviseTask defers revision dispatch when the agent is busy", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.2, notes: "Bad", revision: "Fix it" }) }],
    });

    const task = store.createTask({
      title: "Needs work",
      description: "Do something",
      source: "manual",
      agent_name: "agent-a",
    });
    store.updateTask(task.id, { status: "done", result: "Partial" });

    const active = store.createTask({ title: "Busy", source: "manual", agent_name: "agent-a" });
    store.updateTask(active.id, { status: "dispatched" });

    const result = await verifyAndReviseTask(config, store, new ReviewerClient(config), task.id);

    expect(result.approved).toBe(false);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(store.getTask(task.id)?.verification_status).toBeNull();
  });

  it("verifyAndReviseTask skips revision when source_ref is already resolved", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify({ approved: false, score: 0.2, notes: "Bad", revision: "Fix it" }) }],
    });
    mockLiveValidateForDispatch.mockReturnValueOnce("issue already closed");

    const task = store.createTask({
      title: "Needs work",
      description: "Do something",
      source: "github",
      source_ref: "owner/a#42",
      agent_name: "agent-a",
    });
    store.updateTask(task.id, { status: "done", result: "Partial" });

    const result = await verifyAndReviseTask(config, store, new ReviewerClient(config), task.id);

    expect(result.approved).toBe(true);
    expect(result.notes).toBe("no-op: already resolved");
    expect(mockDispatch).not.toHaveBeenCalled();
    // Task verification_status should be set to approved (not re-queued for revision)
    expect(store.getTask(task.id)?.verification_status).toBe("approved");
    // A supervisor decision should be recorded for observability
    const decisions = store.getRecentSupervisorDecisions(5);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].outcome).toBe("skipped");
    expect(decisions[0].hard_gates).toContain("no-op: already resolved");
  });

  it("reviewSupervisorState builds context and filters vague idle dispatches", async () => {
    const task = store.createTask({ title: "Finished task", source: "manual", agent_name: "agent-a" });
    store.updateTask(task.id, { status: "done", result: "Done" });

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        {
          action: "dispatch",
          agentName: "agent-a",
          message: "Agent is idle with 0 active tasks. Check for work.",
          reason: "Agent is idle",
        },
        {
          action: "dispatch",
          agentName: "agent-b",
          message: "Implement issue #42 from owner/b",
          reason: "Issue is open",
        },
      ]) }],
    });

    const decisions = await reviewSupervisorState(config, store, new ReviewerClient(config));

    expect(decisions).toHaveLength(1);
    expect(decisions[0].agentName).toBe("agent-b");
    expect(mockCreate.mock.calls[0][0].messages[0].content).toContain("## Recent Completed Tasks");
  });

  it("gateResolvedIssues blocks resolved dispatches", () => {
    mockLiveValidateForDispatch.mockReturnValueOnce("issue already has open PR");

    const result = gateResolvedIssues(config, store, [
      { action: "dispatch", agentName: "agent-a", message: "Implement issue #42", reason: "Open issue" },
    ]);

    expect(result.blocked).toHaveLength(1);
    expect(result.passed).toHaveLength(0);
  });

  it("detectImprovements delegates to ReviewerClient", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { title: "Add retry logic", description: "Improve retries", affected_agents: ["agent-a"], severity: "medium" },
      ]) }],
    });

    const improvements = await detectImprovements(new ReviewerClient(config), [
      makeTask({ quality_score: 0.3 }),
    ]);

    expect(improvements).toHaveLength(1);
    expect(improvements[0].title).toBe("Add retry logic");
  });

  it("buildSupervisorContext includes prior decisions and research findings", () => {
    store.addSupervisorDecision({
      action: "dispatch",
      agent_name: "agent-a",
      reason: "Implement issue #42",
      outcome: "dispatched",
      task_id: "01ABCDEF1234",
    });

    const research = store.createTask({
      title: "Research scaling",
      source: "manual",
      agent_name: "agent-a",
      task_type: "research",
    });
    store.updateTask(research.id, {
      status: "done",
      result: "Pool-based routing helps.",
      verification_status: "approved",
      quality_score: 0.9,
    });

    const context = buildSupervisorContext(config, store);

    expect(context).toContain("## Recent Supervisor Decisions");
    expect(context).toContain("## Recent Research Findings");
    expect(context).toContain("Research scaling");
  });

  it("extractIssueRefs and isConcreteDispatch keep supervisor gating behavior", () => {
    expect(extractIssueRefs("Fix #42 and owner/repo#43")).toEqual([42, 43]);
    expect(isConcreteDispatch("Please implement issue #42")).toBe(true);
    expect(isConcreteDispatch("You are idle. Check for work.")).toBe(false);
  });

  it("isDecisionAlreadyResolved returns false for open issues", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockReturnValueOnce("OPEN");

    expect(isDecisionAlreadyResolved("Fix issue #42", "Still open", "owner/a")).toBe(false);
  });
});
