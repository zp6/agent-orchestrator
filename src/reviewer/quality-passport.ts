/**
 * Quality Passport — per-repo PR review score badge and comment posting.
 *
 * Implements the "quality passport" concept from issue #610:
 *   - Tracks rolling quality scores per external repo
 *   - Generates shields.io badge URLs embeddable in READMEs
 *   - Posts structured score comments on PRs (Phase 1 experiment)
 *   - Enforces freemium gate: 10 free reviews/month, then paid tiers
 *   - Exposes `GET /api/badge/:owner/:repo` REST payload builder
 *   - Exposes `GET /api/quality-passport/info` public capability docs
 *
 * Phase 1: Manual experiment — post one quality score comment on a public OSS
 *   PR using postQualityPassportComment(). Measure maintainer response.
 *
 * Phase 2: Webhook infrastructure — POST /api/pr-review/submit triggers
 *   quality passport scoring + badge update for any installed repo.
 *
 * Phase 3: Aggregate scores → dependency risk signal (B2B upsell).
 *
 * SQL (run once at startup via ensureQualityPassportTables()):
 *   quality_passport_scores     — per-repo rolling score + freemium counter
 *   quality_passport_reviews    — per-PR review history
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import { REVIEWER_PORT } from "../config/fleet-config.js";

const log = createLogger("quality-passport");

// ─── Constants ────────────────────────────────────────────────────────────────

/** Free tier: max reviews per repo per calendar month. */
export const FREEMIUM_MONTHLY_LIMIT = 10;

/** Minimum score to earn the "passing" badge label. */
export const BADGE_PASS_THRESHOLD = 0.75;

/** Score floor below which the badge label is "failing". */
export const BADGE_FAIL_THRESHOLD = 0.60;

/** Window (in PRs) used to compute the rolling score trend. */
export const TREND_WINDOW = 5;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Trend direction based on recent score delta. */
export type QualityTrend = "up" | "down" | "stable";

/** Human-readable badge label from score. */
export type BadgeLabel = "passing" | "marginal" | "failing" | "unknown";

/** Per-repo quality passport state (stored in quality_passport_scores). */
export interface RepoQualityPassport {
  /** GitHub repo slug: "owner/repo". */
  repo: string;
  /** Rolling average quality score (0–1). null until first review. */
  score: number | null;
  /** Total PRs reviewed for this repo. */
  pr_count: number;
  /** Score trend based on last TREND_WINDOW reviews. */
  trend: QualityTrend;
  /** Monthly review count (resets at monthly_reset_at). */
  monthly_review_count: number;
  /** ISO date when the monthly counter next resets. */
  monthly_reset_at: string;
  /** ISO timestamp of most recent score update. */
  last_updated: string;
}

/** Badge payload for GET /api/badge/:owner/:repo. */
export interface QualityBadgePayload {
  repo: string;
  score: number | null;
  score_pct: string;
  label: BadgeLabel;
  trend: QualityTrend;
  pr_count: number;
  /** shields.io redirect URL — embed directly in README as an <img>. */
  badge_url: string;
  /** Markdown ![quality](badge_url) snippet for README embed. */
  embed_markdown: string;
  /** ISO timestamp of last score computation. */
  last_updated: string;
}

/** Result of posting a quality passport comment on a PR. */
export interface QualityPassportCommentResult {
  repo: string;
  pr_number: number;
  score: number;
  label: BadgeLabel;
  decision: "approve" | "request_changes" | "escalate";
  /** GitHub comment URL if posted successfully. */
  comment_url?: string;
  /** Whether the comment was successfully posted. */
  posted: boolean;
  error?: string;
}

/** Freemium gate evaluation result. */
export interface FreemiumGateResult {
  /** Whether the request is within the free tier or has paid access. */
  allowed: boolean;
  monthly_count: number;
  monthly_limit: number;
  /** true if the caller provided a valid payment ref (any tier). */
  is_paid: boolean;
  /** ISO date when the monthly counter resets. */
  reset_at: string;
  /** Human-readable rejection reason (only set when allowed=false). */
  rejection_reason?: string;
}

/** Minimal store interface (subset of StateStore) required by this module. */
export interface IQualityPassportStore {
  /** Ensure tables exist (idempotent). */
  ensureQualityPassportTables(): void;
  /** Upsert or return the passport row for a repo. */
  getOrCreatePassport(repo: string): RepoQualityPassport;
  /** Record a completed review and update rolling score + trend. */
  recordPassportReview(opts: {
    repo: string;
    pr_number: number;
    score: number;
    decision: string;
    tier: string;
  }): RepoQualityPassport;
  /** Increment the monthly review counter; return false if over limit. */
  checkAndIncrementFreemiumCounter(repo: string): FreemiumGateResult;
  /** Return recent review scores for trend computation. */
  getRecentScores(repo: string, limit: number): number[];
}

