/**
 * Bug Bounty Board — public crowdsourced defect detection for fleet-merged PRs.
 *
 * Implements issue #620: expose recently-merged fleet PRs publicly and invite
 * external developers to earn $5 review credits by finding confirmed bugs.
 *
 * Flow:
 *   1. Fleet daemon syncs recently-merged PRs into `bounty_eligible_prs`.
 *   2. External devs call GET /api/bounty/prs to browse the board.
 *   3. A dev submits a bug report via POST /api/bounty/report.
 *   4. The LLM validates the claim (real bug vs. noise).
 *   5. Confirmed bugs → coupon code issued; hunter credited on leaderboard.
 *   6. GET /api/bounty/leaderboard shows top hunters.
 *
 * Connection to other features:
 *   - Confirmed catches feed back into score_calibrator (reviewer quality signal).
 *   - Leaderboard hunters are natural quality-passport early adopters (#610).
 *
 * SQL (executed via ensureBountyBoardTables() at startup):
 *   bounty_eligible_prs   — merged PRs listed on the board
 *   bounty_reports        — submitted bug reports
 *   bounty_hunters        — aggregate stats per external submitter
 *   bounty_coupons        — issued coupon codes for confirmed catches
 *
 * Endpoints to mount in server.ts:
 *   GET  /api/bounty/info           — programme overview + prize details
 *   GET  /api/bounty/prs            — list board-eligible merged PRs
 *   POST /api/bounty/report         — submit a bug report
 *   GET  /api/bounty/leaderboard    — top external hunters
 *   GET  /api/bounty/report/:id     — fetch report status
 */

import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../service/logger.js";

const log = createLogger("bug-bounty-board");

// ─── Constants ────────────────────────────────────────────────────────────────

/** Reward credit value for each confirmed bug catch (USD cents). */
export const BOUNTY_CREDIT_VALUE_CENTS = 500; // $5.00

/** How many recently-merged PRs to surface on the board. */
export const BOUNTY_PR_WINDOW = 20;

/** Minimum LLM confidence (0–1) to auto-confirm a report as a real bug. */
export const BOUNTY_CONFIRM_THRESHOLD = 0.75;

/** Minimum LLM confidence to auto-reject a report as noise. */
export const BOUNTY_REJECT_THRESHOLD = 0.30;

/** Max length of the diff excerpt stored in the DB (chars). */
export const BOUNTY_DIFF_EXCERPT_MAX = 8_000;

/** Coupon prefix so codes are recognisable at checkout. */
export const COUPON_CODE_PREFIX = "BOUNTY";

// ─── SQL ──────────────────────────────────────────────────────────────────────

