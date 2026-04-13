import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchIssueRef,
  extractConflictHunks,
  listChangedFiles,
  buildConflictRedispatchMessage,
} from "./conflict-redispatch.js";

// Mock child_process so tests never invoke the real `gh` CLI
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExec = vi.mocked(execSync);

// Minimal stub logger so createLogger doesn't blow up
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const SAMPLE_DIFF = [
  "diff --git a/src/orchestrator/dispatcher.ts b/src/orchestrator/dispatcher.ts",
  "index abc1234..def5678 100644",
  "--- a/src/orchestrator/dispatcher.ts",
  "+++ b/src/orchestrator/dispatcher.ts",
  "@@ -10,6 +10,8 @@ import { foo } from './foo.js';",
  " context line A",
  "+added line 1",
  "+added line 2",
  " context line B",
  "diff --git a/src/service/daemon.ts b/src/service/daemon.ts",
  "--- a/src/service/daemon.ts",
  "+++ b/src/service/daemon.ts",
  "@@ -20,3 +20,4 @@ export class Daemon {",
  " existing line",
  "+new daemon line",
].join("\n");

describe("fetchIssueRef", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("returns title and body when gh succeeds", () => {
    mockExec.mockReturnValue(
      JSON.stringify({ title: "Add foo feature", body: "Details about foo" }),
    );
    const ref = fetchIssueRef("owner/repo", 42);
    expect(ref.title).toBe("Add foo feature");
    expect(ref.body).toBe("Details about foo");
    expect(mockExec).toHaveBeenCalledWith(
      "gh issue view 42 --repo owner/repo --json title,body",
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns empty strings when gh fails (non-fatal)", () => {
    mockExec.mockImplementation(() => { throw new Error("gh: not found"); });
    const ref = fetchIssueRef("owner/repo", 99);
    expect(ref.title).toBe("");
    expect(ref.body).toBe("");
  });

  it("handles empty body gracefully", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "No body", body: null }));
    const ref = fetchIssueRef("owner/repo", 1);
    expect(ref.body).toBe("");
  });
});

describe("extractConflictHunks", () => {
  it("returns empty string for empty input", () => {
    expect(extractConflictHunks("")).toBe("");
    expect(extractConflictHunks("   ")).toBe("");
  });

  it("preserves diff/file-header lines without counting them toward cap", () => {
    const out = extractConflictHunks(SAMPLE_DIFF, 200);
    expect(out).toContain("diff --git a/src/orchestrator/dispatcher.ts");
    expect(out).toContain("--- a/src/orchestrator/dispatcher.ts");
    expect(out).toContain("+++ b/src/orchestrator/dispatcher.ts");
    expect(out).toContain("@@ -10,6 +10,8 @@");
  });

  it("includes content lines", () => {
    const out = extractConflictHunks(SAMPLE_DIFF, 200);
    expect(out).toContain("+added line 1");
    expect(out).toContain("+added line 2");
  });

  it("truncates content lines at maxLines and appends truncation notice", () => {
    const out = extractConflictHunks(SAMPLE_DIFF, 2);
    expect(out).toContain("… (diff truncated at 2 lines)");
  });

  it("does not truncate when content is within maxLines", () => {
    const out = extractConflictHunks(SAMPLE_DIFF, 1000);
    expect(out).not.toContain("truncated");
  });
});

describe("listChangedFiles", () => {
  it("extracts unique file paths from +++ b/ lines", () => {
    const files = listChangedFiles(SAMPLE_DIFF);
    expect(files).toContain("src/orchestrator/dispatcher.ts");
    expect(files).toContain("src/service/daemon.ts");
  });

  it("deduplicates repeated file paths", () => {
    const dupDiff = [SAMPLE_DIFF, SAMPLE_DIFF].join("\n");
    const files = listChangedFiles(dupDiff);
    expect(files.filter((f) => f === "src/orchestrator/dispatcher.ts").length).toBe(1);
  });

  it("returns empty array for empty diff", () => {
    expect(listChangedFiles("")).toEqual([]);
  });
});

describe("buildConflictRedispatchMessage", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("includes ## Conflict Context section with branch and PR number", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "Add feature", body: "Implement X" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 123,
      prBranch: "issue-810-add-feature",
      issueNum: 810,
      prDiff: SAMPLE_DIFF,
    });

    expect(msg).toContain("## Conflict Context");
    expect(msg).toContain("`issue-810-add-feature`");
    expect(msg).toContain("PR #123");
  });

  it("embeds the original issue spec", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "Add feature", body: "Implement X in detail" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 10,
      prBranch: "issue-5-add-feature",
      issueNum: 5,
      prDiff: SAMPLE_DIFF,
    });

    expect(msg).toContain("## Original Issue Spec");
    expect(msg).toContain("Add feature");
    expect(msg).toContain("Implement X in detail");
  });

  it("includes changed file list when prDiff is provided", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "T", body: "B" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
      prDiff: SAMPLE_DIFF,
    });

    expect(msg).toContain("src/orchestrator/dispatcher.ts");
    expect(msg).toContain("src/service/daemon.ts");
  });

  it("includes diff code block when prDiff is provided", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "T", body: "B" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
      prDiff: SAMPLE_DIFF,
    });

    expect(msg).toContain("```diff");
  });

  it("shows graceful fallback when prDiff is empty", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "T", body: "B" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
      prDiff: "",
    });

    expect(msg).toContain("Diff not available");
    expect(msg).not.toContain("```diff");
  });

  it("uses pre-loaded issueRef without calling gh", () => {
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 7,
      prBranch: "issue-2-y",
      issueNum: 2,
      prDiff: "",
      issueRef: { title: "Pre-loaded title", body: "Pre-loaded body" },
    });

    expect(mockExec).not.toHaveBeenCalled();
    expect(msg).toContain("Pre-loaded title");
    expect(msg).toContain("Pre-loaded body");
  });

  it("includes resolution approach with clean-start instructions", () => {
    mockExec.mockReturnValue(JSON.stringify({ title: "T", body: "B" }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
    });

    expect(msg).toContain("## Resolution Approach");
    expect(msg).toContain("git checkout main");
    expect(msg).toContain("Closes #1");
  });

  it("truncates issue body longer than 2000 characters", () => {
    const longBody = "x".repeat(3000);
    mockExec.mockReturnValue(JSON.stringify({ title: "T", body: longBody }));
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
    });

    expect(msg).toContain("(truncated)");
    // Ensure the full 3000-char body isn't present (it's been truncated)
    expect(msg.includes(longBody)).toBe(false);
  });

  it("handles gh failure gracefully (still includes Conflict Context)", () => {
    mockExec.mockImplementation(() => { throw new Error("gh: command not found"); });
    const msg = buildConflictRedispatchMessage({
      repo: "owner/repo",
      prNumber: 5,
      prBranch: "issue-1-x",
      issueNum: 1,
    });

    // Must still include the Conflict Context section
    expect(msg).toContain("## Conflict Context");
    expect(msg).toContain("## Resolution Approach");
  });
});
