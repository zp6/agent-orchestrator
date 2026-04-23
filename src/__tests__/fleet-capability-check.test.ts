/**
 * Tests for fleet-wide capability check endpoint (research-agent#178 cross-repo).
 *
 * The research agent calls GET /api/fleet-capability-check before starting any
 * task. These tests cover the pure evaluation logic and the HTTP handler.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateFleetCapability,
  handleFleetCapabilityCheck,
  parseFleetCapabilityCheckQuery,
  findCapableAgents,
  extractRepoFromSourceRef,
  FLEET_CAPABILITY_MAP,
} from "../reviewer/fleet-capability-check.js";
import type { FleetCapabilityCheckRequest } from "../reviewer/fleet-capability-check.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date("2026-04-23T14:00:00Z");

function req(overrides: Partial<FleetCapabilityCheckRequest> = {}): FleetCapabilityCheckRequest {
  return {
    agent: "claude-research-agent",
    task_type: "research",
    ...overrides,
  };
}

// ── FLEET_CAPABILITY_MAP ──────────────────────────────────────────────────────

describe("FLEET_CAPABILITY_MAP", () => {
  it("contains all expected fleet agents", () => {
    const expected = [
      "claude-orchestrator-reviewer",
      "claude-research-agent",
      "claude-agent-orchestrator",
      "claude-orchestrator-dashboard",
      "claude-orchestrator-telegram",
      "claude-proxy",
      "meeting-facilitator-agent",
    ];
    for (const name of expected) {
      expect(FLEET_CAPABILITY_MAP).toHaveProperty(name);
    }
  });

  it("claude-research-agent allows research, investigation, housekeeping", () => {
    const entry = FLEET_CAPABILITY_MAP["claude-research-agent"];
    expect(entry.allowedTaskTypes.has("research")).toBe(true);
    expect(entry.allowedTaskTypes.has("investigation")).toBe(true);
    expect(entry.allowedTaskTypes.has("housekeeping")).toBe(true);
    expect(entry.allowedTaskTypes.has("implementation")).toBe(false);
  });

  it("claude-research-agent ownRepo is rapartlu/research-agent", () => {
    expect(FLEET_CAPABILITY_MAP["claude-research-agent"].ownRepo).toBe("rapartlu/research-agent");
  });

  it("claude-orchestrator-reviewer does not allow implementation", () => {
    const entry = FLEET_CAPABILITY_MAP["claude-orchestrator-reviewer"];
    expect(entry.allowedTaskTypes.has("implementation")).toBe(false);
    expect(entry.allowedTaskTypes.has("review")).toBe(true);
  });
});

// ── extractRepoFromSourceRef ──────────────────────────────────────────────────

describe("extractRepoFromSourceRef", () => {
  it("extracts repo from 'owner/repo#123'", () => {
    expect(extractRepoFromSourceRef("rapartlu/agent-reviewer#441")).toBe("rapartlu/agent-reviewer");
  });

  it("returns null for undefined", () => {
    expect(extractRepoFromSourceRef(undefined)).toBeNull();
  });

  it("returns null for string without '#'", () => {
    expect(extractRepoFromSourceRef("no-hash")).toBeNull();
  });

  it("returns null when '#' is at position 0", () => {
    expect(extractRepoFromSourceRef("#123")).toBeNull();
  });
});

// ── findCapableAgents ─────────────────────────────────────────────────────────

describe("findCapableAgents", () => {
  it("returns agents that accept the given task type", () => {
    const agents = findCapableAgents("research", null);
    expect(agents).toContain("claude-research-agent");
    expect(agents).toContain("claude-orchestrator-reviewer");
  });

  it("includes the target repo's own agent for implementation tasks", () => {
    const agents = findCapableAgents("implementation", "rapartlu/agent-reviewer");
    // reviewer can do implementation on its own repo (own-repo exemption in evaluateFleetCapability,
    // but findCapableAgents also includes own-repo agents)
    expect(agents).toContain("claude-orchestrator-reviewer");
  });

  it("returns empty array for an unknown task type with no matching repo", () => {
    const agents = findCapableAgents("unknown-task-type", null);
    expect(agents).toHaveLength(0);
  });
});

// ── evaluateFleetCapability ───────────────────────────────────────────────────

describe("evaluateFleetCapability — research agent", () => {
  // ── Core misrouting case (task 01KPWCH3) ─────────────────────────────────
  it("rejects implementation task for a foreign repo (core misrouting case)", () => {
    const result = evaluateFleetCapability(req({
      task_type: "implementation",
      source_ref: "rapartlu/agent-reviewer#441",
    }), NOW);

    expect(result.accept).toBe(false);
    expect(result.reason).not.toBeNull();
    expect(result.reason).toContain("claude-research-agent");
    expect(result.reason).toContain("implementation");
    expect(result.checked_at).toBe("2026-04-23T14:00:00.000Z");
  });

  it("includes suggested agents in rejection response", () => {
    const result = evaluateFleetCapability(req({
      task_type: "implementation",
      source_ref: "rapartlu/agent-reviewer#441",
    }), NOW);

    expect(result.suggested_agents.length).toBeGreaterThan(0);
    // claude-orchestrator-reviewer handles its own implementation work
    expect(result.suggested_agents).toContain("claude-orchestrator-reviewer");
  });

  it("includes reject-before-starting guidance in rejection reason", () => {
    const result = evaluateFleetCapability(req({
      task_type: "implementation",
      source_ref: "rapartlu/agent-reviewer#441",
    }), NOW);

    expect(result.reason).toContain("Reject this task before starting any work");
  });

  // ── Accepted cases ────────────────────────────────────────────────────────
  it("accepts research task type", () => {
    const result = evaluateFleetCapability(req({ task_type: "research" }), NOW);
    expect(result.accept).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.suggested_agents).toHaveLength(0);
  });

  it("accepts investigation task type", () => {
    const result = evaluateFleetCapability(req({ task_type: "investigation" }), NOW);
    expect(result.accept).toBe(true);
  });

  it("accepts housekeeping task type", () => {
    const result = evaluateFleetCapability(req({ task_type: "housekeeping" }), NOW);
    expect(result.accept).toBe(true);
  });

  it("accepts implementation task targeting the research agent's own repo", () => {
    const result = evaluateFleetCapability(req({
      task_type: "implementation",
      source_ref: "rapartlu/research-agent#55",
    }), NOW);
    expect(result.accept).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("populates checked_at with the provided now", () => {
    const result = evaluateFleetCapability(req(), NOW);
    expect(result.checked_at).toBe("2026-04-23T14:00:00.000Z");
  });

  it("populates agent field with the input agent name", () => {
    const result = evaluateFleetCapability(req(), NOW);
    expect(result.agent).toBe("claude-research-agent");
  });
});

describe("evaluateFleetCapability — unknown agent", () => {
  it("accepts tasks for unknown agents (forward-compatible)", () => {
    const result = evaluateFleetCapability(
      req({ agent: "new-undocumented-agent" }),
      NOW,
    );
    expect(result.accept).toBe(true);
    expect(result.reason).toBeNull();
  });
});

describe("evaluateFleetCapability — reviewer agent", () => {
  it("rejects implementation task for a foreign repo", () => {
    const result = evaluateFleetCapability({
      agent: "claude-orchestrator-reviewer",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#100",
    }, NOW);
    expect(result.accept).toBe(false);
  });

  it("accepts implementation task for its own repo", () => {
    const result = evaluateFleetCapability({
      agent: "claude-orchestrator-reviewer",
      task_type: "implementation",
      source_ref: "rapartlu/agent-reviewer#200",
    }, NOW);
    expect(result.accept).toBe(true);
  });

  it("accepts review task type", () => {
    const result = evaluateFleetCapability({
      agent: "claude-orchestrator-reviewer",
      task_type: "review",
    }, NOW);
    expect(result.accept).toBe(true);
  });
});

describe("evaluateFleetCapability — orchestrator agent", () => {
  it("accepts implementation tasks", () => {
    const result = evaluateFleetCapability({
      agent: "claude-agent-orchestrator",
      task_type: "implementation",
      source_ref: "rapartlu/agent-orchestrator#50",
    }, NOW);
    expect(result.accept).toBe(true);
  });
});

// ── parseFleetCapabilityCheckQuery ────────────────────────────────────────────

describe("parseFleetCapabilityCheckQuery", () => {
  it("parses all fields from query params", () => {
    const result = parseFleetCapabilityCheckQuery({
      agent: "claude-research-agent",
      task_type: "implementation",
      title: "feat: PR guard cooldown enforcement",
      source_ref: "rapartlu/agent-reviewer#441",
    });
    expect(result.agent).toBe("claude-research-agent");
    expect(result.task_type).toBe("implementation");
    expect(result.title).toBe("feat: PR guard cooldown enforcement");
    expect(result.source_ref).toBe("rapartlu/agent-reviewer#441");
  });

  it("defaults task_type to 'implementation' when missing", () => {
    const result = parseFleetCapabilityCheckQuery({ agent: "claude-research-agent" });
    expect(result.task_type).toBe("implementation");
  });

  it("defaults agent to empty string when missing", () => {
    const result = parseFleetCapabilityCheckQuery({ task_type: "research" });
    expect(result.agent).toBe("");
  });

  it("leaves title undefined when not present", () => {
    const result = parseFleetCapabilityCheckQuery({ agent: "x", task_type: "research" });
    expect(result.title).toBeUndefined();
  });
});

// ── handleFleetCapabilityCheck ────────────────────────────────────────────────

describe("handleFleetCapabilityCheck", () => {
  it("rejects research agent receiving an implementation task", () => {
    const result = handleFleetCapabilityCheck({
      agent: "claude-research-agent",
      task_type: "implementation",
      source_ref: "rapartlu/agent-reviewer#441",
    }, NOW);

    expect(result.accept).toBe(false);
    expect(result.reason).toContain("Reject this task before starting any work");
    expect(result.suggested_agents.length).toBeGreaterThan(0);
  });

  it("accepts research agent receiving a research task", () => {
    const result = handleFleetCapabilityCheck({
      agent: "claude-research-agent",
      task_type: "research",
      source_ref: "rapartlu/research-agent#55",
    }, NOW);

    expect(result.accept).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("includes checked_at in the response", () => {
    const result = handleFleetCapabilityCheck(
      { agent: "claude-research-agent", task_type: "research" },
      NOW,
    );
    expect(typeof result.checked_at).toBe("string");
    expect(result.checked_at).toBe("2026-04-23T14:00:00.000Z");
  });

  it("accepts own-repo implementation for research agent", () => {
    const result = handleFleetCapabilityCheck({
      agent: "claude-research-agent",
      task_type: "implementation",
      source_ref: "rapartlu/research-agent#60",
    }, NOW);
    expect(result.accept).toBe(true);
  });
});
