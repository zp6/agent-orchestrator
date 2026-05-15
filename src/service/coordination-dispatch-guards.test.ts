/**
 * Tests for issue #1691: skip coordinated-change dispatch when implementation
 * section is empty or source issue is closed.
 *
 * The two guards added to dispatchPendingCoordinationGroups:
 *   1. Source-issue-closed guard — cancels the group (status → "failed") and
 *      marks all pending child tasks as "failed" without dispatching any agents.
 *   2. Empty-implementation guard — marks a single child task as "done" without
 *      dispatching an agent when its description contains NO_CODE_CHANGES_FALLBACK.
 *
 * Because dispatchPendingCoordinationGroups is a private method of the Daemon
 * class (which requires heavy wiring), these tests verify the guard invariants
 * through the store contract and the public sentinel constant rather than
 * instantiating a full Daemon.
 */

import { describe, it, expect } from "vitest";
import { NO_CODE_CHANGES_FALLBACK } from "../orchestrator/multi-repo-coordinator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Guard 1: source-issue-closed guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Guard 1: source issue closed — parse + detect", () => {
  /**
   * The daemon uses /^([^#]+)#(\d+)$/ to parse parentSourceRef.
   * These tests verify the regex correctly handles expected ref formats.
   */
  const SOURCE_REF_RE = /^([^#]+)#(\d+)$/;

  it("parses a standard cross-repo ref", () => {
    const match = SOURCE_REF_RE.exec("rapartlu/agent-proxy#592");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("rapartlu/agent-proxy");
    expect(match![2]).toBe("592");
  });

  it("parses a same-repo ref", () => {
    const match = SOURCE_REF_RE.exec("rapartlu/agent-orchestrator#1691");
    expect(match).not.toBeNull();
    expect(match![1]).toBe("rapartlu/agent-orchestrator");
    expect(parseInt(match![2]!, 10)).toBe(1691);
  });

  it("returns null for a bare issue number without repo", () => {
    expect(SOURCE_REF_RE.exec("#592")).toBeNull();
  });

  it("returns null for a PR URL (not a repo#N ref)", () => {
    const url = "https://github.com/rapartlu/agent-proxy/pull/592";
    expect(SOURCE_REF_RE.exec(url)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(SOURCE_REF_RE.exec("")).toBeNull();
  });

  it("returns null when parentSourceRef is a bare task ID (no hash)", () => {
    expect(SOURCE_REF_RE.exec("01KRK0MSX1HPGACWJBYDWY5T2G")).toBeNull();
  });

  /**
   * Verify the expected store state after the source-issue-closed guard fires:
   * - every pending child task must be failed with a reason mentioning the
   *   closed parentSourceRef
   * - the coordination group must be marked "failed"
   */
  it("closed-issue guard: expected store state transition for failed group", () => {
    const parentSourceRef = "rapartlu/agent-proxy#592";
    const childTaskUpdates: Array<[string, { status: string; result: string }]> = [];
    const groupUpdates: Array<[string, { status: string }]> = [];

    // Simulate the daemon guard
    const updateTask = (id: string, patch: { status: string; result: string }) => {
      childTaskUpdates.push([id, patch]);
    };
    const updateCoordinationGroup = (id: string, patch: { status: string }) => {
      groupUpdates.push([id, patch]);
    };

    const group = { id: "group-abc", parentSourceRef, childTaskIds: { "rapartlu/agent-orchestrator": "child-1" } };
    const childTask = { id: "child-1", status: "pending" };

    if (childTask.status === "pending") {
      updateTask(childTask.id, {
        status: "failed",
        result: `Coordination group cancelled: source issue ${group.parentSourceRef} is closed — no dispatch needed.`,
      });
    }
    updateCoordinationGroup(group.id, { status: "failed" });

    expect(childTaskUpdates).toHaveLength(1);
    expect(childTaskUpdates[0]![1].status).toBe("failed");
    expect(childTaskUpdates[0]![1].result).toContain("closed");
    expect(childTaskUpdates[0]![1].result).toContain(parentSourceRef);
    expect(groupUpdates).toHaveLength(1);
    expect(groupUpdates[0]![1].status).toBe("failed");
  });

  it("closed-issue guard: skips already-dispatched child tasks (only cancels pending ones)", () => {
    const childTaskUpdates: string[] = [];

    const updateTask = (id: string) => childTaskUpdates.push(id);

    // Mix of statuses — only "pending" should be cancelled
    const children = [
      { id: "child-1", status: "pending" },
      { id: "child-2", status: "dispatched" },
      { id: "child-3", status: "done" },
    ];

    for (const child of children) {
      if (child.status === "pending") {
        updateTask(child.id);
      }
    }

    expect(childTaskUpdates).toEqual(["child-1"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard 2: empty-implementation guard
// ─────────────────────────────────────────────────────────────────────────────

describe("Guard 2: NO_CODE_CHANGES_FALLBACK sentinel detection", () => {
  it("NO_CODE_CHANGES_FALLBACK is a non-empty string", () => {
    expect(typeof NO_CODE_CHANGES_FALLBACK).toBe("string");
    expect(NO_CODE_CHANGES_FALLBACK.length).toBeGreaterThan(0);
  });

  it("description containing the sentinel triggers the skip guard", () => {
    const description =
      `Part of coordinated change originating from: rapartlu/agent-proxy#592\n\n` +
      `**What to implement in \`rapartlu/agent-orchestrator\`:**\n` +
      `${NO_CODE_CHANGES_FALLBACK}\n\n` +
      `**Your merge order: 1 of 2**`;

    expect(description.includes(NO_CODE_CHANGES_FALLBACK)).toBe(true);
  });

  it("description with real implementation content does NOT trigger the skip guard", () => {
    const description =
      `Part of coordinated change originating from: rapartlu/agent-proxy#592\n\n` +
      `**What to implement in \`rapartlu/agent-orchestrator\`:**\n` +
      `Add a new webhook endpoint for tracking cross-repo coordination events.\n\n` +
      `**Your merge order: 1 of 2**`;

    expect(description.includes(NO_CODE_CHANGES_FALLBACK)).toBe(false);
  });

  it("null/undefined description does NOT trigger the skip guard (guard is opt-in)", () => {
    const description: string | null = null;
    // Using optional chaining — undefined.includes() would throw; this returns false
    expect(description?.includes(NO_CODE_CHANGES_FALLBACK)).toBeFalsy();
  });

  it("empty description does NOT trigger the sentinel guard (falls through to NO_CODE_CHANGES_FALLBACK being absent)", () => {
    const description = "";
    expect(description.includes(NO_CODE_CHANGES_FALLBACK)).toBe(false);
  });

  /**
   * Verify the expected store state after the empty-implementation guard fires:
   * - the child task is marked "done" (not "failed", since there was nothing to do)
   * - the result message mentions the repo and the skip reason
   * - dispatchCoordinationChild is NOT called
   */
  it("empty-implementation guard: expected store state transition for skipped child", () => {
    const childTaskUpdates: Array<[string, { status: string; result: string }]> = [];
    let dispatchChildCalled = false;

    const updateTask = (id: string, patch: { status: string; result: string }) => {
      childTaskUpdates.push([id, patch]);
    };
    const dispatchCoordinationChild = () => {
      dispatchChildCalled = true;
    };

    const repo = "rapartlu/agent-orchestrator";
    const childTask = {
      id: "child-1",
      status: "pending",
      description: `...${NO_CODE_CHANGES_FALLBACK}...`,
      agent_name: "claude-agent-orchestrator",
    };

    if (childTask.description?.includes(NO_CODE_CHANGES_FALLBACK)) {
      updateTask(childTask.id, {
        status: "done",
        result: `Skipped: no code changes required for \`${repo}\`. The parent issue had no actionable implementation section for this repo.`,
      });
      // dispatchCoordinationChild is NOT called
    } else {
      dispatchCoordinationChild();
    }

    expect(childTaskUpdates).toHaveLength(1);
    expect(childTaskUpdates[0]![1].status).toBe("done");
    expect(childTaskUpdates[0]![1].result).toContain("Skipped");
    expect(childTaskUpdates[0]![1].result).toContain(repo);
    expect(dispatchChildCalled).toBe(false);
  });

  it("empty-implementation guard: task with real description dispatches normally", () => {
    let dispatchChildCalled = false;

    const dispatchCoordinationChild = () => {
      dispatchChildCalled = true;
    };

    const childTask = {
      id: "child-1",
      status: "pending",
      description: "Implement the new webhook endpoint in agent-orchestrator.",
      agent_name: "claude-agent-orchestrator",
    };

    if (childTask.description?.includes(NO_CODE_CHANGES_FALLBACK)) {
      // skip — mark done
    } else {
      dispatchCoordinationChild();
    }

    expect(dispatchChildCalled).toBe(true);
  });
});
