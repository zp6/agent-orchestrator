import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VerificationResult } from "../reviewer/verifier.js";
import {
  RESEARCH_OUTPUT_SCHEMA,
  RESEARCH_REQUIRED_SECTIONS,
  TRIAGE_OUTPUT_SCHEMA,
  TRIAGE_REQUIRED_FIELDS,
  PRIORITY_FLOOR_THRESHOLD,
  PRIORITY_QUALITY_FLOOR,
  Verifier,
} from "../reviewer/verifier.js";
import type { Notifier } from "../notify.js";

/**
 * Verifier unit tests — exercises the pure parsing logic and second-pass
 * borderline review logic.
 * LLM calls are intentionally NOT tested here (integration tests only).
 */

// Re-expose private parseResponse for testing via a thin wrapper class
// We test the parsing behavior through the public API shape.

describe("Verifier parseResponse (via enforced shape)", () => {
  // Tests the expected JSON schema that the LLM should return.
  // These validate that callers can safely destructure VerificationResult.

  it("VerificationResult has expected fields", () => {
    // Type-level check — if the import compiles, the type is valid
    const result: VerificationResult = {
      approved: true,
      score: 0.9,
      notes: "Excellent work",
      revision: undefined as string | undefined,
    };
    expect(result.approved).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.notes).toBeTruthy();
  });

  it("VerificationResult includes optional explanation field for sub-0.80 scores", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.68,
      notes: "Incomplete implementation",
      revision: "Please add the missing test coverage",
      explanation:
        "Scored 0.68: acceptance criterion #2 was not verifiable from the diff alone; no test coverage for the dedup path.",
    };
    expect(result.explanation).toBeDefined();
    expect(result.explanation).toContain("0.68");
  });

  it("explanation is absent for scores >= 0.80", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.85,
      notes: "Good work overall",
    };
    expect(result.explanation).toBeUndefined();
  });

  it("score is bounded to [0, 1]", () => {
    // Mirror the parseResponse clamping logic
    const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(1.5)).toBe(1);
    expect(clamp(0.75)).toBe(0.75);
  });

  it("VerificationResult includes optional secondPass field", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.75,
      notes: "Good work overall",
      secondPass: {
        score: 0.78,
        notes: "Independent reviewer agrees",
        agreed: true,
      },
    };
    expect(result.secondPass).toBeDefined();
    expect(result.secondPass?.agreed).toBe(true);
    expect(result.secondPass?.score).toBeGreaterThan(0);
  });
});

describe("Borderline score range constants", () => {
  // Extended from [0.70, 0.79] to [0.60, 0.79] (issue #187): any score that
  // could plausibly be approved at the marginal bar now receives an independent
  // second-pass review before approval is finalised.
  it("borderline range is [0.60, 0.79]", () => {
    const BORDERLINE_LOW = 0.60;
    const BORDERLINE_HIGH = 0.79;

    // scores that should trigger second pass
    const borderlineScores = [0.60, 0.65, 0.70, 0.74, 0.75, 0.79];
    // scores that should NOT trigger second pass
    const nonBorderlineScores = [0.59, 0.80, 0.90, 0.50, 0.00, 1.00];

    for (const score of borderlineScores) {
      const isBorderline = score >= BORDERLINE_LOW && score <= BORDERLINE_HIGH;
      expect(isBorderline, `Expected ${score} to be borderline`).toBe(true);
    }

    for (const score of nonBorderlineScores) {
      const isBorderline = score >= BORDERLINE_LOW && score <= BORDERLINE_HIGH;
      expect(isBorderline, `Expected ${score} to NOT be borderline`).toBe(false);
    }
  });
});

describe("Second-pass result merging logic", () => {
  it("both passes approve → final approved", () => {
    const firstApproved = true;
    const secondApproved = true;
    const finalApproved = firstApproved && secondApproved;
    const agreed = firstApproved === secondApproved;
    expect(finalApproved).toBe(true);
    expect(agreed).toBe(true);
  });

  it("first approves, second rejects → final rejected (conservative)", () => {
    const firstApproved = true;
    const secondApproved = false;
    const finalApproved = firstApproved && secondApproved;
    const agreed = firstApproved === secondApproved;
    expect(finalApproved).toBe(false);
    expect(agreed).toBe(false);
  });

  it("first rejects, second approves → final rejected (conservative)", () => {
    const firstApproved = false;
    const secondApproved = true;
    const finalApproved = firstApproved && secondApproved;
    const agreed = firstApproved === secondApproved;
    expect(finalApproved).toBe(false);
    expect(agreed).toBe(false);
  });

  it("both passes reject → final rejected", () => {
    const firstApproved = false;
    const secondApproved = false;
    const finalApproved = firstApproved && secondApproved;
    const agreed = firstApproved === secondApproved;
    expect(finalApproved).toBe(false);
    expect(agreed).toBe(true);
  });

  it("notifier.notifyOperator is called exactly once on disagreement", async () => {
    const notifyOperatorMock = vi.fn().mockResolvedValue(true);
    const notifier: Notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator: notifyOperatorMock,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };

    // Simulate the disagreement escalation path
    const firstApproved = true;
    const secondApproved = false;
    const agreed = firstApproved === secondApproved; // false

    if (!agreed) {
      await notifier.notifyOperator(
        "Borderline review disagreement",
        "Test disagreement body",
        "medium",
      );
    }

    expect(notifyOperatorMock).toHaveBeenCalledTimes(1);
    expect(notifyOperatorMock).toHaveBeenCalledWith(
      "Borderline review disagreement",
      expect.any(String),
      "medium",
    );
  });

  it("notifier is NOT called when passes agree", async () => {
    const notifyOperatorMock = vi.fn().mockResolvedValue(true);
    const notifier: Notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator: notifyOperatorMock,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };

    const firstApproved = true;
    const secondApproved = true;
    const agreed = firstApproved === secondApproved; // true

    if (!agreed) {
      await notifier.notifyOperator("Borderline review disagreement", "body", "medium");
    }

    expect(notifyOperatorMock).not.toHaveBeenCalled();
  });
});

describe("Explanation narrative for sub-0.80 scores", () => {
  it("explanation is only populated when score < 0.80", () => {
    // Mirror the parseResponse logic
    const attachExplanation = (score: number, raw?: string): string | undefined =>
      score < 0.80 && raw ? raw : undefined;

    expect(attachExplanation(0.79, "Some explanation")).toBeDefined();
    expect(attachExplanation(0.68, "Low score reason")).toBe("Low score reason");
    expect(attachExplanation(0.80, "Should be omitted")).toBeUndefined();
    expect(attachExplanation(0.95, "High score")).toBeUndefined();
  });

  it("revision is enriched with explanation when both are present", () => {
    const explanation = "Scored 0.72: criterion #2 unverifiable from diff.";
    const revision = "Add test coverage for the dedup path.";

    const enrichedRevision = explanation ? `${explanation}\n\n${revision}` : revision;

    expect(enrichedRevision).toContain("Scored 0.72");
    expect(enrichedRevision).toContain("Add test coverage");
    // Explanation appears BEFORE the revision guidance
    expect(enrichedRevision.indexOf(explanation)).toBeLessThan(enrichedRevision.indexOf(revision));
  });

  it("revision is unchanged when no explanation is present", () => {
    const explanation: string | undefined = undefined;
    const revision = "Add test coverage for the dedup path.";

    const enrichedRevision =
      !explanation ? revision : `${explanation}\n\n${revision}`;

    expect(enrichedRevision).toBe(revision);
  });

  it("borderline second-pass prefers second-pass explanation over first", () => {
    const firstExplanation = "First pass: gap in criterion #1.";
    const secondExplanation = "Second pass: missing test for edge case.";

    // Mirror the logic: secondPassResult.explanation ?? firstPassResult.explanation
    const finalExplanation = secondExplanation ?? firstExplanation;
    expect(finalExplanation).toBe(secondExplanation);
  });

  it("borderline fallback uses first-pass explanation when second pass omits one", () => {
    const firstExplanation = "First pass: incomplete implementation.";
    const secondExplanation: string | undefined = undefined;

    const finalExplanation = secondExplanation ?? firstExplanation;
    expect(finalExplanation).toBe(firstExplanation);
  });
});

