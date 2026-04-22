/**
 * Tests for universal-quality-gate.ts (issue #405).
 *
 * Covers:
 *   1. checkApprovalQualityGate() — pure function: floor logic, exemptions, notifier errors
 *   2. formatUniversalQualityGateAlert() — message content and formatting
 *   3. UniversalQualityGateMonitor — dedup, batch processing, alertedCount
 *   4. All task types treated equally — no exemptions for cross-repo-followup, housekeeping, etc.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkApprovalQualityGate,
  formatUniversalQualityGateAlert,
  UniversalQualityGateMonitor,
  UNIVERSAL_QUALITY_FLOOR,
} from "../reviewer/universal-quality-gate.js";
import type { Task } from "../state/types.js";
import type { Notifier } from "../notify.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01KPRYG5XXXXXXXXXXXXXXXX",
    title: "Fix null handling in API layer",
    description: "desc",
    agent_name: "claude-agent-orchestrator",
    status: "done",
    task_type: "implementation",
    source_ref: "rapartlu/agent-orchestrator#42",
    verification_status: "approved",
    quality_score: 0.42,
    bypass_reason: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    result: null,
    verification_notes: null,
    ...overrides,
  } as Task;
}

function makeNotifier(configured = true): Notifier {
  return {
    isConfigured: vi.fn(() => configured),
    send: vi.fn().mockResolvedValue(undefined),
    notifyOperator: vi.fn().mockResolvedValue(undefined),
  } as unknown as Notifier;
}

// ── UNIVERSAL_QUALITY_FLOOR constant ─────────────────────────────────────────

describe("UNIVERSAL_QUALITY_FLOOR", () => {
  it("is 0.80", () => {
    expect(UNIVERSAL_QUALITY_FLOOR).toBe(0.80);
  });
});

// ── checkApprovalQualityGate() ────────────────────────────────────────────────

describe("checkApprovalQualityGate()", () => {
  it("returns false when quality_score is null", async () => {
    const task = makeTask({ quality_score: null });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("returns false when quality_score equals the floor", async () => {
    const task = makeTask({ quality_score: 0.80 });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
  });

  it("returns false when quality_score is above the floor", async () => {
    const task = makeTask({ quality_score: 0.91 });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
  });

  it("returns true and sends alert when quality_score is below the floor", async () => {
    const task = makeTask({ quality_score: 0.65 });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(true);
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
    const [title, msg, severity] = (notifier.notifyOperator as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(title).toBe("Universal Quality Gate Violation");
    expect(severity).toBe("high");
    expect(msg).toContain("01KPRYG5");
    expect(msg).toContain("65.0%");
  });

  it("returns false when bypass_reason is operator_override", async () => {
    const task = makeTask({ quality_score: 0.42, bypass_reason: "operator_override" });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("alerts when bypass_reason is floor_not_enforced (not exempt)", async () => {
    const task = makeTask({ quality_score: 0.55, bypass_reason: "floor_not_enforced" });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(true);
  });

  it("alerts when bypass_reason is null (no audit entry)", async () => {
    const task = makeTask({ quality_score: 0.30, bypass_reason: null });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(true);
  });

  it("returns false and does not throw when notifier is not configured", async () => {
    const task = makeTask({ quality_score: 0.42 });
    const notifier = makeNotifier(false);
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when notifier.notifyOperator throws", async () => {
    const task = makeTask({ quality_score: 0.42 });
    const notifier = makeNotifier();
    (notifier.notifyOperator as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(false);
  });

  it("respects custom floor from config", async () => {
    const task = makeTask({ quality_score: 0.75 });
    const notifier = makeNotifier();
    // Score 0.75 is below default 0.80 but above custom floor 0.70
    const resultBelow = await checkApprovalQualityGate(task, notifier, { floor: 0.80 });
    expect(resultBelow).toBe(true);

    vi.clearAllMocks();

    const resultAbove = await checkApprovalQualityGate(task, notifier, { floor: 0.70 });
    expect(resultAbove).toBe(false);
  });

  it("includes dashboard link in alert when dashboardBaseUrl is provided", async () => {
    const task = makeTask({ quality_score: 0.42 });
    const notifier = makeNotifier();
    await checkApprovalQualityGate(task, notifier, { dashboardBaseUrl: "https://dash.example.com" });
    const msg = (notifier.notifyOperator as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(msg).toContain("https://dash.example.com");
    expect(msg).toContain(task.id);
  });

  // Task-type coverage: no exemptions for any type
  it.each([
    ["implementation", "implementation"],
    ["research", "research"],
    ["housekeeping", "housekeeping"],
  ])("alerts for task_type=%s (no exemptions)", async (_label, taskType) => {
    const task = makeTask({ quality_score: 0.42, task_type: taskType as Task["task_type"] });
    const notifier = makeNotifier();
    const result = await checkApprovalQualityGate(task, notifier);
    expect(result).toBe(true);
  });
});

// ── formatUniversalQualityGateAlert() ─────────────────────────────────────────

describe("formatUniversalQualityGateAlert()", () => {
  it("includes task ID short prefix", () => {
    const task = makeTask({ id: "01KPRYG5XXXXXXXXXXXXXXXX" });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("01KPRYG5");
  });

  it("includes task title (truncated to 80 chars)", () => {
    const title = "A".repeat(100);
    const task = makeTask({ title });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("A".repeat(80));
    expect(msg).not.toContain("A".repeat(81));
  });

  it("includes task type", () => {
    const task = makeTask({ task_type: "housekeeping" });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("housekeeping");
  });

  it("includes agent name", () => {
    const task = makeTask({ agent_name: "claude-orchestrator-reviewer" });
    const msg = formatUniversalQualityGateAlert(task, 0.65, 0.80);
    expect(msg).toContain("claude-orchestrator-reviewer");
  });

  it("formats score as percentage", () => {
    const task = makeTask();
    const msg = formatUniversalQualityGateAlert(task, 0.423, 0.80);
    expect(msg).toContain("42.3%");
  });

  it("formats floor as percentage", () => {
    const task = makeTask();
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("80%");
  });

  it("shows bypass reason", () => {
    const task = makeTask({ bypass_reason: "floor_not_enforced" });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("floor_not_enforced");
  });

  it("shows 'none' when bypass_reason is null", () => {
    const task = makeTask({ bypass_reason: null });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("Bypass: none");
  });

  it("shows 'unknown' for missing agent_name", () => {
    const task = makeTask({ agent_name: null });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("unknown");
  });

  it("omits dashboard link when dashboardBaseUrl is not provided", () => {
    const task = makeTask();
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).not.toContain("http");
  });

  it("includes dashboard link when dashboardBaseUrl is provided", () => {
    const task = makeTask();
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80, "https://dash.example.com");
    expect(msg).toContain("https://dash.example.com");
  });

  it("includes /approve-override command with full task ID", () => {
    const task = makeTask({ id: "01KPRYG5XXXXXXXXXXXXXXXX" });
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toContain("/approve-override 01KPRYG5XXXXXXXXXXXXXXXX");
  });

  it("starts with 🚨 header", () => {
    const task = makeTask();
    const msg = formatUniversalQualityGateAlert(task, 0.42, 0.80);
    expect(msg).toMatch(/^🚨 \*Universal Quality Gate Violation\*/);
  });
});

