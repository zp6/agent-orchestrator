/**
 * Tests for the PR guard cooldown HTTP client (issue #1112).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  queryPRGuardCooldown,
  DEFAULT_REVIEWER_URL,
  COOLDOWN_CHECK_TIMEOUT_MS,
} from "./pr-guard-cooldown-client.js";

// ── fetch mock ────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  };
}

// ── helpers ───────────────────────────────────────────────────────────────────

const REPO = "rapartlu/agent-proxy";
const ISSUE = 440;
const REVIEWER_URL = "http://localhost:3474";

describe("queryPRGuardCooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── active cooldown ─────────────────────────────────────────────────────────

  it("returns { status: 'active' } when reviewer reports active cooldown", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(
      makeResponse({ active: true, expires_at: expiresAt, blocking_pr: 441 }),
    );

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result).toEqual({ status: "active", expires_at: expiresAt, blocking_pr: 441 });
  });

  it("includes blocking_pr in active result when reviewer provides it", async () => {
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    mockFetch.mockResolvedValueOnce(
      makeResponse({ active: true, expires_at: expiresAt, blocking_pr: 999 }),
    );

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result.status).toBe("active");
    if (result.status === "active") {
      expect(result.blocking_pr).toBe(999);
      expect(result.expires_at).toBe(expiresAt);
    }
  });

  it("returns { status: 'inactive' } when reviewer reports no active cooldown", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ active: false }));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result).toEqual({ status: "inactive" });
  });

  it("returns { status: 'inactive' } when active is true but expires_at is missing", async () => {
    // Malformed response — missing expires_at should be treated as inactive
    mockFetch.mockResolvedValueOnce(makeResponse({ active: true }));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result).toEqual({ status: "inactive" });
  });

  // ── fail-open scenarios ─────────────────────────────────────────────────────

  it("returns { status: 'unavailable' } on 404 (endpoint not implemented)", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({}, 404));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.error).toContain("404");
    }
  });

  it("returns { status: 'unavailable' } on HTTP 500", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({}, 500));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.error).toContain("500");
    }
  });

  it("returns { status: 'unavailable' } on network error (ECONNREFUSED)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:3474"));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.error).toContain("ECONNREFUSED");
    }
  });

  it("returns { status: 'unavailable' } on request timeout (AbortError)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("The operation was aborted"));

    const result = await queryPRGuardCooldown(REPO, ISSUE, REVIEWER_URL);

    expect(result.status).toBe("unavailable");
  });

  // ── URL construction ─────────────────────────────────────────────────────────

  it("builds the correct query URL with repo and issue params", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ active: false }));

    await queryPRGuardCooldown("owner/my-repo", 42, REVIEWER_URL);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, unknown];
    expect(calledUrl).toContain("/api/pr-guard-cooldowns");
    expect(calledUrl).toContain("repo=owner%2Fmy-repo");
    expect(calledUrl).toContain("issue=42");
  });

  it("uses DEFAULT_REVIEWER_URL when no url argument is passed", async () => {
    mockFetch.mockResolvedValueOnce(makeResponse({ active: false }));

    await queryPRGuardCooldown(REPO, ISSUE);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl] = mockFetch.mock.calls[0] as [string, unknown];
    expect(calledUrl).toContain(DEFAULT_REVIEWER_URL);
  });

  // ── exported constants ────────────────────────────────────────────────────────

  it("DEFAULT_REVIEWER_URL defaults to http://localhost:3474", () => {
    expect(DEFAULT_REVIEWER_URL).toBe("http://localhost:3474");
  });

  it("COOLDOWN_CHECK_TIMEOUT_MS is 3000", () => {
    expect(COOLDOWN_CHECK_TIMEOUT_MS).toBe(3_000);
  });
});
