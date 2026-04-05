/**
 * auditor.ts — Issue-to-PR traceability gap detector.
 *
 * Surfaces three gap classes across agent repos:
 *   1. Orphan issues   — open issues with no linked branch or PR, age > N days
 *   2. Zombie issues   — merged PRs whose source issues are still open
 *   3. Unlinked PRs    — open PRs missing a "Closes #N" reference in their body
 *
 * Each gap item includes a one-line suggested fix command.
 */

import { execSync } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrphanIssueGap {
  kind: "orphan-issue";
  repo: string;
  agent: string;
  issueNumber: number;
  title: string;
  ageDays: number;
  url: string;
  /** Suggested one-liner fix. */
  fix: string;
}

export interface ZombieIssueGap {
  kind: "zombie-issue";
  repo: string;
  agent: string;
  issueNumber: number;
  title: string;
  mergedPrNumber: number;
  url: string;
  /** Suggested one-liner fix. */
  fix: string;
}

export interface UnlinkedPRGap {
  kind: "unlinked-pr";
  repo: string;
  agent: string;
  prNumber: number;
  title: string;
  url: string;
  /** Suggested one-liner fix. */
  fix: string;
}

export type AuditGap = OrphanIssueGap | ZombieIssueGap | UnlinkedPRGap;

export interface AuditRepoResult {
  repo: string;
  agent: string;
  gaps: AuditGap[];
  /** Error fetching data for this repo, if any. */
  error?: string;
}

export interface AuditResult {
  repos: AuditRepoResult[];
  totalGaps: number;
  orphanIssues: number;
  zombieIssues: number;
  unlinkedPRs: number;
  elapsedMs: number;
}

// ── Closing-keyword pattern ───────────────────────────────────────────────────

const CLOSING_RE =
  /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/gi;

/**
 * Extract all issue numbers referenced via closing keywords in a PR body.
 */
export function extractClosedIssues(body: string | null | undefined): number[] {
  if (!body) return [];
  const nums: number[] = [];
  let m: RegExpExecArray | null;
  CLOSING_RE.lastIndex = 0;
  while ((m = CLOSING_RE.exec(body)) !== null) {
    nums.push(parseInt(m[1]!, 10));
  }
  return nums;
}

/**
 * Return true when a PR body contains at least one closing keyword.
 */
export function hasClosingRef(body: string | null | undefined): boolean {
  if (!body) return false;
  CLOSING_RE.lastIndex = 0;
  return CLOSING_RE.test(body);
}

// ── GitHub data fetchers ──────────────────────────────────────────────────────

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  url: string;
  createdAt: string;
  state: "OPEN" | "CLOSED";
}

interface GhPR {
  number: number;
  title: string;
  body: string | null;
  url: string;
  mergedAt: string | null;
  headRefName: string;
}

function execGh(cmd: string, timeoutMs = 15000): string {
  return execSync(cmd, { encoding: "utf-8", timeout: timeoutMs });
}

function fetchOpenIssues(repo: string): GhIssue[] {
  // Fetch up to 100 open issues (excluding pull requests).
  const raw = execGh(
    `gh api "repos/${repo}/issues?state=open&per_page=100" ` +
      `--jq '[.[] | select(.pull_request == null) | ` +
      `{number, title, body, url: .html_url, createdAt: .created_at, state: "OPEN"}]'`,
  );
  return JSON.parse(raw.trim() || "[]") as GhIssue[];
}

function fetchOpenPRs(repo: string): GhPR[] {
  const raw = execGh(
    `gh api "repos/${repo}/pulls?state=open&per_page=100" ` +
      `--jq '[.[] | {number, title, body, url: .html_url, mergedAt: .merged_at, headRefName: .head.ref}]'`,
  );
  return JSON.parse(raw.trim() || "[]") as GhPR[];
}

function fetchRecentlyMergedPRs(repo: string): GhPR[] {
  // Last 50 closed PRs that were actually merged.
  const raw = execGh(
    `gh api "repos/${repo}/pulls?state=closed&per_page=50" ` +
      `--jq '[.[] | select(.merged_at != null) | {number, title, body, url: .html_url, mergedAt: .merged_at, headRefName: .head.ref}]'`,
  );
  return JSON.parse(raw.trim() || "[]") as GhPR[];
}

// ── Core audit logic ──────────────────────────────────────────────────────────

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / 86_400_000;
}

/**
 * Audit a single repo for all three gap classes.
 */
