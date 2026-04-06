import { describe, it, expect } from "vitest";
import { loadConfig, getAgentDir, type PRReviewConfig, type OrchestratorConfig, type ProviderConfig } from "./schema.js";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

describe("loadConfig", () => {
  const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

  it("loads and parses agents.yaml", () => {
    const config = loadConfig(configPath);
    expect(config.proxy.url).toMatch(/^http:\/\/(localhost|host\.docker\.internal):3457$/);
    expect(config.proxy.timeout_ms).toBe(900000);
    expect(config.base_dir).toBeTruthy();
    expect(Object.keys(config.agents).length).toBeGreaterThanOrEqual(2);
  });

  it("contains active agents", () => {
    const config = loadConfig(configPath);
    const expected = ["claude-agent-orchestrator", "claude-proxy"];
    for (const name of expected) {
      expect(config.agents[name]).toBeDefined();
    }
  });

  it("each agent has required fields", () => {
    const config = loadConfig(configPath);
    for (const [name, agent] of Object.entries(config.agents)) {
      expect(agent.dir, `${name} missing dir`).toBeTruthy();
      expect(agent.description, `${name} missing description`).toBeTruthy();
      expect(agent.capabilities.length, `${name} missing capabilities`).toBeGreaterThan(0);
      expect(agent.owns_topics, `${name} missing owns_topics`).toBeDefined();
    }
  });

  it("throws on missing config file", () => {
    expect(() => loadConfig("/nonexistent/path.yaml")).toThrow();
  });

  it("each agent has docker config", () => {
    const config = loadConfig(configPath);
    for (const [name, agent] of Object.entries(config.agents)) {
      expect(agent.docker, `${name} missing docker config`).toBeDefined();
      expect(agent.docker!.port, `${name} missing docker.port`).toBeGreaterThan(0);
    }
  });

  it("agents have unique ports", () => {
    const config = loadConfig(configPath);
    const ports = Object.values(config.agents).map((a) => a.docker?.port);
    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });

  it("mirrors proxy.gh_token into process.env.GH_TOKEN", () => {
    const previous = process.env.GH_TOKEN;
    const tmp = mkdtempSync(join(tmpdir(), "orch-config-"));
    const configPath = join(tmp, "agents.yaml");

    writeFileSync(
      configPath,
      [
        "proxy:",
        "  url: http://localhost:3457",
        "  timeout_ms: 900000",
        "  gh_token: ghp_test_from_config",
        "base_dir: /tmp",
        "orchestrator_dir: /tmp/orchestrator",
        "agents:",
        "  test-agent:",
        "    dir: test-agent",
        "    description: test",
        "    capabilities: [typescript]",
        "    owns_topics: [test]",
        "    docker:",
        "      port: 3472",
      ].join("\n"),
    );

    try {
      delete process.env.GH_TOKEN;
      const config = loadConfig(configPath);
      expect(config.proxy.gh_token).toBe("ghp_test_from_config");
      expect(process.env.GH_TOKEN).toBe("ghp_test_from_config");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      if (previous === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previous;
      }
    }
  });
});

describe("github field validation", () => {
  function writeTempConfig(githubValue: string): string {
    const tmpPath = resolve(tmpdir(), `agents-test-${Date.now()}.yaml`);
    const yaml = `
proxy:
  url: "http://localhost:3457"
  timeout_ms: 900000
base_dir: "/tmp"
agents:
  test-agent:
    dir: "test"
    github: "${githubValue}"
    description: "Test agent"
    capabilities: ["test"]
    owns_topics: ["test"]
    docker:
      port: 9999
`;
    writeFileSync(tmpPath, yaml);
    return tmpPath;
  }

  it("accepts valid owner/repo format", () => {
    const tmp = writeTempConfig("rapartlu/agent-orchestrator");
    try {
      const config = loadConfig(tmp);
      expect(config.agents["test-agent"].github).toBe("rapartlu/agent-orchestrator");
    } finally {
      unlinkSync(tmp);
    }
  });

  it("accepts owner/repo with dots and hyphens", () => {
    const tmp = writeTempConfig("my-org.io/my-repo.js");
    try {
      const config = loadConfig(tmp);
      expect(config.agents["test-agent"].github).toBe("my-org.io/my-repo.js");
    } finally {
      unlinkSync(tmp);
    }
  });

  it("rejects missing slash (owner-repo)", () => {
    const tmp = writeTempConfig("owner-repo");
    try {
      expect(() => loadConfig(tmp)).toThrow('Agent "test-agent" has invalid github field');
    } finally {
      unlinkSync(tmp);
    }
  });

  it("rejects full URL instead of owner/repo", () => {
    const tmp = writeTempConfig("https://github.com/owner/repo");
    try {
      expect(() => loadConfig(tmp)).toThrow('Agent "test-agent" has invalid github field');
    } finally {
      unlinkSync(tmp);
    }
  });

  it("rejects trailing slash", () => {
    const tmp = writeTempConfig("owner/repo/extra");
    try {
      expect(() => loadConfig(tmp)).toThrow('Agent "test-agent" has invalid github field');
    } finally {
      unlinkSync(tmp);
    }
  });

  it("all agents in real config have valid github fields", () => {
    const realConfigPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");
    const config = loadConfig(realConfigPath);
    for (const [name, agent] of Object.entries(config.agents)) {
      if (agent.github) {
        expect(agent.github, `${name} has invalid github field`).toMatch(
          /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
        );
      }
    }
  });
});

