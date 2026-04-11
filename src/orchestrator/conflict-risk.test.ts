import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  extractIssueFingerprint,
  scoreConflictRisk,
  assessConflictRisk,
} from "./conflict-risk.js";

// Mock execFileSync so tests don't require the `gh` CLI
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
const mockExec = vi.mocked(execFileSync);

describe("extractIssueFingerprint", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns empty array for blank issue", () => {
    expect(extractIssueFingerprint("", "")).toEqual([]);
  });

  it("maps dispatcher keyword to path tokens", () => {
    const tokens = extractIssueFingerprint("Fix dispatcher retry logic", "");
    expect(tokens).toContain("src/orchestrator/dispatcher");
  });

  it("maps supervisor keyword", () => {
    const tokens = extractIssueFingerprint("Supervisor routing improvement", "");
    expect(tokens).toContain("src/orchestrator/supervisor");
  });

  it("extracts explicit src/ paths from body", () => {
    const tokens = extractIssueFingerprint(
      "Bug fix",
      "The issue is in src/orchestrator/planner.ts",
    );
    expect(tokens).toContain("src/orchestrator/planner");
  });

  it("maps dashboard keyword", () => {
    const tokens = extractIssueFingerprint("Dashboard conflict heat map panel", "");
    expect(tokens).toContain("src/dashboard");
  });

  it("maps conflict keyword", () => {
    const tokens = extractIssueFingerprint("Reduce merge conflicts", "");
    expect(tokens).toContain("src/orchestrator/pr-reviewer");
  });

  it("extracts CamelCase class names from title", () => {
    const tokens = extractIssueFingerprint("Fix PreDispatchValidator edge case", "");
    expect(tokens.some((t) => t.includes("pre-dispatch-validator"))).toBe(true);
  });

  it("deduplicates tokens", () => {
    const tokens = extractIssueFingerprint("dispatcher dispatcher dispatcher", "");
    const dispatcherTokens = tokens.filter((t) => t === "src/orchestrator/dispatcher");
    expect(dispatcherTokens.length).toBe(1);
  });
});

describe("scoreConflictRisk", () => {
  it("returns zero score with empty fingerprint", () => {
    const prFiles = new Map([[1, ["src/orchestrator/dispatcher.ts"]]]);
    const result = scoreConflictRisk([], prFiles);
    expect(result.score).toBe(0);
  });

  it("returns zero score with no open PRs", () => {
    const result = scoreConflictRisk(["src/orchestrator/dispatcher"], new Map());
    expect(result.score).toBe(0);
  });

  it("scores 1.0 when all fingerprint tokens match open PRs", () => {
    const fingerprint = ["src/orchestrator/dispatcher"];
    const prFiles = new Map([[1, ["src/orchestrator/dispatcher.ts"]]]);
    const result = scoreConflictRisk(fingerprint, prFiles);
    expect(result.score).toBe(1.0);
    expect(result.overlappingPRs).toContain(1);
  });

  it("scores 0.5 when half the fingerprint tokens match", () => {
    const fingerprint = ["src/orchestrator/dispatcher", "src/state/store"];
    const prFiles = new Map([[1, ["src/orchestrator/dispatcher.ts"]]]);
    const result = scoreConflictRisk(fingerprint, prFiles);
    expect(result.score).toBe(0.5);
  });

  it("identifies hot files (touched by 2+ PRs)", () => {
    const fingerprint = ["src/orchestrator/dispatcher"];
    const prFiles = new Map([
      [1, ["src/orchestrator/dispatcher.ts", "src/state/store.ts"]],
      [2, ["src/orchestrator/dispatcher.ts", "src/config/schema.ts"]],
    ]);
    const result = scoreConflictRisk(fingerprint, prFiles);
    expect(result.hotFiles).toContain("src/orchestrator/dispatcher.ts");
    expect(result.hotFiles).not.toContain("src/state/store.ts");
  });

  it("returns overlapping PR numbers", () => {
    const fingerprint = ["src/orchestrator/dispatcher"];
    const prFiles = new Map([
      [42, ["src/orchestrator/dispatcher.ts"]],
      [99, ["src/state/store.ts"]],
    ]);
    const result = scoreConflictRisk(fingerprint, prFiles);
    expect(result.overlappingPRs).toContain(42);
    expect(result.overlappingPRs).not.toContain(99);
  });

  it("returns zero when fingerprint does not match any PR files", () => {
    const fingerprint = ["src/orchestrator/planner"];
    const prFiles = new Map([[1, ["src/state/store.ts", "src/config/schema.ts"]]]);
    const result = scoreConflictRisk(fingerprint, prFiles);
    expect(result.score).toBe(0);
    expect(result.overlappingFiles).toHaveLength(0);
  });
});

describe("assessConflictRisk", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns zero score when fingerprint extraction yields nothing", () => {
    const result = assessConflictRisk("owner/repo", "Random untitled task", "");
    expect(result.score).toBe(0);
    expect(result.hotFiles).toHaveLength(0);
  });

  it("calls gh to list open PRs when fingerprint is non-empty", () => {
    // First call: gh pr list → returns PR numbers
    mockExec.mockImplementationOnce(() => JSON.stringify([{ number: 5 }]));
    // Second call: gh api files for PR 5
    mockExec.mockImplementationOnce(() => JSON.stringify(["src/orchestrator/dispatcher.ts"]));

    const result = assessConflictRisk(
      "owner/repo",
      "Fix dispatcher queue overflow",
      "",
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.overlappingPRs).toContain(5);
  });

  it("handles gh CLI failure gracefully and returns zero score", () => {
    mockExec.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const result = assessConflictRisk("owner/repo", "Fix dispatcher", "");
    expect(result.score).toBe(0);
  });
});
