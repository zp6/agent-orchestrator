import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import { detectAndCreateFollowUps, formatFollowUpNote } from "./cross-repo-tracker.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { findExistingPRsForIssue, isIssueOpen } from "../triggers/github.js";

vi.mock("node:child_process");

vi.mock("../triggers/github.js", () => ({
  isIssueOpen: vi.fn().mockReturnValue(true),
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
}));

const mockExecFileSync = vi.mocked(childProcess.execFileSync);
const mockIsIssueOpen = vi.mocked(isIssueOpen);
const mockFindExistingPRsForIssue = vi.mocked(findExistingPRsForIssue);

// Minimal config with three agents across different repos
const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3471" },
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orch",
  agents: {
    "claude-agent-orchestrator": {
      dir: "claude-agent-orchestrator",
      description: "Core orchestrator",
      capabilities: [],
      github: "rapartlu/agent-orchestrator",
      owns_topics: ["orchestrator"],
    },
    "claude-orchestrator-reviewer": {
      dir: "claude-orchestrator-reviewer",
      description: "PR reviewer",
      capabilities: [],
      github: "rapartlu/agent-reviewer",
      owns_topics: ["review"],
    },
    "claude-orchestrator-dashboard": {
      dir: "claude-orchestrator-dashboard",
      description: "Dashboard CLI",
      capabilities: [],
      github: "rapartlu/agent-dashboard",
      owns_topics: ["dashboard", "cli"],
    },
  },
  providers: { claude: { model: "claude-3", limits: { hourly: 1000000, daily: 5000000, weekly: 25000000 } } },
} as unknown as OrchestratorConfig;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01TASK001",
    title: "Add supervisor-log CLI command and state updates",
    description:
      "Issue #369 requires both reviewer state changes and a dashboard CLI command `orch supervisor-log`. " +
      "The dashboard should implement the `orch supervisor-log` CLI command to display recent supervisor decisions.",
    source: "github",
    source_ref: "rapartlu/agent-reviewer#369",
    status: "done",
    agent_name: "claude-orchestrator-reviewer",
    conversation_id: "conv-001",
    result: "Implemented state layer changes and Telegram notifications.",
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
    reported: 0,
    created_at: "2026-04-06T00:00:00Z",
    updated_at: "2026-04-06T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function mockOpenSourceIssue(): void {
  mockExecFileSync.mockReturnValueOnce("OPEN\n" as unknown as Buffer);
}

function mockOpenSourceIssueWithNoBlockingPR(): void {
  mockExecFileSync
    .mockReturnValueOnce("OPEN\n" as unknown as Buffer)
    .mockReturnValueOnce(JSON.stringify([]) as unknown as Buffer);
}

function mockOpenSourceIssueWithBlockingPR(prNumber = 5): void {
  mockExecFileSync
    .mockReturnValueOnce("OPEN\n" as unknown as Buffer)
    .mockReturnValueOnce(
      JSON.stringify([
        { number: prNumber, body: "Implements the fix.\n\nCloses #369" },
      ]) as unknown as Buffer,
    );
}

function mockClosedSourceIssue(): void {
  mockExecFileSync.mockReturnValueOnce("CLOSED\n" as unknown as Buffer);
}

