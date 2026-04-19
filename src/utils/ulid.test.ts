/**
 * Tests for the monotonic ULID generator (issue #966).
 *
 * Verifies that `generateId()` produces unique, monotonically-increasing IDs
 * even when called many times within the same millisecond — the scenario that
 * caused task-ID collisions during batch dispatch.
 */

import { describe, it, expect } from "vitest";
import { decodeTime } from "ulid";
import { generateId } from "./ulid.js";

describe("generateId (monotonic ULID)", () => {
  it("returns a 26-character string", () => {
    expect(generateId()).toHaveLength(26);
  });

  it("returns only uppercase alphanumeric characters (Crockford base32)", () => {
    // ULID alphabet: 0-9 and A-Z excluding I, L, O, U
    expect(generateId()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("produces unique IDs across 1000 rapid successive calls (batch dispatch simulation)", () => {
    const count = 1000;
    const ids = Array.from({ length: count }, () => generateId());
    const unique = new Set(ids);
    expect(unique.size).toBe(count);
  });

  it("produces monotonically increasing IDs within the same millisecond", () => {
    // Force same-millisecond scenario by generating a tight batch
    const ids: string[] = [];
    const start = Date.now();
    while (Date.now() === start && ids.length < 200) {
      ids.push(generateId());
    }

    if (ids.length > 1) {
      // Every subsequent ID must be lexicographically greater than the previous
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]! > ids[i - 1]!).toBe(true);
      }
    }
  });

  it("produces IDs that sort chronologically by lexicographic order", () => {
    // Two IDs generated in sequence; the first must be <= the second
    const a = generateId();
    const b = generateId();
    expect(a <= b).toBe(true);
  });

  it("encodes a timestamp in the first 10 characters that is close to Date.now()", () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();

    // Decode the timestamp from the first 10 base32 chars
    const ts = decodeTime(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("consecutive IDs from rapid calls are all different (no two match)", () => {
    const a = generateId();
    const b = generateId();
    const c = generateId();
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});
