import { describe, it, expect, beforeEach, vi } from "vitest";
import { execSync } from "child_process";
import {
  isStandupIssue,
  extractActionItemCount,
  extractPRReferences,
  buildStandupAcknowledgmentComment,
  handleZeroActionStandup,
  isSynthesisFailed,
  generateFallbackActionItems,
  postFallbackActionItems,
  detectSynthesisLabel,
  applyGitHubSynthesisLabel,
  checkAndEscalateFallbackThreshold,
  type GitHubIssue,
} from "../reviewer/standup-handler.js";

// Mock execSync for testing
vi.mock("child_process");

// ── Test Helpers ──────────────────────────────────────────────────────────

function makeStandupIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 695,
    title: "[📋 Standup] 2026-04-12 — 3 action items",
    body: `## 📋 Standup — 2026-04-12

### Synthesis
Steady progress on PR review automation. Core validation logic is solid.

### Action Items
- [HIGH] Merge calibration PRs #681 and #685 (owner: orchestrator)
- [MEDIUM] Deploy token instrumentation (owner: reviewer)
- [LOW] Update docs for new schema detection (owner: reviewer)

### Goal Adjustments
No adjustments proposed.`,
    labels: ["team-meeting", "standup"],
    state: "open",
    ...overrides,
  };
}

function makeZeroActionStandup(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return makeStandupIssue({
    title: "[📋 Standup] 2026-04-12 — 0 action items",
    body: `## 📋 Standup — 2026-04-12

### Synthesis
All systems running smoothly. No blockers identified.

### Action Items
No action items.

### Goal Adjustments
No adjustments proposed.`,
    ...overrides,
  });
}

// ── isStandupIssue ────────────────────────────────────────────────────────

describe("isStandupIssue", () => {
  it("detects standup by label", () => {
    const issue = makeStandupIssue({
      title: "Some random issue",
      labels: ["bug", "standup"],
      body: "Random content",
    });
    expect(isStandupIssue(issue)).toBe(true);
  });

  it("detects standup by team-meeting label", () => {
    const issue = makeStandupIssue({
      title: "Some random issue",
      labels: ["team-meeting"],
      body: "Random content",
    });
    expect(isStandupIssue(issue)).toBe(true);
  });

  it("detects standup by title pattern", () => {
    const issue = makeStandupIssue({
      title: "[📋 Standup] 2026-04-12 — 5 action items",
      labels: ["random"],
      body: "Random content",
    });
    expect(isStandupIssue(issue)).toBe(true);
  });

  it("detects blue sky session by title", () => {
    const issue = makeStandupIssue({
      title: "[🚀 Blue Sky] 2026-04-13 — creative session",
      labels: [],
      body: "Random content",
    });
    expect(isStandupIssue(issue)).toBe(true);
  });

  it("detects standup by body format (Action Items section)", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Random issue",
      body: "Some content\n### Action Items\naction 1\naction 2",
      labels: [],
      state: "open",
    };
    expect(isStandupIssue(issue)).toBe(true);
  });

  it("rejects non-standup issue", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Fix login bug",
      body: "Login is broken on mobile",
      labels: ["bug"],
      state: "open",
    };
    expect(isStandupIssue(issue)).toBe(false);
  });
});

// ── extractActionItemCount ────────────────────────────────────────────────

describe("extractActionItemCount", () => {
  it("extracts count from title", () => {
    const issue = makeStandupIssue({
      title: "[📋 Standup] 2026-04-12 — 3 action items",
    });
    expect(extractActionItemCount(issue)).toBe(3);
  });

  it("extracts zero from title", () => {
    const issue = makeZeroActionStandup({
      title: "[📋 Standup] 2026-04-12 — 0 action items",
    });
    expect(extractActionItemCount(issue)).toBe(0);
  });

  it("counts action items from body", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Some title",
      body: `### Action Items
- [HIGH] Item 1
- [MEDIUM] Item 2
- [LOW] Item 3`,
      labels: [],
      state: "open",
    };
    expect(extractActionItemCount(issue)).toBe(3);
  });

  it("detects no action items text", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Some title",
      body: `### Action Items
No action items.`,
      labels: [],
      state: "open",
    };
    expect(extractActionItemCount(issue)).toBe(0);
  });

  it("handles multi-word priority labels", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Some title",
      body: `### Action Items
- [HIGH PRIORITY] Item 1
- [MEDIUM] Item 2`,
      labels: [],
      state: "open",
    };
    // Should still count 2 (both have - [ at start)
    expect(extractActionItemCount(issue)).toBe(2);
  });

  it("returns -1 if unable to parse", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Some random title",
      body: "No action items section here",
      labels: [],
      state: "open",
    };
    expect(extractActionItemCount(issue)).toBe(-1);
  });
});

