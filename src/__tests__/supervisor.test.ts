import { describe, it, expect } from "vitest";
import { extractIssueRefs, isConcreteDispatch } from "../reviewer/supervisor.js";

describe("extractIssueRefs", () => {
  it("extracts a single issue ref", () => {
    expect(extractIssueRefs("Implement issue #42 from owner/repo")).toEqual([42]);
  });

  it("extracts multiple issue refs", () => {
    const refs = extractIssueRefs("Relates to #10 and also #20, see PR #30");
    expect(refs).toContain(10);
    expect(refs).toContain(20);
    expect(refs).toContain(30);
  });

  it("returns empty array when no refs found", () => {
    expect(extractIssueRefs("No issue reference here")).toEqual([]);
  });

  it("deduplicates repeated refs", () => {
    expect(extractIssueRefs("#5 and #5 again")).toEqual([5]);
  });
});

describe("isConcreteDispatch", () => {
  it("returns true for messages with issue refs", () => {
    expect(isConcreteDispatch("Please implement issue #42 from owner/repo")).toBe(true);
  });

  it("returns true for messages with concrete artifact keywords", () => {
    expect(isConcreteDispatch("Create file src/index.ts with the new routes")).toBe(true);
    expect(isConcreteDispatch("Open a PR for the authentication feature")).toBe(true);
    expect(isConcreteDispatch("Push branch issue-5-auth to origin")).toBe(true);
    expect(isConcreteDispatch("Implement the login endpoint")).toBe(true);
    expect(isConcreteDispatch("Fix the null pointer bug in src/server.ts")).toBe(true);
  });

  it("returns false for vague status-check messages", () => {
    expect(isConcreteDispatch("You are idle, please check for work")).toBe(false);
    expect(isConcreteDispatch("How is the system doing?")).toBe(false);
    expect(isConcreteDispatch("Report your current status")).toBe(false);
  });

  it("returns false for empty message", () => {
    expect(isConcreteDispatch("")).toBe(false);
  });

  it("is case-insensitive for keywords", () => {
    expect(isConcreteDispatch("IMPLEMENT the feature from #42")).toBe(true);
  });
});
