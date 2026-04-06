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

// ---------------------------------------------------------------------------
// toProxyConfig — repo / branch forwarding (issue: repo field was dropped)
// ---------------------------------------------------------------------------
import { toProxyConfig } from "./sync.js";

describe("toProxyConfig — repo field forwarding", () => {
  const minimalConfig: OrchestratorConfig = {
    proxy: { url: "http://localhost:3457", timeout_ms: 300000 },
    orchestrator_dir: "/projects/orchestrator",
    base_dir: "/projects",
    agents: {},
  };

  it("includes repo when set on the agent", () => {
    const agent = {
      dir: "my-agent",
      repo: "git@github.com:org/my-agent.git",
      description: "x",
      capabilities: [],
      owns_topics: [],
      docker: { port: 3460 },
    };
    const result = toProxyConfig(minimalConfig, "my-agent", agent);
    expect(result.repo).toBe("git@github.com:org/my-agent.git");
  });

  it("includes branch (from deploy_branch) when set on the agent", () => {
    const agent = {
      dir: "my-agent",
      repo: "git@github.com:org/my-agent.git",
      deploy_branch: "develop",
      description: "x",
      capabilities: [],
      owns_topics: [],
      docker: { port: 3460 },
    };
    const result = toProxyConfig(minimalConfig, "my-agent", agent);
    expect(result.branch).toBe("develop");
  });

  it("omits repo when not set on the agent", () => {
    const agent = {
      dir: "my-agent",
      description: "x",
      capabilities: [],
      owns_topics: [],
      docker: { port: 3460 },
    };
    const result = toProxyConfig(minimalConfig, "my-agent", agent);
    expect(result.repo).toBeUndefined();
  });

  it("omits branch when deploy_branch is not set", () => {
    const agent = {
      dir: "my-agent",
      repo: "git@github.com:org/my-agent.git",
      description: "x",
      capabilities: [],
      owns_topics: [],
      docker: { port: 3460 },
    };
    const result = toProxyConfig(minimalConfig, "my-agent", agent);
    expect(result.branch).toBeUndefined();
  });
});

describe("planSync — repo/branch drift detection", () => {
  const repoConfig: OrchestratorConfig = {
    proxy: { url: "http://localhost:3457", timeout_ms: 300000 },
    orchestrator_dir: "/projects/orchestrator",
    base_dir: "/projects",
    agents: {
      "repo-agent": {
        dir: "repo-agent",
        repo: "git@github.com:org/repo-agent.git",
        deploy_branch: "main",
        description: "Agent with repo",
        capabilities: [],
        owns_topics: [],
        docker: { port: 3460, permissions: "auto" },
      },
    },
  };

  it("detects drift when proxy has no repo but config does", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "repo-agent",
        project: "/projects/repo-agent",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        // no repo field — simulates a proxy that didn't receive repo during create
      },
    ];
    const actions = planSync(repoConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
    expect(updateActions[0].agentName).toBe("repo-agent");
  });

  it("detects drift when proxy has a different repo URL", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "repo-agent",
        project: "/projects/repo-agent",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        repo: "git@github.com:org/old-repo.git",
        branch: "main",
      },
    ];
    const actions = planSync(repoConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
  });

  it("skips when repo and branch match the proxy", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "repo-agent",
        project: "/projects/repo-agent",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        repo: "git@github.com:org/repo-agent.git",
        branch: "main",
      },
    ];
    const actions = planSync(repoConfig, proxyAgents);
    const skipActions = actions.filter((a) => a.type === "skip");
    expect(skipActions).toHaveLength(1);
  });
});

describe("planSync — GH_TOKEN drift detection", () => {
  const tokenConfig: OrchestratorConfig = {
    proxy: { url: "http://localhost:3457", timeout_ms: 300000, gh_token: "ghp_new_token_123" },
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
    },
  };

  it("detects drift when proxy agent has no ghToken but config does", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "agent-a",
        project: "/projects/agent-a",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        // no ghToken — simulates container recreated without token
      },
    ];
    const actions = planSync(tokenConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
    expect(updateActions[0].reason).toBe("GH_TOKEN differs from desired state");
  });

  it("detects drift when proxy agent has a stale ghToken", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "agent-a",
        project: "/projects/agent-a",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        ghToken: "ghp_old_token_456",
      },
    ];
    const actions = planSync(tokenConfig, proxyAgents);
    const updateActions = actions.filter((a) => a.type === "update");
    expect(updateActions).toHaveLength(1);
    expect(updateActions[0].reason).toBe("GH_TOKEN differs from desired state");
  });

  it("skips when proxy agent ghToken matches config", () => {
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "agent-a",
        project: "/projects/agent-a",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        ghToken: "ghp_new_token_123",
      },
    ];
    const actions = planSync(tokenConfig, proxyAgents);
    const skipActions = actions.filter((a) => a.type === "skip");
    expect(skipActions).toHaveLength(1);
  });

  it("skips when config has no ghToken (nothing to enforce)", () => {
    const noTokenConfig: OrchestratorConfig = {
      ...tokenConfig,
      proxy: { ...tokenConfig.proxy, gh_token: undefined },
    };
    const proxyAgents: ProxyAgentStatus[] = [
      {
        name: "agent-a",
        project: "/projects/agent-a",
        port: 3460,
        permissions: "auto",
        status: "running",
        tunnel: false,
        session: "fresh",
        packages: [],
        // proxy has no token either — should be fine
      },
    ];
    const actions = planSync(noTokenConfig, proxyAgents);
    const skipActions = actions.filter((a) => a.type === "skip");
    expect(skipActions).toHaveLength(1);
  });
});