// ── extractPRReferences ───────────────────────────────────────────────────

describe("extractPRReferences", () => {
  it("extracts single PR reference", () => {
    const body = "Closes #123";
    expect(extractPRReferences(body)).toEqual([123]);
  });

  it("extracts multiple PR references", () => {
    const body = "Closes #681 and #682. Also related to #700";
    expect(extractPRReferences(body)).toEqual([681, 682, 700]);
  });

  it("deduplicates PR references", () => {
    const body = "See #100, #200, and #100 again";
    expect(extractPRReferences(body)).toEqual([100, 200]);
  });

  it("returns empty array if no references", () => {
    const body = "This issue has no PR references";
    expect(extractPRReferences(body)).toEqual([]);
  });

  it("handles PR references in various contexts", () => {
    const body = `
### Related PRs
- PR #1
- PR #2

### Blockers
Issue #50 is blocking this

### Action Items
- Merge #100
- Close #101`;
    expect(extractPRReferences(body)).toEqual([1, 2, 50, 100, 101]);
  });

  it("sorts PR references numerically", () => {
    const body = "#200 #100 #300";
    expect(extractPRReferences(body)).toEqual([100, 200, 300]);
  });
});

// ── buildStandupAcknowledgmentComment ──────────────────────────────────

describe("buildStandupAcknowledgmentComment", () => {
  it("builds comment for zero-action standup", () => {
    const issue = makeZeroActionStandup();
    const comment = buildStandupAcknowledgmentComment(issue);

    expect(comment).toContain("[orchestrator] Standup acknowledged");
    expect(comment).toContain("All systems running smoothly");
    expect(comment).toContain("has no action items");
    expect(comment).toContain("No PR will be created");
  });

  it("includes synthesis in comment", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Major achievement this cycle: completed core feature.

### Action Items
No action items.`,
    });
    const comment = buildStandupAcknowledgmentComment(issue);
    expect(comment).toContain("Major achievement");
  });

  it("truncates long synthesis to 500 chars", () => {
    const longSynthesis = "This is a very long synthesis. " + "x".repeat(500);
    const issue = makeZeroActionStandup({
      body: `### Synthesis
${longSynthesis}

### Action Items
No action items.`,
    });
    const comment = buildStandupAcknowledgmentComment(issue);
    expect(comment).toContain("...");
    expect(comment.length).toBeLessThan(longSynthesis.length + 200);
  });

  it("includes blockers section if present", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
All good.

### Action Items
No action items.

## Blockers
- Waiting on PR #100 to merge`,
    });
    const comment = buildStandupAcknowledgmentComment(issue);
    expect(comment).toContain("Blockers:");
    expect(comment).toContain("Waiting on PR #100");
  });

  it("skips blockers section if empty or none", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
All good.

### Action Items
No action items.

## Blockers
No blockers.`,
    });
    const comment = buildStandupAcknowledgmentComment(issue);
    // Should not include "No blockers" text
    expect(comment).not.toContain("No blockers");
  });

  it("includes goal adjustments if present", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Making progress.

### Action Items
No action items.

### Goal Adjustments
- Focus more on testing
- Add performance metrics`,
    });
    const comment = buildStandupAcknowledgmentComment(issue);
    expect(comment).toContain("Goal Adjustments:");
    expect(comment).toContain("Focus more on testing");
  });

  it("produces valid markdown comment", () => {
    const issue = makeZeroActionStandup();
    const comment = buildStandupAcknowledgmentComment(issue);

    // Basic markdown validation
    expect(comment).toContain("**");
    expect(comment).not.toMatch(/\n{3,}/); // No excessive newlines
    expect(comment.length).toBeGreaterThan(50);
  });
});

// ── handleZeroActionStandup ───────────────────────────────────────────────

