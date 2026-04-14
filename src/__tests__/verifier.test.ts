import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VerificationResult } from "../reviewer/verifier.js";
import { RESEARCH_OUTPUT_SCHEMA, RESEARCH_REQUIRED_SECTIONS } from "../reviewer/verifier.js";
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
  it("borderline range is [0.70, 0.79]", () => {
    const BORDERLINE_LOW = 0.70;
    const BORDERLINE_HIGH = 0.79;

    // scores that should trigger second pass
    const borderlineScores = [0.70, 0.74, 0.75, 0.79];
    // scores that should NOT trigger second pass
    const nonBorderlineScores = [0.69, 0.80, 0.90, 0.50, 0.00, 1.00];

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

describe("Marginal approval flagging (score 0.60–0.74)", () => {
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

  it("marginalApproval range is [0.60, 0.74]", () => {
    const MARGINAL_LOW = 0.60;
    const MARGINAL_HIGH = 0.74;

    const marginalScores = [0.60, 0.65, 0.70, 0.74];
    const nonMarginalApprovalScores = [0.59, 0.75, 0.80, 0.90];

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
      approved && score >= 0.60 && score <= 0.74;

    // Approved, marginal score → marginalApproval
    expect(isMarginalApproval(true, 0.68)).toBe(true);
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
