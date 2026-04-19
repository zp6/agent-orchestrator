/**
 * Tests for the Score-Bypass Violation Report module (issue #356).
 *
 * Covers:
 *  1. getScoreViolationsPayload — basic threshold filtering
 *  2. Correct ordering: lowest score first
 *  3. Per-agent summary: count, avg_score, min_score, buckets
 *  4. Score bucket classification (critical, low, marginal, borderline)
 *  5. Time window filtering (days parameter)
 *  6. Agent name filtering
 *  7. Dimension breakdown parsed from verification_notes
 *  8. PR URL extraction from source_ref
 *  9. Custom threshold, days, and limit overrides
 * 10. Empty store edge case
 * 11. formatScoreViolationsForTelegram — output sections
 * 12. Tasks at exactly the threshold are excluded (strict <)
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import {
  getScoreViolationsPayload,
  formatScoreViolationsForTelegram,
  SCORE_VIOLATIONS_DEFAULT_THRESHOLD,
  SCORE_VIOLATIONS_DEFAULT_DAYS,
  SCORE_VIOLATIONS_DEFAULT_LIMIT,
  SCORE_BUCKETS,
} from "../reviewer/score-violations.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

function isoAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-sv-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    verification_notes?: string | null;
    quality_explanation?: string | null;
    source_ref?: string | null;
    bypass_reason?: string | null;
    updated_at?: string;
    status?: string;
    task_type?: string;
  }) => {
    seq += 1;
    const id = `01TEST${String(seq).padStart(14, "0")}`;
    const now = overrides.updated_at ?? isoNow();
    writer
      .prepare(
        `INSERT INTO tasks
           (id, title, description, status, agent_name, task_type, source_ref,
            verification_status, quality_score, verification_notes,
            quality_explanation, bypass_reason,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${seq}`,
        null,
        overrides.status ?? "done",
        overrides.agent_name ?? "test-agent",
        overrides.task_type ?? "implementation",
        overrides.source_ref ?? null,
        overrides.verification_status ?? "approved",
        overrides.quality_score ?? null,
        overrides.verification_notes ?? null,
        overrides.quality_explanation ?? null,
        overrides.bypass_reason ?? null,
        now,
        now,
      );
    return id;
  };

  const cleanup = () => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { store, writer, insertTask, dir, cleanup };
}

// ── Constants ────────────────────────────────────────────────────────────────

describe("score-violations constants", () => {
  it("default threshold is 0.80", () => {
    expect(SCORE_VIOLATIONS_DEFAULT_THRESHOLD).toBe(0.80);
  });

  it("default days is 7", () => {
    expect(SCORE_VIOLATIONS_DEFAULT_DAYS).toBe(7);
  });

  it("default limit is 100", () => {
    expect(SCORE_VIOLATIONS_DEFAULT_LIMIT).toBe(100);
  });

  it("SCORE_BUCKETS covers 0 to 0.80", () => {
    expect(SCORE_BUCKETS).toHaveLength(4);
    expect(SCORE_BUCKETS[0].label).toBe("critical");
    expect(SCORE_BUCKETS[3].label).toBe("borderline");
  });
});

// ── getScoreViolationsPayload ────────────────────────────────────────────────

describe("getScoreViolationsPayload", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns empty payload when no approved tasks exist", () => {
    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.total).toBe(0);
    expect(payload.violations).toHaveLength(0);
    expect(payload.per_agent).toHaveLength(0);
    expect(payload.threshold).toBe(0.80);
    expect(payload.days).toBe(7);
  });

  it("uses default threshold (0.80) when no options provided", () => {
    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.threshold).toBe(SCORE_VIOLATIONS_DEFAULT_THRESHOLD);
  });

  it("includes approved tasks below threshold", () => {
    fixture.insertTask({ quality_score: 0.42 });
    fixture.insertTask({ quality_score: 0.55 });
    fixture.insertTask({ quality_score: 0.70 });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.total).toBe(3);
    expect(payload.violations.map((v) => v.quality_score)).toEqual([0.42, 0.55, 0.70]);
  });

  it("excludes tasks at exactly the threshold (strict <)", () => {
    fixture.insertTask({ quality_score: 0.80 });
    fixture.insertTask({ quality_score: 0.79 });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.total).toBe(1);
    expect(payload.violations[0]!.quality_score).toBe(0.79);
  });

  it("excludes rejected tasks", () => {
    fixture.insertTask({ quality_score: 0.55, verification_status: "rejected" });
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.total).toBe(1);
    expect(payload.violations[0]!.quality_score).toBe(0.65);
  });

  it("excludes tasks with null quality_score", () => {
    fixture.insertTask({ quality_score: null, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.60, verification_status: "approved" });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.total).toBe(1);
  });

  it("orders by score ascending (worst first)", () => {
    fixture.insertTask({ quality_score: 0.72 });
    fixture.insertTask({ quality_score: 0.45 });
    fixture.insertTask({ quality_score: 0.65 });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.violations.map((v) => v.quality_score)).toEqual([0.45, 0.65, 0.72]);
  });

  it("classifies violations into correct score buckets", () => {
    fixture.insertTask({ quality_score: 0.42 }); // critical
    fixture.insertTask({ quality_score: 0.55 }); // low
    fixture.insertTask({ quality_score: 0.65 }); // marginal
    fixture.insertTask({ quality_score: 0.78 }); // borderline

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.violations[0]!.bucket).toBe("critical");
    expect(payload.violations[1]!.bucket).toBe("low");
    expect(payload.violations[2]!.bucket).toBe("marginal");
    expect(payload.violations[3]!.bucket).toBe("borderline");

    const byBucket = payload.by_bucket;
    expect(byBucket.find((b) => b.label === "critical")!.count).toBe(1);
    expect(byBucket.find((b) => b.label === "low")!.count).toBe(1);
    expect(byBucket.find((b) => b.label === "marginal")!.count).toBe(1);
    expect(byBucket.find((b) => b.label === "borderline")!.count).toBe(1);
  });

  it("respects time window (days parameter)", () => {
    fixture.insertTask({ quality_score: 0.60, updated_at: isoAgo(3) });  // within 7d
    fixture.insertTask({ quality_score: 0.65, updated_at: isoAgo(10) }); // outside 7d

    const payload = getScoreViolationsPayload(fixture.store, { days: 7 });
    expect(payload.total).toBe(1);
    expect(payload.violations[0]!.quality_score).toBe(0.60);
  });

  it("filters by agent name", () => {
    fixture.insertTask({ quality_score: 0.60, agent_name: "agent-alpha" });
    fixture.insertTask({ quality_score: 0.65, agent_name: "agent-beta" });

    const payload = getScoreViolationsPayload(fixture.store, { agent: "alpha" });
    expect(payload.total).toBe(1);
    expect(payload.violations[0]!.agent_name).toBe("agent-alpha");
    expect(payload.agent_filter).toBe("alpha");
  });

  it("respects custom threshold", () => {
    fixture.insertTask({ quality_score: 0.70 });
    fixture.insertTask({ quality_score: 0.75 });

    const at75 = getScoreViolationsPayload(fixture.store, { threshold: 0.75 });
    expect(at75.total).toBe(1);
    expect(at75.violations[0]!.quality_score).toBe(0.70);

    const at80 = getScoreViolationsPayload(fixture.store, { threshold: 0.80 });
    expect(at80.total).toBe(2);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.60 + i * 0.02 });
    }

    const payload = getScoreViolationsPayload(fixture.store, { limit: 3 });
    expect(payload.violations.length).toBeLessThanOrEqual(3);
  });

  it("builds per-agent summary sorted by count descending", () => {
    fixture.insertTask({ quality_score: 0.60, agent_name: "agent-a" });
    fixture.insertTask({ quality_score: 0.65, agent_name: "agent-a" });
    fixture.insertTask({ quality_score: 0.70, agent_name: "agent-b" });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.per_agent).toHaveLength(2);
    expect(payload.per_agent[0]!.agent_name).toBe("agent-a");
    expect(payload.per_agent[0]!.count).toBe(2);
    expect(payload.per_agent[1]!.agent_name).toBe("agent-b");
    expect(payload.per_agent[1]!.count).toBe(1);
  });

  it("per-agent summary includes avg_score and min_score", () => {
    fixture.insertTask({ quality_score: 0.60, agent_name: "agent-x" });
    fixture.insertTask({ quality_score: 0.70, agent_name: "agent-x" });

    const payload = getScoreViolationsPayload(fixture.store);
    const agentX = payload.per_agent.find((a) => a.agent_name === "agent-x");
    expect(agentX).toBeDefined();
    expect(agentX!.avg_score).toBeCloseTo(0.65, 2);
    expect(agentX!.min_score).toBe(0.60);
  });

  it("parses dimension breakdown from verification_notes", () => {
    fixture.insertTask({
      quality_score: 0.65,
      verification_notes: "**Correctness**: 80/100\n**Completeness**: 60/100\n**Test Coverage**: 50/100\n**Code Quality**: 70/100",
    });

    const payload = getScoreViolationsPayload(fixture.store);
    const dims = payload.violations[0]!.dimensions;
    expect(dims).not.toBeNull();
    expect(dims!.correctness).toBe(0.80);
    expect(dims!.completeness).toBe(0.60);
    expect(dims!.test_coverage).toBe(0.50);
    expect(dims!.code_quality).toBe(0.70);
  });

  it("identifies weakest dimension", () => {
    fixture.insertTask({
      quality_score: 0.65,
      verification_notes: "**Correctness**: 80/100\n**Completeness**: 60/100\n**Test Coverage**: 50/100\n**Code Quality**: 70/100",
    });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.violations[0]!.weakest_dimension).toBe("test_coverage");
  });

  it("extracts PR URL from source_ref", () => {
    fixture.insertTask({
      quality_score: 0.70,
      source_ref: "rapartlu/agent-dashboard/pull/42",
    });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.violations[0]!.pr_url).toBe("https://github.com/rapartlu/agent-dashboard/pull/42");
  });

  it("includes bypass_reason when present", () => {
    fixture.insertTask({
      quality_score: 0.55,
      bypass_reason: "operator_override",
    });

    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.violations[0]!.bypass_reason).toBe("operator_override");
  });

  it("has generated_at timestamp", () => {
    const payload = getScoreViolationsPayload(fixture.store);
    expect(payload.generated_at).toBeDefined();
    expect(new Date(payload.generated_at).toISOString()).toBe(payload.generated_at);
  });

  it("by_bucket percentages sum to approximately 1", () => {
    fixture.insertTask({ quality_score: 0.42 });
    fixture.insertTask({ quality_score: 0.55 });
    fixture.insertTask({ quality_score: 0.65 });
    fixture.insertTask({ quality_score: 0.78 });

    const payload = getScoreViolationsPayload(fixture.store);
    const totalPct = payload.by_bucket.reduce((sum, b) => sum + b.pct, 0);
    expect(totalPct).toBeCloseTo(1.0, 2);
  });
});

// ── formatScoreViolationsForTelegram ─────────────────────────────────────────

describe("formatScoreViolationsForTelegram", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("shows 'all good' message when no violations", () => {
    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload);
    expect(msg).toContain("No approved tasks below");
    expect(msg).toContain("80%");
  });

  it("includes violation count and threshold", () => {
    fixture.insertTask({ quality_score: 0.42 });
    fixture.insertTask({ quality_score: 0.65 });

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload);
    expect(msg).toContain("2 approved tasks");
    expect(msg).toContain("80%");
  });

  it("includes agent summary", () => {
    fixture.insertTask({ quality_score: 0.60, agent_name: "my-agent" });

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload);
    expect(msg).toContain("my-agent");
    expect(msg).toContain("By agent");
  });

  it("includes dimension breakdown when available", () => {
    fixture.insertTask({
      quality_score: 0.65,
      verification_notes: "**Correctness**: 80/100\n**Completeness**: 60/100\n**Test Coverage**: 50/100\n**Code Quality**: 70/100",
    });

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload);
    expect(msg).toContain("Corr:80");
    expect(msg).toContain("Test:50");
  });

  it("includes dashboard link when provided", () => {
    fixture.insertTask({ quality_score: 0.65 });

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload, 10, "https://dashboard.example.com");
    expect(msg).toContain("https://dashboard.example.com/score-violations");
  });

  it("truncates task list to maxTasks", () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.60 + i * 0.02 });
    }

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload, 2);
    expect(msg).toContain("and 3 more");
  });

  it("includes bucket severity breakdown", () => {
    fixture.insertTask({ quality_score: 0.42 }); // critical
    fixture.insertTask({ quality_score: 0.65 }); // marginal

    const payload = getScoreViolationsPayload(fixture.store);
    const msg = formatScoreViolationsForTelegram(payload);
    expect(msg).toContain("By severity");
    expect(msg).toContain("critical");
    expect(msg).toContain("marginal");
  });
});
