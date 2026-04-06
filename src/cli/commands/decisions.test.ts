import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseDuration, sinceToDate, decisionMatchesIssue, decisionMatchesSearch } from "./decisions.js";

// ── parseDuration ─────────────────────────────────────────────────────────────

describe("parseDuration", () => {
  it("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("2h")).toBe(7_200_000);
  });

  it("parses minutes", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("90m")).toBe(5_400_000);
  });

  it("parses days", () => {
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("parses seconds", () => {
    expect(parseDuration("60s")).toBe(60_000);
    expect(parseDuration("30s")).toBe(30_000);
  });

  it("parses combined components", () => {
    expect(parseDuration("1h30m")).toBe(3_600_000 + 1_800_000);
    expect(parseDuration("2h15m")).toBe(7_200_000 + 900_000);
    expect(parseDuration("1d2h")).toBe(86_400_000 + 7_200_000);
    expect(parseDuration("1d2h30m")).toBe(86_400_000 + 7_200_000 + 1_800_000);
  });

  it("returns null for empty string", () => {
    expect(parseDuration("")).toBeNull();
  });

  it("returns null for zero duration", () => {
    expect(parseDuration("0h")).toBeNull();
    expect(parseDuration("0m")).toBeNull();
  });

  it("returns null for invalid formats", () => {
    expect(parseDuration("1")).toBeNull();
    expect(parseDuration("1x")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("1h 30m")).toBeNull(); // space not allowed
  });

  it("trims leading/trailing whitespace before parsing", () => {
    expect(parseDuration("  1h  ")).toBe(3_600_000);
  });
});

// ── sinceToDate ───────────────────────────────────────────────────────────────

describe("sinceToDate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-06T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a Date offset by the given duration", () => {
    const result = sinceToDate("1h");
    expect(result).not.toBeNull();
    expect(result!.toISOString()).toBe("2026-04-06T11:00:00.000Z");
  });

  it("returns a Date offset by 2h correctly", () => {
    const result = sinceToDate("2h");
    expect(result!.toISOString()).toBe("2026-04-06T10:00:00.000Z");
  });

  it("returns a Date offset by 30m correctly", () => {
    const result = sinceToDate("30m");
    expect(result!.toISOString()).toBe("2026-04-06T11:30:00.000Z");
  });

  it("returns a Date offset by 1d correctly", () => {
    const result = sinceToDate("1d");
    expect(result!.toISOString()).toBe("2026-04-05T12:00:00.000Z");
  });

  it("returns null for an invalid duration string", () => {
    expect(sinceToDate("invalid")).toBeNull();
    expect(sinceToDate("")).toBeNull();
    expect(sinceToDate("5x")).toBeNull();
  });
});

// ── filtering logic ───────────────────────────────────────────────────────────
// Test the filter predicates as pure functions so they don't require a real DB.

import type { SupervisorDecisionRecord } from "../../state/store.js";

function makeDecision(overrides: Partial<SupervisorDecisionRecord> = {}): SupervisorDecisionRecord {
  return {
    id: 1,
    action: "dispatch",
    agent_name: "claude-orchestrator-dashboard",
    reason: "Issue looks good",
    message: null,
    rationale: null,
    outcome: "dispatched",
    task_id: "abc12345",
    created_at: "2026-04-06T11:30:00.000Z",
    ...overrides,
  };
}

describe("decisions filtering logic", () => {
  const decisions: SupervisorDecisionRecord[] = [
    makeDecision({ id: 1, action: "dispatch", agent_name: "agent-a", outcome: "dispatched",  created_at: "2026-04-06T11:30:00.000Z" }),
    makeDecision({ id: 2, action: "verify",   agent_name: "agent-b", outcome: "skipped",     created_at: "2026-04-06T10:00:00.000Z" }),
    makeDecision({ id: 3, action: "dispatch", agent_name: "agent-a", outcome: "failed",      created_at: "2026-04-06T08:00:00.000Z" }),
    makeDecision({ id: 4, action: "none",     agent_name: null as unknown as string, outcome: "none", created_at: "2026-04-05T12:00:00.000Z" }),
  ];

  it("filters by --action", () => {
    const result = decisions.filter((d) => d.action === "dispatch");
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.action === "dispatch")).toBe(true);
  });

  it("filters by --agent", () => {
    const result = decisions.filter((d) => d.agent_name === "agent-a");
    expect(result).toHaveLength(2);
    expect(result.every((d) => d.agent_name === "agent-a")).toBe(true);
  });

  it("filters by --outcome", () => {
    const result = decisions.filter((d) => d.outcome === "dispatched");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("filters by --since using ISO cutoff", () => {
    const cutoff = "2026-04-06T09:00:00.000Z";
    const result = decisions.filter((d) => d.created_at >= cutoff);
    expect(result).toHaveLength(2); // ids 1 and 2
    expect(result.map((d) => d.id)).toEqual([1, 2]);
  });

  it("combines --agent and --since filters", () => {
    const cutoff = "2026-04-06T09:00:00.000Z";
    const result = decisions
      .filter((d) => d.created_at >= cutoff)
      .filter((d) => d.agent_name === "agent-a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(1);
  });

  it("respects --limit after filtering", () => {
    const filtered = decisions.filter((d) => d.action === "dispatch");
    const limited = filtered.slice(0, 1);
    expect(limited).toHaveLength(1);
  });

  it("returns empty array when no decisions match filters", () => {
    const result = decisions.filter((d) => d.agent_name === "ghost-agent");
    expect(result).toHaveLength(0);
  });
});

// ── NDJSON output ─────────────────────────────────────────────────────────────

describe("--json NDJSON output format", () => {
  it("each line is valid JSON", () => {
    const decisions = [
      makeDecision({ id: 1 }),
      makeDecision({ id: 2 }),
    ];
    const lines = decisions.map((d) => JSON.stringify(d));
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // Must be one object per line, not an array
    expect(JSON.parse(lines[0])).toHaveProperty("id", 1);
    expect(JSON.parse(lines[1])).toHaveProperty("id", 2);
  });

  it("NDJSON lines are parseable by jq (no wrapping array)", () => {
    const decisions = [makeDecision({ id: 1, action: "dispatch" })];
    const line = JSON.stringify(decisions[0]);
    const parsed = JSON.parse(line);
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed.action).toBe("dispatch");
  });
});

