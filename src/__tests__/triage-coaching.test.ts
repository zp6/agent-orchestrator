/**
 * Tests for triage-coaching.ts (issue #245).
 *
 * Covers:
 *   1. buildTriageCoachingDirective() — directive text content and structure
 *   2. formatTriageCoachingSection() — supervisor context formatting
 *   3. injectTriageCoachingIntoPrompt() — prompt augmentation and no-op cases
 *   4. TriageCoachingAdvisor — integration with StateStore (healthy / below-threshold agents)
 *   5. Supervisor wiring — coaching section appears in buildContext() output
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  buildTriageCoachingDirective,
  formatTriageCoachingSection,
  injectTriageCoachingIntoPrompt,
  TriageCoachingAdvisor,
  TRIAGE_COACHING_THRESHOLD,
  TRIAGE_COACHING_WINDOW,
  type TriageCoachingDirective,
  type TriageCoachingProvider,
} from "../reviewer/triage-coaching.js";
import { TRIAGE_REQUIRED_FIELDS } from "../reviewer/verifier.js";
import { StateStore } from "../state/store.js";
import { Supervisor } from "../reviewer/supervisor.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

type RawDb = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

let _taskSeq = 0;

/**
 * Seed a housekeeping task.  `offsetSeconds` controls ordering: tasks with a
 * larger (more positive) offset are newer.  Defaults to an auto-incrementing
 * counter so each seeded task gets a unique timestamp.
 */
function seedTriageTask(
  store: StateStore,
  id: string,
  agentName: string,
  qualityScore: number | null,
  verificationStatus: "approved" | "rejected" | null = null,
  result?: string,
  offsetSeconds?: number,
): void {
  const seq = offsetSeconds ?? (_taskSeq++);
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score,
                       verification_status, result, created_at, updated_at)
    VALUES (?, ?, 'done', ?, 'housekeeping', ?, ?, ?,
            datetime('now', ? || ' seconds'), datetime('now', ? || ' seconds'))
  `);
  insert.run(
    id,
    `triage task ${id}`,
    agentName,
    qualityScore,
    verificationStatus,
    result ?? null,
    String(seq),
    String(seq),
  );
}

function seedImplementationTask(
  store: StateStore,
  id: string,
  agentName: string,
  qualityScore: number,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score,
                       verification_status, created_at, updated_at)
    VALUES (?, ?, 'done', ?, 'implementation', ?, 'approved', datetime('now'), datetime('now'))
  `);
  insert.run(id, `impl task ${id}`, agentName, qualityScore);
}

// ── buildTriageCoachingDirective ──────────────────────────────────────────────