export function auditRepo(
  repo: string,
  agent: string,
  opts: { minAgeDays: number },
): AuditRepoResult {
  const gaps: AuditGap[] = [];

  let openIssues: GhIssue[];
  let openPRs: GhPR[];
  let mergedPRs: GhPR[];

  try {
    openIssues = fetchOpenIssues(repo);
    openPRs = fetchOpenPRs(repo);
    mergedPRs = fetchRecentlyMergedPRs(repo);
  } catch (err) {
    return {
      repo,
      agent,
      gaps: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Pre-compute issue numbers referenced by open PRs (branch names + bodies).
  const linkedByOpenPR = new Set<number>();
  for (const pr of openPRs) {
    // Branch name heuristic: issue-123-description or 123-something
    const branchMatch = /(?:^|[-/])(\d+)(?:[-/]|$)/.exec(pr.headRefName);
    if (branchMatch) linkedByOpenPR.add(parseInt(branchMatch[1]!, 10));
    for (const n of extractClosedIssues(pr.body)) linkedByOpenPR.add(n);
  }

  // Pre-compute which issues are closed by merged PRs.
  // merged PR number → closed issue numbers
  const closedByMerge = new Map<number, number[]>();
  for (const pr of mergedPRs) {
    const nums = extractClosedIssues(pr.body);
    if (nums.length > 0) closedByMerge.set(pr.number, nums);
  }

  // Build set of open issue numbers for quick lookup.
  const openIssueNums = new Set(openIssues.map((i) => i.number));

  // ── Gap 1: Orphan issues ────────────────────────────────────────────────────
  for (const issue of openIssues) {
    const age = daysSince(issue.createdAt);
    if (age < opts.minAgeDays) continue;
    if (linkedByOpenPR.has(issue.number)) continue;

    // Check merged PRs too — maybe the PR merged but the issue didn't auto-close.
    let linkedToMerge = false;
    for (const nums of closedByMerge.values()) {
      if (nums.includes(issue.number)) {
        linkedToMerge = true;
        break;
      }
    }
    if (linkedToMerge) continue; // will surface as zombie-issue gap instead

    gaps.push({
      kind: "orphan-issue",
      repo,
      agent,
      issueNumber: issue.number,
      title: issue.title,
      ageDays: Math.floor(age),
      url: issue.url,
      fix: `orch dispatch "Investigate and resolve issue #${issue.number}: ${issue.title}" --agent=${agent}`,
    });
  }

  // ── Gap 2: Zombie issues ────────────────────────────────────────────────────
  // A merged PR closed this issue number, but the issue is still open.
  for (const [prNumber, closedNums] of closedByMerge) {
    for (const num of closedNums) {
      if (!openIssueNums.has(num)) continue; // already closed — good
      const issue = openIssues.find((i) => i.number === num);
      if (!issue) continue;

      gaps.push({
        kind: "zombie-issue",
        repo,
        agent,
        issueNumber: num,
        title: issue.title,
        mergedPrNumber: prNumber,
        url: issue.url,
        fix: `gh issue close ${num} --repo ${repo} --comment "Auto-close: already shipped in merged PR #${prNumber}"`,
      });
    }
  }

  // ── Gap 3: Unlinked PRs ─────────────────────────────────────────────────────
  for (const pr of openPRs) {
    if (hasClosingRef(pr.body)) continue;

    // Try to infer an issue number from the branch name as a hint.
    const branchMatch = /(?:^|[-/])(\d+)(?:[-/]|$)/.exec(pr.headRefName);
    const hintIssue = branchMatch ? parseInt(branchMatch[1]!, 10) : null;
    const closesHint = hintIssue ? ` (inferred: Closes #${hintIssue})` : "";

    gaps.push({
      kind: "unlinked-pr",
      repo,
      agent,
      prNumber: pr.number,
      title: pr.title,
      url: pr.url,
      fix: `gh pr edit ${pr.number} --repo ${repo} --body "$(gh pr view ${pr.number} --repo ${repo} --json body -q .body)\\n\\nCloses #??"${closesHint}`,
    });
  }

  return { repo, agent, gaps };
}

/**
 * Audit all repos in the agent registry.
 */
export function auditAll(
  agents: Record<string, { github?: string }>,
  opts: { minAgeDays: number },
): AuditResult {
  const start = Date.now();
  const repos: AuditRepoResult[] = [];

  for (const [agentName, agentCfg] of Object.entries(agents)) {
    if (!agentCfg.github) continue;
    const result = auditRepo(agentCfg.github, agentName, opts);
    repos.push(result);
  }

  const totalGaps = repos.reduce((n, r) => n + r.gaps.length, 0);
  const orphanIssues = repos.reduce(
    (n, r) => n + r.gaps.filter((g) => g.kind === "orphan-issue").length,
    0,
  );
  const zombieIssues = repos.reduce(
    (n, r) => n + r.gaps.filter((g) => g.kind === "zombie-issue").length,
    0,
  );
  const unlinkedPRs = repos.reduce(
    (n, r) => n + r.gaps.filter((g) => g.kind === "unlinked-pr").length,
    0,
  );

  return {
    repos,
    totalGaps,
    orphanIssues,
    zombieIssues,
    unlinkedPRs,
    elapsedMs: Date.now() - start,
  };
}
