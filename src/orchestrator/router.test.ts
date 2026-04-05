import { describe, it, expect } from "vitest";
import { Router } from "./router.js";
import { loadConfig } from "../config/schema.js";
import { resolve } from "node:path";

const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");
const config = loadConfig(configPath);

describe("Router", () => {
  const router = new Router(config);

  it("routes by topic keyword", () => {
    const matches = router.route("fix the proxy docker container");
    expect(matches[0].agentName).toBe("claude-proxy");
    expect(matches[0].confidence).toBeGreaterThan(0);
  });

  it("routes by agent name mention", () => {
    const matches = router.route("fix something in claude-proxy");
    expect(matches[0].agentName).toBe("claude-proxy");
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("routes proxy tasks", () => {
    const matches = router.route("update the docker infrastructure and proxy auth");
    expect(matches[0].agentName).toBe("claude-proxy");
  });

  it("returns empty array for unmatched tasks", () => {
    const matches = router.route("do something completely unrelated xyz123");
    expect(matches.length).toBe(0);
  });

  it("returns matches sorted by confidence descending", () => {
    const matches = router.route("docker container proxy infrastructure");
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].confidence).toBeLessThanOrEqual(matches[i - 1].confidence);
    }
  });
});

describe("Router.routeToRepo", () => {
  const router = new Router(config);

  it("finds agent by GitHub repo", () => {
    expect(router.routeToRepo("rapartlu/claude-proxy")).toBe("claude-proxy");
  });

  it("returns undefined for unknown repo", () => {
    expect(router.routeToRepo("unknown/repo")).toBeUndefined();
  });
});

describe("Router integration-phrasing destination routing", () => {
  const router = new Router(config);

  it('routes "wire reviewer into orchestrator daemon" to claude-agent-orchestrator', () => {
    const matches = router.route("wire reviewer package into orchestrator daemon");
    expect(matches[0].agentName).toBe("claude-agent-orchestrator");
    expect(matches[0].reason).toMatch(/integration destination/i);
  });

  it('routes "integrate reviewer into orchestrator dispatcher" to claude-agent-orchestrator', () => {
    const matches = router.route("integrate reviewer into orchestrator dispatcher");
    expect(matches[0].agentName).toBe("claude-agent-orchestrator");
    expect(matches[0].reason).toMatch(/integration destination/i);
  });

  it('routes "integrate reviewer with orchestrator daemon" to claude-agent-orchestrator', () => {
    const matches = router.route("integrate reviewer with orchestrator daemon");
    expect(matches[0].agentName).toBe("claude-agent-orchestrator");
    expect(matches[0].reason).toMatch(/integration destination/i);
  });

  it('routes "plug reviewer notifications into orchestrator triggers" to claude-agent-orchestrator', () => {
    const matches = router.route("plug reviewer notifications into orchestrator triggers");
    expect(matches[0].agentName).toBe("claude-agent-orchestrator");
    expect(matches[0].reason).toMatch(/integration destination/i);
  });

  it('routes "consume reviewer package in orchestrator daemon" to claude-agent-orchestrator', () => {
    const matches = router.route("consume reviewer package in orchestrator daemon");
    expect(matches[0].agentName).toBe("claude-agent-orchestrator");
    expect(matches[0].reason).toMatch(/integration destination/i);
  });
});