describe("handleZeroActionStandup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue("");
  });

  it("posts acknowledgment comment", async () => {
    const issue = makeZeroActionStandup();
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, false);

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue comment 100"),
      expect.any(Object),
    );
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("rapartlu/test-repo"),
      expect.any(Object),
    );
  });

  it("calls closeResolvedStandup when autoClose=true", async () => {
    const issue = makeZeroActionStandup({
      body: `### Action Items
No action items.

Related PRs: #100`,
    });

    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, true);

    // Should have called gh to check PR status
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh pr view"),
      expect.any(Object),
    );
  });

  it("skips autoClose when autoClose=false", async () => {
    const issue = makeZeroActionStandup({
      body: `### Action Items
No action items.

Closes #200`,
    });

    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();

    // Allow the comment call and synthesis label stamping calls, but not PR checks
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue comment")) return "";
      if (cmd.includes("gh label create")) return "";
      if (cmd.includes("gh issue edit") && cmd.includes("--add-label")) return "";
      throw new Error("Unexpected command");
    });

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, false);

    // Should have comment + label create + label apply calls, but NOT PR merge checks
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue comment"),
      expect.any(Object),
    );
    // Verify no PR merge check was made (the key assertion for autoClose=false)
    const calls = mockExecSync.mock.calls.map((c: [string]) => c[0]);
    expect(calls.some((c: string) => c.includes("gh pr view"))).toBe(false);
  });
});

// ── isSynthesisFailed ─────────────────────────────────────────────────────

describe("isSynthesisFailed", () => {
  it("returns true when synthesis failed sentinel is present", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Synthesis failed — see round transcripts for raw input.

### Action Items
No action items.`,
    });
    expect(isSynthesisFailed(issue)).toBe(true);
  });

  it("returns false for a successful synthesis", () => {
    const issue = makeZeroActionStandup();
    expect(isSynthesisFailed(issue)).toBe(false);
  });

  it("returns false for a normal standup with action items", () => {
    const issue = makeStandupIssue();
    expect(isSynthesisFailed(issue)).toBe(false);
  });

  it("handles partial sentinel match correctly (must contain full word)", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Synthesis failed to produce clean JSON but has some data.

### Action Items
No action items.`,
    });
    // "Synthesis failed" is still present even with more text after
    expect(isSynthesisFailed(issue)).toBe(true);
  });

  it("returns false when body is empty", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "[📋 Standup] 2026-04-12 — 0 action items",
      body: "",
      labels: ["standup"],
      state: "open",
    };
    expect(isSynthesisFailed(issue)).toBe(false);
  });
});

// ── generateFallbackActionItems ───────────────────────────────────────────

