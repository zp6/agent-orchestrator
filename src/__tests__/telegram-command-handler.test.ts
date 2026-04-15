import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandHandler } from "../telegram/command-handler.js";
import type {
  AgentHealth,
  DispatchRequest,
  IStateStore,
  MergeQueueEntry,
  QualityHealthReport,
  SupervisorDecisionQuery,
  SupervisorDecisionRecord,
  Task,
  VerificationResultRecord,
} from "../state/types.js";

function makeTask(overrides: Partial<Task>): Task {
  const now = "2026-04-07T12:00:00.000Z";
  return {
    id: "01HZXTEST00000000000000000",
    title: "Escalated task",
    description: null,
    status: "escalated",
    agent_name: "claude-proxy",
    task_type: "implementation",
    source: null,
    source_ref: null,
    result: null,
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeStore(
  tasks: Task[],
  opts: {
    verificationRecord?: VerificationResultRecord | null;
    qualityReport?: QualityHealthReport;
  } = {},
): IStateStore {
  const systemFlags = new Map<string, string>();
  const decisions: SupervisorDecisionRecord[] = [];

  return {
    getTask: (id: string) => tasks.find((task) => task.id === id) ?? null,
    updateTask: (id: string, updates) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) return;
      Object.assign(task, updates, { updated_at: "2026-04-07T12:30:00.000Z" });
    },
    hasActiveTask: () => false,
    listTasks: ({ status, agent_name, limit }) => {
      const filtered = tasks.filter((task) => {
        if (status && task.status !== status) return false;
        if (agent_name && task.agent_name !== agent_name) return false;
        return true;
      });
      return filtered.slice(0, limit ?? 100);
    },
    getRecentCompleted: () => [],
    getUnverified: () => [],
    getAgentStats: () => [],
    getAgentHealthBatch: () => [] as AgentHealth[],
    getRecentSupervisorDecisions: (limit: number) => decisions.slice(0, limit),
    querySupervisorDecisions: (_opts: SupervisorDecisionQuery) => decisions,
    pruneOldSupervisorDecisions: () => 0,
    recordSupervisorDecision: (action, reason, opts = {}) => {
      decisions.unshift({
        id: `decision-${decisions.length + 1}`,
        action,
        agent_name: opts.agentName ?? null,
        task_id: opts.taskId ?? null,
        issue_ref: opts.issueRef ?? null,
        reason,
        message: opts.message ?? null,
        outcome: opts.outcome ?? "pending",
        rationale: opts.rationale ?? null,
        created_at: "2026-04-07T12:30:00.000Z",
      });
    },
    queuePRForMerge: (_repo: string, prNumber: number, branch: string): MergeQueueEntry => ({
      repo: "repo",
      pr_number: prNumber,
      branch,
      status: "queued",
      position: 1,
      created_at: "2026-04-07T12:00:00.000Z",
    }),
    getMergeQueue: () => [],
    isPRInMergeQueue: () => false,
    markQueuedPRMerging: () => undefined,
    markQueuedPRMerged: () => undefined,
    markQueuedPRFailed: () => undefined,
    removeFromMergeQueue: () => undefined,
    recordPRReview: () => undefined,
    getSystemFlag: (key: string) => systemFlags.get(key) ?? null,
    setSystemFlag: (key: string, value: string) => {
      systemFlags.set(key, value);
    },
    createDispatchRequest: (agentName: string, message: string): DispatchRequest => ({
      id: `dispatch-${agentName}`,
      agent_name: agentName,
      message,
      status: "pending",
      created_at: "2026-04-07T12:00:00.000Z",
    }),
    getPendingDispatchRequests: () => [],
    prioritizeTask: () => false,
    insertVerificationResult: () => undefined,
    getVerificationStats: () => null,
    getLatestVerificationRecord: (taskId: string) =>
      opts.verificationRecord?.task_id === taskId ? (opts.verificationRecord ?? null) : null,
    getQualityHealthReport: () =>
      opts.qualityReport ?? {
        generated_at: "2026-04-07T12:00:00.000Z",
        window_tasks: 20,
        threshold: 0.75,
        total_task_count: 0,
        scored_task_count: 0,
        null_score_count: 0,
        below_threshold_count: 0,
        system_avg_score: null,
        per_agent: [],
      },
  };
}

