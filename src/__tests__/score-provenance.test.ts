/**
 * Unit tests for score-provenance.ts (issue #483)
 */

import { describe, it, expect, vi } from "vitest";
import {
  deriveScoreSource,
  shouldBlockDefaultFallbackApproval,
  getScoreProvenancePayload,
  parseScoreProvenanceParams,
  formatScoreProvenanceForTelegram,
  PARSE_FAILURE_NOTES_SENTINEL,
  SCORE_PROVENANCE_MIGRATION_SQL,
} from "../reviewer/score-provenance.js";
import type { VerificationResultRecord } from "../state/types.js";
import type { IScoreProvenanceStore } from "../reviewer/score-provenance.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRecord(
  overrides: Partial<VerificationResultRecord & { score_source?: string | null }> = {},
): VerificationResultRecord & { score_source?: string | null } {
  return {
    task_id: "TASK_01",
    score: 0.85,
    first_pass: 1,
    rejection_reason: null,
    blocked_reason: null,
    approval_rationale: null,
    threshold: 0.8,
    agent_id: "claude-test-agent",
    timestamp: "2026-04-25T09:00:00.000Z",
    ...overrides,
  };
}

function makeStore(record: ReturnType<typeof makeRecord> | null): IScoreProvenanceStore {
  return {
    getLatestVerificationRecord: vi.fn(() => record),
  };
}

// ── deriveScoreSource ──────────────────────────────────────────────────────────

describe("deriveScoreSource", () => {
  it("returns llm_parse when score_source is explicitly set", () => {
    expect(deriveScoreSource(makeRecord({ score_source: "llm_parse" }))).toBe("llm_parse");
  });

  it("returns default_fallback when score_source is explicitly set", () => {
    expect(deriveScoreSource(makeRecord({ score_source: "default_fallback" }))).toBe(
      "default_fallback",
    );
  });

  it("returns operator_override when score_source is explicitly set", () => {
    expect(deriveScoreSource(makeRecord({ score_source: "operator_override" }))).toBe(
      "operator_override",
    );
  });

  it("falls back to operator_override when bypass_reason matches", () => {
    expect(
      deriveScoreSource(makeRecord({ score_source: null, bypass_reason: "operator_override" })),
    ).toBe("operator_override");
  });

  it("falls back to default_fallback when rejection_reason contains sentinel", () => {
    expect(
      deriveScoreSource(
        makeRecord({
          score_source: null,
          rejection_reason: PARSE_FAILURE_NOTES_SENTINEL,
        }),
      ),
    ).toBe("default_fallback");
  });

  it("falls back to llm_parse for legacy records with no score_source", () => {
    expect(deriveScoreSource(makeRecord({ score_source: null }))).toBe("llm_parse");
    expect(deriveScoreSource(makeRecord({ score_source: undefined }))).toBe("llm_parse");
  });
});

// ── shouldBlockDefaultFallbackApproval ────────────────────────────────────────

describe("shouldBlockDefaultFallbackApproval", () => {
  it("returns true for default_fallback scores", () => {
    expect(
      shouldBlockDefaultFallbackApproval(makeRecord({ score_source: "default_fallback" })),
    ).toBe(true);
  });

  it("returns false for llm_parse scores", () => {
    expect(
      shouldBlockDefaultFallbackApproval(makeRecord({ score_source: "llm_parse" })),
    ).toBe(false);
  });

  it("returns false for operator_override scores", () => {
    expect(
      shouldBlockDefaultFallbackApproval(makeRecord({ score_source: "operator_override" })),
    ).toBe(false);
  });

  it("returns true when legacy rejection_reason contains parse failure sentinel", () => {
    expect(
      shouldBlockDefaultFallbackApproval(
        makeRecord({
          score_source: null,
          rejection_reason: PARSE_FAILURE_NOTES_SENTINEL,
        }),
      ),
    ).toBe(true);
  });
});

// ── getScoreProvenancePayload ──────────────────────────────────────────────────

