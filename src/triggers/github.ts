import { execSync } from "node:child_process";

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export interface GhAuthStatus {
  /** Whether `gh` is authenticated (token present and accepted). */
  ok: boolean;
  /** Human-readable reason when ok is false. */
  reason?: string;
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
 * Find open or recently-merged PRs that close a given issue number.
 *
 * Searches PR bodies for closing keywords ("closes #N", "fixes #N",
 * "resolves #N", and their variants) to identify PRs linked to the issue.
 *
 * Returns an empty array on any error (fail-open: the caller proceeds with
 * dispatch rather than silently dropping work when the check fails).
 */
export function findExistingPRsForIssue(repo: string, issueNumber: number): LinkedPR[] {
  const closingPattern = new RegExp(
    `\\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\s+#${issueNumber}\\b`,
    "i",
  );

  try {
    // Fetch open (including draft) PRs
    const openRaw = execSync(
      `gh api "repos/${repo}/pulls?state=open&per_page=100" --jq '[.[] | {number, title, url: .html_url, isDraft: .draft, body: .body}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const openPRs = (
      JSON.parse(openRaw.trim() || "[]") as Array<{
        number: number;
        title: string;
        url: string;
        isDraft: boolean;
        body: string | null;
      }>
    )
      .filter((pr) => closingPattern.test(pr.body ?? ""))
      .map((pr) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        state: "open" as const,
        isDraft: pr.isDraft,
      }));

    // Fetch recently merged PRs (last 30 closed PRs that were merged)
    const mergedRaw = execSync(
      `gh api "repos/${repo}/pulls?state=closed&per_page=30" --jq '[.[] | select(.merged_at != null) | {number, title, url: .html_url, body: .body}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const mergedPRs = (
      JSON.parse(mergedRaw.trim() || "[]") as Array<{
        number: number;
        title: string;
        url: string;
        body: string | null;
      }>
    )
      .filter((pr) => closingPattern.test(pr.body ?? ""))
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

export function fetchOpenIssues(repo: string): GitHubIssue[] {
  try {
    const output = execSync(
      `gh api "repos/${repo}/issues?state=open&per_page=50" --jq '[.[] | select(.pull_request == null) | {number, title, body, url: .html_url, labels: [.labels[].name]}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const parsed = JSON.parse(output.trim() || "[]") as Array<{
      number: number;
      title: string;
      body: string | null;
      url: string;
      labels: string[];
    }>;

    return parsed.map((issue) => ({
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.url,
      labels: issue.labels,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issues for ${repo}: ${msg}`);
  }
}
