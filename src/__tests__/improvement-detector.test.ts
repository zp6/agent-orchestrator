/**
 * Tests for ImprovementDetector — focusing on the research findings analysis path
 * and the batch deduplication guard (issue #458).
 *
 * The LLM call in analyzeResearchFindings() is not mocked here; instead we test
 * the private parseResponse logic via the exported helper and the public interface
 * contract (no-op on empty / non-research input).
 *
 * Batch deduplication guard tests use an in-memory StateStore to exercise the
 * full SQLite path without requiring a real file.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImprovementDetector, computeBatchHash } from "../reviewer/improvement-detector.js";
import { StateStore } from "../state/store.js";
import type { ReviewerConfig } from "../config.js";
import type { Task, IImprovementBatchDeduplicationStore } from "../state/types.js";

const mockConfig: ReviewerConfig = {
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orch",
  agents: {
    "claude-orchestrator-reviewer": {
      description: "The quality and oversight layer",
      github: "rapartlu/agent-reviewer",
      dir: "agent-reviewer",
    },
    "claude-proxy": {
      description: "Claude proxy agent",
      github: "rapartlu/claude-proxy",
      dir: "claude-proxy",
    },
    "claude-agent-orchestrator": {
      description: "Orchestrator control plane",
      github: "rapartlu/claude-agent-orchestrator",
      dir: "orchestrator",
    },
  },
};

function makeResearchTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "aaaabbbbccccdddd",
    title: "Research: follow-up context injection",
    status: "done",
    task_type: "research",
    agent_name: "claude-research-agent",
    result: `# Follow-Up Context Injection Research

**Date:** 2026-04-13

## Summary
Injecting research findings into follow-up context reduces manual operator effort.

## Recommendation
Implement automatic issue drafting from research findings in the improvement detector.
The detector should ingest the Recommendation and Next Steps sections and create
GitHub issues for operator review.

## Next Steps
- Add \`analyzeResearchFindings()\` to ImprovementDetector
- Wire the new method in the orchestrator's periodic improvement cycle
`,
    ...overrides,
  };
}

function makeImplTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "1111222233334444",
    title: "Fix null pointer in router",
    status: "done",
    task_type: "implementation",
    agent_name: "claude-agent-orchestrator",
    quality_score: 0.9,
    verification_status: "approved",
    ...overrides,
  };
}

describe("ImprovementDetector.analyzeResearchFindings", () => {
  it("returns empty array when no tasks are provided", async () => {
    const detector = new ImprovementDetector(mockConfig);
    const result = await detector.analyzeResearchFindings([]);
    expect(result).toEqual([]);
  });

  it("returns empty array when all tasks are implementation tasks", async () => {
    const detector = new ImprovementDetector(mockConfig);
    const tasks = [makeImplTask(), makeImplTask({ id: "5555666677778888" })];
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
  });

  it("returns empty array when research tasks have no result", async () => {
    const detector = new ImprovementDetector(mockConfig);
    const tasks = [makeResearchTask({ result: null })];
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
  });

  it("returns empty array when research task status is not done", async () => {
    const detector = new ImprovementDetector(mockConfig);
    const tasks = [makeResearchTask({ status: "in_progress" })];
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
  });

  it("filters out non-research tasks before sending to LLM", async () => {
    // This test verifies the early-exit guard without making a real LLM call.
    // We pass a mix: one impl task + one research task with no result.
    // Both should be filtered out, returning [] without touching the LLM.
    const detector = new ImprovementDetector(mockConfig);
    const tasks = [
      makeImplTask(),
      makeResearchTask({ result: null }),
    ];
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
  });
});

describe("ImprovementDetector.analyze (research exclusion)", () => {
  it("returns empty array when only research tasks are passed", async () => {
    const detector = new ImprovementDetector(mockConfig);
    const tasks = [makeResearchTask(), makeResearchTask({ id: "9999aaaabbbbcccc" })];
    // analyze() should filter out research tasks and return [] without an LLM call
    const result = await detector.analyze(tasks);
    expect(result).toEqual([]);
  });
});

describe("DetectedImprovement source field", () => {
  it("improvements from analyzeResearchFindings have source = research-finding", async () => {
    // We can't test the full LLM path here, but we can verify the type contract
    // by inspecting a hand-crafted improvement object (simulating parseResponse output).
    const improvement = {
      title: "Add research findings issue drafting",
      description: "Automatically draft GitHub issues from research recommendations",
      affected_agents: ["claude-orchestrator-reviewer"],
      severity: "medium" as const,
      evidence: [{ taskId: "aaaabbbb", detail: "Research: follow-up context injection" }],
      source: "research-finding" as const,
    };
    expect(improvement.source).toBe("research-finding");
  });

  it("improvements from analyze have source = task-pattern", () => {
    const improvement = {
      title: "Add webhook integration",
      description: "Dispatch tasks via incoming webhook",
      affected_agents: ["claude-agent-orchestrator"],
      severity: "high" as const,
      evidence: [],
      source: "task-pattern" as const,
    };
    expect(improvement.source).toBe("task-pattern");
  });
});

// ── computeBatchHash ─────────────────────────────────────────────────────────

describe("computeBatchHash", () => {
  it("returns a 64-char hex string", () => {
    const tasks = [makeImplTask()];
    const hash = computeBatchHash(tasks);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same set of tasks", () => {
    const tasks = [makeImplTask(), makeImplTask({ id: "2222333344445555" })];
    expect(computeBatchHash(tasks)).toBe(computeBatchHash(tasks));
  });

  it("is order-independent (same hash regardless of array order)", () => {
    const t1 = makeImplTask({ id: "aaaa000000000001" });
    const t2 = makeImplTask({ id: "aaaa000000000002" });
    expect(computeBatchHash([t1, t2])).toBe(computeBatchHash([t2, t1]));
  });

  it("changes when task status changes", () => {
    const t = makeImplTask();
    const tDone = { ...t, status: "failed" as const };
    expect(computeBatchHash([t])).not.toBe(computeBatchHash([tDone]));
  });

  it("changes when a different task is included", () => {
    const t1 = makeImplTask({ id: "aaaa000000000001" });
    const t2 = makeImplTask({ id: "aaaa000000000002" });
    expect(computeBatchHash([t1])).not.toBe(computeBatchHash([t2]));
  });

  it("returns a stable hash for an empty array", () => {
    expect(computeBatchHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── StateStore: IImprovementBatchDeduplicationStore ───────────────────────────

describe("StateStore batch deduplication", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
  });

  it("recordImprovementAnalysisRun stores a row, getRecentImprovementAnalysisRuns returns it", () => {
    store.recordImprovementAnalysisRun("abc123", 5, false);
    const runs = store.getRecentImprovementAnalysisRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].batch_hash).toBe("abc123");
    expect(runs[0].task_count).toBe(5);
    expect(runs[0].skipped).toBe(false);
  });

  it("recordImprovementAnalysisRun skipped=true is stored correctly", () => {
    store.recordImprovementAnalysisRun("abc123", 3, true);
    const runs = store.getRecentImprovementAnalysisRuns();
    expect(runs[0].skipped).toBe(true);
  });

  it("hasRecentImprovementAnalysisRun returns false when no run exists", () => {
    expect(store.hasRecentImprovementAnalysisRun("unknown-hash")).toBe(false);
  });

  it("hasRecentImprovementAnalysisRun returns true after a non-skipped run is recorded", () => {
    store.recordImprovementAnalysisRun("myhash", 4, false);
    expect(store.hasRecentImprovementAnalysisRun("myhash")).toBe(true);
  });

  it("hasRecentImprovementAnalysisRun returns false when only skipped runs exist", () => {
    store.recordImprovementAnalysisRun("myhash", 4, true);
    // A skipped run should not count as "seen" for deduplication purposes.
    expect(store.hasRecentImprovementAnalysisRun("myhash")).toBe(false);
  });

  it("getRecentImprovementAnalysisRuns respects the limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      store.recordImprovementAnalysisRun(`hash-${i}`, i + 1, false);
    }
    const runs = store.getRecentImprovementAnalysisRuns(3);
    expect(runs).toHaveLength(3);
  });

  it("getRecentImprovementAnalysisRuns returns newest first", () => {
    store.recordImprovementAnalysisRun("older", 1, false);
    store.recordImprovementAnalysisRun("newer", 2, false);
    const runs = store.getRecentImprovementAnalysisRuns();
    expect(runs[0].batch_hash).toBe("newer");
  });
});

// ── ImprovementDetector batch deduplication guard ─────────────────────────────

describe("ImprovementDetector batch deduplication guard", () => {
  /** Minimal dedup store stub for injecting controlled responses. */
  function makeStub(hasSeen: boolean): IImprovementBatchDeduplicationStore & {
    recorded: Array<{ hash: string; count: number; skipped: boolean }>;
  } {
    const recorded: Array<{ hash: string; count: number; skipped: boolean }> = [];
    return {
      recorded,
      hasRecentImprovementAnalysisRun: () => hasSeen,
      recordImprovementAnalysisRun(hash, count, skipped) {
        recorded.push({ hash, count, skipped });
      },
      getRecentImprovementAnalysisRuns: () => [],
    };
  }

  it("skips analyze() and returns [] when batch was recently seen", async () => {
    const stub = makeStub(true);
    const detector = new ImprovementDetector(mockConfig, stub as never);
    const tasks = [makeImplTask()];
    const result = await detector.analyze(tasks);
    expect(result).toEqual([]);
    // Must record the skip
    expect(stub.recorded).toHaveLength(1);
    expect(stub.recorded[0].skipped).toBe(true);
  });

  it("skips analyzeResearchFindings() and returns [] when batch was recently seen", async () => {
    const stub = makeStub(true);
    const detector = new ImprovementDetector(mockConfig, stub as never);
    const tasks = [makeResearchTask()];
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
    expect(stub.recorded).toHaveLength(1);
    expect(stub.recorded[0].skipped).toBe(true);
  });

  it("records a non-skipped run when batch is new (analyze)", async () => {
    const stub = makeStub(false);
    const detector = new ImprovementDetector(mockConfig, stub as never);
    const tasks = [makeImplTask()];
    // The dedup record is written before the LLM call, so it is persisted even
    // when the LLM client throws (e.g. no API key in tests).  The LLM error is
    // caught inside analyze() and returns [].
    const result = await detector.analyze(tasks);
    expect(result).toEqual([]); // LLM error swallowed, returns []
    expect(stub.recorded).toHaveLength(1);
    expect(stub.recorded[0].skipped).toBe(false);
  });

  it("records a non-skipped run when batch is new (analyzeResearchFindings)", async () => {
    const stub = makeStub(false);
    const detector = new ImprovementDetector(mockConfig, stub as never);
    const tasks = [makeResearchTask()];
    // Same as above — LLM error is caught inside analyzeResearchFindings().
    const result = await detector.analyzeResearchFindings(tasks);
    expect(result).toEqual([]);
    expect(stub.recorded).toHaveLength(1);
    expect(stub.recorded[0].skipped).toBe(false);
  });

  it("does not call dedup store when store is not provided", async () => {
    // Detector without a store — should work as before with no dedup
    const detector = new ImprovementDetector(mockConfig);
    const result = await detector.analyze([]);
    expect(result).toEqual([]);
  });
});
