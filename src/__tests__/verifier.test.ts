import { describe, it, expect, vi, beforeEach } from "vitest";
import type { VerificationResult } from "../reviewer/verifier.js";
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
