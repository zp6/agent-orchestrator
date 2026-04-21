import { execSync } from "node:child_process";

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  created_at?: string;
}

export interface GhAuthStatus {
  /** Whether `gh` is authenticated (token present and accepted). */
  ok: boolean;
  /** Human-readable reason when ok is false. */
  reason?: string;
}

/**
 * Thrown when GitHub CLI authentication fails before or during dispatch.
 *
 * Callers can use `instanceof GhAuthError` to distinguish auth failures from
 * other dispatch errors and surface a clear, actionable message — rather than
 * letting the task proceed and produce an orphan branch with no linked PR.
 */
export class GhAuthError extends Error {
  constructor(
    message: string,
    /** The underlying reason returned by validateGhAuth(). */
    public readonly reason: string,
  ) {
    super(message);
    this.name = "GhAuthError";
  }
}

/**
 * Validate that the `gh` CLI is authenticated before attempting any GitHub
 * API calls.
 *
 * Checks in priority order:
 *  1. `GH_TOKEN` environment variable — if set and non-empty, `gh` will use it
 *     without needing a stored credential.
 *  2. `gh auth status` — succeeds (exit 0) when a stored credential exists.
 *
 * Returns `{ ok: true }` when authenticated, or `{ ok: false, reason }` with a
 * clear message describing the problem so callers can surface it instead of
 * silently dispatching work that will fail inside the agent.
 *
 * @param execFn - optional override for unit tests
 */
export function validateGhAuth(
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): GhAuthStatus {
  // Fast path: GH_TOKEN env var is set and non-empty — gh will honour it.
  const token = process.env["GH_TOKEN"];
  if (token && token.trim().length > 0) {
    return { ok: true };
  }

  // Slow path: run `gh auth status` to check stored credential.
  try {
    execFn("gh auth status", { encoding: "utf-8", timeout: 10000 });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      "Set the GH_TOKEN environment variable or run `gh auth login` to authenticate.";
    return {
      ok: false,
      reason: `gh CLI is not authenticated: ${msg}. ${hint}`,
    };
  }
}

export interface LinkedPR {
  number: number;
  title: string;
  url: string;
  /** "open" includes draft PRs. "merged" means the PR was merged (not just closed). */
  state: "open" | "merged";
  isDraft: boolean;
}

/**
 * Find open PRs for an issue using GitHub's search API (server-side, scalable).
 *
 * Unlike the REST list endpoint (gh api repos/OWNER/REPO/pulls with per_page=100),
 * which fetches all open PRs and filters client-side, this queries GitHub's search
 * index directly. A repo with 300+ open PRs will not silently miss a PR that
 * appears beyond position 100 in the paginated list — the root cause of the
 * fleet-wide guard failures described in issue #967.
 *
 * Searches for closing keyword variants in PR bodies:
 * "closes #N", "fixes #N", "resolves #N" (GitHub's search is case-insensitive).
 *
 * Returns an empty array on any error (fail-open — callers proceed with
 * dispatch rather than silently blocking work).
 */
