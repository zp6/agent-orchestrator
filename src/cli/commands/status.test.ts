import { describe, it, expect } from "vitest";
import { formatSourceLabel } from "./status.js";
import type { Task } from "../../state/store.js";

/** Minimal Task stub — only the fields used by formatSourceLabel. */
function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "01TEST00000000000001",
    title: "Test task",
    description: null,
    source: "manual",
    source_ref: null,
    status: "done",
    agent_name: "test-agent",
    conversation_id: null,
    result: null,
    parent_task_id: null,
    step_id: null,
    plan: null,
    task_type: "implementation",
    verification_status: null,
    quality_score: null,
    verification_notes: null,
    retry_count: 0,
    next_retry_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("formatSourceLabel", () => {
  it("returns plain source name for a manual task without source_ref", () => {
    const task = makeTask({ source: "manual", source_ref: null });
    const label = formatSourceLabel(task);
    expect(label).toBe("manual");
  });

  it("returns source + ref in parentheses for github tasks", () => {
    const task = makeTask({ source: "github", source_ref: "owner/repo#5" });
    const label = formatSourceLabel(task);
    expect(label).toContain("github");
    expect(label).toContain("owner/repo#5");
  });

  it("returns 'PR feedback for owner/repo#N' label for pr-feedback tasks", () => {
    const task = makeTask({ source: "pr-feedback", source_ref: "rapartlu/cheese-hater#42" });
    const label = formatSourceLabel(task);
    // Should include "PR feedback for" prefix
    expect(label).toMatch(/PR feedback for/);
    expect(label).toContain("rapartlu/cheese-hater#42");
  });

  it("falls back to plain 'pr-feedback' when source_ref is null", () => {
    const task = makeTask({ source: "pr-feedback", source_ref: null });
    const label = formatSourceLabel(task);
    expect(label).toBe("pr-feedback");
  });

  it("handles linear source without source_ref", () => {
    const task = makeTask({ source: "linear", source_ref: null });
    const label = formatSourceLabel(task);
    expect(label).toBe("linear");
  });

  it("handles linear source with source_ref", () => {
    const task = makeTask({ source: "linear", source_ref: "ENG-123" });
    const label = formatSourceLabel(task);
    expect(label).toContain("linear");
    expect(label).toContain("ENG-123");
  });
});