describe("detectAndCreateFollowUps", () => {
  it("returns empty array for research tasks", () => {
    const task = makeTask({ task_type: "research" });
    const result = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(result).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("skips follow-up creation when the source issue already has a linked PR", () => {
    mockFindExistingPRsForIssue.mockReturnValueOnce([
      {
        number: 88,
        title: "Close out parent issue",
        url: "https://github.com/rapartlu/agent-reviewer/pull/88",
        state: "open",
        isDraft: false,
      },
    ]);

    const followUps = detectAndCreateFollowUps(makeTask(), "claude-orchestrator-reviewer", config);

    expect(followUps).toEqual([]);
    expect(mockIsIssueOpen).not.toHaveBeenCalled();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("skips follow-up creation when the source issue is closed", () => {
    mockFindExistingPRsForIssue.mockReturnValueOnce([]);
    mockIsIssueOpen.mockReturnValueOnce(false);

    const followUps = detectAndCreateFollowUps(makeTask(), "claude-orchestrator-reviewer", config);

    expect(followUps).toEqual([]);
    expect(mockIsIssueOpen).toHaveBeenCalledWith("rapartlu/agent-reviewer", 369);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("creates a follow-up issue when peer repo is mentioned with action verb", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    // dedup check returns empty list → no duplicate
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([]) as unknown as Buffer) // gh issue list (dedup)
      .mockReturnValueOnce("https://github.com/rapartlu/agent-dashboard/issues/42\n" as unknown as Buffer); // gh issue create

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);

    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({
      repo: "rapartlu/agent-dashboard",
      issueNumber: 42,
      issueUrl: "https://github.com/rapartlu/agent-dashboard/issues/42",
    });

    // Should have called gh issue create with dashboard repo
    const createCall = mockExecFileSync.mock.calls.find((c) =>
      c[0] === "gh" && Array.isArray(c[1]) && c[1].includes("create"),
    );
    expect(createCall).toBeDefined();
    const createArgs = createCall![1] as string[];
    expect(createArgs).toContain("rapartlu/agent-dashboard");
    expect(createArgs).toContain("orchestrator");
  });

  it("does NOT create a follow-up for mentions of own repo", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    const task = makeTask({
      description:
        "Update the reviewer state layer (rapartlu/agent-reviewer) to track supervisor decisions.",
      source_ref: "rapartlu/agent-reviewer#370",
    });

    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(followUps).toEqual([]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("does NOT create follow-up when peer repo is mentioned without action verb", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    const task = makeTask({
      description:
        "See also: the dashboard repo rapartlu/agent-dashboard provides CLI context for reference.",
      title: "Research dashboard architecture",
      task_type: "implementation",
    });

    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(followUps).toEqual([]);
  });

  it("skips creation when a duplicate issue already exists", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    // dedup check finds an existing issue with a similar title
    mockExecFileSync.mockReturnValueOnce(
      JSON.stringify([
        { title: "[orchestrator-dashboard] Follow-up from #369: Add supervisor-log CLI command and st" },
      ]) as unknown as Buffer,
    );

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(followUps).toEqual([]);
    // gh issue create should NOT have been called
    const createCalls = mockExecFileSync.mock.calls.filter((c) =>
      c[0] === "gh" && Array.isArray(c[1]) && c[1].includes("create"),
    );
    expect(createCalls).toHaveLength(0);
  });

  it("returns empty when execSync fails (fail-open)", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([]) as unknown as Buffer) // dedup
      .mockImplementationOnce(() => { throw new Error("gh: auth error"); }); // create fails

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(followUps).toEqual([]);
  });

  it("uses short agent name format in issue title", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([]) as unknown as Buffer)
      .mockReturnValueOnce("https://github.com/rapartlu/agent-dashboard/issues/99\n" as unknown as Buffer);

    const task = makeTask();
    detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);

    const createCall = mockExecFileSync.mock.calls.find((c) =>
      c[0] === "gh" && Array.isArray(c[1]) && c[1].includes("create"),
    );
    expect(createCall).toBeDefined();
    const createArgs = createCall![1] as string[];
    // The --title arg follows "create", find it by position after "--title"
    const titleIdx = createArgs.indexOf("--title");
    const titleValue = titleIdx >= 0 ? createArgs[titleIdx + 1] : "";
    // Title should reference the peer agent (dashes converted to spaces in short name)
    expect(titleValue).toContain("orchestrator dashboard");
    // And reference the parent issue number
    expect(titleValue).toContain("#369");
  });

  it("detects peer repo by agent name (short form)", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    mockExecFileSync
      .mockReturnValueOnce(JSON.stringify([]) as unknown as Buffer)
      .mockReturnValueOnce("https://github.com/rapartlu/agent-dashboard/issues/5\n" as unknown as Buffer);

    const task = makeTask({
      description:
        "The claude-orchestrator-dashboard should implement the `orch supervisor-log` command.",
      title: "Add supervisor-log command",
      source_ref: "rapartlu/agent-reviewer#369",
    });

    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]!.repo).toBe("rapartlu/agent-dashboard");
  });

  it("skips follow-up filing when the source issue is closed", () => {
    mockClosedSourceIssue();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);

    expect(followUps).toEqual([]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync.mock.calls[0]?.[1]).toEqual([
      "issue",
      "view",
      "369",
      "--repo",
      "rapartlu/agent-reviewer",
      "--json",
      "state",
      "-q",
      ".state",
    ]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping cross-repo follow-ups: source issue is closed"),
    );
    consoleSpy.mockRestore();
  });

  it("skips follow-up filing when an open PR already closes the source issue", () => {
    mockOpenSourceIssueWithBlockingPR(11);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config);

    expect(followUps).toEqual([]);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    expect(mockExecFileSync.mock.calls[1]?.[1]).toEqual([
      "pr",
      "list",
      "--repo",
      "rapartlu/agent-reviewer",
      "--state",
      "open",
      "--json",
      "number,body",
      "-L",
      "100",
    ]);
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("already linked in PR #11");
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("claude-orchestrator-reviewer");
    expect(consoleSpy.mock.calls[0]?.[0]).toContain("rapartlu/agent-reviewer#369");
    consoleSpy.mockRestore();
  });

  it("invokes onAvoided callback when a blocking PR skips follow-up creation (AC#3)", () => {
    mockOpenSourceIssueWithBlockingPR(11);
    const onAvoided = vi.fn();

    const task = makeTask();
    const followUps = detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config, onAvoided);

    expect(followUps).toEqual([]);
    expect(onAvoided).toHaveBeenCalledOnce();
  });

  it("does NOT invoke onAvoided when source issue is closed (not an avoidance)", () => {
    mockClosedSourceIssue();
    const onAvoided = vi.fn();

    const task = makeTask();
    detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config, onAvoided);

    expect(onAvoided).not.toHaveBeenCalled();
  });

  it("does NOT invoke onAvoided when no follow-up is needed (no peer repo mention)", () => {
    mockOpenSourceIssueWithNoBlockingPR();
    const onAvoided = vi.fn();

    const task = makeTask({
      description: "Internal orchestrator change only — no peer repos involved.",
      title: "Refactor internal state",
    });
    detectAndCreateFollowUps(task, "claude-orchestrator-reviewer", config, onAvoided);

    expect(onAvoided).not.toHaveBeenCalled();
  });
});

describe("formatFollowUpNote", () => {
  it("returns empty string when no follow-ups", () => {
    expect(formatFollowUpNote([])).toBe("");
  });

  it("formats single follow-up with acceptance criteria wording", () => {
    const note = formatFollowUpNote([
      { repo: "rapartlu/agent-dashboard", issueNumber: 42, issueUrl: "https://github.com/rapartlu/agent-dashboard/issues/42" },
    ]);
    expect(note).toContain("Created follow-up issue #42 on rapartlu/agent-dashboard");
    expect(note).toContain("https://github.com/rapartlu/agent-dashboard/issues/42");
  });

  it("formats multiple follow-ups", () => {
    const note = formatFollowUpNote([
      { repo: "rapartlu/agent-dashboard", issueNumber: 42, issueUrl: "https://github.com/rapartlu/agent-dashboard/issues/42" },
      { repo: "rapartlu/agent-reviewer", issueNumber: 7, issueUrl: "https://github.com/rapartlu/agent-reviewer/issues/7" },
    ]);
    expect(note).toContain("Created follow-up issue #42 on rapartlu/agent-dashboard");
    expect(note).toContain("Created follow-up issue #7 on rapartlu/agent-reviewer");
  });
});
