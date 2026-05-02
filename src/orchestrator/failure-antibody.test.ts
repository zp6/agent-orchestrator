import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { StateStore } from "../state/store.js";
vi.mock("../triggers/github.js", () => ({
  findExistingPRsForIssue: vi.fn(),
}));
import {
  applyFailureAntibodyFitness,
  classifyFailureErrorClass,
  harvestFailureAntibodyForTask,
  normaliseFailureSignature,
} from "./failure-antibody.js";
import { findExistingPRsForIssue } from "../triggers/github.js";

const mockFindExistingPRsForIssue = vi.mocked(findExistingPRsForIssue);

describe("failure antibody helpers", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-failure-antibody-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(dbPath + suffix);
      } catch {}
    }
  });

  it("normalises signatures and classifies common failure classes", () => {
    expect(normaliseFailureSignature("TypeError: Cannot read properties of undefined (reading 'foo') #42")).toContain("typeerror");
    expect(classifyFailureErrorClass("TypeError: Cannot read properties of undefined")).toBe("runtime");
    expect(classifyFailureErrorClass("gh auth login failed: permission denied")).toBe("authentication");
  });

  it("harvests a failure antibody from a rejected attempt followed by a successful retry", () => {
    const sourceRef = "owner/repo#42";
    mockFindExistingPRsForIssue.mockReturnValueOnce([
      {
        number: 84,
        title: "Fix null dereference",
        url: "https://github.com/owner/repo/pull/84",
        state: "merged",
        isDraft: false,
      },
    ]);
    const failed = store.createTask({
      title: "First attempt",
      source: "github",
      source_ref: sourceRef,
      agent_name: "claude-agent-orchestrator",
    });
    store.updateTask(failed.id, {
      status: "failed",
      verification_status: "rejected",
      verification_notes: "TypeError: Cannot read properties of undefined (reading 'foo')",
    });

    const approved = store.createTask({
      title: "Retry attempt",
      source: "github",
      source_ref: sourceRef,
      agent_name: "claude-agent-orchestrator",
    });
    store.updateTask(approved.id, {
      status: "done",
      verification_status: "approved",
      result: "Added a defensive null check and simplified the lookup path.",
      verification_notes: "Looks good",
    });

    const signal = harvestFailureAntibodyForTask(store, {
      ...approved,
      verification_status: "approved",
      verification_notes: "Looks good",
    });

    expect(signal).toBeTruthy();
    expect(signal?.signal_type).toBe("failure_antibody");
    expect(signal?.key).toContain("typeerror");

    const value = signal?.value ? (JSON.parse(signal.value) as {
      fix_hint: string;
      error_class: string;
      source_pr: string;
    }) : null;
    expect(value).toMatchObject({
      error_class: "runtime",
      source_pr: "owner/repo#84",
    });
    expect(value?.fix_hint).toContain("null check");
  });

  it("uses the direct PR ref for pr-feedback tasks", () => {
    const sourceRef = "owner/repo#88";
    const failed = store.createTask({
      title: "PR feedback round 1",
      source: "pr-feedback",
      source_ref: sourceRef,
      agent_name: "claude-agent-orchestrator",
    });
    store.updateTask(failed.id, {
      status: "failed",
      verification_status: "rejected",
      verification_notes: "TypeError: Cannot read properties of undefined (reading 'foo')",
    });

    const approved = store.createTask({
      title: "PR feedback round 2",
      source: "pr-feedback",
      source_ref: sourceRef,
      agent_name: "claude-agent-orchestrator",
    });
    store.updateTask(approved.id, {
      status: "done",
      verification_status: "approved",
      result: "Added a defensive null check and simplified the lookup path.",
      verification_notes: "Looks good",
    });

    const signal = harvestFailureAntibodyForTask(store, {
      ...approved,
      verification_status: "approved",
      verification_notes: "Looks good",
    });

    expect(signal).toBeTruthy();
    const value = signal?.value ? (JSON.parse(signal.value) as { source_pr: string }) : null;
    expect(value?.source_pr).toBe(sourceRef);
  });

  it("updates confidence on successful use, decays on matching failure, and culls stale antibodies", () => {
    const signal = store.writeSignal({
      agent: "claude-agent-orchestrator",
      signal_type: "failure_antibody",
      key: "typeerror cannot read properties undefined",
      value: {
        fix_hint: "Add a null check",
        error_class: "runtime",
        source_pr: "owner/repo#42",
      },
      repo: "owner/repo",
      confidence: 0.5,
    });

    for (let i = 0; i < 10; i++) {
      store.recordSignalRead(signal.id, "claude-agent-orchestrator", `task-${i}`);
    }

    store.recordSignalRead(signal.id, "claude-agent-orchestrator", "task-success");
    const approvedCount = applyFailureAntibodyFitness(
      store,
      "task-success",
      "approved",
    );
    expect(approvedCount).toBe(1);
    expect(store.getSignalById(signal.id)?.confidence).toBeCloseTo(0.55, 5);

    store.recordSignalRead(signal.id, "claude-agent-orchestrator", "task-fail");
    const failedCount = applyFailureAntibodyFitness(
      store,
      "task-fail",
      "rejected",
      "TypeError: Cannot read properties of undefined",
    );
    expect(failedCount).toBe(1);
    expect(store.getSignalById(signal.id)?.confidence).toBeCloseTo(0.45, 5);

    store.updateSignal(signal.id, { confidence: 0.15 });
    store.recordSignalRead(signal.id, "claude-agent-orchestrator", "task-cull");
    applyFailureAntibodyFitness(
      store,
      "task-cull",
      "rejected",
      "TypeError: Cannot read properties of undefined",
    );
    expect(store.getSignalById(signal.id)).toBeUndefined();
  });
});
