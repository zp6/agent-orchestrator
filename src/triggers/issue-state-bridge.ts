/**
 * Bridge between the IssueStateCache and the real GitHub API helpers.
 *
 * Provides a pre-built IssueFetcher that wraps `isIssueOpen()` and
 * `findExistingPRsForIssue()` from github.ts, plus convenience functions
 * that consumers can call instead of dealing with the cache directly.
 *
 * Usage:
 *   import { cachedIsIssueOpen, cachedValidateForDispatch, logCacheMetrics } from "./issue-state-bridge.js";
 *
 *   if (!cachedIsIssueOpen(repo, issueNum)) { ... }
 *   const skip = cachedValidateForDispatch(repo, issueNum);
 *   if (skip) { log.info(skip); continue; }
 *
 * @see https://github.com/rapartlu/claude-agent-orchestrator/issues/458
 */

import { isIssueOpen, findExistingPRsForIssue } from "./github.js";
import { getIssueStateCache, type IssueFetcher, type CachedIssueState } from "./issue-state-cache.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("issue-state-bridge");

/**
 * The default IssueFetcher backed by real GitHub API calls.
 * Wraps `isIssueOpen()` + `findExistingPRsForIssue()` into the
 * `IssueFetcher` interface expected by the cache.
 */
export const gitHubFetcher: IssueFetcher = (repo: string, issueNumber: number) => {
  const open = isIssueOpen(repo, issueNumber);
  const existingPRs = findExistingPRsForIssue(repo, issueNumber);
  const hasOpenPR = existingPRs.some((pr) => pr.state === "open" && !pr.isDraft);
  const hasMergedPR = existingPRs.some((pr) => pr.state === "merged");

  return {
    state: open ? ("open" as const) : ("closed" as const),
    hasOpenPR,
    hasMergedPR,
  };
};

/**
 * Check whether an issue is open, using the global cache.
 * Drop-in replacement for direct `isIssueOpen()` calls.
 */
export function cachedIsIssueOpen(repo: string, issueNumber: number): boolean {
  return getIssueStateCache().isIssueOpen(repo, issueNumber, gitHubFetcher);
}

/**
 * Get full cached state for an issue.
 * Useful when the caller needs to inspect hasOpenPR/hasMergedPR directly.
 */
export function cachedGetIssueState(repo: string, issueNumber: number): CachedIssueState {
  return getIssueStateCache().getOrFetch(repo, issueNumber, gitHubFetcher);
}

/**
 * Validate whether an issue is dispatchable, using the cache.
 * Returns a skip-reason string if dispatch should be blocked, or null if OK.
 *
 * Automatically increments the `staleDispatchesPrevented` metric when
 * a closed/resolved issue is caught.
 */
export function cachedValidateForDispatch(repo: string, issueNumber: number): string | null {
  return getIssueStateCache().validateForDispatch(repo, issueNumber, gitHubFetcher);
}

/**
 * Invalidate a single issue's cached state.
 * Call this after events that change issue state (PR merge, issue close, etc.).
 */
export function invalidateCachedIssue(repo: string, issueNumber: number): void {
  getIssueStateCache().invalidate(repo, issueNumber);
}

/**
 * Log cache metrics at info level.
 * Called periodically by the daemon to surface the "stale dispatch prevented"
 * metric for operators.
 */
export function logCacheMetrics(): void {
  const metrics = getIssueStateCache().getMetrics();
  if (metrics.hits > 0 || metrics.misses > 0 || metrics.staleDispatchesPrevented > 0) {
    log.info("Issue state cache metrics", {
      hits: metrics.hits,
      misses: metrics.misses,
      staleDispatchesPrevented: metrics.staleDispatchesPrevented,
      cacheSize: metrics.size,
      hitRate: metrics.hits + metrics.misses > 0
        ? ((metrics.hits / (metrics.hits + metrics.misses)) * 100).toFixed(1) + "%"
        : "N/A",
    });
  }
}
