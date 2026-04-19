/**
 * Tests for the Semantic Task Memory system (issue #1011).
 *
 * Covers:
 *  1. FTS5 query builder — keyword extraction, stopword removal, term limiting
 *  2. buildSemanticMemoryBlock() — output formatting
 *  3. StateStore integration — migration, indexing, querying
 */

import { describe, it, expect } from "vitest";
import { buildSemanticMemoryBlock, type SemanticMemoryMatch } from "../../orchestrator/semantic-memory.js";
import { StateStore } from "../../state/store.js";

// ── buildSemanticMemoryBlock ─────────────────────────────────────────────────

describe("buildSemanticMemoryBlock", () => {
  it("returns empty string when matches is null", () => {
    expect(buildSemanticMemoryBlock(null)).toBe("");
  });

  it("returns empty string when matches is empty array", () => {
    expect(buildSemanticMemoryBlock([])).toBe("");
  });

  it("formats a single match with all fields", () => {
    const matches: SemanticMemoryMatch[] = [
      {
        taskId: "01TASK1",
        title: "Add retry logic to dispatcher",
        sourceRef: "rapartlu/agent-orchestrator#42",
        qualityScore: 0.92,
        reviewerNotes: "Clean implementation, good error handling.",
        resultExcerpt: "Implemented exponential backoff with jitter...",
      },
    ];

    const block = buildSemanticMemoryBlock(matches);

    expect(block).toContain("Past Successes");
    expect(block).toContain("Add retry logic to dispatcher");
    expect(block).toContain("0.92");
    expect(block).toContain("rapartlu/agent-orchestrator#42");
    expect(block).toContain("Clean implementation");
    expect(block).toContain("exponential backoff");
    expect(block).toContain("proven patterns");
  });

  it("formats multiple matches with numbered headers", () => {
    const matches: SemanticMemoryMatch[] = [
      {
        taskId: "01A",
        title: "First task",
        sourceRef: null,
        qualityScore: 0.90,
        reviewerNotes: null,
        resultExcerpt: null,
      },
      {
        taskId: "01B",
        title: "Second task",
        sourceRef: "repo#2",
        qualityScore: 0.85,
        reviewerNotes: "Good work",
        resultExcerpt: null,
      },
      {
        taskId: "01C",
        title: "Third task",
        sourceRef: null,
        qualityScore: 0.88,
        reviewerNotes: null,
        resultExcerpt: "Some excerpt",
      },
    ];

    const block = buildSemanticMemoryBlock(matches);

    expect(block).toContain("### 1. First task");
    expect(block).toContain("### 2. Second task");
    expect(block).toContain("### 3. Third task");
  });

  it("omits optional fields when null", () => {
    const matches: SemanticMemoryMatch[] = [
      {
        taskId: "01X",
        title: "Minimal task",
        sourceRef: null,
        qualityScore: 0.80,
        reviewerNotes: null,
        resultExcerpt: null,
      },
    ];

    const block = buildSemanticMemoryBlock(matches);

    expect(block).toContain("Minimal task");
    expect(block).toContain("0.80");
    expect(block).not.toContain("Source:");
    expect(block).not.toContain("Reviewer notes:");
    expect(block).not.toContain("Result excerpt:");
  });
});

// ── StateStore semantic memory integration ───────────────────────────────────

