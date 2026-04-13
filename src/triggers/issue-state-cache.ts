/**
 * Real-time issue state cache with TTL.
 *
 * Prevents stale dispatch decisions by caching GitHub issue and PR state
 * with a configurable TTL.  Before any dispatch decision the caller can
 * re-validate issue state through the cache — if the cached entry is
 * fresher than the TTL, no GitHub API call is made.
 *
 * Surfaces a "stale dispatch prevented" metric so operators can measure
 * how many wasted agent cycles this layer saves.
 *
 * @see https://github.com/rapartlu/claude-agent-orchestrator/issues/458
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("issue-state-cache");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IssueState = "open" | "closed";

export interface CachedIssueState {
  state: IssueState;
  /** Whether an open (non-draft) PR already exists for this issue */
  hasOpenPR: boolean;
  /** Whether a merged PR already exists for this issue */
  hasMergedPR: boolean;
  /** Epoch ms when this entry was fetched from GitHub */
  fetchedAt: number;
}

export interface IssueStateCacheMetrics {
  /** Number of cache hits (served from cache, no API call) */
  hits: number;
  /** Number of cache misses (fetched from GitHub) */
  misses: number;
  /** Number of times a stale/closed issue was caught before dispatch */
  staleDispatchesPrevented: number;
  /** Number of entries currently in the cache */
  size: number;
}

/**
 * Function signature for fetching issue state from GitHub.
 * Abstracted so callers can inject mocks for testing.
 */
export type IssueFetcher = (
  repo: string,
  issueNumber: number,
) => { state: IssueState; hasOpenPR: boolean; hasMergedPR: boolean };

// ---------------------------------------------------------------------------
// Cache implementation
// ---------------------------------------------------------------------------

/** Default TTL: 60 seconds (as specified in the issue) */
export const DEFAULT_TTL_MS = 60_000;

/** Maximum cache size to prevent unbounded memory growth */
const MAX_CACHE_SIZE = 500;

export class IssueStateCache {
  private cache = new Map<string, CachedIssueState>();
  private ttlMs: number;
  private metrics = {
    hits: 0,
    misses: 0,
    staleDispatchesPrevented: 0,
  };

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /** Build a cache key from repo + issue number */
  private key(repo: string, issueNumber: number): string {
    return `${repo}#${issueNumber}`;
  }

  /**
   * Get cached issue state if it exists and is within TTL.
   * Returns undefined if not cached or expired.
   */
  get(repo: string, issueNumber: number): CachedIssueState | undefined {
    const k = this.key(repo, issueNumber);
    const entry = this.cache.get(k);
    if (!entry) return undefined;

    const age = Date.now() - entry.fetchedAt;
    if (age > this.ttlMs) {
      this.cache.delete(k);
      return undefined;
    }

    this.metrics.hits++;
    return entry;
  }

  /**
   * Store issue state in the cache.
   */
  set(repo: string, issueNumber: number, state: CachedIssueState): void {
    // Evict oldest entries if at capacity
    if (this.cache.size >= MAX_CACHE_SIZE) {
      this.evictOldest();
    }
    this.cache.set(this.key(repo, issueNumber), state);
  }

  /**
   * Get issue state, fetching from GitHub if not cached or expired.
   * This is the primary API — callers should use this rather than
   * calling get/set manually.
   */
  getOrFetch(
    repo: string,
    issueNumber: number,
    fetcher: IssueFetcher,
  ): CachedIssueState {
    const cached = this.get(repo, issueNumber);
    if (cached) return cached;

    this.metrics.misses++;
    const fresh = fetcher(repo, issueNumber);
    const entry: CachedIssueState = {
      ...fresh,
      fetchedAt: Date.now(),
    };
    this.set(repo, issueNumber, entry);
    return entry;
  }

