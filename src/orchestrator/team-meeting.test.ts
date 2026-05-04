/**
 * Tests for team-meeting synthesis retry and fallback action item extraction.
 *
 * Covers:
 *  - extractFallbackActionItems(): lines with action verbs + issue refs → items
 *  - extractFallbackActionItems(): deduplication and per-agent cap
 *  - extractFallbackActionItems(): empty / no-match inputs
 *  - extractFallbackActionItems(): ordering (last round first)
 *  - extractFallbackActionItems(): FALLBACK_MAX_ITEMS cap
 */

import { describe, it, expect } from "vitest";
import { extractFallbackActionItems, formatPriorRounds } from "./team-meeting.js";
import type { MeetingRound } from "./team-meeting.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRound(roundNumber: number, entries: Array<{ agentName: string; response: string | null }>): MeetingRound {
  return {
    roundNumber,
    prompt: `Round ${roundNumber} prompt`,
    entries: entries.map(({ agentName, response }) => ({
      agentName,
      provider: "claude",
      pool: undefined,
      response,
      error: null,
    })),
  };
}

// ── formatPriorRounds ─────────────────────────────────────────────────────

describe("formatPriorRounds", () => {
  it("returns empty string for empty rounds array", () => {
    expect(formatPriorRounds([])).toBe("");
  });

  it("returns empty string when the only round has all-null responses (issue #1462)", () => {
    // This is the bug: previously returned "## Round 1\n" (truthy empty section)
    // which caused Round 2 to show an empty ## Round 1 header with no content.
    const rounds = [
      makeRound(1, [
        { agentName: "agent-a", response: null },
        { agentName: "agent-b", response: null },
      ]),
    ];
    expect(formatPriorRounds(rounds)).toBe("");
  });

  it("includes round section when at least one agent responded", () => {
    const rounds = [
      makeRound(1, [
        { agentName: "agent-a", response: "Here is my round 1 response." },
        { agentName: "agent-b", response: null },
      ]),
    ];
    const result = formatPriorRounds(rounds);
    expect(result).toContain("## Round 1");
    expect(result).toContain("**agent-a**");
    expect(result).not.toContain("agent-b");
  });

  it("skips rounds with no responses but includes rounds that have responses", () => {
    // Round 1: all failed → skip. Round 2: has responses → include.
    const rounds = [
      makeRound(1, [{ agentName: "agent-a", response: null }]),
      makeRound(2, [{ agentName: "agent-b", response: "Round 2 response." }]),
    ];
    const result = formatPriorRounds(rounds);
    expect(result).not.toContain("## Round 1");
    expect(result).toContain("## Round 2");
    expect(result).toContain("**agent-b**");
  });

  it("formats two rounds with responses correctly (separator between them)", () => {
    const rounds = [
      makeRound(1, [{ agentName: "agent-a", response: "Round 1 by A." }]),
      makeRound(2, [{ agentName: "agent-b", response: "Round 2 by B." }]),
    ];
    const result = formatPriorRounds(rounds);
    expect(result).toContain("## Round 1");
    expect(result).toContain("## Round 2");
    expect(result).toContain("---"); // separator between rounds
  });

  it("does NOT emit a round header with empty body (regression for issue #1462)", () => {
    const rounds = [
      makeRound(1, [{ agentName: "agent-a", response: null }]),
    ];
    const result = formatPriorRounds(rounds);
    // Must not have a header with no content following it
    expect(result).not.toMatch(/## Round \d+\s*$/);
    expect(result).toBe("");
  });
});

// ── extractFallbackActionItems ─────────────────────────────────────────────

describe("extractFallbackActionItems", () => {
  it("returns empty array when rounds is empty", () => {
    expect(extractFallbackActionItems([])).toEqual([]);
  });

  it("returns empty array when all responses are null", () => {
    const rounds = [
      makeRound(1, [{ agentName: "agent-a", response: null }]),
    ];
    expect(extractFallbackActionItems(rounds)).toEqual([]);
  });

  it("returns empty array when no response line has both action verb and issue ref", () => {
    const rounds = [
      makeRound(1, [{
        agentName: "agent-a",
        response: "The system is healthy and running well. All agents are online.",
      }]),
    ];
    expect(extractFallbackActionItems(rounds)).toEqual([]);
  });

  it("extracts a line with action verb 'merge' and issue ref", () => {
    const rounds = [
      makeRound(2, [{
        agentName: "claude-agent-orchestrator",
        response: "- Merge PR #171 to unblock the capability manifest pipeline",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(1);
    expect(items[0].description).toContain("#171");
    expect(items[0].owner).toBe("claude-agent-orchestrator");
    expect(items[0].priority).toBe("medium");
  });

  it("extracts a line with action verb 'prioritize' and issue ref", () => {
    const rounds = [
      makeRound(2, [{
        agentName: "claude-agent-orchestrator",
        response: "I'll prioritize shipping per-repo dispatch pause #549 so that when a PR exists, I stop creating wasteful tasks.",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(1);
    expect(items[0].description).toContain("#549");
  });

  it("extracts a line with action verb 'wire' and issue ref", () => {
    const rounds = [
      makeRound(2, [{
        agentName: "claude-agent-orchestrator",
        response: "wire capability manifest from research agent #173 into pre-dispatch gate",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(1);
    expect(items[0].description).toContain("#173");
  });

  it("extracts items from multiple agents", () => {
    const rounds = [
      makeRound(2, [
        {
          agentName: "claude-agent-orchestrator",
          response: "- Merge PR #173 to unblock capability manifest",
        },
        {
          agentName: "claude-research-agent",
          response: "- Review and merge PRs #171, #173, #176 for self-rejection pipeline",
        },
      ]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(2);
    const owners = items.map((i) => i.owner);
    expect(owners).toContain("claude-agent-orchestrator");
    expect(owners).toContain("claude-research-agent");
  });

  it("deduplicates identical descriptions (case-insensitive)", () => {
    const rounds = [
      makeRound(1, [{
        agentName: "agent-a",
        response: "merge PR #173 into main",
      }]),
      makeRound(2, [{
        agentName: "agent-a",
        response: "Merge PR #173 into main",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(1);
  });

  it("caps contributions per agent at 2 items", () => {
    const response = [
      "merge PR #171 to fix self-rejection",
      "implement capability manifest check #173",
      "ship per-repo dispatch pause feature #549",
    ].join("\n");

    const rounds = [
      makeRound(2, [{ agentName: "agent-a", response }]),
    ];
    const items = extractFallbackActionItems(rounds);
    // Only 2 items per agent
    const agentAItems = items.filter((i) => i.owner === "agent-a");
    expect(agentAItems.length).toBeLessThanOrEqual(2);
  });

  it("caps total items at FALLBACK_MAX_ITEMS (5)", () => {
    const agents = Array.from({ length: 10 }, (_, i) => ({
      agentName: `agent-${i}`,
      response: `merge PR #${100 + i} to close issue #${200 + i}`,
    }));

    const rounds = [makeRound(2, agents)];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBeLessThanOrEqual(5);
  });

  it("processes last round first (higher round number = higher priority)", () => {
    const round1 = makeRound(1, [{
      agentName: "agent-a",
      response: "merge PR #100 for the old feature",
    }]);
    const round2 = makeRound(2, [{
      agentName: "agent-b",
      response: "merge PR #200 for the new feature",
    }]);

    const items = extractFallbackActionItems([round1, round2]);
    // Round 2 should be first in the output
    if (items.length >= 2) {
      expect(items[0].description).toContain("#200");
    } else {
      // Even with only 1 item, it should be from round 2
      expect(items[0].description).toContain("#200");
    }
  });

  it("strips markdown bold markers from descriptions", () => {
    const rounds = [
      makeRound(2, [{
        agentName: "agent-a",
        response: "**Merge PR #171** to unblock the pipeline",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBe(1);
    expect(items[0].description).not.toContain("**");
  });

  it("strips leading bullet markers from descriptions", () => {
    const rounds = [
      makeRound(2, [{
        agentName: "agent-a",
        response: "- Merge PR #171 into main\n* implement #200 next",
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    for (const item of items) {
      expect(item.description).not.toMatch(/^[-*•]\s/);
    }
  });

  it("truncates very long descriptions to 120 chars", () => {
    const longLine = "merge PR #171 " + "x".repeat(200);
    const rounds = [
      makeRound(2, [{
        agentName: "agent-a",
        response: longLine,
      }]),
    ];
    const items = extractFallbackActionItems(rounds);
    if (items.length > 0) {
      expect(items[0].description.length).toBeLessThanOrEqual(120);
    }
  });

  it("real-world: extracts from issue #1111 Round 2 transcript", () => {
    // Simulates the actual Round 2 responses from the failed standup
    const orchestratorRound2 = `**Round 2 — Orchestrator**

**Agree/build:** The merge bottleneck theme is unanimous — everyone feels it. I can help immediately: I'll prioritize shipping per-repo dispatch pause (#549) so that when a PR exists, I stop creating wasteful tasks entirely rather than creating-then-blocking them. That directly reduces noise for every agent downstream.

**Disagree/clarify:** Token spend reduction shouldn't wait for dashboard tooling. I already have prompt caching infrastructure — the 40% cache hit rate goal is achievable by expanding \`cache_control\` coverage to verification and routing prompts, which are highly repetitive. That's an orchestrator-side win independent of dashboard panels.

**Cross-team opportunity:** Research agent's 3 mergeable PRs (#171/#173/#176) form a complete misrouting self-healing pipeline. If reviewer merges those, I can immediately wire the capability manifest into my pre-dispatch gate — eliminating misrouted implementation tasks at source.`;

    const researchRound2 = `## Round 2 — Research Agent Response

**Agree/build:** The 23.8% failure rate is alarming — nearly 1 in 4 tasks failing. I have 3 open PRs (#171, #173, #176) that directly address this: self-rejection, capability manifest for pre-dispatch routing, and auto-reroute. If merged, the orchestrator gets a machine-readable capability manifest to check *before* dispatching, killing misroutes at the source.

**Priority ask:** Please review/merge PRs #171, #173, #176 — they're all MERGEABLE and directly target the failure rate goal.`;

    const rounds = [
      makeRound(1, [
        { agentName: "claude-agent-orchestrator", response: null }, // Round 1 was empty per the issue
      ]),
      makeRound(2, [
        { agentName: "claude-agent-orchestrator", response: orchestratorRound2 },
        { agentName: "claude-research-agent", response: researchRound2 },
      ]),
    ];

    const items = extractFallbackActionItems(rounds);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(5);

    // At least one item should reference an issue/PR number from the transcript
    const allDescriptions = items.map((i) => i.description).join(" ");
    const hasIssueRef = /#\d+/.test(allDescriptions);
    expect(hasIssueRef).toBe(true);
  });
});
