/**
 * Tests for the `coordination_dispatch_audit` table + listing helpers
 * introduced in issue #1530.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

function makeStore(): { store: StateStore; cleanup: () => void } {
  const dbPath = join(tmpdir(), `coord-audit-test-${randomUUID()}.db`);
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

describe("coordination_dispatch_audit (#1530)", () => {
  let fixture: ReturnType<typeof makeStore>;

  beforeEach(() => { fixture = makeStore(); });
  afterEach(() => { fixture.cleanup(); });

  it("returns an empty array before any audits are recorded", () => {
    expect(fixture.store.listCoordinationDispatchAudits()).toEqual([]);
    expect(fixture.store.countCoordinationDispatchAuditsByReason()).toEqual({});
  });

  it("records and reads back a single audit entry", () => {
    fixture.store.recordCoordinationDispatchAudit({
      id: "01ABC",
      groupId: "GRP1",
      parentSourceRef: "rapartlu/agent-orchestrator#1530",
      repo: "rapartlu/agent-reviewer",
      agentName: "claude-orchestrator-reviewer",
      matchedToken: "agent-reviewer",
      rawSnippet: "Direct commits to main bypass code review …",
      reason: "antibody_fragment",
    });

    const rows = fixture.store.listCoordinationDispatchAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "01ABC",
      groupId: "GRP1",
      parentSourceRef: "rapartlu/agent-orchestrator#1530",
      repo: "rapartlu/agent-reviewer",
      agentName: "claude-orchestrator-reviewer",
      matchedToken: "agent-reviewer",
      reason: "antibody_fragment",
      fallbackUsed: true,
    });
    expect(typeof rows[0]!.createdAt).toBe("string");
  });

  it("orders results newest first", async () => {
    fixture.store.recordCoordinationDispatchAudit({
      id: "01OLDER",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "old",
      reason: "empty",
      createdAt: "2026-05-01T00:00:00Z",
    });
    fixture.store.recordCoordinationDispatchAudit({
      id: "01NEWER",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "new",
      reason: "empty",
      createdAt: "2026-05-15T00:00:00Z",
    });
    const rows = fixture.store.listCoordinationDispatchAudits();
    expect(rows.map((r) => r.id)).toEqual(["01NEWER", "01OLDER"]);
  });

  it("filters by repo and reason", () => {
    fixture.store.recordCoordinationDispatchAudit({
      id: "01A",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "x",
      reason: "empty",
    });
    fixture.store.recordCoordinationDispatchAudit({
      id: "01B",
      repo: "rapartlu/agent-dashboard",
      rawSnippet: "y",
      reason: "truncated",
    });
    fixture.store.recordCoordinationDispatchAudit({
      id: "01C",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "z",
      reason: "truncated",
    });

    expect(fixture.store
      .listCoordinationDispatchAudits({ repo: "rapartlu/agent-reviewer" })
      .map((r) => r.id).sort()).toEqual(["01A", "01C"]);

    expect(fixture.store
      .listCoordinationDispatchAudits({ reason: "truncated" })
      .map((r) => r.id).sort()).toEqual(["01B", "01C"]);
  });

  it("aggregates rejection counts by reason", () => {
    for (const id of ["1", "2", "3"]) {
      fixture.store.recordCoordinationDispatchAudit({
        id,
        repo: "rapartlu/agent-reviewer",
        rawSnippet: "x",
        reason: "antibody_fragment",
      });
    }
    fixture.store.recordCoordinationDispatchAudit({
      id: "4",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "y",
      reason: "empty",
    });
    expect(fixture.store.countCoordinationDispatchAuditsByReason()).toEqual({
      antibody_fragment: 3,
      empty: 1,
    });
  });

  it("respects sinceISO when aggregating by reason", () => {
    fixture.store.recordCoordinationDispatchAudit({
      id: "old",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "x",
      reason: "empty",
      createdAt: "2026-05-01T00:00:00Z",
    });
    fixture.store.recordCoordinationDispatchAudit({
      id: "new",
      repo: "rapartlu/agent-reviewer",
      rawSnippet: "y",
      reason: "empty",
      createdAt: "2026-05-15T00:00:00Z",
    });
    expect(fixture.store.countCoordinationDispatchAuditsByReason({
      sinceISO: "2026-05-10T00:00:00Z",
    })).toEqual({ empty: 1 });
  });
});

describe("listRecentCoordinationGroups (#1530)", () => {
  let fixture: ReturnType<typeof makeStore>;

  beforeEach(() => { fixture = makeStore(); });
  afterEach(() => { fixture.cleanup(); });

  it("returns an empty list before any groups exist", () => {
    expect(fixture.store.listRecentCoordinationGroups()).toEqual([]);
  });

  it("returns groups newest first and respects limit + status filter", () => {
    const base = {
      changeSets: [],
      childTaskIds: {},
      childPRNumbers: {},
      childPRUrls: {},
    };
    fixture.store.createCoordinationGroup({
      id: "GRP-OLD",
      parentTaskId: "T1",
      parentSourceRef: "rapartlu/agent-orchestrator#1",
      ...base,
      status: "merged",
      createdAt: "2026-05-01T00:00:00Z",
      updatedAt: "2026-05-01T00:00:00Z",
    });
    fixture.store.createCoordinationGroup({
      id: "GRP-MID",
      parentTaskId: "T2",
      parentSourceRef: "rapartlu/agent-orchestrator#2",
      ...base,
      status: "in_progress",
      createdAt: "2026-05-10T00:00:00Z",
      updatedAt: "2026-05-10T00:00:00Z",
    });
    fixture.store.createCoordinationGroup({
      id: "GRP-NEW",
      parentTaskId: "T3",
      parentSourceRef: "rapartlu/agent-orchestrator#3",
      ...base,
      status: "merged",
      createdAt: "2026-05-15T00:00:00Z",
      updatedAt: "2026-05-15T00:00:00Z",
    });

    const all = fixture.store.listRecentCoordinationGroups();
    expect(all.map((g) => g.id)).toEqual(["GRP-NEW", "GRP-MID", "GRP-OLD"]);

    const limited = fixture.store.listRecentCoordinationGroups({ limit: 2 });
    expect(limited.map((g) => g.id)).toEqual(["GRP-NEW", "GRP-MID"]);

    const merged = fixture.store.listRecentCoordinationGroups({ status: "merged" });
    expect(merged.map((g) => g.id)).toEqual(["GRP-NEW", "GRP-OLD"]);
  });
});
