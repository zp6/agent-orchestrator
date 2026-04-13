import { describe, it, expect, beforeEach } from "vitest";
import {
  IssueStateCache,
  getIssueStateCache,
  setIssueStateCache,
  type IssueFetcher,
  type CachedIssueState,
  DEFAULT_TTL_MS,
} from "./issue-state-cache.js";

// Helper: create a mock fetcher that returns configurable state
function makeFetcher(
  state: "open" | "closed" = "open",
  hasOpenPR = false,
  hasMergedPR = false,
): IssueFetcher & { callCount: number } {
  const fn = Object.assign(
    (_repo: string, _issueNumber: number) => {
      fn.callCount++;
      return { state, hasOpenPR, hasMergedPR };
    },
    { callCount: 0 },
  );
  return fn;
}

describe("IssueStateCache", () => {
  let cache: IssueStateCache;

  beforeEach(() => {
    cache = new IssueStateCache(60_000); // 60s TTL
  });

  // ────────────────────────────────────────────────────────────────────────
  // get/set basics
  // ────────────────────────────────────────────────────────────────────────

  it("returns undefined for cache miss", () => {
    expect(cache.get("owner/repo", 1)).toBeUndefined();
  });

  it("stores and retrieves cached state within TTL", () => {
    const entry: CachedIssueState = {
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    };
    cache.set("owner/repo", 42, entry);

    const result = cache.get("owner/repo", 42);
    expect(result).toEqual(entry);
  });

  it("returns undefined for expired entries", () => {
    const entry: CachedIssueState = {
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now() - 120_000, // 2 minutes ago — past 60s TTL
    };
    cache.set("owner/repo", 42, entry);

    expect(cache.get("owner/repo", 42)).toBeUndefined();
  });

  it("tracks hits on cache get", () => {
    const entry: CachedIssueState = {
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    };
    cache.set("owner/repo", 42, entry);

    cache.get("owner/repo", 42);
    cache.get("owner/repo", 42);

    expect(cache.getMetrics().hits).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────────────
  // getOrFetch
  // ────────────────────────────────────────────────────────────────────────

  it("fetches on miss and caches the result", () => {
    const fetcher = makeFetcher("open");

    const result = cache.getOrFetch("owner/repo", 1, fetcher);

    expect(result.state).toBe("open");
    expect(fetcher.callCount).toBe(1);

    // Second call should hit cache
    cache.getOrFetch("owner/repo", 1, fetcher);
    expect(fetcher.callCount).toBe(1);
    expect(cache.getMetrics().hits).toBe(1);
    expect(cache.getMetrics().misses).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // isIssueOpen
  // ────────────────────────────────────────────────────────────────────────

  it("returns true for open issues", () => {
    const fetcher = makeFetcher("open");
    expect(cache.isIssueOpen("owner/repo", 1, fetcher)).toBe(true);
  });

  it("returns false for closed issues", () => {
    const fetcher = makeFetcher("closed");
    expect(cache.isIssueOpen("owner/repo", 1, fetcher)).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────────────
  // validateForDispatch
  // ────────────────────────────────────────────────────────────────────────

  it("returns null for dispatchable issues", () => {
    const fetcher = makeFetcher("open", false, false);
    expect(cache.validateForDispatch("owner/repo", 1, fetcher)).toBeNull();
  });

  it("blocks dispatch for closed issues and increments metric", () => {
    const fetcher = makeFetcher("closed");
    const reason = cache.validateForDispatch("owner/repo", 1, fetcher);
    expect(reason).toContain("closed");
    expect(cache.getMetrics().staleDispatchesPrevented).toBe(1);
  });

  it("allows dispatch for open issues with a merged PR (issue #775)", () => {
    // An open issue with a merged PR means the PR did not close the issue —
    // there is still work to do. Dispatch must be allowed; only issue state
    // (open/closed) is authoritative.
    const fetcher = makeFetcher("open", false, true);
    const reason = cache.validateForDispatch("owner/repo", 1, fetcher);
    expect(reason).toBeNull();
    expect(cache.getMetrics().staleDispatchesPrevented).toBe(0);
  });

  it("blocks dispatch for closed issues even when no merged PR", () => {
    const fetcher = makeFetcher("closed", false, false);
    const reason = cache.validateForDispatch("owner/repo", 1, fetcher);
    expect(reason).toContain("closed");
    expect(cache.getMetrics().staleDispatchesPrevented).toBe(1);
  });

  it("blocks dispatch for issues with open PR", () => {
    const fetcher = makeFetcher("open", true, false);
    const reason = cache.validateForDispatch("owner/repo", 1, fetcher);
    expect(reason).toContain("open PR");
    expect(cache.getMetrics().staleDispatchesPrevented).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // invalidation
  // ────────────────────────────────────────────────────────────────────────

  it("invalidates a single entry", () => {
    const fetcher = makeFetcher("open");
    cache.getOrFetch("owner/repo", 1, fetcher);
    cache.invalidate("owner/repo", 1);

    // Should need to re-fetch
    cache.getOrFetch("owner/repo", 1, fetcher);
    expect(fetcher.callCount).toBe(2);
  });

  it("invalidates all entries for a repo", () => {
    const fetcher = makeFetcher("open");
    cache.getOrFetch("owner/repo", 1, fetcher);
    cache.getOrFetch("owner/repo", 2, fetcher);
    cache.getOrFetch("other/repo", 3, fetcher);

    cache.invalidateRepo("owner/repo");

    // owner/repo entries should be gone
    expect(cache.get("owner/repo", 1)).toBeUndefined();
    expect(cache.get("owner/repo", 2)).toBeUndefined();
    // other/repo should still be cached
    expect(cache.get("other/repo", 3)).toBeDefined();
  });

  it("clears entire cache", () => {
    const fetcher = makeFetcher("open");
    cache.getOrFetch("owner/repo", 1, fetcher);
    cache.getOrFetch("owner/repo", 2, fetcher);

    cache.clear();
    expect(cache.getMetrics().size).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // eviction
  // ────────────────────────────────────────────────────────────────────────

  it("evicts expired entries", () => {
    // Manually set an old entry
    cache.set("owner/repo", 1, {
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now() - 120_000,
    });
    cache.set("owner/repo", 2, {
      state: "open",
      hasOpenPR: false,
      hasMergedPR: false,
      fetchedAt: Date.now(),
    });

    const evicted = cache.evictExpired();
    expect(evicted).toBe(1);
    expect(cache.getMetrics().size).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // metrics
  // ────────────────────────────────────────────────────────────────────────

  it("resets metrics", () => {
    const fetcher = makeFetcher("closed");
    cache.validateForDispatch("owner/repo", 1, fetcher);

    expect(cache.getMetrics().staleDispatchesPrevented).toBe(1);
    cache.resetMetrics();
    expect(cache.getMetrics().staleDispatchesPrevented).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // singleton
  // ────────────────────────────────────────────────────────────────────────

  it("provides a global singleton via getIssueStateCache", () => {
    setIssueStateCache(null); // reset
    const a = getIssueStateCache();
    const b = getIssueStateCache();
    expect(a).toBe(b);
    setIssueStateCache(null); // cleanup
  });

  it("allows replacing the singleton for testing", () => {
    const custom = new IssueStateCache(1000);
    setIssueStateCache(custom);
    expect(getIssueStateCache()).toBe(custom);
    setIssueStateCache(null); // cleanup
  });
});