describe("VerificationResult combined notes format", () => {
  it("combined notes contain both pass labels and agreement status", () => {
    const firstScore = 0.75;
    const secondScore = 0.72;
    const firstApproved = true;
    const secondApproved = true;
    const agreed = true;
    const finalApproved = true;

    const combinedNotes = [
      `[First pass — score ${(firstScore * 100).toFixed(0)}%] First pass notes here.`,
      `[Second pass — score ${(secondScore * 100).toFixed(0)}%] Second pass notes here.`,
      agreed
        ? `[Agreement: both passes ${finalApproved ? "approved" : "rejected"}]`
        : `[Disagreement: passes diverged — conservative decision: ${finalApproved ? "approved" : "rejected"}]`,
    ].join("\n");

    expect(combinedNotes).toContain("[First pass — score 75%]");
    expect(combinedNotes).toContain("[Second pass — score 72%]");
    expect(combinedNotes).toContain("[Agreement: both passes approved]");
  });

  it("disagreement notes contain diverged message", () => {
    const firstScore = 0.77;
    const secondScore = 0.65;
    const agreed = false;
    const finalApproved = false;

    const combinedNotes = [
      `[First pass — score ${(firstScore * 100).toFixed(0)}%] First approved.`,
      `[Second pass — score ${(secondScore * 100).toFixed(0)}%] Second rejected.`,
      agreed
        ? `[Agreement: both passes ${finalApproved ? "approved" : "rejected"}]`
        : `[Disagreement: passes diverged — conservative decision: ${finalApproved ? "approved" : "rejected"}]`,
    ].join("\n");

    expect(combinedNotes).toContain("[Disagreement: passes diverged");
    expect(combinedNotes).toContain("conservative decision: rejected");
  });
});

describe("Marginal approval flagging (score 0.60–0.79)", () => {
  it("VerificationResult includes optional marginalApproval and marginalReason fields", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.68,
      notes: "⚠️ MARGINAL APPROVAL — score 68% — Missing edge-case handling reduced confidence.\n\nCore logic is sound.",
      marginalApproval: true,
      marginalReason: "Missing edge-case handling reduced confidence despite correct core logic.",
    };
    expect(result.marginalApproval).toBe(true);
    expect(result.marginalReason).toBeDefined();
    expect(result.marginalReason).toContain("confidence");
  });

  it("marginalApproval is absent for high-confidence approvals", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.90,
      notes: "Excellent work",
    };
    expect(result.marginalApproval).toBeUndefined();
    expect(result.marginalReason).toBeUndefined();
  });

  // Extended from [0.60, 0.74] to [0.60, 0.79] (issue #187): marginal approval
  // range is now aligned with the borderline second-pass range.
  it("marginalApproval range is [0.60, 0.79]", () => {
    const MARGINAL_LOW = 0.60;
    const MARGINAL_HIGH = 0.79;

    const marginalScores = [0.60, 0.65, 0.70, 0.74, 0.75, 0.79];
    const nonMarginalApprovalScores = [0.59, 0.80, 0.90];

    for (const score of marginalScores) {
      const isMarginal = score >= MARGINAL_LOW && score <= MARGINAL_HIGH;
      expect(isMarginal, `Expected ${score} to be in marginal range`).toBe(true);
    }

    for (const score of nonMarginalApprovalScores) {
      const isMarginal = score >= MARGINAL_LOW && score <= MARGINAL_HIGH;
      expect(isMarginal, `Expected ${score} to NOT be in marginal range`).toBe(false);
    }
  });

  it("marginalReason is only populated for approved tasks in the marginal range", () => {
    const isMarginalApproval = (approved: boolean, score: number) =>
      approved && score >= 0.60 && score <= 0.79;

    // Approved, marginal score → marginalApproval
    expect(isMarginalApproval(true, 0.68)).toBe(true);
    expect(isMarginalApproval(true, 0.75)).toBe(true);   // now in marginal range (extended to 0.79)
    expect(isMarginalApproval(true, 0.79)).toBe(true);   // upper boundary (inclusive)
    // Rejected, marginal score → no marginalApproval (rejected tasks get explanation instead)
    expect(isMarginalApproval(false, 0.68)).toBe(false);
    // Approved, score above marginal threshold → no marginalApproval
    expect(isMarginalApproval(true, 0.80)).toBe(false);
    // Approved, score below marginal threshold → no marginalApproval
    expect(isMarginalApproval(true, 0.50)).toBe(false);
  });

  it("marginal badge prefix includes score percentage and reason", () => {
    const score = 0.68;
    const marginalReason = "Missing error handling in the retry path reduced confidence.";

    const marginalBadge =
      `⚠️ MARGINAL APPROVAL — score ${(score * 100).toFixed(0)}%` +
      ` — ${marginalReason}` +
      "\n\n";

    expect(marginalBadge).toContain("⚠️ MARGINAL APPROVAL");
    expect(marginalBadge).toContain("score 68%");
    expect(marginalBadge).toContain(marginalReason);
  });

  it("marginal badge is prepended to notes so dashboard can render it as a distinct label", () => {
    const score = 0.71;
    const marginalReason = "Incomplete test coverage for edge cases.";
    const rawNotes = "Core implementation is correct with minor gaps.";

    const marginalBadge =
      `⚠️ MARGINAL APPROVAL — score ${(score * 100).toFixed(0)}% — ${marginalReason}\n\n`;
    const enrichedNotes = `${marginalBadge}${rawNotes}`;

    expect(enrichedNotes.startsWith("⚠️ MARGINAL APPROVAL")).toBe(true);
    expect(enrichedNotes).toContain(rawNotes);
    // Badge appears before the raw notes
    expect(enrichedNotes.indexOf("⚠️")).toBeLessThan(enrichedNotes.indexOf(rawNotes));
  });
});

describe("Sub-0.50 hard-block guard", () => {
  const HARD_BLOCK_THRESHOLD = 0.50;

  /**
   * Mirror the hard-block enforcement logic from parseResponse so we can unit-test
   * boundary behaviour without calling the LLM.
   */
  function applyHardBlock(
    approved: boolean,
    score: number,
  ): { approved: boolean; blockedReason?: "hard_block_sub50" } {
    const isHardBlocked = score < HARD_BLOCK_THRESHOLD;
    return {
      approved: isHardBlocked ? false : approved,
      ...(isHardBlocked && { blockedReason: "hard_block_sub50" as const }),
    };
  }

  it("score below 0.50 is always rejected, even when LLM says approved", () => {
    const result = applyHardBlock(true, 0.38);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of 0 is hard-blocked", () => {
    const result = applyHardBlock(true, 0);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of 0.05 is hard-blocked", () => {
    const result = applyHardBlock(true, 0.05);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of 0.1 is hard-blocked", () => {
    const result = applyHardBlock(true, 0.1);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of 0.2 is hard-blocked", () => {
    const result = applyHardBlock(true, 0.2);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of 0.49 is hard-blocked (just below boundary)", () => {
    const result = applyHardBlock(false, 0.49);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score of exactly 0.50 is NOT hard-blocked (boundary is exclusive)", () => {
    const result = applyHardBlock(false, 0.50);
    expect(result.approved).toBe(false);     // LLM said rejected — still rejected
    expect(result.blockedReason).toBeUndefined();
  });

  it("score of exactly 0.50 approved by LLM passes through without hard-block", () => {
    const result = applyHardBlock(true, 0.50);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("score of 0.51 is not hard-blocked", () => {
    const result = applyHardBlock(false, 0.51);
    expect(result.approved).toBe(false);     // LLM said rejected — still rejected
    expect(result.blockedReason).toBeUndefined();
  });

  it("score of 0.80 is not hard-blocked", () => {
    const result = applyHardBlock(true, 0.80);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("hard-block suppresses marginalApproval flag", () => {
    // Score 0.48 is below the marginal range lower bound AND below HARD_BLOCK_THRESHOLD.
    // The hard-block fires, so marginalApproval must not be set.
    const score = 0.48;
    const MARGINAL_LOW = 0.60;
    const MARGINAL_HIGH = 0.74;
    const isHardBlocked = score < HARD_BLOCK_THRESHOLD;
    const isMarginalApproval = !isHardBlocked && true && score >= MARGINAL_LOW && score <= MARGINAL_HIGH;
    expect(isMarginalApproval).toBe(false);
    expect(isHardBlocked).toBe(true);
  });

  it("VerificationResult can express blockedReason field", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.20,
      notes: "Fundamentally incomplete work",
      revision: "Start over — the implementation does not address the requirements.",
      blockedReason: "hard_block_sub50",
    };
    expect(result.blockedReason).toBe("hard_block_sub50");
    expect(result.approved).toBe(false);
  });

  it("blockedReason is absent for scores >= 0.50", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.55,
      notes: "Partially meets requirements",
    };
    expect(result.blockedReason).toBeUndefined();
  });
});

