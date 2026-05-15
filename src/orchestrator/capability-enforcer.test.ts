import { describe, it, expect } from "vitest";
import {
  isImplementationTask,
  checkCapabilityEnforcement,
  checkRepoOwnership,
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

  // ── Issue #985: code-authorship keyword detection ─────────────────────────

  it("returns true when title contains 'implement' (pattern match)", () => {
    expect(isImplementationTask("research", "Implement the new dispatch guard")).toBe(true);
  });

  it("returns true when title contains 'create PR' (case insensitive)", () => {
    expect(isImplementationTask("research", "Create PR for routing boundary enforcement")).toBe(true);
  });

  it("returns true when title contains 'write tests'", () => {
    expect(isImplementationTask("research", "Write tests for the dispatcher module")).toBe(true);
  });

  it("returns true when title contains 'write code'", () => {
    expect(isImplementationTask("research", "Write code for the new capability enforcer")).toBe(true);
  });

  it("returns true when title contains 'build the' (keyword match)", () => {
    expect(isImplementationTask("research", "Build the new standup pipeline")).toBe(true);
  });

  it("returns true when title contains 'build a feature' (pattern match)", () => {
    expect(isImplementationTask("research", "Build a feature for conflict recovery")).toBe(true);
  });

  it("returns true when title contains 'build and deploy'", () => {
    expect(isImplementationTask("research", "Build and deploy the auth middleware")).toBe(true);
  });

  it("returns true when title contains 'write a handler'", () => {
    expect(isImplementationTask("research", "Write a handler for Telegram commands")).toBe(true);
  });

  it("returns true when title contains 'write a migration'", () => {
    expect(isImplementationTask("research", "Write a migration for state.db schema")).toBe(true);
  });

  it("returns false for research-flavored titles without code-authorship signals", () => {
    expect(isImplementationTask("research", "Research feasibility of conflict recovery reroute")).toBe(false);
  });

  it("returns false for 'write up research findings' — non-code write usage", () => {
    // The keyword 'write code' should not fire for generic writing tasks
    expect(isImplementationTask("research", "Write up research findings and summarise")).toBe(false);
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

// ── review-only tag enforcement ────────────────────────────────────────────

describe("checkCapabilityEnforcement — review-only", () => {
  it("returns null for a review-only agent receiving a non-implementation task", () => {
    const config = makeConfig({
      "claude-reviewer-agent": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-reviewer-agent",
      taskType: "research",
      sourceRef: "rapartlu/agent-reviewer#10",
    });
    expect(result).toBeNull();
  });

  it("reroutes implementation task away from review-only agent", () => {
    const config = makeConfig({
      "claude-reviewer-agent": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-reviewer-agent",
      taskType: "implementation",
      title: "[Orchestrator] Add dispatch guard",
      sourceRef: "rapartlu/agent-orchestrator#973",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-reviewer-agent");
    expect(result!.toAgent).toBe("claude-impl-agent");
    expect(result!.redirectReason).toContain("review-only");
  });

  it("routes to exact repo-match agent when one is available", () => {
    const config = makeConfig({
      "claude-reviewer-agent": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      "claude-dashboard-agent": { github: "rapartlu/agent-dashboard" },
      "claude-orchestrator-agent": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-reviewer-agent",
      taskType: "implementation",
      sourceRef: "rapartlu/agent-dashboard#416",
    });
    expect(result!.toAgent).toBe("claude-dashboard-agent");
  });

  it("does not select another review-only or research-only agent as substitute", () => {
    const config = makeConfig({
      "claude-reviewer-agent": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-reviewer-agent",
      taskType: "implementation",
      sourceRef: "rapartlu/agent-orchestrator#973",
    });
    expect(result!.toAgent).toBe("claude-impl-agent");
    expect(result!.toAgent).not.toBe("claude-research-agent");
  });

  it("falls back gracefully and returns null when no substitute is available", () => {
    const config = makeConfig({
      "claude-reviewer-agent": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      // All other agents are also restricted
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
      },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-reviewer-agent",
      taskType: "implementation",
      sourceRef: "rapartlu/agent-orchestrator#973",
    });
    // No valid substitute → enforcer allows dispatch to avoid deadlock
    expect(result).toBeNull();
  });
});

// ── Issue #985: claude-orchestrator-reviewer boundary enforcement ──────────
// These tests mirror real-world misroutes observed in tasks 01KPHX1B, 01KPHWS8,
// 01KPHWEJ, 01KPHW9R where the reviewer agent was dispatched code-authorship work.

describe("checkCapabilityEnforcement — reviewer agent code-authorship guard (issue #985)", () => {
  const makeReviewerConfig = (extraAgents: Record<string, { github?: string; capability_tags?: string[] }> = {}) =>
    makeConfig({
      "claude-orchestrator-reviewer": {
        github: "rapartlu/agent-reviewer",
        capability_tags: ["review-only"],
      },
      "claude-agent-orchestrator": {
        github: "rapartlu/agent-orchestrator",
      },
      ...extraAgents,
    });

  it("blocks 'implement' task dispatched to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "research",
      title: "Implement the new dispatch guard for reviewer routing",
      sourceRef: "rapartlu/agent-orchestrator#985",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-reviewer");
    expect(result!.toAgent).toBe("claude-agent-orchestrator");
  });

  it("blocks 'create PR' task dispatched to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "research",
      title: "Create PR for issue #985 routing boundary enforcement",
      sourceRef: "rapartlu/agent-orchestrator#985",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-reviewer");
  });

  it("blocks 'write tests' task dispatched to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "research",
      title: "Write tests for the capability enforcer module",
      sourceRef: "rapartlu/agent-orchestrator#985",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-reviewer");
  });

  it("blocks 'build a feature' task dispatched to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "research",
      title: "Build a feature for Telegram routing alerts",
      sourceRef: "rapartlu/agent-orchestrator#985",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-reviewer");
  });

  it("blocks explicit implementation taskType dispatched to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "implementation",
      title: "[Orchestrator] Add supervisor log query endpoint",
      sourceRef: "rapartlu/agent-orchestrator#977",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-reviewer");
    expect(result!.redirectReason).toContain("review-only");
  });

  it("allows genuine review task to pass through to reviewer", () => {
    const config = makeReviewerConfig();
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "research",
      title: "Review the PR for issue #984",
      // sourceRef points to its own repo — not a cross-repo implementation task
      sourceRef: "rapartlu/agent-reviewer#200",
    });
    expect(result).toBeNull();
  });

  it("routes to exact repo-match implementation agent when available", () => {
    const config = makeReviewerConfig({
      "claude-orchestrator-dashboard": { github: "rapartlu/agent-dashboard" },
    });
    const result = checkCapabilityEnforcement({
      config,
      agentName: "claude-orchestrator-reviewer",
      taskType: "implementation",
      sourceRef: "rapartlu/agent-dashboard#424",
    });
    expect(result!.toAgent).toBe("claude-orchestrator-dashboard");
  });
});

