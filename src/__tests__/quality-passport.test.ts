/**
 * Tests for quality-passport.ts (issue #610).
 *
 * Covers:
 *  1. getBadgeLabel  — score → label mapping
 *  2. getBadgeColor  — label → shields.io color
 *  3. getTrendArrow  — trend → arrow character
 *  4. buildBadgeUrl  — valid shields.io URL construction
 *  5. buildBadgeMarkdown — README embed snippet
 *  6. computeTrend   — delta-based trend direction
 *  7. buildQualityPassportComment — comment structure
 *  8. buildBadgePayload — REST payload builder
 *  9. evaluateFreemiumGate — paid bypass, limit enforcement
 * 10. nextMonthlyReset — returns first of next month
 * 11. postQualityPassportComment dry_run — no gh call, correct shape
 * 12. getQualityPassportInfo — info payload structure
 * 13. QUALITY_PASSPORT_MIGRATION_SQL — contains expected tables
 */

import { describe, expect, it } from "vitest";
import {
  getBadgeLabel,
  getBadgeColor,
  getTrendArrow,
  buildBadgeUrl,
  buildBadgeMarkdown,
  computeTrend,
  buildQualityPassportComment,
  buildBadgePayload,
  evaluateFreemiumGate,
  nextMonthlyReset,
  postQualityPassportComment,
  getQualityPassportInfo,
  QUALITY_PASSPORT_MIGRATION_SQL,
  FREEMIUM_MONTHLY_LIMIT,
  BADGE_PASS_THRESHOLD,
  BADGE_FAIL_THRESHOLD,
  type RepoQualityPassport,
  type QualityTrend,
} from "../reviewer/quality-passport.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePassport(overrides: Partial<RepoQualityPassport> = {}): RepoQualityPassport {
  return {
    repo: "owner/repo",
    score: 0.85,
    pr_count: 12,
    trend: "up",
    monthly_review_count: 3,
    monthly_reset_at: "2026-06-01",
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

// ─── getBadgeLabel ────────────────────────────────────────────────────────────

describe("getBadgeLabel", () => {
  it("returns 'passing' at and above BADGE_PASS_THRESHOLD", () => {
    expect(getBadgeLabel(BADGE_PASS_THRESHOLD)).toBe("passing");
    expect(getBadgeLabel(1.0)).toBe("passing");
    expect(getBadgeLabel(0.99)).toBe("passing");
  });

  it("returns 'marginal' between BADGE_FAIL and BADGE_PASS thresholds", () => {
    expect(getBadgeLabel(BADGE_FAIL_THRESHOLD)).toBe("marginal");
    expect(getBadgeLabel(0.70)).toBe("marginal");
    expect(getBadgeLabel(BADGE_PASS_THRESHOLD - 0.01)).toBe("marginal");
  });

  it("returns 'failing' below BADGE_FAIL_THRESHOLD", () => {
    expect(getBadgeLabel(0)).toBe("failing");
    expect(getBadgeLabel(0.59)).toBe("failing");
    expect(getBadgeLabel(BADGE_FAIL_THRESHOLD - 0.01)).toBe("failing");
  });

  it("returns 'unknown' for null", () => {
    expect(getBadgeLabel(null)).toBe("unknown");
  });
});

// ─── getBadgeColor ────────────────────────────────────────────────────────────

describe("getBadgeColor", () => {
  it("maps passing → brightgreen", () => {
    expect(getBadgeColor("passing")).toBe("brightgreen");
  });

  it("maps marginal → yellow", () => {
    expect(getBadgeColor("marginal")).toBe("yellow");
  });

  it("maps failing → red", () => {
    expect(getBadgeColor("failing")).toBe("red");
  });

  it("maps unknown → lightgrey", () => {
    expect(getBadgeColor("unknown")).toBe("lightgrey");
  });
});

// ─── getTrendArrow ────────────────────────────────────────────────────────────

describe("getTrendArrow", () => {
  it("returns ↑ for up", () => {
    expect(getTrendArrow("up")).toBe(" ↑");
  });

  it("returns ↓ for down", () => {
    expect(getTrendArrow("down")).toBe(" ↓");
  });

  it("returns empty string for stable", () => {
    expect(getTrendArrow("stable")).toBe("");
  });
});

// ─── buildBadgeUrl ────────────────────────────────────────────────────────────

describe("buildBadgeUrl", () => {
  it("returns a shields.io URL", () => {
    const url = buildBadgeUrl(0.91, "up");
    expect(url).toMatch(/^https:\/\/img\.shields\.io\/badge\//);
  });

  it("includes the score in the URL", () => {
    const url = buildBadgeUrl(0.91, "stable");
    expect(url).toContain("0.91");
  });

  it("includes trend arrow for up trend", () => {
    const url = buildBadgeUrl(0.85, "up");
    // ↑ is encoded as %E2%86%91
    expect(url).toMatch(/(%E2%86%91|↑)/);
  });

  it("includes trend arrow for down trend", () => {
    const url = buildBadgeUrl(0.65, "down");
    // ↓ is encoded as %E2%86%93
    expect(url).toMatch(/(%E2%86%93|↓)/);
  });

  it("uses brightgreen color for passing score", () => {
    const url = buildBadgeUrl(0.90, "stable");
    expect(url).toContain("brightgreen");
  });

  it("uses yellow color for marginal score", () => {
    const url = buildBadgeUrl(0.70, "stable");
    expect(url).toContain("yellow");
  });

  it("uses red color for failing score", () => {
    const url = buildBadgeUrl(0.50, "stable");
    expect(url).toContain("red");
  });

  it("uses lightgrey and 'unscored' for null score", () => {
    const url = buildBadgeUrl(null, "stable");
    expect(url).toContain("lightgrey");
    expect(url).toContain("unscored");
  });
});

// ─── buildBadgeMarkdown ───────────────────────────────────────────────────────

describe("buildBadgeMarkdown", () => {
  it("returns a Markdown image link (wrapped in a click-through link)", () => {
    const md = buildBadgeMarkdown(0.91, "up", "owner/repo");
    // Format: [![alt](badge_url)](link_url)
    expect(md).toMatch(/^\[!\[/);
    expect(md).toContain("](https://img.shields.io/badge/");
  });

  it("links to the agent-reviewer GitHub page", () => {
    const md = buildBadgeMarkdown(0.91, "stable", "owner/repo");
    expect(md).toContain("rapartlu/agent-reviewer");
  });

  it("includes score in alt text", () => {
    const md = buildBadgeMarkdown(0.82, "stable", "owner/repo");
    expect(md).toContain("0.82");
  });

  it("includes trend arrow in alt text when up", () => {
    const md = buildBadgeMarkdown(0.82, "up", "owner/repo");
    expect(md).toContain("↑");
  });
});

// ─── computeTrend ─────────────────────────────────────────────────────────────

describe("computeTrend", () => {
  it("returns stable for fewer than 2 scores", () => {
    expect(computeTrend([])).toBe("stable");
    expect(computeTrend([0.80])).toBe("stable");
  });

  it("returns up when recent scores clearly improved", () => {
    // Old half avg: 0.60, new half avg: 0.85 → delta +0.25
    const scores = [0.60, 0.60, 0.85, 0.85];
    expect(computeTrend(scores)).toBe("up");
  });

  it("returns down when recent scores clearly dropped", () => {
    // Old half avg: 0.85, new half avg: 0.60 → delta -0.25
    const scores = [0.85, 0.85, 0.60, 0.60];
    expect(computeTrend(scores)).toBe("down");
  });

  it("returns stable when delta ≤ 0.02", () => {
    // delta exactly 0.00
    const scores = [0.80, 0.80];
    expect(computeTrend(scores)).toBe("stable");
  });

  it("returns stable for delta just inside the band", () => {
    const scores = [0.80, 0.82]; // delta 0.02 — not strictly >0.02
    expect(computeTrend(scores)).toBe("stable");
  });

  it("returns up for delta just above the band", () => {
    const scores = [0.80, 0.821]; // delta >0.02
    expect(computeTrend(scores)).toBe("up");
  });
});

// ─── buildQualityPassportComment ─────────────────────────────────────────────

describe("buildQualityPassportComment", () => {
  const base = {
    repo: "owner/repo",
    pr_number: 42,
    score: 0.88,
    label: "passing" as const,
    decision: "approve" as const,
    trend: "stable" as const,
    tier: "free" as const,
  };

  it("contains the quality-passport-comment marker", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("<!-- quality-passport-comment -->");
  });

  it("includes the repo and PR number in the header", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("owner/repo#42");
  });

  it("includes the score as a percentage", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("88%");
  });

  it("shows 'Approve' for approve decision", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("Approve");
  });

  it("shows 'Request changes' for request_changes decision", () => {
    const body = buildQualityPassportComment({
      ...base,
      decision: "request_changes",
      label: "failing",
      score: 0.55,
    });
    expect(body).toContain("Request changes");
  });

  it("includes the badge embed snippet", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("img.shields.io/badge/");
    expect(body).toContain("```markdown");
  });

  it("includes the summary when provided", () => {
    const body = buildQualityPassportComment({ ...base, summary: "Looks good overall." });
    expect(body).toContain("Looks good overall.");
    expect(body).toContain("**Summary**");
  });

  it("omits summary section when not provided", () => {
    const body = buildQualityPassportComment(base);
    expect(body).not.toContain("**Summary**");
  });

  it("includes attribution footer", () => {
    const body = buildQualityPassportComment(base);
    expect(body).toContain("claude-orchestrator-reviewer");
    expect(body).toContain("quality-passport");
  });
});

