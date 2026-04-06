import { describe, it, expect } from "vitest";
import { parseIntervalMs, computeDiff, type HealthSnapshot } from "./health.js";

// ── parseIntervalMs ───────────────────────────────────────────────────────────

describe("parseIntervalMs", () => {
  it("parses bare number as seconds", () => {
    expect(parseIntervalMs("60")).toBe(60_000);
  });

  it("parses 's' suffix as seconds", () => {
    expect(parseIntervalMs("30s")).toBe(30_000);
  });

  it("parses 'm' suffix as minutes", () => {
    expect(parseIntervalMs("2m")).toBe(120_000);
  });

  it("parses '1m' correctly", () => {
    expect(parseIntervalMs("1m")).toBe(60_000);
  });

  it("parses '5s' correctly", () => {
    expect(parseIntervalMs("5s")).toBe(5_000);
  });

  it("throws for invalid formats", () => {
    expect(() => parseIntervalMs("abc")).toThrow(/Invalid interval/);
    expect(() => parseIntervalMs("1h")).toThrow(/Invalid interval/);
    expect(() => parseIntervalMs("")).toThrow(/Invalid interval/);
  });
});

// ── computeDiff ───────────────────────────────────────────────────────────────

function makeSnap(overrides: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    timestamp: new Date(),
    daemonRunning: true,
    daemonPid: 1234,
    lastCycleAt: null,
    lastCycleAgeMs: null,
    ghAuthOk: true,
    ghAuthReason: null,
    agentGhAuthFailures: 0,
    agents: new Map(),
    taskCounts: { done: 5, failed: 0, in_progress: 0, dispatched: 0, pending: 0 },
    unverified: 0,
    agentTimeoutMap: new Map(),
    retryMetrics: null,
    openPRs: [],
    orphansByRepo: new Map(),
    alerts: [],
    hasCriticalFailure: false,
    dbUnavailable: false,
    budgetStatuses: new Map(),
    tokenBudgetPanel: { providers: [], agents: [], top_agent_name: null },
    ...overrides,
  };
}

