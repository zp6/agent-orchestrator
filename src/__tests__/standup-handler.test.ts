import { describe, it, expect, beforeEach, vi } from "vitest";
import { execSync } from "child_process";
import {
  isStandupIssue,
  extractActionItemCount,
  extractPRReferences,
  buildStandupAcknowledgmentComment,
  handleZeroActionStandup,
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

    // Make it only match the comment call
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("gh issue comment")) return "";
      throw new Error("Unexpected command");
    });

    await handleZeroActionStandup("rapartlu/test-repo", 100, issue, false);

    // Should only have the comment call, not PR checks
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("gh issue comment"),
      expect.any(Object),
    );
  });
});
