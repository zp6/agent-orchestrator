import { describe, it, expect } from "vitest";
import { extractIssueRefs, isConcreteDispatch, formatAgentHealthSection, formatTimeAgo, formatConflictStatsSection, detectNavelGazingRisk, formatOkrContextSection } from "../reviewer/supervisor.js";
import type { AgentHealth } from "../state/types.js";
import type { ConflictStats } from "../reviewer/pr-reviewer.js";

describe("extractIssueRefs", () => {
  it("extracts a single issue ref", () => {
    expect(extractIssueRefs("Implement issue #42 from owner/repo")).toEqual([42]);
  });

  it("extracts multiple issue refs", () => {
    const refs = extractIssueRefs("Relates to #10 and also #20, see PR #30");
    expect(refs).toContain(10);
    expect(refs).toContain(20);
    expect(refs).toContain(30);
  });

  it("returns empty array when no refs found", () => {
    expect(extractIssueRefs("No issue reference here")).toEqual([]);
  });

  it("deduplicates repeated refs", () => {
    expect(extractIssueRefs("#5 and #5 again")).toEqual([5]);
  });
});

describe("isConcreteDispatch", () => {
  it("returns true for messages with issue refs", () => {
    expect(isConcreteDispatch("Please implement issue #42 from owner/repo")).toBe(true);
  });

  it("returns true for messages with concrete artifact keywords", () => {
    expect(isConcreteDispatch("Create file src/index.ts with the new routes")).toBe(true);
    expect(isConcreteDispatch("Open a PR for the authentication feature")).toBe(true);
    expect(isConcreteDispatch("Push branch issue-5-auth to origin")).toBe(true);
    expect(isConcreteDispatch("Implement the login endpoint")).toBe(true);
    expect(isConcreteDispatch("Fix the null pointer bug in src/server.ts")).toBe(true);
  });

  it("returns false for vague status-check messages", () => {
    expect(isConcreteDispatch("You are idle, please check for work")).toBe(false);
    expect(isConcreteDispatch("How is the system doing?")).toBe(false);
    expect(isConcreteDispatch("Report your current status")).toBe(false);
  });

  it("returns false for empty message", () => {
    expect(isConcreteDispatch("")).toBe(false);
  });

  it("is case-insensitive for keywords", () => {
    expect(isConcreteDispatch("IMPLEMENT the feature from #42")).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatAgentHealthSection (issue #32)
// ────────────────────────────────────────────────────────────────────────────

describe("formatAgentHealthSection", () => {
  const makeHealth = (name: string, overrides?: Partial<AgentHealth>): AgentHealth => ({
    agent_name: name,
    consecutive_failures: 0,
    last_error_at: null,
    last_error_message: null,
    last_success_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  it("shows 'no dispatch history' for agents with no health record", () => {
    const lines = formatAgentHealthSection(["reviewer", "proxy"], []);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("- reviewer: healthy (no dispatch history)");
    expect(lines[1]).toBe("- proxy: healthy (no dispatch history)");
  });

  it("shows healthy status with last success time", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const lines = formatAgentHealthSection(
      ["reviewer"],
      [makeHealth("reviewer", { last_success_at: fiveMinAgo })],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- reviewer: healthy \(last success: 5m ago\)$/);
  });

  it("flags agents with consecutive failures", () => {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const lines = formatAgentHealthSection(
      ["reviewer"],
      [
        makeHealth("reviewer", {
          consecutive_failures: 3,
          last_error_at: twoMinAgo,
          last_error_message: "503 Failed to spawn claude CLI",
        }),
      ],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("3 consecutive failure(s)");
    expect(lines[0]).toContain("2m ago");
    expect(lines[0]).toContain("503 Failed to spawn claude CLI");
  });

  it("truncates long error messages to 80 chars", () => {
    const longError = "A".repeat(200);
    const lines = formatAgentHealthSection(
      ["reviewer"],
      [
        makeHealth("reviewer", {
          consecutive_failures: 1,
          last_error_at: new Date().toISOString(),
          last_error_message: longError,
        }),
      ],
    );
    // The error snippet should be at most 80 chars
    const errPart = lines[0].split(" — ")[1];
    expect(errPart.replace(")", "").length).toBeLessThanOrEqual(80);
  });

  it("mixes healthy and unhealthy agents correctly", () => {
    const now = new Date().toISOString();
    const lines = formatAgentHealthSection(
      ["reviewer", "reviewer-2", "reviewer-3"],
      [
        makeHealth("reviewer", {
          consecutive_failures: 5,
          last_error_at: now,
          last_error_message: "Connection refused",
        }),
        makeHealth("reviewer-2", { last_success_at: now }),
        // reviewer-3 has no health record
      ],
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("5 consecutive failure(s)");
    expect(lines[1]).toContain("healthy");
    expect(lines[2]).toContain("no dispatch history");
  });

  it("returns empty array for empty agent list", () => {
    expect(formatAgentHealthSection([], [])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatTimeAgo (issue #32)
// ────────────────────────────────────────────────────────────────────────────

describe("formatTimeAgo", () => {
  it("formats seconds ago", () => {
    const ts = new Date(Date.now() - 30 * 1000).toISOString();
    expect(formatTimeAgo(ts)).toBe("30s ago");
  });

  it("formats minutes ago", () => {
    const ts = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(formatTimeAgo(ts)).toBe("5m ago");
  });

  it("formats hours ago", () => {
    const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(ts)).toBe("3h ago");
  });

  it("formats days ago", () => {
    const ts = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatTimeAgo(ts)).toBe("2d ago");
  });

  it("returns 'just now' for future timestamps", () => {
    const ts = new Date(Date.now() + 60 * 1000).toISOString();
    expect(formatTimeAgo(ts)).toBe("just now");
  });

  it("returns 'just now' for invalid timestamps", () => {
    expect(formatTimeAgo("not-a-date")).toBe("just now");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatConflictStatsSection (issue #44)
// ────────────────────────────────────────────────────────────────────────────

describe("formatConflictStatsSection", () => {
  function makeStats(overrides: Partial<ConflictStats> = {}): ConflictStats {
    return {
      totalConflictEscalations: 0,
      totalAutoClosedConflictPRs: 0,
      totalStaleBranchNudges: 0,
      perRepo: {},
      ...overrides,
    };
  }

  it("returns empty array when there are no conflict events", () => {
    expect(formatConflictStatsSection(makeStats())).toEqual([]);
  });

  it("includes totals when there are escalations", () => {
    const lines = formatConflictStatsSection(
      makeStats({ totalConflictEscalations: 2 }),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("Conflict escalations"))).toBe(true);
    expect(lines.some((l) => l.includes("Estimated cycles lost"))).toBe(true);
  });

  it("includes stale-branch nudges in the summary", () => {
    const lines = formatConflictStatsSection(
      makeStats({ totalStaleBranchNudges: 3 }),
    );
    expect(lines.some((l) => l.includes("Stale-branch nudges"))).toBe(true);
  });

  it("does NOT add cycle-cost line when only stale nudges exist (no direct cycle loss)", () => {
    const lines = formatConflictStatsSection(
      makeStats({ totalStaleBranchNudges: 3 }),
    );
    // Stale nudges alone don't count as cycles lost (they're preventive)
    expect(lines.some((l) => l.includes("Estimated cycles lost"))).toBe(false);
  });

  it("lists conflict-prone repos sorted by total event count", () => {
    const stats = makeStats({
      totalConflictEscalations: 5,
      totalStaleBranchNudges: 2,
      perRepo: {
        "agent-proxy": { escalations: 1, autoCloses: 0, staleNudges: 1 },
        "agent-dashboard": { escalations: 4, autoCloses: 0, staleNudges: 1 },
      },
    });
    const lines = formatConflictStatsSection(stats);
    const repoLines = lines.filter((l) => l.includes("•"));
    // dashboard (5) should appear before proxy (2)
    expect(repoLines[0]).toContain("agent-dashboard");
    expect(repoLines[1]).toContain("agent-proxy");
  });

  it("omits repos with zero escalations and zero stale nudges", () => {
    const stats = makeStats({
      totalAutoClosedConflictPRs: 1,
      perRepo: {
        "agent-proxy": { escalations: 0, autoCloses: 1, staleNudges: 0 },
      },
    });
    const lines = formatConflictStatsSection(stats);
    // Repos only contributing auto-closes (not escalations or nudges) are omitted
    expect(lines.some((l) => l.includes("agent-proxy"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// detectNavelGazingRisk (agent-orchestrator#1258 fix #4)
// ────────────────────────────────────────────────────────────────────────────

describe("detectNavelGazingRisk", () => {
  const now = new Date("2026-04-27T12:00:00Z").getTime();

  const makeTask = (
    okr_tag: string | null,
    daysAgo: number,
    status: string = "done",
  ) => ({
    okr_tag,
    status,
    created_at: new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
  });

  it("returns atRisk=false when there are no completed tasks", () => {
    const result = detectNavelGazingRisk([], now);
    expect(result.atRisk).toBe(false);
    expect(result.totalTasks).toBe(0);
  });

  it("returns atRisk=false when at least one OKR-tagged task exists", () => {
    const tasks = [
      makeTask("OKR-1", 2),
      makeTask("internal", 1),
      makeTask(null, 3),
    ];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(false);
    expect(result.ocrAdvanceTasks).toBe(1);
  });

  it("returns atRisk=true when all tasks are internal", () => {
    const tasks = [makeTask("internal", 1), makeTask("internal", 3)];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(true);
    expect(result.internalTasks).toBe(2);
    expect(result.ocrAdvanceTasks).toBe(0);
  });

  it("returns atRisk=true when all tasks are untagged", () => {
    const tasks = [makeTask(null, 1), makeTask(null, 2)];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(true);
    expect(result.untaggedTasks).toBe(2);
    expect(result.ocrAdvanceTasks).toBe(0);
  });

  it("ignores tasks outside the 7-day rolling window", () => {
    const tasks = [
      makeTask("OKR-1", 10), // 10 days ago — outside window
      makeTask("internal", 1), // inside window
    ];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(true);
    expect(result.ocrAdvanceTasks).toBe(0);
    expect(result.totalTasks).toBe(1);
  });

  it("ignores non-done tasks", () => {
    const tasks = [
      makeTask("OKR-1", 1, "dispatched"),
      makeTask("internal", 1, "done"),
    ];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(true);
    expect(result.ocrAdvanceTasks).toBe(0);
  });

  it("records the most recent OKR advance timestamp", () => {
    const newerAt = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    const olderAt = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    const tasks = [
      { okr_tag: "OKR-2", status: "done", created_at: newerAt },
      { okr_tag: "OKR-3", status: "done", created_at: olderAt },
    ];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.lastOkrAdvanceAt).toBe(newerAt);
  });

  it("counts all OKR tag variants", () => {
    const tasks = [
      makeTask("OKR-1", 1),
      makeTask("OKR-2", 2),
      makeTask("OKR-3", 3),
      makeTask("OKR-4", 4),
    ];
    const result = detectNavelGazingRisk(tasks, now);
    expect(result.atRisk).toBe(false);
    expect(result.ocrAdvanceTasks).toBe(4);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// formatOkrContextSection (agent-orchestrator#1258 fix #4)
// ────────────────────────────────────────────────────────────────────────────

describe("formatOkrContextSection", () => {
  it("shows unknown status when no tasks in window", () => {
    const result = { atRisk: false, totalTasks: 0, ocrAdvanceTasks: 0, internalTasks: 0, untaggedTasks: 0, lastOkrAdvanceAt: null };
    const lines = formatOkrContextSection(result);
    expect(lines[0]).toContain("unknown");
  });

  it("includes NAVEL-GAZING RISK warning when atRisk is true", () => {
    const result = { atRisk: true, totalTasks: 5, ocrAdvanceTasks: 0, internalTasks: 3, untaggedTasks: 2, lastOkrAdvanceAt: null };
    const lines = formatOkrContextSection(result);
    expect(lines[0]).toContain("NAVEL-GAZING RISK");
    expect(lines[0]).toContain("ZERO");
  });

  it("shows OKR progress detected when not at risk", () => {
    const result = {
      atRisk: false,
      totalTasks: 3,
      ocrAdvanceTasks: 2,
      internalTasks: 1,
      untaggedTasks: 0,
      lastOkrAdvanceAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    const lines = formatOkrContextSection(result);
    expect(lines[0]).toContain("✅");
    expect(lines[0]).toContain("2/3");
  });

  it("includes breakdown line when non-zero counts exist", () => {
    const result = { atRisk: true, totalTasks: 4, ocrAdvanceTasks: 0, internalTasks: 2, untaggedTasks: 2, lastOkrAdvanceAt: null };
    const lines = formatOkrContextSection(result);
    const breakdownLine = lines.find((l) => l.includes("Breakdown"));
    expect(breakdownLine).toBeDefined();
    expect(breakdownLine).toContain("internal: 2");
    expect(breakdownLine).toContain("untagged: 2");
  });
});
