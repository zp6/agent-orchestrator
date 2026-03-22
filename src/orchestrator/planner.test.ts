import { describe, it, expect, vi } from "vitest";
import { Planner, type PlanStep } from "./planner.js";
import type { OrchestratorConfig } from "../config/schema.js";

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "blog-articles": {
      dir: "blog-articles",
      description: "Blog article generation",
      capabilities: ["writing"],
      owns_topics: ["blog"],
    },
    "ravio-mcp": {
      dir: "ravio-mcp",
      description: "MCP server",
      capabilities: ["mcp"],
      owns_topics: ["mcp"],
    },
    "temporal": {
      dir: "temporal",
      description: "Workflow orchestration",
      capabilities: ["workflows"],
      owns_topics: ["temporal"],
    },
  },
};

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: {
      create: vi.fn(),
    },
  }),
}));

describe("Planner.topologicalSort", () => {
  const planner = new Planner(config);

  it("sorts a linear chain", () => {
    const steps: PlanStep[] = [
      { id: "step-2", agent: "blog-articles", task: "Write", depends_on: ["step-1"] },
      { id: "step-1", agent: "ravio-mcp", task: "Research", depends_on: [] },
    ];
    const sorted = planner.topologicalSort(steps);
    expect(sorted[0].id).toBe("step-1");
    expect(sorted[1].id).toBe("step-2");
  });

  it("handles independent parallel steps", () => {
    const steps: PlanStep[] = [
      { id: "step-1", agent: "blog-articles", task: "A", depends_on: [] },
      { id: "step-2", agent: "ravio-mcp", task: "B", depends_on: [] },
      { id: "step-3", agent: "temporal", task: "C", depends_on: ["step-1", "step-2"] },
    ];
    const sorted = planner.topologicalSort(steps);
    expect(sorted.length).toBe(3);
    expect(sorted[2].id).toBe("step-3");
  });

  it("throws on dependency cycle", () => {
    const steps: PlanStep[] = [
      { id: "step-1", agent: "blog-articles", task: "A", depends_on: ["step-2"] },
      { id: "step-2", agent: "ravio-mcp", task: "B", depends_on: ["step-1"] },
    ];
    expect(() => planner.topologicalSort(steps)).toThrow("dependency cycle");
  });

  it("handles single step", () => {
    const steps: PlanStep[] = [
      { id: "step-1", agent: "blog-articles", task: "A", depends_on: [] },
    ];
    const sorted = planner.topologicalSort(steps);
    expect(sorted).toHaveLength(1);
  });
});

describe("Planner.validate (via plan parsing)", () => {
  const planner = new Planner(config);

  it("rejects unknown agent names", () => {
    // Access private validate method
    const plan = {
      id: "test",
      original_task: "test",
      is_multi_agent: false,
      steps: [{ id: "step-1", agent: "nonexistent", task: "Do something", depends_on: [] }],
    };
    expect(() => (planner as any).validate(plan)).toThrow('unknown agent "nonexistent"');
  });

  it("rejects unknown dependency references", () => {
    const plan = {
      id: "test",
      original_task: "test",
      is_multi_agent: true,
      steps: [
        { id: "step-1", agent: "blog-articles", task: "A", depends_on: ["step-99"] },
      ],
    };
    expect(() => (planner as any).validate(plan)).toThrow('unknown step "step-99"');
  });

  it("accepts valid single-agent plan", () => {
    const plan = {
      id: "test",
      original_task: "test",
      is_multi_agent: false,
      steps: [{ id: "step-1", agent: "blog-articles", task: "Write a blog post", depends_on: [] }],
    };
    expect(() => (planner as any).validate(plan)).not.toThrow();
  });

  it("accepts valid multi-agent plan", () => {
    const plan = {
      id: "test",
      original_task: "test",
      is_multi_agent: true,
      steps: [
        { id: "step-1", agent: "ravio-mcp", task: "Get data", depends_on: [] },
        { id: "step-2", agent: "blog-articles", task: "Write about it", depends_on: ["step-1"] },
      ],
    };
    expect(() => (planner as any).validate(plan)).not.toThrow();
  });
});