describe("StateStore semantic memory", () => {
  it("creates FTS5 table and tracking table during construction", () => {
    const store = new StateStore(":memory:");

    // The semantic_memory FTS5 table should exist
    const size = store.getSemanticMemorySize();
    expect(size).toBe(0);
  });

  it("indexes approved tasks with high quality scores", () => {
    const store = new StateStore(":memory:");

    // Create an approved task with quality_score > 0.80
    store.createTask({
      title: "Implement retry logic",
      description: "Add exponential backoff to the dispatcher",
      source: "github",
      taskType: "implementation",
    });

    // Get the task ID
    const tasks = store.listTasks({ limit: 1 });
    const taskId = tasks[0].id;

    // Simulate verification: mark as done + approved with high score
    store.updateTask(taskId, {
      status: "done",
      result: "Implemented exponential backoff with jitter. Added 3 retry attempts with configurable delays. Includes circuit breaker pattern for repeated failures.",
      verification_status: "approved",
      quality_score: 0.92,
      verification_notes: "Clean implementation. Good error handling and test coverage.",
    });

    // Now index
    const indexed = store.indexApprovedTasksIntoMemory(0.80, 400);
    expect(indexed).toBe(1);
    expect(store.getSemanticMemorySize()).toBe(1);

    // Second call should not re-index
    const reindexed = store.indexApprovedTasksIntoMemory(0.80, 400);
    expect(reindexed).toBe(0);
  });

  it("skips tasks below quality threshold", () => {
    const store = new StateStore(":memory:");

    store.createTask({
      title: "Low quality task",
      description: "This task got a low score",
      source: "github",
      taskType: "implementation",
    });

    const tasks = store.listTasks({ limit: 1 });
    store.updateTask(tasks[0].id, {
      status: "done",
      result: "Some mediocre implementation with issues that need fixing.",
      verification_status: "approved",
      quality_score: 0.65,
      verification_notes: "Needs improvement.",
    });

    const indexed = store.indexApprovedTasksIntoMemory(0.80, 400);
    expect(indexed).toBe(0);
  });

  it("queries semantic memory with keyword matching", () => {
    const store = new StateStore(":memory:");

    // Create and index a task about retry logic
    store.createTask({
      title: "Add exponential backoff retry to dispatcher",
      description: "Implement retry with jitter for failed dispatches",
      source: "github",
      taskType: "implementation",
    });
    const tasks = store.listTasks({ limit: 1 });
    store.updateTask(tasks[0].id, {
      status: "done",
      result: "Implemented exponential backoff with jitter. Added configurable retry delays and circuit breaker pattern.",
      verification_status: "approved",
      quality_score: 0.92,
      verification_notes: "Excellent retry implementation with good test coverage.",
    });

    // Create and index a task about Telegram alerts
    store.createTask({
      title: "Add Telegram notification for quality alerts",
      description: "Send Telegram messages when quality drops",
      source: "github",
      taskType: "implementation",
    });
    const tasks2 = store.listTasks({ limit: 2 });
    const telegramTaskId = tasks2.find((t) => t.title.includes("Telegram"))!.id;
    store.updateTask(telegramTaskId, {
      status: "done",
      result: "Added Telegram bot integration with dedup and rate limiting for quality alerts.",
      verification_status: "approved",
      quality_score: 0.88,
      verification_notes: "Good dedup logic. Rate limiting works correctly.",
    });

    store.indexApprovedTasksIntoMemory(0.80, 400);
    expect(store.getSemanticMemorySize()).toBe(2);

    // Query for retry-related tasks
    const retryMatches = store.querySemanticMemory("retry backoff dispatcher", 3);
    expect(retryMatches.length).toBeGreaterThan(0);
    expect(retryMatches[0].title).toContain("retry");

    // Query for Telegram-related tasks
    const telegramMatches = store.querySemanticMemory("telegram notification alerts", 3);
    expect(telegramMatches.length).toBeGreaterThan(0);
    expect(telegramMatches[0].title).toContain("Telegram");
  });

  it("excludes a specific task ID from results", () => {
    const store = new StateStore(":memory:");

    store.createTask({
      title: "Add webhook handler for GitHub events",
      description: "Process GitHub webhook payloads",
      source: "github",
      taskType: "implementation",
    });

    const tasks = store.listTasks({ limit: 1 });
    const taskId = tasks[0].id;
    store.updateTask(taskId, {
      status: "done",
      result: "Implemented webhook handler with signature verification and event routing.",
      verification_status: "approved",
      quality_score: 0.90,
    });

    store.indexApprovedTasksIntoMemory(0.80, 400);

    // Query excluding the same task
    const matches = store.querySemanticMemory("webhook handler", 3, taskId);
    expect(matches.every((m) => m.taskId !== taskId)).toBe(true);
  });

  it("returns empty array for queries with only stopwords", () => {
    const store = new StateStore(":memory:");
    const matches = store.querySemanticMemory("the and for with", 3);
    expect(matches).toEqual([]);
  });

  it("handles empty query gracefully", () => {
    const store = new StateStore(":memory:");
    const matches = store.querySemanticMemory("", 3);
    expect(matches).toEqual([]);
  });
});
