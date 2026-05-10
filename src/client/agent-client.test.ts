import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { AgentClient, buildAgentIdentityPrompt, buildAgentSystemPrompt, buildMonologueEntry, buildResearchPrompt } from "./agent-client.js";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";

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

  it("uses GET for the proxy liveness check", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      const client = new AgentClient(makeConfig(port));
      await client.ping("test-agent", 3000);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("GET");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AgentClient.pingWithDetail", () => {
  it("returns alive:true with no errorType on success", async () => {
    const client = new AgentClient(makeConfig(port));
    const result = await client.pingWithDetail("test-agent", 3000);
    expect(result.alive).toBe(true);
    expect(result.errorType).toBeUndefined();
  });

  it("returns connection_refused for top-level ECONNREFUSED (Node.js < 22 style)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { name: "Error" }),
    );
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new AgentClient(makeConfig(1));
      const result = await client.pingWithDetail("test-agent", 3000);
      expect(result.alive).toBe(false);
      expect(result.errorType).toBe("connection_refused");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns connection_refused when ECONNREFUSED is in err.cause.message (Node.js 22 style)", async () => {
    // On Node.js 22, fetch wraps: err.message === 'fetch failed',
    // err.cause.message === 'connect ECONNREFUSED 127.0.0.1:PORT'
    const cause = new Error("connect ECONNREFUSED 127.0.0.1:1");
    const fetchError = Object.assign(new Error("fetch failed"), { cause });
    const fetchMock = vi.fn().mockRejectedValue(fetchError);
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new AgentClient(makeConfig(1));
      const result = await client.pingWithDetail("test-agent", 3000);
      expect(result.alive).toBe(false);
      expect(result.errorType).toBe("connection_refused");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns timeout for AbortError", async () => {
    const abortErr = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new AgentClient(makeConfig(port));
      const result = await client.pingWithDetail("test-agent", 3000);
      expect(result.alive).toBe(false);
      expect(result.errorType).toBe("timeout");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns other for unrecognized errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("some weird TLS error"));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const client = new AgentClient(makeConfig(port));
      const result = await client.pingWithDetail("test-agent", 3000);
      expect(result.alive).toBe(false);
      expect(result.errorType).toBe("other");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("returns no_port for agents with no docker.port configured", async () => {
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
        },
      },
    };
    const client = new AgentClient(config);
    const result = await client.pingWithDetail("no-port-agent", 3000);
    expect(result.alive).toBe(false);
    expect(result.errorType).toBe("no_port");
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

  it("includes pre-PR checklist with all four validation steps", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    // Step 1: duplicate PR check
    expect(prompt).toContain("gh pr list");
    // Step 2: rebase check
    expect(prompt).toContain("git rebase origin/main");
    // Step 3: merge conflict check
    expect(prompt).toContain("git diff --check");
    // Step 4: issue ref check
    expect(prompt).toContain("Closes #N");
  });

  it("includes orch preflight as the fastest pre-flight check method", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("orch preflight");
    expect(prompt).toContain("--repo owner/repo");
  });

  it("includes duplicate PR check instruction", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toMatch(/duplicate pr/i);
    expect(prompt).toContain("gh pr list");
  });

  it("includes merge conflict check instruction", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toMatch(/merge conflict/i);
    expect(prompt).toContain("git diff --check");
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

  it("includes monologue logging guidance", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("MONOLOGUE LOGGING");
    expect(prompt).toContain("decision points and major transitions");
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

  it("includes all four pre-PR checklist steps", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("gh pr list");        // duplicate PR check
    expect(prompt).toContain("git rebase origin/main"); // rebase check
    expect(prompt).toContain("git diff --check");  // merge conflict check
    expect(prompt).toContain("Closes #N");         // issue ref check
  });

  it("includes orch preflight as the recommended pre-flight command", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("orch preflight");
    expect(prompt).toContain("--repo owner/repo");
    expect(prompt).toContain("--branch");
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

  it("instructs agents to validate gh auth before any git push", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("gh auth status");
    expect(prompt).toContain("git push");
  });

  it("instructs agents to treat push+PR as an atomic retryable unit", () => {
    const prompt = buildAgentSystemPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("atomic");
    expect(prompt).toContain("retry");
    expect(prompt).toContain("gh pr create");
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
    expect(prompt).toContain("Clarification note");
    expect(prompt).toContain("what you interpreted it to mean");
    expect(prompt).toContain("when the request uses an ambiguous referent");
    expect(prompt).toContain("Telegram handler");
    expect(prompt).toContain("Summary");
    expect(prompt).toContain("Analysis");
    expect(prompt).toContain("Alternatives");
    expect(prompt).toContain("Risks");
    expect(prompt).toContain("Recommendation");
  });

  it("includes monologue logging guidance", () => {
    const prompt = buildResearchPrompt("test-agent", "owner/repo");
    expect(prompt).toContain("MONOLOGUE LOGGING");
    expect(prompt).toContain("1-4 sentences");
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

describe("monologue helper", () => {
  it("buildMonologueEntry returns a normalized payload", () => {
    expect(buildMonologueEntry("agent", "task", "reflection", "I learned something.")).toEqual({
      agent_name: "agent",
      task_id: "task",
      kind: "reflection",
      prose: "I learned something.",
    });
  });

  it("buildMonologueEntry omits task_id when one is not provided", () => {
    expect(buildMonologueEntry("agent", null, "observation", "Checking in.")).toEqual({
      agent_name: "agent",
      kind: "observation",
      prose: "Checking in.",
    });
  });

  it("AgentClient.emitMonologue writes through the store", () => {
    const dbPath = join(tmpdir(), `orch-test-${randomUUID()}.db`);
    const store = new StateStore(dbPath);

    try {
      const client = new AgentClient(makeConfig(port), store);
      const task = store.createTask({ title: "Monologue helper task", source: "manual" });
      client.emitMonologue("test-agent", task.id, "decision", "I have enough context now, so I am taking the direct path.");

      const entries = store.getMonologue({ task_id: task.id });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        agent_name: "test-agent",
        task_id: task.id,
        kind: "decision",
        prose: "I have enough context now, so I am taking the direct path.",
      });
    } finally {
      store.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(dbPath + suffix); } catch {}
      }
    }
  });
});

