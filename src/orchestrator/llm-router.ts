import { createLLMClient, getLLMModel } from "../client/llm-client.js";
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

  async route(task: string, sourceRepo?: string): Promise<LLMRouteResult | null> {
    const registry = this.buildRegistryPrompt(sourceRepo) + (this.learner?.buildRouterContext() ?? "");
    const { client, model } = createLLMClient(this.config);

    try {
      const response = await client.messages.create({
        model: getLLMModel(this.config, "router") ?? model,
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

  private buildRegistryPrompt(sourceRepo?: string): string {
    const agentList = Object.entries(this.config.agents)
      .map(([name, agent]) =>
        `- **${name}** (repo: ${agent.github ?? "none"}): ${agent.description}\n  Capabilities: ${agent.capabilities.join(", ")}\n  Topics: ${agent.owns_topics.join(", ")}`,
      )
      .join("\n");

    const sourceNote = sourceRepo
      ? `\nThis task was triggered from the repo: ${sourceRepo}. The triggering repo is NOT necessarily the destination — read the task carefully.\n`
      : "";

    return `You are a task router. Given a task description, pick the most appropriate agent to handle it.

Available agents:
${agentList}
${sourceNote}
ROUTING RULES:
1. Match the agent whose capabilities and owned topics best fit the task.
2. INTEGRATION TASKS: When a task uses integration phrasing such as "wire X into Y",
   "integrate X with Y", "integrate X into Y", "plug X into Y", "use X in Y", or
   "add X to Y" — route to the agent that OWNS THE DESTINATION SYSTEM (Y), not the
   source system (X). The destination is the system being modified to consume or
   integrate with the source. Example: "wire reviewer package into orchestrator daemon"
   should route to the orchestrator agent (it owns the daemon), NOT the reviewer agent.
3. CROSS-REPO TASKS: If the task description explicitly names a specific repo or agent
   (e.g. "update claude-agent-orchestrator to...", "in rapartlu/agent-proxy, add..."),
   route to the agent that OWNS THAT NAMED REPO, even if the task was triggered from a
   different repo. The destination repo mentioned in the task body takes priority over
   the triggering source repo.

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