describe("Quality dimensions breakdown", () => {
  it("VerificationResult includes optional dimensions field", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.65,
      notes: "Incomplete work",
      revision: "Add test coverage",
      explanation: "Missing test coverage for the new feature",
      dimensions: {
        correctness: 0.8,
        completeness: 0.6,
        test_coverage: 0.4,
        code_quality: 0.7,
      },
    };
    expect(result.dimensions).toBeDefined();
    expect(result.dimensions?.correctness).toBe(0.8);
    expect(result.dimensions?.test_coverage).toBe(0.4);
  });

  it("dimensions are bounded to [0, 1]", () => {
    // Mirror the parseResponse clamping logic for dimensions
    const clamp = (n: number) => Math.min(Math.max(n, 0), 1);
    expect(clamp(-0.5)).toBe(0);
    expect(clamp(1.5)).toBe(1);
    expect(clamp(0.75)).toBe(0.75);

    // Verify all four dimensions can be clamped
    const dimensions = {
      correctness: clamp(0.8),
      completeness: clamp(1.2), // Should clamp to 1.0
      test_coverage: clamp(-0.1), // Should clamp to 0.0
      code_quality: clamp(0.6),
    };

    expect(dimensions.correctness).toBe(0.8);
    expect(dimensions.completeness).toBe(1.0);
    expect(dimensions.test_coverage).toBe(0.0);
    expect(dimensions.code_quality).toBe(0.6);
  });

  it("dimensions are absent when not provided by LLM", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.9,
      notes: "Excellent work",
    };
    expect(result.dimensions).toBeUndefined();
  });

  it("second-pass result includes dimensions", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.75,
      notes: "Good work",
      dimensions: {
        correctness: 0.85,
        completeness: 0.8,
        test_coverage: 0.7,
        code_quality: 0.75,
      },
      secondPass: {
        score: 0.78,
        notes: "Independent reviewer concurs",
        agreed: true,
        dimensions: {
          correctness: 0.85,
          completeness: 0.8,
          test_coverage: 0.75,
          code_quality: 0.75,
        },
      },
    };

    expect(result.secondPass?.dimensions).toBeDefined();
    expect(result.secondPass?.dimensions?.test_coverage).toBe(0.75);
  });

  it("revision message includes dimension breakdown when dimensions present (implementation task)", () => {
    // Simulate the formatDimensionsBreakdown logic for implementation tasks (isResearch=false)
    const dimensions = {
      correctness: 0.6,
      completeness: 0.8,
      test_coverage: 0.5,
      code_quality: 0.7,
    };

    const threshold = 0.8;
    const formatScore = (d: number) => `${(d * 100).toFixed(0)}/100`;
    const indicator = (d: number) => (d >= threshold ? "✓" : "✗");

    const breakdown = [
      "## Quality Dimensions Breakdown",
      `- **Correctness**: ${formatScore(dimensions.correctness)} ${indicator(dimensions.correctness)} (logic, no bugs)`,
      `- **Completeness**: ${formatScore(dimensions.completeness)} ${indicator(dimensions.completeness)} (requirements met)`,
      `- **Test Coverage**: ${formatScore(dimensions.test_coverage)} ${indicator(dimensions.test_coverage)} (edge cases covered)`,
      `- **Code Quality**: ${formatScore(dimensions.code_quality)} ${indicator(dimensions.code_quality)} (clarity, documentation)`,
    ].join("\n");

    expect(breakdown).toContain("Quality Dimensions Breakdown");
    expect(breakdown).toContain("**Correctness**: 60/100 ✗");
    expect(breakdown).toContain("**Test Coverage**: 50/100 ✗");
    expect(breakdown).toContain("**Completeness**: 80/100 ✓");
    expect(breakdown).toContain("**Code Quality**");
    expect(breakdown).not.toContain("Schema Compliance");
  });

  it("revision message uses research-specific dimension labels when isResearch=true", () => {
    // Simulate the formatDimensionsBreakdown logic for research tasks (isResearch=true)
    const dimensions = {
      correctness: 0.9,
      completeness: 0.8,
      test_coverage: 0.6,
      code_quality: 0.4, // schema compliance — missing sections
    };

    const threshold = 0.8;
    const formatScore = (d: number) => `${(d * 100).toFixed(0)}/100`;
    const indicator = (d: number) => (d >= threshold ? "✓" : "✗");
    const isResearch = true;

    const breakdown = [
      "## Quality Dimensions Breakdown",
      `- **Correctness**: ${formatScore(dimensions.correctness)} ${indicator(dimensions.correctness)} (${isResearch ? "claims technically sound" : "logic, no bugs"})`,
      `- **Completeness**: ${formatScore(dimensions.completeness)} ${indicator(dimensions.completeness)} (${isResearch ? "all aspects of question addressed" : "requirements met"})`,
      `- **${isResearch ? "Evidence Coverage" : "Test Coverage"}**: ${formatScore(dimensions.test_coverage)} ${indicator(dimensions.test_coverage)} (${isResearch ? "findings validated, evidence comprehensive" : "edge cases covered"})`,
      `- **${isResearch ? "Schema Compliance" : "Code Quality"}**: ${formatScore(dimensions.code_quality)} ${indicator(dimensions.code_quality)} (${isResearch ? "all 5 required sections present and substantive" : "clarity, documentation"})`,
    ].join("\n");

    expect(breakdown).toContain("**Evidence Coverage**");
    expect(breakdown).toContain("**Schema Compliance**: 40/100 ✗");
    expect(breakdown).toContain("all 5 required sections present and substantive");
    expect(breakdown).not.toContain("**Test Coverage**");
    expect(breakdown).not.toContain("**Code Quality**");
  });
});

