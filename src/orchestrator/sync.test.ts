import { describe, it, expect } from "vitest";
import { planSync } from "./sync.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { ProxyAgentStatus } from "../client/management-client.js";

const baseConfig: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 300000 },
  orchestrator_dir: "/projects/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": {
      dir: "agent-a",
      description: "Agent A",
      capabilities: ["test"],
      owns_topics: ["a"],
      docker: { port: 3460, permissions: "auto" },
    },
    "agent-b": {
      dir: "agent-b",
      description: "Agent B",
      capabilities: ["test"],
      owns_topics: ["b"],
      docker: { port: 3461, permissions: "auto" },
    },
  },
};

describe("planSync", () => {
  it("creates agents missing from proxy", () => {
    const actions = planSync(baseConfig, []);
    expect(actions).toHaveLength(2);
    expect(actions.every((a) => a.type === "create")).toBe(true);
  });

  it("skips agents that are running", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/projects/agent-a", port: 3460, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
      { name: "agent-b", project: "/projects/agent-b", port: 3461, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(baseConfig, proxyAgents);
    expect(actions.every((a) => a.type === "skip")).toBe(true);
  });

  it("starts stopped agents", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/projects/agent-a", port: 3460, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
      { name: "agent-b", project: "/projects/agent-b", port: 3461, permissions: "auto", status: "exited", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(baseConfig, proxyAgents);
    const startActions = actions.filter((a) => a.type === "start");
    expect(startActions).toHaveLength(1);
    expect(startActions[0].agentName).toBe("agent-b");
  });

  it("flags unknown proxy agents for removal", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/projects/agent-a", port: 3460, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
      { name: "agent-b", project: "/projects/agent-b", port: 3461, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
      { name: "rogue-agent", project: "/tmp/rogue", port: 9999, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(baseConfig, proxyAgents);
    const removeActions = actions.filter((a) => a.type === "remove");
    expect(removeActions).toHaveLength(1);
    expect(removeActions[0].agentName).toBe("rogue-agent");
  });

  it("detects config drift on project path", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/wrong/path", port: 3460, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(baseConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
    expect(updateActions[0].agentName).toBe("agent-a");
  });

  it("detects config drift on port", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/projects/agent-a", port: 9999, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(baseConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
  });

  it("handles mix of create, start, skip, and remove", () => {
    const configWith3: OrchestratorConfig = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        "agent-c": {
          dir: "agent-c",
          description: "Agent C",
          capabilities: ["test"],
          owns_topics: ["c"],
          docker: { port: 3462 },
        },
      },
    };
    const proxyAgents: ProxyAgentStatus[] = [
      { name: "agent-a", project: "/projects/agent-a", port: 3460, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
      { name: "agent-b", project: "/projects/agent-b", port: 3461, permissions: "auto", status: "stopped", tunnel: false, session: "fresh", packages: [] },
      { name: "old-agent", project: "/tmp/old", port: 8888, permissions: "auto", status: "running", tunnel: false, session: "fresh", packages: [] },
    ];
    const actions = planSync(configWith3, proxyAgents);
    const types = actions.map((a) => `${a.agentName}:${a.type}`);
    expect(types).toContain("agent-a:skip");
    expect(types).toContain("agent-b:start");
    expect(types).toContain("agent-c:create");
    expect(types).toContain("old-agent:remove");
  });
});
