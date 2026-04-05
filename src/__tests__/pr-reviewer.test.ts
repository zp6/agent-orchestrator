import { describe, it, expect } from "vitest";
import { enforceChecklist } from "../reviewer/pr-reviewer.js";

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
