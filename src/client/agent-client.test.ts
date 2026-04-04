import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentClient, buildAgentIdentityPrompt } from "./agent-client.js";
import { createServer, type Server } from "node:http";
import type { OrchestratorConfig } from "../config/schema.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    // Return any HTTP response — the ping just needs the port to be alive
    res.writeHead(200);
    res.end("ok");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function makeConfig(agentPort: number): OrchestratorConfig {
  return {
    proxy: { url: `http://localhost:${agentPort}`, manager_url: "http://localhost:3400", timeout_ms: 5000 },
    base_dir: "/tmp",
    orchestrator_dir: "/tmp",
    agents: {
      "test-agent": {
        dir: "test-agent",
        description: "Test",
        capabilities: [],
        owns_topics: [],
        docker: { port: agentPort },
      },
    },
  };
}

describe("AgentClient.ping", () => {
  it("returns true when agent port is reachable", async () => {
    const client = new AgentClient(makeConfig(port));
    const alive = await client.ping("test-agent", 3000);
    expect(alive).toBe(true);
  });

  it("returns false when agent port is unreachable", async () => {
    // Port 1 should be refused immediately
    const client = new AgentClient(makeConfig(1));
    const alive = await client.ping("test-agent", 3000);
    expect(alive).toBe(false);
  });

  it("returns false for an agent with no docker port configured", async () => {
    const config: OrchestratorConfig = {
      proxy: { url: "http://localhost:3400", manager_url: "http://localhost:3400", timeout_ms: 5000 },
      base_dir: "/tmp",
      orchestrator_dir: "/tmp",
      agents: {
        "no-port-agent": {
          dir: "no-port-agent",
          description: "No port",
          capabilities: [],
          owns_topics: [],
          // no docker config
        },
      },
    };
    const client = new AgentClient(config);
    const alive = await client.ping("no-port-agent", 3000);
    expect(alive).toBe(false);
  });
});

describe("buildAgentIdentityPrompt", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the agent name", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt).toContain(`"${agentName}"`);
  });

  it("includes the github repo", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt).toContain(githubRepo);
  });

  it("includes backlog triage instructions (close duplicates)", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt.toLowerCase()).toContain("duplicate");
  });

  it("includes backlog triage instructions (close stale issues)", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt.toLowerCase()).toContain("stale");
  });

  it("includes ROADMAP.md maintenance instruction", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt).toContain("ROADMAP.md");
  });

  it("includes PR/issue hygiene instructions (Closes #N)", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt).toContain("Closes #N");
  });

  it("includes git workflow instructions", () => {
    const prompt = buildAgentIdentityPrompt(agentName, githubRepo);
    expect(prompt).toContain("git checkout main");
    expect(prompt).toContain("Never commit directly to main");
  });

  it("works with an empty github repo", () => {
    const prompt = buildAgentIdentityPrompt("anon-agent", "");
    expect(prompt).toContain(`"anon-agent"`);
    // Should not crash or include misleading repo references
    expect(prompt).not.toContain("Your GitHub repo is .");
  });
});
