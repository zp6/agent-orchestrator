/**
 * Tests for standup-dispatch-guard — issue #255
 *
 * Verifies that `shouldSkipStandupDispatch` correctly invokes `onShortCircuit`
 * at the moment a zero-action standup task is short-circuited, eliminating
 * reliance on the Phase 3 backfill for score coverage.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import {
  shouldSkipStandupDispatch,
  looksLikeStandupTask,
  extractStandupIssueNumber,
} from "../reviewer/standup-dispatch-guard.js";

// Mock child_process so no real gh CLI calls are made
vi.mock("child_process");

// Mock logger
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

/** Build a minimal GitHub issue JSON that looks like a standup with N action items. */
function buildStandupIssueJson(actionItems: number): string {
  // extractActionItemCount looks for "### Action Items" (triple hash) and
  // bullets in "- [PRIORITY] description" format (not GH-style "- [ ]").
  const bullets = Array.from({ length: actionItems }, (_, i) =>
    `- [HIGH] Action item ${i + 1} (owner: team)`,
  ).join("\n");
  const body = actionItems > 0
    ? `### Action Items\n${bullets}`
    : `### Action Items\nNo action items.`;

  return JSON.stringify({
    number: 703,
    title: "[📋 Standup] Daily standup 2026-04-17",
    body,
    labels: [{ name: "standup" }],
    state: "OPEN",
  });
}

/** Build a non-standup issue JSON. */
function buildRegularIssueJson(): string {
  return JSON.stringify({
    number: 100,
    title: "Fix bug in API handler",
    body: "The handler throws when input is empty.",
    labels: [],
    state: "OPEN",
  });
}

// ── shouldSkipStandupDispatch — basic behavior ─────────────────────────────

describe("shouldSkipStandupDispatch — basic behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns skip=false when issue fetch fails", async () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("gh CLI error");
    });

    const result = await shouldSkipStandupDispatch("owner/repo", 703);
    expect(result.skip).toBe(false);
    expect(result.reason).toContain("Could not fetch issue");
  });

  it("returns skip=false for non-standup issues", async () => {
    execSyncMock.mockImplementationOnce(() => buildRegularIssueJson());

    const result = await shouldSkipStandupDispatch("owner/repo", 100);
    expect(result.skip).toBe(false);
    expect(result.reason).toContain("not a standup issue");
  });

  it("returns skip=false when action items > 0", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(3));
    // handleZeroActionStandup is not called, no extra gh calls

    const result = await shouldSkipStandupDispatch("owner/repo", 703);
    expect(result.skip).toBe(false);
    expect(result.actionItemCount).toBe(3);
  });

  it("returns skip=true for zero-action standup (autoClose=false to avoid gh calls)", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(0));
    // handleZeroActionStandup will try to post comment / close — mock those
    execSyncMock.mockImplementation(() => "{}"); // absorb any further gh calls

    const result = await shouldSkipStandupDispatch("owner/repo", 703, {
      autoClose: false,
    });
    expect(result.skip).toBe(true);
    expect(result.actionItemCount).toBe(0);
  });
});

// ── onShortCircuit callback (issue #255) ───────────────────────────────────

describe("shouldSkipStandupDispatch — onShortCircuit callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes onShortCircuit with 'no_action_needed' when zero-action standup skipped", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(0));
    execSyncMock.mockImplementation(() => "{}"); // absorb gh comment/close calls

    const onShortCircuit = vi.fn();

    const result = await shouldSkipStandupDispatch("owner/repo", 703, {
      taskId: "task-standup-703",
      onShortCircuit,
      autoClose: false,
    });

    expect(result.skip).toBe(true);
    expect(onShortCircuit).toHaveBeenCalledOnce();
    expect(onShortCircuit).toHaveBeenCalledWith(
      "task-standup-703",
      "no_action_needed",
      expect.stringContaining("0 action items"),
    );
  });

  it("does NOT invoke onShortCircuit when action items > 0", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(2));

    const onShortCircuit = vi.fn();

    const result = await shouldSkipStandupDispatch("owner/repo", 703, {
      taskId: "task-standup-703",
      onShortCircuit,
    });

    expect(result.skip).toBe(false);
    expect(onShortCircuit).not.toHaveBeenCalled();
  });

  it("does NOT invoke onShortCircuit when taskId is missing", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(0));
    execSyncMock.mockImplementation(() => "{}");

    const onShortCircuit = vi.fn();

    await shouldSkipStandupDispatch("owner/repo", 703, {
      onShortCircuit, // no taskId
      autoClose: false,
    });

    expect(onShortCircuit).not.toHaveBeenCalled();
  });

  it("still returns correct result if onShortCircuit throws", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(0));
    execSyncMock.mockImplementation(() => "{}");

    const onShortCircuit = vi.fn().mockImplementationOnce(() => {
      throw new Error("scoring failure");
    });

    // Should NOT throw — scoring errors must be swallowed
    const result = await shouldSkipStandupDispatch("owner/repo", 703, {
      taskId: "task-err",
      onShortCircuit,
      autoClose: false,
    });

    expect(result.skip).toBe(true);
    expect(result.actionItemCount).toBe(0);
  });

  it("works without opts — backward-compatible with zero-arg call", async () => {
    execSyncMock.mockImplementationOnce(() => buildStandupIssueJson(1));

    // No opts at all — must not throw
    const result = await shouldSkipStandupDispatch("owner/repo", 703);
    expect(result.skip).toBe(false); // 1 action item → dispatch normally
  });
});

// ── looksLikeStandupTask ───────────────────────────────────────────────────

describe("looksLikeStandupTask", () => {
  it("returns true for titles containing 'standup'", () => {
    expect(looksLikeStandupTask("[📋 Standup] Daily")).toBe(true);
    expect(looksLikeStandupTask("Weekly standup report")).toBe(true);
  });

  it("returns true for standup: source refs", () => {
    expect(looksLikeStandupTask("", "standup:703")).toBe(true);
  });

  it("returns false for regular tasks", () => {
    expect(looksLikeStandupTask("Fix bug in API", "github-issue:owner/repo#42")).toBe(false);
  });
});

// ── extractStandupIssueNumber ──────────────────────────────────────────────

describe("extractStandupIssueNumber", () => {
  it("extracts from standup: format", () => {
    expect(extractStandupIssueNumber("standup:703")).toBe(703);
  });

  it("extracts from github-issue: format", () => {
    expect(extractStandupIssueNumber("github-issue:owner/repo#703")).toBe(703);
  });

  it("extracts from bare #N format", () => {
    expect(extractStandupIssueNumber("#42")).toBe(42);
  });

  it("returns null for unknown format", () => {
    expect(extractStandupIssueNumber("unknown-format")).toBeNull();
    expect(extractStandupIssueNumber(null)).toBeNull();
  });
});
