/**
 * Tests for the Bug Bounty Board module (issue #620).
 *
 * Covers:
 *  - getBountyBoardInfo() structure
 *  - validateBountyReportRequest() input validation
 *  - generateCouponCode() format
 *  - registerBountyPR() idempotency
 *  - getBountyBoardPayload() and getBountyLeaderboardPayload()
 *  - submitBountyReport() persistence and status determination
 *  - parseBountyReportIdFromPath()
 *  - evaluateBountyReport() fallback when API key is missing
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  BUG_BOUNTY_MIGRATION_SQL,
  BOUNTY_CREDIT_VALUE_CENTS,
  BOUNTY_CONFIRM_THRESHOLD,
  BOUNTY_REJECT_THRESHOLD,
  COUPON_CODE_PREFIX,
  BOUNTY_PR_WINDOW,
  getBountyBoardInfo,
  getBountyBoardPayload,
  getBountyLeaderboardPayload,
  getBountyReport,
  generateCouponCode,
  validateBountyReportRequest,
  submitBountyReport,
  registerBountyPR,
  parseBountyReportIdFromPath,
  evaluateBountyReport,
} from "../reviewer/bug-bounty-board.js";
import type {
  IBountyBoardStore,
  BountyReportRequest,
  BountyEligiblePR,
} from "../reviewer/bug-bounty-board.js";

// ─── In-memory store helper ───────────────────────────────────────────────────

function makeStore(): IBountyBoardStore {
  const db = new Database(":memory:");
  db.exec(BUG_BOUNTY_MIGRATION_SQL);
  return db;
}

function seedPR(store: IBountyBoardStore, overrides: Partial<BountyEligiblePR> = {}): BountyEligiblePR {
  const pr: BountyEligiblePR = {
    id: overrides.id ?? "rapartlu/agent-reviewer#42",
    repo: overrides.repo ?? "rapartlu/agent-reviewer",
    pr_number: overrides.pr_number ?? 42,
    title: overrides.title ?? "Test PR: fix null pointer",
    merged_at: overrides.merged_at ?? "2026-05-01T10:00:00Z",
    author: overrides.author ?? "dev-bot",
    diff_excerpt: overrides.diff_excerpt ?? "- const x = foo.bar;\n+ const x = foo?.bar ?? 0;",
    pr_url: overrides.pr_url ?? "https://github.com/rapartlu/agent-reviewer/pull/42",
    reviewer_score: overrides.reviewer_score ?? 0.82,
    added_at: overrides.added_at ?? new Date().toISOString(),
  };
  registerBountyPR(store, {
    repo: pr.repo,
    pr_number: pr.pr_number,
    title: pr.title,
    merged_at: pr.merged_at,
    author: pr.author,
    pr_url: pr.pr_url,
    reviewer_score: pr.reviewer_score,
    diff: pr.diff_excerpt,
  });
  return pr;
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("BOUNTY_CREDIT_VALUE_CENTS is 500 ($5.00)", () => {
    expect(BOUNTY_CREDIT_VALUE_CENTS).toBe(500);
  });

  it("COUPON_CODE_PREFIX is BOUNTY", () => {
    expect(COUPON_CODE_PREFIX).toBe("BOUNTY");
  });

  it("BOUNTY_CONFIRM_THRESHOLD >= BOUNTY_REJECT_THRESHOLD", () => {
    expect(BOUNTY_CONFIRM_THRESHOLD).toBeGreaterThan(BOUNTY_REJECT_THRESHOLD);
  });

  it("BOUNTY_PR_WINDOW > 0", () => {
    expect(BOUNTY_PR_WINDOW).toBeGreaterThan(0);
  });
});

// ─── getBountyBoardInfo ───────────────────────────────────────────────────────

describe("getBountyBoardInfo()", () => {
  it("returns a valid info object with required fields", () => {
    const info = getBountyBoardInfo();
    expect(info.name).toBeTruthy();
    expect(info.description).toBeTruthy();
    expect(info.prize.value_usd).toBe(5);
    expect(info.prize.type).toBe("review_credit");
    expect(Array.isArray(info.eligibility)).toBe(true);
    expect(info.eligibility.length).toBeGreaterThan(0);
    expect(Array.isArray(info.how_to_participate)).toBe(true);
    expect(Array.isArray(info.endpoints)).toBe(true);
  });

  it("endpoints list includes all expected routes", () => {
    const info = getBountyBoardInfo();
    const paths = info.endpoints.map((e) => e.path);
    expect(paths).toContain("/api/bounty/info");
    expect(paths).toContain("/api/bounty/prs");
    expect(paths).toContain("/api/bounty/report");
    expect(paths).toContain("/api/bounty/leaderboard");
    expect(paths).toContain("/api/bounty/report/:id");
  });

  it("includes a POST /api/bounty/report endpoint", () => {
    const info = getBountyBoardInfo();
    const postReport = info.endpoints.find((e) => e.method === "POST" && e.path === "/api/bounty/report");
    expect(postReport).toBeDefined();
  });
});

// ─── generateCouponCode ───────────────────────────────────────────────────────

describe("generateCouponCode()", () => {
  it("returns a string matching BOUNTY-XXXX-XXXX format", () => {
    const code = generateCouponCode();
    expect(code).toMatch(/^BOUNTY-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it("generates unique codes on successive calls", () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateCouponCode()));
    // With 8 hex chars of randomness, collisions in 20 samples are astronomically rare
    expect(codes.size).toBeGreaterThan(15);
  });
});

// ─── validateBountyReportRequest ─────────────────────────────────────────────

describe("validateBountyReportRequest()", () => {
  it("returns error for non-object", () => {
    expect(validateBountyReportRequest(null)).not.toBeNull();
    expect(validateBountyReportRequest("string")).not.toBeNull();
    expect(validateBountyReportRequest(42)).not.toBeNull();
  });

  it("returns error when pr_id is missing", () => {
    expect(validateBountyReportRequest({ hunter_handle: "bob", description: "x".repeat(25) })).toMatch(/pr_id/);
  });

  it("returns error when hunter_handle is missing", () => {
    expect(validateBountyReportRequest({ pr_id: "foo#1", description: "x".repeat(25) })).toMatch(/hunter_handle/);
  });

  it("returns error when description is missing", () => {
    expect(validateBountyReportRequest({ pr_id: "foo#1", hunter_handle: "bob" })).toMatch(/description/);
  });

  it("returns error when description is too short", () => {
    expect(validateBountyReportRequest({ pr_id: "foo#1", hunter_handle: "bob", description: "short" })).toMatch(/20 char/);
  });

  it("returns null for a valid request", () => {
    const valid = {
      pr_id: "rapartlu/agent-reviewer#42",
      hunter_handle: "alice",
      description: "The null check is missing on line 42, causing a crash when foo is undefined.",
    };
    expect(validateBountyReportRequest(valid)).toBeNull();
  });
});

// ─── registerBountyPR ────────────────────────────────────────────────────────

describe("registerBountyPR()", () => {
  it("inserts a PR into bounty_eligible_prs", () => {
    const store = makeStore();
    registerBountyPR(store, {
      repo: "rapartlu/agent-reviewer",
      pr_number: 99,
      title: "Fix bug #99",
      merged_at: "2026-05-02T12:00:00Z",
      pr_url: "https://github.com/rapartlu/agent-reviewer/pull/99",
      reviewer_score: 0.90,
    });
    const row = store.prepare("SELECT * FROM bounty_eligible_prs WHERE id = ?")
      .get("rapartlu/agent-reviewer#99") as BountyEligiblePR | null;
    expect(row).not.toBeNull();
    expect(row?.pr_number).toBe(99);
    expect(row?.reviewer_score).toBe(0.90);
  });

  it("is idempotent — duplicate inserts do not throw", () => {
    const store = makeStore();
    const opts = {
      repo: "rapartlu/agent-reviewer",
      pr_number: 100,
      title: "Idempotent PR",
      merged_at: "2026-05-02T12:00:00Z",
      pr_url: "https://github.com/rapartlu/agent-reviewer/pull/100",
    };
    expect(() => {
      registerBountyPR(store, opts);
      registerBountyPR(store, opts);
    }).not.toThrow();
  });
});

// ─── getBountyBoardPayload ────────────────────────────────────────────────────

describe("getBountyBoardPayload()", () => {
  it("returns empty prs list when no PRs registered", () => {
    const store = makeStore();
    const payload = getBountyBoardPayload(store);
    expect(payload.prs).toEqual([]);
    expect(payload.total).toBe(0);
    expect(payload.window).toBe(BOUNTY_PR_WINDOW);
    expect(payload.generated_at).toBeTruthy();
  });

  it("returns registered PRs in reverse-chronological order", () => {
    const store = makeStore();
    registerBountyPR(store, {
      repo: "rapartlu/agent-reviewer",
      pr_number: 1,
      title: "Older PR",
      merged_at: "2026-04-01T00:00:00Z",
      pr_url: "https://github.com/rapartlu/agent-reviewer/pull/1",
    });
    registerBountyPR(store, {
      repo: "rapartlu/agent-reviewer",
      pr_number: 2,
      title: "Newer PR",
      merged_at: "2026-05-01T00:00:00Z",
      pr_url: "https://github.com/rapartlu/agent-reviewer/pull/2",
    });
    const payload = getBountyBoardPayload(store);
    expect(payload.prs.length).toBe(2);
    expect(payload.prs[0].pr_number).toBe(2); // newer first
    expect(payload.prs[1].pr_number).toBe(1);
  });
});

// ─── getBountyLeaderboardPayload ─────────────────────────────────────────────

describe("getBountyLeaderboardPayload()", () => {
  it("returns empty leaderboard when no reports submitted", () => {
    const store = makeStore();
    const payload = getBountyLeaderboardPayload(store);
    expect(payload.hunters).toEqual([]);
    expect(payload.total_confirmed_bugs).toBe(0);
    expect(payload.total_credits_issued_usd).toBe(0);
    expect(payload.generated_at).toBeTruthy();
  });
});

// ─── getBountyReport ─────────────────────────────────────────────────────────

describe("getBountyReport()", () => {
  it("returns null for unknown report ID", () => {
    const store = makeStore();
    expect(getBountyReport(store, "nonexistent")).toBeNull();
  });
});

// ─── parseBountyReportIdFromPath ──────────────────────────────────────────────

describe("parseBountyReportIdFromPath()", () => {
  it("extracts report ID from valid path", () => {
    expect(parseBountyReportIdFromPath("/api/bounty/report/br_12345_abc")).toBe("br_12345_abc");
  });

  it("returns null for non-matching paths", () => {
    expect(parseBountyReportIdFromPath("/api/bounty/prs")).toBeNull();
    expect(parseBountyReportIdFromPath("/api/bounty/report")).toBeNull();
    expect(parseBountyReportIdFromPath("/api/bounty/report/foo/bar")).toBeNull();
  });
});

// ─── evaluateBountyReport — no API key ───────────────────────────────────────

describe("evaluateBountyReport() without API key", () => {
  it("returns needs_info verdict when ANTHROPIC_API_KEY is not set", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const pr: BountyEligiblePR = {
      id: "rapartlu/agent-reviewer#1",
      repo: "rapartlu/agent-reviewer",
      pr_number: 1,
      title: "Test",
      merged_at: "2026-05-01T00:00:00Z",
      author: "bot",
      diff_excerpt: "- old\n+ new",
      pr_url: "https://github.com/rapartlu/agent-reviewer/pull/1",
      reviewer_score: 0.85,
      added_at: new Date().toISOString(),
    };
    const request: BountyReportRequest = {
      pr_id: pr.id,
      hunter_handle: "alice",
      description: "Null pointer exception when foo is undefined on line 42.",
    };

    const verdict = await evaluateBountyReport(pr, request, "");
    expect(verdict.suggested_action).toBe("needs_info");
    expect(verdict.confidence).toBe(0);

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });
});

// ─── submitBountyReport ───────────────────────────────────────────────────────

describe("submitBountyReport()", () => {
  it("returns error when pr_id is not on the board", async () => {
    const store = makeStore();
    const { report, error } = await submitBountyReport(
      store,
      { pr_id: "nonexistent#1", hunter_handle: "alice", description: "x".repeat(30) },
      "", // no API key → no LLM call anyway
    );
    expect(error).toBeTruthy();
    expect(error).toMatch(/not found/i);
  });

  it("persists a report and upserts hunter stats (no API key → needs_info)", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const store = makeStore();
    seedPR(store);

    const { report, error } = await submitBountyReport(
      store,
      {
        pr_id: "rapartlu/agent-reviewer#42",
        hunter_handle: "bob",
        description: "When the input is undefined the parser throws ReferenceError on line 7.",
        evidence: "Steps: call parse(undefined) and observe the stack trace.",
      },
      "",
    );

    expect(error).toBeUndefined();
    expect(report.id).toMatch(/^br_/);
    expect(report.status).toBe("needs_info");
    expect(report.hunter_handle).toBe("bob");
    expect(report.coupon_code).toBeNull();

    // Verify persistence
    const persisted = getBountyReport(store, report.id);
    expect(persisted).not.toBeNull();
    expect(persisted?.hunter_handle).toBe("bob");

    // Hunter should appear in leaderboard
    const leaderboard = getBountyLeaderboardPayload(store);
    const hunter = leaderboard.hunters.find((h) => h.handle === "bob");
    expect(hunter).toBeDefined();
    expect(hunter?.pending_reports).toBe(1);

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("does not issue a coupon when status is needs_info", async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const store = makeStore();
    seedPR(store);

    const { report } = await submitBountyReport(
      store,
      {
        pr_id: "rapartlu/agent-reviewer#42",
        hunter_handle: "charlie",
        description: "The error handling path silently swallows exceptions from the parser.",
      },
      "",
    );

    expect(report.coupon_code).toBeNull();

    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });
});
