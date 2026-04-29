/**
 * Tests for the post-completion PR verifier (issue #1306).
 *
 * Covers:
 *  1. parseGitHubIssueRef — valid refs, invalid refs, edge cases
 *  2. responseContainsPRSignal — common PR creation signals in agent output
 *  3. verifyPRCreated — skips for non-implementation tasks
 *  4. verifyPRCreated — skips when source_ref is not a GitHub issue ref
 *  5. verifyPRCreated — fast path: response text contains PR signal
 *  6. verifyPRCreated — PR found via GitHub API → stays "done"
 *  7. verifyPRCreated — no PR found → task re-marked "failed"
 *  8. verifyPRCreated — GitHub API error → non-fatal, preserves "done"
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  parseGitHubIssueRef,
  responseContainsPRSignal,
  verifyPRCreated,
} from "../orchestrator/pr-completion-verifier.js";
import type { Task } from "../state/types.js";
import type { StateStore } from "../state/store.js";

// ── Mock findExistingPRsForIssue ────────────────────────────────────────────��─

vi.mock("../triggers/github.js", () => ({
  findExistingPRsForIssue: vi.fn(),
}));

import { findExistingPRsForIssue } from "../triggers/github.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-001",
    title: "Implement feature X",
    status: "done",
    task_type: "implementation",
    source_ref: "owner/repo#42",
    agent_name: "test-agent",
    ...overrides,
  } as Task;
}

function makeStore(overrides: Partial<StateStore> = {}): StateStore {
  return {
    updateTask: vi.fn(),
    ...overrides,
  } as unknown as StateStore;
}

// ── parseGitHubIssueRef ───────────────────────────────────────────────────────

describe("parseGitHubIssueRef", () => {
  it("parses a standard owner/repo#N ref", () => {
    expect(parseGitHubIssueRef("owner/repo#42")).toEqual({ repo: "owner/repo", issueNumber: 42 });
  });

  it("parses a repo with hyphens and numbers", () => {
    expect(parseGitHubIssueRef("rapartlu/agent-orchestrator#1306")).toEqual({
      repo: "rapartlu/agent-orchestrator",
      issueNumber: 1306,
    });
  });

  it("returns null for null input", () => {
    expect(parseGitHubIssueRef(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseGitHubIssueRef(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGitHubIssueRef("")).toBeNull();
  });

  it("returns null for a Linear ref (no slash before #)", () => {
    expect(parseGitHubIssueRef("linear-check:agent:2026-01-01T00")).toBeNull();
  });

  it("returns null when # is at position 0", () => {
    expect(parseGitHubIssueRef("#42")).toBeNull();
  });

  it("returns null when there is no slash in the repo part", () => {
    expect(parseGitHubIssueRef("repo#42")).toBeNull();
  });

  it("returns null when issue number is not a valid integer", () => {
    expect(parseGitHubIssueRef("owner/repo#abc")).toBeNull();
  });

  it("returns null when issue number is zero", () => {
    expect(parseGitHubIssueRef("owner/repo#0")).toBeNull();
  });

  it("returns null when issue number is negative", () => {
    expect(parseGitHubIssueRef("owner/repo#-5")).toBeNull();
  });
});

// ── responseContainsPRSignal ──────────────────────────────────────────────────

describe("responseContainsPRSignal", () => {
  it("detects a GitHub pull URL", () => {
    expect(
      responseContainsPRSignal("Done! https://github.com/owner/repo/pull/123"),
    ).toBe(true);
  });

  it("detects 'PR #N created'", () => {
    expect(responseContainsPRSignal("PR #456 created successfully.")).toBe(true);
  });

  it("detects 'opened PR'", () => {
    expect(responseContainsPRSignal("I opened a PR for review.")).toBe(true);
  });

  it("detects 'pull request #N'", () => {
    expect(responseContainsPRSignal("Submitted pull request #789.")).toBe(true);
  });

  it("detects 'gh pr create' command output", () => {
    expect(responseContainsPRSignal("Running: gh pr create --title ...")).toBe(true);
  });

  it("returns false for 'tests pass, build succeeds' without PR signal", () => {
    expect(
      responseContainsPRSignal(
        "All done. tests pass, build succeeds. No errors.",
      ),
    ).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(responseContainsPRSignal("")).toBe(false);
  });

  it("is case-insensitive for PR URL detection", () => {
    expect(
      responseContainsPRSignal("See: HTTPS://GITHUB.COM/owner/repo/pull/99"),
    ).toBe(true);
  });
});

// ── verifyPRCreated ───────────────────────────────────────────────────────────

describe("verifyPRCreated", () => {
  beforeEach(() => {
    vi.mocked(findExistingPRsForIssue).mockReset();
  });

  // ── Skip conditions ─────────────────────────────────────────────────────────

  it("skips for research tasks", () => {
    const task = makeTask({ task_type: "research" });
    const store = makeStore();
    const result = verifyPRCreated(task, store);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("research");
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(findExistingPRsForIssue).not.toHaveBeenCalled();
  });

  it("skips when source_ref is null", () => {
    const task = makeTask({ source_ref: null });
    const store = makeStore();
    const result = verifyPRCreated(task, store);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("(none)");
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(findExistingPRsForIssue).not.toHaveBeenCalled();
  });

  it("skips when source_ref is a Linear ref", () => {
    const task = makeTask({ source_ref: "linear-check:agent:2026-01-01T00" });
    const store = makeStore();
    const result = verifyPRCreated(task, store);
    expect(result.skipped).toBe(true);
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(findExistingPRsForIssue).not.toHaveBeenCalled();
  });

  // ── Fast path ───────────────────────────────────────────────────────────────

  it("returns prFound=true via fast path when response contains a GitHub PR URL", () => {
    const task = makeTask();
    const store = makeStore();
    const responseText = "All done! https://github.com/owner/repo/pull/99";
    const result = verifyPRCreated(task, store, responseText);
    expect(result.skipped).toBe(false);
    expect(result.prFound).toBe(true);
    // GitHub API should NOT have been called (fast path)
    expect(findExistingPRsForIssue).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  // ── GitHub API found ────────────────────────────────────────────────────────

  it("returns prFound=true and leaves task done when PR exists in GitHub", () => {
    vi.mocked(findExistingPRsForIssue).mockReturnValue([
      {
        number: 101,
        title: "Fix issue #42",
        url: "https://github.com/owner/repo/pull/101",
        state: "open",
        isDraft: false,
        detectionStrategy: "body_keyword",
      },
    ]);

    const task = makeTask();
    const store = makeStore();
    const result = verifyPRCreated(task, store, "tests pass, build succeeds");

    expect(result.skipped).toBe(false);
    expect(result.prFound).toBe(true);
    expect(result.prNumber).toBe(101);
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/101");
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(findExistingPRsForIssue).toHaveBeenCalledWith("owner/repo", 42);
  });

  // ── No PR found ─────────────────────────────────────────────────────────────

  it("marks task failed and returns prFound=false when no PR exists", () => {
    vi.mocked(findExistingPRsForIssue).mockReturnValue([]);

    const task = makeTask();
    const store = makeStore();
    const result = verifyPRCreated(task, store, "All done. tests pass, build succeeds.");

    expect(result.skipped).toBe(false);
    expect(result.prFound).toBe(false);
    expect(result.lookupError).toBeUndefined();

    // Task must be re-marked failed
    expect(store.updateTask).toHaveBeenCalledWith("task-001", {
      status: "failed",
      result: expect.stringContaining("NO PR was created"),
    });

    // Error message must reference the cause and issue link
    const [, updates] = vi.mocked(store.updateTask).mock.calls[0];
    expect(updates.result).toContain("owner/repo#42");
    expect(updates.result).toContain("#1252");
  });

  it("includes the agent name in the failure message", () => {
    vi.mocked(findExistingPRsForIssue).mockReturnValue([]);

    const task = makeTask({ agent_name: "revenue-rails-agent" });
    const store = makeStore();
    verifyPRCreated(task, store, "tests pass");

    const [, updates] = vi.mocked(store.updateTask).mock.calls[0];
    expect(updates.result).toContain("revenue-rails-agent");
  });

  // ── GitHub API error ────────────────────────────────────────────────────────

  it("is non-fatal when GitHub lookup throws — preserves done status", () => {
    vi.mocked(findExistingPRsForIssue).mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const task = makeTask();
    const store = makeStore();
    const result = verifyPRCreated(task, store, "tests pass");

    expect(result.skipped).toBe(false);
    expect(result.prFound).toBe(false);
    expect(result.lookupError).toContain("gh: command not found");
    // Must NOT mark the task failed — error is non-fatal
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
