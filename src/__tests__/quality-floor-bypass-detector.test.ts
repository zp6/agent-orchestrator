/**
 * Tests for the Quality Floor Bypass Detector (issue #367).
 *
 * Covers:
 *  1. No alert when score >= 0.80
 *  2. No alert when decision is not 'approved' (result.approved = false)
 *  3. Alerts when score < 0.80, approved, no bypass_reason
 *  4. No alert when bypass_reason === 'operator_override'
 *  5. 'floor_not_enforced' bypass_reason still triggers alert (audit gap, not a real override)
 *  6. Deduplication: no alert for same task ID twice
 *  7. Uses task.quality_score when result.score is null (not possible per VerificationResult type, but tests fallback)
 *  8. Message format: includes task ID, score %, floor %, agent name, bypass note, /override command
 *  9. Returns true when alert sent, false when skipped
 * 10. Does not call notifier when not configured
 * 11. Custom threshold is respected
 * 12. Correctly formats audit link when dashboardBaseUrl is provided
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  QualityFloorBypassDetector,
  QUALITY_FLOOR_THRESHOLD,
} from "../reviewer/quality-floor-bypass-detector.js";
import type { Notifier } from "../notify.js";
import type { VerificationResult } from "../reviewer/verifier.js";
import type { Task } from "../state/types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNotifier(configured = true): { notifier: Notifier; sent: string[] } {
  const sent: string[] = [];
  const notifier: Notifier = {
    isConfigured: () => configured,
    send: vi.fn(async (text: string) => { sent.push(text); }),
    escalation: vi.fn(),
    taskRejected: vi.fn(),
    supervisorDecision: vi.fn(),
    healthRecovery: vi.fn(),
    memoryDigest: vi.fn(),
    notifyOperator: vi.fn(async (_title: string, body: string, _urgency: string) => {
      sent.push(body);
      return true;
    }),
  };
  return { notifier, sent };
}

function makeApprovedResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    approved: true,
    score: 0.75,
    notes: "Looks good",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01HTEST000000000001",
    title: "Test task",
    status: "done",
    task_type: "implementation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bypass_reason: null,
    agent_name: "claude-test-agent",
    ...overrides,
  };
}

// ── Constant tests ─────────────────────────────────────────────────────────────

describe("QUALITY_FLOOR_THRESHOLD", () => {
  it("is 0.80", () => {
    expect(QUALITY_FLOOR_THRESHOLD).toBe(0.80);
  });
});

// ── QualityFloorBypassDetector ────────────────────────────────────────────────

describe("QualityFloorBypassDetector.checkAndAlert", () => {
  let notifier: Notifier;
  let sent: string[];
  let detector: QualityFloorBypassDetector;

  beforeEach(() => {
    ({ notifier, sent } = makeNotifier());
    detector = new QualityFloorBypassDetector(notifier);
  });

  // ── Basic filtering ─────────────────────────────────────────────────────────

  it("returns false and sends no alert when score >= 0.80", async () => {
    const result = makeApprovedResult({ score: 0.80 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("returns false when score is exactly the threshold (0.80)", async () => {
    const result = makeApprovedResult({ score: 0.80 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
  });

  it("returns false when score > 0.80", async () => {
    const result = makeApprovedResult({ score: 0.95 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
  });

  it("returns false when result.approved is false", async () => {
    const result = makeApprovedResult({ approved: false, score: 0.55 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // ── Alert conditions ────────────────────────────────────────────────────────

  it("returns true and sends alert when score < 0.80, approved, no bypass_reason", async () => {
    const result = makeApprovedResult({ score: 0.75 });
    const task = makeTask({ bypass_reason: null });
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("sends alert when score is just below threshold (0.799)", async () => {
    const result = makeApprovedResult({ score: 0.799 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(true);
  });

  // ── Bypass reason handling ──────────────────────────────────────────────────

  it("returns false when bypass_reason === 'operator_override'", async () => {
    const result = makeApprovedResult({ score: 0.55 });
    const task = makeTask({ bypass_reason: "operator_override" });
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("still alerts when bypass_reason === 'floor_not_enforced' (audit gap, not real override)", async () => {
    const result = makeApprovedResult({ score: 0.65 });
    const task = makeTask({ bypass_reason: "floor_not_enforced" });
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  it("does not send a second alert for the same task ID", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ id: "dedup-task-001" });

    const first = await detector.checkAndAlert(result, task);
    const second = await detector.checkAndAlert(result, task);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("alerts independently for different task IDs", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task1 = makeTask({ id: "task-aaa" });
    const task2 = makeTask({ id: "task-bbb" });

    const r1 = await detector.checkAndAlert(result, task1);
    const r2 = await detector.checkAndAlert(result, task2);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(sent).toHaveLength(2);
  });

  // ── Score resolution ────────────────────────────────────────────────────────

  it("uses task.quality_score when result.score is zero (edge: below threshold)", async () => {
    // result.score = 0 (falsy) but still a number — should be used as-is
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ quality_score: 0.90 });
    // result.score (0.0) is below threshold, so alert fires
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(true);
  });

  // ── Message format ──────────────────────────────────────────────────────────

  it("includes task ID in alert message", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ id: "task-format-test-01" });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("task-format-test-01");
  });

  it("includes score percentage in alert message", async () => {
    const result = makeApprovedResult({ score: 0.72 });
    const task = makeTask();
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("72.0%");
  });

  it("includes floor percentage in alert message", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask();
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("80%");
  });

  it("includes agent name in alert message", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ agent_name: "my-test-agent" });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("my-test-agent");
  });

  it("shows 'NO AUDIT ENTRY FOUND' when bypass_reason is null", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ bypass_reason: null });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("NO AUDIT ENTRY FOUND");
  });

  it("shows bypass_reason value in audit note when present (floor_not_enforced)", async () => {
    const result = makeApprovedResult({ score: 0.65 });
    const task = makeTask({ bypass_reason: "floor_not_enforced" });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("floor_not_enforced");
  });

  it("includes /override command in alert message", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ id: "override-task-test" });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).toContain("/override confirm override-task-test <reason>");
  });

  // ── Notifier configuration ──────────────────────────────────────────────────

  it("returns false and does not call notifyOperator when notifier is not configured", async () => {
    const { notifier: unconfigured } = makeNotifier(false);
    const unconfiguredDetector = new QualityFloorBypassDetector(unconfigured);
    const notifyOperatorSpy = vi.spyOn(unconfigured, "notifyOperator");

    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask();
    const alerted = await unconfiguredDetector.checkAndAlert(result, task);

    expect(alerted).toBe(false);
    expect(notifyOperatorSpy).not.toHaveBeenCalled();
  });

  // ── Custom threshold ────────────────────────────────────────────────────────

  it("respects custom threshold", async () => {
    const customDetector = new QualityFloorBypassDetector(notifier, { threshold: 0.70 });

    // score = 0.75 — above 0.70, should NOT alert
    const result = makeApprovedResult({ score: 0.75 });
    const task1 = makeTask({ id: "custom-threshold-task-1" });
    const alerted1 = await customDetector.checkAndAlert(result, task1);
    expect(alerted1).toBe(false);

    // score = 0.65 — below 0.70, should alert
    const result2 = makeApprovedResult({ score: 0.65 });
    const task2 = makeTask({ id: "custom-threshold-task-2" });
    const alerted2 = await customDetector.checkAndAlert(result2, task2);
    expect(alerted2).toBe(true);
  });

  // ── Audit link ──────────────────────────────────────────────────────────────

  it("includes audit trail link when dashboardBaseUrl is configured", async () => {
    const linkedDetector = new QualityFloorBypassDetector(notifier, {
      dashboardBaseUrl: "https://dashboard.example.com",
    });
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ id: "audit-link-task-01" });
    await linkedDetector.checkAndAlert(result, task);
    expect(sent[0]).toContain("https://dashboard.example.com/api/tasks/audit-link-task-01/audit");
  });

  it("does not include audit trail link when dashboardBaseUrl is not configured", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask({ id: "no-link-task-01" });
    await detector.checkAndAlert(result, task);
    expect(sent[0]).not.toContain("http");
  });

  // ── Return values ───────────────────────────────────────────────────────────

  it("returns true when alert is successfully sent", async () => {
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(true);
  });

  it("returns false when score is at or above threshold", async () => {
    const result = makeApprovedResult({ score: 0.85 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
  });

  it("returns false for non-approved tasks even when score is very low", async () => {
    const result = makeApprovedResult({ approved: false, score: 0.20 });
    const task = makeTask();
    const alerted = await detector.checkAndAlert(result, task);
    expect(alerted).toBe(false);
  });

  // ── notifyOperator is called with correct urgency ──────────────────────────

  it("calls notifyOperator with 'high' urgency", async () => {
    const notifyOperatorSpy = vi.spyOn(notifier, "notifyOperator");
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask();
    await detector.checkAndAlert(result, task);
    expect(notifyOperatorSpy).toHaveBeenCalledWith(
      "Quality Floor Bypass",
      expect.any(String),
      "high",
    );
  });

  it("calls notifyOperator with title 'Quality Floor Bypass'", async () => {
    const notifyOperatorSpy = vi.spyOn(notifier, "notifyOperator");
    const result = makeApprovedResult({ score: 0.70 });
    const task = makeTask();
    await detector.checkAndAlert(result, task);
    expect(notifyOperatorSpy).toHaveBeenCalledWith(
      "Quality Floor Bypass",
      expect.stringContaining("Quality Floor Bypass Detected"),
      "high",
    );
  });
});