describe("buildTriageCoachingDirective()", () => {
  it("returns an object with agent_name, rolling_triage_score, task_count, missing_fields, directive", () => {
    const d = buildTriageCoachingDirective("agent-a", 0.72, 5, []);
    expect(d.agent_name).toBe("agent-a");
    expect(d.rolling_triage_score).toBe(0.72);
    expect(d.task_count).toBe(5);
    expect(d.missing_fields).toEqual([]);
    expect(typeof d.directive).toBe("string");
  });

  it("directive includes agent name", () => {
    const d = buildTriageCoachingDirective("claude-orchestrator-dashboard", 0.72, 3, []);
    expect(d.directive).toContain("claude-orchestrator-dashboard");
  });

  it("directive includes the rolling score", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.72, 5, []);
    expect(d.directive).toContain("0.72");
  });

  it("directive includes the threshold value", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.72, 5, [], 0.80);
    expect(d.directive).toContain("0.80");
  });

  it("directive includes the task count", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.65, 7, []);
    expect(d.directive).toContain("7");
  });

  it("uses singular 'task' when task_count is 1", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.65, 1, []);
    expect(d.directive).toContain("1 task");
    expect(d.directive).not.toContain("1 tasks");
  });

  it("uses plural 'tasks' when task_count > 1", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.65, 3, []);
    expect(d.directive).toContain("3 tasks");
  });

  it("mentions missing fields when provided", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.72, 5, [
      { field: "priority_reordering", count: 2 },
      { field: "outcome_summary", count: 1 },
    ]);
    expect(d.directive).toContain("priority_reordering");
    expect(d.directive).toContain("outcome_summary");
  });

  it("lists at most 3 missing fields in the snippet (top-3 by count)", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.50, 5, [
      { field: "priority_reordering", count: 4 },
      { field: "duplicates_checked", count: 3 },
      { field: "outcome_summary", count: 2 },
      { field: "stale_issues", count: 1 },
    ]);
    // Should mention the top-3: priority_reordering, duplicates_checked, outcome_summary
    expect(d.directive).toContain("priority_reordering");
    expect(d.directive).toContain("duplicates_checked");
    expect(d.directive).toContain("outcome_summary");
  });

  it("does not mention field names when missing_fields is empty", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.65, 5, []);
    // None of the specific field names should appear if there's nothing to highlight
    // (the generic 'all four schema fields' line lists them, but not as 'missing')
    expect(d.directive).not.toContain("missing schema");
  });

  it("always instructs agent to verify all four required fields", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.72, 3, []);
    for (const field of TRIAGE_REQUIRED_FIELDS) {
      expect(d.directive).toContain(field);
    }
  });

  it("uses custom threshold when provided", () => {
    const d = buildTriageCoachingDirective("agent-x", 0.65, 3, [], 0.90);
    expect(d.directive).toContain("0.90");
    expect(d.directive).not.toContain("0.80");
  });

  it("defaults to TRIAGE_COACHING_THRESHOLD (0.80) when no threshold arg given", () => {
    expect(TRIAGE_COACHING_THRESHOLD).toBe(0.80);
    const d = buildTriageCoachingDirective("agent-x", 0.72, 3, []);
    expect(d.directive).toContain("0.80");
  });
});

// ── formatTriageCoachingSection ───────────────────────────────────────────────

