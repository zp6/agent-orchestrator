import { describe, it, expect } from "vitest";
import { Router } from "./router.js";
import { loadConfig } from "../config/schema.js";
import { resolve } from "node:path";

const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");
const config = loadConfig(configPath);

describe("Router", () => {
  const router = new Router(config);

  it("routes by topic keyword", () => {
    const matches = router.route("update the blog post about AI");
    expect(matches[0].agentName).toBe("blog-articles");
    expect(matches[0].confidence).toBeGreaterThan(0);
  });

  it("routes by agent name mention", () => {
    const matches = router.route("fix something in temporal");
    expect(matches[0].agentName).toBe("temporal");
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("routes proxy-related tasks", () => {
    const matches = router.route("fix the proxy streaming bug");
    expect(matches[0].agentName).toBe("claude-proxy");
  });

  it("routes interview-related tasks", () => {
    const matches = router.route("summarise the latest interview notes");
    expect(matches[0].agentName).toBe("interview-notes-summariser");
  });

  it("routes MCP tasks to an MCP agent", () => {
    const matches = router.route("add a new MCP tool");
    expect(matches[0].agentName).toMatch(/ravio-mcp/);
  });

  it("routes annual report tasks", () => {
    const matches = router.route("crawl the annual report for Tesla");
    expect(matches[0].agentName).toBe("annual-report-crawler");
  });

  it("returns empty array for unmatched tasks", () => {
    const matches = router.route("do something completely unrelated xyz123");
    expect(matches.length).toBe(0);
  });

  it("returns matches sorted by confidence descending", () => {
    const matches = router.route("temporal workflows");
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
