import { describe, it, expect, beforeEach } from "vitest";
import { StateStore, type MonologueKind } from "./store.js";

describe("Monologue Log", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("emits and retrieves a monologue entry", () => {
    const result = store.emitMonologue({
      agent_name: "claude-agent-orchestrator",
      task_id: "01ABC123",
      kind: "plan",
      prose: "Starting work on the hire-the-fleet landing page deployment.",
    });

    expect(result.id).toBeGreaterThan(0);
    expect(result.created_at).toBeTruthy();

    const entries = store.getMonologue({ agent_name: "claude-agent-orchestrator" });
    expect(entries).toHaveLength(1);
    expect(entries[0].agent_name).toBe("claude-agent-orchestrator");
    expect(entries[0].task_id).toBe("01ABC123");
    expect(entries[0].kind).toBe("plan");
    expect(entries[0].prose).toContain("hire-the-fleet");
  });

  it("filters by kind", () => {
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "Planning..." });
    store.emitMonologue({ agent_name: "agent-a", kind: "decision", prose: "Decided to..." });
    store.emitMonologue({ agent_name: "agent-a", kind: "execution", prose: "Running..." });

    const decisions = store.getMonologue({ kind: "decision" });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].kind).toBe("decision");
  });

  it("filters by task_id", () => {
    store.emitMonologue({ agent_name: "agent-a", task_id: "task-1", kind: "plan", prose: "A" });
    store.emitMonologue({ agent_name: "agent-a", task_id: "task-2", kind: "plan", prose: "B" });

    const entries = store.getMonologue({ task_id: "task-1" });
    expect(entries).toHaveLength(1);
    expect(entries[0].prose).toBe("A");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.emitMonologue({ agent_name: "agent-a", kind: "observation", prose: `Entry ${i}` });
    }

    const entries = store.getMonologue({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it("returns entries newest-first (by id when timestamps match)", () => {
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "First" });
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "Second" });

    const entries = store.getMonologue();
    // Both inserts may share the same ISO timestamp in fast tests,
    // but the higher id is always the later insert.
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBeGreaterThan(entries[1].id);
  });

  it("handles null task_id", () => {
    const result = store.emitMonologue({
      agent_name: "agent-b",
      kind: "reflection",
      prose: "No task context here.",
    });

    const entries = store.getMonologue({ agent_name: "agent-b" });
    expect(entries).toHaveLength(1);
    expect(entries[0].task_id).toBeNull();
  });

  it("getPeerMonologue excludes the requesting agent", () => {
    store.emitMonologue({ agent_name: "agent-a", task_id: "shared-task", kind: "plan", prose: "A's plan" });
    store.emitMonologue({ agent_name: "agent-b", task_id: "shared-task", kind: "decision", prose: "B's decision" });
    store.emitMonologue({ agent_name: "agent-c", task_id: "shared-task", kind: "execution", prose: "C's work" });

    const peer = store.getPeerMonologue({
      exclude_agent: "agent-a",
      task_ids: ["shared-task"],
    });

    expect(peer).toHaveLength(2);
    expect(peer.every((e) => e.agent_name !== "agent-a")).toBe(true);
  });

  it("getPeerMonologue falls back to recent entries without task_ids", () => {
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "A" });
    store.emitMonologue({ agent_name: "agent-b", kind: "plan", prose: "B" });

    const peer = store.getPeerMonologue({ exclude_agent: "agent-a", limit: 5 });
    expect(peer).toHaveLength(1);
    expect(peer[0].agent_name).toBe("agent-b");
  });

  it("getMonologueCount returns correct counts", () => {
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "One" });
    store.emitMonologue({ agent_name: "agent-a", kind: "plan", prose: "Two" });
    store.emitMonologue({ agent_name: "agent-b", kind: "plan", prose: "Three" });

    expect(store.getMonologueCount()).toBe(3);
    expect(store.getMonologueCount({ agent_name: "agent-a" })).toBe(2);
  });

  it("validates all kind values are accepted", () => {
    const kinds: MonologueKind[] = ["plan", "observation", "decision", "execution", "reflection", "escalation"];
    for (const kind of kinds) {
      const result = store.emitMonologue({ agent_name: "test", kind, prose: `Testing ${kind}` });
      expect(result.id).toBeGreaterThan(0);
    }

    const all = store.getMonologue({ limit: 100 });
    expect(all).toHaveLength(kinds.length);
  });
});
