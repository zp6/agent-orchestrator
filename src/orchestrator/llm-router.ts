import { createLLMClient } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { PromptLearner } from "./prompt-learner.js";
import type { StateStore } from "../state/store.js";

export interface LLMRouteResult {
  agentName: string;
  confidence: number;
  reason: string;
}

export class LLMRouter {
  private learner?: PromptLearner;

  constructor(private config: OrchestratorConfig, store?: StateStore) {
    if (store) {
      this.learner = new PromptLearner(store);
    }
  }

  async route(task: string): Promise<LLMRouteResult | null> {
    const registry = this.buildRegistryPrompt() + (this.learner?.buildRouterContext() ?? "");
    const client = createLLMClient(this.config
    );

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: registry,
        messages: [{ role: "user", content: task }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parseResponse(text);
    } catch {
      return null;
    }
  }

  private buildRegistryPrompt(): string {
    const agentList = Object.entries(this.config.agents)
      .map(([name, agent]) =>
        `- **${name}**: ${agent.description}\n  Capabilities: ${agent.capabilities.join(", ")}\n  Topics: ${agent.owns_topics.join(", ")}`,
      )
      .join("\n");

    return `You are a task router. Given a task description, pick the most appropriate agent to handle it.

Available agents:
${agentList}

Respond with ONLY a JSON object (no markdown, no code fences):
{"agentName": "<name>", "confidence": <0.0-1.0>, "reason": "<brief reason>"}

If no agent is a good fit, respond with:
{"agentName": "", "confidence": 0, "reason": "No suitable agent found"}`;
  }

  private parseResponse(text: string): LLMRouteResult | null {
    try {
      // Strip markdown code fences if present
      const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(cleaned) as LLMRouteResult;

      if (!parsed.agentName || !this.config.agents[parsed.agentName]) {
        return null;
      }

      return {
        agentName: parsed.agentName,
        confidence: Math.min(Math.max(parsed.confidence ?? 0.5, 0), 1),
        reason: parsed.reason ?? "LLM routing",
      };
    } catch {
      return null;
    }
  }
}