// ── checkRepoOwnership (issue #1614) ──────────────────────────────────────────

describe("checkRepoOwnership", () => {
  it("returns null when agent has no github field", () => {
    const config = makeConfig({
      "claude-agent-orchestrator": {},
    });
    expect(
      checkRepoOwnership({
        config,
        agentName: "claude-agent-orchestrator",
        sourceRef: "rapartlu/agent-reviewer#100",
      }),
    ).toBeNull();
  });

  it("returns null when source_ref has no '#' separator (non-GitHub ref)", () => {
    const config = makeConfig({
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    expect(
      checkRepoOwnership({
        config,
        agentName: "claude-agent-orchestrator",
        sourceRef: "linear-check:claude-agent-orchestrator:2026-01-01T00",
      }),
    ).toBeNull();
  });

  it("returns null when source_ref is undefined", () => {
    const config = makeConfig({
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    expect(
      checkRepoOwnership({
        config,
        agentName: "claude-agent-orchestrator",
        sourceRef: undefined,
      }),
    ).toBeNull();
  });

  it("returns null when agent owns the target repo", () => {
    const config = makeConfig({
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    expect(
      checkRepoOwnership({
        config,
        agentName: "claude-agent-orchestrator",
        sourceRef: "rapartlu/agent-orchestrator#1614",
      }),
    ).toBeNull();
  });

  it("returns block descriptor when agent doesn't own the target repo and an owner exists", () => {
    const config = makeConfig({
      "claude-orchestrator-dashboard": { github: "rapartlu/agent-dashboard" },
      "claude-orchestrator-reviewer": { github: "rapartlu/agent-reviewer" },
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkRepoOwnership({
      config,
      agentName: "claude-orchestrator-dashboard",
      sourceRef: "rapartlu/agent-reviewer#100",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-dashboard");
    expect(result!.targetRepo).toBe("rapartlu/agent-reviewer");
  });

  it("redirects to the correct owner agent when one is registered", () => {
    const config = makeConfig({
      "claude-orchestrator-dashboard": { github: "rapartlu/agent-dashboard" },
      "claude-orchestrator-reviewer": { github: "rapartlu/agent-reviewer" },
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    const result = checkRepoOwnership({
      config,
      agentName: "claude-orchestrator-dashboard",
      sourceRef: "rapartlu/agent-reviewer#100",
    });
    expect(result!.toAgent).toBe("claude-orchestrator-reviewer");
    expect(result!.redirectReason).toContain("rapartlu/agent-reviewer");
    expect(result!.redirectReason).toContain("claude-orchestrator-reviewer");
  });

  it("returns null (allow-fallback) when no owner agent is registered for the target repo", () => {
    const config = makeConfig({
      "claude-orchestrator-dashboard": { github: "rapartlu/agent-dashboard" },
    });
    // No agent owns "rapartlu/unknown-repo"
    const result = checkRepoOwnership({
      config,
      agentName: "claude-orchestrator-dashboard",
      sourceRef: "rapartlu/unknown-repo#42",
    });
    expect(result).toBeNull();
  });

  it("blocks the exact failure case from issue #1614: dashboard agent dispatched to agent-reviewer repo", () => {
    const config = makeConfig({
      "claude-orchestrator-dashboard": { github: "rapartlu/agent-dashboard" },
      "claude-orchestrator-reviewer": { github: "rapartlu/agent-reviewer" },
      "claude-agent-orchestrator": { github: "rapartlu/agent-orchestrator" },
    });
    // Mirrors task 01KR9R1J: dashboard agent dispatched to agent-reviewer repo
    const result = checkRepoOwnership({
      config,
      agentName: "claude-orchestrator-dashboard",
      sourceRef: "rapartlu/agent-orchestrator#1599",
    });
    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-orchestrator-dashboard");
    expect(result!.toAgent).toBe("claude-agent-orchestrator");
    expect(result!.targetRepo).toBe("rapartlu/agent-orchestrator");
  });
});
