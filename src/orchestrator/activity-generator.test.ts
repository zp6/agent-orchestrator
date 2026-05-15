import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  generateWeeklyActivityReport,
  getDirectorHighlights,
  getWeeklyClosedLinearIssues,
  getWeeklyMergedPRs,
  formatActivityReportAsMarkdown,
  type WeeklyActivityReport,
} from "./activity-generator.js";
import type { StateStore, MeetingRecord } from "../state/store.js";
import { execSync } from "child_process";

// Mock child_process at module level so Vitest's ESM resolver intercepts the
// import before activity-generator.ts loads it. The previous pattern used
// `vi.spyOn(require("child_process"), "execSync")` which does not work in ESM
// mode — `require` is unavailable so the spy is silently ignored and the real
// execSync runs `gh pr list` against 6 fleet repos (~400 ms each, ~2400 ms
// total per test). (#1523)
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue(""),
  };
});

const mockExecSync = vi.mocked(execSync);

describe("Activity Generator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getWeeklyMergedPRs", () => {
    it("returns PRs from this week only", async () => {
      const weekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const mockOutput = `{"number":123,"title":"Fix bug","author":{"login":"agent-1"},"mergedAt":"${new Date().toISOString()}","url":"https://github.com/..."}`;

      mockExecSync.mockReturnValue(mockOutput);

      const prs = await getWeeklyMergedPRs(7);

      expect(Array.isArray(prs)).toBe(true);
      expect(prs.every((pr) => new Date(pr.mergedAt) >= new Date(weekAgoDate))).toBe(true);
    });

    it("handles API errors gracefully", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Connection failed");
      });

      const prs = await getWeeklyMergedPRs(7);

      expect(prs).toEqual([]);
    });
  });

  describe("getWeeklyClosedLinearIssues", () => {
    it("returns issues from this week only", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      const weekAgoDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const mockResponse = {
        ok: true,
        json: async () => ({
          data: {
            team: {
              issues: {
                nodes: [
                  {
                    id: "issue-123",
                    identifier: "NEX-123",
                    title: "Test issue",
                    closedAt: new Date().toISOString(),
                    creator: { name: "Test User" },
                  },
                ],
              },
            },
          },
        }),
      };

      mockFetch.mockResolvedValue(mockResponse);

      const issues = await getWeeklyClosedLinearIssues(7);

      expect(Array.isArray(issues)).toBe(true);
      // Should have filtered by date
      if (issues.length > 0) {
        expect(new Date(issues[0]!.closedAt) >= new Date(weekAgoDate)).toBe(true);
      }
    });

    it("returns empty array when API key is missing", async () => {
      vi.mock("fs", () => ({
        readFileSync: () => "TELEGRAM_BOT_TOKEN=...",
      }));

      const issues = await getWeeklyClosedLinearIssues(7);

      expect(issues).toEqual([]);
    });

    it("returns empty array on API error", async () => {
      const mockFetch = vi.fn();
      global.fetch = mockFetch;

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
      });

      const issues = await getWeeklyClosedLinearIssues(7);

      expect(issues).toEqual([]);
    });
  });

  describe("getDirectorHighlights", () => {
    it("extracts action items from retro meetings", () => {
      const mockStore = {
        getMeetings: vi.fn().mockReturnValue([
          {
            type: "retrospective",
            date: new Date().toISOString(),
            synthesis: JSON.stringify({
              summary: "Great week",
              action_items: [
                { description: "Improve docs", owner: "agent-1" },
                { description: "Fix bugs", owner: "agent-2" },
              ],
            }),
          },
        ]),
      } as unknown as StateStore;

      const highlights = getDirectorHighlights(mockStore, 7);

      expect(Array.isArray(highlights)).toBe(true);
      expect(highlights.length).toBeGreaterThan(0);
      expect(highlights[0]?.actionItems.length).toBeGreaterThan(0);
    });

    it("filters out old meetings", () => {
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const mockStore = {
        getMeetings: vi.fn().mockReturnValue([
          {
            type: "retrospective",
            date: oldDate,
            synthesis: JSON.stringify({ summary: "Old", action_items: [] }),
          },
        ]),
      } as unknown as StateStore;

      const highlights = getDirectorHighlights(mockStore, 7);

      expect(highlights).toEqual([]);
    });

    it("handles malformed synthesis gracefully", () => {
      const mockStore = {
        getMeetings: vi.fn().mockReturnValue([
          {
            type: "retrospective",
            date: new Date().toISOString(),
            synthesis: "invalid json {{{",
          },
        ]),
      } as unknown as StateStore;

      const highlights = getDirectorHighlights(mockStore, 7);

      // Should return empty array, not throw
      expect(Array.isArray(highlights)).toBe(true);
    });
  });

  describe("generateWeeklyActivityReport", () => {
    it("aggregates all sources into single report", async () => {
      const mockStore = {
        getMeetings: vi.fn().mockReturnValue([]),
      } as unknown as StateStore;

      mockExecSync.mockReturnValue("");
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { team: { issues: { nodes: [] } } } }) });

      const report = await generateWeeklyActivityReport(mockStore, 7);

      expect(report).toHaveProperty("weekStart");
      expect(report).toHaveProperty("weekEnd");
      expect(report).toHaveProperty("prs");
      expect(report).toHaveProperty("linearIssues");
      expect(report).toHaveProperty("highlights");
      expect(report).toHaveProperty("totalPRs");
      expect(report).toHaveProperty("totalIssuesClosed");
      expect(report).toHaveProperty("agentSummary");
      expect(report).toHaveProperty("hasMeaningfulContent");

      expect(typeof report.weekStart).toBe("string");
      expect(Array.isArray(report.prs)).toBe(true);
      expect(Array.isArray(report.linearIssues)).toBe(true);
      expect(typeof report.hasMeaningfulContent).toBe("boolean");
    });

    it("computes hasMeaningfulContent correctly", async () => {
      const mockStore = {
        getMeetings: vi.fn().mockReturnValue([]),
      } as unknown as StateStore;

      mockExecSync.mockReturnValue("");
      global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { team: { issues: { nodes: [] } } } }) });

      const report = await generateWeeklyActivityReport(mockStore, 7);

      // Both empty = not meaningful
      expect(report.hasMeaningfulContent).toBe(report.prs.length + report.linearIssues.length > 0);
    });
  });

  describe("formatActivityReportAsMarkdown", () => {
    it("produces valid markdown with all sections", () => {
      const report: WeeklyActivityReport = {
        weekStart: "2026-05-03T00:00:00.000Z",
        weekEnd: "2026-05-09T23:59:59.999Z",
        prs: [
          {
            number: 123,
            title: "Fix bug",
            author: "agent-1",
            repo: "rapartlu/agent-orchestrator",
            mergedAt: "2026-05-05T10:00:00.000Z",
            url: "https://github.com/...",
          },
        ],
        linearIssues: [
          {
            id: "issue-1",
            identifier: "NEX-123",
            title: "Implement feature",
            closedAt: "2026-05-06T15:00:00.000Z",
            author: "agent-2",
            url: "https://linear.app/...",
          },
        ],
        highlights: [
          {
            title: "Great progress",
            actionItems: ["Improve docs", "Fix bugs"],
            date: "2026-05-07T09:00:00.000Z",
          },
        ],
        totalPRs: 1,
        totalIssuesClosed: 1,
        agentSummary: { "agent-1": { prs: 1, issues: 0 } },
        hasMeaningfulContent: true,
      };

      const markdown = formatActivityReportAsMarkdown(report);

      expect(markdown).toContain("## Week of");
      expect(markdown).toContain("Shipped PRs");
      expect(markdown).toContain("Fix bug");
      expect(markdown).toContain("Closed Issues");
      expect(markdown).toContain("NEX-123");
      expect(markdown).toContain("Director Highlights");
      expect(markdown).toContain("Great progress");
      expect(markdown).toContain("Agent Activity");
    });

    it("handles empty report gracefully", () => {
      const report: WeeklyActivityReport = {
        weekStart: "2026-05-03T00:00:00.000Z",
        weekEnd: "2026-05-09T23:59:59.999Z",
        prs: [],
        linearIssues: [],
        highlights: [],
        totalPRs: 0,
        totalIssuesClosed: 0,
        agentSummary: {},
        hasMeaningfulContent: false,
      };

      const markdown = formatActivityReportAsMarkdown(report);

      expect(markdown).toContain("## Week of");
      expect(typeof markdown).toBe("string");
      expect(markdown.length).toBeGreaterThan(0);
    });
  });
});