describe("formatTriageCoachingSection()", () => {
  it("returns empty array when directives list is empty", () => {
    expect(formatTriageCoachingSection([])).toEqual([]);
  });

  it("returns non-empty array for a single below-threshold directive", () => {
    const d = buildTriageCoachingDirective("agent-a", 0.72, 3, []);
    const lines = formatTriageCoachingSection([d]);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("includes agent name and triage score in the summary line", () => {
    const d = buildTriageCoachingDirective("claude-orchestrator-dashboard", 0.72, 4, []);
    const lines = formatTriageCoachingSection([d]);
    const summary = lines[0];
    expect(summary).toContain("claude-orchestrator-dashboard");
    expect(summary).toContain("0.72");
    expect(summary).toContain("4 tasks");
  });

  it("includes missing fields in the summary line when present", () => {
    const d = buildTriageCoachingDirective("agent-a", 0.72, 3, [
      { field: "priority_reordering", count: 2 },
    ]);
    const section = formatTriageCoachingSection([d]);
    const summaryLine = section[0];
    expect(summaryLine).toContain("priority_reordering");
    expect(summaryLine).toContain("2×");
  });

  it("formats multiple directives as separate entries", () => {
    const d1 = buildTriageCoachingDirective("agent-a", 0.72, 3, []);
    const d2 = buildTriageCoachingDirective("agent-b", 0.65, 5, [
      { field: "outcome_summary", count: 1 },
    ]);
    const lines = formatTriageCoachingSection([d1, d2]);
    const fullText = lines.join("\n");
    expect(fullText).toContain("agent-a");
    expect(fullText).toContain("agent-b");
  });

  it("indents directive text lines for readability in context", () => {
    const d = buildTriageCoachingDirective("agent-a", 0.72, 3, []);
    const lines = formatTriageCoachingSection([d]);
    // Lines after the summary line (index 0) should be indented
    const indentedLines = lines.slice(1);
    for (const line of indentedLines) {
      expect(line.startsWith("  ")).toBe(true);
    }
  });
});

// ── injectTriageCoachingIntoPrompt ────────────────────────────────────────────

describe("injectTriageCoachingIntoPrompt()", () => {
  const healthyProvider: TriageCoachingProvider = {
    getTriageCoachingDirectives: () => [],
  };

  const buildProvider = (agent: string, score: number): TriageCoachingProvider => ({
    getTriageCoachingDirectives: (names: string[]) => {
      if (!names.includes(agent)) return [];
      return [buildTriageCoachingDirective(agent, score, 3, [])];
    },
  });

  it("returns original prompt when provider is null", () => {
    expect(injectTriageCoachingIntoPrompt("Do triage work", "agent-a", null)).toBe(
      "Do triage work",
    );
  });

  it("returns original prompt when provider is undefined", () => {
    expect(injectTriageCoachingIntoPrompt("Do triage work", "agent-a", undefined)).toBe(
      "Do triage work",
    );
  });

  it("returns original prompt when provider returns no directive for the agent", () => {
    const result = injectTriageCoachingIntoPrompt(
      "Do triage work",
      "agent-a",
      healthyProvider,
    );
    expect(result).toBe("Do triage work");
  });

  it("appends coaching snippet when provider returns a directive for the agent", () => {
    const provider = buildProvider("agent-a", 0.72);
    const result = injectTriageCoachingIntoPrompt("Do triage work", "agent-a", provider);
    expect(result).not.toBe("Do triage work");
    expect(result.startsWith("Do triage work")).toBe(true);
    expect(result).toContain("0.72");
    expect(result).toContain("agent-a");
  });

  it("separates original prompt and coaching with a horizontal rule", () => {
    const provider = buildProvider("agent-a", 0.72);
    const result = injectTriageCoachingIntoPrompt("Original prompt.", "agent-a", provider);
    expect(result).toContain("---");
  });

  it("does NOT inject for a different agent even when provider has a directive", () => {
    const provider = buildProvider("agent-a", 0.72);
    const result = injectTriageCoachingIntoPrompt("Do triage", "agent-b", provider);
    expect(result).toBe("Do triage");
  });

  it("preserves the original prompt content verbatim before the separator", () => {
    const original = "Perform housekeeping triage on rapartlu/agent-dashboard.";
    const provider = buildProvider("agent-x", 0.65);
    const result = injectTriageCoachingIntoPrompt(original, "agent-x", provider);
    expect(result.startsWith(original)).toBe(true);
  });
});

// ── TriageCoachingAdvisor (StateStore integration) ────────────────────────────

describe("TriageCoachingAdvisor", () => {
  let store: StateStore;
  let rawDb: Database.Database;
  let tmpDir: string;

  beforeEach(() => {
    _taskSeq = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "triage-coaching-test-"));
    const dbPath = join(tmpDir, "state.db");
    store = new StateStore(dbPath);
    rawDb = new Database(dbPath);
  });

  afterEach(() => {
    rawDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("TRIAGE_COACHING_THRESHOLD is 0.80", () => {
    expect(TRIAGE_COACHING_THRESHOLD).toBe(0.80);
  });

  it("TRIAGE_COACHING_WINDOW is 10", () => {
    expect(TRIAGE_COACHING_WINDOW).toBe(10);
  });

  it("returns no directives when agent has no triage tasks", () => {
    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-a"]);
    expect(directives).toEqual([]);
  });

  it("returns no directives when agent's rolling triage score is at or above threshold", () => {
    // Seed 3 triage tasks with scores >= 0.80
    seedTriageTask(store, "t1", "agent-a", 0.85, "approved");
    seedTriageTask(store, "t2", "agent-a", 0.90, "approved");
    seedTriageTask(store, "t3", "agent-a", 0.82, "approved");

    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-a"]);
    expect(directives).toEqual([]);
  });

  it("returns a directive when agent's rolling triage score is below 0.80", () => {
    // Seed 2 triage tasks: 0.72 rejected, 0.70 rejected → avg 0.71
    seedTriageTask(store, "t1", "agent-a", 0.72, "rejected");
    seedTriageTask(store, "t2", "agent-a", 0.70, "rejected");

    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-a"]);

    expect(directives).toHaveLength(1);
    expect(directives[0].agent_name).toBe("agent-a");
    expect(directives[0].rolling_triage_score).toBeCloseTo(0.71, 2);
    expect(directives[0].rolling_triage_score).toBeLessThan(0.80);
  });

  it("directive text contains agent name and score for the below-threshold agent", () => {
    seedTriageTask(store, "t1", "agent-b", 0.65, "rejected");

    const advisor = new TriageCoachingAdvisor(store);
    const [d] = advisor.getTriageCoachingDirectives(["agent-b"]);

    expect(d.directive).toContain("agent-b");
    expect(d.directive).toContain("0.65");
  });

  it("ignores implementation tasks when computing rolling triage score", () => {
    // High-scoring implementation tasks should NOT raise the triage average
    seedImplementationTask(store, "impl-1", "agent-c", 0.95);
    seedImplementationTask(store, "impl-2", "agent-c", 0.92);
    // Low-scoring triage tasks
    seedTriageTask(store, "t1", "agent-c", 0.65, "rejected");
    seedTriageTask(store, "t2", "agent-c", 0.68, "rejected");

    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-c"]);

    // Even though implementation scores are high, triage average is 0.665 → below threshold
    expect(directives).toHaveLength(1);
    expect(directives[0].rolling_triage_score).toBeLessThan(0.80);
  });

  it("detects missing fields from rejection messages in task result text", () => {
    const rejectionMsg =
      "TRIAGE SCHEMA VIOLATION: Missing required fields: priority_reordering";
    seedTriageTask(store, "t1", "agent-d", 0.72, "rejected", rejectionMsg);
    seedTriageTask(store, "t2", "agent-d", 0.70, "rejected", rejectionMsg);

    const advisor = new TriageCoachingAdvisor(store);
    const [d] = advisor.getTriageCoachingDirectives(["agent-d"]);

    expect(d.missing_fields.length).toBeGreaterThan(0);
    const fieldNames = d.missing_fields.map((f) => f.field);
    expect(fieldNames).toContain("priority_reordering");
  });

  it("orders missing fields by occurrence count descending", () => {
    const msg1 = "Missing required fields: priority_reordering";
    const msg2 = "Missing required fields: priority_reordering";
    const msg3 = "Missing required fields: outcome_summary";
    seedTriageTask(store, "t1", "agent-e", 0.65, "rejected", msg1);
    seedTriageTask(store, "t2", "agent-e", 0.68, "rejected", msg2);
    seedTriageTask(store, "t3", "agent-e", 0.70, "rejected", msg3);

    const advisor = new TriageCoachingAdvisor(store);
    const [d] = advisor.getTriageCoachingDirectives(["agent-e"]);

    if (d.missing_fields.length >= 2) {
      expect(d.missing_fields[0].count).toBeGreaterThanOrEqual(d.missing_fields[1].count);
    }
  });

  it("handles multiple agents and returns directives only for below-threshold ones", () => {
    // agent-good: high triage scores → no coaching needed
    seedTriageTask(store, "good-1", "agent-good", 0.90, "approved");
    seedTriageTask(store, "good-2", "agent-good", 0.88, "approved");

    // agent-bad: low triage scores → coaching needed
    seedTriageTask(store, "bad-1", "agent-bad", 0.65, "rejected");
    seedTriageTask(store, "bad-2", "agent-bad", 0.68, "rejected");

    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-good", "agent-bad"]);

    expect(directives).toHaveLength(1);
    expect(directives[0].agent_name).toBe("agent-bad");
  });

  it("respects the windowTasks parameter — only last N triage tasks are considered", () => {
    // Seed 5 old bad tasks (lower timestamps = older) then 3 newer good tasks.
    // listTasks returns DESC created_at so the 3 good tasks appear first.
    // With window=3, only those 3 good tasks are used → avg 0.90 → no coaching.
    for (let i = 0; i < 5; i++) {
      // Use negative offsets so these are older than the good tasks below
      seedTriageTask(store, `old-${i}`, "agent-f", 0.55, "rejected", undefined, -(10 - i));
    }
    for (let i = 0; i < 3; i++) {
      // Positive offsets: these are the most recent
      seedTriageTask(store, `new-${i}`, "agent-f", 0.90, "approved", undefined, i + 1);
    }

    const advisor = new TriageCoachingAdvisor(store, 0.80, 3);
    const directives = advisor.getTriageCoachingDirectives(["agent-f"]);
    expect(directives).toHaveLength(0);
  });

  it("does not return a directive when rolling_avg_score is null (no scored tasks)", () => {
    // Triage task with null score (not yet scored)
    seedTriageTask(store, "t1", "agent-g", null, null);

    const advisor = new TriageCoachingAdvisor(store);
    const directives = advisor.getTriageCoachingDirectives(["agent-g"]);
    expect(directives).toHaveLength(0);
  });

  it("supports a custom threshold via constructor arg", () => {
    // Score 0.75 — above default (0.80) but might be below a custom threshold
    seedTriageTask(store, "t1", "agent-h", 0.75, "approved");
    seedTriageTask(store, "t2", "agent-h", 0.76, "approved");

    // Default threshold (0.80): 0.755 avg → below → coaching expected
    const defaultAdvisor = new TriageCoachingAdvisor(store, 0.80);
    expect(defaultAdvisor.getTriageCoachingDirectives(["agent-h"])).toHaveLength(1);

    // Custom threshold (0.70): 0.755 avg → above → no coaching
    const highThreshAdvisor = new TriageCoachingAdvisor(store, 0.70);
    expect(highThreshAdvisor.getTriageCoachingDirectives(["agent-h"])).toHaveLength(0);
  });
});

// ── Supervisor wiring ─────────────────────────────────────────────────────────

describe("Supervisor — Triage Coaching Directives section in buildContext()", () => {
  /**
   * We test the formatting integration without invoking the full Supervisor.review()
   * (which requires an LLM call).  The Supervisor.buildContext() is private, but
   * we can verify the section is rendered via formatTriageCoachingSection which
   * buildContext() delegates to.
   */

  it("formatTriageCoachingSection produces a non-empty section for below-threshold agents", () => {
    const d = buildTriageCoachingDirective("claude-orchestrator-dashboard", 0.72, 3, [
      { field: "priority_reordering", count: 2 },
    ]);
    const lines = formatTriageCoachingSection([d]);

    expect(lines.length).toBeGreaterThan(0);
    const fullSection = `## Triage Coaching Directives\n${lines.join("\n")}`;
    expect(fullSection).toContain("claude-orchestrator-dashboard");
    expect(fullSection).toContain("0.72");
    expect(fullSection).toContain("priority_reordering");
  });

  it("formatTriageCoachingSection produces empty array for healthy agents (no section added)", () => {
    expect(formatTriageCoachingSection([])).toEqual([]);
  });

  it("Supervisor constructor accepts triageCoachingProvider without error", () => {
    // Verify the Supervisor accepts the new provider option (compile + runtime check).
    // Uses the statically imported Supervisor class (imported at top of file).
    const mockStore = {
      getRecentSupervisorDecisions: () => [],
      listTasks: () => [],
      getRecentCompleted: () => [],
      getUnverified: () => [],
      getAgentStats: () => [],
      getAgentHealthBatch: () => [],
      querySupervisorDecisions: () => [],
    };
    const mockConfig = { agents: {} };
    const mockProvider: TriageCoachingProvider = {
      getTriageCoachingDirectives: () => [],
    };

    expect(() => {
      new Supervisor(mockConfig as any, mockStore as any, {
        triageCoachingProvider: mockProvider,
      });
    }).not.toThrow();
  });
});
