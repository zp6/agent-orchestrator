import { describe, it, expect, vi } from "vitest";
import { fetchOpenIssues, findExistingPRsForIssue } from "./github.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

describe("fetchOpenIssues", () => {
  it("parses GitHub issues from gh CLI output", () => {
    mockExecSync.mockReturnValue(JSON.stringify([
      { number: 1, title: "Bug fix", body: "Fix the bug", url: "https://github.com/owner/repo/issues/1", labels: ["bug"] },
      { number: 2, title: "Feature", body: null, url: "https://github.com/owner/repo/issues/2", labels: [] },
    ]));

    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({
      repo: "owner/repo",
      number: 1,
      title: "Bug fix",
      body: "Fix the bug",
      url: "https://github.com/owner/repo/issues/1",
      labels: ["bug"],
    });
    expect(issues[1].body).toBe("");
  });

  it("returns empty array when no issues", () => {
    mockExecSync.mockReturnValue("[]");
    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(0);
  });

  it("handles empty output", () => {
    mockExecSync.mockReturnValue("");
    const issues = fetchOpenIssues("owner/repo");
    expect(issues).toHaveLength(0);
  });

  it("throws on gh CLI failure", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    expect(() => fetchOpenIssues("owner/repo")).toThrow("Failed to fetch issues");
  });

  it("passes correct repo to gh CLI", () => {
    mockExecSync.mockReturnValue("[]");
    fetchOpenIssues("rapartlu/claude-proxy");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/claude-proxy/issues"),
      expect.any(Object),
    );
  });
});

describe("findExistingPRsForIssue", () => {
  // execSync is called twice: once for open PRs, once for merged PRs
  function mockPRCalls(
    openPRs: Array<{ number: number; title: string; url: string; isDraft: boolean; body: string | null }>,
    mergedPRs: Array<{ number: number; title: string; url: string; body: string | null }>,
  ): void {
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(openPRs))
      .mockReturnValueOnce(JSON.stringify(mergedPRs));
  }

  it("returns empty array when no PRs reference the issue", () => {
    mockPRCalls(
      [{ number: 10, title: "Unrelated PR", url: "https://github.com/owner/repo/pull/10", isDraft: false, body: "This does something else" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("detects an open PR with 'Closes #N' in the body", () => {
    mockPRCalls(
      [{ number: 5, title: "Fix the bug", url: "https://github.com/owner/repo/pull/5", isDraft: false, body: "Closes #42\nFixed the issue." }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 5, state: "open", isDraft: false });
  });

  it("detects a draft PR with 'Closes #N' in the body", () => {
    mockPRCalls(
      [{ number: 7, title: "WIP fix", url: "https://github.com/owner/repo/pull/7", isDraft: true, body: "Work in progress\n\nCloses #42" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 7, state: "open", isDraft: true });
  });

  it("detects a merged PR with 'Fixes #N' in the body", () => {
    mockPRCalls(
      [],
      [{ number: 3, title: "Merged fix", url: "https://github.com/owner/repo/pull/3", body: "Fixes #42 by refactoring." }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 3, state: "merged", isDraft: false });
  });

  it("matches closing keywords case-insensitively", () => {
    const bodies = [
      "CLOSES #42",
      "Fixes #42",
      "RESOLVES #42",
      "closed #42",
      "fixed #42",
      "resolved #42",
    ];
    for (const body of bodies) {
      mockExecSync
        .mockReturnValueOnce(JSON.stringify([{ number: 1, title: "PR", url: "url", isDraft: false, body }]))
        .mockReturnValueOnce("[]");
      const prs = findExistingPRsForIssue("owner/repo", 42);
      expect(prs).toHaveLength(1);
    }
  });

  it("does NOT match a PR that only mentions the issue without a closing keyword", () => {
    mockPRCalls(
      [{ number: 8, title: "Related work", url: "url", isDraft: false, body: "See issue #42 for context. Does not close it." }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("does NOT match a different issue number (e.g. #420 vs #42)", () => {
    mockPRCalls(
      [{ number: 9, title: "Other fix", url: "url", isDraft: false, body: "Closes #420" }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns both open and merged PRs when both exist", () => {
    mockPRCalls(
      [{ number: 5, title: "Open PR", url: "url1", isDraft: false, body: "Closes #42" }],
      [{ number: 3, title: "Merged PR", url: "url2", body: "Fixes #42" }],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(2);
    expect(prs.map((p) => p.state)).toContain("open");
    expect(prs.map((p) => p.state)).toContain("merged");
  });

  it("returns empty array when gh CLI fails (fail-open)", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("returns empty array when gh output is empty", () => {
    mockExecSync.mockReturnValueOnce("").mockReturnValueOnce("");
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });

  it("queries the correct repo in gh API calls", () => {
    mockPRCalls([], []);
    findExistingPRsForIssue("rapartlu/my-agent", 99);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("repos/rapartlu/my-agent/pulls"),
      expect.any(Object),
    );
  });

  it("handles null PR body gracefully", () => {
    mockPRCalls(
      [{ number: 11, title: "No body", url: "url", isDraft: false, body: null }],
      [],
    );
    const prs = findExistingPRsForIssue("owner/repo", 42);
    expect(prs).toHaveLength(0);
  });
});
