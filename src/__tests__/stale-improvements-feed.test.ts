/**
 * Tests for the stale-improvements feed (issue #440).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildStaleImprovementsFeed,
  formatStaleImprovementsFeedForTelegram,
  STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS,
  STALE_IMPROVEMENTS_DISPLAY_LIMIT,
} from "../reviewer/stale-improvements-feed.js";
import type { ReviewerConfig } from "../config.js";

// ── Mocks ─────────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";
const mockExecSync = vi.mocked(execSync);

// ── Helpers ───────────────────────────────────────────────────────────────

function makeConfig(repos: string[]): ReviewerConfig {
  const agents: Record<string, { github: string }> = {};
  repos.forEach((repo, idx) => {
    agents[`agent-${idx}`] = { github: repo };
  });
  return { agents } as unknown as ReviewerConfig;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

const evidenceBody = `## Improvement Identified by Orchestrator

**Severity:** medium
**Affected agent:** claude-orchestrator-reviewer

### Description

Some description.

### Evidence

- Task \`01KPVZNN\`: [rapartlu/agent-reviewer#392] Already in review — PR #437
- Task \`01KPVZN9\`: [rapartlu/agent-reviewer#427] Already in review — PR #437
- Task \`01KPVZMY\`: [rapartlu/agent-reviewer#436] Already in review — PR #439

---
*This issue was automatically created by the claude-agent-orchestrator based on analysis of recent task patterns.*`;

// ── Tests ─────────────────────────────────────────────────────────────────

describe("buildStaleImprovementsFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty feed when no repos are configured", () => {
    const feed = buildStaleImprovementsFeed(makeConfig([]), 24);
    expect(feed.issues).toHaveLength(0);
    expect(feed.repos_checked).toBe(0);
    expect(feed.total_open_improvement_issues).toBe(0);
  });

  it("filters out issues younger than minAgeHours", () => {
    // Issue created 1h ago — should be excluded when minAgeHours=24
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { number: 1, title: "New issue", url: "https://github.com/r/repo/issues/1", createdAt: hoursAgo(1), body: evidenceBody },
      ]),
    );

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues).toHaveLength(0);
    expect(feed.total_open_improvement_issues).toBe(1);
  });

  it("includes issues older than minAgeHours with no PR", () => {
    // Issue list
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { number: 42, title: "Stale improvement", url: "https://github.com/r/repo/issues/42", createdAt: hoursAgo(48), body: evidenceBody },
      ]),
    );
    // PR search calls all return empty (no PR found)
    mockExecSync.mockReturnValue(JSON.stringify([]));

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues).toHaveLength(1);
    expect(feed.issues[0]?.number).toBe(42);
    expect(feed.issues[0]?.has_pr).toBe(false);
    expect(feed.issues[0]?.detection_count).toBe(3); // 3 evidence lines
  });

  it("excludes issues that have an associated PR", () => {
    // Issue list
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { number: 10, title: "Already handled", url: "https://github.com/r/repo/issues/10", createdAt: hoursAgo(30), body: evidenceBody },
      ]),
    );
    // First PR search returns a hit
    mockExecSync.mockReturnValueOnce(JSON.stringify([{ number: 99 }]));

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues).toHaveLength(0);
  });

  it("sorts by detection_count descending", () => {
    const twoDetections = evidenceBody; // 3 evidence lines
    const oneDetection = evidenceBody.replace(
      "- Task `01KPVZN9`: [rapartlu/agent-reviewer#427] Already in review — PR #437\n- Task `01KPVZMY`: [rapartlu/agent-reviewer#436] Already in review — PR #439\n",
      "",
    ); // 1 evidence line

    mockExecSync.mockReturnValueOnce(
      JSON.stringify([
        { number: 1, title: "Low count", url: "u1", createdAt: hoursAgo(25), body: oneDetection },
        { number: 2, title: "High count", url: "u2", createdAt: hoursAgo(26), body: twoDetections },
      ]),
    );
    // All PR searches return empty
    mockExecSync.mockReturnValue(JSON.stringify([]));

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues[0]?.number).toBe(2); // 3 detections first
    expect(feed.issues[1]?.number).toBe(1); // 1 detection second
  });

  it("deduplicates repos when multiple agents share the same github repo", () => {
    const config: ReviewerConfig = {
      agents: {
        "agent-a": { github: "rapartlu/agent-reviewer" },
        "agent-b": { github: "rapartlu/agent-reviewer" }, // same repo
      },
    } as unknown as ReviewerConfig;

    mockExecSync.mockReturnValue(JSON.stringify([]));

    const feed = buildStaleImprovementsFeed(config, 24);
    // Should only query the repo once
    expect(feed.repos_checked).toBe(1);
  });

  it("respects STALE_IMPROVEMENTS_DISPLAY_LIMIT", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      url: `https://github.com/r/repo/issues/${i + 1}`,
      createdAt: hoursAgo(25 + i),
      body: evidenceBody,
    }));
    mockExecSync.mockReturnValueOnce(JSON.stringify(many));
    mockExecSync.mockReturnValue(JSON.stringify([]));

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues.length).toBeLessThanOrEqual(STALE_IMPROVEMENTS_DISPLAY_LIMIT);
  });

  it("fails-open when gh CLI errors on issue list", () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("gh: not found"); });

    const feed = buildStaleImprovementsFeed(makeConfig(["rapartlu/agent-reviewer"]), 24);
    expect(feed.issues).toHaveLength(0);
    expect(feed.repos_checked).toBe(1);
  });
});

describe("formatStaleImprovementsFeedForTelegram", () => {
  it("returns a no-stale-issues message when feed is empty", () => {
    const feed = {
      issues: [],
      repos_checked: 2,
      total_open_improvement_issues: 0,
      fetched_at: new Date().toISOString(),
    };
    const text = formatStaleImprovementsFeedForTelegram(feed, 24);
    expect(text).toContain("No stale improvements");
  });

  it("formats issue entries with age and detection count", () => {
    const feed = {
      issues: [
        {
          repo: "rapartlu/agent-reviewer",
          number: 440,
          title: "Guard flood not dispatched",
          url: "https://github.com/rapartlu/agent-reviewer/issues/440",
          created_at: hoursAgo(50),
          age_hours: 50,
          detection_count: 3,
          has_pr: false,
        },
      ],
      repos_checked: 1,
      total_open_improvement_issues: 5,
      fetched_at: new Date().toISOString(),
    };
    const text = formatStaleImprovementsFeedForTelegram(feed, 24);
    expect(text).toContain("#440");
    expect(text).toContain("Guard flood not dispatched");
    expect(text).toContain("3 detections");
    expect(text).toContain("agent-reviewer");
  });

  it("shows days label for issues older than 48h", () => {
    const feed = {
      issues: [
        {
          repo: "rapartlu/agent-reviewer",
          number: 1,
          title: "Old issue",
          url: "u",
          created_at: hoursAgo(72),
          age_hours: 72,
          detection_count: 1,
          has_pr: false,
        },
      ],
      repos_checked: 1,
      total_open_improvement_issues: 1,
      fetched_at: new Date().toISOString(),
    };
    const text = formatStaleImprovementsFeedForTelegram(feed, 24);
    expect(text).toContain("3d");
  });

  it("uses default STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS constant correctly", () => {
    expect(STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS).toBe(24);
  });
});
