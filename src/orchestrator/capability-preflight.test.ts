/**
 * Tests for the runtime capability pre-flight system (issue #837).
 *
 * Covers:
 *   1. callCapabilityCheck — HTTP client behaviour (accept, reject, 404, timeout, error)
 *   2. runRemoteCapabilityCheck — orchestrator-side integration
 *   3. Extended isImplementationTask keyword detection (routes, panel, follow-up, etc.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callCapabilityCheck } from "../client/capability-check-client.js";
import { isImplementationTask, runRemoteCapabilityCheck } from "./capability-enforcer.js";
import type { OrchestratorConfig } from "../config/schema.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeConfig(
  agents: Record<string, { github?: string; capability_tags?: string[]; port?: number }>,
): OrchestratorConfig {
  const agentEntries: OrchestratorConfig["agents"] = {};
  for (const [name, overrides] of Object.entries(agents)) {
    agentEntries[name] = {
      dir: `/agents/${name}`,
      description: `Test agent ${name}`,
      capabilities: [],
      owns_topics: [],
      github: overrides.github,
      capability_tags: overrides.capability_tags,
      ...(overrides.port ? { docker: { port: overrides.port } } : {}),
    };
  }
  return {
    proxy: { url: "http://localhost:3400", timeout_ms: 30000 },
    base_dir: "/agents",
    orchestrator_dir: "/orchestrator",
    agents: agentEntries,
  };
}

// ── callCapabilityCheck ────────────────────────────────────────────────────

describe("callCapabilityCheck", () => {
  const mockFetch = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns accepted when agent responds with accept:true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: true }),
    });

    const result = await callCapabilityCheck("http://localhost:3478", {
      title: "Research: compare vector DBs",
      task_type: "research",
    });

    expect(result.status).toBe("accepted");
  });

  it("returns rejected when agent responds with accept:false", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: false, reason: "I only do research tasks" }),
    });

    const result = await callCapabilityCheck("http://localhost:3478", {
      title: "[Orchestrator] Add dashboard routes",
      task_type: "implementation",
    });

    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBe("I only do research tasks");
    }
  });

  it("returns not-supported when agent returns 404", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: "not found" }),
    });

    const result = await callCapabilityCheck("http://localhost:3478", {
      title: "[Orchestrator] Add dashboard routes",
      task_type: "implementation",
    });

    expect(result.status).toBe("not-supported");
  });

  it("returns error on non-OK non-404 HTTP status", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await callCapabilityCheck("http://localhost:3478", {
      title: "Some task",
      task_type: "implementation",
    });

    expect(result.status).toBe("error");
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await callCapabilityCheck("http://localhost:3478", {
      title: "Some task",
      task_type: "implementation",
    });

    expect(result.status).toBe("error");
  });

  it("includes source_ref in the query string when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: true }),
    });

    await callCapabilityCheck("http://localhost:3478", {
      title: "Research task",
      task_type: "research",
      source_ref: "rapartlu/research-agent#42",
    });

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain("source_ref=rapartlu%2Fresearch-agent%2342");
  });

  it("uses GET method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: true }),
    });

    await callCapabilityCheck("http://localhost:3478", {
      title: "Research task",
      task_type: "research",
    });

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    expect(options.method).toBe("GET");
  });
});

// ── runRemoteCapabilityCheck ───────────────────────────────────────────────

describe("runRemoteCapabilityCheck", () => {
  const mockFetch = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns null when agent has no docker port (no URL to call)", async () => {
    const config = makeConfig({
      "claude-research-agent": {
        github: "rapartlu/research-agent",
        capability_tags: ["research-only"],
        // No port → getAgentBaseUrl returns undefined
      },
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator", port: 3472 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[Orchestrator] Add panel",
    });

    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when agent accepts the task", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: true }),
    });

    const config = makeConfig({
      "claude-research-agent": { github: "rapartlu/research-agent", port: 3478 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "research",
      title: "Research: evaluate vector DBs",
    });

    expect(result).toBeNull();
  });

  it("returns null when endpoint is not supported (404)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    const config = makeConfig({
      "claude-research-agent": { github: "rapartlu/research-agent", port: 3478 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[Orchestrator] Fix routes",
    });

    expect(result).toBeNull();
  });

  it("returns a reroute descriptor when agent rejects the task", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: false, reason: "I am research-only" }),
    });

    const config = makeConfig({
      "claude-research-agent": { github: "rapartlu/research-agent", port: 3478 },
      "claude-impl-agent": { github: "rapartlu/agent-orchestrator", port: 3472 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[Orchestrator] Add dashboard panel",
      sourceRef: "rapartlu/agent-orchestrator#837",
    });

    expect(result).not.toBeNull();
    expect(result!.blockedAgent).toBe("claude-research-agent");
    expect(result!.toAgent).toBe("claude-impl-agent");
    expect(result!.redirectReason).toContain("rejected");
    expect(result!.redirectReason).toContain("I am research-only");
  });

  it("routes to the exact repo match when available", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ accept: false, reason: "research-only" }),
    });

    const config = makeConfig({
      "claude-research-agent": { github: "rapartlu/research-agent", port: 3478 },
      "claude-dashboard-agent": { github: "rapartlu/agent-dashboard", port: 3473 },
      "claude-orchestrator-agent": { github: "rapartlu/agent-orchestrator", port: 3472 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[agent-dashboard] Add immune panel",
      sourceRef: "rapartlu/agent-dashboard#196",
    });

    expect(result!.toAgent).toBe("claude-dashboard-agent");
  });

  it("returns null on network error (non-blocking)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const config = makeConfig({
      "claude-research-agent": { github: "rapartlu/research-agent", port: 3478 },
    });

    const result = await runRemoteCapabilityCheck({
      config,
      agentName: "claude-research-agent",
      taskType: "implementation",
      title: "[Orchestrator] Some task",
    });

    expect(result).toBeNull();
  });
});

// ── Extended isImplementationTask keyword detection ───────────────────────

describe("isImplementationTask — extended keyword detection (issue #837)", () => {
  it("returns true for title containing 'routes'", () => {
    expect(isImplementationTask("research", "[Dashboard] Add routes for immune system panel")).toBe(true);
  });

  it("returns true for title containing 'panel'", () => {
    expect(isImplementationTask("research", "[Dashboard] Implement immune system panel")).toBe(true);
  });

  it("returns true for title containing 'widget'", () => {
    expect(isImplementationTask("research", "[Dashboard] First-pass save rate widget")).toBe(true);
  });

  it("returns true for 'follow-up from #N' pattern", () => {
    expect(isImplementationTask("research", "Follow-up from #114: add cross-repo cascade view")).toBe(true);
  });

  it("returns true for [agent-dashboard] tag", () => {
    expect(isImplementationTask("research", "[agent-dashboard] Add new route")).toBe(true);
  });

  it("returns true for [agent-reviewer] tag", () => {
    expect(isImplementationTask("research", "[agent-reviewer] Fix verifier score")).toBe(true);
  });

  it("returns false for genuine research titles with no impl keywords", () => {
    expect(isImplementationTask("research", "Evaluate embedding model options for agent routing")).toBe(false);
  });

  it("returns false for research title with 'analysis' and no impl keywords", () => {
    expect(isImplementationTask("research", "Technology analysis: LLM routing strategies")).toBe(false);
  });

  it("returns true for explicit implementation taskType regardless of title", () => {
    expect(isImplementationTask("implementation", "Evaluate embedding models")).toBe(true);
  });

  it("returns true for cross-repo source ref (unchanged behaviour)", () => {
    expect(
      isImplementationTask(
        "research",
        undefined,
        "rapartlu/agent-orchestrator#837",
        "rapartlu/research-agent",
      ),
    ).toBe(true);
  });

  it("returns false for same-repo source ref with plain research title", () => {
    expect(
      isImplementationTask(
        "research",
        "Evaluate options",
        "rapartlu/research-agent#5",
        "rapartlu/research-agent",
      ),
    ).toBe(false);
  });
});
