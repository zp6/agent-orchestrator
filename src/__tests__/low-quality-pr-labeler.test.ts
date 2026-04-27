/**
 * Tests for LowQualityPRLabeler (issue #428).
 *
 * Coverage:
 *  1.  parsePrRef: returns null for null source_ref
 *  2.  parsePrRef: returns null for issue ref (owner/repo#NNN)
 *  3.  parsePrRef: parses owner/repo/pull/NNN correctly
 *  4.  parsePrRef: returns null for unrecognised formats
 *  5.  applyLabel: returns false when task has no source_ref
 *  6.  applyLabel: returns false when source_ref is an issue ref, not a PR
 *  7.  applyLabel: returns false when score is null
 *  8.  applyLabel: adds label when score < 0.70
 *  9.  applyLabel: adds label when score is exactly 0.00
 * 10.  applyLabel: adds label when score is exactly 0.69 (just below threshold)
 * 11.  applyLabel: removes label when score is exactly 0.70 (at threshold)
 * 12.  applyLabel: removes label when score > 0.70
 * 13.  applyLabel: returns true on successful add
 * 14.  applyLabel: returns true on successful remove
 * 15.  applyLabel: returns false and logs error when gh CLI throws on add
 * 16.  applyLabel: returns false and logs error when gh CLI throws on remove
 * 17.  applyLabel: prefers result.score over task.quality_score
 * 18.  applyLabel: falls back to task.quality_score when result.score is 0 (falsy)
 * 19.  LowQualityPRLabeler: custom threshold is respected
 * 20.  LowQualityPRLabeler: skipLabelCreation suppresses ensureLowQualityLabel calls
 * 21.  LowQualityPRLabeler: ensureLowQualityLabel called once per repo per instance
 * 22.  LowQualityPRLabeler: ensureLowQualityLabel called again for second distinct repo
 * 23.  LOW_QUALITY_LABEL_THRESHOLD constant equals 0.70
 * 24.  LOW_QUALITY_LABEL_NAME constant equals 'low-quality'
 * 25.  ensureLowQualityLabel error is non-fatal (add still attempted)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { VerificationResult } from "../reviewer/verifier.js";
import type { Task } from "../state/types.js";

// ── Module mock setup ─────────────────────────────────────────────────────────
// We mock the execSync calls to avoid spawning real gh processes in tests.

const mockExecSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Import AFTER mocking so module-level execSync references pick up the mock.
const {
  LowQualityPRLabeler,
  parsePrRef,
  LOW_QUALITY_LABEL_THRESHOLD,
  LOW_QUALITY_LABEL_NAME,
  ensureLowQualityLabel,
  addLowQualityLabel,
  removeLowQualityLabel,
} = await import("../reviewer/low-quality-pr-labeler.js");

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeResult(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return {
    approved: true,
    score: 0.55,
    notes: "Work is incomplete.",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01ABCDEF1234567890ABCDEFGH",
    title: "housekeeping triage task",
    status: "done",
    task_type: "housekeeping",
    source_ref: "rapartlu/agent-reviewer/pull/428",
    quality_score: 0.55,
    verification_status: "approved",
    ...overrides,
  } as Task;
}

// ── parsePrRef ────────────────────────────────────────────────────────────────

describe("parsePrRef", () => {
  it("1. returns null for null source_ref", () => {
    expect(parsePrRef(null)).toBeNull();
  });

  it("2. returns null for issue ref (owner/repo#NNN)", () => {
    expect(parsePrRef("rapartlu/agent-reviewer#123")).toBeNull();
  });

  it("3. parses owner/repo/pull/NNN correctly", () => {
    const result = parsePrRef("rapartlu/agent-reviewer/pull/428");
    expect(result).toEqual({ repo: "rapartlu/agent-reviewer", prNumber: "428" });
  });

  it("4. returns null for unrecognised formats", () => {
    expect(parsePrRef("rapartlu/agent-reviewer")).toBeNull();
    expect(parsePrRef("https://github.com/rapartlu/agent-reviewer/pull/428")).toBeNull();
    expect(parsePrRef("just-a-string")).toBeNull();
  });
});

// ── LowQualityPRLabeler.applyLabel ────────────────────────────────────────────

describe("LowQualityPRLabeler.applyLabel", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("5. returns false when task has no source_ref", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(makeResult(), makeTask({ source_ref: null }));
    expect(result).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("6. returns false when source_ref is an issue ref, not a PR", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(
      makeResult(),
      makeTask({ source_ref: "rapartlu/agent-reviewer#100" }),
    );
    expect(result).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("7. returns false when score is null", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(
      makeResult({ score: undefined as unknown as number }),
      makeTask({ quality_score: null }),
    );
    expect(result).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("8. adds label when score < 0.70", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledOnce();
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--add-label");
    expect(cmd).toContain(LOW_QUALITY_LABEL_NAME);
  });

  it("9. adds label when score is exactly 0.00", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(makeResult({ score: 0.00 }), makeTask());
    expect(result).toBe(true);
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--add-label");
  });

  it("10. adds label when score is exactly 0.69 (just below threshold)", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    await labeler.applyLabel(makeResult({ score: 0.69 }), makeTask());
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--add-label");
  });

  it("11. removes label when score is exactly 0.70 (at threshold)", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    const result = await labeler.applyLabel(makeResult({ score: 0.70 }), makeTask());
    expect(result).toBe(true);
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--remove-label");
    expect(cmd).toContain(LOW_QUALITY_LABEL_NAME);
  });

  it("12. removes label when score > 0.70", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    await labeler.applyLabel(makeResult({ score: 0.95 }), makeTask());
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--remove-label");
  });

  it("13. returns true on successful add", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    expect(result).toBe(true);
  });

  it("14. returns true on successful remove", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    mockExecSync.mockReturnValue(Buffer.from(""));
    const result = await labeler.applyLabel(makeResult({ score: 0.80 }), makeTask());
    expect(result).toBe(true);
  });

  it("15. returns false and catches error when gh CLI throws on add", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    mockExecSync.mockImplementation(() => { throw new Error("gh: not authenticated"); });
    const result = await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    expect(result).toBe(false);
  });

  it("16. returns false and catches error when gh CLI throws on remove", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    mockExecSync.mockImplementation(() => { throw new Error("gh: PR not found"); });
    const result = await labeler.applyLabel(makeResult({ score: 0.80 }), makeTask());
    expect(result).toBe(false);
  });

  it("17. prefers result.score over task.quality_score", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    // result.score = 0.85 (above threshold) but task.quality_score = 0.55 (below)
    // should use result.score → remove label
    await labeler.applyLabel(makeResult({ score: 0.85 }), makeTask({ quality_score: 0.55 }));
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--remove-label");
  });

  it("18. falls back to task.quality_score when result.score is not set", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    // result with score=0 (falsy in JS but valid score) vs task.quality_score=0.55
    // parsePrRef + score resolution: result.score ?? task.quality_score
    // When result.score is undefined (not set), falls back to task.quality_score
    const result = makeResult({ score: undefined as unknown as number });
    await labeler.applyLabel(result, makeTask({ quality_score: 0.55 }));
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--add-label");
  });
});

// ── Options ───────────────────────────────────────────────────────────────────

describe("LowQualityPRLabeler options", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("19. custom threshold is respected", async () => {
    const labeler = new LowQualityPRLabeler({ threshold: 0.80, skipLabelCreation: true });
    // score 0.75 is below 0.80 → should add label
    await labeler.applyLabel(makeResult({ score: 0.75 }), makeTask());
    const cmd = mockExecSync.mock.calls[0][0] as string;
    expect(cmd).toContain("--add-label");
  });

  it("20. skipLabelCreation suppresses ensureLowQualityLabel calls", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: true });
    await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    // Only one execSync call (the add-label), not two (ensure + add)
    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(labeler.ensuredRepoCount).toBe(0);
  });

  it("21. ensureLowQualityLabel called once per repo per instance", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: false });
    // Two calls for the same repo
    await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    // 1 ensure + 1 add on first call, 0 ensure + 1 add on second call
    const ensureCalls = mockExecSync.mock.calls.filter(
      (call) => (call[0] as string).includes("label create"),
    );
    expect(ensureCalls).toHaveLength(1);
    expect(labeler.ensuredRepoCount).toBe(1);
  });

  it("22. ensureLowQualityLabel called again for second distinct repo", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: false });
    await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    await labeler.applyLabel(
      makeResult({ score: 0.55 }),
      makeTask({ source_ref: "rapartlu/agent-dashboard/pull/99" }),
    );
    const ensureCalls = mockExecSync.mock.calls.filter(
      (call) => (call[0] as string).includes("label create"),
    );
    expect(ensureCalls).toHaveLength(2);
    expect(labeler.ensuredRepoCount).toBe(2);
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("23. LOW_QUALITY_LABEL_THRESHOLD constant equals 0.70", () => {
    expect(LOW_QUALITY_LABEL_THRESHOLD).toBe(0.70);
  });

  it("24. LOW_QUALITY_LABEL_NAME constant equals 'low-quality'", () => {
    expect(LOW_QUALITY_LABEL_NAME).toBe("low-quality");
  });
});

// ── ensureLowQualityLabel error resilience ────────────────────────────────────

describe("ensureLowQualityLabel error resilience", () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("25. ensureLowQualityLabel error is non-fatal (add still attempted)", async () => {
    const labeler = new LowQualityPRLabeler({ skipLabelCreation: false });
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      callCount++;
      if (cmd.includes("label create")) throw new Error("forbidden");
      // add-label succeeds
      return Buffer.from("");
    });
    const result = await labeler.applyLabel(makeResult({ score: 0.55 }), makeTask());
    // add-label was still called despite ensure failure
    expect(result).toBe(true);
    expect(callCount).toBe(2); // ensure (throws) + add-label (succeeds)
  });
});
