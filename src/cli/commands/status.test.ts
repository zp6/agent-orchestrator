import { describe, it, expect, vi, afterEach } from "vitest";
import { formatSourceLabel, formatRetryState, printActiveClaims } from "./status.js";
import type { Task, IssueClaim } from "../../state/store.js";
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

describe("printActiveClaims", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeClaim(overrides: Partial<IssueClaim> = {}): IssueClaim {
    const now = new Date();
    return {
      source: "github",
      source_ref: "owner/repo#42",
      agent_name: "claude-test-agent",
      task_id: "01TESTCLAIM0000001",
      claimed_at: new Date(now.getTime() - 5 * 60_000).toISOString(),   // 5 min ago
      expires_at: new Date(now.getTime() + 115 * 60_000).toISOString(), // 115 min from now
      ...overrides,
    };
  }

  it("prints nothing when claims array is empty", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    printActiveClaims([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("prints a header row and one row per active claim", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const claim = makeClaim();
    printActiveClaims([claim]);

    // Should contain the source_ref, agent name, and the section header
    const output = lines.join("\n");
    expect(output).toContain("Active Issue Claims");
    expect(output).toContain("owner/repo#42");
    expect(output).toContain("claude-test-agent");
  });

  it("shows 'pending' task ID when task_id is null", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const claim = makeClaim({ task_id: null });
    printActiveClaims([claim]);
    const output = lines.join("\n");
    expect(output).toContain("pending");
  });

  it("shows multiple claims when array has multiple entries", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    const claims = [
      makeClaim({ source_ref: "owner/repo#10", agent_name: "agent-alpha" }),
      makeClaim({ source_ref: "owner/repo#20", agent_name: "agent-beta" }),
    ];
    printActiveClaims(claims);
    const output = lines.join("\n");
    expect(output).toContain("owner/repo#10");
    expect(output).toContain("owner/repo#20");
    expect(output).toContain("agent-alpha");
    expect(output).toContain("agent-beta");
    // The header should mention the count
    expect(output).toContain("2");
  });
});
