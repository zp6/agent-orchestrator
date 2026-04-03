import { describe, it, expect } from "vitest";
import { extractClosedIssueNumbers } from "./daemon.js";

describe("extractClosedIssueNumbers", () => {
  it("extracts Closes #N", () => {
    expect(extractClosedIssueNumbers("Closes #42")).toEqual([42]);
  });

  it("extracts Fixes #N", () => {
    expect(extractClosedIssueNumbers("Fixes #7")).toEqual([7]);
  });

  it("extracts Resolves #N", () => {
    expect(extractClosedIssueNumbers("Resolves #100")).toEqual([100]);
  });

  it("is case-insensitive", () => {
    expect(extractClosedIssueNumbers("closes #1\nFIXES #2\nResolves #3")).toEqual([1, 2, 3]);
  });

  it("extracts multiple refs from one body", () => {
    expect(extractClosedIssueNumbers("Closes #10\nAlso fixes #20")).toEqual([10, 20]);
  });

  it("deduplicates", () => {
    expect(extractClosedIssueNumbers("Closes #5\nAlso closes #5")).toEqual([5]);
  });

  it("returns empty array when no refs", () => {
    expect(extractClosedIssueNumbers("No issue references here")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractClosedIssueNumbers("")).toEqual([]);
  });

  it("handles refs inline with other text", () => {
    expect(extractClosedIssueNumbers("This PR closes #42 and fixes #43.")).toEqual([42, 43]);
  });
});
