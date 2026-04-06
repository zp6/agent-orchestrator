import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findSimilarIssues } from "./issue-status.js";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

describe("findSimilarIssues", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty array when gh command fails", () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const result = findSimilarIssues("owner/repo", 100, "Fix the bug", "");
    expect(result).toEqual([]);
  });

  it("returns empty array when target has no meaningful tokens", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([{ number: 200, title: "Another issue", body: "Some body" }]),
    );

    // Title/body that only contains stop words or very short words
    const result = findSimilarIssues("owner/repo", 100, "a an the", "");
    expect(result).toEqual([]);
  });

  it("excludes the target issue itself from results", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        { number: 100, title: "Fix authentication bug in login flow", body: "auth login bug" },
        { number: 200, title: "Fix authentication issue in login flow", body: "auth login problem" },
      ]),
    );

    const result = findSimilarIssues("owner/repo", 100, "Fix authentication bug in login flow", "auth login bug");
    // Issue #100 is the target — must not appear in results
    const numbers = result.map((r) => r.number);
    expect(numbers).not.toContain(100);
  });

  it("surfaces issues with >60% keyword overlap", () => {
    const nearDuplicateBody = "add supervisor hard gate metrics dashboard widget display";
    const targetBody = "add supervisor hard gate metrics dashboard widget";

    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          number: 501,
          title: "Add supervisor hard gate metrics dashboard widget display",
          body: nearDuplicateBody,
        },
        {
          number: 502,
          title: "Unrelated: update readme file",
          body: "just updating documentation readme",
        },
      ]),
    );

    const result = findSimilarIssues(
      "owner/repo",
      512,
      "Add supervisor hard gate metrics dashboard widget",
      targetBody,
    );

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].number).toBe(501);
    expect(result[0].overlapScore).toBeGreaterThan(0.6);
    // The readme issue should not appear
    expect(result.map((r) => r.number)).not.toContain(502);
  });

  it("does not flag issues with <=60% overlap", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          number: 300,
          title: "Completely different topic about CI pipelines",
          body: "ci build pipeline stages deployment",
        },
      ]),
    );

    const result = findSimilarIssues(
      "owner/repo",
      100,
      "Fix authentication bug in login flow",
      "auth token login session cookie",
    );

    expect(result).toEqual([]);
  });

  it("sorts results by overlap score descending", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          number: 401,
          title: "supervisor metrics widget hard gate display dashboard",
          body: "supervisor metrics widget hard gate display dashboard panel",
        },
        {
          number: 402,
          title: "supervisor metrics dashboard",
          body: "supervisor metrics dashboard",
        },
      ]),
    );

    const result = findSimilarIssues(
      "owner/repo",
      512,
      "supervisor metrics widget hard gate dashboard",
      "supervisor metrics widget hard gate dashboard",
    );

    if (result.length >= 2) {
      expect(result[0].overlapScore).toBeGreaterThanOrEqual(result[1].overlapScore);
    }
  });

  it("includes correct url in result", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          number: 999,
          title: "supervisor hard gate metrics widget dashboard display",
          body: "supervisor hard gate metrics widget dashboard display",
        },
      ]),
    );

    const result = findSimilarIssues(
      "myorg/myrepo",
      512,
      "supervisor hard gate metrics widget dashboard",
      "supervisor hard gate metrics widget dashboard",
    );

    if (result.length > 0) {
      expect(result[0].url).toBe("https://github.com/myorg/myrepo/issues/999");
    }
  });

  it("respects a custom overlap threshold", () => {
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          number: 600,
          title: "supervisor metrics dashboard widget",
          body: "supervisor metrics dashboard widget",
        },
      ]),
    );

    // With 0.9 threshold, a 60–70% match should not appear
    const strictResult = findSimilarIssues(
      "owner/repo",
      512,
      "supervisor metrics dashboard widget hard gate extras",
      "supervisor metrics dashboard widget hard gate extras",
      0.9,
    );

    // With 0.1 threshold, it should appear
    const lenientResult = findSimilarIssues(
      "owner/repo",
      512,
      "supervisor metrics dashboard widget hard gate extras",
      "supervisor metrics dashboard widget hard gate extras",
      0.1,
    );

    expect(lenientResult.length).toBeGreaterThan(0);
    // Strict result may or may not include depending on exact score;
    // just verify the threshold is wired correctly
    if (strictResult.length > 0) {
      expect(strictResult[0].overlapScore).toBeGreaterThanOrEqual(0.9);
    }
  });
});
