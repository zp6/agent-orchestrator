import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentClient, buildAgentIdentityPrompt, buildAgentSystemPrompt, buildResearchPrompt } from "./agent-client.js";
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

describe("buildAgentSystemPrompt", () => {
  const agentName = "my-agent";
  const githubRepo = "owner/my-agent";

  it("includes the agent name", () => {
    const prompt = buildAgentSystemPrompt(agentName, githubRepo);
    expect(prompt).toContain(`"${agentName}"`);
  });

  it("includes the github repo", () => {
    const prompt = buildAgentSystemPrompt(agentName, githubRepo);
    expect(prompt).toContain(githubRepo);
  });

  it("includes PR and issue hygiene instructions (Closes #N)", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Closes #N");
    expect(prompt).toContain("gh issue list --repo owner/repo --state open");
  });

  it("includes backlog triage instructions (close duplicates)", () => {
    const prompt = buildAgentSystemPrompt(agentName, githubRepo);
    expect(prompt.toLowerCase()).toContain("duplicate");
  });

  it("includes backlog triage instructions (close stale issues)", () => {
    const prompt = buildAgentSystemPrompt(agentName, githubRepo);
    expect(prompt.toLowerCase()).toContain("stale");
  });

  it("includes ROADMAP.md maintenance instruction", () => {
    const prompt = buildAgentSystemPrompt(agentName, githubRepo);
    expect(prompt).toContain("ROADMAP.md");
  });

  it("includes backlog triage and roadmap section header", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Backlog triage and roadmap");
    expect(prompt).toContain("Close stale/duplicate issues");
    expect(prompt).toContain("housekeeping");
  });

  it("includes self-improvement instructions", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Product features");
    expect(prompt).toContain("User experience");
    expect(prompt).toContain("Content depth");
  });

  it("works with an empty github repo", () => {
    const prompt = buildAgentSystemPrompt("anon-agent", "");
    expect(prompt).toContain(`"anon-agent"`);
    expect(prompt).not.toContain("Your GitHub repo is .");
  });
});

describe("buildAgentSystemPrompt", () => {
  it("includes agent name and repo", () => {
    const prompt = buildAgentSystemPrompt("cheese-hater", "rapartlu/cheese-hater");
    expect(prompt).toContain('"cheese-hater"');
    expect(prompt).toContain("rapartlu/cheese-hater");
  });

  it("includes PR and issue hygiene instructions", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Closes #N");
    expect(prompt).toContain("gh issue list --repo owner/repo --state open");
  });

  it("includes backlog triage and roadmap instructions", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Backlog triage and roadmap");
    expect(prompt).toContain("ROADMAP.md");
  });

  it("includes self-improvement instructions", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Product features");
    expect(prompt).toContain("User experience");
  });

  it("handles missing github repo", () => {
    const prompt = buildAgentSystemPrompt("local-agent", "");
    expect(prompt).toContain('"local-agent"');
    expect(prompt).not.toContain("Your GitHub repo is .");
  });

  it("is identical to buildAgentIdentityPrompt (alias)", () => {
    const prompt1 = buildAgentSystemPrompt("test-agent", "owner/repo");
    const prompt2 = buildAgentIdentityPrompt("test-agent", "owner/repo");
    expect(prompt1).toBe(prompt2);
  });
});

describe("buildResearchPrompt", () => {
  it("includes agent name and research mode", () => {
    const prompt = buildResearchPrompt("cheese-hater", "rapartlu/cheese-hater");
    expect(prompt).toContain('"cheese-hater"');
    expect(prompt).toContain("RESEARCH MODE");
  });

  it("includes research structure guidance", () => {
    const prompt = buildResearchPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Summary");
    expect(prompt).toContain("Analysis");
    expect(prompt).toContain("Alternatives");
    expect(prompt).toContain("Risks");
    expect(prompt).toContain("Recommendation");
  });

  it("forbids code changes and PR creation", () => {
    const prompt = buildResearchPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("Do NOT create branches, PRs, issues");
    expect(prompt).toContain("Do NOT suggest self-improvement issues");
  });

  it("does NOT include implementation instructions", () => {
    const prompt = buildResearchPrompt("test-agent", "owner/repo");
    expect(prompt).not.toContain("Closes #N");
    expect(prompt).not.toContain("ROADMAP.md");
    expect(prompt).not.toContain("gh pr create");
  });
});