describe("computeDiff", () => {
  it("returns empty array when nothing changed", () => {
    const snap = makeSnap();
    const diff = computeDiff(snap, snap);
    expect(diff).toHaveLength(0);
  });

  it("detects daemon going down", () => {
    const prev = makeSnap({ daemonRunning: true });
    const curr = makeSnap({ daemonRunning: false });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("critical");
    expect(diff[0].message).toMatch(/stopped/i);
  });

  it("detects daemon coming back up", () => {
    const prev = makeSnap({ daemonRunning: false });
    const curr = makeSnap({ daemonRunning: true });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("info");
    expect(diff[0].message).toMatch(/running/i);
  });

  it("detects GitHub auth degradation", () => {
    const prev = makeSnap({ ghAuthOk: true });
    const curr = makeSnap({ ghAuthOk: false, ghAuthReason: "not logged in" });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("critical");
    expect(diff[0].message).toMatch(/degraded/i);
  });

  it("detects GitHub auth recovery", () => {
    const prev = makeSnap({ ghAuthOk: false });
    const curr = makeSnap({ ghAuthOk: true });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("info");
    expect(diff[0].message).toMatch(/OK/i);
  });

  it("detects new task failures", () => {
    const prev = makeSnap({ taskCounts: { done: 5, failed: 0 } });
    const curr = makeSnap({ taskCounts: { done: 5, failed: 2 } });
    const diff = computeDiff(prev, curr);
    const failedChange = diff.find((d) => d.message.includes("failed"));
    expect(failedChange).toBeDefined();
    expect(failedChange?.severity).toBe("warn");
    expect(failedChange?.message).toMatch(/0 → 2/);
  });

  it("detects completed tasks (done count increase)", () => {
    const prev = makeSnap({ taskCounts: { done: 3, failed: 0 } });
    const curr = makeSnap({ taskCounts: { done: 8, failed: 0 } });
    const diff = computeDiff(prev, curr);
    const doneChange = diff.find((d) => d.message.includes("done"));
    expect(doneChange).toBeDefined();
    expect(doneChange?.severity).toBe("info");
    expect(doneChange?.message).toMatch(/\+5/);
  });

  it("detects rising timeout rate", () => {
    const prev = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 2, timedOut24h: 1, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const curr = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 15, timedOut24h: 8, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const diff = computeDiff(prev, curr);
    const timeoutChange = diff.find((d) => d.message.includes("timeout rate"));
    expect(timeoutChange).toBeDefined();
    expect(timeoutChange?.severity).toBe("warn");
    expect(timeoutChange?.message).toMatch(/↑/);
    expect(timeoutChange?.message).toMatch(/2\.0%/);
    expect(timeoutChange?.message).toMatch(/15\.0%/);
  });

  it("ignores timeout rate changes < 1 percentage point", () => {
    const prev = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 5.1, timedOut24h: 3, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const curr = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 5.8, timedOut24h: 3, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const diff = computeDiff(prev, curr);
    const timeoutChange = diff.find((d) => d.message.includes("timeout rate"));
    expect(timeoutChange).toBeUndefined();
  });

  it("marks critical for timeout rate >= 25%", () => {
    const prev = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 5, timedOut24h: 2, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const curr = makeSnap({
      agentTimeoutMap: new Map([
        ["my-agent", { rate24h: 30, timedOut24h: 15, total24h: 50, rate7d: null, timedOut7d: 0, total7d: 0 }],
      ]),
    });
    const diff = computeDiff(prev, curr);
    const timeoutChange = diff.find((d) => d.message.includes("timeout rate"));
    expect(timeoutChange?.severity).toBe("critical");
  });

  it("detects new open PR", () => {
    const prev = makeSnap({ openPRs: [] });
    const curr = makeSnap({
      openPRs: [{ repo: "rapartlu/my-agent", number: 42, title: "Fix bug" }],
    });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("info");
    expect(diff[0].message).toMatch(/new open PR/);
    expect(diff[0].message).toMatch(/#42/);
  });

  it("detects closed/merged PR", () => {
    const prev = makeSnap({
      openPRs: [{ repo: "rapartlu/my-agent", number: 42, title: "Fix bug" }],
    });
    const curr = makeSnap({ openPRs: [] });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].message).toMatch(/closed\/merged/);
  });

  it("detects new orphan branch", () => {
    const prev = makeSnap({ orphansByRepo: new Map() });
    const curr = makeSnap({
      orphansByRepo: new Map([["rapartlu/my-agent", 2]]),
    });
    const diff = computeDiff(prev, curr);
    expect(diff).toHaveLength(1);
    expect(diff[0].severity).toBe("warn");
    expect(diff[0].message).toMatch(/orphan branches/);
    expect(diff[0].message).toMatch(/0 → 2/);
  });

  it("detects new alert", () => {
    const prev = makeSnap({ alerts: [] });
    const curr = makeSnap({ alerts: ["my-agent has 3 failed tasks in the last 24h"] });
    const diff = computeDiff(prev, curr);
    const alertChange = diff.find((d) => d.message.includes("new alert"));
    expect(alertChange).toBeDefined();
    expect(alertChange?.severity).toBe("warn");
  });

  it("detects resolved alert", () => {
    const prev = makeSnap({ alerts: ["my-agent has 3 failed tasks in the last 24h"] });
    const curr = makeSnap({ alerts: [] });
    const diff = computeDiff(prev, curr);
    const resolved = diff.find((d) => d.message.includes("alert resolved"));
    expect(resolved).toBeDefined();
    expect(resolved?.severity).toBe("info");
  });

  it("marks critical alert as critical severity", () => {
    const prev = makeSnap({ alerts: [] });
    const curr = makeSnap({ alerts: ["CRITICAL: Daemon is not running — autonomous loop is stopped"] });
    const diff = computeDiff(prev, curr);
    const alertChange = diff.find((d) => d.message.includes("new alert"));
    expect(alertChange?.severity).toBe("critical");
  });

  it("detects agent container status change", () => {
    const agents = new Map([["my-agent", { containerStatus: "running", healthStatus: "alive" as const, latencyMs: 50, ghAuthOk: true }]]);
    const prev = makeSnap({ agents });
    const currAgents = new Map([["my-agent", { containerStatus: "stopped", healthStatus: "unreachable" as const, latencyMs: null, ghAuthOk: null }]]);
    const curr = makeSnap({ agents: currAgents });
    const diff = computeDiff(prev, curr);
    const containerChange = diff.find((d) => d.message.includes("container"));
    expect(containerChange).toBeDefined();
    expect(containerChange?.severity).toBe("warn");
  });

  it("detects agent GH_TOKEN loss", () => {
    const prevAgents = new Map([["my-agent", { containerStatus: "running", healthStatus: "alive" as const, latencyMs: 50, ghAuthOk: true }]]);
    const currAgents = new Map([["my-agent", { containerStatus: "running", healthStatus: "alive" as const, latencyMs: 50, ghAuthOk: false }]]);
    const prev = makeSnap({ agents: prevAgents });
    const curr = makeSnap({ agents: currAgents });
    const diff = computeDiff(prev, curr);
    const authChange = diff.find((d) => d.message.includes("GH_TOKEN lost"));
    expect(authChange).toBeDefined();
    expect(authChange?.severity).toBe("warn");
  });

  it("detects agent GH_TOKEN restoration", () => {
    const prevAgents = new Map([["my-agent", { containerStatus: "running", healthStatus: "alive" as const, latencyMs: 50, ghAuthOk: false }]]);
    const currAgents = new Map([["my-agent", { containerStatus: "running", healthStatus: "alive" as const, latencyMs: 50, ghAuthOk: true }]]);
    const prev = makeSnap({ agents: prevAgents });
    const curr = makeSnap({ agents: currAgents });
    const diff = computeDiff(prev, curr);
    const authChange = diff.find((d) => d.message.includes("GH_TOKEN restored"));
    expect(authChange).toBeDefined();
    expect(authChange?.severity).toBe("info");
  });

  it("handles multiple simultaneous changes", () => {
    const prev = makeSnap({ daemonRunning: true, ghAuthOk: true });
    const curr = makeSnap({ daemonRunning: false, ghAuthOk: false });
    const diff = computeDiff(prev, curr);
    expect(diff.length).toBeGreaterThanOrEqual(2);
    expect(diff.filter((d) => d.severity === "critical")).toHaveLength(2);
  });
});
