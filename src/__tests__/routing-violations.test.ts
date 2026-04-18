/**
 * Tests for the routing violation detector (issue #293).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";
import {
  detectViolation,
  extractRepoFromSourceRef,
  buildRepoOwnerMap,
  formatViolationsForDisplay,
} from "../reviewer/routing-violations.js";
import type { Task, RoutingViolation } from "../state/types.js";
import type { AgentConfig } from "../config.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────

function tmpDbPath(): string {
  return path.join("/tmp", `test-rv-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

const AGENTS: Record<string, AgentConfig> = {
  "claude-agent-orchestrator": {
    description: "Orchestrator",
    github: "rapartlu/agent-orchestrator",
    dir: "agent-orchestrator",
  },
  "claude-orchestrator-reviewer": {
    description: "Reviewer",
    github: "rapartlu/agent-reviewer",
    dir: "agent-reviewer",
  },
  "claude-orchestrator-dashboard": {
    description: "Dashboard",
    github: "rapartlu/agent-dashboard",
    dir: "agent-dashboard",
  },
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01TEST" + Math.random().toString(36).slice(2, 8).toUpperCase(),
    title: "Test task",
    status: "done",
    task_type: "implementation",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Task;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("extractRepoFromSourceRef", () => {
  it("extracts repo from standard source_ref", () => {
    expect(extractRepoFromSourceRef("rapartlu/agent-reviewer#292")).toBe("rapartlu/agent-reviewer");
  });

  it("returns null for null/undefined input", () => {
    expect(extractRepoFromSourceRef(null)).toBeNull();
    expect(extractRepoFromSourceRef(undefined)).toBeNull();
  });

  it("returns null for bare issue number", () => {
    expect(extractRepoFromSourceRef("#42")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractRepoFromSourceRef("")).toBeNull();
  });
});

describe("buildRepoOwnerMap", () => {
  it("maps repos to agent names", () => {
    const map = buildRepoOwnerMap(AGENTS);
    expect(map.get("rapartlu/agent-orchestrator")).toBe("claude-agent-orchestrator");
    expect(map.get("rapartlu/agent-reviewer")).toBe("claude-orchestrator-reviewer");
    expect(map.get("rapartlu/agent-dashboard")).toBe("claude-orchestrator-dashboard");
  });

  it("skips agents without github field", () => {
    const agents = { "no-repo": { description: "No repo", dir: "." } };
    const map = buildRepoOwnerMap(agents);
    expect(map.size).toBe(0);
  });
});

describe("detectViolation", () => {
  const repoOwnerMap = buildRepoOwnerMap(AGENTS);

  it("returns null when agent owns the target repo", () => {
    const task = makeTask({
      agent_name: "claude-orchestrator-reviewer",
      source_ref: "rapartlu/agent-reviewer#42",
    });
    expect(detectViolation(task, repoOwnerMap, AGENTS)).toBeNull();
  });

  it("detects violation when agent does NOT own the target repo", () => {
    const task = makeTask({
      agent_name: "claude-orchestrator-dashboard",
      source_ref: "rapartlu/agent-reviewer#42",
      title: "Wrong agent for reviewer repo",
    });
    const v = detectViolation(task, repoOwnerMap, AGENTS);
    expect(v).not.toBeNull();
    expect(v!.agent_name).toBe("claude-orchestrator-dashboard");
    expect(v!.target_repo).toBe("rapartlu/agent-reviewer");
    expect(v!.expected_agent).toBe("claude-orchestrator-reviewer");
  });

  it("returns null when task has no agent_name", () => {
    const task = makeTask({ agent_name: null, source_ref: "rapartlu/agent-reviewer#1" });
    expect(detectViolation(task, repoOwnerMap, AGENTS)).toBeNull();
  });

  it("returns null when task has no source_ref", () => {
    const task = makeTask({ agent_name: "claude-orchestrator-reviewer", source_ref: null });
    expect(detectViolation(task, repoOwnerMap, AGENTS)).toBeNull();
  });

  it("returns null when target repo is not in config", () => {
    const task = makeTask({
      agent_name: "claude-orchestrator-reviewer",
      source_ref: "rapartlu/unknown-repo#1",
    });
    expect(detectViolation(task, repoOwnerMap, AGENTS)).toBeNull();
  });
});

describe("StateStore routing violations", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDbPath();
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
  });

  it("records and retrieves routing violations", () => {
    const now = new Date().toISOString();
    store.recordRoutingViolation({
      task_id: "01TESTABC",
      agent_name: "claude-orchestrator-dashboard",
      target_repo: "rapartlu/agent-reviewer",
      expected_agent: "claude-orchestrator-reviewer",
      task_title: "Test violation",
      dispatched_at: now,
      detected_at: now,
    });

    const violations = store.getRoutingViolations();
    expect(violations).toHaveLength(1);
    expect(violations[0].task_id).toBe("01TESTABC");
    expect(violations[0].agent_name).toBe("claude-orchestrator-dashboard");
    expect(violations[0].target_repo).toBe("rapartlu/agent-reviewer");
    expect(violations[0].expected_agent).toBe("claude-orchestrator-reviewer");
  });

  it("returns empty array when no violations exist", () => {
    expect(store.getRoutingViolations()).toEqual([]);
  });

  it("limits results", () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      store.recordRoutingViolation({
        task_id: `01TEST${i}`,
        agent_name: "agent-a",
        target_repo: "org/repo",
        expected_agent: "agent-b",
        dispatched_at: now,
        detected_at: now,
      });
    }
    expect(store.getRoutingViolations(3)).toHaveLength(3);
  });
});

describe("formatViolationsForDisplay", () => {
  it("shows 'no violations' for empty list", () => {
    const output = formatViolationsForDisplay([]);
    expect(output).toContain("No routing violations");
  });

  it("formats violations as a table", () => {
    const violations: RoutingViolation[] = [
      {
        id: 1,
        task_id: "01TESTABC123",
        agent_name: "claude-orchestrator-dashboard",
        target_repo: "rapartlu/agent-reviewer",
        expected_agent: "claude-orchestrator-reviewer",
        dispatched_at: "2026-04-18T10:00:00.000Z",
        detected_at: "2026-04-18T10:01:00.000Z",
        task_title: "Test task",
      },
    ];
    const output = formatViolationsForDisplay(violations);
    expect(output).toContain("01TESTABC1");
    expect(output).toContain("claude-orchestrator-dashbo"); // truncated to 26 chars
    expect(output).toContain("rapartlu/agent-reviewer");
    expect(output).toContain("claude-orchestrator-review"); // truncated to 26 chars
  });
});
