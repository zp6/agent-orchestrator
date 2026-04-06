import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Supervisor, isConcreteDispatch, extractIssueRefs, isDecisionAlreadyResolved } from "./supervisor.js";
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

// Mock issue-state-bridge so isDecisionAlreadyResolved falls through to execSync
// and gateResolvedIssues can be tested with controlled responses
const mockLiveValidateForDispatch = vi.fn().mockReturnValue(null);
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

  it("parses rationale field from LLM response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        {
          action: "dispatch",
          agentName: "agent-a",
          message: "Implement issue #42 from owner/a",
          reason: "Issue #42 is open",
          rationale: "Issue #42 was opened 2 days ago with high user impact. No prior attempts. Success means a PR that closes #42.",
        },
      ])}],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();

    expect(decisions).toHaveLength(1);
    expect(decisions[0].rationale).toBe(
      "Issue #42 was opened 2 days ago with high user impact. No prior attempts. Success means a PR that closes #42.",
    );
  });

  it("handles missing rationale gracefully", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { action: "dispatch", agentName: "agent-a", message: "Fix issue #10", reason: "Issue open" },
      ])}],
    });

    const supervisor = new Supervisor(config, store);
    const decisions = await supervisor.review();

    expect(decisions).toHaveLength(1);
    expect(decisions[0].rationale).toBeUndefined();
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

  describe("supervisor memory across cycles", () => {
    it("includes prior decisions in context when they exist", async () => {
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: "agent-a",
        reason: "Implementing issue #42",
        message: "Please implement issue #42",
        outcome: "dispatched",
        task_id: "01ABC123",
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain("## Recent Supervisor Decisions");
      expect(prompt).toContain("dispatch → agent-a");
      expect(prompt).toContain("Implementing issue #42");
      expect(prompt).toContain("outcome: dispatched");
    });

    it("omits prior decisions section when no decisions recorded", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).not.toContain("## Recent Supervisor Decisions");
    });

    it("includes task_id in decision context when available", async () => {
      store.addSupervisorDecision({
        action: "follow-up",
        agent_name: "agent-b",
        reason: "Branch not pushed",
        message: "Push your branch",
        outcome: "dispatched",
        task_id: "01DEADBEEF",
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain("task:01DEADBE");
    });

    it("limits prior decisions to 10 in context", async () => {
      for (let i = 0; i < 15; i++) {
        store.addSupervisorDecision({
          action: "none",
          reason: `Decision ${i}`,
          outcome: "none",
        });
      }

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      // Count occurrences of "outcome: none" — should be exactly 10
      const matches = (prompt.match(/outcome: none/g) ?? []).length;
      expect(matches).toBe(10);
    });
  });

  describe("research findings in context (issue #428)", () => {
    it("includes approved research findings in supervisor context", async () => {
      // Create an approved research task with findings
      const task = store.createTask({
        title: "Research: Agent scaling patterns",
        source: "manual",
        agent_name: "agent-a",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Key finding: Horizontal scaling with pool-based routing outperforms round-robin by 40% under load. Recommendation: implement health-aware pool selection.",
        verification_status: "approved",
        quality_score: 0.92,
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain("## Recent Research Findings");
      expect(prompt).toContain("Research: Agent scaling patterns");
      expect(prompt).toContain("score: 0.9");
      expect(prompt).toContain("Horizontal scaling with pool-based routing");
    });

    it("shows linked status when research has implementation issues filed", async () => {
      // Create an approved research task
      const researchTask = store.createTask({
        title: "Research: Model tiering",
        source: "manual",
        agent_name: "agent-a",
        task_type: "research",
      });
      store.updateTask(researchTask.id, {
        status: "done",
        result: "Finding: Use Haiku for routing, Sonnet for implementation, Opus for verification.",
        verification_status: "approved",
        quality_score: 0.88,
      });

      // Create a research-link bookkeeping record (simulating what research-linker does)
      const linkTask = store.createTask({
        title: `[research-link] Analyzed: Research: Model tiering`,
        source: "manual",
        source_ref: `research-link:${researchTask.id}`,
        task_type: "implementation",
      });
      store.updateTask(linkTask.id, { status: "done" });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain("implementation issues filed");
    });

    it("shows not-yet-linked status for unprocessed research", async () => {
      const task = store.createTask({
        title: "Research: New topic",
        source: "manual",
        agent_name: "agent-b",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Some findings here.",
        verification_status: "approved",
        quality_score: 0.85,
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).toContain("not yet linked to implementation");
    });

    it("omits research findings section when no approved research exists", async () => {
      // Create a non-research task
      const task = store.createTask({
        title: "Implementation task",
        source: "manual",
        agent_name: "agent-a",
      });
      store.updateTask(task.id, { status: "done", result: "Done" });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      expect(prompt).not.toContain("## Recent Research Findings");
    });

    it("excludes research with quality score below threshold", async () => {
      const task = store.createTask({
        title: "Research: Low quality",
        source: "manual",
        agent_name: "agent-a",
        task_type: "research",
      });
      store.updateTask(task.id, {
        status: "done",
        result: "Mediocre findings.",
        verification_status: "approved",
        quality_score: 0.5,
      });

      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const supervisor = new Supervisor(config, store);
      await supervisor.review();

      const prompt = mockCreate.mock.calls[0][0].messages[0].content;
      // The dedicated research section should not appear — low quality research
      // is excluded. (It may still appear in "Recent Completed Tasks" which
      // shows ALL done tasks regardless of quality, but that's expected.)
      expect(prompt).not.toContain("## Recent Research Findings");
    });
  });
});

describe("extractIssueRefs", () => {
  it("extracts simple #N references", () => {
    expect(extractIssueRefs("Fix issue #42 and #43")).toEqual([42, 43]);
  });

  it("deduplicates repeated references", () => {
    expect(extractIssueRefs("Relates to #42 and also #42")).toEqual([42]);
  });

  it("extracts from combined message and reason text", () => {
    expect(extractIssueRefs("Branch pushed for issue #220 in task")).toEqual([220]);
  });

  it("returns empty array when no refs present", () => {
    expect(extractIssueRefs("No issue reference here")).toEqual([]);
  });
});

describe("isDecisionAlreadyResolved", () => {
  let execSyncMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const cp = await import("node:child_process");
    execSyncMock = vi.mocked(cp.execSync);
    execSyncMock.mockReset();
  });

  it("returns false when no issue refs found in text", () => {
    const result = isDecisionAlreadyResolved(
      "Push your branch to remote",
      "Branch not pushed",
      "owner/repo",
    );
    expect(result).toBe(false);
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("returns true when all referenced issues are CLOSED", () => {
    execSyncMock.mockReturnValue("CLOSED\n");
    const result = isDecisionAlreadyResolved(
      "Issue #42 needs attention",
      "Issue #42 still open",
      "owner/repo",
    );
    expect(result).toBe(true);
  });

  it("returns false when a referenced issue is OPEN", () => {
    execSyncMock.mockReturnValue("OPEN\n");
    const result = isDecisionAlreadyResolved(
      "Issue #42 needs attention",
      "Issue #42 still open",
      "owner/repo",
    );
    expect(result).toBe(false);
  });

  it("returns true when all referenced PRs are MERGED", () => {
    // First call (gh issue view) throws, second call (gh pr view) returns MERGED
    execSyncMock
      .mockImplementationOnce(() => { throw new Error("not an issue"); })
      .mockReturnValue("MERGED\n");
    const result = isDecisionAlreadyResolved(
      "PR #99 needs review",
      "PR still open",
      "owner/repo",
    );
    expect(result).toBe(true);
  });

  it("returns false when one of multiple refs is OPEN", () => {
    execSyncMock
      .mockReturnValueOnce("CLOSED\n")  // #42 is closed
      .mockReturnValueOnce("OPEN\n");   // #43 is open
    const result = isDecisionAlreadyResolved(
      "Issues #42 and #43 need attention",
      "Multiple issues",
      "owner/repo",
    );
    expect(result).toBe(false);
  });

  it("returns false when gh command fails unexpectedly", () => {
    execSyncMock.mockImplementation(() => { throw new Error("gh auth failure"); });
    const result = isDecisionAlreadyResolved(
      "Issue #42 open",
      "Need to fix #42",
      "owner/repo",
    );
    // Can't determine state — safe default is false (don't skip)
    expect(result).toBe(false);
  });

  it("returns false when no refs could be resolved (all gh calls fail)", () => {
    // Both issue and PR views throw for every ref — checkedAny stays false
    execSyncMock.mockImplementation(() => { throw new Error("not found"); });
    const result = isDecisionAlreadyResolved(
      "Issue #999 needs attention",
      "Issue not found in repo",
      "owner/repo",
    );
    expect(result).toBe(false);
  });
});

describe("gateResolvedIssues (issue #507)", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLiveValidateForDispatch.mockReturnValue(null);
    dbPath = join(tmpdir(), `orch-gate-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  it("passes dispatch decisions when issues are open", () => {
    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #42", reason: "Issue open" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(mockLiveValidateForDispatch).toHaveBeenCalledWith("owner/a", 42);
  });

  it("blocks dispatch when issue is closed", () => {
    mockLiveValidateForDispatch.mockReturnValue("issue owner/a#42 is closed");

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #42", reason: "Issue open" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].skipReason).toBe("issue owner/a#42 is closed");
  });

  it("blocks dispatch when issue has merged PR", () => {
    mockLiveValidateForDispatch.mockReturnValue("issue owner/a#42 has a merged PR");

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #42", reason: "Needs work" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].skipReason).toContain("merged PR");
  });

  it("blocks dispatch when issue has open PR", () => {
    mockLiveValidateForDispatch.mockReturnValue("issue owner/a#42 already has an open PR");

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "follow-up" as const, agentName: "agent-a", message: "Continue on #42", reason: "Follow up" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
  });

  it("passes non-dispatch actions through without checking", () => {
    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "none" as const, reason: "All good" },
      { action: "verify" as const, reason: "Needs check" },
      { action: "redeploy" as const, agentName: "agent-a", reason: "Stale" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(3);
    expect(result.blocked).toHaveLength(0);
    expect(mockLiveValidateForDispatch).not.toHaveBeenCalled();
  });

  it("passes dispatch to agent without github config", () => {
    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-b", message: "Fix issue #42", reason: "Needs work" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    // agent-b has no github config, so can't validate — passes through
    expect(result.passed).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(mockLiveValidateForDispatch).not.toHaveBeenCalled();
  });

  it("passes dispatch with no issue references", () => {
    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Create ROADMAP.md", reason: "Missing file" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
    expect(mockLiveValidateForDispatch).not.toHaveBeenCalled();
  });

  it("handles mixed decisions — some blocked, some passed", () => {
    mockLiveValidateForDispatch
      .mockReturnValueOnce("issue owner/a#42 is closed")  // first issue check
      .mockReturnValueOnce(null);                          // second issue check

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #42", reason: "Issue open" },
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #99", reason: "Issue open" },
      { action: "none" as const, reason: "All good" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(2); // #99 dispatch + none
    expect(result.blocked).toHaveLength(1); // #42 dispatch
  });

  it("allows dispatch when GitHub API check throws (safe default)", () => {
    mockLiveValidateForDispatch.mockImplementation(() => { throw new Error("gh timeout"); });

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix issue #42", reason: "Issue open" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    // API error — safe default is to allow dispatch (don't skip uncertain work)
    expect(result.passed).toHaveLength(1);
    expect(result.blocked).toHaveLength(0);
  });

  it("checks all issue refs — blocks if any is resolved", () => {
    mockLiveValidateForDispatch
      .mockReturnValueOnce(null)                                  // #42 is open
      .mockReturnValueOnce("issue owner/a#43 has a merged PR");   // #43 is resolved

    const supervisor = new Supervisor(config, store);
    const decisions = [
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix #42 and #43", reason: "Both need work" },
    ];

    const result = supervisor.gateResolvedIssues(decisions);

    expect(result.passed).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].skipReason).toContain("#43");
  });

  it("uses live (cache-bypassing) validation, not cached", () => {
    const supervisor = new Supervisor(config, store);
    supervisor.gateResolvedIssues([
      { action: "dispatch" as const, agentName: "agent-a", message: "Fix #42", reason: "Open" },
    ]);

    // Verify liveValidateForDispatch was called (not cachedValidateForDispatch)
    expect(mockLiveValidateForDispatch).toHaveBeenCalledWith("owner/a", 42);
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