async function runTelegramCommand(store: IStateStore, text: string): Promise<string> {
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  const savedChat = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "token";
  process.env.TELEGRAM_CHAT_ID = "42";

  let messageText = "";
  let delivered = false;
  let resolveSent: (() => void) | undefined;
  const sent = new Promise<void>((resolve) => {
    resolveSent = resolve;
  });

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(url);
    if (endpoint.includes("/getUpdates")) {
      if (delivered) {
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
      }
      delivered = true;
      return new Response(
        JSON.stringify({
          ok: true,
          result: [
            {
              update_id: 1,
              message: {
                message_id: 1,
                chat: { id: 42 },
                text,
              },
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (endpoint.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      messageText = body.text ?? "";
      resolveSent?.();
      return new Response("{}", { status: 200 });
    }

    return new Response("{}", { status: 200 });
  });

  const handler = new TelegramCommandHandler(store, { pollIntervalMs: 1 });
  const stop = handler.start();

  await sent;
  stop();
  await new Promise((resolve) => setTimeout(resolve, 0));

  fetchSpy.mockRestore();
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  if (savedChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = savedChat;

  return messageText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TelegramCommandHandler de-escalation commands", () => {
  it("acknowledges a specific escalated task and returns it to pending", async () => {
    const task = makeTask({
      id: "01HZXAAA000000000000000001",
      title: "Health-check follow-up",
      source_ref: "health-check-fail:agent-a",
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, "/ack health-check-fail:agent-a");

    expect(task.status).toBe("pending");
    expect(reply).toContain("De-escalated");
    expect(reply).toContain("health-check-fail:agent-a");

    const decisions = store.getRecentSupervisorDecisions(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("ack");
    expect(decisions[0].outcome).toBe("de-escalated");
  });

  it("shows escalated tasks and issue age heatmap in /status", async () => {
    const task = makeTask({
      id: "01HZXAAA000000000000000021",
      title: "Escalated status task",
      source_ref: "#501",
      created_at: "2026-03-01T12:00:00.000Z",
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, "/status");

    expect(reply).toContain("Escalated tasks: 1");
    expect(reply).toContain("Escalated status task");
    expect(reply).toContain("Issue age heatmap");
  });
});

describe("/score command — task quality lookup", () => {
  const TASK_ID = "01KP65ZE0000000000000000AA";

  it("returns usage hint when no task ID is provided", async () => {
    const store = makeStore([]);
    const reply = await runTelegramCommand(store, "/score");
    expect(reply).toContain("Usage");
    expect(reply).toContain("/score");
    expect(reply).toContain("task-id");
  });

  it("returns not-found message for an unknown task ID", async () => {
    const store = makeStore([]);
    const reply = await runTelegramCommand(store, "/score 01UNKNOWN0000000000000000");
    expect(reply).toContain("not found");
    expect(reply).toContain("01UNKNOWN0000000000000000");
  });

  it("returns score, status, and agent for a verified task (exact ID)", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Implement feature X",
      agent_name: "claude-agent-orchestrator",
      task_type: "implementation",
      status: "done",
      verification_status: "approved",
      quality_score: 0.88,
      verification_notes: "Good implementation.",
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("Task Score");
    expect(reply).toContain("Implement feature X");
    expect(reply).toContain("claude-agent-orchestrator");
    expect(reply).toContain("approved");
    expect(reply).toContain("0.88");
    expect(reply).toContain("88");
  });

  it("matches task by short ID prefix (at least 8 chars)", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Prefix match task",
      agent_name: "claude-proxy",
      status: "done",
      verification_status: "rejected",
      quality_score: 0.55,
    });
    const store = makeStore([task]);

    // Only the first 8 chars of the ID
    const reply = await runTelegramCommand(store, `/score 01KP65ZE`);

    expect(reply).toContain("Prefix match task");
    expect(reply).toContain("rejected");
    expect(reply).toContain("0.55");
  });

  it("shows not-yet-verified message when task has no verification data", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Unverified task",
      status: "done",
      verification_status: null,
      quality_score: null,
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("not yet verified");
  });

  it("shows hard-block indicator when blocked_reason is hard_block_sub50", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Hard blocked task",
      agent_name: "claude-research-agent",
      status: "done",
      verification_status: "rejected",
      quality_score: 0.38,
    });
    const verRecord: VerificationResultRecord = {
      id: 1,
      task_id: TASK_ID,
      score: 0.38,
      first_pass: 0,
      rejection_reason: "Critical implementation failure",
      blocked_reason: "hard_block_sub50",
      threshold: 0.80,
      agent_id: "claude-research-agent",
      timestamp: "2026-04-14T12:00:00.000Z",
    };
    const store = makeStore([task], { verificationRecord: verRecord });

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("hard block");
    expect(reply).toContain("0.38");
  });

  it("shows quality_explanation when present", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Task with explanation",
      status: "done",
      verification_status: "rejected",
      quality_score: 0.65,
      quality_explanation: "Scored 0.65: the test coverage dimension was weak, missing edge cases for the retry path.",
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("Quality explanation");
    expect(reply).toContain("test coverage dimension was weak");
  });

  it("shows dimension breakdown when verification_notes contains Quality Dimensions section", async () => {
    const dimensionNotes = [
      "## Quality Dimensions Breakdown",
      "- Correctness: 90/100 ✓ (logic correct)",
      "- Completeness: 70/100 ✗ (requirements partially met)",
      "- Test Coverage: 60/100 ✗ (edge cases missing)",
      "- Code Quality: 80/100 ✓ (readable)",
    ].join("\n");

    const task = makeTask({
      id: TASK_ID,
      title: "Dimension breakdown task",
      status: "done",
      verification_status: "rejected",
      quality_score: 0.75,
      verification_notes: dimensionNotes,
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("Dimensions");
    expect(reply).toContain("Correctness");
    expect(reply).toContain("Completeness");
  });

  it("shows score bar in the reply", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Score bar test",
      status: "done",
      verification_status: "approved",
      quality_score: 0.80,
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    // Score bar uses ▓ (filled) and ░ (empty) chars
    expect(reply).toMatch(/[▓░]/);
  });

  it("includes dashboard link footer", async () => {
    const task = makeTask({
      id: TASK_ID,
      title: "Footer test",
      status: "done",
      verification_status: "approved",
      quality_score: 0.90,
    });
    const store = makeStore([task]);

    const reply = await runTelegramCommand(store, `/score ${TASK_ID}`);

    expect(reply).toContain("/tasks/");
    expect(reply).toContain(TASK_ID);
  });
});

