import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "./schema.js";
import { diffConfig } from "./watcher.js";

const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

describe("diffConfig", () => {
  it("should return empty array for identical configs", () => {
    const config = loadConfig(configPath);
    const changes = diffConfig(config, config);
    expect(changes).toEqual([]);
  });

  it("should detect proxy.timeout_ms change", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    newConfig.proxy.timeout_ms = 123456;
    const changes = diffConfig(oldConfig, newConfig);
    expect(changes).toContainEqual({
      path: "proxy.timeout_ms",
      oldValue: oldConfig.proxy.timeout_ms,
      newValue: 123456,
    });
  });

  it("should detect nested verification config change", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    if (!newConfig.verification) newConfig.verification = { enabled: true };
    const oldMinScore = newConfig.verification.min_score;
    newConfig.verification.min_score = 0.99;
    const changes = diffConfig(oldConfig, newConfig);
    expect(changes.some((c) => c.path === "verification.min_score")).toBe(true);
  });

  it("should detect agent-level changes individually", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    const firstAgentName = Object.keys(newConfig.agents)[0];
    newConfig.agents[firstAgentName] = {
      ...newConfig.agents[firstAgentName],
      description: "modified description for test",
    };
    const changes = diffConfig(oldConfig, newConfig);
    expect(changes.some((c) => c.path === `agents.${firstAgentName}`)).toBe(true);
  });

  it("should detect new agent added", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    (newConfig.agents as Record<string, unknown>)["test-new-agent"] = {
      dir: "test",
      description: "test agent",
      capabilities: [],
      owns_topics: [],
    };
    const changes = diffConfig(oldConfig, newConfig);
    expect(changes.some((c) => c.path === "agents.test-new-agent")).toBe(true);
    const addChange = changes.find((c) => c.path === "agents.test-new-agent");
    expect(addChange?.oldValue).toBeUndefined();
  });

  it("should detect agent removed", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    const firstAgentName = Object.keys(newConfig.agents)[0];
    delete newConfig.agents[firstAgentName];
    const changes = diffConfig(oldConfig, newConfig);
    const removeChange = changes.find((c) => c.path === `agents.${firstAgentName}`);
    expect(removeChange).toBeDefined();
    expect(removeChange?.newValue).toBeUndefined();
  });

  it("should detect pr_review config change", () => {
    const oldConfig = loadConfig(configPath);
    const newConfig = loadConfig(configPath);
    if (!newConfig.pr_review) newConfig.pr_review = {};
    newConfig.pr_review.feedback_ceiling = 99;
    const changes = diffConfig(oldConfig, newConfig);
    // The change may be detected at the field level or the object level depending
    // on whether pr_review already exists in the config
    expect(changes.some((c) => c.path.startsWith("pr_review"))).toBe(true);
  });
});
