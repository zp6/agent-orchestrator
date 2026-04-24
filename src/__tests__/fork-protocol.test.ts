/**
 * Tests for the fork_from dispatch payload protocol (issue #454).
 *
 * The reviewer owns the canonical spec; these tests verify that the
 * helpers are correct and that the DB migration constant is present.
 */

import { describe, it, expect } from "vitest";
import {
  parseForkFrom,
  serialiseForkFrom,
  isValidForkConversationId,
  buildForkSpec,
  isExploratoryFork,
  KNOWN_FORK_LABELS,
  FORK_FROM_MIGRATION_SQL,
  FORK_FROM_COLUMN,
} from "../reviewer/fork-protocol.js";
import type { DispatchForkSpec } from "../reviewer/fork-protocol.js";

// A valid 26-char ULID for test fixtures
const VALID_ULID = "01KPYCV6X2DDQ4KVTJH690PM0F";
const ANOTHER_ULID = "01KPYZ0000000000000000000A";

// ── isValidForkConversationId ─────────────────────────────────────────────

describe("isValidForkConversationId", () => {
  it("accepts a valid 26-char ULID", () => {
    expect(isValidForkConversationId(VALID_ULID)).toBe(true);
  });

  it("accepts another valid ULID", () => {
    expect(isValidForkConversationId(ANOTHER_ULID)).toBe(true);
  });

  it("rejects a string shorter than 26 chars", () => {
    expect(isValidForkConversationId("SHORT")).toBe(false);
  });

  it("rejects a string longer than 26 chars", () => {
    expect(isValidForkConversationId(VALID_ULID + "X")).toBe(false);
  });

  it("accepts lowercase ulid (ULID spec is case-insensitive)", () => {
    // The /i flag on the regex means lowercase is accepted per the ULID spec
    expect(isValidForkConversationId(VALID_ULID.toLowerCase())).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidForkConversationId("")).toBe(false);
  });

  it("rejects a UUID-style string", () => {
    expect(isValidForkConversationId("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });
});

// ── buildForkSpec ─────────────────────────────────────────────────────────

describe("buildForkSpec", () => {
  it("returns a DispatchForkSpec with the given conversation_id", () => {
    const spec = buildForkSpec(VALID_ULID);
    expect(spec.conversation_id).toBe(VALID_ULID);
    expect(spec.fork_label).toBeUndefined();
  });

  it("includes fork_label when provided", () => {
    const spec = buildForkSpec(VALID_ULID, "immune-seed");
    expect(spec.fork_label).toBe("immune-seed");
  });

  it("truncates fork_label to 32 chars", () => {
    const longLabel = "a".repeat(40);
    const spec = buildForkSpec(VALID_ULID, longLabel);
    expect(spec.fork_label!.length).toBe(32);
  });

  it("throws on an invalid conversation_id", () => {
    expect(() => buildForkSpec("not-a-ulid")).toThrow(/Invalid fork_from conversation_id/);
  });

  it("throws on a short conversation_id", () => {
    expect(() => buildForkSpec("SHORT")).toThrow(/Invalid fork_from conversation_id/);
  });
});

// ── serialiseForkFrom / parseForkFrom round-trip ──────────────────────────

describe("serialiseForkFrom", () => {
  it("returns null for null input", () => {
    expect(serialiseForkFrom(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(serialiseForkFrom(undefined)).toBeNull();
  });

  it("serialises a DispatchForkSpec to JSON", () => {
    const spec: DispatchForkSpec = { conversation_id: VALID_ULID };
    const json = serialiseForkFrom(spec);
    expect(json).toBe(JSON.stringify({ conversation_id: VALID_ULID }));
  });

  it("includes fork_label in serialised JSON", () => {
    const spec: DispatchForkSpec = { conversation_id: VALID_ULID, fork_label: "parallel-subtask" };
    const json = serialiseForkFrom(spec)!;
    const parsed = JSON.parse(json);
    expect(parsed.fork_label).toBe("parallel-subtask");
  });
});

describe("parseForkFrom", () => {
  it("returns null for null input", () => {
    expect(parseForkFrom(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseForkFrom(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseForkFrom("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseForkFrom("not-json")).toBeNull();
  });

  it("returns null when conversation_id is missing", () => {
    expect(parseForkFrom(JSON.stringify({ fork_label: "test" }))).toBeNull();
  });

  it("returns null when conversation_id is not a string", () => {
    expect(parseForkFrom(JSON.stringify({ conversation_id: 42 }))).toBeNull();
  });

  it("parses a valid JSON DispatchForkSpec", () => {
    const spec: DispatchForkSpec = { conversation_id: VALID_ULID };
    const result = parseForkFrom(JSON.stringify(spec));
    expect(result).not.toBeNull();
    expect(result!.conversation_id).toBe(VALID_ULID);
  });

  it("preserves fork_label during parse", () => {
    const spec: DispatchForkSpec = { conversation_id: VALID_ULID, fork_label: "ab-exploration" };
    const result = parseForkFrom(JSON.stringify(spec));
    expect(result!.fork_label).toBe("ab-exploration");
  });
});

describe("serialiseForkFrom + parseForkFrom round-trip", () => {
  it("round-trips a spec without fork_label", () => {
    const spec = buildForkSpec(VALID_ULID);
    const json = serialiseForkFrom(spec)!;
    const parsed = parseForkFrom(json);
    expect(parsed).toEqual(spec);
  });

  it("round-trips a spec with fork_label", () => {
    const spec = buildForkSpec(VALID_ULID, "immune-seed");
    const json = serialiseForkFrom(spec)!;
    const parsed = parseForkFrom(json);
    expect(parsed).toEqual(spec);
  });
});

// ── isExploratoryFork ─────────────────────────────────────────────────────

describe("isExploratoryFork", () => {
  it("returns true for 'ab-exploration'", () => {
    expect(isExploratoryFork("ab-exploration")).toBe(true);
  });

  it("returns false for 'immune-seed'", () => {
    expect(isExploratoryFork("immune-seed")).toBe(false);
  });

  it("returns false for 'parallel-subtask'", () => {
    expect(isExploratoryFork("parallel-subtask")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isExploratoryFork(undefined)).toBe(false);
  });

  it("returns false for an unknown label", () => {
    expect(isExploratoryFork("unknown")).toBe(false);
  });
});

// ── KNOWN_FORK_LABELS ─────────────────────────────────────────────────────

describe("KNOWN_FORK_LABELS", () => {
  it("contains 'immune-seed'", () => {
    expect(KNOWN_FORK_LABELS).toContain("immune-seed");
  });

  it("contains 'parallel-subtask'", () => {
    expect(KNOWN_FORK_LABELS).toContain("parallel-subtask");
  });

  it("contains 'ab-exploration'", () => {
    expect(KNOWN_FORK_LABELS).toContain("ab-exploration");
  });
});

// ── DB migration constants ────────────────────────────────────────────────

describe("DB migration constants", () => {
  it("FORK_FROM_COLUMN is 'fork_from'", () => {
    expect(FORK_FROM_COLUMN).toBe("fork_from");
  });

  it("FORK_FROM_MIGRATION_SQL is the correct ALTER TABLE statement", () => {
    expect(FORK_FROM_MIGRATION_SQL).toBe("ALTER TABLE tasks ADD COLUMN fork_from TEXT");
  });

  it("migration SQL references the correct column name", () => {
    expect(FORK_FROM_MIGRATION_SQL).toContain(FORK_FROM_COLUMN);
  });
});