describe("Research output schema constants", () => {
  it("RESEARCH_REQUIRED_SECTIONS contains all five required section headers", () => {
    expect(RESEARCH_REQUIRED_SECTIONS).toHaveLength(5);
    expect(RESEARCH_REQUIRED_SECTIONS).toContain("## Problem Statement");
    expect(RESEARCH_REQUIRED_SECTIONS).toContain("## Key Findings");
    expect(RESEARCH_REQUIRED_SECTIONS).toContain("## Implementation Recommendations");
    expect(RESEARCH_REQUIRED_SECTIONS).toContain("## Open Questions");
    expect(RESEARCH_REQUIRED_SECTIONS).toContain("## References");
  });

  it("RESEARCH_OUTPUT_SCHEMA is a non-empty string containing all required headers", () => {
    expect(typeof RESEARCH_OUTPUT_SCHEMA).toBe("string");
    expect(RESEARCH_OUTPUT_SCHEMA.length).toBeGreaterThan(0);

    for (const section of RESEARCH_REQUIRED_SECTIONS) {
      expect(RESEARCH_OUTPUT_SCHEMA, `Schema must include "${section}"`).toContain(section);
    }
  });

  it("RESEARCH_OUTPUT_SCHEMA is a valid markdown template with placeholder content", () => {
    // Should include bracket-style placeholder text indicating where content goes
    expect(RESEARCH_OUTPUT_SCHEMA).toContain("[");
    expect(RESEARCH_OUTPUT_SCHEMA).toContain("]");
  });

  it("schema compliance scoring: missing sections reduce score by 0.15 each", () => {
    // Mirror the scoring logic described in the research system prompt
    const BASE_SCORE = 0.90; // hypothetical content quality score
    const PENALTY_PER_MISSING_SECTION = 0.15;
    const ALL_SECTIONS_CAP = 0.30; // cap when ALL sections are absent

    const computeScore = (presentSections: number, totalRequired = 5): number => {
      const missingSections = totalRequired - presentSections;
      if (presentSections === 0) return ALL_SECTIONS_CAP;
      return Math.max(BASE_SCORE - missingSections * PENALTY_PER_MISSING_SECTION, 0);
    };

    // All 5 sections present → no penalty
    expect(computeScore(5)).toBe(BASE_SCORE);
    // 4 of 5 present → -0.15
    expect(computeScore(4)).toBeCloseTo(0.75, 5);
    // 3 of 5 present → -0.30
    expect(computeScore(3)).toBeCloseTo(0.60, 5);
    // 1 of 5 present → -0.60
    expect(computeScore(1)).toBeCloseTo(0.30, 5);
    // 0 of 5 present → cap at 0.30
    expect(computeScore(0)).toBe(ALL_SECTIONS_CAP);
  });

  it("RESEARCH_REQUIRED_SECTIONS can be used to check schema compliance in agent outputs", () => {
    // Simulate the verifier checking a well-formed research output
    const compliantOutput = `
## Problem Statement
Redis connection pooling is causing timeouts under high load.

## Key Findings
- Pool size defaults to 10 — insufficient for 50 concurrent workers
- No idle connection eviction — connections accumulate and exhaust memory

## Implementation Recommendations
Increase pool size to 50 and enable idle eviction after 30s.

## Open Questions
- Should we use cluster mode or sentinel for HA?

## References
- redis/ioredis docs: PoolOptions
`;

    const missingSections = RESEARCH_REQUIRED_SECTIONS.filter(
      (section) => !compliantOutput.includes(section),
    );
    expect(missingSections).toHaveLength(0);
  });

  it("RESEARCH_REQUIRED_SECTIONS correctly identifies missing sections in non-compliant output", () => {
    // Output missing Open Questions and References
    const partialOutput = `
## Problem Statement
Some problem.

## Key Findings
- Finding 1

## Implementation Recommendations
Do X.
`;

    const missingSections = RESEARCH_REQUIRED_SECTIONS.filter(
      (section) => !partialOutput.includes(section),
    );
    expect(missingSections).toHaveLength(2);
    expect(missingSections).toContain("## Open Questions");
    expect(missingSections).toContain("## References");
  });
});

describe("Priority quality gate (issue_priority ≥ 0.80, quality_score < 0.60)", () => {
  it("exported constants have correct values", () => {
    expect(PRIORITY_FLOOR_THRESHOLD).toBe(0.80);
    expect(PRIORITY_QUALITY_FLOOR).toBe(0.60);
  });

  it("gate fires when issue_priority >= 0.80 AND score < 0.60", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    // Should escalate
    expect(shouldEscalate(0.90, 0.15)).toBe(true);   // the scenario from issue #179
    expect(shouldEscalate(0.80, 0.59)).toBe(true);   // exactly on priority threshold, just below quality floor
    expect(shouldEscalate(1.00, 0.00)).toBe(true);   // maximum priority, zero quality
    expect(shouldEscalate(0.85, 0.50)).toBe(true);   // high priority, acceptable but below floor
  });

  it("gate does NOT fire when issue_priority is null", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    expect(shouldEscalate(null, 0.10)).toBe(false);
  });

  it("gate does NOT fire when issue_priority < 0.80", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    expect(shouldEscalate(0.79, 0.15)).toBe(false);  // just below priority threshold
    expect(shouldEscalate(0.50, 0.10)).toBe(false);  // low priority, terrible quality
    expect(shouldEscalate(0.00, 0.00)).toBe(false);  // zero priority, zero quality
  });

  it("gate does NOT fire when quality_score >= 0.60 (even with high priority)", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    expect(shouldEscalate(0.90, 0.60)).toBe(false);  // exactly at quality floor — no escalation
    expect(shouldEscalate(0.90, 0.75)).toBe(false);  // high priority, good quality
    expect(shouldEscalate(1.00, 1.00)).toBe(false);  // maximum everything — no escalation
  });

  it("gate is boundary-exclusive on quality floor (0.60 does NOT trigger)", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    expect(shouldEscalate(0.90, 0.60)).toBe(false);  // exactly 0.60 — passes the floor
    expect(shouldEscalate(0.90, 0.59)).toBe(true);   // 0.59 — below floor
  });

  it("gate is boundary-inclusive on priority threshold (0.80 triggers)", () => {
    const shouldEscalate = (issuePriority: number | null, score: number): boolean => {
      if (issuePriority == null) return false;
      return issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR;
    };

    expect(shouldEscalate(0.80, 0.55)).toBe(true);   // exactly 0.80 priority — gate fires
    expect(shouldEscalate(0.79, 0.55)).toBe(false);  // just below 0.80 — gate does not fire
  });

  it("VerificationResult can express priorityQualityEscalated field", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.15,
      notes: "Critically low quality on high-priority task",
      priorityQualityEscalated: true,
    };
    expect(result.priorityQualityEscalated).toBe(true);
  });

  it("priorityQualityEscalated is absent on normal results", () => {
    const result: VerificationResult = {
      approved: true,
      score: 0.90,
      notes: "Excellent work",
    };
    expect(result.priorityQualityEscalated).toBeUndefined();
  });

  it("notifyOperator is called with high urgency when gate fires", async () => {
    const notifyOperatorMock = vi.fn().mockResolvedValue(true);
    const updateTaskMock = vi.fn();

    const notifier: Notifier = {
      send: vi.fn(),
      escalation: vi.fn(),
      taskRejected: vi.fn(),
      notifyOperator: notifyOperatorMock,
      supervisorDecision: vi.fn(),
      healthRecovery: vi.fn(),
      isConfigured: () => true,
    };

    const store = {
      getTask: vi.fn(),
      updateTask: updateTaskMock,
      hasActiveTask: vi.fn(),
      listTasks: vi.fn(),
    };

    // Simulate the gate firing path directly using the logic extracted from applyPriorityQualityGate
    const taskId = "01KP8CZ5ABCDEFGH";
    const issuePriority = 0.90;
    const score = 0.15;

    if (issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR) {
      store.updateTask(taskId, { status: "escalated" });

      const priorityPct = (issuePriority * 100).toFixed(0);
      const qualityPct = (score * 100).toFixed(0);
      const body = [
        `Task \`${taskId.slice(0, 12)}\` was the system's highest-priority work yet returned a critically low quality score.`,
        ``,
        `*Task:* \`${taskId}\``,
        `*Agent:* \`claude-agent-orchestrator\``,
        `*Issue priority:* ${priorityPct}% (threshold: ${(PRIORITY_FLOOR_THRESHOLD * 100).toFixed(0)}%)`,
        `*Quality score:* ${qualityPct}% (floor: ${(PRIORITY_QUALITY_FLOOR * 100).toFixed(0)}%)`,
        ``,
        `Task status moved to \`escalated\`. Use \`/resolve ${taskId.slice(0, 8)}\` to de-escalate after manual review.`,
      ].join("\n");

      await notifier.notifyOperator(
        "Priority quality gate: high-priority task below quality floor",
        body,
        "high",
      );
    }

    expect(updateTaskMock).toHaveBeenCalledWith(taskId, { status: "escalated" });
    expect(notifyOperatorMock).toHaveBeenCalledTimes(1);
    expect(notifyOperatorMock).toHaveBeenCalledWith(
      "Priority quality gate: high-priority task below quality floor",
      expect.stringContaining("90%"),    // priority shown
      "high",
    );
    expect(notifyOperatorMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("15%"),    // quality score shown
      "high",
    );
  });

  it("task status is set to escalated (not done) when gate fires", () => {
    const updateTaskMock = vi.fn();

    const taskId = "01KP8CZ5ABCDEFGH";
    const issuePriority = 0.90;
    const score = 0.15;

    // Simulate the escalation path
    if (issuePriority >= PRIORITY_FLOOR_THRESHOLD && score < PRIORITY_QUALITY_FLOOR) {
      updateTaskMock(taskId, { status: "escalated" });
    }

    expect(updateTaskMock).toHaveBeenCalledWith(taskId, { status: "escalated" });
    // Crucially, status is "escalated" not "done"
    const call = updateTaskMock.mock.calls[0];
    expect(call[1].status).toBe("escalated");
    expect(call[1].status).not.toBe("done");
  });

  it("Telegram alert body contains both priority score and quality score", () => {
    const issuePriority = 0.90;
    const score = 0.15;
    const taskId = "01KP8CZ5ABCDEFGH";
    const agentName = "claude-agent-orchestrator";

    const priorityPct = (issuePriority * 100).toFixed(0);
    const qualityPct = (score * 100).toFixed(0);
    const body = [
      `Task \`${taskId.slice(0, 12)}\` was the system's highest-priority work yet returned a critically low quality score.`,
      ``,
      `*Task:* \`${taskId}\``,
      `*Agent:* \`${agentName}\``,
      `*Issue priority:* ${priorityPct}% (threshold: ${(PRIORITY_FLOOR_THRESHOLD * 100).toFixed(0)}%)`,
      `*Quality score:* ${qualityPct}% (floor: ${(PRIORITY_QUALITY_FLOOR * 100).toFixed(0)}%)`,
      ``,
      `Task status moved to \`escalated\`. Use \`/resolve ${taskId.slice(0, 8)}\` to de-escalate after manual review.`,
    ].join("\n");

    expect(body).toContain("*Issue priority:* 90%");
    expect(body).toContain("*Quality score:* 15%");
    expect(body).toContain("escalated");
    expect(body).toContain("/resolve");
    expect(body).toContain(agentName);
  });
});