export const BUG_BOUNTY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS bounty_eligible_prs (
  id              TEXT PRIMARY KEY,        -- "owner/repo#number"
  repo            TEXT NOT NULL,
  pr_number       INTEGER NOT NULL,
  title           TEXT NOT NULL,
  merged_at       TEXT NOT NULL,
  author          TEXT NOT NULL DEFAULT '',
  diff_excerpt    TEXT NOT NULL DEFAULT '',
  pr_url          TEXT NOT NULL,
  reviewer_score  REAL,                    -- quality score at merge time
  added_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bounty_prs_repo_num
  ON bounty_eligible_prs (repo, pr_number);

CREATE TABLE IF NOT EXISTS bounty_reports (
  id              TEXT PRIMARY KEY,
  pr_id           TEXT NOT NULL,           -- FK → bounty_eligible_prs.id
  hunter_handle   TEXT NOT NULL,           -- GitHub handle or email
  description     TEXT NOT NULL,           -- the claimed bug
  evidence        TEXT NOT NULL DEFAULT '', -- code snippet / repro steps
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|confirmed|rejected|needs_info
  llm_verdict     TEXT,                    -- raw LLM response
  llm_confidence  REAL,
  llm_reasoning   TEXT,
  coupon_code     TEXT,                    -- populated when confirmed
  submitted_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_bounty_reports_pr_id
  ON bounty_reports (pr_id);

CREATE INDEX IF NOT EXISTS idx_bounty_reports_hunter
  ON bounty_reports (hunter_handle);

CREATE TABLE IF NOT EXISTS bounty_hunters (
  handle              TEXT PRIMARY KEY,
  confirmed_bugs      INTEGER NOT NULL DEFAULT 0,
  rejected_reports    INTEGER NOT NULL DEFAULT 0,
  pending_reports     INTEGER NOT NULL DEFAULT 0,
  total_credits_usd   REAL NOT NULL DEFAULT 0.0,
  first_submission_at TEXT NOT NULL,
  last_submission_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bounty_coupons (
  code        TEXT PRIMARY KEY,
  report_id   TEXT NOT NULL,
  hunter_handle TEXT NOT NULL,
  value_cents INTEGER NOT NULL DEFAULT 500,
  issued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at TEXT
);
`;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Status of a submitted bug report. */
export type BountyReportStatus = "pending" | "confirmed" | "rejected" | "needs_info";

/** A merged PR eligible for bug hunting. */
export interface BountyEligiblePR {
  id: string;
  repo: string;
  pr_number: number;
  title: string;
  merged_at: string;
  author: string;
  /** Truncated diff excerpt for display on the board. */
  diff_excerpt: string;
  pr_url: string;
  reviewer_score: number | null;
  added_at: string;
}

/** A bug report submitted by an external hunter. */
export interface BountyReport {
  id: string;
  pr_id: string;
  hunter_handle: string;
  description: string;
  evidence: string;
  status: BountyReportStatus;
  llm_verdict: string | null;
  llm_confidence: number | null;
  llm_reasoning: string | null;
  coupon_code: string | null;
  submitted_at: string;
  resolved_at: string | null;
}

/** Leaderboard entry for an external bug hunter. */
export interface BountyHunterStats {
  handle: string;
  confirmed_bugs: number;
  rejected_reports: number;
  pending_reports: number;
  total_credits_usd: number;
  first_submission_at: string;
  last_submission_at: string;
}

/** LLM verdict on a submitted bug report. */
export interface BountyVerdictResult {
  is_real_bug: boolean;
  confidence: number;
  reasoning: string;
  severity: "critical" | "high" | "medium" | "low" | "not_a_bug";
  suggested_action: "confirm" | "reject" | "needs_info";
}

/** Request body for POST /api/bounty/report. */
export interface BountyReportRequest {
  pr_id: string;
  hunter_handle: string;
  description: string;
  evidence?: string;
}

/** Payload for GET /api/bounty/prs. */
export interface BountyBoardPayload {
  prs: BountyEligiblePR[];
  total: number;
  window: number;
  generated_at: string;
}

/** Payload for GET /api/bounty/leaderboard. */
export interface BountyLeaderboardPayload {
  hunters: BountyHunterStats[];
  total_confirmed_bugs: number;
  total_credits_issued_usd: number;
  generated_at: string;
}

/** Payload for GET /api/bounty/info. */
export interface BountyBoardInfo {
  name: string;
  description: string;
  prize: { value_usd: number; type: string; description: string };
  eligibility: string[];
  how_to_participate: string[];
  endpoints: Array<{ method: string; path: string; description: string }>;
  repo: string;
  contact: string;
}

/** Minimal store interface required by this module. */
export interface IBountyBoardStore {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

// ─── Info payload ─────────────────────────────────────────────────────────────

/**
 * GET /api/bounty/info — programme overview returned as JSON.
 */
export function getBountyBoardInfo(): BountyBoardInfo {
  return {
    name: "claude-orchestrator Bug Bounty Board",
    description:
      "Find real bugs in fleet-merged PRs and earn $5 review credits. " +
      "Every confirmed catch directly teaches the AI reviewer what it missed, " +
      "making the whole fleet smarter.",
    prize: {
      value_usd: BOUNTY_CREDIT_VALUE_CENTS / 100,
      type: "review_credit",
      description:
        "A $5 credit toward the PR Review API (Basic or Deep tier). " +
        "Credits are issued as single-use coupon codes sent to the " +
        "email/handle provided on submission.",
    },
    eligibility: [
      "Any external developer (not a fleet agent or orchestrator maintainer)",
      "Bug must be in a listed merged PR — not a feature request or style nit",
      "Bug must be verifiable: runtime failure, data loss, security vulnerability, or logical error",
      "First valid report per bug wins the bounty",
    ],
    how_to_participate: [
      "Browse GET /api/bounty/prs for recently-merged PRs",
      "Find a real bug in the diff (runtime error, logic flaw, security issue)",
      "Submit via POST /api/bounty/report with the pr_id, your GitHub handle, and clear reproduction steps",
      "The LLM reviews your report within seconds",
      "Confirmed bugs → coupon code emailed / returned in the response",
    ],
    endpoints: [
      { method: "GET",  path: "/api/bounty/info",           description: "This endpoint — programme overview" },
      { method: "GET",  path: "/api/bounty/prs",            description: "List board-eligible merged PRs with diff excerpts" },
      { method: "POST", path: "/api/bounty/report",         description: "Submit a bug report against a listed PR" },
      { method: "GET",  path: "/api/bounty/leaderboard",    description: "Top external bug hunters" },
      { method: "GET",  path: "/api/bounty/report/:id",     description: "Fetch report status and verdict" },
    ],
    repo: "https://github.com/rapartlu/agent-reviewer",
    contact: "https://github.com/rapartlu/agent-reviewer/issues",
  };
}

// ─── Board payload ────────────────────────────────────────────────────────────

/**
 * Build the GET /api/bounty/prs payload from stored eligible PRs.
 */
export function getBountyBoardPayload(store: IBountyBoardStore): BountyBoardPayload {
  const rows = store.prepare(`
    SELECT id, repo, pr_number, title, merged_at, author, diff_excerpt,
           pr_url, reviewer_score, added_at
    FROM bounty_eligible_prs
    ORDER BY merged_at DESC
    LIMIT ?
  `).all(BOUNTY_PR_WINDOW) as BountyEligiblePR[];

  return {
    prs: rows,
    total: rows.length,
    window: BOUNTY_PR_WINDOW,
    generated_at: new Date().toISOString(),
  };
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

/**
 * Build the GET /api/bounty/leaderboard payload.
 */
export function getBountyLeaderboardPayload(store: IBountyBoardStore): BountyLeaderboardPayload {
  const hunters = store.prepare(`
    SELECT handle, confirmed_bugs, rejected_reports, pending_reports,
           total_credits_usd, first_submission_at, last_submission_at
    FROM bounty_hunters
    ORDER BY confirmed_bugs DESC, total_credits_usd DESC
    LIMIT 25
  `).all() as BountyHunterStats[];

  const totals = store.prepare(`
    SELECT
      COALESCE(SUM(confirmed_bugs), 0) AS total_confirmed_bugs,
      COALESCE(SUM(total_credits_usd), 0) AS total_credits_issued_usd
    FROM bounty_hunters
  `).get() as { total_confirmed_bugs: number; total_credits_issued_usd: number } | undefined;

  return {
    hunters,
    total_confirmed_bugs: totals?.total_confirmed_bugs ?? 0,
    total_credits_issued_usd: totals?.total_credits_issued_usd ?? 0,
    generated_at: new Date().toISOString(),
  };
}

// ─── Report status fetch ──────────────────────────────────────────────────────

/**
 * Fetch a single report by ID for GET /api/bounty/report/:id.
 */
export function getBountyReport(store: IBountyBoardStore, reportId: string): BountyReport | null {
  const row = store.prepare(`
    SELECT id, pr_id, hunter_handle, description, evidence, status,
           llm_verdict, llm_confidence, llm_reasoning, coupon_code,
           submitted_at, resolved_at
    FROM bounty_reports
    WHERE id = ?
  `).get(reportId) as BountyReport | undefined;
  return row ?? null;
}

// ─── Coupon generation ────────────────────────────────────────────────────────

/**
 * Generate a unique, human-readable coupon code.
 * Format: BOUNTY-XXXX-XXXX (hex, uppercase).
 */
export function generateCouponCode(): string {
  const part1 = randomBytes(2).toString("hex").toUpperCase();
  const part2 = randomBytes(2).toString("hex").toUpperCase();
  return `${COUPON_CODE_PREFIX}-${part1}-${part2}`;
}

// ─── LLM validation ───────────────────────────────────────────────────────────

/** Build the LLM prompt for validating a bug report against a PR diff. */
function buildVerdictPrompt(
  pr: BountyEligiblePR,
  report: BountyReportRequest,
): string {
  return `You are a senior code reviewer evaluating a bug report submitted to a public bug bounty programme.

## PR Under Review
- **Repo**: ${pr.repo}
- **PR number**: #${pr.pr_number}
- **Title**: ${pr.title}
- **URL**: ${pr.pr_url}
- **Merged at**: ${pr.merged_at}
- **Reviewer score at merge**: ${pr.reviewer_score ?? "unknown"}

## Diff Excerpt
\`\`\`
${pr.diff_excerpt.slice(0, 4_000)}
\`\`\`

## Submitted Bug Report
- **Hunter**: ${report.hunter_handle}
- **Description**: ${report.description}
- **Evidence / Repro steps**:
${report.evidence ?? "(none provided)"}

## Your Task
Determine whether the submitted report describes a *real, verifiable bug* in the merged code.

A real bug is one of:
1. Runtime failure: code that will throw, panic, or crash in plausible conditions
2. Logic error: incorrect output or behaviour that deviates from the obvious intent
3. Security vulnerability: authentication bypass, injection, data leakage, etc.
4. Data loss or corruption: irreversible destruction of user data

Style nits, naming preferences, missing comments, and "could be improved" suggestions are NOT bugs.

Respond in this exact JSON format (no markdown, no explanation outside the JSON):
{
  "is_real_bug": true | false,
  "confidence": 0.0–1.0,
  "severity": "critical" | "high" | "medium" | "low" | "not_a_bug",
  "reasoning": "2–4 sentence explanation referencing specific code in the diff",
  "suggested_action": "confirm" | "reject" | "needs_info"
}`;
}

/**
 * Call the LLM to evaluate whether a bug report describes a real defect.
 * Returns a structured verdict.
 */
export async function evaluateBountyReport(
  pr: BountyEligiblePR,
  report: BountyReportRequest,
  apiKey?: string,
): Promise<BountyVerdictResult> {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!key) {
    log.warn("ANTHROPIC_API_KEY not set — returning needs_info verdict");
    return {
      is_real_bug: false,
      confidence: 0,
      reasoning: "LLM evaluation unavailable (API key not configured).",
      severity: "not_a_bug",
      suggested_action: "needs_info",
    };
  }

  const client = new Anthropic({ apiKey: key });
  const prompt = buildVerdictPrompt(pr, report);

  try {
    const response = await client.messages.create({
      model: process.env.REVIEWER_MODEL ?? "claude-sonnet-4-5",
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Parse the JSON verdict
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON found in LLM response: ${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(jsonMatch[0]) as {
      is_real_bug: boolean;
      confidence: number;
      severity: string;
      reasoning: string;
      suggested_action: string;
    };

    return {
      is_real_bug: Boolean(parsed.is_real_bug),
      confidence: Number(parsed.confidence ?? 0),
      reasoning: String(parsed.reasoning ?? ""),
      severity: (parsed.severity ?? "not_a_bug") as BountyVerdictResult["severity"],
      suggested_action: (parsed.suggested_action ?? "needs_info") as BountyVerdictResult["suggested_action"],
    };
  } catch (err) {
    log.error("LLM verdict failed", { err: String(err) });
    return {
      is_real_bug: false,
      confidence: 0,
      reasoning: `Evaluation error: ${String(err).slice(0, 200)}`,
      severity: "not_a_bug",
      suggested_action: "needs_info",
    };
  }
}

// ─── Report submission ────────────────────────────────────────────────────────

/**
 * Validate the raw POST body for a bug report submission.
 * Returns an error string if invalid, or null if OK.
 */
export function validateBountyReportRequest(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Request body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (!b.pr_id || typeof b.pr_id !== "string") return "pr_id (string) is required";
  if (!b.hunter_handle || typeof b.hunter_handle !== "string") return "hunter_handle (string) is required";
  if (!b.description || typeof b.description !== "string") return "description (string) is required";
  if ((b.description as string).trim().length < 20)
    return "description must be at least 20 characters";
  return null;
}

/**
 * Process a new bug report submission end-to-end:
 *   1. Validate input
 *   2. Look up the eligible PR
 *   3. Call LLM for verdict
 *   4. Persist result
 *   5. Issue coupon if confirmed
 *   6. Update hunter leaderboard stats
 *
 * Returns the persisted BountyReport.
 */
export async function submitBountyReport(
  store: IBountyBoardStore,
  body: BountyReportRequest,
  apiKey?: string,
): Promise<{ report: BountyReport; error?: string }> {
  // Look up the PR
  const pr = store.prepare(
    `SELECT id, repo, pr_number, title, merged_at, author, diff_excerpt,
            pr_url, reviewer_score, added_at
     FROM bounty_eligible_prs WHERE id = ?`,
  ).get(body.pr_id) as BountyEligiblePR | null;

  if (!pr) {
    return {
      report: {} as BountyReport,
      error: `PR not found on bounty board: ${body.pr_id}`,
    };
  }

  // Generate report ID
  const reportId = `br_${Date.now()}_${randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();

  // Evaluate with LLM
  const verdict = await evaluateBountyReport(pr, body, apiKey);

  // Determine status from verdict
  let status: BountyReportStatus = "pending";
  if (verdict.suggested_action === "confirm" && verdict.confidence >= BOUNTY_CONFIRM_THRESHOLD) {
    status = "confirmed";
  } else if (verdict.suggested_action === "reject" && verdict.confidence >= BOUNTY_REJECT_THRESHOLD) {
    status = "rejected";
  } else if (verdict.suggested_action === "needs_info") {
    status = "needs_info";
  }

  // Generate coupon if confirmed
  let couponCode: string | null = null;
  if (status === "confirmed") {
    couponCode = generateCouponCode();
    store.prepare(`
      INSERT INTO bounty_coupons (code, report_id, hunter_handle, value_cents, issued_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(couponCode, reportId, body.hunter_handle, BOUNTY_CREDIT_VALUE_CENTS, now);
  }

  // Persist the report
  store.prepare(`
    INSERT INTO bounty_reports
      (id, pr_id, hunter_handle, description, evidence, status,
       llm_verdict, llm_confidence, llm_reasoning, coupon_code, submitted_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reportId,
    body.pr_id,
    body.hunter_handle,
    body.description,
    body.evidence ?? "",
    status,
    verdict.severity,
    verdict.confidence,
    verdict.reasoning,
    couponCode,
    now,
    status !== "pending" ? now : null,
  );

  // Upsert hunter leaderboard
  const existing = store.prepare(
    `SELECT confirmed_bugs, rejected_reports, pending_reports, total_credits_usd
     FROM bounty_hunters WHERE handle = ?`,
  ).get(body.hunter_handle) as BountyHunterStats | null;

  if (!existing) {
    store.prepare(`
      INSERT INTO bounty_hunters
        (handle, confirmed_bugs, rejected_reports, pending_reports,
         total_credits_usd, first_submission_at, last_submission_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.hunter_handle,
      status === "confirmed" ? 1 : 0,
      status === "rejected" ? 1 : 0,
      status === "pending" || status === "needs_info" ? 1 : 0,
      status === "confirmed" ? BOUNTY_CREDIT_VALUE_CENTS / 100 : 0,
      now,
      now,
    );
  } else {
    store.prepare(`
      UPDATE bounty_hunters SET
        confirmed_bugs   = confirmed_bugs   + ?,
        rejected_reports = rejected_reports + ?,
        pending_reports  = pending_reports  + ?,
        total_credits_usd = total_credits_usd + ?,
        last_submission_at = ?
      WHERE handle = ?
    `).run(
      status === "confirmed" ? 1 : 0,
      status === "rejected" ? 1 : 0,
      status === "pending" || status === "needs_info" ? 1 : 0,
      status === "confirmed" ? BOUNTY_CREDIT_VALUE_CENTS / 100 : 0,
      now,
      body.hunter_handle,
    );
  }

  const report: BountyReport = {
    id: reportId,
    pr_id: body.pr_id,
    hunter_handle: body.hunter_handle,
    description: body.description,
    evidence: body.evidence ?? "",
    status,
    llm_verdict: verdict.severity,
    llm_confidence: verdict.confidence,
    llm_reasoning: verdict.reasoning,
    coupon_code: couponCode,
    submitted_at: now,
    resolved_at: status !== "pending" ? now : null,
  };

  log.info("bounty report processed", {
    reportId,
    prId: body.pr_id,
    hunter: body.hunter_handle,
    status,
    confidence: verdict.confidence,
  });

  return { report };
}

// ─── PR registration ──────────────────────────────────────────────────────────

/** Options for registering a merged PR on the bounty board. */
export interface RegisterBountyPROptions {
  repo: string;
  pr_number: number;
  title: string;
  merged_at: string;
  author?: string;
  pr_url: string;
  reviewer_score?: number | null;
  /** Raw diff string — truncated to BOUNTY_DIFF_EXCERPT_MAX chars before storage. */
  diff?: string;
}

/**
 * Register a merged PR on the bounty board.
 * Safe to call multiple times for the same PR (idempotent via INSERT OR IGNORE).
 *
 * When `diff` is not provided, attempts to fetch it via `gh pr diff`.
 * Silently skips if gh CLI is unavailable.
 */
export function registerBountyPR(
  store: IBountyBoardStore,
  opts: RegisterBountyPROptions,
): void {
  const id = `${opts.repo}#${opts.pr_number}`;

  let diffExcerpt = (opts.diff ?? "").slice(0, BOUNTY_DIFF_EXCERPT_MAX);

  // Attempt to fetch diff via gh CLI if not supplied
  if (!diffExcerpt) {
    try {
      const raw = execSync(
        `gh pr diff ${opts.pr_number} --repo ${opts.repo}`,
        { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
      ).toString();
      diffExcerpt = raw.slice(0, BOUNTY_DIFF_EXCERPT_MAX);
    } catch {
      // gh not configured or PR not accessible — skip diff
    }
  }

  store.prepare(`
    INSERT OR IGNORE INTO bounty_eligible_prs
      (id, repo, pr_number, title, merged_at, author, diff_excerpt, pr_url, reviewer_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    opts.repo,
    opts.pr_number,
    opts.title,
    opts.merged_at,
    opts.author ?? "",
    diffExcerpt,
    opts.pr_url,
    opts.reviewer_score ?? null,
  );
}

// ─── HTTP request parsing helpers ─────────────────────────────────────────────

/**
 * Parse the report ID from a URL like /api/bounty/report/br_12345_abc.
 * Returns null if the path does not match.
 */
export function parseBountyReportIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/bounty\/report\/([^/]+)$/);
  return match ? match[1] : null;
}
