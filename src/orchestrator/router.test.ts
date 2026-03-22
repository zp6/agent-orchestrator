import { describe, it, expect } from "vitest";
import { Router } from "./router.js";
import { loadConfig } from "../config/schema.js";
import { resolve } from "node:path";

const configPath = resolve(import.meta.dirname, "..", "..", "agents.yaml");
const config = loadConfig(configPath);

describe("Router", () => {
  const router = new Router(config);

  it("routes by topic keyword", () => {
    const matches = router.route("tell me about cheese");
    expect(matches[0].agentName).toBe("cheese-hater");
    expect(matches[0].confidence).toBeGreaterThan(0);
  });

  it("routes by agent name mention", () => {
    const matches = router.route("fix something in hermitcraft-agent");
    expect(matches[0].agentName).toBe("hermitcraft-agent");
    expect(matches[0].confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("routes hermitcraft tasks", () => {
    const matches = router.route("research the latest minecraft hermitcraft season");
    expect(matches[0].agentName).toBe("hermitcraft-agent");
  });

  it("routes cheese tasks", () => {
    const matches = router.route("rate some cheese for me");
    expect(matches[0].agentName).toBe("cheese-hater");
  });

  it("returns empty array for unmatched tasks", () => {
    const matches = router.route("do something completely unrelated xyz123");
    expect(matches.length).toBe(0);
  });

  it("returns matches sorted by confidence descending", () => {
    const matches = router.route("hermitcraft minecraft smp");
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].confidence).toBeLessThanOrEqual(matches[i - 1].confidence);
    }
  });
});

describe("Router.routeToRepo", () => {
  const router = new Router(config);

  it("finds agent by GitHub repo", () => {
    expect(router.routeToRepo("rapartlu/cheese-hater")).toBe("cheese-hater");
  });

  it("returns undefined for unknown repo", () => {
    expect(router.routeToRepo("unknown/repo")).toBeUndefined();
  });
});
