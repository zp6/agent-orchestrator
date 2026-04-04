import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { pingAllAgents } from "./agents.js";
import type { OrchestratorConfig } from "../../config/schema.js";

let server: Server;
let livePort: number;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      livePort = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

function makeConfig(agents: Record<string, { port?: number }>): OrchestratorConfig {
  return {
    proxy: {
      url: "http://localhost:3400",
      manager_url: "http://localhost:3400",
      timeout_ms: 5000,
    },
    base_dir: "/tmp",
    orchestrator_dir: "/tmp",
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, { port }]) => [
        name,
        {
          dir: name,
          description: `Agent ${name}`,
          capabilities: [],
          owns_topics: [],
          ...(port !== undefined ? { docker: { port } } : {}),
        },
      ]),
    ),
  };
}

describe("pingAllAgents", () => {
  it("returns alive with latency for a responding agent", async () => {
    const config = makeConfig({ "live-agent": { port: livePort } });
    const result = await pingAllAgents(config, ["live-agent"], 3000);
    const health = result.get("live-agent");
    expect(health?.status).toBe("alive");
    expect(typeof health?.latencyMs).toBe("number");
    expect(health!.latencyMs!).toBeGreaterThanOrEqual(0);
  });

  it("returns unreachable with null latency for a non-responding port", async () => {
    // Port 1 is always refused
    const config = makeConfig({ "dead-agent": { port: 1 } });
    const result = await pingAllAgents(config, ["dead-agent"], 3000);
    const health = result.get("dead-agent");
    expect(health?.status).toBe("unreachable");
    expect(health?.latencyMs).toBeNull();
  });

  it("returns no-port when agent has no docker port configured", async () => {
    const config = makeConfig({ "no-port-agent": {} });
    const result = await pingAllAgents(config, ["no-port-agent"], 3000);
    const health = result.get("no-port-agent");
    expect(health?.status).toBe("no-port");
    expect(health?.latencyMs).toBeNull();
  });

  it("handles multiple agents concurrently with mixed results", async () => {
    const config = makeConfig({
      "live-agent": { port: livePort },
      "dead-agent": { port: 1 },
      "no-port-agent": {},
    });
    const result = await pingAllAgents(
      config,
      ["live-agent", "dead-agent", "no-port-agent"],
      3000,
    );
    expect(result.get("live-agent")?.status).toBe("alive");
    expect(result.get("live-agent")?.latencyMs).not.toBeNull();
    expect(result.get("dead-agent")?.status).toBe("unreachable");
    expect(result.get("dead-agent")?.latencyMs).toBeNull();
    expect(result.get("no-port-agent")?.status).toBe("no-port");
    expect(result.get("no-port-agent")?.latencyMs).toBeNull();
  });

  it("returns an empty map for an empty agent list", async () => {
    const config = makeConfig({});
    const result = await pingAllAgents(config, [], 3000);
    expect(result.size).toBe(0);
  });
});
