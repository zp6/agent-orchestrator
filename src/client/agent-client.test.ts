import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentClient } from "./agent-client.js";
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
