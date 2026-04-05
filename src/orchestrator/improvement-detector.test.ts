import { describe, it, expect, vi } from "vitest";
import { ImprovementDetector } from "./improvement-detector.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

const mockCreate = vi.fn();

vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: { create: mockCreate },
  }),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": { dir: "a", description: "A", capabilities: ["test"], owns_topics: ["a"] },
    "agent-b": { dir: "b", description: "B", capabilities: ["test"], owns_topics: ["b"] },
  },
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "test-id", title: "Test", description: null, source: "manual",
    source_ref: null, status: "done", agent_name: "agent-a", conversation_id: null,
    result: "Done", parent_task_id: null, step_id: null, plan: null,
    verification_status: null, quality_score: null, verification_notes: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("ImprovementDetector", () => {
  it("detects improvements from task patterns", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { title: "Add retry logic", description: "Both agents fail on network errors", affected_agents: ["agent-a", "agent-b"], severity: "medium" },
      ])}],
    });

    const detector = new ImprovementDetector(config);
    const improvements = await detector.analyze([
      makeTask({ agent_name: "agent-a", quality_score: 0.4 }),
      makeTask({ agent_name: "agent-b", quality_score: 0.5 }),
    ]);

    expect(improvements).toHaveLength(1);
    expect(improvements[0].title).toBe("Add retry logic");
    expect(improvements[0].affected_agents).toEqual(["agent-a", "agent-b"]);
  });

  it("returns empty for no tasks", async () => {
    const detector = new ImprovementDetector(config);
    const improvements = await detector.analyze([]);
    expect(improvements).toHaveLength(0);
  });

  it("filters out unknown agent names", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: JSON.stringify([
        { title: "Fix", description: "Issue", affected_agents: ["agent-a", "unknown-agent"], severity: "low" },
      ])}],
    });

    const detector = new ImprovementDetector(config);
    const improvements = await detector.analyze([makeTask({})]);

    expect(improvements[0].affected_agents).toEqual(["agent-a"]);
  });

  it("handles malformed LLM response", async () => {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I found some issues but can't format JSON" }],
    });

    const detector = new ImprovementDetector(config);
    const improvements = await detector.analyze([makeTask({})]);
    expect(improvements).toHaveLength(0);
  });
});
