import { describe, it, expect, vi, beforeEach } from "vitest";
import { Deployer, parseRepoSlug } from "./deployer.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockUpdateAgent = vi.fn().mockResolvedValue({ name: "agent-a", status: "restarting" });
const mockStopAgent = vi.fn().mockResolvedValue(undefined);
const mockStartAgent = vi.fn().mockResolvedValue(undefined);

vi.mock("../client/management-client.js", () => ({
  ManagementClient: class {
    updateAgent = mockUpdateAgent;
    stopAgent = mockStopAgent;
    startAgent = mockStartAgent;
    isReachable = vi.fn().mockResolvedValue(true);
  },
}));

const mockExecSync = vi.fn().mockReturnValue("abc123\n");
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockImplementation((path: string) => {
      // Simulate no marker file for local agents, no stored SHA for repo agents
      throw new Error("ENOENT");
    }),
  };
});

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "agent-a": {
      dir: "agent-a",
      description: "A",
      capabilities: ["test"],
      owns_topics: ["a"],
      docker: { port: 3460 },
    },
    "repo-agent": {
      dir: "repo-agent",
      repo: "owner/my-repo",
      description: "Repo-based agent",
      capabilities: ["test"],
      owns_topics: ["repo"],
      docker: { port: 3461 },
    },
    "no-docker": {
      dir: "no-docker",
      description: "No docker",
      capabilities: ["test"],
      owns_topics: ["b"],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: execSync returns a git SHA for local agents and a remote SHA for repo agents
  mockExecSync.mockReturnValue("abc123\n");
});

describe("Deployer", () => {
  it("redeploys a specific agent", async () => {
    const deployer = new Deployer(config);
    const result = await deployer.redeploy("agent-a");
    expect(result.action).toBe("redeployed");
    expect(mockUpdateAgent).toHaveBeenCalled();
  });

  it("returns error for unknown agent", async () => {
    const deployer = new Deployer(config);
    const result = await deployer.redeploy("nonexistent");
    expect(result.action).toBe("error");
    expect(result.detail).toContain("Unknown agent");
  });

  it("detects stale agents without deploy marker", () => {
    const deployer = new Deployer(config);
    const stale = deployer.getStaleAgents();
    // agent-a has docker port and git returns a sha but no marker = stale
    expect(stale).toContain("agent-a");
    // no-docker has no docker port = skipped
    expect(stale).not.toContain("no-docker");
  });

  it("redeployStale redeploys all stale agents", async () => {
    const deployer = new Deployer(config);
    const results = await deployer.redeployStale();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].action).toBe("redeployed");
  });
});

describe("Deployer — repo-based agents", () => {
  it("getStaleRepoAgents detects agents with new remote commits", () => {
    // execSync returns "remote-sha\n" for gh api call, and readFileSync throws (no stored SHA)
    mockExecSync.mockReturnValue("remote-sha-001\n");
    const deployer = new Deployer(config);
    const stale = deployer.getStaleRepoAgents();
    expect(stale).toContain("repo-agent");
  });

  it("getStaleRepoAgents skips agents without a repo", () => {
    mockExecSync.mockReturnValue("remote-sha-001\n");
    const deployer = new Deployer(config);
    const stale = deployer.getStaleRepoAgents();
    expect(stale).not.toContain("agent-a");
    expect(stale).not.toContain("no-docker");
  });

  it("getStaleRepoAgents skips agents not in registeredAgents set", () => {
    mockExecSync.mockReturnValue("remote-sha-001\n");
    const deployer = new Deployer(config);
    const registered = new Set(["agent-a"]); // repo-agent not in set
    const stale = deployer.getStaleRepoAgents(registered);
    expect(stale).not.toContain("repo-agent");
  });

  it("restartStaleRepoAgents restarts agents with new commits", async () => {
    mockExecSync.mockReturnValue("remote-sha-001\n");
    const deployer = new Deployer(config);
    const results = await deployer.restartStaleRepoAgents();
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].agentName).toBe("repo-agent");
    expect(results[0].action).toBe("redeployed");
    expect(mockStopAgent).toHaveBeenCalled();
    expect(mockStartAgent).toHaveBeenCalled();
  });

  it("redeployStale includes repo agent restart results", async () => {
    mockExecSync.mockReturnValue("new-sha-xyz\n");
    const deployer = new Deployer(config);
    const results = await deployer.redeployStale();
    const agentNames = results.map((r) => r.agentName);
    expect(agentNames).toContain("repo-agent");
  });

  it("getStaleRepoAgents treats agent as up-to-date when stored SHA matches remote", async () => {
    // Mock readFileSync to return the same SHA as the remote
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValueOnce("same-sha\n");
    mockExecSync.mockReturnValue("same-sha\n");
    const deployer = new Deployer(config);
    const stale = deployer.getStaleRepoAgents();
    expect(stale).not.toContain("repo-agent");
  });
});

describe("parseRepoSlug", () => {
  it("parses HTTPS GitHub URL", () => {
    expect(parseRepoSlug("https://github.com/owner/my-repo.git")).toBe("owner/my-repo");
    expect(parseRepoSlug("https://github.com/owner/my-repo")).toBe("owner/my-repo");
  });

  it("parses SSH GitHub URL", () => {
    expect(parseRepoSlug("git@github.com:owner/my-repo.git")).toBe("owner/my-repo");
    expect(parseRepoSlug("git@github.com:owner/my-repo")).toBe("owner/my-repo");
  });

  it("parses owner/repo shorthand", () => {
    expect(parseRepoSlug("owner/my-repo")).toBe("owner/my-repo");
    expect(parseRepoSlug("owner/my-repo.git")).toBe("owner/my-repo");
  });

  it("returns null for unrecognized formats", () => {
    expect(parseRepoSlug("not-a-repo")).toBeNull();
    expect(parseRepoSlug("")).toBeNull();
  });
});
