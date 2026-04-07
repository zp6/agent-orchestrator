import { describe, it, expect } from "vitest";
import {
  scoreComplexity,
  selectTier,
  escalateTier,
  resolveModel,
  routeModel,
} from "./model-router.js";

describe("scoreComplexity", () => {
  it("scores short simple messages as low complexity", () => {
    const score = scoreComplexity("Fix typo in README");
    expect(score).toBeLessThan(0.3);
  });

  it("scores long complex messages as high complexity", () => {
    const msg = "Refactor the entire dispatcher module to support multi-file " +
      "architecture changes. Need to modify store.ts, dispatcher.ts, daemon.ts, " +
      "router.ts, planner.ts, and executor.ts. This is a breaking change that " +
      "requires a migration. " + "x".repeat(3000);
    const score = scoreComplexity(msg);
    expect(score).toBeGreaterThan(0.6);
  });

  it("scores research tasks lower", () => {
    const base = scoreComplexity("Investigate how caching works in the proxy");
    const research = scoreComplexity("Investigate how caching works in the proxy", { taskType: "research" });
    expect(research).toBeLessThan(base);
  });

  it("scores revisions lower", () => {
    const base = scoreComplexity("Fix the login page styling");
    const revision = scoreComplexity("Fix the login page styling", { isRevision: true });
    expect(revision).toBeLessThan(base);
  });

  it("scores PR feedback as low complexity", () => {
    const score = scoreComplexity("[PR feedback] Fix indentation on line 42");
    expect(score).toBeLessThan(0.3);
  });

  it("clamps score to 0-1 range", () => {
    const low = scoreComplexity("a", { isRevision: true, taskType: "research" });
    const high = scoreComplexity("x".repeat(10000) + " refactor migration security");
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });
});

describe("selectTier", () => {
  it("selects light for low scores", () => {
    expect(selectTier(0.1)).toBe("light");
    expect(selectTier(0.29)).toBe("light");
  });

  it("selects standard for mid scores", () => {
    expect(selectTier(0.3)).toBe("standard");
    expect(selectTier(0.5)).toBe("standard");
    expect(selectTier(0.69)).toBe("standard");
  });

  it("selects heavy for high scores", () => {
    expect(selectTier(0.7)).toBe("heavy");
    expect(selectTier(0.9)).toBe("heavy");
    expect(selectTier(1.0)).toBe("heavy");
  });
});

describe("escalateTier", () => {
  it("escalates light → standard", () => {
    expect(escalateTier("light")).toBe("standard");
  });
  it("escalates standard → heavy", () => {
    expect(escalateTier("standard")).toBe("heavy");
  });
  it("returns null for heavy (already max)", () => {
    expect(escalateTier("heavy")).toBeNull();
  });
});

describe("resolveModel", () => {
  it("returns claude models for claude provider", () => {
    expect(resolveModel("claude", "light")).toBe("claude-haiku-4-5");
    expect(resolveModel("claude", "standard")).toBe("claude-sonnet-4-6");
    expect(resolveModel("claude", "heavy")).toBe("claude-opus-4-6");
  });

  it("returns openai models for openai provider", () => {
    expect(resolveModel("openai", "light")).toBe("gpt-5.4-mini");
    expect(resolveModel("openai", "heavy")).toBe("gpt-5.4");
  });

  it("falls back to claude models for unknown provider", () => {
    expect(resolveModel("unknown", "heavy")).toBe("claude-opus-4-6");
  });
});

describe("routeModel", () => {
  it("routes simple task to light model", () => {
    const result = routeModel("claude", "Fix typo in config");
    expect(result.tier).toBe("light");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("routes complex task to heavy model", () => {
    const msg = "Refactor the entire authentication system with migration. " +
      "Breaking change across multiple files. " + "x".repeat(4000);
    const result = routeModel("claude", msg);
    expect(result.tier).toBe("heavy");
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("routes openai tasks to correct models", () => {
    const result = routeModel("openai", "Fix typo");
    expect(result.model).toBe("gpt-5.4-mini");
  });
});
