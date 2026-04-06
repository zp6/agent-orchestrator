import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OrchestratorConfig } from "../config/schema.js";

// Mock proxy-client before importing llm-client so the factory never actually
// opens a network connection during tests.
vi.mock("./proxy-client.js", () => ({
  createProxyClient: vi.fn((_proxy, _dir, opts: { baseUrl?: string }) => ({
    __baseUrl: opts.baseUrl ?? "fallback",
    messages: { create: vi.fn() },
  })),
}));

// Import after mocking so the module-level code picks up the stub.
const { createProxyClient } = await import("./proxy-client.js");
const { createLLMClient } = await import("./llm-client.js");

/** Minimal config that exercises the provider-preference logic. */
function makeConfig(
  overrides: Partial<OrchestratorConfig["llm"]> = {},
): OrchestratorConfig {
  return {
    proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
    orchestrator_dir: "/tmp/orch",
    base_dir: "/projects",
    llm: { provider: "auto", ...overrides },
    agents: {
      "claude-orchestrator-reviewer": {
        dir: "claude-orchestrator-reviewer",
        description: "Claude reviewer",
        capabilities: ["review"],
        owns_topics: ["review"],
        provider: "claude",
        model: "claude-sonnet-4-6",
        docker: { port: 3474, api_key: "claude-key" },
      },
      "codex-orchestrator-reviewer": {
        dir: "codex-orchestrator-reviewer",
        description: "Codex reviewer",
        capabilities: ["review"],
        owns_topics: ["review"],
        provider: "codex",
        model: "codex-model",
        docker: { port: 3475, api_key: "codex-key" },
      },
    },
  };
}

function selectedBaseUrl(): string {
  const calls = vi.mocked(createProxyClient).mock.calls;
  const last = calls[calls.length - 1];
  return (last[2] as any).baseUrl ?? "fallback";
}

const CLAUDE_PORT_URL = "http://localhost:3474";
const CODEX_PORT_URL = "http://localhost:3475";

describe("createLLMClient — per-task provider preference", () => {
  beforeEach(() => {
    vi.mocked(createProxyClient).mockClear();
  });

  it("with provider=auto and no taskKind, defaults to Claude (claude is first in preference list)", () => {
    createLLMClient(makeConfig());
    expect(selectedBaseUrl()).toBe(CLAUDE_PORT_URL);
  });

  it("high-frequency tasks default to Claude when provider=auto", () => {
    for (const task of ["router", "planner", "verifier", "supervisor", "improvement", "issue_matcher"] as const) {
      vi.mocked(createProxyClient).mockClear();
      createLLMClient(makeConfig(), task);
      expect(selectedBaseUrl()).toBe(CLAUDE_PORT_URL);
    }
  });

  it("respects explicit task_providers override to codex", () => {
    const config = makeConfig({ task_providers: { verifier: "codex" } });
    createLLMClient(config, "verifier");
    expect(selectedBaseUrl()).toBe(CODEX_PORT_URL);
  });

  it("respects explicit task_providers override to claude", () => {
    // Start with global codex preference but override verifier back to claude
    const config = makeConfig({ provider: "codex", task_providers: { verifier: "claude" } });
    createLLMClient(config, "verifier");
    expect(selectedBaseUrl()).toBe(CLAUDE_PORT_URL);
  });

  it("task_providers=auto falls back to global provider", () => {
    // global=codex, task_providers.supervisor=auto → should use codex ordering
    const config = makeConfig({ provider: "codex", task_providers: { supervisor: "auto" } });
    createLLMClient(config, "supervisor");
    expect(selectedBaseUrl()).toBe(CODEX_PORT_URL);
  });

  it("global provider=codex without task override picks Codex", () => {
    const config = makeConfig({ provider: "codex" });
    createLLMClient(config, "default");
    expect(selectedBaseUrl()).toBe(CODEX_PORT_URL);
  });

  it("global provider=claude always picks Claude", () => {
    const config = makeConfig({ provider: "claude" });
    createLLMClient(config, "verifier");
    expect(selectedBaseUrl()).toBe(CLAUDE_PORT_URL);
  });
});
