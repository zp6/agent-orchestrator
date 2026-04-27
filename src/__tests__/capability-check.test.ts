import { describe, it, expect } from "vitest";
import {
  evaluateCapability,
  handleCapabilityCheck,
  parseCapabilityCheckQuery,
  REVIEWER_REPO,
  ALLOWED_TASK_TYPES,
  ALLOWED_SOURCES,
} from "../reviewer/capability-check.js";

describe("evaluateCapability", () => {
  // ── Accepted: reviewer-scoped task types ─────────────────────────────

  it.each([...ALLOWED_TASK_TYPES])("accepts task_type '%s'", (taskType) => {
    const result = evaluateCapability({
      title: "Some task",
      task_type: taskType,
    });
    expect(result.accept).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  // ── Accepted: allowed sources ────────────────────────────────────────

  it.each([...ALLOWED_SOURCES])("accepts source '%s' regardless of task type", (source) => {
    const result = evaluateCapability({
      title: "Implement feature X in agent-orchestrator",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#965",
      source,
    });
    expect(result.accept).toBe(true);
  });

  // ── Accepted: own repo ───────────────────────────────────────────────

  it("accepts implementation tasks targeting the reviewer's own repo", () => {
    const result = evaluateCapability({
      title: "Add capability check endpoint",
      task_type: "implementation",
      source_ref: `${REVIEWER_REPO}#325`,
    });
    expect(result.accept).toBe(true);
  });

  // ── Accepted: reviewer work patterns in title ────────────────────────

  it("accepts tasks with 'PR review' in the title even if typed as implementation", () => {
    const result = evaluateCapability({
      title: "PR review improvements for auto-merge",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#100",
    });
    expect(result.accept).toBe(true);
  });

  it("accepts tasks with 'verification' in the title", () => {
    const result = evaluateCapability({
      title: "Improve verification scoring accuracy",
      task_type: "implementation",
    });
    expect(result.accept).toBe(true);
  });

  it("accepts tasks with 'quality score' in the title", () => {
    const result = evaluateCapability({
      title: "Quality score anomaly detection enhancement",
      task_type: "implementation",
    });
    expect(result.accept).toBe(true);
  });

  it("accepts tasks with 'calibration' in the title", () => {
    const result = evaluateCapability({
      title: "Fix calibration drift alert threshold",
      task_type: "implementation",
    });
    expect(result.accept).toBe(true);
  });

  it("accepts tasks with 'housekeeping' in the title", () => {
    const result = evaluateCapability({
      title: "[housekeeping] Triage open issues",
      task_type: "implementation",
    });
    expect(result.accept).toBe(true);
  });

  it("accepts tasks with 'triage' in the title", () => {
    const result = evaluateCapability({
      title: "Backlog triage for agent-reviewer",
      task_type: "implementation",
    });
    expect(result.accept).toBe(true);
  });

  // ── Rejected: implementation tasks for foreign repos ─────────────────

  it("rejects implementation tasks targeting agent-orchestrator", () => {
    const result = evaluateCapability({
      title: "ULID collision fix for state store",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#965",
    });
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("implementation-ineligible");
    expect(result.reason).toContain("rapartlu/agent-orchestrator");
  });

  it("rejects implementation tasks targeting agent-dashboard", () => {
    const result = evaluateCapability({
      title: "Dashboard bypass badge",
      task_type: "implementation",
      source_ref: "rapartlu/agent-dashboard#416",
    });
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("implementation-ineligible");
    expect(result.reason).toContain("rapartlu/agent-dashboard");
  });

  it("rejects implementation tasks with no source_ref (ambiguous foreign work)", () => {
    const result = evaluateCapability({
      title: "Add ULID collision fix to state store",
      task_type: "implementation",
    });
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("implementation-ineligible");
  });

  it("rejects implementation tasks targeting agent-proxy", () => {
    const result = evaluateCapability({
      title: "Fix container health check",
      task_type: "implementation",
      source_ref: "rapartlu/agent-proxy#50",
    });
    expect(result.accept).toBe(false);
    expect(result.reason).toContain("implementation-ineligible");
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  it("rejects when source_ref has no hash (malformed)", () => {
    const result = evaluateCapability({
      title: "Some task",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator",
    });
    // No repo extracted → falls through to rejection
    expect(result.accept).toBe(false);
  });

  it("handles empty title gracefully", () => {
    const result = evaluateCapability({
      title: "",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#100",
    });
    expect(result.accept).toBe(false);
  });

  it("handles missing source_ref gracefully", () => {
    const result = evaluateCapability({
      title: "Review open PRs",
      task_type: "review",
    });
    expect(result.accept).toBe(true);
  });
});

describe("parseCapabilityCheckQuery", () => {
  it("parses all fields from query params", () => {
    const req = parseCapabilityCheckQuery({
      title: "Fix bug",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#100",
      source: "github",
    });
    expect(req).toEqual({
      title: "Fix bug",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#100",
      source: "github",
    });
  });

  it("defaults task_type to 'implementation' when missing", () => {
    const req = parseCapabilityCheckQuery({ title: "Some task" });
    expect(req.task_type).toBe("implementation");
  });

  it("defaults title to empty string when missing", () => {
    const req = parseCapabilityCheckQuery({});
    expect(req.title).toBe("");
  });
});

describe("handleCapabilityCheck", () => {
  it("returns accept for reviewer work", () => {
    const result = handleCapabilityCheck({
      title: "Score calibration drift",
      task_type: "review",
    });
    expect(result.accept).toBe(true);
  });

  it("returns reject for foreign implementation", () => {
    const result = handleCapabilityCheck({
      title: "Add feature to orchestrator",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#999",
    });
    expect(result.accept).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
