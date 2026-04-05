import { describe, it, expect } from "vitest";
import {
  enforceChecklist,
  extractChecklistItems,
  buildFeedbackTaskMessage,
  validateClosesReferences,
} from "../reviewer/pr-reviewer.js";

describe("enforceChecklist", () => {
  it("returns unchanged when already numbered", () => {
    const input = "1. Fix the bug\n2. Add a test";
    expect(enforceChecklist(input)).toBe(input);
  });

  it("returns unchanged when numbered with parentheses", () => {
    const input = "1) Fix the bug\n2) Add a test";
    expect(enforceChecklist(input)).toBe(input);
  });

  it("wraps a single sentence as item 1", () => {
    const result = enforceChecklist("Fix the null pointer exception.");
    expect(result).toBe("1. Fix the null pointer exception.");
  });

  it("converts bullet list to numbered list", () => {
    const input = "- Fix auth\n- Add test\n- Update docs";
    const result = enforceChecklist(input);
    expect(result).toBe("1. Fix auth\n2. Add test\n3. Update docs");
  });

  it("converts star bullets to numbered list", () => {
    const input = "* Fix auth\n* Add test";
    const result = enforceChecklist(input);
    expect(result).toBe("1. Fix auth\n2. Add test");
  });

  it("converts a paragraph with multiple sentences to numbered items", () => {
    const input = "Fix the null pointer exception. Add error handling. Update the test.";
    const result = enforceChecklist(input);
    expect(result).toContain("1.");
    expect(result).toContain("2.");
    expect(result).toContain("3.");
  });

  it("returns empty string for empty input", () => {
    expect(enforceChecklist("")).toBe("");
  });

  it("handles multi-line paragraphs as numbered items", () => {
    const input = "The function crashes on null input\nThe error message is confusing";
    const result = enforceChecklist(input);
    expect(result).toBe("1. The function crashes on null input\n2. The error message is confusing");
  });
});

