import { describe, it, expect } from "vitest";
import { formatSourceLabel, formatRetryState } from "./status.js";
import type { Task } from "../../state/store.js";
import { MAX_RETRIES } from "../../orchestrator/dispatcher.js";

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

describe("formatRetryState", () => {
  it("returns empty string for a fresh task with no retries", () => {
    const task = makeTask({ retry_count: 0, next_retry_at: null, status: "done" });
    expect(formatRetryState(task)).toBe("");
  });

  it("returns empty string for a dispatched task with no retries", () => {
    const task = makeTask({ retry_count: 0, next_retry_at: null, status: "dispatched" });
    expect(formatRetryState(task)).toBe("");
  });

  it("shows backoff info when task is failed and waiting for retry", () => {
    const futureTime = new Date(Date.now() + 47_000).toISOString();
    const task = makeTask({
      status: "failed",
      retry_count: 1,
      next_retry_at: futureTime,
    });
    const result = formatRetryState(task);
    expect(result).toContain(`retry 1/${MAX_RETRIES}`);
    expect(result).toContain("next attempt");
    expect(result).toMatch(/in \d+s/);
  });

  it("shows 'imminently' when the backoff window has passed but task not yet picked up", () => {
    const pastTime = new Date(Date.now() - 5_000).toISOString();
    const task = makeTask({
      status: "failed",
      retry_count: 1,
      next_retry_at: pastTime,
    });
    const result = formatRetryState(task);
    expect(result).toContain("imminently");
  });

  it("shows active retry when task is dispatched with retry_count > 0", () => {
    const task = makeTask({
      status: "dispatched",
      retry_count: 1,
      next_retry_at: null,
    });
    const result = formatRetryState(task);
    expect(result).toContain(`retry 1/${MAX_RETRIES}`);
    expect(result).toContain("active");
  });

  it("shows active retry when task is in_progress with retry_count > 0", () => {
    const task = makeTask({
      status: "in_progress",
      retry_count: 2,
      next_retry_at: null,
    });
    const result = formatRetryState(task);
    expect(result).toContain(`retry 2/${MAX_RETRIES}`);
    expect(result).toContain("active");
  });

  it("shows exhausted when task permanently failed after max retries", () => {
    const task = makeTask({
      status: "failed",
      retry_count: MAX_RETRIES,
      next_retry_at: null,
    });
    const result = formatRetryState(task);
    expect(result).toContain(`${MAX_RETRIES}/${MAX_RETRIES}`);
    expect(result).toContain("exhausted");
  });
});

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