describe("ProviderConfig", () => {
  const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

  it("loads providers from agents.yaml", () => {
    const config = loadConfig(configPath);
    expect(config.providers).toBeDefined();
    expect(config.providers!["claude"]).toBeDefined();
    expect(config.providers!["openai"]).toBeDefined();
    expect(config.providers!["gemini"]).toBeDefined();
  });

  it("each provider has a model field", () => {
    const config = loadConfig(configPath);
    for (const [name, provider] of Object.entries(config.providers!)) {
      expect(provider.model, `${name} missing model`).toBeTruthy();
    }
  });

  it("non-claude providers are configured", () => {
    const config = loadConfig(configPath);
    expect(config.providers!["openai"].model).toBe("gpt-5.4");
    expect(config.providers!["gemini"].api_key_env).toBe("GEMINI_API_KEY");
  });

  it("ProviderConfig interface works correctly", () => {
    const provider: ProviderConfig = {
      model: "test-model",
      api_key_env: "TEST_KEY",
      daily_token_limit: 1000000,
    };
    expect(provider.model).toBe("test-model");
    expect(provider.api_key_env).toBe("TEST_KEY");
    expect(provider.daily_token_limit).toBe(1000000);
  });

  it("agent provider field is set for all agents", () => {
    const config = loadConfig(configPath);
    expect(config.agents["claude-agent-orchestrator"].provider).toBe("claude");
    expect(config.agents["codex-agent-orchestrator"].provider).toBe("openai");
  });
});

describe("PRReviewConfig", () => {
  it("feedback_ceiling is optional and defaults to undefined when not set", () => {
    const prReview: PRReviewConfig = {};
    expect(prReview.feedback_ceiling).toBeUndefined();
  });

  it("feedback_ceiling can be set to a custom value", () => {
    const prReview: PRReviewConfig = { feedback_ceiling: 5 };
    expect(prReview.feedback_ceiling).toBe(5);
  });

  it("OrchestratorConfig accepts pr_review field", () => {
    const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");
    const config = loadConfig(configPath);
    // pr_review is optional — agents.yaml may not define it
    const withPrReview: OrchestratorConfig = { ...config, pr_review: { feedback_ceiling: 2 } };
    expect(withPrReview.pr_review?.feedback_ceiling).toBe(2);
  });
});

describe("getAgentDir", () => {
  const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

  it("returns container path for repo-based agents", () => {
    const config = loadConfig(configPath);
    const dir = getAgentDir(config, "claude-proxy");
    // claude-proxy has repo: set → container path derived from repo URL
    expect(dir).toBe("/home/claude/workspace/agent-proxy");
  });

  it("returns host path for bind-mounted agents without repo", () => {
    const config = loadConfig(configPath);
    // Temporarily remove repo to test host path fallback
    const agent = config.agents["claude-proxy"];
    const savedRepo = agent.repo;
    delete agent.repo;
    const dir = getAgentDir(config, "claude-proxy");
    expect(dir).toContain("claude-proxy");
    expect(dir).not.toContain("/home/claude");
    agent.repo = savedRepo;
  });

  it("throws for unknown agent", () => {
    const config = loadConfig(configPath);
    expect(() => getAgentDir(config, "nonexistent")).toThrow("Unknown agent: nonexistent");
  });
});

describe("AgentConfig auto-reroute threshold", () => {
  it("loads per-agent auto_reroute_rejection_threshold from config", () => {
    const tmp = mkdtempSync(join(tmpdir(), "orch-reroute-config-"));
    const configPath = join(tmp, "agents.yaml");

    writeFileSync(
      configPath,
      [
        "proxy:",
        "  url: http://localhost:3457",
        "  timeout_ms: 900000",
        "base_dir: /tmp",
        "orchestrator_dir: /tmp/orchestrator",
        "agents:",
        "  test-agent:",
        "    dir: test-agent",
        "    description: test",
        "    capabilities: [typescript]",
        "    owns_topics: [orchestrator]",
        "    auto_reroute_rejection_threshold: 4",
        "    docker:",
        "      port: 3472",
      ].join("\n"),
    );

    try {
      const config = loadConfig(configPath);
      expect(config.agents["test-agent"].auto_reroute_rejection_threshold).toBe(4);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