// ── decisionMatchesIssue ─────────────────────────────────────────────────────

describe("decisionMatchesIssue", () => {
  it("matches issue number in reason field", () => {
    const d = makeDecision({ reason: "Dispatching work for #457 to agent" });
    expect(decisionMatchesIssue(d, 457)).toBe(true);
  });

  it("matches issue number in message field", () => {
    const d = makeDecision({ message: "GitHub Issue #123: Fix the bug" });
    expect(decisionMatchesIssue(d, 123)).toBe(true);
  });

  it("matches issue number in rationale field", () => {
    const d = makeDecision({ rationale: "Issue #99 is high priority" });
    expect(decisionMatchesIssue(d, 99)).toBe(true);
  });

  it("matches sourceRef patterns like owner/repo#457", () => {
    const d = makeDecision({ reason: "Skipped rapartlu/claude-agent-orchestrator#457" });
    expect(decisionMatchesIssue(d, 457)).toBe(true);
  });

  it("does not match when issue number is a prefix of another number", () => {
    const d = makeDecision({ reason: "Working on #4570" });
    expect(decisionMatchesIssue(d, 457)).toBe(false);
  });

  it("does not match unrelated issue numbers", () => {
    const d = makeDecision({ reason: "Dispatching #100" });
    expect(decisionMatchesIssue(d, 200)).toBe(false);
  });

  it("returns false when all text fields are null/empty", () => {
    const d = makeDecision({ reason: "No issue ref", message: null, rationale: null });
    expect(decisionMatchesIssue(d, 457)).toBe(false);
  });
});

// ── decisionMatchesSearch ────────────────────────────────────────────────────

describe("decisionMatchesSearch", () => {
  it("matches case-insensitively in reason", () => {
    const d = makeDecision({ reason: "Dispatching to Agent-A for urgent fix" });
    expect(decisionMatchesSearch(d, "urgent")).toBe(true);
    expect(decisionMatchesSearch(d, "URGENT")).toBe(true);
  });

  it("matches in message field", () => {
    const d = makeDecision({ message: "GitHub Issue #457: Pre-dispatch detection" });
    expect(decisionMatchesSearch(d, "pre-dispatch")).toBe(true);
  });

  it("matches in rationale field", () => {
    const d = makeDecision({ rationale: "Agent is idle and issue is fresh" });
    expect(decisionMatchesSearch(d, "idle")).toBe(true);
  });

  it("matches in action field", () => {
    const d = makeDecision({ action: "dispatch" });
    expect(decisionMatchesSearch(d, "dispatch")).toBe(true);
  });

  it("matches in agent_name field", () => {
    const d = makeDecision({ agent_name: "claude-orchestrator-dashboard" });
    expect(decisionMatchesSearch(d, "dashboard")).toBe(true);
  });

  it("matches in outcome field", () => {
    const d = makeDecision({ outcome: "skipped" });
    expect(decisionMatchesSearch(d, "skipped")).toBe(true);
  });

  it("returns false when no field matches", () => {
    const d = makeDecision({ reason: "All good", message: null, rationale: null });
    expect(decisionMatchesSearch(d, "nonexistent")).toBe(false);
  });

  it("handles null fields without errors", () => {
    const d = makeDecision({ message: null, rationale: null, agent_name: null as unknown as string });
    expect(decisionMatchesSearch(d, "test")).toBe(false);
  });
});

// ── --issue filter integration ───────────────────────────────────────────────

describe("--issue filter", () => {
  const decisions: SupervisorDecisionRecord[] = [
    makeDecision({ id: 1, reason: "Dispatching rapartlu/repo#457 to agent-a", outcome: "dispatched" }),
    makeDecision({ id: 2, reason: "Skipped #457 — already resolved by merged PR", outcome: "skipped" }),
    makeDecision({ id: 3, reason: "Dispatching #100 to agent-b", outcome: "dispatched" }),
    makeDecision({ id: 4, reason: "No action needed", outcome: "none" }),
    makeDecision({ id: 5, message: "GitHub Issue #457: Fix detection", reason: "Fresh issue", outcome: "dispatched" }),
  ];

  it("filters decisions related to a specific issue", () => {
    const result = decisions.filter((d) => decisionMatchesIssue(d, 457));
    expect(result).toHaveLength(3);
    expect(result.map((d) => d.id)).toEqual([1, 2, 5]);
  });

  it("combines --issue with --outcome filter", () => {
    const result = decisions
      .filter((d) => decisionMatchesIssue(d, 457))
      .filter((d) => d.outcome === "skipped");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(2);
  });

  it("returns empty when issue has no decisions", () => {
    const result = decisions.filter((d) => decisionMatchesIssue(d, 999));
    expect(result).toHaveLength(0);
  });
});
