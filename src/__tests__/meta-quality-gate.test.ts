/**
 * Tests for the Meta-Quality Gate (issue #357).
 *
 * Covers:
 *  1. isMetaQualityTask — keyword matching (positive cases)
 *  2. isMetaQualityTask — no match (negative cases)
 *  3. isMetaQualityTask — case-insensitivity
 *  4. isMetaQualityTask — empty / null title
 *  5. matchedMetaQualityKeyword — returns first matched keyword
 *  6. matchedMetaQualityKeyword — returns null when no match
 *  7. applyMetaQualityGateToResult — fires when meta-quality task approved below floor
 *  8. applyMetaQualityGateToResult — no-op when score ≥ META_QUALITY_FLOOR
 *  9. applyMetaQualityGateToResult — no-op when already rejected (approved=false)
 * 10. applyMetaQualityGateToResult — no-op when title has no keyword
 * 11. applyMetaQualityGateToResult — banner included in notes
 * 12. applyMetaQualityGateToResult — metaQualityRejected flag set
 * 13. applyMetaQualityGateToResult — original revision included in enriched revision
 * 14. buildMetaQualityAlertBody — contains task ID, agent, score, keyword
 * 15. Verifier integration — meta-quality gate overrides approval for enforcement tasks
 * 16. Verifier integration — gate is no-op for normal tasks below 0.85
 * 17. Verifier integration — gate is no-op when score ≥ 0.85
 * 18. META_QUALITY_FLOOR exported constant equals 0.85
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isMetaQualityTask,
  matchedMetaQualityKeyword,
  applyMetaQualityGateToResult,
  buildMetaQualityAlertBody,
  META_QUALITY_FLOOR,
  META_QUALITY_KEYWORDS,
} from "../reviewer/meta-quality-gate.js";
import { StateStore } from "../state/store.js";
import { Verifier } from "../reviewer/verifier.js";

// ── LLM client mock — controlled per-test via `mockLLMResponse` ───────────────

let mockResponseText = "";

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    messages: {
      create: vi.fn().mockImplementation(async () => ({
        content: [{ type: "text", text: mockResponseText }],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      })),
    },
  }),
  buildCachedSystemContent: (s: string) => s,
}));

// ── isMetaQualityTask ─────────────────────────────────────────────────────────

describe("isMetaQualityTask", () => {
  it.each([
    ["score bypass alert implementation"],
    ["Implement quality gate enforcement"],
    ["verifier calibration improvements"],
    ["Add score floor monitoring"],
    ["threshold enforcement for agents"],
    ["quality threshold checker"],
    ["bypass reason detection"],
    ["low-score alert notifications"],
    ["approval floor validation"],
    ["meta review process"],
    ["quality calibration system"],
    ["score threshold reporting"],
    ["quality enforcement module"],
    ["Task: implement bypass detection"],
    ["[meta-review] low score approval fix"],
  ])("matches: %s", (title) => {
    expect(isMetaQualityTask(title)).toBe(true);
  });

  it.each([
    ["Add feature to the reviewer"],
    ["Fix PR reviewer test failure"],
    ["Update ROADMAP.md"],
    ["Improve supervisor dispatching"],
    ["Refactor state store queries"],
    ["Add Telegram daily digest"],
    [""],
  ])("does not match: %s", (title) => {
    expect(isMetaQualityTask(title)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isMetaQualityTask("QUALITY GATE implementation")).toBe(true);
    expect(isMetaQualityTask("Score Bypass Detection")).toBe(true);
    expect(isMetaQualityTask("CALIBRATION system")).toBe(true);
  });

  it("returns false for empty string", () => {
    expect(isMetaQualityTask("")).toBe(false);
  });
});

// ── matchedMetaQualityKeyword ─────────────────────────────────────────────────

describe("matchedMetaQualityKeyword", () => {
  it("returns the first matched keyword", () => {
    const kw = matchedMetaQualityKeyword("score bypass alert implementation");
    expect(kw).toBe("score bypass");
  });

  it("returns null when no keyword matches", () => {
    expect(matchedMetaQualityKeyword("Add new feature to the reviewer")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(matchedMetaQualityKeyword("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(matchedMetaQualityKeyword("QUALITY GATE system")).not.toBeNull();
  });
});

// ── applyMetaQualityGateToResult ──────────────────────────────────────────────

describe("applyMetaQualityGateToResult", () => {
  const baseInput = {
    taskId: "01TESTTASKID001",
    taskTitle: "Implement score bypass alerting",
    agentName: "claude-orchestrator-reviewer",
    approved: true,
    score: 0.72,
    notes: "Task completed reasonably.",
    revision: "Consider improving test coverage.",
  };

  it("fires when meta-quality task is approved below floor", () => {
    const output = applyMetaQualityGateToResult(baseInput);
    expect(output.metaQualityRejected).toBe(true);
    expect(output.approved).toBe(false);
  });

  it("adds META-QUALITY banner to notes", () => {
    const output = applyMetaQualityGateToResult(baseInput);
    expect(output.notes).toContain("META-QUALITY GATE");
    expect(output.notes).toContain("85%");
  });

  it("includes original notes in enriched notes", () => {
    const output = applyMetaQualityGateToResult(baseInput);
    expect(output.notes).toContain("Task completed reasonably.");
  });

  it("includes original revision in enriched revision", () => {
    const output = applyMetaQualityGateToResult(baseInput);
    expect(output.revision).toContain("Consider improving test coverage.");
  });

  it("includes meta-quality floor explanation in revision", () => {
    const output = applyMetaQualityGateToResult(baseInput);
    expect(output.revision).toContain("85%");
    expect(output.revision).toContain("quality enforcement");
  });

  it("is a no-op when score ≥ META_QUALITY_FLOOR (0.85)", () => {
    const output = applyMetaQualityGateToResult({ ...baseInput, score: 0.85 });
    expect(output.metaQualityRejected).toBe(false);
    expect(output.approved).toBe(true);
    expect(output.notes).toBe(baseInput.notes);
  });

  it("is a no-op when score just above floor (0.86)", () => {
    const output = applyMetaQualityGateToResult({ ...baseInput, score: 0.86 });
    expect(output.metaQualityRejected).toBe(false);
    expect(output.approved).toBe(true);
  });

  it("is a no-op when already rejected (approved=false)", () => {
    const output = applyMetaQualityGateToResult({ ...baseInput, approved: false, score: 0.72 });
    expect(output.metaQualityRejected).toBe(false);
    expect(output.approved).toBe(false);
    expect(output.notes).toBe(baseInput.notes); // unchanged
  });

  it("is a no-op when title has no meta-quality keyword", () => {
    const output = applyMetaQualityGateToResult({
      ...baseInput,
      taskTitle: "Add new feature to the reviewer",
    });
    expect(output.metaQualityRejected).toBe(false);
    expect(output.approved).toBe(true);
  });

  it("fires at exactly the boundary score 0.84 (just below floor)", () => {
    const output = applyMetaQualityGateToResult({ ...baseInput, score: 0.84 });
    expect(output.metaQualityRejected).toBe(true);
    expect(output.approved).toBe(false);
  });

  it("handles missing revision gracefully", () => {
    const { revision: _revision, ...noRevision } = baseInput;
    const output = applyMetaQualityGateToResult(noRevision);
    expect(output.metaQualityRejected).toBe(true);
    expect(output.revision).toBeDefined();
    expect(output.revision).toContain("quality enforcement");
  });

  it("works for all exported keyword categories", () => {
    for (const kw of META_QUALITY_KEYWORDS) {
      const output = applyMetaQualityGateToResult({
        ...baseInput,
        taskTitle: `Implement ${kw} feature`,
        score: 0.75,
      });
      expect(output.metaQualityRejected, `keyword: "${kw}"`).toBe(true);
    }
  });
});

// ── buildMetaQualityAlertBody ─────────────────────────────────────────────────

describe("buildMetaQualityAlertBody", () => {
  it("contains task ID", () => {
    const body = buildMetaQualityAlertBody("TASK01", "agent-alpha", 0.72, "score bypass");
    expect(body).toContain("TASK01");
  });

  it("contains agent name", () => {
    const body = buildMetaQualityAlertBody("TASK01", "agent-alpha", 0.72, "score bypass");
    expect(body).toContain("agent-alpha");
  });

  it("contains quality score", () => {
    const body = buildMetaQualityAlertBody("TASK01", "agent-alpha", 0.72, "score bypass");
    expect(body).toContain("72%");
  });

  it("contains matched keyword", () => {
    const body = buildMetaQualityAlertBody("TASK01", "agent-alpha", 0.72, "score bypass");
    expect(body).toContain("score bypass");
  });

  it("contains the floor percentage", () => {
    const body = buildMetaQualityAlertBody("TASK01", "agent-alpha", 0.72, "calibration");
    expect(body).toContain(`${(META_QUALITY_FLOOR * 100).toFixed(0)}%`);
  });

  it("handles null agent name gracefully", () => {
    const body = buildMetaQualityAlertBody("TASK01", null, 0.72, "enforcement");
    expect(body).toContain("unknown");
  });
});

// ── META_QUALITY_FLOOR constant ───────────────────────────────────────────────

describe("META_QUALITY_FLOOR", () => {
  it("is 0.85", () => {
    expect(META_QUALITY_FLOOR).toBe(0.85);
  });
});

// ── Verifier integration ──────────────────────────────────────────────────────

function makeVerifierFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-mqg-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertDoneTask = (overrides: {
    title?: string;
    agent_name?: string;
    task_type?: string;
    issue_priority?: number | null;
  } = {}) => {
    seq += 1;
    const id = `01MQGTEST${String(seq).padStart(11, "0")}`;
    writer.prepare(
      `INSERT INTO tasks
         (id, title, description, status, agent_name, task_type,
          result, verification_status, quality_score,
          issue_priority, created_at, updated_at)
       VALUES (?, ?, NULL, 'done', ?, ?, 'Task result.', NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      id,
      overrides.title ?? "Regular feature task",
      overrides.agent_name ?? "agent-alpha",
      overrides.task_type ?? "implementation",
      overrides.issue_priority ?? null,
    );
    return id;
  };

  return {
    store,
    writer,
    insertDoneTask,
    cleanup: () => {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Helper: build a JSON LLM response string that the verifier will parse
function makeLLMResponse(score: number, approved: boolean): string {
  return JSON.stringify({
    approved,
    score,
    notes: `Score ${(score * 100).toFixed(0)}% — test response.`,
    dimensions: { correctness: score, completeness: score, test_coverage: score, code_quality: score },
    ...(score < 0.80 ? { explanation: "Score below threshold." } : {}),
  });
}

describe("Verifier.verify — meta-quality gate integration", () => {
  let fixture: ReturnType<typeof makeVerifierFixture>;

  beforeEach(() => {
    fixture = makeVerifierFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("fires for a quality-enforcement task scoring 0.80 (below 0.85 floor)", async () => {
    const { store, insertDoneTask } = fixture;

    // Score 0.80 passes the standard 0.80 floor but NOT the meta-quality 0.85 floor
    mockResponseText = makeLLMResponse(0.80, true);

    const taskId = insertDoneTask({
      title: "Implement score bypass alerting for the reviewer",
    });

    const verifier = new Verifier(store, undefined);
    const result = await verifier.verify(taskId);

    // Meta-quality gate should have fired: approved overridden to false
    expect(result.metaQualityRejected).toBe(true);
    expect(result.approved).toBe(false);
    expect(result.notes).toContain("META-QUALITY GATE");
  });

  it("is a no-op for a normal task scoring 0.80 (no meta keyword)", async () => {
    const { store, insertDoneTask } = fixture;

    mockResponseText = makeLLMResponse(0.80, true);

    const taskId = insertDoneTask({
      title: "Add new Telegram command for agent status",
    });

    const verifier = new Verifier(store, undefined);
    const result = await verifier.verify(taskId);

    expect(result.metaQualityRejected).toBeUndefined();
    expect(result.approved).toBe(true);
  });

  it("is a no-op when meta-quality task scores ≥ 0.85", async () => {
    const { store, insertDoneTask } = fixture;

    mockResponseText = makeLLMResponse(0.90, true);

    const taskId = insertDoneTask({
      title: "Implement quality gate enforcement module",
    });

    const verifier = new Verifier(store, undefined);
    const result = await verifier.verify(taskId);

    expect(result.metaQualityRejected).toBeUndefined();
    expect(result.approved).toBe(true);
    expect(result.score).toBeCloseTo(0.90, 3);
  });
});
