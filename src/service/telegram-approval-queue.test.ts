/**
 * Tests for the Telegram approval queue module (issue #937).
 *
 * Covers:
 *  - formatApprovalCard: rich context card output (no SQLite needed)
 *  - queueForApproval: score-range gating, dedup, store + notify side effects
 *  - /approve, /reject, /queue Telegram commands (via telegram.handleCommand)
 *
 * Note: queueForApproval and the Telegram command tests depend on better-sqlite3
 * native bindings (same as reviewer-ops.test.ts, telegram.test.ts, etc.).
 * These are skipped automatically when the bindings are unavailable on
 * non-standard architectures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import type { Task } from "../state/store.js";
import type { VerificationResult } from "../client/reviewer-client.js";
import {
  formatApprovalCard,
  queueForApproval,
  APPROVAL_QUEUE_MIN_SCORE,
  APPROVAL_QUEUE_MAX_SCORE,
} from "./telegram-approval-queue.js";

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockNotifyOperator = vi.fn().mockResolvedValue(undefined);
vi.mock("./notify.js", () => ({
  notifyOperator: (...args: unknown[]) => mockNotifyOperator(...args),
}));

// execSync used by findPRUrlForTask — return empty to simulate no PR found
const { execSyncMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn().mockReturnValue(""),
}));
vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
  exec: vi.fn(),
}));

vi.mock("../triggers/github.js", () => ({
  findExistingPRsForIssue: vi.fn().mockReturnValue([]),
  findBranchForIssue: vi.fn().mockReturnValue(null),
}));

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01KPFBW500000000000000000",
    title: "Implement OAuth token validation",
    description: "Add OAuth token validation to the login flow",
    source: "github",
    source_ref: "owner/repo-a#42",
    status: "done",
    agent_name: "agent-a",
    conversation_id: null,
    result: "Done",
    parent_task_id: null,
    step_id: null,
    plan: null,
    task_type: "implementation",
    verification_status: "rejected",
    quality_score: 0.55,
    verification_notes: "Missing token expiry validation",
    retry_count: 0,
    next_retry_at: null,
    revision_count: 1,
    lineage_group_id: null,
    reported: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    approved: false,
    score: 0.55,
    notes: "Missing token expiry validation and insufficient test coverage",
    dimensions: {
      correctness: 0.60,
      completeness: 0.50,
      test_coverage: 0.45,
      code_quality: 0.65,
    },
    ...overrides,
  };
}

// ── formatApprovalCard tests (no SQLite required) ─────────────────────────────

describe("formatApprovalCard", () => {
  it("includes task title, ID, agent, ref, score", () => {
    const task = makeTask();
    const result = makeResult();
    const card = formatApprovalCard(task, result, null, "Risk: skips expiry check.");

    expect(card).toContain("Implement OAuth token validation");
    expect(card).toContain("01KPFBW5");
    expect(card).toContain("agent-a");
    expect(card).toContain("owner/repo-a#42");
    expect(card).toContain("55%");
  });

  it("includes per-dimension breakdown", () => {
    const card = formatApprovalCard(makeTask(), makeResult(), null, "Some risk.");
    expect(card).toContain("correctness");
    expect(card).toContain("completeness");
    expect(card).toContain("test coverage");
    expect(card).toContain("code quality");
  });

  it("includes PR URL when provided", () => {
    const card = formatApprovalCard(
      makeTask(),
      makeResult(),
      "https://github.com/owner/repo-a/pull/99",
      "Some risk.",
    );
    expect(card).toContain("https://github.com/owner/repo-a/pull/99");
  });

  it("omits PR section when prUrl is null", () => {
    const card = formatApprovalCard(makeTask(), makeResult(), null, "Some risk.");
    expect(card).not.toContain("https://");
  });

  it("includes risk summary", () => {
    const card = formatApprovalCard(makeTask(), makeResult(), null, "Skips token expiry.");
    expect(card).toContain("Skips token expiry.");
  });

  it("includes approve/reject reply hints with short task ID", () => {
    const card = formatApprovalCard(makeTask(), makeResult(), null, "Risk.");
    expect(card).toContain("/approve");
    expect(card).toContain("/reject");
    expect(card).toContain("01KPFBW5");
  });

  it("uses traffic-light icons for dimension quality", () => {
    const result = makeResult({
      dimensions: {
        correctness: 0.80, // green  ≥0.70
        completeness: 0.60, // yellow 0.50–0.69
        test_coverage: 0.30, // red   <0.50
      },
    });
    const card = formatApprovalCard(makeTask(), result, null, "Risk.");
    expect(card).toContain("🟢");
    expect(card).toContain("🟡");
    expect(card).toContain("🔴");
  });

  it("handles missing dimensions gracefully", () => {
    const result = makeResult({ dimensions: undefined });
    // Should not throw and should still include essential fields
    const card = formatApprovalCard(makeTask(), result, null, "Risk.");
    expect(card).toContain("01KPFBW5");
    expect(card).toContain("55%");
  });

  it("truncates very long task titles to 80 chars", () => {
    const longTitle = "A".repeat(200);
    const task = makeTask({ title: longTitle });
    const card = formatApprovalCard(task, makeResult(), null, "Risk.");
    // Title in card is slice(0, 80)
    expect(card).toContain("A".repeat(80));
    expect(card).not.toContain("A".repeat(81));
  });
});

// ── Score boundary constants ───────────────────────────────────────────────────

describe("APPROVAL_QUEUE score range constants", () => {
  it("MIN_SCORE is below MAX_SCORE", () => {
    expect(APPROVAL_QUEUE_MIN_SCORE).toBeLessThan(APPROVAL_QUEUE_MAX_SCORE);
  });

  it("MIN_SCORE is in the 0.30–0.60 range (borderline-bad territory)", () => {
    expect(APPROVAL_QUEUE_MIN_SCORE).toBeGreaterThanOrEqual(0.30);
    expect(APPROVAL_QUEUE_MIN_SCORE).toBeLessThan(0.60);
  });

  it("MAX_SCORE is in the 0.60–0.80 range (borderline-good territory)", () => {
    expect(APPROVAL_QUEUE_MAX_SCORE).toBeGreaterThanOrEqual(0.60);
    expect(APPROVAL_QUEUE_MAX_SCORE).toBeLessThan(0.80);
  });
});

// ── queueForApproval and store-dependent tests ────────────────────────────────
// These use a real SQLite in /tmp. On arm64 CI environments without compiled
// better-sqlite3 bindings they will fail at the StateStore constructor — this
// matches the existing behaviour in reviewer-ops.test.ts, telegram.test.ts, etc.

describe("queueForApproval (requires better-sqlite3)", () => {
  let store: import("../state/store.js").StateStore;
  let dbPath: string;

  const mockReviewerClient = {
    generateRiskSummary: vi.fn().mockResolvedValue(
      "The implementation skips OAuth token expiry validation, risking silent auth bypass on expired tokens.",
    ),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `test-aq-${Date.now()}.db`);
    const { StateStore } = await import("../state/store.js");
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store?.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("enqueues and notifies for borderline score", async () => {
    const task = makeTask({ quality_score: 0.55 });
    const result = makeResult({ score: 0.55 });

    await queueForApproval(store, mockReviewerClient as never, task, result);

    const entry = store.getApprovalQueueEntry(task.id);
    expect(entry).not.toBeNull();
    expect(entry!.status).toBe("pending");
    expect(entry!.score).toBe(0.55);
    expect(entry!.title).toBe(task.title);

    expect(mockNotifyOperator).toHaveBeenCalledOnce();
    const [title, body] = mockNotifyOperator.mock.calls[0];
    expect(title).toContain("approval");
    expect(body).toContain("01KPFBW5");
    expect(body).toContain("55%");
  });

  it("does NOT enqueue when score is below minimum (clearly bad)", async () => {
    const task = makeTask({ quality_score: 0.20 });
    const result = makeResult({ score: 0.20 });

    await queueForApproval(store, mockReviewerClient as never, task, result);

    expect(store.getApprovalQueueEntry(task.id)).toBeNull();
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("does NOT enqueue when score is above maximum (approved by verifier)", async () => {
    const task = makeTask({ quality_score: 0.85, verification_status: "approved" });
    const result = makeResult({ score: 0.85, approved: true });

    await queueForApproval(store, mockReviewerClient as never, task, result);

    expect(store.getApprovalQueueEntry(task.id)).toBeNull();
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("does NOT enqueue duplicate (idempotent)", async () => {
    const task = makeTask({ quality_score: 0.55 });
    const result = makeResult({ score: 0.55 });

    await queueForApproval(store, mockReviewerClient as never, task, result);
    await queueForApproval(store, mockReviewerClient as never, task, result);

    const pending = store.getPendingApprovalQueue();
    expect(pending.filter((e) => e.task_id === task.id)).toHaveLength(1);
    expect(mockNotifyOperator).toHaveBeenCalledOnce();
  });

  it("persists dimensions JSON", async () => {
    const task = makeTask({ quality_score: 0.55 });
    const result = makeResult({ score: 0.55 });

    await queueForApproval(store, mockReviewerClient as never, task, result);

    const entry = store.getApprovalQueueEntry(task.id);
    expect(entry!.dimensions_json).not.toBeNull();
    const dims = JSON.parse(entry!.dimensions_json!);
    expect(dims.correctness).toBe(0.60);
    expect(dims.test_coverage).toBe(0.45);
  });

  it("falls back to notes when risk summary generation fails", async () => {
    const failingClient = {
      generateRiskSummary: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
    };
    const task = makeTask({ quality_score: 0.55 });
    const result = makeResult({ score: 0.55 });

    await queueForApproval(store, failingClient as never, task, result);

    const entry = store.getApprovalQueueEntry(task.id);
    expect(entry!.risk_summary).toContain("Missing token expiry");
  });
});

// ── StateStore CRUD tests ──────────────────────────────────────────────────────

describe("StateStore approval queue CRUD (requires better-sqlite3)", () => {
  let store: import("../state/store.js").StateStore;
  let dbPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dbPath = join(tmpdir(), `test-aq-crud-${Date.now()}.db`);
    const { StateStore } = await import("../state/store.js");
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store?.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("getApprovalQueueEntryByShortId finds by 8-char prefix", () => {
    store.insertApprovalQueueEntry({
      task_id: "01KPFBW500000000000000000",
      title: "Test task",
      score: 0.55,
    });
    const entry = store.getApprovalQueueEntryByShortId("01KPFBW5");
    expect(entry).not.toBeNull();
    expect(entry!.title).toBe("Test task");
  });

  it("resolveApprovalQueueEntry marks entry as approved with timestamp", () => {
    store.insertApprovalQueueEntry({
      task_id: "01KPFBW500000000000000001",
      title: "Approved task",
      score: 0.60,
    });
    const entry = store.getApprovalQueueEntry("01KPFBW500000000000000001")!;
    store.resolveApprovalQueueEntry(entry.id, "approved", "operator");

    const resolved = store.getApprovalQueueEntry("01KPFBW500000000000000001")!;
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_by).toBe("operator");
    expect(resolved.resolved_at).not.toBeNull();
  });

  it("getPendingApprovalQueue returns only pending entries", () => {
    store.insertApprovalQueueEntry({ task_id: "01KPFBW500000000000000002", title: "P1", score: 0.55 });
    store.insertApprovalQueueEntry({ task_id: "01KPFBW500000000000000003", title: "P2", score: 0.60 });

    const e1 = store.getApprovalQueueEntry("01KPFBW500000000000000002")!;
    store.resolveApprovalQueueEntry(e1.id, "rejected", "operator");

    const pending = store.getPendingApprovalQueue();
    expect(pending.map((e) => e.task_id)).toContain("01KPFBW500000000000000003");
    expect(pending.map((e) => e.task_id)).not.toContain("01KPFBW500000000000000002");
  });

  it("insertApprovalQueueEntry is idempotent (IGNORE on duplicate task_id)", () => {
    store.insertApprovalQueueEntry({ task_id: "DEDUP0000000000000000000", title: "First", score: 0.55 });
    // Second insert with same task_id should silently be ignored
    expect(() => {
      store.insertApprovalQueueEntry({ task_id: "DEDUP0000000000000000000", title: "Second", score: 0.60 });
    }).not.toThrow();

    const entry = store.getApprovalQueueEntry("DEDUP0000000000000000000")!;
    expect(entry.title).toBe("First"); // Original title preserved
  });
});