// ── Directive injection tests ─────────────────────────────────────────────────

describe("AgentClient directive injection", () => {
  // A minimal mock store that implements only the listDirectives() method.
  function makeStoreWithDirectives(directives: Array<{ id: number; text: string; created_at: string }>) {
    return {
      listDirectives: () => directives,
    } as unknown as import("../state/store.js").StateStore;
  }

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

  it("buildDirectivesSuffix is empty when no store is provided", () => {
    const client = new AgentClient(makeConfig(9999));
    // Access the private method via type cast for testing
    const suffix = (client as unknown as { buildDirectivesSuffix(): string }).buildDirectivesSuffix();
    expect(suffix).toBe("");
  });

  it("buildDirectivesSuffix is empty when store has no directives", () => {
    const store = makeStoreWithDirectives([]);
    const client = new AgentClient(makeConfig(9999), store);
    const suffix = (client as unknown as { buildDirectivesSuffix(): string }).buildDirectivesSuffix();
    expect(suffix).toBe("");
  });

  it("buildDirectivesSuffix includes all stored directives", () => {
    const store = makeStoreWithDirectives([
      { id: 1, text: "always use plain text", created_at: "2026-01-01T00:00:00.000Z" },
      { id: 2, text: "never use backslashes", created_at: "2026-01-02T00:00:00.000Z" },
    ]);
    const client = new AgentClient(makeConfig(9999), store);
    const suffix = (client as unknown as { buildDirectivesSuffix(): string }).buildDirectivesSuffix();
    expect(suffix).toContain("PERSISTENT BEHAVIORAL DIRECTIVES");
    expect(suffix).toContain("always use plain text");
    expect(suffix).toContain("never use backslashes");
  });
});
