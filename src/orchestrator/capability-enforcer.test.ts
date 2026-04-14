import { describe, it, expect } from "vitest";
import {
  isImplementationTask,
  checkCapabilityEnforcement,
} from "./capability-enforcer.js";
import type { OrchestratorConfig } from "../config/schema.js";

// Minimal config factory
function makeConfig(agents: Record<string, { github?: string; capability_tags?: string[] }>): OrchestratorConfig {
  const agentEntries: OrchestratorConfig["agents"] = {};
  for (const [name, overrides] of Object.entries(agents)) {
    agentEntries[name] = {
      dir: `/agents/${name}`,
      description: `Test agent ${name}`,
      capabilities: [],
      owns_topics: [],
      ...overrides,
    };
  }
  return {
    proxy: { url: "http://localhost:3400", timeout_ms: 30000 },
    base_dir: "/agents",
    orchestrator_dir: "/orchestrator",
    agents: agentEntries,
  };
}

describe("isImplementationTask", () => {
  it("returns true for implementation taskType", () => {
    expect(isImplementationTask("implementation")).toBe(true);
  });

  it("returns false for research taskType with no title/sourceRef", () => {
    expect(isImplementationTask("research")).toBe(false);
  });

  it("returns true for research type with [Orchestrator] title", () => {
    expect(isImplementationTask("research", "[Orchestrator] Fix watchdog timeout")).toBe(true);
  });

  it("returns true for research type with [orchestrator dashboard] title (case insensitive)", () => {
    expect(isImplementationTask("research", "[Orchestrator Dashboard] Add panel")).toBe(true);
  });

  it("returns true for research type with [agent orchestrator] title", () => {
    expect(isImplementationTask("research", "[agent orchestrator] Block research")).toBe(true);
  });

  it("returns true when sourceRef is a different repo from agentGithub", () => {
    expect(
      isImplementationTask("research", undefined, "rapartlu/agent-orchestrator#811", "rapartlu/research-agent"),
    ).toBe(true);
  });

  it("returns false when sourceRef matches agentGithub", () => {
    expect(
      isImplementationTask("research", undefined, "rapartlu/research-agent#5", "rapartlu/research-agent"),
    ).toBe(false);
  });
});

describe("checkCapabilityEnforcement", () => {
  it("returns null when agent has no capability_tags", () => {
    const config = makeConfig({
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator" },
    });
    expect(
      checkCapabilityEnforcement({
        config,
        agentName: "claude-impl-agent",
        taskType: "implementation",
      }),
    ).toBeNull();
  });

  it("returns null when agent is research-only but task is research type with own sourceRef", () => {
    const config = makeConfig({
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
    });
    expect(
      checkCapabilityEnforcement({
        config,
        agentName: "claude-research-agent",
        taskType: "research",
        sourceRef: "rapartlu/research-agent#10",
      }),
    ).toBeNull();
  });

  it("returns reroute descriptor when research-only agent receives implementation task", () => {
    const config = makeConfig({
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
      "claude-agent-orchestrator": {
        github: "rapartlu/agent-orchestrator",
      },
    });

    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[Orchestrator] Watchdog pressure Telegram alert",
      sourceRef: "rapartlu/agent-orchestrator#811",
    });

    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-research-agent");
    expect(result!.toAgent).toBe("claude-agent-orchestrator");
    expect(result!.redirectReason).toContain("research-only");
    expect(result!.redirectReason).toContain("claude-agent-orchestrator");
  });

  it("routes to exact repo match when available", () => {
    const config = makeConfig({
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
      "claude-dashboard-agent": {
        github: "rapartlu/agent-dashboard",
      },
      "claude-orchestrator-agent": {
        github: "rapartlu/agent-orchestrator",
      },
    });

    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      sourceRef: "rapartlu/agent-dashboard#196",
    });

    expect(result!.toAgent).toBe("claude-dashboard-agent");
  });

  it("falls back to first non-research-only agent when no exact repo match", () => {
    const config = makeConfig({
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
      "claude-impl-agent": {
        github: "rapartlu/agent-impl",
      },
    });

    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      // sourceRef points to unknown repo
      sourceRef: "rapartlu/unknown-repo#42",
    });

    expect(result!.toAgent).toBe("claude-impl-agent");
  });
});
