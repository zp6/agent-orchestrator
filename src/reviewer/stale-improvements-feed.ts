/**
 * Stale-improvements feed — lists improvement-detector issues older than N hours
 * that have no associated open or merged PR, sorted by detection count descending.
 *
 * "Detection count" is derived from the number of evidence entries in the issue
 * body (lines under `### Evidence`). Each entry represents one symptom observation
 * from an orchestrator analysis cycle.
 *
 * Used by the `/stale-improvements` Telegram command (issue #440).
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";

const log = createLogger("stale-improvements-feed");

/** Default minimum age (hours) before an improvement issue is considered stale. */
export const STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS = 24;

/** Maximum number of stale improvement issues to display. */
export const STALE_IMPROVEMENTS_DISPLAY_LIMIT = 15;

export interface StaleImprovementIssue {
  repo: string;
  number: number;
  title: string;
  url: string;
  created_at: string;
  age_hours: number;
  /** Number of evidence entries extracted from the issue body. */
  detection_count: number;
  /** True when an open or merged PR was found that references this issue. */
  has_pr: boolean;
}

export interface StaleImprovementsFeed {
  /** Stale issues with no associated PR, sorted by detection_count desc. */
  issues: StaleImprovementIssue[];
  /** Number of agent repos that were queried. */
  repos_checked: number;
  /** Total open improvement issues found before filtering. */
  total_open_improvement_issues: number;
  fetched_at: string;
}

interface GhIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  body: string;
}

