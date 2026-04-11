import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { loadConfig } from "./schema.js";
import { validateConfig } from "./validator.js";

const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");

describe("validateConfig", () => {
  it("should pass for the real agents.yaml", () => {
    const config = loadConfig(configPath);
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it("should catch negative proxy.timeout_ms", () => {
    const config = loadConfig(configPath);
    (config.proxy as Record<string, unknown>).timeout_ms = -1;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "proxy.timeout_ms")).toBe(true);
  });

  it("should catch non-number proxy.timeout_ms", () => {
    const config = loadConfig(configPath);
    (config.proxy as Record<string, unknown>).timeout_ms = "fast";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "proxy.timeout_ms")).toBe(true);
  });

  it("should catch min_score out of range", () => {
    const config = loadConfig(configPath);
    if (!config.verification) config.verification = { enabled: true };
    config.verification.min_score = 1.5;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "verification.min_score")).toBe(true);
  });

  it("should catch negative min_score", () => {
    const config = loadConfig(configPath);
    if (!config.verification) config.verification = { enabled: true };
    config.verification.min_score = -0.1;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "verification.min_score")).toBe(true);
  });

  it("should catch invalid verification.max_revisions", () => {
    const config = loadConfig(configPath);
    if (!config.verification) config.verification = { enabled: true };
    config.verification.max_revisions = -1;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "verification.max_revisions")).toBe(true);
  });

  it("should allow max_revisions = 0 (verify-only mode)", () => {
    const config = loadConfig(configPath);
    if (!config.verification) config.verification = { enabled: true };
    config.verification.max_revisions = 0;
    const errors = validateConfig(config);
    expect(errors.filter((e) => e.path === "verification.max_revisions")).toEqual([]);
  });

  it("should catch invalid llm.provider", () => {
    const config = loadConfig(configPath);
    if (!config.llm) config.llm = {};
    (config.llm as Record<string, unknown>).provider = "openai";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "llm.provider")).toBe(true);
  });

  it("should catch invalid docker.session", () => {
    const config = loadConfig(configPath);
    const firstAgent = Object.values(config.agents)[0];
    if (!firstAgent.docker) firstAgent.docker = {};
    (firstAgent.docker as Record<string, unknown>).session = "invalid";
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes("docker.session"))).toBe(true);
  });

  it("should catch invalid digest schedule format", () => {
    const config = loadConfig(configPath);
    if (!config.dashboard) config.dashboard = {};
    config.dashboard.digest = { slack_webhook: "https://hooks.slack.com/test", schedule: "9am" };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "dashboard.digest.schedule")).toBe(true);
  });

  it("should catch budget warning_pct out of range", () => {
    const config = loadConfig(configPath);
    if (!config.dashboard) config.dashboard = {};
    config.dashboard.budget = { warning_pct: 0 };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "dashboard.budget.warning_pct")).toBe(true);
  });

  it("should catch non-array connection_error_delays_ms", () => {
    const config = loadConfig(configPath);
    config.retry = { connection_error_delays_ms: "fast" as unknown as number[] };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "retry.connection_error_delays_ms")).toBe(true);
  });

  it("should catch negative agent stale_timeout_ms", () => {
    const config = loadConfig(configPath);
    const firstAgentName = Object.keys(config.agents)[0];
    config.agents[firstAgentName].stale_timeout_ms = -100;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes("stale_timeout_ms"))).toBe(true);
  });

  it("should catch negative dispatch.max_open_prs", () => {
    const config = loadConfig(configPath);
    config.dispatch = { max_open_prs: -1 };
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path === "dispatch.max_open_prs")).toBe(true);
  });

  it("should catch negative agent.max_open_prs", () => {
    const config = loadConfig(configPath);
    const firstAgentName = Object.keys(config.agents)[0];
    config.agents[firstAgentName].max_open_prs = -1;
    const errors = validateConfig(config);
    expect(errors.some((e) => e.path.includes("max_open_prs"))).toBe(true);
  });
});
