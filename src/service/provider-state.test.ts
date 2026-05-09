/**
 * Tests for isRateLimitError() and parseResetTime() (provider-state.ts).
 *
 * Key coverage added for issue #1521:
 *   - "out of extra usage" / "extra usage" Anthropic quota patterns
 *   - "resets Xpm (UTC)" reset-time format
 */

import { describe, it, expect } from "vitest";
import { isRateLimitError, parseResetTime } from "./provider-state.js";

// ────────────────────────────────────────────────────────────────────────────
// isRateLimitError()
// ────────────────────────────────────────────────────────────────────────────

describe("isRateLimitError", () => {
  it("detects HTTP 429 by code string", () => {
    expect(isRateLimitError(new Error("429 Too Many Requests"))).toBe(true);
  });

  it("detects 'rate limit' phrase", () => {
    expect(isRateLimitError(new Error("You have hit your rate limit"))).toBe(true);
  });

  it("detects 'rate_limit' phrase", () => {
    expect(isRateLimitError(new Error("rate_limit exceeded"))).toBe(true);
  });

  it("detects 'hit your limit'", () => {
    expect(isRateLimitError(new Error("You have hit your limit for this period"))).toBe(true);
  });

  it("detects 'usage limit'", () => {
    expect(isRateLimitError(new Error("usage limit exceeded"))).toBe(true);
  });

  it("detects 'quota'", () => {
    expect(isRateLimitError(new Error("quota exhausted"))).toBe(true);
  });

  it("detects 'too many requests'", () => {
    expect(isRateLimitError(new Error("Too many requests"))).toBe(true);
  });

  it("detects 'overloaded'", () => {
    expect(isRateLimitError(new Error("API is currently overloaded"))).toBe(true);
  });

  // ── Issue #1521: Anthropic quota-exhaustion patterns ─────────────────────

  it("detects Anthropic 'out of extra usage' quota error (issue #1521)", () => {
    expect(
      isRateLimitError(
        new Error(
          `500 {"type":"error","error":{"type":"api_error","message":"You're out of extra usage · resets 1pm (UTC)"}}`,
        ),
      ),
    ).toBe(true);
  });

  it("detects 'extra usage' standalone phrase (issue #1521)", () => {
    expect(isRateLimitError(new Error("extra usage exhausted for this billing period"))).toBe(true);
  });

  it("detects 'out of daily' quota pattern (issue #1521)", () => {
    expect(isRateLimitError(new Error("out of daily tokens"))).toBe(true);
  });

  it("returns false for genuine connection error", () => {
    expect(isRateLimitError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe(false);
  });

  it("returns false for a logic error", () => {
    expect(isRateLimitError(new Error("agent returned invalid JSON output"))).toBe(false);
  });

  it("returns false for a generic 500 server error without quota text", () => {
    expect(isRateLimitError(new Error("Internal Server Error"))).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseResetTime()
// ────────────────────────────────────────────────────────────────────────────

describe("parseResetTime", () => {
  it("parses retry-after seconds", () => {
    const t = parseResetTime(new Error("Retry-After: 60"));
    expect(t).not.toBeNull();
    const delta = t!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThan(65_000);
  });

  it("parses retry-after with hyphen variant", () => {
    const t = parseResetTime(new Error("retry-after: 120"));
    expect(t).not.toBeNull();
    const delta = t!.getTime() - Date.now();
    expect(delta).toBeGreaterThan(115_000);
    expect(delta).toBeLessThan(125_000);
  });

  it("parses Codex 'try again at' date format", () => {
    const t = parseResetTime(new Error("Please try again at Apr 13th, 2026 10:21 PM"));
    // Should parse as a future-ish date (or well-formed Date object)
    expect(t).not.toBeNull();
    expect(t).toBeInstanceOf(Date);
    expect(isNaN(t!.getTime())).toBe(false);
  });

  // ── Issue #1521: Anthropic "resets Xpm (UTC)" format ─────────────────────

  it("parses 'resets 1pm (UTC)' (issue #1521)", () => {
    const msg = `You're out of extra usage · resets 1pm (UTC)`;
    const t = parseResetTime(new Error(msg));
    expect(t).not.toBeNull();
    expect(t!.getUTCHours()).toBe(13);
    expect(t!.getUTCMinutes()).toBe(0);
  });

  it("parses 'resets 11:30am (UTC)' (issue #1521)", () => {
    const t = parseResetTime(new Error("resets 11:30am (UTC)"));
    expect(t).not.toBeNull();
    expect(t!.getUTCHours()).toBe(11);
    expect(t!.getUTCMinutes()).toBe(30);
  });

  it("parses 'resets 12am (UTC)' — midnight edge case (issue #1521)", () => {
    const t = parseResetTime(new Error("resets 12am (UTC)"));
    expect(t).not.toBeNull();
    expect(t!.getUTCHours()).toBe(0);
    expect(t!.getUTCMinutes()).toBe(0);
  });

  it("parses 'resets 12pm (UTC)' — noon edge case (issue #1521)", () => {
    const t = parseResetTime(new Error("resets 12pm (UTC)"));
    expect(t).not.toBeNull();
    expect(t!.getUTCHours()).toBe(12);
    expect(t!.getUTCMinutes()).toBe(0);
  });

  it("parses 'resets at 3pm' without UTC tag (issue #1521)", () => {
    const t = parseResetTime(new Error("resets at 3pm"));
    expect(t).not.toBeNull();
    expect(t!.getUTCHours()).toBe(15);
  });

  it("reset time is always in the future (or moves to tomorrow if past) (issue #1521)", () => {
    // We can't easily fake 'now', so just check that the returned time is in the future
    // by using an obviously-past reset time: "resets 1am" — if it's currently after 1am
    // UTC the date should roll to tomorrow.
    const t = parseResetTime(new Error("resets 1am (UTC)"));
    expect(t).not.toBeNull();
    expect(t!.getTime()).toBeGreaterThan(Date.now());
  });

  it("falls back to 5-minute cooldown for unknown format", () => {
    const before = Date.now();
    const t = parseResetTime(new Error("something went wrong with no reset hint"));
    expect(t).not.toBeNull();
    const delta = t!.getTime() - before;
    // Should be ~5 minutes (allow ±1s)
    expect(delta).toBeGreaterThan(4 * 60 * 1000 - 1000);
    expect(delta).toBeLessThan(5 * 60 * 1000 + 1000);
  });
});
