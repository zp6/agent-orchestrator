/**
 * Tests for ScoreZeroApprovalAlerter (issue #375).
 *
 * Acceptance criteria:
 *  1. Alert fires within one daemon cycle of approval (tested via synchronous call).
 *  2. Message includes: score, agent, task title, and bypass path.
 *  3. Alert is suppressed for short-circuit exits (already-in-review, etc.).
 *
 * Coverage:
 *  1.  No alert when score > 0.05
 *  2.  No alert when result.approved is false
 *  3.  Alert fires when score is exactly 0.0 and approved
 *  4.  Alert fires when score is exactly 0.05 (boundary, inclusive)
 *  5.  No alert when score is 0.051 (just above threshold)
 *  6.  Suppressed for short_circuit approvalRationale
 *  7.  Suppressed for 'already-in-review:' result prefix
 *  8.  Suppressed for 'already-handled' result text
 *  9.  NOT suppressed for other approvalRationale values (e.g. 'marginal_approval')
 * 10.  Deduplication: no second alert for same task ID
 *  11. Independent alerts for different task IDs
 * 12.  No alert when notifier is not configured
 * 13.  No alert when notifier is undefined
 * 14.  Message includes task title
 * 15.  Message includes agent name
 * 16.  Message includes score percentage
 * 17.  Message includes bypass path from task.bypass_reason
 * 18.  Message includes approvalRationale when bypass_reason absent
 * 19.  Message includes 'NONE RECORDED' when neither bypass_reason nor approvalRationale present
 * 20.  Message includes dimension breakdown when available
 * 21.  Message includes /override command with task ID
 * 22.  Message includes verifier notes (first 200 chars)
 * 23.  notifyOperator called with 'high' urgency and 'Score-Zero Approval' title
 * 24.  Returns true when alert is sent
 * 25.  Returns false when alert is skipped (high score)
 * 26.  Returns false when notifier not configured
 * 27.  Dedup set cleared on send failure (allows retry)
 * 28.  Custom scoreThreshold is respected
 * 29.  NOT suppressed when operator_override bypass_reason is present (still catastrophic)
 * 30.  SCORE_ZERO_ALERT_THRESHOLD constant equals 0.05
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ScoreZeroApprovalAlerter,
  SCORE_ZERO_ALERT_THRESHOLD,
} from "../reviewer/score-zero-alert.js";
import type { Notifier } from "../notify.js";
import type { VerificationResult } from "../reviewer/verifier.js";
import type { Task } from "../state/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeNotifier(configured = true): { notifier: Notifier; sent: string[]; titles: string[] } {
  const sent: string[] = [];
  const titles: string[] = [];
  const notifier: Notifier = {
    isConfigured: () => configured,
    send: vi.fn(async (text: string) => { sent.push(text); }),
    escalation: vi.fn(),
    taskRejected: vi.fn(),
    supervisorDecision: vi.fn(),
    healthRecovery: vi.fn(),
    memoryDigest: vi.fn(),
    notifyOperator: vi.fn(async (title: string, body: string, _urgency: string) => {
      titles.push(title);
      sent.push(body);
      return true;
    }),
  };
  return { notifier, sent, titles };
}

function makeApprovedResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    approved: true,
    score: 0.0,
    notes: "Work is fundamentally incomplete.",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01HTEST000000000375",
    title: "Implement feature X",
    status: "done",
    task_type: "implementation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bypass_reason: null,
    agent_name: "claude-test-agent",
    result: null,
    ...overrides,
  };
}

// ── Constant ───────────────────────────────────────────────────────────────────

describe("SCORE_ZERO_ALERT_THRESHOLD", () => {
  it("is 0.05", () => {
    expect(SCORE_ZERO_ALERT_THRESHOLD).toBe(0.05);
  });
});

// ── ScoreZeroApprovalAlerter ───────────────────────────────────────────────────

describe("ScoreZeroApprovalAlerter.checkAndAlert", () => {
  let notifier: Notifier;
  let sent: string[];
  let titles: string[];
  let alerter: ScoreZeroApprovalAlerter;

  beforeEach(() => {
    ({ notifier, sent, titles } = makeNotifier());
    alerter = new ScoreZeroApprovalAlerter(notifier);
  });

  // ── Score filtering ─────────────────────────────────────────────────────────

  it("(1) does NOT alert when score > 0.05", async () => {
    const result = makeApprovedResult({ score: 0.10 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("(2) does NOT alert when result.approved is false", async () => {
    const result = makeApprovedResult({ approved: false, score: 0.0 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("(3) alerts when score is exactly 0.0 and approved", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("(4) alerts when score is exactly 0.05 (threshold, inclusive)", async () => {
    const result = makeApprovedResult({ score: 0.05 });
    const task = makeTask({ id: "task-boundary-inclusive" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("(5) does NOT alert when score is 0.051 (just above threshold)", async () => {
    const result = makeApprovedResult({ score: 0.051 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // ── Short-circuit suppression ───────────────────────────────────────────────

  it("(6) suppresses alert when approvalRationale starts with 'short_circuit_'", async () => {
    const result = makeApprovedResult({
      score: 0.0,
      approvalRationale: "short_circuit_no_action_needed",
    });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("(6b) suppresses for 'short_circuit_pre_dispatch_blocked'", async () => {
    const result = makeApprovedResult({
      score: 0.02,
      approvalRationale: "short_circuit_pre_dispatch_blocked",
    });
    const task = makeTask({ id: "task-dispatch-block" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
  });

  it("(7) suppresses when task.result starts with 'already-in-review:'", async () => {
    const result = makeApprovedResult({ score: 0.0, approvalRationale: undefined });
    const task = makeTask({ result: "already-in-review: PR #42 is open and mergeable" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("(8) suppresses for 'already-handled' text in task.result", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ result: "Work is already handled — PR exists" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
  });

  it("(9) does NOT suppress for 'marginal_approval' approvalRationale", async () => {
    const result = makeApprovedResult({ score: 0.0, approvalRationale: "marginal_approval" });
    const task = makeTask({ id: "task-marginal-zero" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("(29) does NOT suppress when operator_override bypass_reason is present", async () => {
    // Score-zero is catastrophic regardless of who authorised the override.
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-op-override-zero", bypass_reason: "operator_override" });
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(true);
    expect(sent).toHaveLength(1);
  });

  // ── Deduplication ───────────────────────────────────────────────────────────

  it("(10) does not send a second alert for the same task ID", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "dedup-task-zero-001" });

    const first = await alerter.checkAndAlert(result, task);
    const second = await alerter.checkAndAlert(result, task);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("(11) sends independent alerts for different task IDs", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const r1 = await alerter.checkAndAlert(result, makeTask({ id: "task-zero-aaa" }));
    const r2 = await alerter.checkAndAlert(result, makeTask({ id: "task-zero-bbb" }));
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(sent).toHaveLength(2);
  });

  // ── Notifier configuration ──────────────────────────────────────────────────

  it("(12) returns false when notifier is not configured", async () => {
    const { notifier: unconfigured } = makeNotifier(false);
    const unconfiguredAlerter = new ScoreZeroApprovalAlerter(unconfigured);
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-unconfigured-notifier" });
    const r = await unconfiguredAlerter.checkAndAlert(result, task);
    expect(r).toBe(false);
  });

  it("(13) returns false when notifier is undefined", async () => {
    const undefinedAlerter = new ScoreZeroApprovalAlerter(undefined);
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-no-notifier" });
    const r = await undefinedAlerter.checkAndAlert(result, task);
    expect(r).toBe(false);
  });

  // ── Message content ─────────────────────────────────────────────────────────

  it("(14) message includes task title", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ title: "Deploy new payment gateway" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("Deploy new payment gateway");
  });

  it("(15) message includes agent name", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ agent_name: "claude-payment-agent" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("claude-payment-agent");
  });

  it("(16) message includes score percentage", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-score-pct-test" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("0.0%");
  });

  it("(16b) message includes non-zero score below threshold", async () => {
    const result = makeApprovedResult({ score: 0.03 });
    const task = makeTask({ id: "task-score-3pct-test" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("3.0%");
  });

  it("(17) message includes bypass path from task.bypass_reason", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ bypass_reason: "operator_override" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("operator_override");
  });

  it("(18) message includes approvalRationale when bypass_reason is absent", async () => {
    const result = makeApprovedResult({ score: 0.0, approvalRationale: "second_pass_passed" });
    const task = makeTask({ id: "task-rationale-fallback", bypass_reason: null });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("second_pass_passed");
  });

  it("(19) message shows 'NONE RECORDED' when neither bypass_reason nor approvalRationale", async () => {
    const result = makeApprovedResult({ score: 0.0, approvalRationale: undefined });
    const task = makeTask({ bypass_reason: null });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("NONE RECORDED");
  });

  it("(20) message includes dimension breakdown when dimensions are available", async () => {
    const result = makeApprovedResult({
      score: 0.0,
      dimensions: {
        correctness: 0.0,
        completeness: 0.0,
        test_coverage: 0.0,
        code_quality: 0.05,
      },
    });
    const task = makeTask({ id: "task-with-dims" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("Correctness");
    expect(sent[0]).toContain("Completeness");
    expect(sent[0]).toContain("Test Coverage");
    expect(sent[0]).toContain("Code Quality");
    expect(sent[0]).toContain("5%"); // code_quality: 0.05 -> 5%
  });

  it("(21) message includes /override command with task ID", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-override-cmd-test" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("/override confirm task-override-cmd-test <reason>");
  });

  it("(22) message includes verifier notes (first 200 chars)", async () => {
    const result = makeApprovedResult({
      score: 0.0,
      notes: "No implementation found. The PR only contains a comment.",
    });
    const task = makeTask({ id: "task-notes-test" });
    await alerter.checkAndAlert(result, task);
    expect(sent[0]).toContain("No implementation found");
  });

  // ── notifyOperator args ─────────────────────────────────────────────────────

  it("(23) calls notifyOperator with 'high' urgency and 'Score-Zero Approval' title", async () => {
    const notifyOperatorSpy = vi.spyOn(notifier, "notifyOperator");
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-urgency-check" });
    await alerter.checkAndAlert(result, task);
    expect(notifyOperatorSpy).toHaveBeenCalledWith(
      "Score-Zero Approval",
      expect.any(String),
      "high",
    );
  });

  it("(23b) notifyOperator body contains 'Score-Zero Approval Detected' header", async () => {
    const notifyOperatorSpy = vi.spyOn(notifier, "notifyOperator");
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-header-check" });
    await alerter.checkAndAlert(result, task);
    expect(notifyOperatorSpy).toHaveBeenCalledWith(
      "Score-Zero Approval",
      expect.stringContaining("Score-Zero Approval Detected"),
      "high",
    );
  });

  // ── Return values ───────────────────────────────────────────────────────────

  it("(24) returns true when alert is sent successfully", async () => {
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(true);
  });

  it("(25) returns false when score is above threshold", async () => {
    const result = makeApprovedResult({ score: 0.80 });
    const task = makeTask();
    const r = await alerter.checkAndAlert(result, task);
    expect(r).toBe(false);
  });

  it("(26) returns false when notifier is not configured", async () => {
    const { notifier: unconfigured } = makeNotifier(false);
    const r = await new ScoreZeroApprovalAlerter(unconfigured).checkAndAlert(
      makeApprovedResult({ score: 0.0 }),
      makeTask({ id: "task-unconfigured-return" }),
    );
    expect(r).toBe(false);
  });

  // ── Error recovery ──────────────────────────────────────────────────────────

  it("(27) removes task from dedup set on send failure, allowing retry", async () => {
    let callCount = 0;
    const failingNotifier: Notifier = {
      isConfigured: () => true,
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      memoryDigest: vi.fn(),
      notifyOperator: vi.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error("Telegram timeout");
        return true;
      }),
    };

    const retryAlerter = new ScoreZeroApprovalAlerter(failingNotifier);
    const result = makeApprovedResult({ score: 0.0 });
    const task = makeTask({ id: "task-retry-test" });

    // First call fails — dedup entry should be removed so retry is possible.
    const first = await retryAlerter.checkAndAlert(result, task);
    expect(first).toBe(false);

    // Second call should succeed after the failure cleared the dedup entry.
    const second = await retryAlerter.checkAndAlert(result, task);
    expect(second).toBe(true);
    expect(callCount).toBe(2);
  });

  // ── Custom threshold ────────────────────────────────────────────────────────

  it("(28) respects a custom scoreThreshold", async () => {
    const customAlerter = new ScoreZeroApprovalAlerter(notifier, { scoreThreshold: 0.10 });

    // 0.08 ≤ 0.10: should alert
    const r1 = await customAlerter.checkAndAlert(
      makeApprovedResult({ score: 0.08 }),
      makeTask({ id: "custom-task-1" }),
    );
    expect(r1).toBe(true);

    // 0.11 > 0.10: should NOT alert
    const r2 = await customAlerter.checkAndAlert(
      makeApprovedResult({ score: 0.11 }),
      makeTask({ id: "custom-task-2" }),
    );
    expect(r2).toBe(false);
  });
});