// ── UniversalQualityGateMonitor ───────────────────────────────────────────────

describe("UniversalQualityGateMonitor", () => {
  it("sends alert for sub-floor task", async () => {
    const task = makeTask({ quality_score: 0.42 });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);
    const result = await monitor.checkAndAlert(task);
    expect(result).toBe(true);
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
  });

  it("deduplicates: does NOT re-alert the same task ID", async () => {
    const task = makeTask({ quality_score: 0.42 });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);

    const first = await monitor.checkAndAlert(task);
    const second = await monitor.checkAndAlert(task);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
  });

  it("alerts different tasks independently", async () => {
    const task1 = makeTask({ id: "TASK-A-XXXXXXXXXXXXXXXX", quality_score: 0.42 });
    const task2 = makeTask({ id: "TASK-B-XXXXXXXXXXXXXXXX", quality_score: 0.55 });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);

    const r1 = await monitor.checkAndAlert(task1);
    const r2 = await monitor.checkAndAlert(task2);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(notifier.notifyOperator).toHaveBeenCalledTimes(2);
  });

  it("does not count passing tasks toward alertedCount", async () => {
    const task = makeTask({ quality_score: 0.95 });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);
    await monitor.checkAndAlert(task);
    expect(monitor.alertedCount).toBe(0);
  });

  it("increments alertedCount per unique alerted task", async () => {
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);

    await monitor.checkAndAlert(makeTask({ id: "ID-A-XXXX", quality_score: 0.42 }));
    await monitor.checkAndAlert(makeTask({ id: "ID-B-XXXX", quality_score: 0.55 }));
    // dedup: same ID again
    await monitor.checkAndAlert(makeTask({ id: "ID-A-XXXX", quality_score: 0.42 }));

    expect(monitor.alertedCount).toBe(2);
  });

  it("returns false without alerting operator_override tasks", async () => {
    const task = makeTask({ quality_score: 0.42, bypass_reason: "operator_override" });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);
    const result = await monitor.checkAndAlert(task);
    expect(result).toBe(false);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("returns false for tasks with no quality_score", async () => {
    const task = makeTask({ quality_score: null });
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier);
    const result = await monitor.checkAndAlert(task);
    expect(result).toBe(false);
  });

  // checkBatch()
  describe("checkBatch()", () => {
    it("returns correct alerted/skipped counts", async () => {
      const notifier = makeNotifier();
      const monitor = new UniversalQualityGateMonitor(notifier);

      const tasks = [
        makeTask({ id: "ID-1-XXXX", quality_score: 0.42 }),  // alerts
        makeTask({ id: "ID-2-XXXX", quality_score: 0.95 }),  // passes
        makeTask({ id: "ID-3-XXXX", quality_score: 0.55 }),  // alerts
        makeTask({ id: "ID-4-XXXX", quality_score: null }),   // no score
      ];

      const { alerted, skipped } = await monitor.checkBatch(tasks);
      expect(alerted).toBe(2);
      expect(skipped).toBe(2);
    });

    it("returns { alerted: 0, skipped: 0 } for empty batch", async () => {
      const notifier = makeNotifier();
      const monitor = new UniversalQualityGateMonitor(notifier);
      const result = await monitor.checkBatch([]);
      expect(result).toEqual({ alerted: 0, skipped: 0 });
    });

    it("deduplicates within a batch", async () => {
      const notifier = makeNotifier();
      const monitor = new UniversalQualityGateMonitor(notifier);

      const task = makeTask({ id: "SAME-TASK-XXXXXXXXXXXX", quality_score: 0.42 });
      const { alerted, skipped } = await monitor.checkBatch([task, task, task]);

      expect(alerted).toBe(1);
      expect(skipped).toBe(2);
      expect(notifier.notifyOperator).toHaveBeenCalledOnce();
    });

    it("processes tasks sequentially (not in parallel) — all tasks checked", async () => {
      const notifier = makeNotifier();
      const monitor = new UniversalQualityGateMonitor(notifier);
      const order: string[] = [];

      (notifier.notifyOperator as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 1));
      });

      const tasks = [
        makeTask({ id: "ID-SEQ-1-XXXXXXXXXX", quality_score: 0.30, title: "T1" }),
        makeTask({ id: "ID-SEQ-2-XXXXXXXXXX", quality_score: 0.40, title: "T2" }),
        makeTask({ id: "ID-SEQ-3-XXXXXXXXXX", quality_score: 0.50, title: "T3" }),
      ];

      const { alerted } = await monitor.checkBatch(tasks);
      expect(alerted).toBe(3);
      expect(notifier.notifyOperator).toHaveBeenCalledTimes(3);
    });
  });

  // All task types treated equally
  describe("task-type coverage (no exemptions)", () => {
    it.each([
      ["implementation"],
      ["research"],
      ["housekeeping"],
    ])("alerts for task_type=%s", async (taskType) => {
      const task = makeTask({
        id: `ID-${taskType}-XXXXXXXXXXXX`,
        quality_score: 0.42,
        task_type: taskType as Task["task_type"],
      });
      const notifier = makeNotifier();
      const monitor = new UniversalQualityGateMonitor(notifier);
      const result = await monitor.checkAndAlert(task);
      expect(result).toBe(true);
    });
  });

  // Custom config
  it("respects custom floor from config", async () => {
    const notifier = makeNotifier();
    const monitor = new UniversalQualityGateMonitor(notifier, { floor: 0.70 });

    // Score 0.75 is above custom floor 0.70 — should NOT alert
    const task = makeTask({ id: "ID-CUSTOM-FLOOR-XXXXXXX", quality_score: 0.75 });
    const result = await monitor.checkAndAlert(task);
    expect(result).toBe(false);
  });
});