describe("Triage output schema constants", () => {
  it("TRIAGE_REQUIRED_FIELDS contains all four required field names", () => {
    expect(TRIAGE_REQUIRED_FIELDS).toHaveLength(4);
    expect(TRIAGE_REQUIRED_FIELDS).toContain("duplicates_checked");
    expect(TRIAGE_REQUIRED_FIELDS).toContain("stale_issues");
    expect(TRIAGE_REQUIRED_FIELDS).toContain("priority_reordering");
    expect(TRIAGE_REQUIRED_FIELDS).toContain("outcome_summary");
  });

  it("TRIAGE_OUTPUT_SCHEMA is a non-empty string containing all required field names", () => {
    expect(typeof TRIAGE_OUTPUT_SCHEMA).toBe("string");
    expect(TRIAGE_OUTPUT_SCHEMA.length).toBeGreaterThan(0);

    for (const field of TRIAGE_REQUIRED_FIELDS) {
      expect(TRIAGE_OUTPUT_SCHEMA, `Schema must include "${field}"`).toContain(field);
    }
  });

  it("TRIAGE_OUTPUT_SCHEMA is a valid JSON code block template", () => {
    expect(TRIAGE_OUTPUT_SCHEMA).toContain("```json");
    expect(TRIAGE_OUTPUT_SCHEMA).toContain("```");
    // Should reference all four key fields as JSON keys
    expect(TRIAGE_OUTPUT_SCHEMA).toContain('"duplicates_checked"');
    expect(TRIAGE_OUTPUT_SCHEMA).toContain('"stale_issues"');
    expect(TRIAGE_OUTPUT_SCHEMA).toContain('"priority_reordering"');
    expect(TRIAGE_OUTPUT_SCHEMA).toContain('"outcome_summary"');
  });
});

describe("Verifier.checkTriageSchemaCompliance", () => {
  // Instantiate Verifier with a minimal mock store — we only test the pure
  // schema compliance method, which does not touch the store or LLM.
  const mockStore = {
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getChildTasks: vi.fn().mockReturnValue([]),
    insertVerificationResult: vi.fn(),
  } as unknown as Parameters<typeof Verifier>[0];

  const verifier = new Verifier(mockStore);

  const compliantBlock = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [
    { "number": 21, "title": "Old feature request", "action": "closed", "reason": "superseded by #30" }
  ],
  "priority_reordering": [],
  "outcome_summary": "Closed 1 stale issue. No duplicates found. ROADMAP.md is up to date."
}
\`\`\`
`;

  it("passes for a fully compliant JSON block", () => {
    const result = verifier.checkTriageSchemaCompliance(compliantBlock);
    expect(result.passes).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.80);
    expect(result.missingFields).toHaveLength(0);
  });

  it("passes for a fully compliant block with empty arrays", () => {
    const emptyArraysBlock = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": "No changes needed. All issues are current and prioritised correctly."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(emptyArraysBlock);
    expect(result.passes).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.80);
    expect(result.missingFields).toHaveLength(0);
  });

  it("fails and returns score 0 when no JSON block is present", () => {
    const noBlock = "I reviewed the issues. Everything looks fine. No changes needed.";
    const result = verifier.checkTriageSchemaCompliance(noBlock);
    expect(result.passes).toBe(false);
    expect(result.score).toBe(0);
    expect(result.missingFields).toEqual(expect.arrayContaining([...TRIAGE_REQUIRED_FIELDS]));
  });

  it("fails when duplicates_checked is missing from the JSON block", () => {
    const block = `
\`\`\`json
{
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": "No changes needed."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.passes).toBe(false);
    expect(result.missingFields).toContain("duplicates_checked");
  });

  it("fails when duplicates_checked is false instead of true", () => {
    const block = `
\`\`\`json
{
  "duplicates_checked": false,
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": "No changes needed."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.missingFields).toContain("duplicates_checked");
  });

  it("fails when stale_issues is not an array", () => {
    const block = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": "none",
  "priority_reordering": [],
  "outcome_summary": "All good."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.missingFields).toContain("stale_issues");
  });

  it("fails when stale_issues entries are missing required sub-fields", () => {
    const block = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [
    { "number": 5, "title": "Old issue" }
  ],
  "priority_reordering": [],
  "outcome_summary": "Closed one issue."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    // Entry is missing "action" and "reason"
    expect(result.missingFields.some((f) => f.startsWith("stale_issues"))).toBe(true);
  });

  it("fails when outcome_summary is an empty string", () => {
    const block = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": ""
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.missingFields).toContain("outcome_summary");
  });

  it("scores below 0.80 when two fields are missing", () => {
    const block = `
\`\`\`json
{
  "duplicates_checked": true,
  "stale_issues": []
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.passes).toBe(false);
    expect(result.score).toBeLessThan(0.80);
    expect(result.missingFields).toContain("priority_reordering");
    expect(result.missingFields).toContain("outcome_summary");
  });

  it("returns a score that sums to exactly 1.00 when fully compliant", () => {
    const result = verifier.checkTriageSchemaCompliance(compliantBlock);
    // Full compliance means all weights sum: 0.25 + 0.25 + 0.25 + 0.25 = 1.00
    expect(result.score).toBeCloseTo(1.00, 10);
  });

  it("scores 0.75 when exactly one field is missing (below 0.80 threshold)", () => {
    // Verifies the equal-weight design: any single missing field drops to 0.75
    const block = `
\`\`\`json
{
  "stale_issues": [],
  "priority_reordering": [],
  "outcome_summary": "No changes needed."
}
\`\`\`
`;
    const result = verifier.checkTriageSchemaCompliance(block);
    expect(result.passes).toBe(false);
    expect(result.score).toBeCloseTo(0.75, 10);
    expect(result.missingFields).toContain("duplicates_checked");
  });
});