describe("generateFallbackActionItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    // Default: return JSON list of open issues
    mockExecSync.mockReturnValue(
      JSON.stringify([
        { number: 10, title: "Fix login bug" },
        { number: 11, title: "Add dark mode" },
        { number: 12, title: "Improve performance" },
      ]),
    );
  });

  it("returns action items from open issues", () => {
    const items = generateFallbackActionItems(["rapartlu/test-repo"]);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({
      priority: "MEDIUM",
      owner: "orchestrator",
    });
    expect(items[0].description).toContain("rapartlu/test-repo");
  });

  it("includes issue number and title in description", () => {
    const items = generateFallbackActionItems(["rapartlu/test-repo"]);
    const descriptions = items.map((i) => i.description);
    expect(descriptions.some((d) => d.includes("#10"))).toBe(true);
    expect(descriptions.some((d) => d.includes("Fix login bug"))).toBe(true);
  });

  it("returns empty array when no open issues exist", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue(JSON.stringify([]));

    const items = generateFallbackActionItems(["rapartlu/test-repo"]);
    expect(items).toEqual([]);
  });

  it("returns empty array when gh CLI fails", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const items = generateFallbackActionItems(["rapartlu/test-repo"]);
    expect(items).toEqual([]);
  });

  it("queries multiple repos when provided", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue(JSON.stringify([{ number: 1, title: "Issue" }]));

    const items = generateFallbackActionItems([
      "rapartlu/repo-a",
      "rapartlu/repo-b",
    ]);
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(items.some((i) => i.description.includes("repo-a"))).toBe(true);
    expect(items.some((i) => i.description.includes("repo-b"))).toBe(true);
  });

  it("respects maxTotal cap", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    // Return 8 issues per repo, 3 repos → would be 24 without cap
    mockExecSync.mockReturnValue(
      JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}` }))),
    );

    const items = generateFallbackActionItems(["r/a", "r/b", "r/c"], 8, 10);
    expect(items.length).toBeLessThanOrEqual(10);
  });
});

// ── postFallbackActionItems ───────────────────────────────────────────────

describe("postFallbackActionItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue(
      JSON.stringify([
        { number: 10, title: "Fix login bug" },
        { number: 11, title: "Add dark mode" },
      ]),
    );
  });

  it("posts a fallback comment when open issues exist", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let commentPosted = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        return JSON.stringify([{ number: 10, title: "Fix login bug" }]);
      }
      if (cmd.includes("gh issue comment")) {
        commentPosted = true;
        return "";
      }
      return "";
    });

    const result = await postFallbackActionItems("rapartlu/test-repo", 100);
    expect(result).toBe(true);
    expect(commentPosted).toBe(true);
  });

  it("comment includes fallback action items", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let postedBody = "";
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        return JSON.stringify([{ number: 42, title: "Deploy new service" }]);
      }
      if (cmd.includes("gh issue comment")) {
        // Extract the --body argument
        const match = cmd.match(/--body\s+'([\s\S]+?)'\s*$/);
        if (match) postedBody = match[1];
        return "";
      }
      return "";
    });

    await postFallbackActionItems("rapartlu/test-repo", 100);
    expect(postedBody).toContain("Fallback Action Items");
    expect(postedBody).toContain("#42");
    expect(postedBody).toContain("Deploy new service");
  });

  it("returns false when no open issues exist", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue(JSON.stringify([]));

    const result = await postFallbackActionItems("rapartlu/test-repo", 100);
    expect(result).toBe(false);
  });

  it("retries up to maxRetries times on comment failure", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let commentAttempts = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        return JSON.stringify([{ number: 10, title: "Fix bug" }]);
      }
      if (cmd.includes("gh issue comment")) {
        commentAttempts++;
        throw new Error("gh comment failed");
      }
      return "";
    });

    const result = await postFallbackActionItems("rapartlu/test-repo", 100, undefined, 2);
    expect(result).toBe(false);
    expect(commentAttempts).toBe(2); // retried exactly 2 times
  });

  it("succeeds on second attempt after first fails", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let commentAttempts = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        return JSON.stringify([{ number: 10, title: "Fix bug" }]);
      }
      if (cmd.includes("gh issue comment")) {
        commentAttempts++;
        if (commentAttempts === 1) throw new Error("transient error");
        return "";
      }
      return "";
    });

    const result = await postFallbackActionItems("rapartlu/test-repo", 100, undefined, 2);
    expect(result).toBe(true);
    expect(commentAttempts).toBe(2);
  });

  it("uses provided fallbackRepos instead of default repo", async () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    const queriedRepos: string[] = [];
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        const match = cmd.match(/--repo\s+(\S+)/);
        if (match) queriedRepos.push(match[1]);
        return JSON.stringify([{ number: 1, title: "Issue" }]);
      }
      return "";
    });

    await postFallbackActionItems(
      "rapartlu/current-repo",
      100,
      ["rapartlu/repo-a", "rapartlu/repo-b"],
    );

    expect(queriedRepos).toContain("rapartlu/repo-a");
    expect(queriedRepos).toContain("rapartlu/repo-b");
    expect(queriedRepos).not.toContain("rapartlu/current-repo");
  });
});

// ── handleZeroActionStandup with synthesis failure ────────────────────────

describe("handleZeroActionStandup — synthesis failure recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockReturnValue("");
  });

  it("triggers fallback when synthesis failed sentinel is present", async () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Synthesis failed — see round transcripts for raw input.

### Action Items
No action items.`,
    });

    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let listCalled = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        listCalled = true;
        return JSON.stringify([{ number: 5, title: "Open issue" }]);
      }
      return "";
    });

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, false);

    expect(listCalled).toBe(true);
  });

  it("does NOT trigger fallback for successful synthesis with 0 items", async () => {
    const issue = makeZeroActionStandup(); // no failure sentinel

    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    let listCalled = false;
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue list")) {
        listCalled = true;
        return JSON.stringify([]);
      }
      return "";
    });

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, false);

    expect(listCalled).toBe(false);
  });
});

// ── detectSynthesisLabel ──────────────────────────────────────────────────

