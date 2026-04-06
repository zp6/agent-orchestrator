import { describe, it, expect } from "vitest";
import {
  formatTimestamp,
  formatOutcomeBadge,
  formatRationaleMeta,
  extractRationale,
  formatDecision,
  renderPanel,
} from "./supervisor-log.js";
import type { SupervisorDecisionRecord } from "../../state/store.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal SupervisorDecisionRecord for tests. */
function makeRecord(
  overrides: Partial<SupervisorDecisionRecord> = {},
): SupervisorDecisionRecord {
  return {
    id: 1,
    action: "dispatch",
    agent_name: "claude-reviewer",
    reason: "Default reason",
    message: null,
    rationale: null,
    issue_refs: [],
    hard_gates: [],
    outcome: "dispatched",
    task_id: null,
    created_at: "2026-04-06T14:32:18.000Z",
    ...overrides,
  };
}

// ── formatTimestamp ───────────────────────────────────────────────────────────

describe("formatTimestamp", () => {
  it("returns HH:MM:SS in local time", () => {
    // We can't assert exact local-time values, but we can check the format.
    const ts = formatTimestamp("2026-04-06T14:32:18.000Z");
    expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("returns ??:??:?? for an invalid ISO string", () => {
    expect(formatTimestamp("not-a-date")).toBe("??:??:??");
  });

  it("returns ??:??:?? for an empty string", () => {
    expect(formatTimestamp("")).toBe("??:??:??");
  });
});

// ── formatOutcomeBadge ────────────────────────────────────────────────────────

describe("formatOutcomeBadge", () => {
  it("pads all outcomes to 10 characters (before ANSI codes)", () => {
    const outcomes = ["dispatched", "skipped", "failed", "none", "unhandled"];
    for (const outcome of outcomes) {
      // Strip ANSI escape sequences to compare raw text width
      const stripped = formatOutcomeBadge(outcome).replace(/\x1B\[[0-9;]*m/g, "");
      expect(stripped).toHaveLength(10);
    }
  });

  it("produces distinct output for each outcome", () => {
    const outcomes = ["dispatched", "skipped", "failed", "none", "unhandled", "unknown"];
    const badges = outcomes.map(formatOutcomeBadge);
    // Each badge must be unique (different colours / text)
    const unique = new Set(badges);
    expect(unique.size).toBe(outcomes.length);
  });
});

// ── formatRationaleMeta ───────────────────────────────────────────────────────

describe("formatRationaleMeta", () => {
  it("returns null for null input", () => {
    expect(formatRationaleMeta(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(formatRationaleMeta("")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(formatRationaleMeta("{broken json")).toBeNull();
  });

  it("returns null when all fields are null/undefined", () => {
    const json = JSON.stringify({
      llm_reasoning: null,
      issue_state_at_dispatch: null,
      existing_pr_check_result: null,
      agent_idle_duration_ms: null,
      confidence_score: null,
    });
    expect(formatRationaleMeta(json)).toBeNull();
  });

  it("includes issue state when present", () => {
    const json = JSON.stringify({ issue_state_at_dispatch: "open" });
    const meta = formatRationaleMeta(json);
    expect(meta).toContain("issue=open");
  });

  it("includes PR check result when present", () => {
    const json = JSON.stringify({ existing_pr_check_result: "none" });
    const meta = formatRationaleMeta(json);
    expect(meta).toContain("pr=none");
  });

  it("converts agent_idle_duration_ms to minutes", () => {
    const json = JSON.stringify({ agent_idle_duration_ms: 720_000 }); // 12 minutes
    const meta = formatRationaleMeta(json);
    expect(meta).toContain("idle=12m");
  });

  it("includes confidence score formatted to 2 decimal places", () => {
    const json = JSON.stringify({ confidence_score: 0.85 });
    const meta = formatRationaleMeta(json);
    expect(meta).toContain("conf=0.85");
  });

  it("combines multiple fields", () => {
    const json = JSON.stringify({
      issue_state_at_dispatch: "open",
      existing_pr_check_result: "none",
      agent_idle_duration_ms: 180_000,
      confidence_score: 0.9,
    });
    const meta = formatRationaleMeta(json);
    expect(meta).toContain("issue=open");
    expect(meta).toContain("pr=none");
    expect(meta).toContain("idle=3m");
    expect(meta).toContain("conf=0.90");
  });
});

// ── extractRationale ──────────────────────────────────────────────────────────

describe("extractRationale", () => {
  it("returns reason field when rationale is null", () => {
    const record = makeRecord({ reason: "Agent idle, issue open", rationale: null });
    expect(extractRationale(record)).toBe("Agent idle, issue open");
  });

  it("prefers llm_reasoning from rationale JSON over reason field", () => {
    const record = makeRecord({
      reason: "Fallback reason",
      rationale: JSON.stringify({ llm_reasoning: "LLM says dispatch now" }),
    });
    expect(extractRationale(record)).toBe("LLM says dispatch now");
  });

  it("falls back to reason when rationale JSON has no llm_reasoning", () => {
    const record = makeRecord({
      reason: "Fallback reason",
      rationale: JSON.stringify({ confidence_score: 0.7 }),
    });
    expect(extractRationale(record)).toBe("Fallback reason");
  });

  it("falls back to reason when rationale JSON is malformed", () => {
    const record = makeRecord({
      reason: "Fallback reason",
      rationale: "not valid json {",
    });
    expect(extractRationale(record)).toBe("Fallback reason");
  });
});

// ── formatDecision ────────────────────────────────────────────────────────────

describe("formatDecision", () => {
  it("produces a FormattedDecision with all fields", () => {
    const record = makeRecord({
      agent_name: "claude-reviewer",
      issue_refs: ["owner/repo#42"],
      outcome: "dispatched",
      task_id: "01ABCDEF1234567890",
    });
    const d = formatDecision(record);
    expect(d.agent).toBe("claude-reviewer");
    expect(d.issueRefs).toBe("owner/repo#42");
    expect(d.outcome).toBe("dispatched");
    expect(d.taskId).toBe("01ABCDEF12"); // first 10 chars
    expect(d.timestamp).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("uses — for missing agent_name", () => {
    const record = makeRecord({ agent_name: null });
    expect(formatDecision(record).agent).toBe("—");
  });

  it("uses — when issue_refs is empty", () => {
    const record = makeRecord({ issue_refs: [] });
    expect(formatDecision(record).issueRefs).toBe("—");
  });

  it("joins multiple issue refs with comma+space", () => {
    const record = makeRecord({ issue_refs: ["owner/repo#1", "owner/repo#2"] });
    expect(formatDecision(record).issueRefs).toBe("owner/repo#1, owner/repo#2");
  });

  it("truncates rationale to 120 chars", () => {
    const longReason = "x".repeat(200);
    const record = makeRecord({ reason: longReason });
    expect(formatDecision(record).rationale).toHaveLength(120);
  });

  it("populates hardGates from the record", () => {
    const record = makeRecord({ hard_gates: ["issue already closed", "agent busy"] });
    const d = formatDecision(record);
    expect(d.hardGates).toEqual(["issue already closed", "agent busy"]);
  });

  it("sets taskId to null when task_id is null", () => {
    const record = makeRecord({ task_id: null });
    expect(formatDecision(record).taskId).toBeNull();
  });

  it("includes rationaleMeta when rationale JSON has structured fields", () => {
    const record = makeRecord({
      rationale: JSON.stringify({
        issue_state_at_dispatch: "open",
        confidence_score: 0.88,
      }),
    });
    const d = formatDecision(record);
    expect(d.rationaleMeta).toContain("issue=open");
    expect(d.rationaleMeta).toContain("conf=0.88");
  });
});

// ── renderPanel ───────────────────────────────────────────────────────────────

describe("renderPanel", () => {
  const sampleDecision = formatDecision(
    makeRecord({
      agent_name: "claude-reviewer",
      issue_refs: ["owner/repo#42"],
      outcome: "dispatched",
      reason: "Agent was idle and issue is open",
    }),
  );

  it("includes the panel header", () => {
    const output = renderPanel([sampleDecision], false, 5);
    // Strip ANSI for comparison
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("Supervisor Decision Log");
  });

  it("shows 'snapshot' label in non-live mode", () => {
    const output = renderPanel([sampleDecision], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("snapshot");
  });

  it("shows 'live' label in watch mode", () => {
    const output = renderPanel([sampleDecision], true, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("live");
  });

  it("shows the interval when in live mode", () => {
    const output = renderPanel([sampleDecision], true, 10);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("10s");
  });

  it("shows agent name in output", () => {
    const output = renderPanel([sampleDecision], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("claude-reviewer");
  });

  it("shows issue refs in output", () => {
    const output = renderPanel([sampleDecision], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("owner/repo#42");
  });

  it("shows empty-state message when no decisions", () => {
    const output = renderPanel([], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("No supervisor decisions recorded yet");
  });

  it("renders multiple decisions", () => {
    const d1 = formatDecision(makeRecord({ id: 1, agent_name: "claude-alpha", issue_refs: ["r/r#1"] }));
    const d2 = formatDecision(makeRecord({ id: 2, agent_name: "claude-beta", issue_refs: ["r/r#2"] }));
    const output = renderPanel([d1, d2], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("claude-alpha");
    expect(plain).toContain("claude-beta");
  });

  it("renders hard gates when present", () => {
    const d = formatDecision(
      makeRecord({ hard_gates: ["issue already closed"], outcome: "skipped" }),
    );
    const output = renderPanel([d], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("issue already closed");
  });

  it("renders rationale meta when present", () => {
    const d = formatDecision(
      makeRecord({
        rationale: JSON.stringify({ issue_state_at_dispatch: "open", confidence_score: 0.9 }),
      }),
    );
    const output = renderPanel([d], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("issue=open");
    expect(plain).toContain("conf=0.90");
  });

  it("renders task ID when present", () => {
    const d = formatDecision(makeRecord({ task_id: "01ABCDEF1234567890" }));
    const output = renderPanel([d], false, 5);
    const plain = output.replace(/\x1B\[[0-9;]*m/g, "");
    expect(plain).toContain("01ABCDEF12");
  });
});
