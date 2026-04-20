/**
 * Tests for the sub-0.60 bypass-reason gate (issue #379).
 *
 * Verifies:
 *   1. `BYPASS_REASON_FLOOR` constant equals 0.60
 *   2. `checkBypassReasonGate()` returns correct outcomes for all cases
 *   3. `buildBypassRejectionFeedback()` produces well-formed messages
 *   4. `Verifier.applyBypassReasonGate()` correctly gates low-score approvals
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  BYPASS_REASON_FLOOR,
  checkBypassReasonGate,
  buildBypassRejectionFeedback,
  Verifier,
} from "../reviewer/verifier.js";
import type { VerificationResult } from "../reviewer/verifier.js";

// ── Minimal mock store ────────────────────────────────────────────────────────

function makeMockStore(): ConstructorParameters<typeof Verifier>[0] {
  return {
    getTask: () => undefined,
    updateTask: () => undefined,
    createTask: () => ({ id: "TASK001", title: "t", status: "done", source: "manual", created_at: "", updated_at: "" }),
    listTasks: () => [],
    addLog: () => undefined,
    getChildTasks: () => [],
  } as unknown as ConstructorParameters<typeof Verifier>[0];
}

// ── Helper: build a VerificationResult ───────────────────────────────────────

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    approved: true,
    score: 0.50,
    notes: "Some notes",
    ...overrides,
  };
}

// ── BYPASS_REASON_FLOOR ───────────────────────────────────────────────────────

describe("BYPASS_REASON_FLOOR", () => {
  it("equals 0.60", () => {
    expect(BYPASS_REASON_FLOOR).toBe(0.60);
  });
});

// ── checkBypassReasonGate ─────────────────────────────────────────────────────

describe("checkBypassReasonGate", () => {
  describe("score >= BYPASS_REASON_FLOOR (above floor)", () => {
    it("returns above_floor for score exactly 0.60", () => {
      const result = checkBypassReasonGate(0.60);
      expect(result.outcome).toBe("above_floor");
      expect(result.blocked).toBe(false);
      expect(result.score).toBe(0.60);
    });

    it("returns above_floor for score 0.80", () => {
      const result = checkBypassReasonGate(0.80);
      expect(result.outcome).toBe("above_floor");
      expect(result.blocked).toBe(false);
    });

    it("returns above_floor for score 1.0", () => {
      const result = checkBypassReasonGate(1.0);
      expect(result.outcome).toBe("above_floor");
      expect(result.blocked).toBe(false);
    });

    it("does not include bypass_reason in above_floor result", () => {
      const result = checkBypassReasonGate(0.75, "some reason");
      expect(result.outcome).toBe("above_floor");
      expect(result.bypass_reason).toBeUndefined();
    });
  });

  describe("score < BYPASS_REASON_FLOOR with no bypass_reason", () => {
    it("returns blocked_no_reason for score 0.59 with no reason", () => {
      const result = checkBypassReasonGate(0.59);
      expect(result.outcome).toBe("blocked_no_reason");
      expect(result.blocked).toBe(true);
    });

    it("returns blocked_no_reason for score 0.0 with no reason", () => {
      const result = checkBypassReasonGate(0.0);
      expect(result.outcome).toBe("blocked_no_reason");
      expect(result.blocked).toBe(true);
    });

    it("returns blocked_no_reason when bypass_reason is null", () => {
      const result = checkBypassReasonGate(0.50, null);
      expect(result.outcome).toBe("blocked_no_reason");
      expect(result.blocked).toBe(true);
    });

    it("returns blocked_no_reason when bypass_reason is empty string", () => {
      const result = checkBypassReasonGate(0.50, "");
      expect(result.outcome).toBe("blocked_no_reason");
      expect(result.blocked).toBe(true);
    });

    it("returns blocked_no_reason when bypass_reason is whitespace only", () => {
      const result = checkBypassReasonGate(0.50, "   ");
      expect(result.outcome).toBe("blocked_no_reason");
      expect(result.blocked).toBe(true);
    });

    it("preserves score in result", () => {
      const result = checkBypassReasonGate(0.35);
      expect(result.score).toBe(0.35);
    });
  });

  describe("score < BYPASS_REASON_FLOOR with valid bypass_reason", () => {
    it("returns allowed_with_reason for score 0.59 with non-empty reason", () => {
      const result = checkBypassReasonGate(0.59, "Hotfix with manual verification");
      expect(result.outcome).toBe("allowed_with_reason");
      expect(result.blocked).toBe(false);
    });

    it("trims the bypass_reason", () => {
      const result = checkBypassReasonGate(0.50, "  prototype only  ");
      expect(result.outcome).toBe("allowed_with_reason");
      expect(result.bypass_reason).toBe("prototype only");
    });

    it("passes through bypass_reason in result", () => {
      const result = checkBypassReasonGate(0.35, "Known regression, approved by tech lead");
      expect(result.bypass_reason).toBe("Known regression, approved by tech lead");
    });

    it("handles score 0.0 with valid reason", () => {
      const result = checkBypassReasonGate(0.0, "Emergency hotfix");
      expect(result.outcome).toBe("allowed_with_reason");
      expect(result.blocked).toBe(false);
    });
  });
});

// ── buildBypassRejectionFeedback ──────────────────────────────────────────────

describe("buildBypassRejectionFeedback", () => {
  it("includes the score percentage", () => {
    const msg = buildBypassRejectionFeedback(0.35, "TASK001");
    expect(msg).toContain("35%");
  });

  it("includes the floor percentage", () => {
    const msg = buildBypassRejectionFeedback(0.35, "TASK001");
    expect(msg).toContain("60%");
  });

  it("includes the task ID", () => {
    const msg = buildBypassRejectionFeedback(0.50, "ABCDEF12");
    expect(msg).toContain("ABCDEF12");
  });

  it("includes guidance about providing a bypass_reason", () => {
    const msg = buildBypassRejectionFeedback(0.50, "TASK001");
    expect(msg.toLowerCase()).toContain("bypass_reason");
  });

  it("mentions the quality floor gate", () => {
    const msg = buildBypassRejectionFeedback(0.58, "TASK001");
    expect(msg.toLowerCase()).toContain("quality");
    expect(msg.toLowerCase()).toContain("floor");
  });

  it("includes bypass-reason-gate prefix for log searching", () => {
    const msg = buildBypassRejectionFeedback(0.50, "TASK001");
    expect(msg).toContain("[bypass-reason-gate]");
  });

  it("produces non-empty string for any valid inputs", () => {
    for (const score of [0.0, 0.30, 0.50, 0.59]) {
      expect(buildBypassRejectionFeedback(score, "T001").length).toBeGreaterThan(0);
    }
  });
});

// ── Verifier.applyBypassReasonGate ───────────────────────────────────────────

describe("Verifier.applyBypassReasonGate", () => {
  let verifier: Verifier;

  beforeEach(() => {
    verifier = new Verifier(makeMockStore());
  });

  describe("approved: false results — gate is always a no-op", () => {
    it("does not modify a rejected result with low score", () => {
      const result = makeResult({ approved: false, score: 0.35 });
      const out = verifier.applyBypassReasonGate(result, undefined, "TASK001");
      expect(out.approved).toBe(false);
      expect(out.score).toBe(0.35);
    });

    it("does not require bypass_reason for rejected results", () => {
      const result = makeResult({ approved: false, score: 0.10 });
      const out = verifier.applyBypassReasonGate(result);
      expect(out.approved).toBe(false);
    });
  });

  describe("score >= BYPASS_REASON_FLOOR — gate is a no-op", () => {
    it("passes through approved result at exactly 0.60", () => {
      const result = makeResult({ approved: true, score: 0.60 });
      const out = verifier.applyBypassReasonGate(result);
      expect(out.approved).toBe(true);
      expect(out.bypass_reason).toBeUndefined();
    });

    it("passes through approved result at 0.80", () => {
      const result = makeResult({ approved: true, score: 0.80 });
      const out = verifier.applyBypassReasonGate(result);
      expect(out.approved).toBe(true);
    });
  });

  describe("approved: true + score < BYPASS_REASON_FLOOR + no bypass_reason → block", () => {
    it("flips approved to false when score 0.35 and no reason", () => {
      const result = makeResult({ approved: true, score: 0.35 });
      const out = verifier.applyBypassReasonGate(result, undefined, "TASK001");
      expect(out.approved).toBe(false);
    });

    it("flips approved to false when score 0.58 and empty reason", () => {
      const result = makeResult({ approved: true, score: 0.58 });
      const out = verifier.applyBypassReasonGate(result, "", "TASK002");
      expect(out.approved).toBe(false);
    });

    it("flips approved to false when score 0.50 and whitespace-only reason", () => {
      const result = makeResult({ approved: true, score: 0.50 });
      const out = verifier.applyBypassReasonGate(result, "   ");
      expect(out.approved).toBe(false);
    });

    it("sets blockedReason to held_for_operator_review", () => {
      const result = makeResult({ approved: true, score: 0.40 });
      const out = verifier.applyBypassReasonGate(result, null, "TASK003");
      expect(out.blockedReason).toBe("held_for_operator_review");
    });

    it("sets revision to bypass gate feedback message", () => {
      const result = makeResult({ approved: true, score: 0.40 });
      const out = verifier.applyBypassReasonGate(result, null, "TASK004");
      expect(out.revision).toBeDefined();
      expect(out.revision).toContain("[bypass-reason-gate]");
      expect(out.revision).toContain("bypass_reason");
    });

    it("prefixes notes with [bypass-reason-gate] tag", () => {
      const result = makeResult({ approved: true, score: 0.55, notes: "Good effort" });
      const out = verifier.applyBypassReasonGate(result, undefined, "TASK005");
      expect(out.notes).toContain("[bypass-reason-gate]");
      expect(out.notes).toContain("Good effort");
    });

    it("clears bypass_reason from the result", () => {
      const result = makeResult({ approved: true, score: 0.50, bypass_reason: "old value" });
      const out = verifier.applyBypassReasonGate(result, "", "TASK006");
      expect(out.bypass_reason).toBeUndefined();
    });
  });

  describe("approved: true + score < BYPASS_REASON_FLOOR + valid bypass_reason → allow", () => {
    it("keeps approved:true when reason is provided", () => {
      const result = makeResult({ approved: true, score: 0.35 });
      const out = verifier.applyBypassReasonGate(result, "Emergency hotfix", "TASK007");
      expect(out.approved).toBe(true);
    });

    it("stamps the trimmed bypass_reason into the result", () => {
      const result = makeResult({ approved: true, score: 0.50 });
      const out = verifier.applyBypassReasonGate(result, "  prototype only  ", "TASK008");
      expect(out.bypass_reason).toBe("prototype only");
    });

    it("preserves original score", () => {
      const result = makeResult({ approved: true, score: 0.58 });
      const out = verifier.applyBypassReasonGate(result, "Approved by tech lead", "TASK009");
      expect(out.score).toBe(0.58);
    });

    it("preserves original notes", () => {
      const result = makeResult({ approved: true, score: 0.45, notes: "Partial implementation" });
      const out = verifier.applyBypassReasonGate(result, "Known acceptable gap", "TASK010");
      expect(out.notes).toBe("Partial implementation");
    });

    it("preserves other result fields (dimensions, revision, etc.)", () => {
      const result = makeResult({
        approved: true,
        score: 0.55,
        dimensions: { correctness: 0.6, completeness: 0.5, test_coverage: 0.5, code_quality: 0.6 },
        marginalApproval: true,
      });
      const out = verifier.applyBypassReasonGate(result, "Approved with caveats", "TASK011");
      expect(out.dimensions).toEqual(result.dimensions);
      expect(out.marginalApproval).toBe(true);
    });

    it("handles score 0.0 with reason (extreme case)", () => {
      const result = makeResult({ approved: true, score: 0.0 });
      const out = verifier.applyBypassReasonGate(result, "Full rewrite already in progress", "TASK012");
      expect(out.approved).toBe(true);
      expect(out.bypass_reason).toBe("Full rewrite already in progress");
    });
  });

  describe("edge cases", () => {
    it("is a no-op for approved results with score just below floor (0.599…) when reason provided", () => {
      const result = makeResult({ approved: true, score: 0.599 });
      const out = verifier.applyBypassReasonGate(result, "Manual verification done");
      expect(out.approved).toBe(true);
      expect(out.bypass_reason).toBe("Manual verification done");
    });

    it("applies gate without taskId parameter (defaults to 'unknown')", () => {
      const result = makeResult({ approved: true, score: 0.50 });
      const out = verifier.applyBypassReasonGate(result);
      // blocked, default taskId used in message
      expect(out.approved).toBe(false);
      expect(out.revision).toContain("unknown");
    });
  });
});