// ─── Badge generation ─────────────────────────────────────────────────────────

/**
 * Returns the badge label for a given score.
 *
 * - passing   ≥ BADGE_PASS_THRESHOLD (0.75)
 * - marginal  ≥ BADGE_FAIL_THRESHOLD (0.60) && < BADGE_PASS_THRESHOLD
 * - failing   <  BADGE_FAIL_THRESHOLD
 * - unknown   when score is null
 */
export function getBadgeLabel(score: number | null): BadgeLabel {
  if (score === null) return "unknown";
  if (score >= BADGE_PASS_THRESHOLD) return "passing";
  if (score >= BADGE_FAIL_THRESHOLD) return "marginal";
  return "failing";
}

/**
 * Returns the shields.io color for a badge label.
 *
 * passing  → brightgreen
 * marginal → yellow
 * failing  → red
 * unknown  → lightgrey
 */
export function getBadgeColor(label: BadgeLabel): string {
  switch (label) {
    case "passing":  return "brightgreen";
    case "marginal": return "yellow";
    case "failing":  return "red";
    case "unknown":  return "lightgrey";
  }
}

/**
 * Returns the trend arrow suffix appended to the score string in the badge.
 *
 * up   → ↑
 * down → ↓
 * stable → (no suffix)
 */
export function getTrendArrow(trend: QualityTrend): string {
  switch (trend) {
    case "up":     return " ↑";
    case "down":   return " ↓";
    case "stable": return "";
  }
}

/**
 * Builds a shields.io static badge URL for the given repo score.
 *
 * Format: quality: 0.91 ↑  (brightgreen)
 *
 * The URL is a shields.io endpoint badge so it renders immediately without
 * requiring any server-side endpoint.
 *
 * Example:
 *   https://img.shields.io/badge/quality-0.91%20%E2%86%91-brightgreen
 */
export function buildBadgeUrl(score: number | null, trend: QualityTrend): string {
  const label = getBadgeLabel(score);
  const color = getBadgeColor(label);

  let rightText: string;
  if (score === null) {
    rightText = "unscored";
  } else {
    const pct = score.toFixed(2);
    const arrow = getTrendArrow(trend);
    rightText = `${pct}${arrow}`;
  }

  // shields.io static badge: /badge/<left>-<right>-<color>
  // We percent-encode spaces as %20 and special chars.
  const left = encodeURIComponent("quality");
  const right = encodeURIComponent(rightText);
  return `https://img.shields.io/badge/${left}-${right}-${color}`;
}

/**
 * Builds the Markdown snippet for embedding the badge in a README.
 *
 * Example:
 *   [![quality: 0.91 ↑](https://img.shields.io/badge/quality-0.91%20%E2%86%91-brightgreen)](https://github.com/rapartlu/agent-reviewer)
 */
export function buildBadgeMarkdown(
  score: number | null,
  trend: QualityTrend,
  repoSlug: string,
): string {
  const badgeUrl = buildBadgeUrl(score, trend);
  const scoreFmt = score !== null ? score.toFixed(2) : "unscored";
  const arrow = getTrendArrow(trend);
  const altText = `quality: ${scoreFmt}${arrow}`;
  const linkUrl = `https://github.com/rapartlu/agent-reviewer`;
  return `[![${altText}](${badgeUrl})](${linkUrl})`;
}

// ─── Score comment format ─────────────────────────────────────────────────────

/**
 * Builds the Markdown comment body that is posted on the reviewed PR.
 *
 * Designed to be concise and non-intrusive for maintainers — leads with the
 * score, surfaces the decision clearly, and offers the badge embed snippet.
 */
export function buildQualityPassportComment(opts: {
  repo: string;
  pr_number: number;
  score: number;
  label: BadgeLabel;
  decision: "approve" | "request_changes" | "escalate";
  trend: QualityTrend;
  summary?: string;
  tier: "free" | "basic" | "deep";
}): string {
  const { repo, pr_number, score, label, decision, trend, summary, tier } = opts;

  const emoji: Record<BadgeLabel, string> = {
    passing:  "✅",
    marginal: "⚠️",
    failing:  "❌",
    unknown:  "❓",
  };

  const decisionText: Record<string, string> = {
    approve:          "**Approve** — changes look good",
    request_changes:  "**Request changes** — issues found (see below)",
    escalate:         "**Escalate** — human review recommended",
  };

  const badgeMarkdown = buildBadgeMarkdown(score, trend, repo);
  const scoreLine = `${emoji[label]} **Quality score: ${(score * 100).toFixed(0)}%** (${label}${getTrendArrow(trend)})`;

  const lines: string[] = [
    "<!-- quality-passport-comment -->",
    `### 🔍 Fleet PR Review — \`${repo}#${pr_number}\``,
    "",
    scoreLine,
    `> Decision: ${decisionText[decision] ?? decision}`,
    "",
  ];

  if (summary) {
    lines.push("**Summary**", "", summary, "");
  }

  lines.push(
    "---",
    "",
    "**Add this badge to your README** to show your repo's review quality:",
    "",
    "```markdown",
    badgeMarkdown,
    "```",
    "",
    `_Reviewed by [claude-orchestrator-reviewer](https://github.com/rapartlu/agent-reviewer) · ` +
    `Tier: ${tier} · [How it works](https://github.com/rapartlu/agent-reviewer#quality-passport)_`,
  );

  return lines.join("\n");
}