interface GhPr {
  number: number;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Fetch open issues labelled "orchestrator" from a repo.
 * Fails-open: returns [] on error.
 */
function fetchOrchestratorIssues(repo: string): GhIssue[] {
  try {
    const raw = execSync(
      `gh issue list --repo ${shellEscape(repo)} --state open --label orchestrator --json number,title,url,createdAt,body -L 100`,
      { encoding: "utf-8", timeout: 20000 },
    ).trim();
    if (!raw) return [];
    return JSON.parse(raw) as GhIssue[];
  } catch (err) {
    log.warn("Failed to fetch orchestrator issues", {
      repo,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Check if there is an open or merged PR in `repo` that references issue `issueNumber`.
 *
 * Strategy: search for PRs whose title or body contains "closes #N", "#N", or
 * whose branch name matches common patterns like `issue-N-*`.  We check both
 * open and merged PRs (last 30 merged) to avoid flagging issues that already
 * have merged work.
 *
 * Fails-open: if the gh CLI call errors, returns false so the issue is still
 * surfaced to the operator (better to show a false positive than to silently hide it).
 */
function hasAssociatedPr(repo: string, issueNumber: number): boolean {
  // Search open PRs that mention the issue
  const queries = [
    `closes #${issueNumber}`,
    `Closes #${issueNumber}`,
    `close #${issueNumber}`,
    `fixes #${issueNumber}`,
    `Fixes #${issueNumber}`,
    `#${issueNumber}`,
  ];

  for (const q of queries) {
    try {
      const raw = execSync(
        `gh pr list --repo ${shellEscape(repo)} --state open --search ${shellEscape(q)} --json number -L 5`,
        { encoding: "utf-8", timeout: 10000 },
      ).trim();
      if (raw) {
        const prs = JSON.parse(raw) as GhPr[];
        if (prs.length > 0) return true;
      }
    } catch {
      // continue to next query
    }
  }

  // Also check recently merged PRs (branch name pattern issue-N-*)
  try {
    const branchPattern = `issue-${issueNumber}-`;
    const raw = execSync(
      `gh pr list --repo ${shellEscape(repo)} --state merged --search ${shellEscape(branchPattern)} --json number -L 5`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();
    if (raw) {
      const prs = JSON.parse(raw) as GhPr[];
      if (prs.length > 0) return true;
    }
  } catch {
    // fail-open
  }

  return false;
}

/**
 * Count evidence entries in an issue body.
 *
 * The improvement-detector formats evidence as:
 *   ### Evidence
 *   - Task `XXXXXXXX`: ...
 *   - Task `XXXXXXXX`: ...
 *
 * We count lines that start with "- Task" under the Evidence/Source Research Tasks section.
 * Returns 1 as the minimum so issues without a parseable evidence block still sort above 0.
 */
function countDetections(body: string): number {
  if (!body) return 1;

  // Find the evidence section
  const evidenceMatch = body.match(/###\s+(?:Evidence|Source Research Tasks)([\s\S]*?)(?:\n###|\n---|\n\*\*|$)/);
  if (!evidenceMatch) return 1;

  const section = evidenceMatch[1];
  // Count lines that look like evidence entries
  const entries = section.split("\n").filter((line) => /^\s*-\s+/.test(line) && line.trim().length > 2);
  return Math.max(entries.length, 1);
}

/**
 * Compute issue age in hours.
 */
function ageHours(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  return (now - created) / (1000 * 60 * 60);
}

/**
 * Build the stale-improvements feed from all agent repos in the reviewer config.
 *
 * @param config - ReviewerConfig; agents must have a `github` field to be queried.
 * @param minAgeHours - Minimum age in hours before an issue is considered stale (default 24).
 */
export function buildStaleImprovementsFeed(
  config: ReviewerConfig,
  minAgeHours = STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS,
): StaleImprovementsFeed {
  const agents = config.agents ?? {};
  const repos = [...new Set(
    Object.values(agents)
      .map((a) => (a as { github?: string }).github)
      .filter((g): g is string => !!g),
  )];

  let totalOpen = 0;
  const candidates: StaleImprovementIssue[] = [];

  for (const repo of repos) {
    const issues = fetchOrchestratorIssues(repo);
    totalOpen += issues.length;

    for (const issue of issues) {
      const age = ageHours(issue.createdAt);
      if (age < minAgeHours) continue;

      const detectionCount = countDetections(issue.body);
      const hasPr = hasAssociatedPr(repo, issue.number);

      if (!hasPr) {
        candidates.push({
          repo,
          number: issue.number,
          title: issue.title,
          url: issue.url,
          created_at: issue.createdAt,
          age_hours: age,
          detection_count: detectionCount,
          has_pr: false,
        });
      }
    }
  }

  // Sort by detection_count desc, then age desc as tiebreaker
  candidates.sort((a, b) => {
    if (b.detection_count !== a.detection_count) return b.detection_count - a.detection_count;
    return b.age_hours - a.age_hours;
  });

  return {
    issues: candidates.slice(0, STALE_IMPROVEMENTS_DISPLAY_LIMIT),
    repos_checked: repos.length,
    total_open_improvement_issues: totalOpen,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Format a StaleImprovementsFeed for a Telegram message.
 */
export function formatStaleImprovementsFeedForTelegram(
  feed: StaleImprovementsFeed,
  minAgeHours = STALE_IMPROVEMENTS_DEFAULT_MIN_AGE_HOURS,
): string {
  const lines: string[] = [];

  lines.push(`🔍 *Stale Improvement Issues* — no PR after >${minAgeHours}h`);
  lines.push(`Checked ${feed.repos_checked} repo${feed.repos_checked !== 1 ? "s" : ""} · ${feed.total_open_improvement_issues} open improvement issues`);
  lines.push("");

  if (feed.issues.length === 0) {
    lines.push("✅ No stale improvements — all open improvement issues have associated PRs or are under ${minAgeHours}h old.");
    return lines.join("\n");
  }

  for (const issue of feed.issues) {
    const ageLabel = issue.age_hours >= 48
      ? `${Math.round(issue.age_hours / 24)}d`
      : `${Math.round(issue.age_hours)}h`;

    const detectionLabel = issue.detection_count === 1 ? "1 detection" : `${issue.detection_count} detections`;
    const repoShort = issue.repo.replace("rapartlu/", "");

    lines.push(
      `• [#${issue.number}](${issue.url}) \`${repoShort}\``,
    );
    lines.push(`  ${issue.title.slice(0, 80)}${issue.title.length > 80 ? "…" : ""}`);
    lines.push(`  ⏱ ${ageLabel} old · 🔁 ${detectionLabel}`);
    lines.push("");
  }

  if (feed.issues.length >= STALE_IMPROVEMENTS_DISPLAY_LIMIT) {
    lines.push(`_Showing top ${STALE_IMPROVEMENTS_DISPLAY_LIMIT}. Dispatch or close issues to clear the backlog._`);
  }

  lines.push(`_Updated: ${new Date(feed.fetched_at).toUTCString()}_`);

  return lines.join("\n");
}