describe("/quality command — live quality health snapshot", () => {
  it("renders a summary table with null-rate, below-threshold rate, and downward trend flags", async () => {
    const qualityReport: QualityHealthReport = {
      generated_at: "2026-04-07T12:00:00.000Z",
      window_tasks: 20,
      threshold: 0.75,
      total_task_count: 40,
      scored_task_count: 29,
      null_score_count: 11,
      below_threshold_count: 6,
      system_avg_score: 0.812,
      per_agent: [
        {
          agent_name: "agent-a",
          task_count: 20,
          scored_task_count: 17,
          null_score_count: 3,
          null_score_rate: 0.15,
          below_threshold_count: 2,
          below_threshold_rate: 2 / 17,
          rolling_avg_score: 0.88,
          recent_avg_score: 0.82,
          previous_avg_score: 0.91,
          trend_delta: -0.09,
          trending_downward: true,
        },
        {
          agent_name: "agent-b",
          task_count: 20,
          scored_task_count: 12,
          null_score_count: 8,
          null_score_rate: 0.4,
          below_threshold_count: 4,
          below_threshold_rate: 4 / 12,
          rolling_avg_score: 0.74,
          recent_avg_score: 0.75,
          previous_avg_score: 0.73,
          trend_delta: 0.02,
          trending_downward: false,
        },
      ],
    };
    const store = makeStore([], { qualityReport });

    const reply = await runTelegramCommand(store, "/quality");

    expect(reply).toContain("Quality Health");
    expect(reply).toContain("System avg");
    expect(reply).toContain("agent-a");
    expect(reply).toContain("agent-b");
    expect(reply).toContain("Null scores");
    expect(reply).toContain("Below threshold");
    expect(reply).toContain("Trending downward");
    expect(reply).toContain("↘");
  });

  it("defaults to 20 tasks per agent when no window is provided", async () => {
    const store = makeStore([], {
      qualityReport: {
        generated_at: "2026-04-07T12:00:00.000Z",
        window_tasks: 20,
        threshold: 0.75,
        total_task_count: 0,
        scored_task_count: 0,
        null_score_count: 0,
        below_threshold_count: 0,
        system_avg_score: null,
        per_agent: [],
      },
    });

    const reply = await runTelegramCommand(store, "/quality");

    expect(reply).toContain("last 20 tasks per agent");
    expect(reply).toContain("No quality scores recorded yet");
  });
});
