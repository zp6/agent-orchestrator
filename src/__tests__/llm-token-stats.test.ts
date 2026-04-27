import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import type { LlmCallEvent } from "../state/types.js";

let tempDir: string | undefined;
let store: StateStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "agent-reviewer-token-stats-"));
  store = new StateStore(join(tempDir, "state.db"));
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("recordLlmCallEvent + getTokenStats", () => {
  it("returns empty array when no events have been recorded", () => {
    const stats = store.getTokenStats();
    expect(stats).toEqual([]);
  });

  it("records a single event and returns it in stats", () => {
    store.recordLlmCallEvent({
      call_type: "pr_review",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 200,
      duration_ms: 1500,
      pr_number: 42,
    });

    const stats = store.getTokenStats();
    expect(stats).toHaveLength(1);
    const row = stats[0];
    expect(row.call_type).toBe("pr_review");
    expect(row.call_count).toBe(1);
    expect(row.total_input_tokens).toBe(1000);
    expect(row.total_output_tokens).toBe(200);
    expect(row.total_cache_read_tokens).toBe(0);
    expect(row.total_cache_write_tokens).toBe(0);
    expect(row.avg_duration_ms).toBeCloseTo(1500, 0);
  });

  it("records cache token fields correctly", () => {
    store.recordLlmCallEvent({
      call_type: "task_verify",
      model: "claude-sonnet-4-6",
      input_tokens: 800,
      output_tokens: 150,
      cache_read_tokens: 300,
      cache_write_tokens: 50,
      task_id: "01ABC",
    });

    const stats = store.getTokenStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].total_cache_read_tokens).toBe(300);
    expect(stats[0].total_cache_write_tokens).toBe(50);
  });

  it("aggregates multiple calls of the same type", () => {
    const event: LlmCallEvent = {
      call_type: "supervisor",
      model: "claude-sonnet-4-6",
      input_tokens: 2000,
      output_tokens: 400,
      duration_ms: 3000,
    };
    store.recordLlmCallEvent(event);
    store.recordLlmCallEvent({ ...event, input_tokens: 1800, output_tokens: 350, duration_ms: 2800 });

    const stats = store.getTokenStats();
    expect(stats).toHaveLength(1);
    const row = stats[0];
    expect(row.call_type).toBe("supervisor");
    expect(row.call_count).toBe(2);
    expect(row.total_input_tokens).toBe(3800);
    expect(row.total_output_tokens).toBe(750);
    expect(row.avg_duration_ms).toBeCloseTo(2900, 0);
  });

  it("groups stats by call_type and orders by total_input_tokens desc", () => {
    store.recordLlmCallEvent({ call_type: "pr_review", model: "m", input_tokens: 500, output_tokens: 100 });
    store.recordLlmCallEvent({ call_type: "supervisor", model: "m", input_tokens: 3000, output_tokens: 500 });
    store.recordLlmCallEvent({ call_type: "task_verify", model: "m", input_tokens: 800, output_tokens: 150 });
    store.recordLlmCallEvent({ call_type: "improvement", model: "m", input_tokens: 4000, output_tokens: 800 });

    const stats = store.getTokenStats();
    expect(stats).toHaveLength(4);
    // Ordered by total_input_tokens DESC
    expect(stats[0].call_type).toBe("improvement");   // 4000
    expect(stats[1].call_type).toBe("supervisor");    // 3000
    expect(stats[2].call_type).toBe("task_verify");   // 800
    expect(stats[3].call_type).toBe("pr_review");     // 500
  });

  it("getTokenStats respects sinceHours window", () => {
    // Record an event now
    store.recordLlmCallEvent({
      call_type: "pr_review",
      model: "claude-sonnet-4-6",
      input_tokens: 1000,
      output_tokens: 200,
    });

    // Stats with a 1-hour window should include the recent event
    const recent = store.getTokenStats(1);
    expect(recent).toHaveLength(1);

    // A 0.001-hour window should still work without crashing (rounds to 1)
    const tiny = store.getTokenStats(0.0001);
    expect(Array.isArray(tiny)).toBe(true);
  });

  it("swallows instrumentation errors gracefully", () => {
    // Passing null call_type should not throw — errors are swallowed
    expect(() =>
      store.recordLlmCallEvent({
        call_type: "pr_review",
        model: "claude-sonnet-4-6",
        input_tokens: -1, // unusual but shouldn't throw
        output_tokens: 0,
      }),
    ).not.toThrow();
  });
});
