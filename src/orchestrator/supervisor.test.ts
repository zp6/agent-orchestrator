import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Supervisor, isConcreteDispatch } from "./supervisor.js";
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

// Mock execSync so tests don't call real gh CLI
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("[]"),
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

  describe("filterVagueDispatches", () => {
    it("drops dispatch to idle agent with vague message", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([
          {
            action: "dispatch",
            agentName: "agent-a",
            message: "Agent is idle with 0 active tasks. Last approved task completed. Check for work.",
            reason: "Agent is idle",
          },
        ])}],
      });

      const supervisor = new Supervisor(config, store);
      const decisions = await supervisor.review();
      // Vague dispatch to idle agent must be filtered out
      expect(decisions).toHaveLength(0);
    });

    it("allows dispatch to idle agent with specific issue reference", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([
          {
            action: "dispatch",
            agentName: "agent-a",
            message: "Please implement issue #42 from owner/a: Add retry logic to the dispatcher.",
            reason: "Issue #42 is open and unassigned",
          },
        ])}],
      });

      const supervisor = new Supervisor(config, store);
      const decisions = await supervisor.review();
      expect(decisions).toHaveLength(1);
      expect(decisions[0].action).toBe("dispatch");
    });

    it("allows dispatch to idle agent with concrete artifact keyword", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([
          {
            action: "dispatch",
            agentName: "agent-a",
            message: "Create file ROADMAP.md with the top 5 priorities for this repo.",
            reason: "ROADMAP.md missing",
          },
        ])}],
      });

      const supervisor = new Supervisor(config, store);
      const decisions = await supervisor.review();
      expect(decisions).toHaveLength(1);
    });

    it("allows dispatch to busy agent even without issue ref (no filter applies)", async () => {
      // Create an active task so agent-a is busy
      const task = store.createTask({ title: "Active task", source: "manual", agent_name: "agent-a" });
      store.updateTask(task.id, { status: "dispatched" });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([
          {
            action: "dispatch",
            agentName: "agent-a",
            message: "You are working on something — here is additional context.",
            reason: "Follow-up context",
          },
        ])}],
      });

      const supervisor = new Supervisor(config, store);
      const decisions = await supervisor.review();
      // Agent is busy, so the filter should not apply
      expect(decisions).toHaveLength(1);
    });

    it("allows non-dispatch actions through regardless of message content", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: JSON.stringify([
          { action: "none", reason: "All good" },
          { action: "verify", reason: "Task needs verification" },
          { action: "redeploy", agentName: "agent-a", reason: "New commits pushed" },
        ])}],
      });

      const supervisor = new Supervisor(config, store);
      const decisions = await supervisor.review();
      expect(decisions).toHaveLength(3);
    });
  });

  it("includes Open Issues section in context when gh returns data", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockReturnValue(
      JSON.stringify([{ number: 42, title: "Add retry logic" }]),
    );

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });

    const supervisor = new Supervisor(config, store);
    await supervisor.review();

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain("## Open Issues");
    expect(prompt).toContain("#42");
    expect(prompt).toContain("Add retry logic");
  });

  it("omits Open Issues section when gh fails", async () => {
    const { execSync } = await import("node:child_process");
    vi.mocked(execSync).mockImplementation(() => { throw new Error("gh not found"); });

    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "[]" }],
    });

    const supervisor = new Supervisor(config, store);
    await supervisor.review();

    const prompt = mockCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).not.toContain("## Open Issues");
  });
});

describe("isConcreteDispatch", () => {
  it("returns true for message with issue ref", () => {
    expect(isConcreteDispatch("Please implement issue #42 from owner/repo")).toBe(true);
    expect(isConcreteDispatch("Fix owner/repo#17 — missing Closes line")).toBe(true);
  });

  it("returns true for message with artifact keyword", () => {
    expect(isConcreteDispatch("Create file ROADMAP.md with top 5 priorities")).toBe(true);
    expect(isConcreteDispatch("Open a PR for the streaming fix")).toBe(true);
    expect(isConcreteDispatch("Write a test for the router module")).toBe(true);
    expect(isConcreteDispatch("Implement the new retry logic")).toBe(true);
    expect(isConcreteDispatch("Add retry to dispatcher")).toBe(true);
    expect(isConcreteDispatch("Fix the crash in verifier")).toBe(true);
    expect(isConcreteDispatch("Update CLAUDE.md with new commands")).toBe(true);
    expect(isConcreteDispatch("Push branch to remote")).toBe(true);
  });

  it("returns false for vague status-check messages", () => {
    expect(isConcreteDispatch("Agent is idle with 0 active tasks. Last approved task completed. Check for work.")).toBe(false);
    expect(isConcreteDispatch("You are idle. The system looks healthy. No action needed.")).toBe(false);
    expect(isConcreteDispatch("Daemon is running, PR is open, system is normal.")).toBe(false);
    expect(isConcreteDispatch("Check your queue for pending items.")).toBe(false);
  });

  it("returns false for empty or whitespace messages", () => {
    expect(isConcreteDispatch("")).toBe(false);
    expect(isConcreteDispatch("   ")).toBe(false);
  });
});
