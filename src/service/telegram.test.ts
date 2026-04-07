import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import { handleCommand } from "./telegram.js";
import type { OrchestratorConfig } from "../config/schema.js";

const { execMock, execSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execSync: execSyncMock,
}));

vi.mock("../triggers/github.js", () => ({
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  findBranchForIssue: vi.fn().mockReturnValue(null),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/tmp",
  agents: {
    "agent-a": {
      dir: "agent-a",
      description: "Primary",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/repo-a",
    },
    "agent-b": {
      dir: "agent-b",
      description: "Backup",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/repo-b",
    },
  },
};

function installGhFixtures(): void {
  execMock.mockImplementation((cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    if (cmd === "gh issue view 42 --repo owner/repo-a --json number -q .number") {
      cb(null, "42");
      return;
    }
    if (cmd === "gh issue view 42 --repo owner/repo-a --json number,title,body,url,state,labels") {
      cb(null, JSON.stringify({
        number: 42,
        title: "Fix stuck issue",
        body: "Need a fresh attempt",
        url: "https://github.com/owner/repo-a/issues/42",
        state: "OPEN",
        labels: [{ name: "orchestrator" }],
      }));
      return;
    }
    if (cmd === "gh issue view 7 --repo owner/repo-a --json number -q .number") {
      cb(null, "7");
      return;
    }
    if (cmd === "gh issue view 7 --repo owner/repo-a --json number,title,body,url,state,labels") {
      cb(null, JSON.stringify({
        number: 7,
        title: "Queued work",
        body: "Pick me next",
        url: "https://github.com/owner/repo-a/issues/7",
        state: "OPEN",
        labels: [],
      }));
      return;
    }
    cb(new Error("not found"), "");
  });
}

describe("handleCommand telegram operator controls", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
    installGhFixtures();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    }));
  });

  afterEach(() => {
    store.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("prioritizes an issue for the next daemon cycle", async () => {
    const reply = await handleCommand("/prioritize 7", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });

    expect(reply).toContain("owner/repo-a#7");
    expect(store.isSourceRefPriorityBoosted("github", "owner/repo-a#7")).toBe(true);
  });

  it("reassigns an issue immediately and clears prior failure history", async () => {
    const prior = store.createTask({
      title: "Old failed attempt",
      source: "github",
      source_ref: "owner/repo-a#42",
      agent_name: "agent-a",
    });
    store.updateTask(prior.id, { status: "failed", retry_count: 2, verification_status: "rejected" });

    const dispatch = vi.fn().mockResolvedValue({
      taskId: "task-42",
      agentName: "agent-b",
      response: { content: "done" },
    });

    const reply = await handleCommand("/reassign 42 agent-b", {
      config,
      store,
      dispatcher: { dispatch } as never,
    });

    expect(reply).toContain("owner/repo-a#42");
    expect(store.countFailuresForSourceRef("owner/repo-a#42")).toBe(0);
    expect(store.getPriorAttempts("owner/repo-a#42")).toEqual([]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.stringContaining("GitHub Issue #42: Fix stuck issue"),
      expect.objectContaining({
        agentName: "agent-b",
        source: "github",
        sourceRef: "owner/repo-a#42",
      }),
    );
  });

  it("de-escalates a GitHub issue via the ack command and clears processed trigger state", async () => {
    const task = store.createTask({
      title: "Escalated issue 42",
      source: "github",
      source_ref: "owner/repo-a#42",
      agent_name: "agent-a",
    });
    store.updateTask(task.id, { status: "escalated" });
    store.markProcessed("github", "owner/repo-a#42", task.id);

    const reply = await handleCommand("ack 42", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });

    expect(reply).toContain("owner/repo-a#42");
    expect(store.findEscalatedTask("owner/repo-a#42")).toBeUndefined();
    expect(store.getProcessedTriggerInfo("github", "owner/repo-a#42")).toBeUndefined();
    expect(store.getLogs(task.id).some((entry) => entry.content.includes("Telegram ack command"))).toBe(true);
    expect(store.findAllTasksBySourceRef("owner/repo-a#42")[0].status).toBe("failed");
  });

  it("de-escalates a health-check escalation via resolve without stripping the colon", async () => {
    const task = store.createTask({
      title: "Health check failed: agent-a",
      source: "manual",
      source_ref: "health-check-fail:agent-a",
      agent_name: "agent-a",
    });
    store.updateTask(task.id, { status: "escalated" });

    const reply = await handleCommand("/resolve health-check-fail:agent-a", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });

    expect(reply).toContain("health-check-fail:agent-a");
    expect(store.findEscalatedTask("health-check-fail:agent-a")).toBeUndefined();
    expect(store.findAllTasksBySourceRef("health-check-fail:agent-a")[0].status).toBe("failed");
  });

  it("de-escalates all active escalations when asked", async () => {
    const first = store.createTask({
      title: "Escalated issue 42",
      source: "github",
      source_ref: "owner/repo-a#42",
      agent_name: "agent-a",
    });
    const second = store.createTask({
      title: "Health check failed: agent-a",
      source: "manual",
      source_ref: "health-check-fail:agent-a",
      agent_name: "agent-a",
    });
    store.updateTask(first.id, { status: "escalated" });
    store.updateTask(second.id, { status: "escalated" });

    const reply = await handleCommand("dismiss all", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });

    expect(reply).toContain("2 task(s)");
    expect(store.findEscalatedTask("owner/repo-a#42")).toBeUndefined();
    expect(store.findEscalatedTask("health-check-fail:agent-a")).toBeUndefined();
    expect(store.findAllTasksBySourceRef("owner/repo-a#42")[0].status).toBe("failed");
    expect(store.findAllTasksBySourceRef("health-check-fail:agent-a")[0].status).toBe("failed");
  });

  it("lists currently escalated tasks from Telegram", async () => {
    const first = store.createTask({
      title: "Escalated issue 42",
      source: "github",
      source_ref: "owner/repo-a#42",
      agent_name: "agent-a",
    });
    const second = store.createTask({
      title: "Health check failed: agent-a",
      source: "manual",
      source_ref: "health-check-fail:agent-a",
      agent_name: "agent-b",
    });
    store.updateTask(first.id, { status: "escalated" });
    store.updateTask(second.id, { status: "escalated" });

    const reply = await handleCommand("escalated", {
      config,
      store,
      dispatcher: { dispatch: vi.fn() } as never,
    });

    expect(reply).toContain("Escalated Tasks (2)");
    expect(reply).toContain("owner/repo-a#42");
    expect(reply).toContain("health-check-fail:agent-a");
    expect(reply).toContain("deescalate <source_ref>");
  });
});