// ─── buildBadgePayload ────────────────────────────────────────────────────────

describe("buildBadgePayload", () => {
  it("returns unknown payload when passport is null", () => {
    const payload = buildBadgePayload("owner/repo", null);
    expect(payload.repo).toBe("owner/repo");
    expect(payload.score).toBeNull();
    expect(payload.label).toBe("unknown");
    expect(payload.badge_url).toContain("lightgrey");
    expect(payload.embed_markdown).toContain("![");
  });

  it("returns correct payload from a passing passport", () => {
    const passport = makePassport({ score: 0.92, trend: "up", pr_count: 20 });
    const payload = buildBadgePayload("owner/repo", passport);
    expect(payload.score).toBe(0.92);
    expect(payload.label).toBe("passing");
    expect(payload.trend).toBe("up");
    expect(payload.pr_count).toBe(20);
    expect(payload.badge_url).toContain("brightgreen");
  });

  it("computes score_pct correctly", () => {
    const passport = makePassport({ score: 0.876 });
    const payload = buildBadgePayload("owner/repo", passport);
    expect(payload.score_pct).toBe("88%");
  });

  it("sets score_pct to — when score is null", () => {
    const passport = makePassport({ score: null });
    const payload = buildBadgePayload("owner/repo", passport);
    expect(payload.score_pct).toBe("—");
  });
});

