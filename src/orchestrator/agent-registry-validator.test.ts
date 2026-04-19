import { describe, it, expect } from "vitest";
import {
  validateAgentInRegistry,
  buildRegistryBlockAlert,
} from "./agent-registry-validator.js";
import type { OrchestratorConfig } from "../config/schema.js";

function makeConfig(agentNames: string[]): OrchestratorConfig {
  const agents: OrchestratorConfig["agents"] = {};
  for (const name of agentNames) {
    agents[name] = {
      dir: name,
      description: `${name} agent`,
      capabilities: ["typescript"],
      owns_topics: [],
    };
  }
  return {
    proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
    orchestrator_dir: "/tmp/orch",
    base_dir: "/tmp",
    agents,
  };
}

describe("validateAgentInRegistry", () => {
  it("returns 'registered' for a known agent", () => {
    const config = makeConfig(["claude-agent-orchestrator", "claude-orchestrator-reviewer"]);
    const result = validateAgentInRegistry(config, "claude-agent-orchestrator");

    expect(result.status).toBe("registered");
    expect(result.agentName).toBe("claude-agent-orchestrator");
    expect(result.reason).toBeNull();
    expect(result.registeredAgents).toContain("claude-agent-orchestrator");
    expect(result.registeredAgents).toContain("claude-orchestrator-reviewer");
  });

  it("returns 'unregistered' for an unknown agent", () => {
    const config = makeConfig(["claude-agent-orchestrator"]);
    const result = validateAgentInRegistry(config, "ghost-agent");

    expect(result.status).toBe("unregistered");
    expect(result.agentName).toBe("ghost-agent");
    expect(result.reason).toContain('"ghost-agent"');
    expect(result.reason).toContain("agents.yaml");
    expect(result.reason).toContain("claude-agent-orchestrator");
    expect(result.registeredAgents).toEqual(["claude-agent-orchestrator"]);
  });

  it("returns 'unregistered' for an empty agent name", () => {
    const config = makeConfig(["claude-agent-orchestrator"]);
    const result = validateAgentInRegistry(config, "");

    expect(result.status).toBe("unregistered");
    expect(result.agentName).toBe("");
  });

  it("returns a sorted registeredAgents list", () => {
    const config = makeConfig(["z-agent", "a-agent", "m-agent"]);
    const result = validateAgentInRegistry(config, "z-agent");

    expect(result.registeredAgents).toEqual(["a-agent", "m-agent", "z-agent"]);
  });

  it("returns 'unregistered' when config.agents is empty", () => {
    const config = makeConfig([]);
    const result = validateAgentInRegistry(config, "some-agent");

    expect(result.status).toBe("unregistered");
    expect(result.registeredAgents).toEqual([]);
  });

  it("handles stale/renamed agent names (the ghost-agent scenario)", () => {
    // Simulates the real issue: tasks dispatched to codex-orchestrator-reviewer
    // when the system only has claude-orchestrator-reviewer registered.
    const config = makeConfig(["claude-orchestrator-reviewer"]);
    const result = validateAgentInRegistry(config, "codex-orchestrator-reviewer-old");

    expect(result.status).toBe("unregistered");
    expect(result.reason).toContain("renamed or decommissioned");
  });
});

describe("buildRegistryBlockAlert", () => {
  it("includes agent name and registered agents in the alert body", () => {
    const body = buildRegistryBlockAlert(
      "ghost-agent",
      "rapartlu/agent-orchestrator#860",
      ["claude-agent-orchestrator", "claude-orchestrator-reviewer"],
    );

    expect(body).toContain("ghost-agent");
    expect(body).toContain("not registered");
    expect(body).toContain("agents.yaml");
    expect(body).toContain("rapartlu/agent-orchestrator#860");
    expect(body).toContain("claude-agent-orchestrator");
    expect(body).toContain("claude-orchestrator-reviewer");
  });

  it("omits source ref line when sourceRef is undefined", () => {
    const body = buildRegistryBlockAlert(
      "ghost-agent",
      undefined,
      ["claude-agent-orchestrator"],
    );

    expect(body).toContain("ghost-agent");
    expect(body).not.toContain("Source ref:");
  });
});
