import { describe, it, expect, vi } from "vitest";
import { LLMRouter } from "./llm-router.js";
import type { OrchestratorConfig } from "../config/schema.js";

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "blog-articles": {
      dir: "blog-articles",
      description: "Blog article generation",
      capabilities: ["writing", "blog"],
      owns_topics: ["blog", "articles"],
    },
    "temporal": {
      dir: "temporal",
      description: "Temporal workflow orchestration",
      capabilities: ["workflows"],
      owns_topics: ["temporal", "workflows"],
    },
  },
};

// Mock the proxy client
vi.mock("../client/proxy-client.js", () => ({
  createProxyClient: () => ({
    messages: {
      create: vi.fn(),
    },
  }),
}));

describe("LLMRouter", () => {
  it("parses valid JSON routing response", async () => {
    const router = new LLMRouter(config);

    // Access the private parseResponse method via prototype
    const result = (router as any).parseResponse(
      '{"agentName": "blog-articles", "confidence": 0.9, "reason": "Task is about writing content"}',
    );
    expect(result).toEqual({
      agentName: "blog-articles",
      confidence: 0.9,
      reason: "Task is about writing content",
    });
  });

  it("handles JSON wrapped in code fences", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse(
      '```json\n{"agentName": "temporal", "confidence": 0.8, "reason": "Workflow task"}\n```',
    );
    expect(result?.agentName).toBe("temporal");
  });

  it("returns null for unknown agent name", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse(
      '{"agentName": "nonexistent", "confidence": 0.9, "reason": "test"}',
    );
    expect(result).toBeNull();
  });

  it("returns null for empty agent name", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse(
      '{"agentName": "", "confidence": 0, "reason": "No suitable agent"}',
    );
    expect(result).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse("not json at all");
    expect(result).toBeNull();
  });

  it("clamps confidence to 0-1 range", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse(
      '{"agentName": "temporal", "confidence": 1.5, "reason": "test"}',
    );
    expect(result?.confidence).toBe(1);
  });

  it("defaults confidence when missing", () => {
    const router = new LLMRouter(config);
    const result = (router as any).parseResponse(
      '{"agentName": "temporal", "reason": "test"}',
    );
    expect(result?.confidence).toBe(0.5);
  });
});