describe("detectSynthesisLabel", () => {
  it("returns 'synthesized' for an issue with action items", () => {
    const issue = makeStandupIssue(); // has 3 action items
    expect(detectSynthesisLabel(issue)).toBe("synthesized");
  });

  it("returns 'synthesis-fallback' for a zero-action standup without sentinel", () => {
    const issue = makeZeroActionStandup();
    expect(detectSynthesisLabel(issue)).toBe("synthesis-fallback");
  });

  it("returns 'synthesis-fallback' when synthesis sentinel is present", () => {
    const issue = makeZeroActionStandup({
      body: `### Synthesis
Synthesis failed — LLM timeout.

### Action Items
No action items.`,
    });
    expect(detectSynthesisLabel(issue)).toBe("synthesis-fallback");
  });

  it("returns 'empty-retry' when already labelled synthesis-fallback and still 0 items", () => {
    const issue = makeZeroActionStandup({
      labels: ["standup", "synthesis-fallback"],
    });
    expect(detectSynthesisLabel(issue)).toBe("empty-retry");
  });

  it("returns 'empty-retry' when already labelled empty-retry and still 0 items", () => {
    const issue = makeZeroActionStandup({
      labels: ["standup", "empty-retry"],
    });
    expect(detectSynthesisLabel(issue)).toBe("empty-retry");
  });

  it("returns 'synthesized' even with synthesis-fallback label if action items > 0", () => {
    const issue = makeStandupIssue({
      labels: ["standup", "synthesis-fallback"],
    });
    expect(detectSynthesisLabel(issue)).toBe("synthesized");
  });
});

// ── applyGitHubSynthesisLabel ─────────────────────────────────────────────

describe("applyGitHubSynthesisLabel", () => {
  it("calls gh label create and gh issue edit for a synthesis-fallback label", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();
    mockExecSync.mockReturnValue("");

    applyGitHubSynthesisLabel("rapartlu/test-repo", 42, "synthesis-fallback");

    const calls: string[] = mockExecSync.mock.calls.map((c: [string]) => c[0]);
    expect(calls.some((c) => c.includes("gh label create") && c.includes("synthesis-fallback"))).toBe(true);
    expect(calls.some((c) => c.includes("gh issue edit") && c.includes("--add-label"))).toBe(true);
  });

  it("does not throw when gh label create fails (label already exists)", () => {
    const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;
    mockExecSync.mockClear();
    let callCount = 0;
    mockExecSync.mockImplementation((cmd: string) => {
      callCount++;
      if (cmd.includes("gh label create")) throw new Error("already exists");
      return "";
    });

    // Should not throw
    expect(() => applyGitHubSynthesisLabel("rapartlu/test-repo", 42, "synthesized")).not.toThrow();
    // The issue edit call should still be made
    expect(callCount).toBe(2);
  });
});

// ── checkAndEscalateFallbackThreshold ────────────────────────────────────

describe("checkAndEscalateFallbackThreshold", () => {
  it("logs when should_escalate is true (NOISE SUPPRESSION #564)", async () => {
    const mockStore = {
      getStandupHealth: vi.fn().mockReturnValue({
        window_days: 1,
        points: [],
        fallback_count_24h: 3,
        should_escalate: true,
      }),
    };
    const mockNotifier = {
      notifyOperator: vi.fn().mockResolvedValue(true),
    };

    await checkAndEscalateFallbackThreshold(
      mockStore as never,
      mockNotifier as never,
    );

    // Per noise suppression (#564), operational metrics like standup fallback
    // counts should be logged, not sent to Telegram
    expect(mockNotifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("does not escalate when below threshold", async () => {
    const mockStore = {
      getStandupHealth: vi.fn().mockReturnValue({
        window_days: 1,
        points: [],
        fallback_count_24h: 1,
        should_escalate: false,
      }),
    };
    const mockNotifier = {
      notifyOperator: vi.fn(),
    };

    await checkAndEscalateFallbackThreshold(
      mockStore as never,
      mockNotifier as never,
    );

    expect(mockNotifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("swallows errors from store/notifier gracefully", async () => {
    const mockStore = {
      getStandupHealth: vi.fn().mockImplementation(() => {
        throw new Error("DB error");
      }),
    };
    const mockNotifier = { notifyOperator: vi.fn() };

    // Should not throw
    await expect(
      checkAndEscalateFallbackThreshold(mockStore as never, mockNotifier as never),
    ).resolves.toBeUndefined();
  });
});
