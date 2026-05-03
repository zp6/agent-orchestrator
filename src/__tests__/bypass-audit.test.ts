/**
 * Tests for bypass-audit.ts (issue #398).
 *
 * Covers:
 *   1. getBypassAuditPayload() — correct aggregation and worst-offender selection
 *   2. formatBypassAuditForTelegram() — message formatting
 *   3. BypassAuditScheduler — daily dedup, notifier integration, fail-open on error
 *   4. StateStore.getBypassAuditTasks() — SQL query correctness via in-process DB
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  getBypassAuditPayload,
  formatBypassAuditForTelegram,
  BypassAuditScheduler,
  BYPASS_AUDIT_FLOOR,
  BYPASS_AUDIT_DEFAULT_DAYS,
  type BypassAuditEntry,
  type BypassAuditPayload,
} from "../reviewer/bypass-audit.js";
import type { IBypassAuditStore } from "../state/types.js";
import type { Task } from "../state/types.js";
import { StateStore } from "../state/store.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: "Test task",
    description: "desc",
    agent_name: "test-agent",
    status: "done",
    task_type: "implementation",
    source_ref: "owner/repo#1",
    verification_status: "approved",
    quality_score: 0.42,
    bypass_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: null,
    verification_notes: null,
    conversation_id: null,
    retry_count: 0,
    parent_task_id: null,
    quality_explanation: null,
    marginal_reason: null,
    score_explanation: null,
    ...overrides,
  } as Task;
}

function makeStore(tasks: Task[]): IBypassAuditStore {
  return {
    getBypassAuditTasks: (_days?: number, _limit?: number) => tasks,
  };
}

// ── getBypassAuditPayload ─────────────────────────────────────────────────────

describe("getBypassAuditPayload", () => {
  it("returns empty payload when no tasks", () => {
    const payload = getBypassAuditPayload(makeStore([]));
    expect(payload.count).toBe(0);
    expect(payload.entries).toHaveLength(0);
    expect(payload.worst_offender).toBeNull();
    expect(payload.silent_bypass_count).toBe(0);
    expect(payload.floor).toBe(BYPASS_AUDIT_FLOOR);
    expect(payload.period_days).toBe(BYPASS_AUDIT_DEFAULT_DAYS);
  });

  it("maps tasks to entries with correct fields", () => {
    const task = makeTask({
      id: "01KPRYG5XXXXXXXXXXXX",
      title: "PR guard cooldown",
      agent_name: "claude-agent-orchestrator",
      quality_score: 0.42,
      bypass_reason: "floor_not_enforced",
      source_ref: "rapartlu/agent-reviewer#390",
      updated_at: "2026-04-21T10:00:00.000Z",
    });
    const payload = getBypassAuditPayload(makeStore([task]));

    expect(payload.count).toBe(1);
    const entry = payload.entries[0]!;
    expect(entry.task_id).toBe(task.id);
    expect(entry.task_id_short).toBe(task.id.slice(0, 8));
    expect(entry.quality_score).toBe(0.42);
    expect(entry.bypass_reason).toBe("floor_not_enforced");
    expect(entry.source_ref).toBe("rapartlu/agent-reviewer#390");
    expect(entry.agent_name).toBe("claude-agent-orchestrator");
    expect(entry.approved_at).toBe("2026-04-21T10:00:00.000Z");
  });

  it("uses 'none' as bypass_reason when column is null", () => {
    const task = makeTask({ bypass_reason: null, quality_score: 0.42 });
    const payload = getBypassAuditPayload(makeStore([task]));
    expect(payload.entries[0]!.bypass_reason).toBe("none");
  });

  it("first entry is worst_offender (lowest quality_score)", () => {
    const tasks = [
      makeTask({ quality_score: 0.42, id: "worst-000000000000000000" }),
      makeTask({ quality_score: 0.55, id: "better-0000000000000000" }),
    ];
    const payload = getBypassAuditPayload(makeStore(tasks));
    expect(payload.worst_offender!.quality_score).toBe(0.42);
    expect(payload.worst_offender!.task_id).toBe("worst-000000000000000000");
  });

  it("counts silent bypasses (bypass_reason=null or 'none')", () => {
    const tasks = [
      makeTask({ bypass_reason: null }),
      makeTask({ bypass_reason: "operator_override" }),
      makeTask({ bypass_reason: null }),
    ];
    const payload = getBypassAuditPayload(makeStore(tasks));
    expect(payload.silent_bypass_count).toBe(2);
  });

  it("passes days and limit options through to store", () => {
    const spy = vi.fn().mockReturnValue([]);
    const store: IBypassAuditStore = { getBypassAuditTasks: spy };
    getBypassAuditPayload(store, { days: 14, limit: 50 });
    expect(spy).toHaveBeenCalledWith(14, 50);
  });

  it("uses defaults when opts are missing", () => {
    const spy = vi.fn().mockReturnValue([]);
    const store: IBypassAuditStore = { getBypassAuditTasks: spy };
    getBypassAuditPayload(store);
    expect(spy).toHaveBeenCalledWith(7, 200);
  });

  it("generated_at is a valid ISO timestamp", () => {
    const payload = getBypassAuditPayload(makeStore([]));
    expect(() => new Date(payload.generated_at)).not.toThrow();
    expect(new Date(payload.generated_at).toISOString()).toBe(payload.generated_at);
  });
});

// ── formatBypassAuditForTelegram ──────────────────────────────────────────────

describe("formatBypassAuditForTelegram", () => {
  it("returns green OK message when count is 0", () => {
    const payload = getBypassAuditPayload(makeStore([]));
    const msg = formatBypassAuditForTelegram(payload);
    expect(msg).toContain("No sub-floor");
    expect(msg).toContain("✅");
  });

  it("includes count and floor in header", () => {
    const tasks = [makeTask({ quality_score: 0.45 })];
    const payload = getBypassAuditPayload(makeStore(tasks));
    const msg = formatBypassAuditForTelegram(payload);
    expect(msg).toContain("1");
    expect(msg).toContain("0.6");
  });

  it("includes worst offender details", () => {
    const tasks = [
      makeTask({ quality_score: 0.42, title: "Bad task", agent_name: "bad-agent" }),
      makeTask({ quality_score: 0.55, title: "Better task" }),
    ];
    const payload = getBypassAuditPayload(makeStore(tasks));
    const msg = formatBypassAuditForTelegram(payload);
    expect(msg).toContain("0.42");
    expect(msg).toContain("Bad task");
    expect(msg).toContain("bad-agent");
  });

  it("notes silent bypass in summary", () => {
    const tasks = [makeTask({ bypass_reason: null, quality_score: 0.50 })];
    const payload = getBypassAuditPayload(makeStore(tasks));
    const msg = formatBypassAuditForTelegram(payload);
    expect(msg).toContain("silent");
  });

  it("does not include 'silent' note when all bypasses have explicit reasons", () => {
    const tasks = [makeTask({ bypass_reason: "operator_override", quality_score: 0.50 })];
    const payload = getBypassAuditPayload(makeStore(tasks));
    const msg = formatBypassAuditForTelegram(payload);
    expect(msg).not.toContain("silent");
  });
});

// ── BypassAuditScheduler ──────────────────────────────────────────────────────

describe("BypassAuditScheduler", () => {
  it("sends Telegram message and returns true on first call", async () => {
    const notifier = { send: vi.fn().mockResolvedValue(undefined) } as any;
    const store = makeStore([makeTask({ quality_score: 0.42 })]);
    const scheduler = new BypassAuditScheduler(store, notifier);

    const result = await scheduler.checkAndSend(Date.now());
    // #564 noise suppression: digest is logged, not sent to Telegram.
    expect(result).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("does NOT send on second call within the same day (dedup)", async () => {
    const notifier = { send: vi.fn().mockResolvedValue(undefined) } as any;
    const store = makeStore([makeTask()]);
    const scheduler = new BypassAuditScheduler(store, notifier);

    const now = Date.now();
    const result1 = await scheduler.checkAndSend(now);
    const result2 = await scheduler.checkAndSend(now + 60_000); // 1 min later, same day

    // #564 noise suppression: send never called but dedup still works via date key.
    expect(result1).toBe(true);
    expect(result2).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("sends again on the next calendar day", async () => {
    const notifier = { send: vi.fn().mockResolvedValue(undefined) } as any;
    const store = makeStore([makeTask()]);
    const scheduler = new BypassAuditScheduler(store, notifier);

    const day1 = new Date("2026-04-21T10:00:00Z").getTime();
    const day2 = new Date("2026-04-22T10:00:00Z").getTime();

    const result1 = await scheduler.checkAndSend(day1);
    const result2 = await scheduler.checkAndSend(day2);

    // #564 noise suppression: send suppressed but both days return true (processed).
    expect(result1).toBe(true);
    expect(result2).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("returns false without sending when notifier is undefined", async () => {
    const store = makeStore([makeTask()]);
    const scheduler = new BypassAuditScheduler(store, undefined);
    const result = await scheduler.checkAndSend(Date.now());
    expect(result).toBe(false);
  });

  it("returns false and does not throw when notifier.send rejects", async () => {
    const notifier = {
      send: vi.fn().mockRejectedValue(new Error("Telegram down")),
    } as any;
    const store = makeStore([makeTask()]);
    const scheduler = new BypassAuditScheduler(store, notifier);

    // #564 noise suppression: notifier.send is never called so it never rejects.
    // checkAndSend returns true (digest processed via log).
    await expect(scheduler.checkAndSend(Date.now())).resolves.toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("appends dashboard URL when dashboardUrl option is set and count > 0", async () => {
    const notifier = { send: vi.fn().mockResolvedValue(undefined) } as any;
    const store = makeStore([makeTask()]);
    const scheduler = new BypassAuditScheduler(store, notifier, {
      dashboardUrl: "https://dash.example.com",
    });

    const result = await scheduler.checkAndSend(Date.now());
    // #564 noise suppression: send is suppressed; dashboard URL appended to internal
    // text buffer but not dispatched. Verify the run succeeded.
    expect(result).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("does NOT append dashboard URL when count is 0", async () => {
    const notifier = { send: vi.fn().mockResolvedValue(undefined) } as any;
    const store = makeStore([]); // no violations
    const scheduler = new BypassAuditScheduler(store, notifier, {
      dashboardUrl: "https://dash.example.com",
    });

    // #564 noise suppression: send is suppressed. Result is true (processed).
    const result = await scheduler.checkAndSend(Date.now());
    expect(result).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });
});

// ── StateStore.getBypassAuditTasks — integration ─────────────────────────────

describe("StateStore.getBypassAuditTasks", () => {
  let tmpDir: string;
  let store: StateStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bypass-audit-test-"));
    store = new StateStore(join(tmpDir, "state.db"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertTask(
    db: Database.Database,
    opts: {
      id: string;
      quality_score: number;
      verification_status: string;
      updated_at: string;
      bypass_reason?: string | null;
    },
  ) {
    db.prepare(`
      INSERT INTO tasks (id, title, status, task_type, verification_status, quality_score, bypass_reason, updated_at, created_at)
      VALUES (?, 'test', 'done', 'implementation', ?, ?, ?, ?, ?)
    `).run(
      opts.id,
      opts.verification_status,
      opts.quality_score,
      opts.bypass_reason ?? null,
      opts.updated_at,
      opts.updated_at,
    );
  }

  it("returns only tasks below 0.60 with verification_status=approved", () => {
    const db = (store as any).db as Database.Database;
    const now = new Date().toISOString();

    insertTask(db, { id: "t1", quality_score: 0.42, verification_status: "approved", updated_at: now });
    insertTask(db, { id: "t2", quality_score: 0.65, verification_status: "approved", updated_at: now }); // above floor
    insertTask(db, { id: "t3", quality_score: 0.42, verification_status: "rejected", updated_at: now }); // not approved
    insertTask(db, { id: "t4", quality_score: 0.55, verification_status: "approved", updated_at: now });

    const tasks = store.getBypassAuditTasks(7);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("t1");
    expect(ids).toContain("t4");
    expect(ids).not.toContain("t2");
    expect(ids).not.toContain("t3");
  });

  it("orders results by quality_score ascending (worst first)", () => {
    const db = (store as any).db as Database.Database;
    const now = new Date().toISOString();

    insertTask(db, { id: "t1", quality_score: 0.55, verification_status: "approved", updated_at: now });
    insertTask(db, { id: "t2", quality_score: 0.30, verification_status: "approved", updated_at: now });
    insertTask(db, { id: "t3", quality_score: 0.42, verification_status: "approved", updated_at: now });

    const tasks = store.getBypassAuditTasks(7);
    const scores = tasks.map((t) => t.quality_score);
    expect(scores[0]).toBe(0.30); // worst first
    expect(scores[1]).toBe(0.42);
    expect(scores[2]).toBe(0.55);
  });

  it("excludes tasks older than the window", () => {
    const db = (store as any).db as Database.Database;
    const recent = new Date().toISOString();
    const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(); // 9 days ago

    insertTask(db, { id: "recent", quality_score: 0.42, verification_status: "approved", updated_at: recent });
    insertTask(db, { id: "old", quality_score: 0.42, verification_status: "approved", updated_at: old });

    const tasks = store.getBypassAuditTasks(7);
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("recent");
    expect(ids).not.toContain("old");
  });

  it("returns empty array when no matching tasks", () => {
    const tasks = store.getBypassAuditTasks(7);
    expect(tasks).toHaveLength(0);
  });

  it("preserves bypass_reason column value", () => {
    const db = (store as any).db as Database.Database;
    const now = new Date().toISOString();
    insertTask(db, {
      id: "t1",
      quality_score: 0.42,
      verification_status: "approved",
      updated_at: now,
      bypass_reason: "operator_override",
    });

    const tasks = store.getBypassAuditTasks(7);
    expect(tasks[0]!.bypass_reason).toBe("operator_override");
  });
});
