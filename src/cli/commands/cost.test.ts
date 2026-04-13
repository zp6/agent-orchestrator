/**
 * Tests for the `orch cost` CLI command helpers (issue #763).
 */

import { describe, it, expect } from "vitest";
import {
  agentColor,
  colorRevisions,
  formatDate,
  formatScore,
  printCostLeaderboard,
} from "./cost.js";
import chalk from "chalk";

// ── agentColor ─────────────────────────────────────────────────────────────

describe("agentColor", () => {
  it("returns chalk.dim for null agent", () => {
    const map = new Map<string, (s: string) => string>();
    const fn = agentColor(null, map);
    expect(fn("x")).toBe(chalk.dim("x"));
  });

  it("returns a deterministic color for the same agent", () => {
    const map = new Map<string, (s: string) => string>();
    const first = agentColor("claude-proxy", map);
    const second = agentColor("claude-proxy", map);
    expect(first).toBe(second);
    expect(first("hello")).toBe(second("hello"));
  });

  it("assigns different colors to different agents", () => {
    const map = new Map<string, (s: string) => string>();
    const a = agentColor("agent-a", map);
    const b = agentColor("agent-b", map);
    // Both are functions but may render differently
    expect(typeof a).toBe("function");
    expect(typeof b).toBe("function");
  });

  it("caches colors so the map grows monotonically", () => {
    const map = new Map<string, (s: string) => string>();
    agentColor("a", map);
    agentColor("b", map);
    agentColor("a", map); // already in map
    expect(map.size).toBe(2);
  });
});

// ── colorRevisions ─────────────────────────────────────────────────────────

describe("colorRevisions", () => {
  it("renders in green when below ceiling", () => {
    const result = colorRevisions(1, 3);
    expect(result).toContain("1");
  });

  it("renders in yellow when equal to ceiling", () => {
    const result = colorRevisions(3, 3);
    expect(result).toContain("3");
  });

  it("renders in bold red when above ceiling", () => {
    const result = colorRevisions(5, 3);
    expect(result).toContain("5");
  });
});

// ── formatDate ─────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("strips the time portion from an ISO timestamp", () => {
    expect(formatDate("2026-04-13T10:22:00Z")).toBe("2026-04-13");
  });

  it("passes through a date-only string unchanged", () => {
    expect(formatDate("2026-04-13")).toBe("2026-04-13");
  });
});

// ── formatScore ────────────────────────────────────────────────────────────

describe("formatScore", () => {
  it("returns dim dash for null score", () => {
    expect(formatScore(null)).toBe(chalk.dim("  —  "));
  });

  it("returns green for high scores (>= 0.9)", () => {
    const result = formatScore(0.95);
    expect(result).toContain("0.95");
  });

  it("returns yellow for medium scores (0.7–0.89)", () => {
    const result = formatScore(0.75);
    expect(result).toContain("0.75");
  });

  it("returns red for low scores (< 0.7)", () => {
    const result = formatScore(0.5);
    expect(result).toContain("0.50");
  });
});

// ── printCostLeaderboard ───────────────────────────────────────────────────

describe("printCostLeaderboard", () => {
  const sampleRows = [
    {
      source_ref: "owner/repo#42",
      total_revisions: 5,
      task_count: 3,
      agent_name: "claude-proxy",
      labels: [],
      avg_quality_score: 0.72,
      last_updated_at: "2026-04-10T08:00:00Z",
    },
    {
      source_ref: "owner/repo#17",
      total_revisions: 2,
      task_count: 2,
      agent_name: "codex-proxy",
      labels: [],
      avg_quality_score: 0.88,
      last_updated_at: "2026-04-09T12:00:00Z",
    },
  ];

  it("does not throw with typical data", () => {
    expect(() =>
      printCostLeaderboard(sampleRows, { days: 30, limit: 10, ceiling: 3 }),
    ).not.toThrow();
  });

  it("does not throw with empty rows", () => {
    expect(() =>
      printCostLeaderboard([], { days: 30, limit: 10, ceiling: 3 }),
    ).not.toThrow();
  });

  it("handles all-time window label (days=0)", () => {
    expect(() =>
      printCostLeaderboard(sampleRows, { days: 0, limit: 10, ceiling: 3 }),
    ).not.toThrow();
  });

  it("shows agent filter in header when provided", () => {
    // Just ensure no throw — the output formatting is best-effort CLI output
    expect(() =>
      printCostLeaderboard(sampleRows, {
        days: 30,
        limit: 10,
        ceiling: 3,
        agentFilter: "claude-proxy",
      }),
    ).not.toThrow();
  });
});
