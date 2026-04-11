import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramCommandHandler } from "../telegram/command-handler.js";
import type {
  AgentHealth,
  DispatchRequest,
  IStateStore,
  MergeQueueEntry,
  SupervisorDecisionQuery,
  SupervisorDecisionRecord,
  Task,
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

function makeStore(tasks: Task[]): IStateStore {
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
