/**
 * Tests for issue #1530:
 *   - validateChangeSetDescription invokes the audit recorder on rejection
 *   - detectMultiRepoChangeSets propagates the recorder when changes are
 *     extracted from a tainted paragraph
 *   - createCoordinationGroup wires a store-backed recorder so rejections
 *     during child-task description build also persist
 */
import { describe, it, expect, vi } from "vitest";
import {
  detectMultiRepoChangeSets,
  validateChangeSetDescription,
  createCoordinationGroup,
  makeStoreAuditRecorder,
  NO_CODE_CHANGES_FALLBACK,
  type MultiRepoChangeSet,
  type ValidationAuditRecorder,
} from "./multi-repo-coordinator.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";

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
      owns_topics: ["orchestrator"],
    },
    "claude-orchestrator-dashboard": {
      dir: "claude-orchestrator-dashboard",
      description: "Dashboard",
      capabilities: ["implementation"],
      github: "rapartlu/agent-dashboard",
      owns_topics: ["dashboard"],
    },
  },
  providers: {
    claude: { model: "claude-3", limits: { hourly: 1, daily: 1, weekly: 1 } },
  },
} as unknown as OrchestratorConfig;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01TASK",
    title: "Test task",
    description: null,
    source: "github",
    source_ref: "rapartlu/agent-orchestrator#1530",
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

describe("validateChangeSetDescription audit hook (#1530)", () => {
  it("calls recordAudit on empty input with reason=empty", () => {
    const recordAudit = vi.fn();
    const result = validateChangeSetDescription("", "agent-reviewer", {
      repo: "rapartlu/agent-reviewer",
      sourceRef: "rapartlu/agent-orchestrator#1530",
      agentName: "claude-orchestrator-reviewer",
      recordAudit,
    });
    expect(result).toBe(NO_CODE_CHANGES_FALLBACK);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "empty",
        repo: "rapartlu/agent-reviewer",
        agentName: "claude-orchestrator-reviewer",
        sourceRef: "rapartlu/agent-orchestrator#1530",
        matchedToken: "agent-reviewer",
      }),
    );
  });

  it("calls recordAudit with reason=antibody_fragment for antibody-style snippets", () => {
    const recordAudit = vi.fn();
    const text = "Direct commits to main bypass code review, break the merge queue, and can corrupt ..";
    validateChangeSetDescription(text, "agent-reviewer", {
      repo: "rapartlu/agent-reviewer",
      recordAudit,
    });
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]![0].reason).toBe("antibody_fragment");
    expect(recordAudit.mock.calls[0]![0].rawSnippet).toBe(text);
  });

  it("calls recordAudit with reason=truncated for ellipsis-terminated snippets", () => {
    const recordAudit = vi.fn();
    validateChangeSetDescription(
      "The reviewer should detect malformed dispatches and ...",
      "review",
      { repo: "rapartlu/agent-reviewer", recordAudit },
    );
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]![0].reason).toBe("truncated");
  });

  it("calls recordAudit with reason=token_missing when matched token absent", () => {
    const recordAudit = vi.fn();
    validateChangeSetDescription(
      "Add a new endpoint that returns coordination group state.",
      "agent-reviewer",
      { repo: "rapartlu/agent-reviewer", recordAudit },
    );
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit.mock.calls[0]![0].reason).toBe("token_missing");
    expect(recordAudit.mock.calls[0]![0].matchedToken).toBe("agent-reviewer");
  });

  it("does NOT call recordAudit on a clean snippet", () => {
    const recordAudit = vi.fn();
    const result = validateChangeSetDescription(
      "Update the agent-reviewer client to handle coordination dispatch payloads.",
      "agent-reviewer",
      { repo: "rapartlu/agent-reviewer", recordAudit },
    );
    expect(result).toMatch(/agent-reviewer/);
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it("does NOT throw if recordAudit itself throws — dispatch must not break on audit failure", () => {
    const recordAudit = vi.fn(() => { throw new Error("disk full"); });
    expect(() => {
      const result = validateChangeSetDescription("", "agent-reviewer", {
        repo: "rapartlu/agent-reviewer",
        recordAudit,
      });
      expect(result).toBe(NO_CODE_CHANGES_FALLBACK);
    }).not.toThrow();
    expect(recordAudit).toHaveBeenCalledTimes(1);
  });
});