export function findOpenPRsViaSearch(
  repo: string,
  issueNumber: number,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): Array<{ number: number; title: string; url: string; isDraft: boolean; headRefName: string }> {
  try {
    // GitHub search is case-insensitive; OR combines all closing keyword variants.
    // Searching by issue number means results are always a small set (< 10 PRs).
    const query = `closes #${issueNumber} OR fixes #${issueNumber} OR resolves #${issueNumber}`;
    const raw = execFn(
      `gh pr list --repo ${repo} --state open --search ${JSON.stringify(query)} --json number,title,url,isDraft,headRefName --limit 100`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return JSON.parse(raw.trim() || "[]") as Array<{
      number: number;
      title: string;
      url: string;
      isDraft: boolean;
      headRefName: string;
    }>;
  } catch {
    return [];
  }
}

/**
 * Find open or recently-merged PRs that are linked to a given issue number.
 *
 * Uses two complementary detection strategies for open PRs:
 * 1. **Server-side search** (`gh pr list --search`): Finds PRs with closing
 *    keywords ("closes #N", "fixes #N", "resolves #N") via GitHub's search
 *    index. Scales to any repo size — no per_page cap. This is the primary
 *    check and directly addresses the fleet-wide guard failure (issue #967)
 *    where repos with >100 open PRs would miss keyword-referenced PRs.
 * 2. **Branch-name matching**: Finds PRs whose branch follows "issue-N-*" or
 *    "N-*" patterns but lack explicit closing keywords (e.g., research-agent
 *    PRs). These are caught by the paginated list (per_page=100) as a fallback.
 *
 * Merged PRs are checked via the paginated closed-PR list (last 30 merged),
 * using client-side keyword and branch-name filtering.
 *
 * Returns an empty array on any error (fail-open: the caller proceeds with
 * dispatch rather than silently dropping work when the check fails).
 */
export function findExistingPRsForIssue(repo: string, issueNumber: number): LinkedPR[] {
  const closingPattern = new RegExp(
    `\\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#${issueNumber}\\b`,
    "i",
  );

  // Match branches that belong to this issue: issue-N-*, issue_N_*, N-*, N_*
  // This pattern is consistent with findApprovedPRForIssue and findBranchForIssue
  const branchPattern = new RegExp(
    `(?:^|[-/])issue[-_]${issueNumber}(?:[-_/]|$)|^${issueNumber}[-_]`,
  );

  try {
    // Primary: server-side search for closing keywords. Scales to repos with
    // many open PRs without the per_page=100 cap of the REST list endpoint.
    // A PR with "Closes #323" will be found even if 300+ other PRs are open.
    const searchHits = findOpenPRsViaSearch(repo, issueNumber);
    const searchByNumber = new Set(searchHits.map((pr) => pr.number));
    const searchOpenPRs: LinkedPR[] = searchHits.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: "open" as const,
      isDraft: pr.isDraft,
    }));

    // Secondary: branch-name matching from the paginated list. Catches agents
    // that follow the issue-N-description convention but omit closing keywords.
    // PRs already found via search are deduplicated by PR number.
    const openRaw = execSync(
      `gh api "repos/${repo}/pulls?state=open&per_page=100" --jq '[.[] | {number, title, url: .html_url, isDraft: .draft, body: .body, headRefName: .head.ref}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const branchMatchedPRs = (
      JSON.parse(openRaw.trim() || "[]") as Array<{
        number: number;
        title: string;
        url: string;
        isDraft: boolean;
        body: string | null;
        headRefName: string;
      }>
    )
      .filter((pr) => !searchByNumber.has(pr.number) && branchPattern.test(pr.headRefName))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: "open" as const,
        isDraft: pr.isDraft,
      }));

    const openPRs = [...searchOpenPRs, ...branchMatchedPRs];

    // Fetch recently merged PRs (last 30 closed PRs that were merged)
    const mergedRaw = execSync(
      `gh api "repos/${repo}/pulls?state=closed&per_page=30" --jq '[.[] | select(.merged_at != null) | {number, title, url: .html_url, body: .body, headRefName: .head.ref}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const mergedPRs = (
      JSON.parse(mergedRaw.trim() || "[]") as Array<{
        number: number;
        title: string;
        url: string;
        body: string | null;
        headRefName: string;
      }>
    )
      .filter((pr) => closingPattern.test(pr.body ?? "") || branchPattern.test(pr.headRefName))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: "merged" as const,
        isDraft: false,
      }));

    return [...openPRs, ...mergedPRs];
  } catch {
    // Non-fatal: if the PR check fails, proceed with dispatch (fail open)
    return [];
  }
}

/**
 * Check for PRs linked to an issue across multiple repos.
 *
 * Used for cross-repo dispatch guard: when an issue in repo-A is fixed by a
 * PR in repo-B (e.g. a monorepo-style feature spanning reviewer + dashboard),
 * we must not re-dispatch to repo-B just because repo-A's guard didn't fire.
 *
 * Returns an array of { repo, pr } pairs — the PR's `repo` field indicates
 * which repo it was found in (may differ from the issue's own repo).
 *
 * Fail-open: errors on individual repos are silently ignored so a transient
 * API failure on a peer repo does not block dispatch of the primary task.
 *
 * @param primaryRepo - The repo that owns the issue.
 * @param issueNumber - The issue number to look up.
 * @param peerRepos   - Additional repos to scan for cross-repo PRs.
 */
export function findExistingPRsForIssueAcrossRepos(
  primaryRepo: string,
  issueNumber: number,
  peerRepos: string[],
): Array<LinkedPR & { repo: string }> {
  // Only scan peer repos — the primary repo is handled by the caller via
  // findExistingPRsForIssue so we avoid double-checking the same repo.
  const reposToCheck = peerRepos.filter((r) => r !== primaryRepo);
  const results: Array<LinkedPR & { repo: string }> = [];

  for (const repo of reposToCheck) {
    try {
      const prs = findExistingPRsForIssue(repo, issueNumber);
      for (const pr of prs) {
        results.push({ ...pr, repo });
      }
    } catch {
      // fail-open: transient API errors on peer repos must not block dispatch
    }
  }

  return results;
}

/**
 * Count the number of open PRs in a repository.
 *
 * Returns `null` on failure so callers can fail open when GitHub is
 * temporarily unavailable.
 */