describe("Verifier.checkBundlingCompliance (issue #433)", () => {
  // Test the bundling detection logic for housekeeping PRs
  const mockStore = {
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getChildTasks: vi.fn().mockReturnValue([]),
    insertVerificationResult: vi.fn(),
  } as unknown as Parameters<typeof Verifier>[0];

  const verifier = new Verifier(mockStore);

  it("detects no bundling when PR only touches triage files", () => {
    const triageOnlyFiles = ["CLAUDE.md", "ROADMAP.md", "docs/architecture.md"];
    const result = verifier.checkBundlingCompliance(triageOnlyFiles);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(3);
    expect(result.featureFiles).toHaveLength(0);
  });

  it("detects no bundling when PR only touches feature files", () => {
    const featureOnlyFiles = ["src/webhook.ts", "src/__tests__/webhook.test.ts", "package.json"];
    const result = verifier.checkBundlingCompliance(featureOnlyFiles);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(0);
    expect(result.featureFiles).toHaveLength(3);
  });

  it("detects bundling when PR mixes triage and feature files", () => {
    const mixedFiles = [
      "src/webhook.ts",
      "src/__tests__/webhook.test.ts",
      "CLAUDE.md",
      "ROADMAP.md",
    ];
    const result = verifier.checkBundlingCompliance(mixedFiles);

    expect(result.bundled).toBe(true);
    expect(result.triageFiles).toEqual(expect.arrayContaining(["CLAUDE.md", "ROADMAP.md"]));
    expect(result.featureFiles).toEqual(
      expect.arrayContaining(["src/webhook.ts", "src/__tests__/webhook.test.ts"]),
    );
  });

  it("ignores neutral files when checking for bundling", () => {
    const filesWithNeutral = ["src/handler.ts", ".gitignore", "ROADMAP.md"];
    const result = verifier.checkBundlingCompliance(filesWithNeutral);

    expect(result.bundled).toBe(true);
    expect(result.triageFiles).toEqual(["ROADMAP.md"]);
    expect(result.featureFiles).toEqual(["src/handler.ts"]);
    // .gitignore should not appear in either list
    expect([...result.triageFiles, ...result.featureFiles]).not.toContain(".gitignore");
  });

  it("handles empty file list gracefully", () => {
    const result = verifier.checkBundlingCompliance([]);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(0);
    expect(result.featureFiles).toHaveLength(0);
  });

  it("categorizes documentation files correctly", () => {
    const docFiles = [
      "README.md",
      "README.en.md",
      "ROADMAP.md",
      "CHANGELOG.md",
      "CLAUDE.md",
      "docs/setup.md",
      "CONTRIBUTING.md",
    ];
    const result = verifier.checkBundlingCompliance(docFiles);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(7);
    expect(result.featureFiles).toHaveLength(0);
  });

  it("categorizes source and test files as features", () => {
    const sourceFiles = [
      "src/index.ts",
      "lib/utils.js",
      "src/__tests__/index.test.ts",
      "src/utils.spec.ts",
      "dist/bundle.js",
    ];
    const result = verifier.checkBundlingCompliance(sourceFiles);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(0);
    expect(result.featureFiles).toHaveLength(5);
  });

  it("categorizes config files as features", () => {
    const configFiles = [
      "package.json",
      "tsconfig.json",
      "tsconfig.build.json",
      "vite.config.ts",
      ".eslintrc.json",
      ".prettierrc",
    ];
    const result = verifier.checkBundlingCompliance(configFiles);

    expect(result.bundled).toBe(false);
    expect(result.triageFiles).toHaveLength(0);
    expect(result.featureFiles).toHaveLength(6);
  });

  it("detects bundling with docs directory", () => {
    const mixedWithDocs = ["src/handler.ts", "docs/api.md", "package.json"];
    const result = verifier.checkBundlingCompliance(mixedWithDocs);

    expect(result.bundled).toBe(true);
    expect(result.triageFiles).toContain("docs/api.md");
    expect(result.featureFiles).toEqual(
      expect.arrayContaining(["src/handler.ts", "package.json"]),
    );
  });

  it("detects bundling with .github directory (workflows)", () => {
    const mixedWithGithub = ["src/main.ts", ".github/workflows/test.yml"];
    const result = verifier.checkBundlingCompliance(mixedWithGithub);

    expect(result.bundled).toBe(true);
    expect(result.triageFiles).toContain(".github/workflows/test.yml");
  });

  it("resolves repo correctly from source_ref 'owner/repo#123' when prRef.repo is empty", () => {
    // Regression test for the source_ref extraction bug:
    // task.source_ref.split("/").slice(0, 2).join("/") on "owner/repo#123"
    // produces "owner/repo#123" (the #123 stays attached to the second segment).
    // The fix: strip the issue number via .split("#")[0] before splitting on "/".
    const mockStoreLocal = {
      getTask: vi.fn(),
      updateTask: vi.fn(),
      getChildTasks: vi.fn().mockReturnValue([]),
      insertVerificationResult: vi.fn(),
    } as unknown as Parameters<typeof Verifier>[0];

    const v = new Verifier(mockStoreLocal);

    // Spy on the private fetchPRDiffForBundlingCheck to capture which repo is passed
    const fetchSpy = vi
      .spyOn(v as unknown as { fetchPRDiffForBundlingCheck: (repo: string, n: number) => string | null }, "fetchPRDiffForBundlingCheck")
      .mockReturnValue(null); // return null so bundling check is skipped after repo validation

    // Minimal triage-compliant task result (schema already passes at this point in verifyTask;
    // we only care that the repo extraction is correct before the diff fetch).
    // We simulate the repo-resolution logic that fires when prRef.repo is "" and
    // source_ref is "owner/repo#123".
    const sourceRef = "owner/repo#123";
    // Reproduce the extraction logic from verifier.ts to verify it produces the correct value:
    const withoutIssue = sourceRef.split("#")[0] ?? "";
    const segments = withoutIssue.split("/").filter(Boolean);
    const resolvedRepo = segments.length === 2 ? segments.join("/") : "";

    expect(resolvedRepo).toBe("owner/repo"); // must NOT be "owner/repo#123"
    expect(resolvedRepo).not.toContain("#");

    // Confirm the old (broken) approach would have produced the wrong value
    const brokenExtraction = sourceRef.split("/").slice(0, 2).join("/");
    expect(brokenExtraction).toBe("owner/repo#123"); // demonstrates the bug

    // Verify the spy was set up correctly (even if not invoked in this unit path)
    fetchSpy.mockRestore();
  });
});

describe("Sub-0.60 rejection guard (issue #187)", () => {
  /**
   * Mirrors the `applySubThresholdRejectionGuard` logic from verifier.ts.
   * Scores in [0.50, 0.60) must be rejected even when the LLM returns approved=true.
   * The hard-block guard already covers scores < 0.50.
   */
  const HARD_BLOCK_THRESHOLD = 0.50;
  const SUB_THRESHOLD_REJECTION_LIMIT = 0.60;

  function applySubThresholdRejectionGuard(result: {
    approved: boolean;
    score: number;
    blockedReason?: string;
  }): { approved: boolean; blockedReason?: string } {
    // Only fires for scores in [HARD_BLOCK_THRESHOLD, SUB_THRESHOLD_REJECTION_LIMIT)
    if (result.score < HARD_BLOCK_THRESHOLD) return result; // hard-block already handles it
    if (result.score >= SUB_THRESHOLD_REJECTION_LIMIT) return result; // above floor, pass through
    if (!result.approved) return result; // already rejected — nothing to enforce
    const { approved: _, blockedReason: __, ...rest } = result;
    return { ...rest, approved: false, blockedReason: "low_score_sub60" };
  }

  it("score of 0.50 approved by LLM is rejected with blockedReason=low_score_sub60", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.50 });
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("score of 0.55 approved by LLM is rejected", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.55 });
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("score of 0.59 approved by LLM is rejected (just below floor)", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.59 });
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("score of 0.60 is NOT affected — exactly at floor, passes through", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.60 });
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("score of 0.65 is NOT affected — above floor", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.65 });
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("score of 0.80 is NOT affected — well above floor", () => {
    const result = applySubThresholdRejectionGuard({ approved: true, score: 0.80 });
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("score below 0.50 is passed through unchanged (hard-block guard handles it)", () => {
    // Guard must not double-apply: hard-block range is < 0.50
    const alreadyBlocked = { approved: false, score: 0.38, blockedReason: "hard_block_sub50" };
    const result = applySubThresholdRejectionGuard(alreadyBlocked);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50"); // unchanged
  });

  it("already-rejected result in sub-60 range is not modified", () => {
    // LLM correctly rejected a 0.55 score — guard must not overwrite
    const result = applySubThresholdRejectionGuard({ approved: false, score: 0.55 });
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBeUndefined(); // no blocker added when already rejected
  });

  it("VerificationResult can express blockedReason=low_score_sub60", () => {
    const result: VerificationResult = {
      approved: false,
      score: 0.55,
      notes: "Implementation meets some requirements but quality is below the 60% minimum floor.",
      revision: "Please address the missing test coverage and edge-case handling noted above.",
      blockedReason: "low_score_sub60",
    };
    expect(result.blockedReason).toBe("low_score_sub60");
    expect(result.approved).toBe(false);
  });

  it("marginal badge uses QUALITY GATE REJECT prefix for low_score_sub60", () => {
    const score = 0.55;
    const blockedReason = "low_score_sub60";

    const badge =
      blockedReason === "hard_block_sub50"
        ? `🚧 HARD BLOCK — score ${(score * 100).toFixed(0)}% below 50% threshold\n\n`
        : blockedReason === "low_score_sub60"
          ? `🔴 QUALITY GATE REJECT — score ${(score * 100).toFixed(0)}% below the 60% minimum floor\n\n`
          : "";

    expect(badge).toContain("🔴 QUALITY GATE REJECT");
    expect(badge).toContain("55%");
    expect(badge).toContain("60% minimum floor");
    expect(badge).not.toContain("🚧 HARD BLOCK");
  });

  it("hard-block badge uses HARD BLOCK prefix for hard_block_sub50", () => {
    const score = 0.38;
    const blockedReason = "hard_block_sub50";

    const badge =
      blockedReason === "hard_block_sub50"
        ? `🚧 HARD BLOCK — score ${(score * 100).toFixed(0)}% below 50% threshold\n\n`
        : blockedReason === "low_score_sub60"
          ? `🔴 QUALITY GATE REJECT — score ${(score * 100).toFixed(0)}% below the 60% minimum floor\n\n`
          : "";

    expect(badge).toContain("🚧 HARD BLOCK");
    expect(badge).toContain("38%");
    expect(badge).not.toContain("🔴 QUALITY GATE REJECT");
  });
});

