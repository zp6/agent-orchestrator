/**
 * Tests for antibody-harvester (issue #1394) — Phase 2 of fleet adaptive immunity.
 *
 * Tests cover:
 *   - Error genome classification
 *   - Error signature normalisation
 *   - Failure→fix sequence extraction
 *   - Fitness scoring (confidence boost / decay)
 *   - Auto-cull of low-confidence signals
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyErrorReason,
  normaliseErrorSignature,
  AntibodyHarvester,
  CONFIDENCE_BOOST,
  CONFIDENCE_DECAY,
  CULL_CONFIDENCE_THRESHOLD,
  CULL_MIN_INJECTIONS,
  type HarvestedAntibody,
  type ErrorClass,
} from "./antibody-harvester.js";
import type { AntibodyLogEntry, Signal, StateStore } from "../state/store.js";

// ── classifyErrorReason ──────────────────────────────────────────────────────

describe("classifyErrorReason", () => {
  it("classifies schema violations", () => {
    expect(classifyErrorReason("Missing migration for schema change")).toBe("schema_violation");
    expect(classifyErrorReason("alter table missing column")).toBe("schema_violation");
  });

  it("classifies missing tests", () => {
    expect(classifyErrorReason("No test added for this feature")).toBe("test_missing");
    expect(classifyErrorReason("Add test coverage for the new path")).toBe("test_missing");
  });

  it("classifies TypeScript type errors", () => {
    expect(classifyErrorReason("TypeScript error: type mismatch on line 42")).toBe("type_error");
    expect(classifyErrorReason("Property does not exist on type Foo")).toBe("type_error");
  });

  it("classifies merge conflicts", () => {
    expect(classifyErrorReason("Found conflict marker <<<<<<")).toBe("merge_conflict");
  });

  it("classifies regressions", () => {
    expect(classifyErrorReason("This change broke existing tests")).toBe("regression");
    expect(classifyErrorReason("Previously working endpoint now fails")).toBe("regression");
  });

  it("classifies build failures", () => {
    expect(classifyErrorReason("Build failed during tsc compilation")).toBe("build_failure");
  });

  it("classifies import errors", () => {
    expect(classifyErrorReason("Cannot find module './foo.js'")).toBe("import_error");
    expect(classifyErrorReason("Module not found: wrong import path")).toBe("import_error");
  });

  it("classifies missing teardown", () => {
    expect(classifyErrorReason("Resource leak: connection not closed in finally block")).toBe("missing_teardown");
  });

  it("classifies auth bypass", () => {
    expect(classifyErrorReason("Missing auth check — endpoint is unauthenticated")).toBe("auth_bypass");
  });

  it("classifies rate limit", () => {
    expect(classifyErrorReason("Rate limit hit: 429 too many requests")).toBe("rate_limit");
  });

  it("falls back to unknown for unrecognised patterns", () => {
    expect(classifyErrorReason("Unclear reason text without any keywords")).toBe("unknown");
    expect(classifyErrorReason("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(classifyErrorReason("MISSING MIGRATION FOR SCHEMA CHANGE")).toBe("schema_violation");
    expect(classifyErrorReason("TYPE ERROR on line 10")).toBe("type_error");
  });
});

// ── normaliseErrorSignature ──────────────────────────────────────────────────

describe("normaliseErrorSignature", () => {
  it("prefixes the key with the error class", () => {
    const key = normaliseErrorSignature("missing test coverage", "test_missing");
    expect(key.startsWith("test_missing:")).toBe(true);
  });

  it("produces stable keys for similar reasons", () => {
    const a = normaliseErrorSignature("No tests added for this function", "test_missing");
    const b = normaliseErrorSignature("No tests added for this function", "test_missing");
    expect(a).toBe(b);
  });

  it("removes stop words", () => {
    const key = normaliseErrorSignature("the schema was missing a migration", "schema_violation");
    expect(key).not.toContain("the");
    expect(key).not.toContain("was");
  });

  it("sorts tokens for stability across word order", () => {
    const a = normaliseErrorSignature("migration schema missing", "schema_violation");
    const b = normaliseErrorSignature("schema migration missing", "schema_violation");
    // Both should map to the same sorted token set
    expect(a).toBe(b);
  });

  it("uses 'generic' when no meaningful tokens remain", () => {
    const key = normaliseErrorSignature("is in the", "unknown");
    expect(key).toBe("unknown:generic");
  });
});

// ── AntibodyHarvester ────────────────────────────────────────────────────────

// ── Store mock factory ────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<AntibodyLogEntry> = {}): AntibodyLogEntry {
  return {
    id: 1,
    repo: "rapartlu/agent-orchestrator",
    pr_number: 100,
    diff_shape: "{}",
    decision: "request-changes",
    outcome: null,
    reason: "Missing migration for schema change",
    agent: "claude-agent-orchestrator",
    timestamp: "2026-04-01T10:00:00.000Z",
    false_positive: 0,
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 1,
    agent: "antibody-harvester",
    signal_type: "failure_antibody",
    key: "schema_violation:change_migration_missing_schema",
    value: JSON.stringify({
      fix_hint: "Added the missing migration",
      error_class: "schema_violation",
      source_pr: "rapartlu/agent-orchestrator#101",
      failure_pr: "rapartlu/agent-orchestrator#100",
    }),
    repo: "rapartlu/agent-orchestrator",
    file_glob: null,
    confidence: 0.5,
    ttl_hours: 720,
    created_at: "2026-04-01T11:00:00.000Z",
    expires_at: "2026-05-01T11:00:00.000Z",
    ...overrides,
  };
}

function makeStore(overrides: Partial<{
  antibodyEntries: AntibodyLogEntry[];
  signals: Signal[];
  signalReadCount: number;
}>= {}): StateStore {
  const antibodyEntries = overrides.antibodyEntries ?? [];
  const signals = overrides.signals ?? [];
  const signalReadCount = overrides.signalReadCount ?? 0;

  return {
    getAntibodyEntries: vi.fn((opts: { decision?: string } = {}) =>
      antibodyEntries.filter((e) => !opts.decision || e.decision === opts.decision),
    ),
    readSignals: vi.fn(() => signals),
    writeSignal: vi.fn((params) => makeSignal({ key: params.key })),
    updateSignalConfidence: vi.fn(),
    cullFailureAntibodies: vi.fn(() => 0),
  } as unknown as StateStore;
}

// ── extractFailureAntibodies ──────────────────────────────────────────────────

describe("AntibodyHarvester.extractFailureAntibodies", () => {
  it("returns empty array when there are no failure entries", () => {
    const store = makeStore({ antibodyEntries: [] });
    const harvester = new AntibodyHarvester(store);
    const result = harvester.extractFailureAntibodies();
    expect(result).toHaveLength(0);
  });

  it("returns empty array when failures have no matching fix", () => {
    const failure = makeEntry({ decision: "request-changes", timestamp: "2026-04-01T10:00:00.000Z" });
    // No approve entries
    const store = makeStore({ antibodyEntries: [failure] });
    const harvester = new AntibodyHarvester(store);
    const result = harvester.extractFailureAntibodies();
    expect(result).toHaveLength(0);
  });

  it("skips failure entries with no reason text", () => {
    const failure = makeEntry({ decision: "request-changes", reason: null });
    const fix = makeEntry({
      id: 2,
      pr_number: 101,
      decision: "approve",
      reason: "Added the missing migration",
      timestamp: "2026-04-01T12:00:00.000Z",
    });
    const store = makeStore({ antibodyEntries: [failure, fix] });
    const harvester = new AntibodyHarvester(store);
    const result = harvester.extractFailureAntibodies();
    expect(result).toHaveLength(0);
  });

  it("emits a new signal for a failure→fix sequence on the same PR", () => {
    const failure = makeEntry({
      id: 1,
      pr_number: 100,
      decision: "request-changes",
      reason: "Missing migration for schema change",
      timestamp: "2026-04-01T10:00:00.000Z",
    });
    const fix = makeEntry({
      id: 2,
      pr_number: 100, // same PR — revision cycle
      decision: "approve",
      reason: "Author added the migration, looks good",
      timestamp: "2026-04-02T10:00:00.000Z",
    });
    const store = makeStore({ antibodyEntries: [failure, fix], signals: [] });
    const harvester = new AntibodyHarvester(store);

    const result = harvester.extractFailureAntibodies();

    expect(result).toHaveLength(1);
    expect(result[0].is_new).toBe(true);
    expect(result[0].error_class).toBe("schema_violation");
    expect(store.writeSignal).toHaveBeenCalledOnce();

    const writeCall = vi.mocked(store.writeSignal).mock.calls[0][0];
    expect(writeCall.signal_type).toBe("failure_antibody");
    expect(writeCall.confidence).toBe(0.5);
    expect(writeCall.value.fix_hint).toContain("Author added the migration");
    expect(writeCall.value.failure_pr).toBe("rapartlu/agent-orchestrator#100");
  });

  it("emits a signal for a failure→fix sequence on a later PR", () => {
    const failure = makeEntry({
      id: 1,
      pr_number: 100,
      decision: "request-changes",
      reason: "No tests added for the new path",
      timestamp: "2026-04-01T10:00:00.000Z",
    });
    const fix = makeEntry({
      id: 2,
      pr_number: 105, // follow-up PR
      decision: "approve",
      reason: "Added comprehensive test suite",
      timestamp: "2026-04-03T10:00:00.000Z",
    });
    const store = makeStore({ antibodyEntries: [failure, fix], signals: [] });
    const harvester = new AntibodyHarvester(store);

    const result = harvester.extractFailureAntibodies();

    expect(result).toHaveLength(1);
    expect(result[0].is_new).toBe(true);
    expect(result[0].error_class).toBe("test_missing");
    expect(result[0].payload.source_pr).toBe("rapartlu/agent-orchestrator#105");
  });

  it("reinforces an existing signal instead of creating a duplicate", () => {
    const failure = makeEntry({
      id: 1,
      pr_number: 200,
      decision: "request-changes",
      reason: "Missing migration for schema change",
      timestamp: "2026-04-10T10:00:00.000Z",
    });
    const fix = makeEntry({
      id: 2,
      pr_number: 200,
      decision: "approve",
      reason: "Migration added",
      timestamp: "2026-04-11T10:00:00.000Z",
    });

    // Pre-existing signal with the same key
    const existingKey = normaliseErrorSignature("Missing migration for schema change", "schema_violation");
    const existing = makeSignal({ id: 42, key: existingKey });

    const store = makeStore({ antibodyEntries: [failure, fix], signals: [existing] });
    const harvester = new AntibodyHarvester(store);

    const result = harvester.extractFailureAntibodies();

    expect(result).toHaveLength(1);
    expect(result[0].is_new).toBe(false);
    expect(result[0].signal_id).toBe(42);
    // Should boost existing, not create new
    expect(store.writeSignal).not.toHaveBeenCalled();
    expect(store.updateSignalConfidence).toHaveBeenCalledWith(42, CONFIDENCE_BOOST);
  });

  it("ignores fix entries that predate the failure", () => {
    const failure = makeEntry({
      id: 1,
      pr_number: 100,
      decision: "request-changes",
      reason: "Missing migration for schema change",
      timestamp: "2026-04-05T10:00:00.000Z",
    });
    // This approval predates the failure — must NOT be treated as a fix
    const olderApproval = makeEntry({
      id: 2,
      pr_number: 99,
      decision: "approve",
      reason: "Good PR",
      timestamp: "2026-04-04T10:00:00.000Z", // before failure
    });
    const store = makeStore({ antibodyEntries: [failure, olderApproval], signals: [] });
    const harvester = new AntibodyHarvester(store);

    const result = harvester.extractFailureAntibodies();
    expect(result).toHaveLength(0);
  });
});

// ── scoreDispatchOutcome ──────────────────────────────────────────────────────

describe("AntibodyHarvester.scoreDispatchOutcome", () => {
  it("boosts confidence on successful dispatch", () => {
    const existingSignal = makeSignal({ id: 7, key: "schema_violation:migration_schema" });
    const store = makeStore({ signals: [existingSignal] });
    const harvester = new AntibodyHarvester(store);

    const updated = harvester.scoreDispatchOutcome({
      signalKey: "schema_violation:migration_schema",
      outcome: "success",
    });

    expect(updated).toBe(true);
    expect(store.updateSignalConfidence).toHaveBeenCalledWith(7, CONFIDENCE_BOOST);
  });

  it("decays confidence on failed dispatch", () => {
    const existingSignal = makeSignal({ id: 8, key: "test_missing:coverage_tests" });
    const store = makeStore({ signals: [existingSignal] });
    const harvester = new AntibodyHarvester(store);

    const updated = harvester.scoreDispatchOutcome({
      signalKey: "test_missing:coverage_tests",
      outcome: "failure",
      failureErrorClass: "test_missing",
    });

    expect(updated).toBe(true);
    expect(store.updateSignalConfidence).toHaveBeenCalledWith(8, -CONFIDENCE_DECAY);
  });

  it("returns false when signal key is not found", () => {
    const store = makeStore({ signals: [] });
    const harvester = new AntibodyHarvester(store);

    const updated = harvester.scoreDispatchOutcome({
      signalKey: "nonexistent:key",
      outcome: "success",
    });

    expect(updated).toBe(false);
    expect(store.updateSignalConfidence).not.toHaveBeenCalled();
  });
});

// ── cullStaleAntibodies ───────────────────────────────────────────────────────

describe("AntibodyHarvester.cullStaleAntibodies", () => {
  it("delegates to store.cullFailureAntibodies with defaults", () => {
    const store = makeStore();
    vi.mocked(store.cullFailureAntibodies).mockReturnValue(3);
    const harvester = new AntibodyHarvester(store);

    const deleted = harvester.cullStaleAntibodies();

    expect(deleted).toBe(3);
    expect(store.cullFailureAntibodies).toHaveBeenCalledWith(
      CULL_CONFIDENCE_THRESHOLD,
      CULL_MIN_INJECTIONS,
    );
  });

  it("passes custom thresholds to store", () => {
    const store = makeStore();
    vi.mocked(store.cullFailureAntibodies).mockReturnValue(1);
    const harvester = new AntibodyHarvester(store);

    harvester.cullStaleAntibodies({ min_confidence: 0.3, min_injections: 5 });

    expect(store.cullFailureAntibodies).toHaveBeenCalledWith(0.3, 5);
  });
});

// ── Constant exports ──────────────────────────────────────────────────────────

describe("exported constants", () => {
  it("CONFIDENCE_BOOST is 0.05", () => {
    expect(CONFIDENCE_BOOST).toBe(0.05);
  });

  it("CONFIDENCE_DECAY is 0.10", () => {
    expect(CONFIDENCE_DECAY).toBe(0.10);
  });

  it("CULL_CONFIDENCE_THRESHOLD is 0.2", () => {
    expect(CULL_CONFIDENCE_THRESHOLD).toBe(0.2);
  });

  it("CULL_MIN_INJECTIONS is 10", () => {
    expect(CULL_MIN_INJECTIONS).toBe(10);
  });
});
