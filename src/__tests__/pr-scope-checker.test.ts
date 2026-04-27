/**
 * Tests for the PR Scope Pre-Flight Checker (issue #358).
 *
 * Covers:
 *  1. extractClosesRefs — parsing various close keyword formats
 *  2. extractFilesFromDiff — git diff and plain patch formats
 *  3. checkPRScope — "clean" (no violation)
 *  4. checkPRScope — "multi-issue" (2+ Closes refs in body)
 *  5. checkPRScope — "triage-feature-mix" (docs + src files)
 *  6. checkPRScope — "multi-module" (3+ large source dirs)
 *  7. checkPRScope — multi-module NOT fired with only 2 qualifying groups
 *  8. checkPRScope — multi-module NOT fired when groups < minFilesPerGroup
 *  9. checkPRScope — priority: multi-issue beats triage-feature-mix
 * 10. checkPRScope — priority: multi-issue beats multi-module
 * 11. formatScopeViolationComment — includes header, reason, split suggestion
 * 12. formatScopeViolationComment — includes per-issue branch commands for multi-issue
 * 13. extractClosesRefs — case-insensitive matching
 * 14. extractClosesRefs — cross-repo refs (owner/repo#N)
 * 15. checkPRScope — single large module does NOT trigger multi-module
 * 16. feature_groups assigned to closes_hint from PR body refs
 */

import { describe, expect, it } from "vitest";
import {
  checkPRScope,
  extractClosesRefs,
  extractFilesFromDiff,
  formatScopeViolationComment,
} from "../reviewer/pr-scope-checker.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDiff(files: string[]): string {
  return files
    .map(
      (f) =>
        `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-old\n+new\n`,
    )
    .join("\n");
}