  /**
   * Check whether an issue is still open, using the cache.
   * Returns true if open, false if closed.
   *
   * This replaces direct `isIssueOpen()` calls throughout the codebase.
   */
  isIssueOpen(repo: string, issueNumber: number, fetcher: IssueFetcher): boolean {
    const entry = this.getOrFetch(repo, issueNumber, fetcher);
    return entry.state === "open";
  }

  /**
   * Pre-dispatch validation: check if an issue should be dispatched.
   * Returns a reason string if dispatch should be skipped, or null if OK.
   *
   * Increments the staleDispatchesPrevented metric when a stale dispatch
   * is caught.
   */
  validateForDispatch(
    repo: string,
    issueNumber: number,
    fetcher: IssueFetcher,
  ): string | null {
    const entry = this.getOrFetch(repo, issueNumber, fetcher);

    if (entry.state === "closed") {
      this.metrics.staleDispatchesPrevented++;
      log.info("Stale dispatch prevented: issue is closed", {
        repo,
        issueNumber,
        cachedAge: Date.now() - entry.fetchedAt,
      });
      return `issue ${repo}#${issueNumber} is closed`;
    }

    // NOTE: We intentionally do NOT block on hasMergedPR here when the issue
    // is still open. A merged PR that did not close the issue (e.g. missing
    // "Closes #N", partial fix, or manually reopened issue) means there is
    // legitimate remaining work. Gating on issue state (above) is sufficient:
    // if the issue is closed, dispatch is already blocked. If it is open,
    // dispatch must proceed regardless of prior PR history. See issue #775.

    if (entry.hasOpenPR) {
      this.metrics.staleDispatchesPrevented++;
      log.info("Stale dispatch prevented: issue has open PR", {
        repo,
        issueNumber,
        cachedAge: Date.now() - entry.fetchedAt,
      });
      return `issue ${repo}#${issueNumber} already has an open PR`;
    }

    return null;
  }

  /**
   * Invalidate a single cache entry.  Called when we know the state
   * has changed (e.g. after task dispatch, task completion, PR merge).
   */
  invalidate(repo: string, issueNumber: number): void {
    this.cache.delete(this.key(repo, issueNumber));
  }

  /**
   * Invalidate all entries for a given repo.
   */
  invalidateRepo(repo: string): void {
    const prefix = `${repo}#`;
    for (const k of this.cache.keys()) {
      if (k.startsWith(prefix)) {
        this.cache.delete(k);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get current cache metrics.
   */
  getMetrics(): IssueStateCacheMetrics {
    return {
      ...this.metrics,
      size: this.cache.size,
    };
  }

  /**
   * Reset metrics counters (useful for periodic reporting).
   */
  resetMetrics(): void {
    this.metrics.hits = 0;
    this.metrics.misses = 0;
    this.metrics.staleDispatchesPrevented = 0;
  }

  /**
   * Evict expired entries from the cache.
   * Called periodically to prevent stale entries from accumulating.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [k, entry] of this.cache) {
      if (now - entry.fetchedAt > this.ttlMs) {
        this.cache.delete(k);
        evicted++;
      }
    }
    return evicted;
  }

  /**
   * Evict the oldest entry when cache is at capacity.
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [k, entry] of this.cache) {
      if (entry.fetchedAt < oldestTime) {
        oldestTime = entry.fetchedAt;
        oldestKey = k;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton instance
// ---------------------------------------------------------------------------

let globalInstance: IssueStateCache | null = null;

/**
 * Get or create the global IssueStateCache singleton.
 * The singleton is lazily created on first access.
 */
export function getIssueStateCache(ttlMs?: number): IssueStateCache {
  if (!globalInstance) {
    globalInstance = new IssueStateCache(ttlMs);
    log.info("Issue state cache initialized", { ttlMs: ttlMs ?? DEFAULT_TTL_MS });
  }
  return globalInstance;
}

/**
 * Replace the global singleton (for testing or reconfiguration).
 */
export function setIssueStateCache(cache: IssueStateCache | null): void {
  globalInstance = cache;
}
