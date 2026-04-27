/**
 * Tests for PR iteration tracking metrics (issue #110).
 *
 * Covers:
 *   1. categoriseReviewComment — keyword-based category extraction
 *   2. formatIterationReport   — Markdown formatter
 *   3. PRIterationMetrics      — wrapper around store queries
 *   4. StateStore              — recordPRReviewDetails + getPRIterationReport
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  categoriseReviewComment,
  formatIterationReport,
  PRIterationMetrics,
} from "../reviewer/pr-iteration-metrics.js";
import type { PRIterationReport } from "../state/types.js";
import { StateStore } from "../state/store.js";

// ── categoriseReviewComment ──────────────────────────────────────────────────

describe("categoriseReviewComment", () => {
  it("returns empty array for empty comment", () => {
    expect(categoriseReviewComment("")).toEqual([]);
    expect(categoriseReviewComment("   ")).toEqual([]);
  });

  it("returns ['other'] for unrecognised comment", () => {
    expect(categoriseReviewComment("LGTM — nice work!")).toEqual(["other"]);
  });

  it("categorises missing Closes reference", () => {
    const categories = categoriseReviewComment(
      "This PR is missing a Closes #N reference in the body.",
    );
    expect(categories).toContain("missing-closes-ref");
  });

  it("categorises merge conflicts", () => {
    const categories = categoriseReviewComment(
      "There are merge conflicts that must be resolved before this can be reviewed.",
    );
    expect(categories).toContain("merge-conflict");
  });

  it("categorises security issues", () => {
    const categories = categoriseReviewComment(
      "This exposes an API key directly in the source code — potential credential leak.",
    );
    expect(categories).toContain("security");
  });

  it("categorises missing tests", () => {
    const categories = categoriseReviewComment(
      "The new function lacks test coverage — please add unit tests.",
    );
    expect(categories).toContain("test-coverage");
  });

  it("categorises stale branch", () => {
    const categories = categoriseReviewComment(
      "Your branch is behind main — please rebase before merging.",
    );
    expect(categories).toContain("stale-branch");
  });

  it("categorises missing execution evidence", () => {
    const categories = categoriseReviewComment(
      "This response is largely narrative without concrete evidence of execution or command output.",
    );
    expect(categories).toContain("no-execution-evidence");
  });

  it("categorises logic errors", () => {
    const categories = categoriseReviewComment(
      "The logic error in the sort function returns wrong results for negative numbers.",
    );
    expect(categories).toContain("logic");
  });

  it("categorises diff-too-large", () => {
    const categories = categoriseReviewComment(
      "This PR's diff is too large for automated review — please split it.",
    );
    expect(categories).toContain("diff-too-large");
  });

  it("categorises schema-breaking", () => {
    const categories = categoriseReviewComment(
      "This PR introduces a breaking schema change that affects downstream consumers.",
    );
    expect(categories).toContain("schema-breaking");
  });

  it("categorises feedback-ceiling", () => {
    const categories = categoriseReviewComment(
      "This PR has hit the feedback ceiling — escalating after too many revision rounds.",
    );
    expect(categories).toContain("feedback-ceiling");
  });

  it("returns multiple categories when comment triggers several rules", () => {
    const categories = categoriseReviewComment(
      "Missing closes ref and the logic error causes incorrect behaviour.",
    );
    expect(categories).toContain("missing-closes-ref");
    expect(categories).toContain("logic");
    expect(categories.length).toBeGreaterThan(1);
  });
});

// ── formatIterationReport ────────────────────────────────────────────────────

describe("formatIterationReport", () => {
  const emptyReport: PRIterationReport = {
    generated_at: "2026-04-13T12:00:00.000Z",
    window_days: 30,
    multi_round_prs: [],
    agent_stats: [],
    top_categories: [],
  };

  it("renders header with window days", () => {
    const md = formatIterationReport(emptyReport);
    expect(md).toContain("last 30 days");
  });

  it("renders empty-state messages when no data", () => {
    const md = formatIterationReport(emptyReport);
    expect(md).toContain("No categorised review comments");
    expect(md).toContain("No agent-linked PR reviews");
    expect(md).toContain("No PRs required more than one review round");
  });

  it("renders top categories", () => {
    const report: PRIterationReport = {
      ...emptyReport,
      top_categories: [
        { category: "missing-closes-ref", count: 5 },
        { category: "logic", count: 3 },
      ],
    };
    const md = formatIterationReport(report);
    expect(md).toContain("missing-closes-ref");
    expect(md).toContain("5 occurrences");
    expect(md).toContain("logic");
    expect(md).toContain("3 occurrences");
  });

  it("renders agent stats", () => {
    const report: PRIterationReport = {
      ...emptyReport,
      agent_stats: [
        {
          agent_name: "claude-orchestrator-dashboard",
          total_prs: 10,
          multi_round_prs: 4,
          avg_rounds: 2.1,
          max_rounds: 5,
        },
      ],
    };
    const md = formatIterationReport(report);
    expect(md).toContain("claude-orchestrator-dashboard");
    expect(md).toContain("10 PRs");
    expect(md).toContain("avg 2.1 rounds");
    expect(md).toContain("max 5");
  });

  it("renders multi-round PRs", () => {
    const report: PRIterationReport = {
      ...emptyReport,
      multi_round_prs: [
        {
          repo: "rapartlu/agent-reviewer",
          pr_number: 42,
          agent_name: "claude-orchestrator-dashboard",
          review_count: 3,
          final_decision: "approve",
          first_review_at: "2026-04-01T10:00:00.000Z",
          last_review_at: "2026-04-05T10:00:00.000Z",
        },
      ],
    };
    const md = formatIterationReport(report);
    expect(md).toContain("rapartlu/agent-reviewer#42");
    expect(md).toContain("3 rounds");
    expect(md).toContain("approve");
  });

  it("truncates to 10 multi-round PRs with overflow note", () => {
    const prs = Array.from({ length: 15 }, (_, i) => ({
      repo: "rapartlu/agent-reviewer",
      pr_number: i + 1,
      agent_name: null,
      review_count: 2,
      final_decision: "approve",
      first_review_at: "2026-04-01T10:00:00.000Z",
      last_review_at: "2026-04-02T10:00:00.000Z",
    }));
    const md = formatIterationReport({ ...emptyReport, multi_round_prs: prs });
    expect(md).toContain("and 5 more");
  });
});

// ── PRIterationMetrics class ─────────────────────────────────────────────────

describe("PRIterationMetrics", () => {
  it("delegates buildReport() to the store", () => {
    const mockReport: PRIterationReport = {
      generated_at: "2026-04-13T12:00:00.000Z",
      window_days: 7,
      multi_round_prs: [],
      agent_stats: [],
      top_categories: [],
    };
    const store = { getPRIterationReport: vi.fn().mockReturnValue(mockReport) };
    const metrics = new PRIterationMetrics(store);

    const result = metrics.buildReport(7);
    expect(result).toBe(mockReport);
    expect(store.getPRIterationReport).toHaveBeenCalledWith(7);
  });

  it("buildFormattedReport() returns a non-empty string", () => {
    const store = {
      getPRIterationReport: vi.fn().mockReturnValue({
        generated_at: new Date().toISOString(),
        window_days: 30,
        multi_round_prs: [],
        agent_stats: [],
        top_categories: [],
      }),
    };
    const md = new PRIterationMetrics(store).buildFormattedReport();
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });
});

// ── StateStore.recordPRReviewDetails + getPRIterationReport ──────────────────

function makeTmpStore(): StateStore {
  const tmpFile = path.join(os.tmpdir(), `test-pr-iter-${Date.now()}.db`);
  return new StateStore(tmpFile);
}

describe("StateStore — PR iteration tracking", () => {
  let store: StateStore;

  beforeEach(() => {
    store = makeTmpStore();
  });

  it("recordPRReviewDetails persists review_number, agent_name, review_categories", () => {
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 99, "request-changes", {
      confidence: 0.8,
      agentName: "claude-orchestrator-dashboard",
      reviewCategories: ["logic", "test-coverage"],
    });

    const db = (store as unknown as { db: Database.Database }).db;
    const row = db
      .prepare("SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ?")
      .get("rapartlu/agent-reviewer", 99) as Record<string, unknown>;

    expect(row).toBeDefined();
    expect(row["review_number"]).toBe(1);
    expect(row["agent_name"]).toBe("claude-orchestrator-dashboard");
    expect(JSON.parse(row["review_categories"] as string)).toEqual(["logic", "test-coverage"]);
    expect(row["confidence"]).toBeCloseTo(0.8);
    expect(row["decision"]).toBe("request-changes");
  });

  it("auto-increments review_number for subsequent reviews on the same PR", () => {
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 100, "request-changes");
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 100, "request-changes");
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 100, "approve");

    const db = (store as unknown as { db: Database.Database }).db;
    const rows = db
      .prepare("SELECT review_number FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at ASC")
      .all("rapartlu/agent-reviewer", 100) as Array<{ review_number: number }>;

    expect(rows.map((r) => r.review_number)).toEqual([1, 2, 3]);
  });

  it("getPRIterationReport returns multi_round_prs for PRs with > 1 review", () => {
    // PR 200 has 2 reviews
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 200, "request-changes", {
      agentName: "agent-a",
      reviewCategories: ["logic"],
    });
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 200, "approve", {
      agentName: "agent-a",
    });

    // PR 201 has only 1 review — should NOT appear in multi_round_prs
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 201, "approve", {
      agentName: "agent-b",
    });

    const report = store.getPRIterationReport(30);

    expect(report.multi_round_prs).toHaveLength(1);
    expect(report.multi_round_prs[0].pr_number).toBe(200);
    expect(report.multi_round_prs[0].review_count).toBe(2);
  });

  it("getPRIterationReport returns agent_stats with correct aggregates", () => {
    // agent-a: 2 PRs, one multi-round (2 reviews), one single-round (1 review)
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 300, "request-changes", { agentName: "agent-a" });
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 300, "approve", { agentName: "agent-a" });
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 301, "approve", { agentName: "agent-a" });

    const report = store.getPRIterationReport(30);
    const agentStat = report.agent_stats.find((s) => s.agent_name === "agent-a");

    expect(agentStat).toBeDefined();
    expect(agentStat!.total_prs).toBe(2);
    expect(agentStat!.multi_round_prs).toBe(1);
    expect(agentStat!.max_rounds).toBe(2);
  });

  it("getPRIterationReport returns top_categories from review_categories JSON", () => {
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 400, "request-changes", {
      reviewCategories: ["logic", "security"],
    });
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 401, "request-changes", {
      reviewCategories: ["logic"],
    });

    const report = store.getPRIterationReport(30);
    const logicCat = report.top_categories.find((c) => c.category === "logic");
    const securityCat = report.top_categories.find((c) => c.category === "security");

    expect(logicCat?.count).toBe(2);
    expect(securityCat?.count).toBe(1);
    // logic appears most — should be first
    expect(report.top_categories[0].category).toBe("logic");
  });

  it("getPRIterationReport respects window_days — excludes old reviews", () => {
    // Insert a review with an old timestamp via raw SQL
    const db = (store as unknown as { db: Database.Database }).db;
    db.prepare(
      `INSERT INTO pr_reviews (id, repo, pr_number, decision, review_number, created_at)
       VALUES ('old-1', 'rapartlu/agent-reviewer', 500, 'request-changes', 1, datetime('now', '-60 days'))`,
    ).run();
    db.prepare(
      `INSERT INTO pr_reviews (id, repo, pr_number, decision, review_number, created_at)
       VALUES ('old-2', 'rapartlu/agent-reviewer', 500, 'approve', 2, datetime('now', '-59 days'))`,
    ).run();

    // Recent PR with multiple rounds
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 501, "request-changes");
    store.recordPRReviewDetails("rapartlu/agent-reviewer", 501, "approve");

    const report = store.getPRIterationReport(30);

    // Old PR 500 should not appear (outside 30-day window)
    const oldPR = report.multi_round_prs.find((p) => p.pr_number === 500);
    expect(oldPR).toBeUndefined();

    // Recent PR 501 should appear
    const recentPR = report.multi_round_prs.find((p) => p.pr_number === 501);
    expect(recentPR).toBeDefined();
  });
});
