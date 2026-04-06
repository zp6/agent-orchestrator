import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { PromptLearner } from "./prompt-learner.js";
import type { StateStore } from "../state/store.js";
import { ulid } from "ulid";

export interface PlanStep {
  id: string;
  agent: string;
  task: string;
  depends_on: string[];
}

export interface Plan {
  id: string;
  original_task: string;
  is_multi_agent: boolean;
  steps: PlanStep[];
}

export class Planner {
  private learner?: PromptLearner;

  constructor(private config: OrchestratorConfig, store?: StateStore) {
    if (store) {
      this.learner = new PromptLearner(store);
    }
  }

  async plan(task: string): Promise<Plan> {
    const registry = this.buildRegistryPrompt() + (this.learner?.buildPlannerContext() ?? "");
    const client = createLLMClient(this.config
    );

    const response = await client.messages.create({
      model: getLLMModel(this.config, "planner"),
      max_tokens: 4096,
      system: registry,
      messages: [{ role: "user", content: task }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? b.text : "")
      .join("");

    const plan = this.parseResponse(text, task);
    this.validate(plan);
    return plan;
  }

  private buildRegistryPrompt(): string {
    const agentList = Object.entries(this.config.agents)
      .map(([name, agent]) =>
        `- **${name}**: ${agent.description}\n  Capabilities: ${agent.capabilities.join(", ")}\n  Topics: ${agent.owns_topics.join(", ")}`,
      )
      .join("\n");

    return `You are a task planner for a multi-agent system. Analyze the given task and decide whether it needs one agent or multiple agents working together.

Available agents:
${agentList}

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "is_multi_agent": true/false,
  "steps": [
    {
      "id": "step-1",
      "agent": "<agent-name>",
      "task": "<clear instruction for this agent>",
      "depends_on": []
    },
    {
      "id": "step-2",
      "agent": "<agent-name>",
      "task": "<instruction, may reference output from prior steps>",
      "depends_on": ["step-1"]
    }
  ]
}

Rules:
- For simple tasks that one agent can handle, set is_multi_agent to false with a single step.
- For complex tasks, break them into discrete steps with clear dependencies.
- Steps with no dependencies can run in parallel.
- Each step's task should be self-contained and actionable.
- Only use agent names from the list above.`;
  }

  private parseResponse(text: string, originalTask: string): Plan {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();

    let parsed: { is_multi_agent: boolean; steps: PlanStep[] };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Failed to parse planner response as JSON: ${cleaned.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error("Planner returned empty or invalid steps");
    }

    return {
      id: ulid(),
      original_task: originalTask,
      is_multi_agent: parsed.is_multi_agent ?? parsed.steps.length > 1,
      steps: parsed.steps,
    };
  }

  private validate(plan: Plan): void {
    const stepIds = new Set(plan.steps.map((s) => s.id));

    for (const step of plan.steps) {
      // Validate agent exists
      if (!this.config.agents[step.agent]) {
        throw new Error(
          `Plan references unknown agent "${step.agent}". Available: ${Object.keys(this.config.agents).join(", ")}`,
        );
      }

      // Validate dependencies reference real steps
      for (const dep of step.depends_on) {
        if (!stepIds.has(dep)) {
          throw new Error(`Step "${step.id}" depends on unknown step "${dep}"`);
        }
      }
    }

    // Validate DAG (no cycles) via topological sort
    this.topologicalSort(plan.steps);
  }

  /** Returns steps in topological order. Throws if there's a cycle. */
  topologicalSort(steps: PlanStep[]): PlanStep[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();
    const stepMap = new Map<string, PlanStep>();

    for (const step of steps) {
      stepMap.set(step.id, step);
      inDegree.set(step.id, step.depends_on.length);
      for (const dep of step.depends_on) {
        const edges = adjacency.get(dep) ?? [];
        edges.push(step.id);
        adjacency.set(dep, edges);
      }
    }

    const queue = steps.filter((s) => s.depends_on.length === 0).map((s) => s.id);
    const sorted: PlanStep[] = [];

    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(stepMap.get(id)!);

      for (const next of adjacency.get(id) ?? []) {
        const degree = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, degree);
        if (degree === 0) {
          queue.push(next);
        }
      }
    }

    if (sorted.length !== steps.length) {
      throw new Error("Plan contains a dependency cycle");
    }

    return sorted;
  }
}
