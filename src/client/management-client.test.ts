import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ManagementClient, ManagementError } from "./management-client.js";
import { createServer, type Server } from "node:http";

// Spin up a tiny mock proxy for testing
let server: Server;
let port: number;

const mockAgents = [
  { name: "agent-a", project: "/tmp/a", port: 3460, permissions: "auto", tunnel: false, session: "fresh", packages: [], status: "running" },
  { name: "agent-b", project: "/tmp/b", port: 3461, permissions: "auto", tunnel: false, session: "continue", packages: [], status: "stopped" },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);
    res.setHeader("Content-Type", "application/json");

    // Health
    if (req.method === "GET" && url.pathname === "/health") {
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // List agents
    if (req.method === "GET" && url.pathname === "/v1/agents") {
      res.end(JSON.stringify(mockAgents));
      return;
    }

    // Get agent
    const getMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (req.method === "GET" && getMatch) {
      const agent = mockAgents.find((a) => a.name === getMatch[1]);
      if (agent) {
        res.end(JSON.stringify(agent));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { message: "Not found" } }));
      }
      return;
    }

    // Create agent
    if (req.method === "POST" && url.pathname === "/v1/agents") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const data = JSON.parse(body);
        res.statusCode = 201;
        res.end(JSON.stringify({ name: data.name, port: data.port, project: data.project, status: "starting" }));
      });
      return;
    }

    // Start agent
    const startMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/start$/);
    if (req.method === "POST" && startMatch) {
      res.end(JSON.stringify({ name: startMatch[1], status: "starting" }));
      return;
    }

    // Stop agent
    const stopMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/stop$/);
    if (req.method === "POST" && stopMatch) {
      res.end(JSON.stringify({ name: stopMatch[1], status: "stopped" }));
      return;
    }

    // Delete agent
    const deleteMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      res.end(JSON.stringify({ name: deleteMatch[1], status: "stopped" }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: "Unknown route" } }));
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

function createClient() {
  return new ManagementClient({ url: `http://localhost:${port}`, timeout_ms: 5000 });
}

describe("ManagementClient", () => {
  it("checks if proxy is reachable", async () => {
    const client = createClient();
    expect(await client.isReachable()).toBe(true);
  });

  it("reports unreachable for bad URL", async () => {
    const client = new ManagementClient({ url: "http://localhost:1", timeout_ms: 1000 });
    expect(await client.isReachable()).toBe(false);
  });

  it("lists agents", async () => {
    const client = createClient();
    const agents = await client.listAgents();
    expect(agents).toHaveLength(2);
    expect(agents[0].name).toBe("agent-a");
    expect(agents[0].status).toBe("running");
    expect(agents[1].status).toBe("stopped");
  });

  it("gets a specific agent", async () => {
    const client = createClient();
    const agent = await client.getAgent("agent-a");
    expect(agent.name).toBe("agent-a");
    expect(agent.port).toBe(3460);
  });

  it("throws ManagementError for unknown agent", async () => {
    const client = createClient();
    await expect(client.getAgent("nonexistent")).rejects.toThrow(ManagementError);
  });

  it("creates an agent", async () => {
    const client = createClient();
    const result = await client.createAgent({
      name: "new-agent",
      project: "/tmp/new",
      port: 3470,
    });
    expect(result.name).toBe("new-agent");
    expect(result.status).toBe("starting");
  });

  it("starts an agent", async () => {
    const client = createClient();
    const result = await client.startAgent("agent-b");
    expect(result.name).toBe("agent-b");
    expect(result.status).toBe("starting");
  });

  it("stops an agent", async () => {
    const client = createClient();
    const result = await client.stopAgent("agent-a");
    expect(result.name).toBe("agent-a");
    expect(result.status).toBe("stopped");
  });

  it("deletes an agent", async () => {
    const client = createClient();
    const result = await client.deleteAgent("agent-a");
    expect(result.name).toBe("agent-a");
  });
});
