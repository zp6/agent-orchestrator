import { describe, it, expect, vi, beforeEach } from "vitest";
import { Deployer } from "./deployer.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockUpdateAgent = vi.fn().mockResolvedValue({ name: "agent-a", status: "restarting" });

vi.mock("../client/management-client.js", () => ({
  ManagementClient: class {
    updateAgent = mockUpdateAgent;
    isReachable = vi.fn().mockResolvedValue(true);
  },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("abc123\n"),
}));

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