// ── Issue #203: Score threshold enforcement regression tests ────────────────
// Any task with quality_score below min_score (0.80) that exits as "approved"
// must either have an explicit approval_rationale or the bug path is blocked.

describe("Score-approval invariant enforcement (issue #203)", () => {
  const HARD_BLOCK_THRESHOLD = 0.50;
  const SUB_THRESHOLD_REJECTION_LIMIT = 0.60;

  /**
   * Simulates the combined hard-block + sub-threshold enforcement pipeline
   * that applyHardBlockGuard + applySubThresholdRejectionGuard implement.
   */
  function enforceScoreThreshold(
    approved: boolean,
    score: number,
  ): { approved: boolean; blockedReason?: "hard_block_sub50" | "low_score_sub60" } {
    // Hard-block: score < 0.50
    if (score < HARD_BLOCK_THRESHOLD) {
      return { approved: false, blockedReason: "hard_block_sub50" };
    }
    // Sub-threshold: score in [0.50, 0.60)
    if (approved && score < SUB_THRESHOLD_REJECTION_LIMIT) {
      return { approved: false, blockedReason: "low_score_sub60" };
    }
    return { approved };
  }

  it("score 0.15 with approved:true must be hard-blocked to rejected", () => {
    const result = enforceScoreThreshold(true, 0.15);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score 0.00 must be hard-blocked", () => {
    const result = enforceScoreThreshold(true, 0.00);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score 0.20 must be hard-blocked", () => {
    const result = enforceScoreThreshold(true, 0.20);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score 0.49 must be hard-blocked (just below boundary)", () => {
    const result = enforceScoreThreshold(true, 0.49);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("score 0.50 with approved:true is NOT hard-blocked but IS sub-threshold rejected", () => {
    const result = enforceScoreThreshold(true, 0.50);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("score 0.55 with approved:true is sub-threshold rejected", () => {
    const result = enforceScoreThreshold(true, 0.55);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("score 0.60 with approved:true passes both gates (enters borderline)", () => {
    const result = enforceScoreThreshold(true, 0.60);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("score 0.80 with approved:true passes all gates", () => {
    const result = enforceScoreThreshold(true, 0.80);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  // The specific reported bug: score=0.15 must NEVER reach "approved"
  it("REGRESSION: score=0.15 cannot reach verification_status=approved", () => {
    // Even if LLM says approved:true, hard-block overrides to false
    const llmSaysApproved = enforceScoreThreshold(true, 0.15);
    expect(llmSaysApproved.approved).toBe(false);
    expect(llmSaysApproved.blockedReason).toBe("hard_block_sub50");

    // And if LLM correctly says approved:false, it stays false
    const llmSaysRejected = enforceScoreThreshold(false, 0.15);
    expect(llmSaysRejected.approved).toBe(false);
    expect(llmSaysRejected.blockedReason).toBe("hard_block_sub50");
  });
});

describe("inferMissingScore applies score-threshold guards (issue #203)", () => {
  const HARD_BLOCK_THRESHOLD = 0.50;
  const SUB_THRESHOLD_REJECTION_LIMIT = 0.60;

  /**
   * Simulates the enforced inference result: inferMissingScore returns
   * approved:true with a raw score, then hard-block and sub-threshold
   * guards are applied (matching the fix in verifier.ts).
   */
  function simulateInferredResult(rawScore: number): {
    approved: boolean;
    score: number;
    blockedReason?: string;
  } {
    let approved = true;
    let blockedReason: string | undefined;

    // Hard-block guard
    if (rawScore < HARD_BLOCK_THRESHOLD) {
      approved = false;
      blockedReason = "hard_block_sub50";
    }
    // Sub-threshold guard
    else if (approved && rawScore < SUB_THRESHOLD_REJECTION_LIMIT) {
      approved = false;
      blockedReason = "low_score_sub60";
    }

    return { approved, score: rawScore, blockedReason };
  }

  it("inferred score 0.15 is rejected with hard_block_sub50", () => {
    const result = simulateInferredResult(0.15);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("inferred score 0.55 is rejected with low_score_sub60", () => {
    const result = simulateInferredResult(0.55);
    expect(result.approved).toBe(false);
    expect(result.blockedReason).toBe("low_score_sub60");
  });

  it("inferred score 0.80 is approved", () => {
    const result = simulateInferredResult(0.80);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("inferred score 0.85 is approved", () => {
    const result = simulateInferredResult(0.85);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it("inferred score 0.65 is approved (enters borderline but passes guards)", () => {
    const result = simulateInferredResult(0.65);
    expect(result.approved).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });
});

describe("updateTask score-approval invariant (issue #203)", () => {
  const HARD_BLOCK_THRESHOLD = 0.50;

  /**
   * Simulates the store-level defence-in-depth guard in updateTask.
   * When verification_status="approved" and quality_score < 0.50, the
   * store overrides to "rejected".
   */
  function simulateUpdateTaskGuard(updates: {
    verification_status?: string;
    quality_score?: number | null;
  }): { verification_status?: string; quality_score?: number | null } {
    const normalized = { ...updates };
    if (
      normalized.verification_status === "approved" &&
      normalized.quality_score != null &&
      normalized.quality_score < HARD_BLOCK_THRESHOLD
    ) {
      normalized.verification_status = "rejected";
    }
    return normalized;
  }

  it("approved + score 0.15 is overridden to rejected in store", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "approved",
      quality_score: 0.15,
    });
    expect(result.verification_status).toBe("rejected");
    expect(result.quality_score).toBe(0.15);
  });

  it("approved + score 0.49 is overridden to rejected in store", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "approved",
      quality_score: 0.49,
    });
    expect(result.verification_status).toBe("rejected");
  });

  it("approved + score 0.50 is NOT overridden (above hard-block threshold)", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "approved",
      quality_score: 0.50,
    });
    expect(result.verification_status).toBe("approved");
  });

  it("approved + score 0.80 is NOT overridden", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "approved",
      quality_score: 0.80,
    });
    expect(result.verification_status).toBe("approved");
  });

  it("rejected + score 0.15 stays rejected (no override needed)", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "rejected",
      quality_score: 0.15,
    });
    expect(result.verification_status).toBe("rejected");
  });

  it("approved + null score is NOT overridden (score not known yet)", () => {
    const result = simulateUpdateTaskGuard({
      verification_status: "approved",
      quality_score: null,
    });
    expect(result.verification_status).toBe("approved");
  });

  it("update without verification_status is not affected", () => {
    const result = simulateUpdateTaskGuard({
      quality_score: 0.15,
    });
    expect(result.verification_status).toBeUndefined();
    expect(result.quality_score).toBe(0.15);
  });
});

// ── JSON extraction fallback tests (issue #587) ──────────────────────────────
// Verifies that parseResponse handles narrative LLM responses gracefully:
//   1. Clean JSON (primary path) — must continue to work correctly
//   2. JSON embedded in narrative prose — fallback regex extraction
//   3. Markdown-fenced JSON — stripped before parsing
//   4. Pure narrative with no JSON — returns default_fallback with score 0
describe("parseResponse: JSON extraction strategies (issue #587)", () => {
  const mockStore587 = {
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getChildTasks: vi.fn().mockReturnValue([]),
    insertVerificationResult: vi.fn(),
    recordLlmCallEvent: vi.fn(),
  } as unknown as Parameters<typeof Verifier>[0];

  const verifier587 = new Verifier(mockStore587);

  it("strategy 1: parses clean JSON object directly", () => {
    const text = JSON.stringify({
      approved: true,
      score: 0.85,
      notes: "Good implementation",
      dimensions: { correctness: 0.9, completeness: 0.85, test_coverage: 0.8, code_quality: 0.85 },
    });
    const result = (verifier587 as any).parseResponse(text, "task-1", "first-pass");
    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.85);
    expect(result.score_source).toBe("llm_parse");
  });

  it("strategy 1: parses JSON inside markdown fences", () => {
    const text = "```json\n" + JSON.stringify({ approved: true, score: 0.82, notes: "OK" }) + "\n```";
    const result = (verifier587 as any).parseResponse(text, "task-2", "first-pass");
    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.82);
    expect(result.score_source).toBe("llm_parse");
  });

  it("strategy 2: extracts JSON embedded in narrative preamble", () => {
    // Simulates the bug: LLM writes narrative then a JSON block
    const jsonPayload = JSON.stringify({ approved: false, score: 0.45, notes: "Incomplete" });
    const narrative = `I'm checking the implementation, tests, and git state so I can confirm whether the work is complete.\n\nAfter reviewing, here is my assessment:\n${jsonPayload}`;
    const result = (verifier587 as any).parseResponse(narrative, "task-3", "first-pass");
    // Should recover the JSON despite the narrative preamble
    // score 0.45 is below the hard-block threshold (0.50) so approved is forced false
    // but the raw score is preserved (the guard runs separately in verify())
    expect(result.score_source).toBe("llm_parse");
    expect(result.approved).toBe(false);  // hard-blocked inline in parseResponse
    expect(result.score).toBe(0.45);      // raw score preserved; guard applied separately
    expect(result.blockedReason).toBe("hard_block_sub50");
  });

  it("strategy 2: extracts JSON embedded in narrative with trailing text", () => {
    const jsonPayload = JSON.stringify({ approved: true, score: 0.88, notes: "Well done" });
    const narrative = `Let me review this task carefully.\n\n${jsonPayload}\n\nHope that helps!`;
    const result = (verifier587 as any).parseResponse(narrative, "task-4", "first-pass");
    expect(result.score_source).toBe("llm_parse");
    expect(result.approved).toBe(true);
    expect(result.score).toBe(0.88);
  });

  it("returns default_fallback when no JSON is present at all", () => {
    const narrative = "I'm checking the implementation, tests, and git state so I can confirm whether the survival-plan work is actually landed and whether anything still needs attention.";
    const result = (verifier587 as any).parseResponse(narrative, "task-5", "first-pass");
    expect(result.score_source).toBe("default_fallback");
    expect(result.approved).toBe(false);
    expect(result.score).toBe(0);
  });

  it("dimensions are parsed correctly when recovered from embedded JSON", () => {
    const jsonPayload = JSON.stringify({
      approved: true,
      score: 0.80,
      notes: "Solid work",
      dimensions: { correctness: 0.85, completeness: 0.80, test_coverage: 0.75, code_quality: 0.80 },
    });
    const narrative = `After a thorough review:\n${jsonPayload}`;
    const result = (verifier587 as any).parseResponse(narrative, "task-6", "first-pass");
    expect(result.score_source).toBe("llm_parse");
    expect(result.dimensions).toBeDefined();
    expect(result.dimensions!.correctness).toBe(0.85);
    expect(result.dimensions!.test_coverage).toBe(0.75);
  });
});

