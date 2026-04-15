import { describe, it, expect } from "vitest";
import {
  extractIntendedAgent,
  isRoutingMismatch,
  getRoutingMismatchDetail,
} from "./routing-mismatch-detector.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

const mockConfig: OrchestratorConfig = {
  proxy: {
    url: "http://localhost:3457",
    manager_url: "http://localhost:3400",
    timeout_ms: 900000,
  },
  agents: {
    "claude-research-agent": {
      dir: "/work/research",
      repo: "git@github.com:rapartlu/research-agent.git",
      github: "rapartlu/research-agent",
      description: "Research agent",
    },
    "claude-orchestrator-dashboard": {
      dir: "/work/dashboard",
      repo: "git@github.com:rapartlu/agent-dashboard.git",
      github: "rapartlu/agent-dashboard",
      description: "Dashboard agent",
    },
    "claude-agent-orchestrator": {
      dir: "/work/orchestrator",
      repo: "git@github.com:rapartlu/agent-orchestrator.git",
      github: "rapartlu/agent-orchestrator",
      description: "Orchestrator core",
    },
  },
};

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-123",
    title: "[claude-research-agent] Test task",
    source: "github",
    status: "done",
    agent_name: "claude-research-agent",
    created_at: "2026-04-15T10:00:00Z",
    updated_at: "2026-04-15T10:05:00Z",
    ...overrides,
  };
}

describe("routing-mismatch-detector", () => {
  describe("extractIntendedAgent", () => {
    it("extracts valid agent name from title prefix", () => {
      const title = "[claude-research-agent] Research task";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBe("claude-research-agent");
    });

    it("extracts agent name with hyphens and numbers", () => {
      const title = "[claude-orchestrator-dashboard] Dashboard update";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBe("claude-orchestrator-dashboard");
    });

    it("requires lowercase agent names (agent names are lowercase)", () => {
      const title = "[CLAUDE-RESEARCH-AGENT] Research";
      const result = extractIntendedAgent(title, mockConfig);
      // Agent names are always lowercase in config, so uppercase brackets return null
      expect(result).toBeNull();
    });

    it("returns null if agent doesn't exist in config", () => {
      const title = "[nonexistent-agent] Task";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBeNull();
    });

    it("returns null if no bracket prefix", () => {
      const title = "Task without agent prefix";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBeNull();
    });

    it("returns null for empty title", () => {
      const result = extractIntendedAgent("", mockConfig);
      expect(result).toBeNull();
    });

    it("returns null for null title", () => {
      const result = extractIntendedAgent(null as any, mockConfig);
      expect(result).toBeNull();
    });

    it("handles whitespace before bracket", () => {
      const title = "  [claude-research-agent] Task";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBe("claude-research-agent");
    });

    it("does not match if bracket is not at start", () => {
      const title = "Task [claude-research-agent] title";
      const result = extractIntendedAgent(title, mockConfig);
      expect(result).toBeNull();
    });
  });

  describe("isRoutingMismatch", () => {
    it("detects mismatch when agent differs from intended", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: "claude-orchestrator-dashboard",
      });
      expect(isRoutingMismatch(task, mockConfig)).toBe(true);
    });

    it("returns false when agents match", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: "claude-research-agent",
      });
      expect(isRoutingMismatch(task, mockConfig)).toBe(false);
    });

    it("returns false when no intended agent prefix", () => {
      const task = createTask({
        title: "Task without agent",
        agent_name: "claude-research-agent",
      });
      expect(isRoutingMismatch(task, mockConfig)).toBe(false);
    });

    it("returns false when task has no agent_name", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: undefined,
      });
      expect(isRoutingMismatch(task, mockConfig)).toBe(false);
    });

    it("returns false for intended agent not in config", () => {
      const task = createTask({
        title: "[unknown-agent] Task",
        agent_name: "claude-research-agent",
      });
      expect(isRoutingMismatch(task, mockConfig)).toBe(false);
    });
  });

  describe("getRoutingMismatchDetail", () => {
    it("returns mismatch details for mismatch", () => {
      const task = createTask({
        title: "[claude-research-agent] Research task",
        agent_name: "claude-orchestrator-dashboard",
        quality_score: 0.65,
        verification_status: "rejected",
      });

      const detail = getRoutingMismatchDetail(task, mockConfig);

      expect(detail).not.toBeNull();
      expect(detail!.taskId).toBe("task-123");
      expect(detail!.taskTitle).toBe("[claude-research-agent] Research task");
      expect(detail!.intendedAgent).toBe("claude-research-agent");
      expect(detail!.actualAgent).toBe("claude-orchestrator-dashboard");
      expect(detail!.qualityScore).toBe(0.65);
      expect(detail!.verificationStatus).toBe("rejected");
    });

    it("returns null when agents match", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: "claude-research-agent",
      });

      const detail = getRoutingMismatchDetail(task, mockConfig);
      expect(detail).toBeNull();
    });

    it("returns null quality score as null", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: "claude-orchestrator-dashboard",
        quality_score: undefined,
      });

      const detail = getRoutingMismatchDetail(task, mockConfig);
      expect(detail!.qualityScore).toBeNull();
    });

    it("includes task status and timestamps", () => {
      const task = createTask({
        title: "[claude-research-agent] Research",
        agent_name: "claude-orchestrator-dashboard",
        status: "done",
        created_at: "2026-04-10T08:00:00Z",
      });

      const detail = getRoutingMismatchDetail(task, mockConfig);
      expect(detail!.taskStatus).toBe("done");
      expect(detail!.createdAt).toBe("2026-04-10T08:00:00Z");
    });
  });
});
