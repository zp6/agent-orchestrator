/**
 * Unit tests for circuit-breaker and incident-log additions (issue #1398).
 *
 * Covers:
 *  1. suspendAgent / isAgentSuspended / liftAgentSuspension
 *  2. recordIncident / resolveIncident / getIncidents
 *  3. getAgentHealth returns suspended_until / suspension_reason
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

function makeStore(): { store: StateStore; cleanup: () => void } {
  const dbPath = join(tmpdir(), `circuit-breaker-test-${randomUUID()}.db`);
  const store = new StateStore(dbPath);
  return {
    store,
    cleanup: () => {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(dbPath + suffix); } catch {}
      }
    },
  };
}

describe("circuit breaker — agent suspension", () => {
  let fixture: ReturnType<typeof makeStore>;

  beforeEach(() => { fixture = makeStore(); });
  afterEach(() => { fixture.cleanup(); });

  it("isAgentSuspended returns false for unknown agent", () => {
    expect(fixture.store.isAgentSuspended("ghost-agent")).toBe(false);
  });

  it("isAgentSuspended returns true after suspendAgent with future timestamp", () => {
    const futureTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", futureTs, "connection errors exhausted");
    expect(fixture.store.isAgentSuspended("claude-reviewer")).toBe(true);
  });

  it("isAgentSuspended returns false when suspended_until is in the past", () => {
    const pastTs = new Date(Date.now() - 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", pastTs, "old suspension");
    expect(fixture.store.isAgentSuspended("claude-reviewer")).toBe(false);
  });

  it("liftAgentSuspension clears suspension so isAgentSuspended returns false", () => {
    const futureTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", futureTs, "test suspension");
    expect(fixture.store.isAgentSuspended("claude-reviewer")).toBe(true);

    fixture.store.liftAgentSuspension("claude-reviewer");
    expect(fixture.store.isAgentSuspended("claude-reviewer")).toBe(false);
  });

  it("getAgentHealth returns suspended_until and suspension_reason after suspend", () => {
    const futureTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", futureTs, "connection-error-exhausted");

    const health = fixture.store.getAgentHealth("claude-reviewer");
    expect(health).not.toBeNull();
    expect(health?.suspended_until).toBe(futureTs);
    expect(health?.suspension_reason).toBe("connection-error-exhausted");
  });

  it("getAgentHealth returns null suspended_until and suspension_reason after lift", () => {
    const futureTs = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", futureTs, "test");
    fixture.store.liftAgentSuspension("claude-reviewer");

    const health = fixture.store.getAgentHealth("claude-reviewer");
    expect(health?.suspended_until).toBeNull();
    expect(health?.suspension_reason).toBeNull();
  });

  it("suspendAgent is idempotent — second call overwrites the first", () => {
    const ts1 = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const ts2 = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fixture.store.suspendAgent("claude-reviewer", ts1, "reason-1");
    fixture.store.suspendAgent("claude-reviewer", ts2, "reason-2");

    const health = fixture.store.getAgentHealth("claude-reviewer");
    expect(health?.suspended_until).toBe(ts2);
    expect(health?.suspension_reason).toBe("reason-2");
  });
});

describe("circuit breaker — incident log", () => {
  let fixture: ReturnType<typeof makeStore>;

  beforeEach(() => { fixture = makeStore(); });
  afterEach(() => { fixture.cleanup(); });

  it("recordIncident inserts a row; getIncidents returns it", () => {
    fixture.store.recordIncident({
      incident_type: "connection-error-exhausted",
      agent_name: "claude-reviewer",
      error_message: "ECONNREFUSED",
      task_id: "task-abc",
      severity: "high",
    });

    const incidents = fixture.store.getIncidents(7, 10, null);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].incident_type).toBe("connection-error-exhausted");
    expect(incidents[0].agent_name).toBe("claude-reviewer");
    expect(incidents[0].error_message).toBe("ECONNREFUSED");
    expect(incidents[0].task_id).toBe("task-abc");
    expect(incidents[0].severity).toBe("high");
    expect(incidents[0].resolved_at).toBeNull();
  });

  it("resolveIncident sets resolved_at", () => {
    fixture.store.recordIncident({
      incident_type: "connection-error-exhausted",
      agent_name: "claude-reviewer",
      error_message: "timeout",
      severity: "high",
    });
    const [incident] = fixture.store.getIncidents(7, 10, null);
    fixture.store.resolveIncident(incident.id);

    const updated = fixture.store.getIncidents(7, 10, null);
    expect(updated[0].resolved_at).not.toBeNull();
  });

  it("getIncidents filters by agent_name", () => {
    fixture.store.recordIncident({ incident_type: "connection-error-exhausted", agent_name: "agent-a", error_message: "e1", severity: "high" });
    fixture.store.recordIncident({ incident_type: "connection-error-exhausted", agent_name: "agent-b", error_message: "e2", severity: "medium" });

    const aOnly = fixture.store.getIncidents(7, 10, "agent-a");
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].agent_name).toBe("agent-a");
  });

  it("getIncidents respects limit", () => {
    for (let i = 0; i < 5; i++) {
      fixture.store.recordIncident({
        incident_type: "connection-error-exhausted",
        agent_name: "claude-reviewer",
        error_message: `err-${i}`,
        severity: "high",
      });
    }
    const incidents = fixture.store.getIncidents(7, 3, null);
    expect(incidents).toHaveLength(3);
  });

  it("getIncidents returns empty array when no rows exist", () => {
    const incidents = fixture.store.getIncidents(7, 10, null);
    expect(incidents).toHaveLength(0);
  });

  it("recordIncident works without optional fields (task_id, agent_name)", () => {
    fixture.store.recordIncident({
      incident_type: "rate-limit",
      severity: "medium",
      error_message: "429 Too Many Requests",
    });
    const incidents = fixture.store.getIncidents(7, 10, null);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].agent_name).toBeNull();
    expect(incidents[0].task_id).toBeNull();
  });
});