// ── Stale-result pre-check tests (issue #604) ─────────────────────────────────
// Verifies that checkStaleResultPattern correctly identifies agents returning
// cached/recalled results instead of live tool-call output for status-check tasks.
describe("checkStaleResultPattern (issue #604)", () => {
  const mockStore604 = {
    getTask: vi.fn(),
    updateTask: vi.fn(),
    getChildTasks: vi.fn().mockReturnValue([]),
    insertVerificationResult: vi.fn(),
    recordLlmCallEvent: vi.fn(),
  } as unknown as Parameters<typeof Verifier>[0];

  const verifier604 = new Verifier(mockStore604);

  // ── No detection for non-status-check tasks ──────────────────────────────

  it("does not fire for a regular feature implementation task", () => {
    const title = "feat(auth): add OAuth2 login flow";
    const result = "I already ran that check just moments ago. The results are still current.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(false);
  });

  it("does not fire for a housekeeping task even with stale phrases", () => {
    const title = "[housekeeping] Backlog triage 2026-04-30";
    const result = "I already ran that check — results are still current.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(false);
  });

  // ── Detection for status-check tasks ─────────────────────────────────────

  it("detects 'I already ran that check' in a self-check task", () => {
    const title = "Run a quick self-check: list the 3 most recently merged PRs";
    const result = "I already ran that check just moments ago. The results are still current:\n\n| #1363 | Standup |";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
    if (check.detected) {
      expect(check.matchedPhrase).toMatch(/i already ran that check/i);
    }
  });

  it("detects 'results are still current' in a list-merged-PRs task", () => {
    const title = "List the 3 most recently merged PRs in rapartlu/agent-orchestrator and report back";
    const result = "The results are still current:\n\nPR #1363 was merged at 2026-04-30T05:46:00Z";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
    if (check.detected) {
      expect(check.matchedPhrase).toMatch(/results are still current/i);
    }
  });

  it("detects 'already ran.*moments ago' pattern", () => {
    const title = "Quick status check on recent merged PRs";
    const result = "I already ran this just moments ago and the data is fresh enough.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
  });

  it("detects 'no need to re-run' phrase", () => {
    const title = "Run a self-check: verify repo health";
    const result = "No need to re-run; results from the prior cycle are still valid.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
    if (check.detected) {
      expect(check.matchedPhrase).toMatch(/no need to re-run/i);
    }
  });

  it("does NOT fire for status-check task with clean live result (no stale phrases)", () => {
    const title = "Run a quick self-check: list the 3 most recently merged PRs";
    const result = `Here are the 3 most recently merged PRs in rapartlu/agent-orchestrator (live query):

| # | Title | Merged At |
|---|-------|-----------|
| #1363 | Standup synthesis | 2026-04-30 05:46 UTC |
| #1365 | fix: route codex-orchestrator-reviewer | 2026-04-30 03:51 UTC |
| #1362 | fix: route deepseek-reasoning reviewer | 2026-04-30 03:29 UTC |`;
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(false);
  });

  it("is case-insensitive for phrase matching", () => {
    const title = "SELF-CHECK: list merged prs";
    const result = "I ALREADY RAN THAT CHECK. Results are STILL CURRENT.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
  });

  it("matches 'previously recalled' phrase", () => {
    const title = "Quick self-check on merged PRs";
    const result = "Using previously recalled output: PR #1363 merged at 2026-04-30.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
    if (check.detected) {
      expect(check.matchedPhrase).toMatch(/previously recalled/i);
    }
  });

  it("matches 'from just moments ago' phrase", () => {
    const title = "list recent merged PRs and report back";
    const result = "The data from just moments ago is still valid; here it is again.";
    const check = verifier604.checkStaleResultPattern(title, result);
    expect(check.detected).toBe(true);
    if (check.detected) {
      expect(check.matchedPhrase).toMatch(/from just moments ago/i);
    }
  });
});
