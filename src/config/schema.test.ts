import { describe, it, expect } from "vitest";
import { loadConfig, getAgentDir } from "./schema.js";
import { resolve } from "node:path";

describe("loadConfig", () => {
  const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

  it("loads and parses agents.yaml", () => {
    const config = loadConfig(configPath);
    expect(config.proxy.url).toMatch(/^http:\/\/(localhost|host\.docker\.internal):3457$/);
    expect(config.proxy.timeout_ms).toBe(300000);
    expect(config.base_dir).toBeTruthy();
    expect(Object.keys(config.agents).length).toBeGreaterThanOrEqual(2);
  });

  it("contains active agents", () => {
    const config = loadConfig(configPath);
    const expected = ["orchestrator-llm", "claude-proxy"];
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
});

describe("getAgentDir", () => {
  const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

  it("resolves agent directory path", () => {
    const config = loadConfig(configPath);
    const dir = getAgentDir(config, "claude-proxy");
    // All agents use base_dir + dir for the host path sent to the proxy
    expect(dir).toContain("claude-proxy");
  });

  it("throws for unknown agent", () => {
    const config = loadConfig(configPath);
    expect(() => getAgentDir(config, "nonexistent")).toThrow("Unknown agent: nonexistent");
  });
});
