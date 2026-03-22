import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Supervisor } from "./supervisor.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": { dir: "a", description: "Agent A", capabilities: ["test"], owns_topics: ["a"], github: "owner/a" },
    "agent-b": { dir: "b", description: "Agent B", capabilities: ["test"], owns_topics: ["b"] },
  },
};

describe("Supervisor", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `orch-super-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("returns decisions from LLM review", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { action: "follow-up", agentName: "agent-a", message: "Push your branch", reason: "Branch not pushed" },
      ])}],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();

    expect(decisions).toHaveLength(1);
    expect(decisions[0].action).toBe("follow-up");
    expect(decisions[0].agentName).toBe("agent-a");
  });

  it("returns empty array when no actions needed", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();
    expect(decisions).toHaveLength(0);
  });

  it("handles malformed LLM response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Everything looks fine!" }],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();
    expect(decisions).toHaveLength(0);
  });

  it("includes task context in the prompt", async () => {
    const task = store.createTask({ title: "Test task", source: "manual", agent_name: "agent-a" });
    store.updateTask(task.id, { status: "done", result: "Done" });

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });

    const supervisor = new Supervisor(config, store);
    await supervisor.review();

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("agent-a");
    expect(prompt).toContain("Test task");
  });

  it("handles LLM errors gracefully", async () => {
    mockCreate.mockRejectedValueOnce(new Error("Proxy down"));

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();
    expect(decisions).toHaveLength(0);
  });
});
