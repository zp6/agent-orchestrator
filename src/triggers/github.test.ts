import { describe, it, expect, vi } from "vitest";
import { fetchOpenIssues } from "./github.js";

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
