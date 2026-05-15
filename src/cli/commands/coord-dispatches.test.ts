/**
 * Tests for the `flagChangeSet` helper in the `orch coord-dispatches`
 * command (issue #1530). The renderer / store wiring is covered by
 * the wider audit-suite; this file pins down the flag rules that decide
 * which per-repo payloads are surfaced as suspicious.
 */
import { describe, it, expect } from "vitest";
import { flagChangeSet } from "./coord-dispatches.js";
import { NO_CODE_CHANGES_FALLBACK, type MultiRepoChangeSet } from "../../orchestrator/multi-repo-coordinator.js";

function cs(description: string): MultiRepoChangeSet {
  return {
    repo: "rapartlu/agent-reviewer",
    agentName: "claude-orchestrator-reviewer",
    description,
    mergeOrder: 1,
  };
}

describe("flagChangeSet", () => {
  it("flags fallback sentinel as kind=fallback", () => {
    expect(flagChangeSet(cs(NO_CODE_CHANGES_FALLBACK))).toEqual({ kind: "fallback" });
  });

  it("flags very short descriptions as kind=short with char count", () => {
    const flag = flagChangeSet(cs("too short"));
    expect(flag).toEqual({ kind: "short", detail: "9 chars" });
  });

  it("does not flag a healthy implementation description", () => {
    const desc =
      "Update the agent-reviewer client to validate the per-repo payload before dispatch.";
    expect(flagChangeSet(cs(desc))).toBeNull();
  });

  it("flags empty / whitespace-only descriptions as kind=short (length 0)", () => {
    expect(flagChangeSet(cs(""))).toEqual({ kind: "short", detail: "0 chars" });
    expect(flagChangeSet(cs("   "))).toEqual({ kind: "short", detail: "0 chars" });
  });
});