function srcFiles(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/${dir}/file${i + 1}.ts`);
}

// ── extractClosesRefs ─────────────────────────────────────────────────────────

describe("extractClosesRefs", () => {
  it("extracts a single closes ref", () => {
    expect(extractClosesRefs("Closes #42")).toEqual([42]);
  });

  it("extracts multiple closes refs", () => {
    expect(extractClosesRefs("Closes #10\nFixes #20\nResolves #30")).toEqual([10, 20, 30]);
  });

  it("is case-insensitive", () => {
    expect(extractClosesRefs("CLOSES #5\nFIXES #6")).toEqual([5, 6]);
  });

  it("deduplicates the same ref", () => {
    expect(extractClosesRefs("Closes #42\nCloses #42")).toEqual([42]);
  });

  it("handles cross-repo refs (owner/repo#N)", () => {
    expect(extractClosesRefs("Closes rapartlu/agent-reviewer#99")).toEqual([99]);
  });

  it("returns sorted results", () => {
    expect(extractClosesRefs("Closes #30\nCloses #5\nCloses #15")).toEqual([5, 15, 30]);
  });

  it("returns empty array when no refs present", () => {
    expect(extractClosesRefs("This PR adds a new feature.")).toEqual([]);
  });

  it("does NOT match bare #N without a close keyword", () => {
    expect(extractClosesRefs("See issue #99 for context.")).toEqual([]);
  });
});

// ── extractFilesFromDiff ──────────────────────────────────────────────────────

describe("extractFilesFromDiff", () => {
  it("extracts files from git diff headers", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/src/bar.ts b/src/bar.ts",
      "--- a/src/bar.ts",
      "+++ b/src/bar.ts",
    ].join("\n");
    expect(extractFilesFromDiff(diff)).toEqual(["src/bar.ts", "src/foo.ts"]);
  });

  it("falls back to +++ b/ lines when no git headers", () => {
    const diff = [
      "--- a/lib/util.js",
      "+++ b/lib/util.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    expect(extractFilesFromDiff(diff)).toEqual(["lib/util.js"]);
  });

  it("returns empty array for empty diff", () => {
    expect(extractFilesFromDiff("")).toEqual([]);
  });

  it("ignores /dev/null in +++ lines", () => {
    const diff = "+++ /dev/null\n+++ b/src/new.ts";
    expect(extractFilesFromDiff(diff)).toEqual(["src/new.ts"]);
  });

  it("deduplicates files appearing multiple times", () => {
    const diff =
      "diff --git a/src/foo.ts b/src/foo.ts\n" +
      "diff --git a/src/foo.ts b/src/foo.ts\n";
    expect(extractFilesFromDiff(diff)).toEqual(["src/foo.ts"]);
  });
});

// ── checkPRScope — clean ──────────────────────────────────────────────────────

describe("checkPRScope — clean", () => {
  it("returns clean for a single-issue single-module PR", () => {
    const body = "Implements the new auth module.\n\nCloses #42";
    const diff = makeDiff([...srcFiles("auth", 5)]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
    expect(result.violation_type).toBe("clean");
    expect(result.closes_refs).toEqual([42]);
    expect(result.feature_groups).toHaveLength(0);
  });

  it("returns clean when PR body has no closes refs and single module", () => {
    const body = "Minor cleanup.";
    const diff = makeDiff(srcFiles("reviewer", 3));
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
  });

  it("returns clean for an empty diff", () => {
    const result = checkPRScope("Closes #1", "");
    expect(result.violation).toBe(false);
  });
});

// ── checkPRScope — multi-issue ────────────────────────────────────────────────

describe("checkPRScope — multi-issue", () => {
  it("fires when PR body has 2 closes refs", () => {
    const body = "Closes #10\nCloses #20";
    const diff = makeDiff(srcFiles("reviewer", 4));
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("multi-issue");
    expect(result.closes_refs).toEqual([10, 20]);
  });

  it("fires for 3+ closes refs", () => {
    const body = "Fixes #1\nFixes #2\nResolves #3";
    const diff = makeDiff(srcFiles("foo", 3));
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("multi-issue");
    expect(result.closes_refs).toEqual([1, 2, 3]);
  });

  it("includes feature_groups with closes_hint per ref", () => {
    const body = "Closes #10\nCloses #20";
    const diff = makeDiff(srcFiles("auth", 3));
    const result = checkPRScope(body, diff);
    expect(result.feature_groups.length).toBeGreaterThanOrEqual(1);
    const hints = result.feature_groups.map((g) => g.closes_hint);
    expect(hints).toContain(10);
    expect(hints).toContain(20);
  });

  it("does NOT fire for exactly 1 closes ref", () => {
    const body = "Closes #42";
    const diff = makeDiff(srcFiles("foo", 5));
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
  });
});

// ── checkPRScope — triage-feature-mix ────────────────────────────────────────

describe("checkPRScope — triage-feature-mix", () => {
  it("fires when CLAUDE.md + src/ files are in the same PR", () => {
    const body = "Closes #55";
    const diff = makeDiff(["CLAUDE.md", "README.md", ...srcFiles("reviewer", 3)]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("triage-feature-mix");
  });

  it("fires for docs/ + src/ mix", () => {
    const body = "Closes #60";
    const diff = makeDiff(["docs/architecture.md", "docs/api.md", ...srcFiles("state", 2)]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("triage-feature-mix");
  });

  it("includes two feature_groups: docs and implementation", () => {
    const body = "Closes #70";
    const diff = makeDiff(["CLAUDE.md", "src/index.ts"]);
    const result = checkPRScope(body, diff);
    expect(result.feature_groups).toHaveLength(2);
    const labels = result.feature_groups.map((g) => g.label);
    expect(labels.some((l) => l.toLowerCase().includes("documentation"))).toBe(true);
    expect(labels.some((l) => l.toLowerCase().includes("implementation"))).toBe(true);
  });

  it("does NOT fire for pure docs PR (no feature files)", () => {
    const body = "Update README.\n\nCloses #80";
    const diff = makeDiff(["README.md", "docs/guide.md"]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
  });

  it("does NOT fire for pure feature PR (no triage files)", () => {
    const body = "Add feature.\n\nCloses #81";
    const diff = makeDiff(srcFiles("reviewer", 5));
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
  });
});

// ── checkPRScope — multi-module ───────────────────────────────────────────────

describe("checkPRScope — multi-module", () => {
  it("fires when 3+ source modules each have ≥3 files", () => {
    const body = "Closes #100";
    const diff = makeDiff([
      ...srcFiles("reviewer", 4),
      ...srcFiles("state", 4),
      ...srcFiles("telegram", 4),
    ]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("multi-module");
    expect(result.feature_groups.length).toBeGreaterThanOrEqual(3);
  });

  it("does NOT fire with only 2 qualifying modules", () => {
    const body = "Closes #101";
    const diff = makeDiff([
      ...srcFiles("reviewer", 4),
      ...srcFiles("state", 4),
    ]);
    const result = checkPRScope(body, diff);
    // 2 groups < default minGroupsForViolation=3 → clean
    expect(result.violation).toBe(false);
  });

  it("does NOT fire when groups are below minFilesPerGroup threshold", () => {
    const body = "Closes #102";
    const diff = makeDiff([
      ...srcFiles("reviewer", 2), // below default threshold of 3
      ...srcFiles("state", 2),
      ...srcFiles("telegram", 2),
    ]);
    const result = checkPRScope(body, diff);
    expect(result.violation).toBe(false);
  });

  it("respects custom minFilesPerGroup option", () => {
    const body = "Closes #103";
    const diff = makeDiff([
      ...srcFiles("reviewer", 2),
      ...srcFiles("state", 2),
      ...srcFiles("telegram", 2),
    ]);
    // Lower threshold to 2 → should fire
    const result = checkPRScope(body, diff, { minFilesPerGroup: 2, minGroupsForViolation: 3 });
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("multi-module");
  });

  it("respects custom minGroupsForViolation option", () => {
    const body = "Closes #104";
    const diff = makeDiff([
      ...srcFiles("reviewer", 4),
      ...srcFiles("state", 4),
    ]);
    // Lower group threshold to 2 → 2 groups should fire
    const result = checkPRScope(body, diff, { minFilesPerGroup: 3, minGroupsForViolation: 2 });
    expect(result.violation).toBe(true);
    expect(result.violation_type).toBe("multi-module");
  });
});

// ── Priority ordering ─────────────────────────────────────────────────────────

describe("checkPRScope — violation priority", () => {
  it("multi-issue beats triage-feature-mix", () => {
    const body = "Closes #1\nCloses #2";
    // Also has triage + feature mix
    const diff = makeDiff(["CLAUDE.md", ...srcFiles("reviewer", 3)]);
    const result = checkPRScope(body, diff);
    expect(result.violation_type).toBe("multi-issue");
  });

  it("multi-issue beats multi-module", () => {
    const body = "Closes #1\nCloses #2";
    const diff = makeDiff([
      ...srcFiles("reviewer", 4),
      ...srcFiles("state", 4),
      ...srcFiles("telegram", 4),
    ]);
    const result = checkPRScope(body, diff);
    expect(result.violation_type).toBe("multi-issue");
  });

  it("triage-feature-mix beats multi-module", () => {
    const body = "Closes #99";
    // Has triage + feature + many modules
    const diff = makeDiff([
      "CLAUDE.md",
      ...srcFiles("reviewer", 4),
      ...srcFiles("state", 4),
      ...srcFiles("telegram", 4),
    ]);
    const result = checkPRScope(body, diff);
    expect(result.violation_type).toBe("triage-feature-mix");
  });
});

// ── formatScopeViolationComment ───────────────────────────────────────────────

describe("formatScopeViolationComment", () => {
  it("includes the violation header", () => {
    const result = checkPRScope("Closes #1\nCloses #2", makeDiff(srcFiles("reviewer", 3)));
    const comment = formatScopeViolationComment(result, 99);
    expect(comment).toContain("Scope violation");
  });

  it("includes the reason text", () => {
    const result = checkPRScope("Closes #1\nCloses #2", makeDiff(srcFiles("reviewer", 3)));
    const comment = formatScopeViolationComment(result, 99);
    expect(comment).toContain(result.reason);
  });

  it("includes split suggestion block", () => {
    const result = checkPRScope("Closes #1\nCloses #2", makeDiff(srcFiles("foo", 3)));
    const comment = formatScopeViolationComment(result, 99);
    expect(comment).toContain("Suggested split");
  });

  it("includes per-issue branch commands for multi-issue violations", () => {
    const result = checkPRScope("Closes #10\nCloses #20", makeDiff(srcFiles("foo", 3)));
    const comment = formatScopeViolationComment(result, 99);
    expect(comment).toContain("issue-10-description");
    expect(comment).toContain("issue-20-description");
    expect(comment).toContain("Closes #10");
    expect(comment).toContain("Closes #20");
  });

  it("includes attribution footer", () => {
    const result = checkPRScope("Closes #1\nCloses #2", makeDiff(srcFiles("foo", 3)));
    const comment = formatScopeViolationComment(result, 99);
    expect(comment).toContain("#358");
  });

  it("includes triage-vs-feature sections in triage-feature-mix comment", () => {
    const diff = makeDiff(["CLAUDE.md", "src/index.ts"]);
    const result = checkPRScope("Closes #5", diff);
    const comment = formatScopeViolationComment(result, 5);
    expect(comment).toContain("housekeeping");
    expect(comment).toContain("feature");
  });
});