describe("extractChecklistItems", () => {
  it("extracts items from a numbered list", () => {
    const input = "1. Fix the null pointer\n2. Add error handling\n3. Update tests";
    expect(extractChecklistItems(input)).toEqual([
      "Fix the null pointer",
      "Add error handling",
      "Update tests",
    ]);
  });

  it("extracts items from a numbered list with parentheses", () => {
    const input = "1) First item\n2) Second item";
    expect(extractChecklistItems(input)).toEqual(["First item", "Second item"]);
  });

  it("extracts items from a bullet list", () => {
    const input = "- Fix auth\n- Add test\n- Update docs";
    expect(extractChecklistItems(input)).toEqual(["Fix auth", "Add test", "Update docs"]);
  });

  it("extracts items from star bullets", () => {
    const input = "* First\n* Second";
    expect(extractChecklistItems(input)).toEqual(["First", "Second"]);
  });

  it("splits a single sentence paragraph into items", () => {
    const input = "Fix the bug. Add a test. Update the docs.";
    expect(extractChecklistItems(input)).toEqual([
      "Fix the bug.",
      "Add a test.",
      "Update the docs.",
    ]);
  });

  it("returns a single-sentence comment as one item", () => {
    const input = "Fix the null pointer exception";
    expect(extractChecklistItems(input)).toEqual(["Fix the null pointer exception"]);
  });

  it("returns multi-line paragraph lines as items", () => {
    const input = "The function crashes on null\nThe error message is wrong";
    expect(extractChecklistItems(input)).toEqual([
      "The function crashes on null",
      "The error message is wrong",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(extractChecklistItems("")).toEqual([]);
  });
});

describe("buildFeedbackTaskMessage", () => {
  const baseOpts = {
    repo: "rapartlu/claude-agent-orchestrator",
    prNumber: 42,
    prTitle: "feat: add new feature",
    prBranch: "issue-42-new-feature",
    reviewComment: "1. Fix the null pointer\n2. Add error handling",
    diff: "diff --git a/src/foo.ts b/src/foo.ts\n+const x = 1;",
  };

  it("includes a - [ ] checklist for each requested change", () => {
    const msg = buildFeedbackTaskMessage(baseOpts);
    expect(msg).toContain("- [ ] Fix the null pointer");
    expect(msg).toContain("- [ ] Add error handling");
  });

  it("includes the PR branch name in the message", () => {
    const msg = buildFeedbackTaskMessage(baseOpts);
    expect(msg).toContain("issue-42-new-feature");
  });

  it("includes the PR number and repo", () => {
    const msg = buildFeedbackTaskMessage(baseOpts);
    expect(msg).toContain("PR #42");
    expect(msg).toContain("rapartlu/claude-agent-orchestrator");
  });

  it("includes a diff context section", () => {
    const msg = buildFeedbackTaskMessage(baseOpts);
    expect(msg).toContain("## Diff context");
    expect(msg).toContain("diff --git");
  });

  it("truncates very large diffs", () => {
    const largeDiff = "x".repeat(10_000);
    const msg = buildFeedbackTaskMessage({ ...baseOpts, diff: largeDiff });
    expect(msg).toContain("diff truncated");
    expect(msg.length).toBeLessThan(10_000);
  });

  it("falls back to a single checklist item when comment has no recognisable structure", () => {
    const msg = buildFeedbackTaskMessage({
      ...baseOpts,
      reviewComment: "Please fix everything",
    });
    expect(msg).toContain("- [ ] Please fix everything");
  });

  it("omits diff section when diff is empty", () => {
    const msg = buildFeedbackTaskMessage({ ...baseOpts, diff: "" });
    expect(msg).not.toContain("## Diff context");
  });

  it("handles a comment with the orchestrator header already stripped", () => {
    const comment = "1. Fix the race condition\n2. Add a lock";
    const msg = buildFeedbackTaskMessage({ ...baseOpts, reviewComment: comment });
    expect(msg).toContain("- [ ] Fix the race condition");
    expect(msg).toContain("- [ ] Add a lock");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// validateClosesReferences (issue #373)
// ────────────────────────────────────────────────────────────────────────────

describe("validateClosesReferences", () => {
  const prRepo = "rapartlu/claude-orchestrator-reviewer";
  const issueRepo = "rapartlu/claude-agent-orchestrator";

  it("returns empty array when repos are the same (bare refs are fine)", () => {
    const body = "## Summary\n\nCloses #42\n\nSome description";
    expect(validateClosesReferences(prRepo, body, prRepo)).toEqual([]);
  });

  it("flags bare 'Closes #N' when PR and issue repos differ", () => {
    const body = "## Summary\n\nCloses #373\n\nImplemented the feature.";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toHaveLength(1);
    expect(issues[0].keyword).toBe("Closes");
    expect(issues[0].number).toBe(373);
    expect(issues[0].suggestedRef).toBe("rapartlu/claude-agent-orchestrator#373");
  });

  it("flags bare 'Fixes #N' and 'Resolves #N' variants", () => {
    const body = "Fixes #100\nResolves #200";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toHaveLength(2);
    expect(issues[0].keyword).toBe("Fixes");
    expect(issues[0].number).toBe(100);
    expect(issues[1].keyword).toBe("Resolves");
    expect(issues[1].number).toBe(200);
  });

  it("is case-insensitive", () => {
    const body = "closes #42\nFIXES #99";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(42);
    expect(issues[1].number).toBe(99);
  });

  it("does NOT flag fully qualified references (already correct)", () => {
    const body = "Closes rapartlu/claude-agent-orchestrator#373";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toEqual([]);
  });

  it("flags bare refs but not qualified refs in the same body", () => {
    const body =
      "Closes rapartlu/claude-agent-orchestrator#373\n\nAlso closes #99";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(99);
    expect(issues[0].keyword.toLowerCase()).toBe("closes");
  });

  it("returns empty array when body has no closing keywords", () => {
    const body = "Just a regular PR description with no closing refs.";
    expect(validateClosesReferences(prRepo, body, issueRepo)).toEqual([]);
  });

  it("returns empty array when body is empty", () => {
    expect(validateClosesReferences(prRepo, "", issueRepo)).toEqual([]);
  });

  it("handles multiple bare refs to the same issue", () => {
    // Agents sometimes put Closes #N in both Summary and at the bottom
    const body = "## Summary\nCloses #373\n\n## Details\nFixes #373";
    const issues = validateClosesReferences(prRepo, body, issueRepo);
    expect(issues).toHaveLength(2);
    expect(issues.every((i) => i.number === 373)).toBe(true);
  });
});