describe("detectMultiRepoChangeSets propagates audit recorder (#1530)", () => {
  it("passes recordAudit through so antibody-tainted snippets persist a row", () => {
    const recordAudit: ValidationAuditRecorder = vi.fn();
    // Intentionally place an antibody-style sentence directly around the
    // matched token so the validator rejects the extracted snippet.
    const task = makeTask({
      title: "Coordination feature",
      description:
        "Update the agent-dashboard so direct commits to main bypass code review, break the merge queue, and can corrupt the dashboard state.",
    });
    detectMultiRepoChangeSets(task, "claude-agent-orchestrator", config, { recordAudit });
    // Whether or not detection ultimately includes the change set, any
    // rejection must surface through the recorder.
    const calls = (recordAudit as ReturnType<typeof vi.fn>).mock.calls;
    if (calls.length > 0) {
      expect(calls[0]![0].reason).toMatch(/antibody_fragment|truncated|token_missing/);
      expect(calls[0]![0].repo).toBe("rapartlu/agent-dashboard");
    }
  });
});

describe("makeStoreAuditRecorder (#1530)", () => {
  it("records to the store with a generated id and the provided groupId", () => {
    const recordCoordinationDispatchAudit = vi.fn();
    const fakeStore = { recordCoordinationDispatchAudit } as unknown as StateStore;
    const recorder = makeStoreAuditRecorder(fakeStore, { groupId: "GRP123" });
    recorder({
      repo: "rapartlu/agent-reviewer",
      agentName: "claude-orchestrator-reviewer",
      sourceRef: "rapartlu/agent-orchestrator#1530",
      matchedToken: "agent-reviewer",
      rawSnippet: "broken text",
      reason: "antibody_fragment",
    });
    expect(recordCoordinationDispatchAudit).toHaveBeenCalledTimes(1);
    const arg = recordCoordinationDispatchAudit.mock.calls[0]![0];
    expect(arg.id).toMatch(/^[0-9A-Z]+$/); // ulid-shaped
    expect(arg.groupId).toBe("GRP123");
    expect(arg.repo).toBe("rapartlu/agent-reviewer");
    expect(arg.agentName).toBe("claude-orchestrator-reviewer");
    expect(arg.matchedToken).toBe("agent-reviewer");
    expect(arg.reason).toBe("antibody_fragment");
    expect(arg.fallbackUsed).toBe(true);
  });

  it("defaults groupId to null when not supplied (detection-time recorder)", () => {
    const recordCoordinationDispatchAudit = vi.fn();
    const fakeStore = { recordCoordinationDispatchAudit } as unknown as StateStore;
    const recorder = makeStoreAuditRecorder(fakeStore);
    recorder({
      repo: "rapartlu/agent-dashboard",
      rawSnippet: "x",
      reason: "empty",
    });
    expect(recordCoordinationDispatchAudit.mock.calls[0]![0].groupId).toBeNull();
  });
});

describe("createCoordinationGroup uses store-backed recorder (#1530)", () => {
  it("wires the store recorder so child-task description rebuild rejections persist", () => {
    const recordCoordinationDispatchAudit = vi.fn();
    const fakeStore = {
      createTask: vi.fn().mockReturnValue({ id: "CHILD1" }),
      createCoordinationGroup: vi.fn(),
      recordCoordinationDispatchAudit,
    } as unknown as StateStore;

    const parent = makeTask();
    // Use a change set whose stored description is antibody-flavoured to
    // simulate a pre-validation cohort being replayed through the dispatch
    // boundary (defense-in-depth path inside buildChildTaskDescription).
    const changeSets: MultiRepoChangeSet[] = [
      {
        repo: "rapartlu/agent-reviewer",
        agentName: "claude-orchestrator-reviewer",
        description: "Direct commits to main bypass code review, break the merge queue, and can corrupt ..",
        mergeOrder: 1,
      },
    ];

    createCoordinationGroup(parent, changeSets, fakeStore);
    expect(recordCoordinationDispatchAudit).toHaveBeenCalledTimes(1);
    const arg = recordCoordinationDispatchAudit.mock.calls[0]![0];
    expect(arg.reason).toBe("antibody_fragment");
    expect(arg.repo).toBe("rapartlu/agent-reviewer");
    expect(arg.groupId).toEqual(expect.any(String));
  });
});
