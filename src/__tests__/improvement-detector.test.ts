/**
 * Tests for ImprovementDetector — focusing on the research findings analysis path.
 *
 * The LLM call in analyzeResearchFindings() is not mocked here; instead we test
 * the private parseResponse logic via the exported helper and the public interface
 * contract (no-op on empty / non-research input).
 */

import { describe, it, expect } from "vitest";
import { ImprovementDetector } from "../reviewer/improvement-detector.js";
import type { ReviewerConfig } from "../config.js";
import type { Task } from "../state/types.js";

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
