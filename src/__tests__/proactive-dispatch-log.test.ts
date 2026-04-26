/**
 * Unit tests for proactive-dispatch-log.ts
 *
 * Covers:
 *   - parseSinceDuration: duration parsing, edge cases, compound formats
 *   - getProactiveDispatches: agentName filter, since filter, combined filters
 *   - formatProactiveDispatchesForTelegram: filter info in header, empty state
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseSinceDuration,
  getProactiveDispatches,
  formatProactiveDispatchesForTelegram,
  type ProactiveDispatchOptions,
} from "../reviewer/proactive-dispatch-log.js";
import type { IStateStore, SupervisorDecisionRecord, SupervisorDecisionQuery, Task } from "../state/types.js";

// ── Minimal store stub ──────────────────────────────────────────────────────

function makeStore(
  decisions: SupervisorDecisionRecord[],
  tasks: Record<string, Partial<Task>> = {},
): IStateStore {
  return {
    querySupervisorDecisions: (_opts: SupervisorDecisionQuery) => decisions,
    getTask: (id: string) => (tasks[id] ?? null) as Task | null,
  } as unknown as IStateStore;
}

function makeStoreCapturingOpts(
  decisions: SupervisorDecisionRecord[],
  tasks: Record<string, Partial<Task>> = {},
): { store: IStateStore; capturedOpts: () => SupervisorDecisionQuery | undefined } {
  let captured: SupervisorDecisionQuery | undefined;
  const store = {
    querySupervisorDecisions: (opts: SupervisorDecisionQuery) => {
      captured = opts;
      return decisions;
    },
    getTask: (id: string) => (tasks[id] ?? null) as Task | null,
  } as unknown as IStateStore;
  return { store, capturedOpts: () => captured };
}

// ── Sample data ─────────────────────────────────────────────────────────────

const SAMPLE_DECISION: SupervisorDecisionRecord = {
  id: "01ABC",
  action: "dispatch",
  agent_name: "claude-orchestrator-dashboard",
  task_id: "task-01",
  issue_ref: "rapartlu/agent-dashboard#570",
  reason: "Agent is idle. Dispatching high-value observability panel.",
  message: "Implement issue #570.",
  outcome: "dispatched",
  created_at: "2026-04-25T14:32:00.000Z",
};

const SAMPLE_DECISION_2: SupervisorDecisionRecord = {
  id: "01DEF",
  action: "dispatch",
  agent_name: "claude-proxy",
  task_id: "task-02",
  issue_ref: "rapartlu/agent-proxy#12",
  reason: "Proxy agent idle, low-risk task.",
  message: null,
  outcome: "dispatched",
  created_at: "2026-04-24T10:00:00.000Z",
};

// ── parseSinceDuration ───────────────────────────────────────────────────────

describe("parseSinceDuration", () => {
  const NOW = new Date("2026-04-26T12:00:00.000Z").getTime();

  it("returns null for undefined input", () => {
    expect(parseSinceDuration(undefined, NOW)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseSinceDuration("", NOW)).toBeNull();
  });

  it("returns null for invalid format", () => {
    expect(parseSinceDuration("yesterday", NOW)).toBeNull();
    expect(parseSinceDuration("7", NOW)).toBeNull();
    expect(parseSinceDuration("abc", NOW)).toBeNull();
  });

  it("returns null when all components are zero", () => {
    expect(parseSinceDuration("0d", NOW)).toBeNull();
    expect(parseSinceDuration("0h0m", NOW)).toBeNull();
  });

  it("parses days correctly (7d → 7 days ago)", () => {
    const result = parseSinceDuration("7d", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("parses hours correctly (24h → 24 hours ago)", () => {
    const result = parseSinceDuration("24h", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("parses minutes correctly (30m → 30 minutes ago)", () => {
    const result = parseSinceDuration("30m", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - 30 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("parses compound duration (1h30m → 90 minutes ago)", () => {
    const result = parseSinceDuration("1h30m", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - 90 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("parses compound duration with days (1d12h → 36 hours ago)", () => {
    const result = parseSinceDuration("1d12h", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - 36 * 60 * 60 * 1000).toISOString();
    expect(result).toBe(expected);
  });

  it("parses full compound duration (1d2h30m)", () => {
    const totalMs = (1 * 24 * 60 + 2 * 60 + 30) * 60_000;
    const result = parseSinceDuration("1d2h30m", NOW);
    expect(result).not.toBeNull();
    const expected = new Date(NOW - totalMs).toISOString();
    expect(result).toBe(expected);
  });

  it("returns an ISO-8601 string", () => {
    const result = parseSinceDuration("7d", NOW);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
  });
});

// ── getProactiveDispatches ───────────────────────────────────────────────────

describe("getProactiveDispatches — filter forwarding", () => {
  it("forwards agentName filter to store", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    getProactiveDispatches(store, 10, { agentName: "claude-orchestrator-dashboard" });

    expect(capturedOpts()).toMatchObject({
      agentName: "claude-orchestrator-dashboard",
      action: "dispatch",
    });
  });

  it("converts since string to ISO timestamp before forwarding", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    const before = Date.now();
    getProactiveDispatches(store, 10, { since: "7d" });
    const after = Date.now();

    const sent = capturedOpts()?.since;
    expect(sent).toBeDefined();

    // Verify the timestamp is between 7d-ago ± a few seconds
    const sentMs = new Date(sent!).getTime();
    const expectedMs7d = before - 7 * 24 * 60 * 60 * 1000;
    expect(sentMs).toBeGreaterThanOrEqual(expectedMs7d - 5000);
    expect(sentMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000 + 5000);
  });

  it("forwards both agentName and since when both are provided", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    getProactiveDispatches(store, 5, {
      agentName: "claude-proxy",
      since: "24h",
    });

    const opts = capturedOpts();
    expect(opts?.agentName).toBe("claude-proxy");
    expect(opts?.since).toBeDefined();
    expect(opts?.limit).toBe(5);
  });

  it("omits agentName from query when not specified", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    getProactiveDispatches(store, 10, {});

    expect(capturedOpts()?.agentName).toBeUndefined();
  });

  it("omits since from query when not specified", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    getProactiveDispatches(store, 10, {});

    expect(capturedOpts()?.since).toBeUndefined();
  });

  it("omits since from query when since is an invalid format", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([SAMPLE_DECISION]);

    getProactiveDispatches(store, 10, { since: "bad-value" });

    expect(capturedOpts()?.since).toBeUndefined();
  });

  it("returns enriched ProactiveDispatch records", () => {
    const store = makeStore([SAMPLE_DECISION], {
      "task-01": { quality_score: 0.88, verification_status: "approved" },
    });

    const result = getProactiveDispatches(store, 10);

    expect(result).toHaveLength(1);
    expect(result[0].quality_score).toBe(0.88);
    expect(result[0].verification_status).toBe("approved");
    expect(result[0].decision.id).toBe("01ABC");
  });

  it("caps limit at 25", () => {
    const { store, capturedOpts } = makeStoreCapturingOpts([]);

    getProactiveDispatches(store, 100);

    expect(capturedOpts()?.limit).toBe(25);
  });

  it("returns empty array when store returns no decisions", () => {
    const store = makeStore([]);
    const result = getProactiveDispatches(store, 10);
    expect(result).toHaveLength(0);
  });
});

// ── formatProactiveDispatchesForTelegram ─────────────────────────────────────

describe("formatProactiveDispatchesForTelegram — filter display", () => {
  it("shows filter info in header when agentName is set", () => {
    const store = makeStore([SAMPLE_DECISION]);
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches, {
      agentName: "claude-orchestrator-dashboard",
    });

    expect(output).toContain("agent=claude-orchestrator-dashboard");
  });

  it("shows filter info in header when since is set", () => {
    const store = makeStore([SAMPLE_DECISION]);
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches, { since: "7d" });

    expect(output).toContain("since=7d");
  });

  it("shows both filters when both are set", () => {
    const store = makeStore([SAMPLE_DECISION]);
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches, {
      agentName: "claude-proxy",
      since: "24h",
    });

    expect(output).toContain("agent=claude-proxy");
    expect(output).toContain("since=24h");
  });

  it("shows no filter suffix when no options are provided", () => {
    const store = makeStore([SAMPLE_DECISION]);
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches);

    // Header should not contain filter text
    const header = output.split("\n")[0];
    expect(header).not.toContain("agent=");
    expect(header).not.toContain("since=");
  });

  it("shows 'matching filters' in empty-result message when filters are active", () => {
    const output = formatProactiveDispatchesForTelegram([], {
      agentName: "claude-proxy",
      since: "24h",
    });

    expect(output).toContain("matching filters");
    expect(output).toContain("agent=claude-proxy");
  });

  it("shows generic empty message when no filters are active", () => {
    const output = formatProactiveDispatchesForTelegram([]);

    expect(output).toContain("No proactive dispatches found");
    expect(output).not.toContain("matching filters");
  });

  it("includes dispatch entry details in output", () => {
    const store = makeStore([SAMPLE_DECISION], {
      "task-01": { quality_score: 0.88, verification_status: "approved" },
    });
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches);

    expect(output).toContain("claude-orchestrator-dashboard");
    expect(output).toContain("rapartlu/agent-dashboard#570");
    expect(output).toContain("88%");
  });

  it("handles multiple dispatches and shows correct count in header", () => {
    const store = makeStore([SAMPLE_DECISION, SAMPLE_DECISION_2]);
    const dispatches = getProactiveDispatches(store, 10);
    const output = formatProactiveDispatchesForTelegram(dispatches);

    expect(output).toContain("(2");
  });
});
