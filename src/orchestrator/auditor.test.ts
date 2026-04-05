import { describe, it, expect } from "vitest";
import { extractClosedIssues, hasClosingRef } from "./auditor.js";

describe("extractClosedIssues", () => {
  it("returns empty array for null/undefined/empty body", () => {
    expect(extractClosedIssues(null)).toEqual([]);
    expect(extractClosedIssues(undefined)).toEqual([]);
    expect(extractClosedIssues("")).toEqual([]);
  });

  it("extracts 'Closes #N' references", () => {
    expect(extractClosedIssues("Closes #42")).toEqual([42]);
    expect(extractClosedIssues("closes #10")).toEqual([10]);
  });

  it("extracts 'Fixes #N' references", () => {
    expect(extractClosedIssues("Fixes #7")).toEqual([7]);
    expect(extractClosedIssues("Fixed #100")).toEqual([100]);
    expect(extractClosedIssues("fix #3")).toEqual([3]);
  });

  it("extracts 'Resolves #N' references", () => {
    expect(extractClosedIssues("Resolves #55")).toEqual([55]);
    expect(extractClosedIssues("resolved #8")).toEqual([8]);
    expect(extractClosedIssues("resolve #1")).toEqual([1]);
  });

  it("extracts multiple issue numbers from a single body", () => {
    const body = "Closes #10\n\nAlso fixes #20 and resolves #30";
    const result = extractClosedIssues(body);
    expect(result).toContain(10);
    expect(result).toContain(20);
    expect(result).toContain(30);
    expect(result).toHaveLength(3);
  });

  it("ignores bare #N references without a closing keyword", () => {
    expect(extractClosedIssues("See #42 for details")).toEqual([]);
    expect(extractClosedIssues("Related to #99")).toEqual([]);
  });

  it("handles keyword at end of string with no trailing text", () => {
    expect(extractClosedIssues("This closes #1")).toEqual([1]);
  });

  it("handles multiline bodies", () => {
    const body = `## Summary
Implements feature X.

Closes #123
`;
    expect(extractClosedIssues(body)).toEqual([123]);
  });

  it("handles 'close' (present tense, no trailing s) variant", () => {
    expect(extractClosedIssues("This will close #99")).toEqual([99]);
  });
});

describe("hasClosingRef", () => {
  it("returns false for null/undefined/empty", () => {
    expect(hasClosingRef(null)).toBe(false);
    expect(hasClosingRef(undefined)).toBe(false);
    expect(hasClosingRef("")).toBe(false);
  });

  it("returns true when body contains Closes #N", () => {
    expect(hasClosingRef("Closes #42")).toBe(true);
  });

  it("returns true when body contains Fixes #N", () => {
    expect(hasClosingRef("Fixes #7")).toBe(true);
  });

  it("returns true when body contains Resolves #N", () => {
    expect(hasClosingRef("Resolves #55")).toBe(true);
  });

  it("returns false when body has no closing keyword", () => {
    expect(hasClosingRef("This is just a description")).toBe(false);
    expect(hasClosingRef("See #42 for context")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(hasClosingRef("CLOSES #10")).toBe(true);
    expect(hasClosingRef("FIXES #10")).toBe(true);
    expect(hasClosingRef("RESOLVES #10")).toBe(true);
  });
});
