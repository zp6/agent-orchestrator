/**
 * Tests for semantic-duplicate-guard (issue #275)
 *
 * Verifies that `checkSemanticDuplicates` correctly identifies semantically
 * similar issue titles using token-overlap (Jaccard) similarity and returns
 * candidate duplicates for operator review.
 */

import { describe, it, expect } from "vitest";
import {
  checkSemanticDuplicates,
  tokenize,
  jaccardSimilarity,
  formatDedupCandidates,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_WINDOW_HOURS,
  type RecentDispatchedIssue,
} from "../reviewer/semantic-duplicate-guard.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

const recentIssues: RecentDispatchedIssue[] = [
  {
    issueNumber: 918,
    title: "Dashboard: expose already-in-review saturation ratio as a fleet health metric",
    repo: "rapartlu/agent-dashboard",
    dispatchedAt: hoursAgo(2),
    assignedAgent: "claude-orchestrator-dashboard",
  },
  {
    issueNumber: 100,
    title: "Fix login page CSS alignment bug on mobile",
    repo: "rapartlu/agent-dashboard",
    dispatchedAt: hoursAgo(10),
  },
  {
    issueNumber: 200,
    title: "Telegram bot: add /restart command for individual containers",
    repo: "rapartlu/agent-orchestrator",
    dispatchedAt: hoursAgo(5),
    assignedAgent: "claude-orchestrator-telegram",
  },
  {
    issueNumber: 300,
    title: "Fleet health: already-in-review saturation ratio panel for monitoring",
    repo: "rapartlu/agent-dashboard",
    dispatchedAt: hoursAgo(1),
    assignedAgent: "codex-orchestrator-dashboard",
  },
];

// ── tokenize ─────────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    const tokens = tokenize("Fleet Health Panel");
    expect(tokens.has("fleet")).toBe(true);
    expect(tokens.has("health")).toBe(true);
    expect(tokens.has("panel")).toBe(true);
  });

  it("replaces separators with spaces", () => {
    const tokens = tokenize("[Orchestrator] Fleet-health_panel");
    // "orchestrator" is a stop word, should be removed
    expect(tokens.has("orchestrator")).toBe(false);
    expect(tokens.has("fleet")).toBe(true);
    expect(tokens.has("health")).toBe(true);
    expect(tokens.has("panel")).toBe(true);
  });

  it("removes stop words", () => {
    const tokens = tokenize("Add a new fleet health metric to the dashboard");
    expect(tokens.has("add")).toBe(false);
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("to")).toBe(false);
    expect(tokens.has("dashboard")).toBe(false); // orchestrator jargon stop word
    expect(tokens.has("fleet")).toBe(true);
    expect(tokens.has("health")).toBe(true);
    expect(tokens.has("metric")).toBe(true);
    expect(tokens.has("new")).toBe(true);
  });

  it("removes short tokens (< 2 chars)", () => {
    const tokens = tokenize("A b CD ef");
    expect(tokens.has("a")).toBe(false);
    expect(tokens.has("b")).toBe(false);
    expect(tokens.has("cd")).toBe(true);
    expect(tokens.has("ef")).toBe(true);
  });

  it("returns empty set for all-stop-word titles", () => {
    const tokens = tokenize("Add a dashboard");
    expect(tokens.size).toBe(0);
  });

  it("deduplicates tokens", () => {
    const tokens = tokenize("health health health metric metric");
    expect(tokens.size).toBe(2);
  });
});

// ── jaccardSimilarity ────────────────────────────────────────────────────────

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const a = new Set(["fleet", "health", "metric"]);
    expect(jaccardSimilarity(a, a)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const a = new Set(["fleet", "health"]);
    const b = new Set(["login", "css"]);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("computes correct similarity for partial overlap", () => {
    const a = new Set(["fleet", "health", "metric", "panel"]);
    const b = new Set(["fleet", "health", "saturation", "ratio"]);
    // intersection: fleet, health → 2
    // union: fleet, health, metric, panel, saturation, ratio → 6
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 6, 5);
  });

  it("is symmetric", () => {
    const a = new Set(["fleet", "health", "metric"]);
    const b = new Set(["health", "metric", "ratio"]);
    expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
  });
});

// ── checkSemanticDuplicates ──────────────────────────────────────────────────