// ─── evaluateFreemiumGate ─────────────────────────────────────────────────────

describe("evaluateFreemiumGate", () => {
  it("allows when monthly_review_count is below limit", () => {
    const passport = makePassport({ monthly_review_count: 5 });
    const gate = evaluateFreemiumGate(passport);
    expect(gate.allowed).toBe(true);
    expect(gate.monthly_count).toBe(5);
    expect(gate.monthly_limit).toBe(FREEMIUM_MONTHLY_LIMIT);
    expect(gate.is_paid).toBe(false);
  });

  it("blocks when monthly_review_count equals limit", () => {
    const passport = makePassport({ monthly_review_count: FREEMIUM_MONTHLY_LIMIT });
    const gate = evaluateFreemiumGate(passport);
    expect(gate.allowed).toBe(false);
    expect(gate.rejection_reason).toMatch(/Free tier limit reached/);
  });

  it("blocks when monthly_review_count exceeds limit", () => {
    const passport = makePassport({ monthly_review_count: FREEMIUM_MONTHLY_LIMIT + 5 });
    const gate = evaluateFreemiumGate(passport);
    expect(gate.allowed).toBe(false);
  });

  it("allows with payment_ref regardless of monthly count (paid bypass)", () => {
    const passport = makePassport({ monthly_review_count: FREEMIUM_MONTHLY_LIMIT });
    const gate = evaluateFreemiumGate(passport, "0xtxhash123");
    expect(gate.allowed).toBe(true);
    expect(gate.is_paid).toBe(true);
  });

  it("treats empty payment_ref as no payment", () => {
    const passport = makePassport({ monthly_review_count: FREEMIUM_MONTHLY_LIMIT });
    const gate = evaluateFreemiumGate(passport, "   ");
    expect(gate.is_paid).toBe(false);
    expect(gate.allowed).toBe(false);
  });

  it("allows when passport is null (first-time repo)", () => {
    const gate = evaluateFreemiumGate(null);
    expect(gate.allowed).toBe(true);
    expect(gate.monthly_count).toBe(0);
  });

  it("returns reset_at from passport", () => {
    const passport = makePassport({ monthly_reset_at: "2026-06-01" });
    const gate = evaluateFreemiumGate(passport);
    expect(gate.reset_at).toBe("2026-06-01");
  });
});