// ─── Comment posting ──────────────────────────────────────────────────────────

/**
 * Posts a quality passport score comment on a GitHub PR using the `gh` CLI.
 *
 * This is the Phase 1 manual experiment entry point. Call it with a real
 * public OSS PR to validate maintainer response before building the full App.
 *
 * Returns a result object — never throws. Errors are captured in result.error.
 */
export function postQualityPassportComment(opts: {
  repo: string;
  pr_number: number;
  score: number;
  decision: "approve" | "request_changes" | "escalate";
  trend?: QualityTrend;
  summary?: string;
  tier?: "free" | "basic" | "deep";
  /** If true, skip actual gh CLI call (dry run for testing). */
  dry_run?: boolean;
}): QualityPassportCommentResult {
  const {
    repo,
    pr_number,
    score,
    decision,
    trend = "stable",
    summary,
    tier = "free",
    dry_run = false,
  } = opts;

  const label = getBadgeLabel(score);
  const body = buildQualityPassportComment({ repo, pr_number, score, label, decision, trend, summary, tier });

  if (dry_run) {
    log.info("quality-passport dry run — skipping gh post", { repo, pr_number, score, decision });
    return { repo, pr_number, score, label, decision, posted: false };
  }

  try {
    // Post the comment via gh CLI
    const escaped = body.replace(/'/g, "'\\''");
    const cmd = `gh pr comment ${pr_number} --repo ${repo} --body '${escaped}'`;
    const out = execSync(cmd, { encoding: "utf8", timeout: 30_000 });
    // gh prints the comment URL on success
    const comment_url = out.trim() || undefined;
    log.info("quality-passport comment posted", { repo, pr_number, score, decision, comment_url });
    return { repo, pr_number, score, label, decision, comment_url, posted: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error("quality-passport comment failed", { repo, pr_number, error });
    return { repo, pr_number, score, label, decision, posted: false, error };
  }
}

// ─── Trend computation ────────────────────────────────────────────────────────

/**
 * Computes the trend direction from a list of recent scores (oldest first).
 *
 * Uses the delta between the average of the first half and the second half
 * of the window:
 *   delta > +0.02  → up
 *   delta < -0.02  → down
 *   otherwise      → stable
 *
 * Returns "stable" for windows with fewer than 2 scores.
 */
export function computeTrend(recentScores: number[]): QualityTrend {
  if (recentScores.length < 2) return "stable";

  const mid = Math.floor(recentScores.length / 2);
  const oldHalf = recentScores.slice(0, mid);
  const newHalf = recentScores.slice(mid);

  const avg = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const delta = avg(newHalf) - avg(oldHalf);

  if (delta > 0.02) return "up";
  if (delta < -0.02) return "down";
  return "stable";
}

// ─── Badge REST payload ───────────────────────────────────────────────────────

/**
 * Builds the GET /api/badge/:owner/:repo response payload.
 *
 * Pass a store or a pre-fetched passport; if neither is available returns
 * a "not yet scored" placeholder payload.
 */
export function buildBadgePayload(
  repo: string,
  passport: RepoQualityPassport | null,
): QualityBadgePayload {
  if (!passport) {
    const badgeUrl = buildBadgeUrl(null, "stable");
    return {
      repo,
      score: null,
      score_pct: "—",
      label: "unknown",
      trend: "stable",
      pr_count: 0,
      badge_url: badgeUrl,
      embed_markdown: buildBadgeMarkdown(null, "stable", repo),
      last_updated: new Date().toISOString(),
    };
  }

  const { score, trend, pr_count, last_updated } = passport;
  const label = getBadgeLabel(score);
  const badgeUrl = buildBadgeUrl(score, trend);

  return {
    repo,
    score,
    score_pct: score !== null ? `${(score * 100).toFixed(0)}%` : "—",
    label,
    trend,
    pr_count,
    badge_url: badgeUrl,
    embed_markdown: buildBadgeMarkdown(score, trend, repo),
    last_updated,
  };
}

// ─── Public capability info ───────────────────────────────────────────────────

/**
 * Returns the GET /api/quality-passport/info payload describing the service
 * to new potential adopters.
 */
export function getQualityPassportInfo(): {
  name: string;
  description: string;
  freemium: { free_reviews_per_month: number; paid_tiers: string[] };
  badge: { format: string; example_url: string; example_markdown: string };
  endpoints: { badge: string; submit: string; info: string };
  phase: string;
} {
  const exampleScore = 0.91;
  const exampleTrend: QualityTrend = "up";
  const exampleBadgeUrl = buildBadgeUrl(exampleScore, exampleTrend);
  const exampleMarkdown = buildBadgeMarkdown(exampleScore, exampleTrend, "owner/repo");

  return {
    name: "Quality Passport",
    description:
      "Autonomous AI fleet PR review service. Install the Quality Passport to " +
      "get per-PR quality scores posted as comments and a public badge for your README. " +
      `Free tier: ${FREEMIUM_MONTHLY_LIMIT} reviews/month. ` +
      "Paid tiers: Basic ($0.10/PR) · Deep ($0.50/PR).",
    freemium: {
      free_reviews_per_month: FREEMIUM_MONTHLY_LIMIT,
      paid_tiers: ["basic ($0.10/PR)", "deep ($0.50/PR)"],
    },
    badge: {
      format: "shields.io static badge: quality: <score> <trend>",
      example_url: exampleBadgeUrl,
      example_markdown: exampleMarkdown,
    },
    endpoints: {
      badge:  `http://localhost:${REVIEWER_PORT}/api/badge/:owner/:repo`,
      submit: `http://localhost:${REVIEWER_PORT}/api/pr-review/submit`,
      info:   `http://localhost:${REVIEWER_PORT}/api/quality-passport/info`,
    },
    phase: "Phase 1 (manual experiment) — Phase 2 App webhook coming soon",
  };
}

// ─── Freemium gate (stateless helper) ─────────────────────────────────────────

/**
 * Evaluates freemium gate status from a passport row.
 *
 * This is the stateless helper; the stateful version (which also persists
 * the increment) lives on IQualityPassportStore.checkAndIncrementFreemiumCounter.
 */
export function evaluateFreemiumGate(
  passport: RepoQualityPassport | null,
  paymentRef?: string,
): FreemiumGateResult {
  const is_paid = typeof paymentRef === "string" && paymentRef.trim().length > 0;

  if (is_paid) {
    // Paid tier bypasses the freemium counter
    const reset_at = passport?.monthly_reset_at ?? nextMonthlyReset();
    return {
      allowed: true,
      monthly_count: passport?.monthly_review_count ?? 0,
      monthly_limit: FREEMIUM_MONTHLY_LIMIT,
      is_paid: true,
      reset_at,
    };
  }

  const count = passport?.monthly_review_count ?? 0;
  const reset_at = passport?.monthly_reset_at ?? nextMonthlyReset();

  if (count >= FREEMIUM_MONTHLY_LIMIT) {
    return {
      allowed: false,
      monthly_count: count,
      monthly_limit: FREEMIUM_MONTHLY_LIMIT,
      is_paid: false,
      reset_at,
      rejection_reason:
        `Free tier limit reached (${count}/${FREEMIUM_MONTHLY_LIMIT} reviews this month). ` +
        `Resets ${reset_at}. Submit with payment_ref for paid access.`,
    };
  }

  return {
    allowed: true,
    monthly_count: count,
    monthly_limit: FREEMIUM_MONTHLY_LIMIT,
    is_paid: false,
    reset_at,
  };
}

/** Returns the ISO date string for the first day of next month (UTC). */
export function nextMonthlyReset(): string {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

// ─── SQL migration helpers ─────────────────────────────────────────────────────

/**
 * DDL strings for the quality passport tables.
 * Call MIGRATE_QUALITY_PASSPORT_SQL at startup (idempotent).
 */
export const QUALITY_PASSPORT_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS quality_passport_scores (
  repo                  TEXT    PRIMARY KEY,
  score                 REAL,
  pr_count              INTEGER NOT NULL DEFAULT 0,
  trend                 TEXT    NOT NULL DEFAULT 'stable',
  monthly_review_count  INTEGER NOT NULL DEFAULT 0,
  monthly_reset_at      TEXT    NOT NULL,
  last_updated          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_passport_reviews (
  id           TEXT    PRIMARY KEY,
  repo         TEXT    NOT NULL,
  pr_number    INTEGER NOT NULL,
  score        REAL    NOT NULL,
  decision     TEXT    NOT NULL,
  tier         TEXT    NOT NULL DEFAULT 'free',
  comment_body TEXT,
  comment_url  TEXT,
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qpr_repo_created
  ON quality_passport_reviews (repo, created_at DESC);
`.trim();