describe("checkSemanticDuplicates", () => {
  it("detects semantically similar issue (the motivating example from #275)", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues,
    });

    expect(result.hasDuplicates).toBe(true);
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);

    // Issue #918 and #300 should both match
    const issueNumbers = result.candidates.map((c) => c.issueNumber);
    expect(issueNumbers).toContain(918);
    expect(issueNumbers).toContain(300);

    // All candidates should be above threshold
    for (const c of result.candidates) {
      expect(c.similarity).toBeGreaterThanOrEqual(DEFAULT_SIMILARITY_THRESHOLD);
    }

    // Should be sorted descending by similarity
    for (let i = 1; i < result.candidates.length; i++) {
      expect(result.candidates[i - 1].similarity).toBeGreaterThanOrEqual(
        result.candidates[i].similarity,
      );
    }
  });

  it("does not flag unrelated issues", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Telegram bot: add /restart command for individual containers",
      candidateIssueNumber: 500,
      recentIssues: [
        {
          issueNumber: 100,
          title: "Fix login page CSS alignment bug on mobile",
          repo: "rapartlu/agent-dashboard",
          dispatchedAt: hoursAgo(10),
        },
      ],
    });

    expect(result.hasDuplicates).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it("excludes self from comparison", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 300,
      candidateRepo: "rapartlu/agent-dashboard",
      recentIssues,
    });

    // Issue #300 should not match itself
    const issueNumbers = result.candidates.map((c) => c.issueNumber);
    expect(issueNumbers).not.toContain(300);
  });

  it("excludes issues outside the time window", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues: [
        {
          issueNumber: 918,
          title: "Dashboard: expose already-in-review saturation ratio as a fleet health metric",
          repo: "rapartlu/agent-dashboard",
          dispatchedAt: hoursAgo(100), // outside 72h window
        },
      ],
    });

    expect(result.hasDuplicates).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it("respects custom similarity threshold", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues,
      similarityThreshold: 0.95, // very strict
    });

    // With 95% threshold, only near-identical titles should match
    // Our example titles differ enough that most won't pass
    for (const c of result.candidates) {
      expect(c.similarity).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("respects custom time window", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues: [
        {
          issueNumber: 918,
          title: "Fleet health: already-in-review saturation ratio as fleet metric",
          repo: "rapartlu/agent-dashboard",
          dispatchedAt: hoursAgo(5),
        },
      ],
      windowHours: 2, // only last 2 hours
    });

    expect(result.hasDuplicates).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it("handles empty recent issues list", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Some feature request",
      candidateIssueNumber: 1,
      recentIssues: [],
    });

    expect(result.hasDuplicates).toBe(false);
    expect(result.candidates).toHaveLength(0);
  });

  it("handles candidate title with only stop words", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Add a dashboard",
      candidateIssueNumber: 1,
      recentIssues,
    });

    expect(result.hasDuplicates).toBe(false);
    expect(result.reason).toContain("no meaningful tokens");
  });

  it("includes assignedAgent in candidates when available", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues,
    });

    const issue918 = result.candidates.find((c) => c.issueNumber === 918);
    if (issue918) {
      expect(issue918.assignedAgent).toBe("claude-orchestrator-dashboard");
    }
  });

  it("exports correct defaults", () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.60);
    expect(DEFAULT_WINDOW_HOURS).toBe(72);
  });
});

// ── formatDedupCandidates ────────────────────────────────────────────────────

describe("formatDedupCandidates", () => {
  it("returns short message when no duplicates", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Totally unique feature",
      candidateIssueNumber: 999,
      recentIssues: [],
    });

    const formatted = formatDedupCandidates(result, 999);
    expect(formatted).toContain("No semantic duplicates");
    expect(formatted).toContain("#999");
  });

  it("formats candidates with similarity percentages", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues,
    });

    const formatted = formatDedupCandidates(result, 352);
    expect(formatted).toContain("⚠️");
    expect(formatted).toContain("#352");
    expect(formatted).toContain("% overlap");
    expect(formatted).toContain("Action: review before dispatch");
  });

  it("includes agent name when available", () => {
    const result = checkSemanticDuplicates({
      candidateTitle: "Fleet health: already-in-review saturation ratio panel",
      candidateIssueNumber: 352,
      recentIssues,
    });

    const formatted = formatDedupCandidates(result, 352);
    // At least one candidate should have an agent
    if (result.candidates.some((c) => c.assignedAgent)) {
      expect(formatted).toContain("→");
    }
  });
});