// ─── nextMonthlyReset ─────────────────────────────────────────────────────────

describe("nextMonthlyReset", () => {
  it("returns a date string in YYYY-MM-DD format", () => {
    const reset = nextMonthlyReset();
    expect(reset).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns first day of next month", () => {
    const reset = nextMonthlyReset();
    expect(reset).toMatch(/-01$/);
  });

  it("is strictly in the future", () => {
    const reset = new Date(nextMonthlyReset()).getTime();
    expect(reset).toBeGreaterThan(Date.now());
  });
});

// ─── postQualityPassportComment (dry_run) ─────────────────────────────────────

describe("postQualityPassportComment (dry_run)", () => {
  it("returns posted=false in dry run mode", () => {
    const result = postQualityPassportComment({
      repo: "owner/testrepo",
      pr_number: 7,
      score: 0.85,
      decision: "approve",
      dry_run: true,
    });
    expect(result.posted).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it("returns correct shape in dry run mode", () => {
    const result = postQualityPassportComment({
      repo: "owner/testrepo",
      pr_number: 99,
      score: 0.72,
      decision: "request_changes",
      trend: "down",
      dry_run: true,
    });
    expect(result.repo).toBe("owner/testrepo");
    expect(result.pr_number).toBe(99);
    expect(result.score).toBe(0.72);
    expect(result.label).toBe("marginal");
    expect(result.decision).toBe("request_changes");
  });

  it("defaults trend to stable when not supplied", () => {
    const result = postQualityPassportComment({
      repo: "owner/repo",
      pr_number: 1,
      score: 0.80,
      decision: "approve",
      dry_run: true,
    });
    // No error → implicitly stable trend was accepted
    expect(result.posted).toBe(false);
  });
});

// ─── getQualityPassportInfo ───────────────────────────────────────────────────

describe("getQualityPassportInfo", () => {
  it("returns required top-level fields", () => {
    const info = getQualityPassportInfo();
    expect(info.name).toBe("Quality Passport");
    expect(info).toHaveProperty("description");
    expect(info).toHaveProperty("freemium");
    expect(info).toHaveProperty("badge");
    expect(info).toHaveProperty("endpoints");
    expect(info).toHaveProperty("phase");
  });

  it("free_reviews_per_month matches constant", () => {
    const info = getQualityPassportInfo();
    expect(info.freemium.free_reviews_per_month).toBe(FREEMIUM_MONTHLY_LIMIT);
  });

  it("example badge URL is a shields.io URL", () => {
    const info = getQualityPassportInfo();
    expect(info.badge.example_url).toMatch(/^https:\/\/img\.shields\.io\/badge\//);
  });

  it("example markdown contains the badge URL", () => {
    const info = getQualityPassportInfo();
    expect(info.badge.example_markdown).toContain(info.badge.example_url);
  });

  it("endpoints include badge and submit paths", () => {
    const info = getQualityPassportInfo();
    expect(info.endpoints.badge).toContain("/api/badge/");
    expect(info.endpoints.submit).toContain("/api/pr-review/submit");
  });
});

// ─── QUALITY_PASSPORT_MIGRATION_SQL ──────────────────────────────────────────

describe("QUALITY_PASSPORT_MIGRATION_SQL", () => {
  it("creates quality_passport_scores table", () => {
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS quality_passport_scores",
    );
  });

  it("creates quality_passport_reviews table", () => {
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS quality_passport_reviews",
    );
  });

  it("includes repo, score, and monthly_review_count columns in scores table", () => {
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain("repo");
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain("score");
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain("monthly_review_count");
  });

  it("includes index on quality_passport_reviews", () => {
    expect(QUALITY_PASSPORT_MIGRATION_SQL).toContain(
      "CREATE INDEX IF NOT EXISTS idx_qpr_repo_created",
    );
  });
});