describe("getScoreProvenancePayload", () => {
  it("returns record: null when task not found", () => {
    const store = makeStore(null);
    const result = getScoreProvenancePayload(store, "UNKNOWN_TASK");
    expect(result.record).toBeNull();
    expect(result.task_id).toBe("UNKNOWN_TASK");
    expect(result.generated_at).toBeTruthy();
  });

  it("returns record with llm_parse source when score_source is not set", () => {
    const record = makeRecord({ score_source: null, score: 0.85 });
    const store = makeStore(record);
    const result = getScoreProvenancePayload(store, "TASK_01");
    expect(result.record).not.toBeNull();
    expect(result.record!.score_source).toBe("llm_parse");
    expect(result.record!.should_block_auto_approval).toBe(false);
    expect(result.record!.block_reason).toBeNull();
  });

  it("returns should_block_auto_approval=true for default_fallback", () => {
    const record = makeRecord({ score_source: "default_fallback", score: 0 });
    const store = makeStore(record);
    const result = getScoreProvenancePayload(store, "TASK_01");
    expect(result.record!.score_source).toBe("default_fallback");
    expect(result.record!.should_block_auto_approval).toBe(true);
    expect(result.record!.block_reason).toMatch(/parse failure/i);
  });

  it("maps first_pass=1 to approved=true", () => {
    const record = makeRecord({ first_pass: 1 });
    const store = makeStore(record);
    const result = getScoreProvenancePayload(store, "TASK_01");
    expect(result.record!.approved).toBe(true);
  });

  it("maps first_pass=0 to approved=false", () => {
    const record = makeRecord({ first_pass: 0 });
    const store = makeStore(record);
    const result = getScoreProvenancePayload(store, "TASK_01");
    expect(result.record!.approved).toBe(false);
  });

  it("returns null record for empty task_id", () => {
    const store = makeStore(makeRecord());
    const result = getScoreProvenancePayload(store, "");
    expect(result.record).toBeNull();
  });

  it("returns null record when store throws", () => {
    const store: IScoreProvenanceStore = {
      getLatestVerificationRecord: () => {
        throw new Error("DB error");
      },
    };
    const result = getScoreProvenancePayload(store, "TASK_01");
    expect(result.record).toBeNull();
  });
});

// ── parseScoreProvenanceParams ────────────────────────────────────────────────

describe("parseScoreProvenanceParams", () => {
  it("returns task_id from params", () => {
    expect(parseScoreProvenanceParams({ task_id: "ABC123" })).toEqual({ task_id: "ABC123" });
  });

  it("trims whitespace", () => {
    expect(parseScoreProvenanceParams({ task_id: "  ABC123  " })).toEqual({ task_id: "ABC123" });
  });

  it("returns null for missing task_id", () => {
    expect(parseScoreProvenanceParams({})).toEqual({ task_id: null });
    expect(parseScoreProvenanceParams({ task_id: "" })).toEqual({ task_id: null });
    expect(parseScoreProvenanceParams({ task_id: "   " })).toEqual({ task_id: null });
  });
});

// ── formatScoreProvenanceForTelegram ──────────────────────────────────────────

describe("formatScoreProvenanceForTelegram", () => {
  it("shows 'no verification record found' when record is null", () => {
    const payload = { generated_at: "", task_id: "TASK_01", record: null };
    const output = formatScoreProvenanceForTelegram(payload);
    expect(output).toContain("no verification record found");
  });

  it("shows parse-failure warning for default_fallback", () => {
    const record = makeRecord({ score_source: "default_fallback", score: 0 });
    const store = makeStore(record);
    const payload = getScoreProvenancePayload(store, "TASK_01");
    const output = formatScoreProvenanceForTelegram(payload);
    expect(output).toContain("parse-failure fallback");
    expect(output).toContain("Auto-approval blocked");
    expect(output).toContain("🚨");
  });

  it("shows LLM parse label for normal scores", () => {
    const record = makeRecord({ score_source: "llm_parse", score: 0.85 });
    const store = makeStore(record);
    const payload = getScoreProvenancePayload(store, "TASK_01");
    const output = formatScoreProvenanceForTelegram(payload);
    expect(output).toContain("LLM parse");
    expect(output).toContain("🤖");
  });

  it("shows operator override label", () => {
    const record = makeRecord({ score_source: "operator_override", score: 0.5 });
    const store = makeStore(record);
    const payload = getScoreProvenancePayload(store, "TASK_01");
    const output = formatScoreProvenanceForTelegram(payload);
    expect(output).toContain("operator override");
    expect(output).toContain("👤");
  });
});

// ── SCORE_PROVENANCE_MIGRATION_SQL ────────────────────────────────────────────

describe("SCORE_PROVENANCE_MIGRATION_SQL", () => {
  it("contains ALTER TABLE statement for verification_results", () => {
    expect(SCORE_PROVENANCE_MIGRATION_SQL).toContain("ALTER TABLE verification_results");
    expect(SCORE_PROVENANCE_MIGRATION_SQL).toContain("score_source");
  });
});