export function countOpenPRs(
  repo: string,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): number | null {
  try {
    const raw = execFn(
      `gh pr list --repo ${repo} --state open --json number`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const prs = JSON.parse(raw.trim() || "[]") as Array<{ number: number }>;
    return prs.length;
  } catch {
    return null;
  }
}

/**
 * Count the number of open issues (excluding PRs) in a repository.
 *
 * Returns `null` on failure so callers can fail open when GitHub is
 * temporarily unavailable.
 */
export function countOpenIssues(
  repo: string,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): number | null {
  try {
    const raw = execFn(
      `gh issue list --repo ${repo} --state open --json number`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const issues = JSON.parse(raw.trim() || "[]") as Array<{ number: number }>;
    return issues.length;
  } catch {
    return null;
  }
}

/**
 * Check whether a GitHub issue is still open before dispatching.
 *
 * Fetches the issue state via `gh issue view`. Returns true if the issue is
 * open, false if it is closed or any other non-open state.
 *
 * Fails open: returns true on any error so a transient gh CLI failure does
 * not silently drop real work.
 *
 * @param execFn - optional override for unit tests (avoids ESM module patching)
 */
export function isIssueOpen(
  repo: string,
  issueNumber: number,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): boolean {
  try {
    const raw = execFn(
      `gh issue view ${issueNumber} --repo ${repo} --json state -q .state`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const state = raw.trim().toUpperCase();
    return state === "OPEN";
  } catch {
    // Fail open: if we can't verify the state, allow the dispatch
    return true;
  }
}

/**
 * Find an existing remote branch that appears to be in-flight work for a
 * given issue number.  Matches branches whose name contains `issue-{N}` or
 * starts with `{N}-` (common agent naming conventions).
 *
 * Returns the matching branch name, or null when none is found.
 *
 * Fails open: returns null on any error so a transient gh CLI failure does
 * not silently suppress real work.
 *
 * @param execFn - optional override for unit tests
 */
export function findBranchForIssue(
  repo: string,
  issueNumber: number,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): string | null {
  try {
    const raw = execFn(
      `gh api "repos/${repo}/branches?per_page=100" --jq '[.[].name]'`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const branches = JSON.parse(raw.trim() || "[]") as string[];

    // Match branches containing "issue-N" (e.g. issue-352-fix, fix/issue-352)
    // or starting with "N-" (e.g. 352-pre-dispatch-check)
    const issuePattern = new RegExp(`(?:^|[-/])issue[-_]${issueNumber}(?:[-_/]|$)|^${issueNumber}[-_]`);
    return branches.find((b) => issuePattern.test(b)) ?? null;
  } catch {
    // Fail open: don't suppress dispatch when branch lookup fails
    return null;
  }
}

export interface ApprovedPR {
  number: number;
  headRefName: string;
}

/**
 * Check whether an open PR for the given issue is approved and clean (ready
 * to merge).
 *
 * Queries all open PRs on the repo and filters by branch name pattern
 * (`issue-N-*` or `N-*`) to find PRs that belong to this issue. If any such
 * PR has `reviewDecision == "APPROVED"` and `mergeStateStatus == "CLEAN"`,
 * returns that PR's details so the caller can skip dispatch.
 *
 * Fails open: returns null on any error so a transient gh CLI failure does
 * not silently suppress real work.
 *
 * @param execFn - optional override for unit tests
 */
export function findApprovedPRForIssue(
  repo: string,
  issueNumber: number,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): ApprovedPR | null {
  try {
    const raw = execFn(
      `gh pr list --repo ${repo} --state open --json number,headRefName,reviewDecision,mergeStateStatus`,
      { encoding: "utf-8", timeout: 15000 },
    );

    const prs = JSON.parse(raw.trim() || "[]") as Array<{
      number: number;
      headRefName: string;
      reviewDecision: string | null;
      mergeStateStatus: string;
    }>;

    // Match branches that belong to this issue: issue-N-*, issue_N_*, N-*, N_*
    const issuePattern = new RegExp(
      `(?:^|[-/])issue[-_]${issueNumber}(?:[-_/]|$)|^${issueNumber}[-_]`,
    );

    const approvedPR = prs.find(
      (pr) =>
        issuePattern.test(pr.headRefName) &&
        pr.reviewDecision === "APPROVED" &&
        pr.mergeStateStatus === "CLEAN",
    );

    return approvedPR
      ? { number: approvedPR.number, headRefName: approvedPR.headRefName }
      : null;
  } catch {
    // Fail open: don't suppress dispatch when the check fails
    return null;
  }
}

export function fetchOpenIssues(repo: string): GitHubIssue[] {
  try {
    const output = execSync(
      `gh api "repos/${repo}/issues?state=open&per_page=50" --jq '[.[] | select(.pull_request == null) | {number, title, body, url: .html_url, labels: [.labels[].name], created_at}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const parsed = JSON.parse(output.trim() || "[]") as Array<{
      number: number;
      title: string;
      body: string | null;
      url: string;
      labels: string[];
      created_at: string;
    }>;

    return parsed.map((issue) => ({
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.url,
      created_at: issue.created_at ?? new Date().toISOString(),
      labels: issue.labels,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issues for ${repo}: ${msg}`);
  }
}
