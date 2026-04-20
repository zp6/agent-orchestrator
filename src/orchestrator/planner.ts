import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { PromptLearner } from "./prompt-learner.js";
import type { StateStore } from "../state/store.js";
import { ulid } from "ulid";
import { cacheableSplitPrompt } from "../utils/prompt-cache.js";

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
  parallel?: PlanStep[];
  sequential?: PlanStep[];
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
    const { staticPrefix, dynamicSuffix } = this.buildRegistryPromptParts();
    const learnerCtx = this.learner?.buildPlannerContext() ?? "";
    const { client, model } = createLLMClient(this.config, "planner");

    const response = await client.messages.create({
      model: getLLMModel(this.config, "planner") ?? model,
      max_tokens: 4096,
      system: cacheableSplitPrompt(staticPrefix, dynamicSuffix + learnerCtx),
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

  /** Split the registry prompt into cacheable static prefix + dynamic suffix. */
  private buildRegistryPromptParts(): { staticPrefix: string; dynamicSuffix: string } {
    const agentList = Object.entries(this.config.agents)
      .map(([name, agent]) =>
        `- **${name}**: ${agent.description}\n  Capabilities: ${agent.capabilities.join(", ")}\n  Topics: ${agent.owns_topics.join(", ")}`,
      )
      .join("\n");

    const staticPrefix = [
      "You are a task planner for a multi-agent system. Analyze the given task and decide whether it needs one agent or multiple agents working together.",
      "",
      "Respond with ONLY a JSON object (no markdown, no code fences):",
      "{",
      '  "is_multi_agent": true/false,',
      '  "parallel": [',
      "    {",
      '      "id": "step-1",',
      '      "agent": "<agent-name>",',
      '      "task": "<clear instruction for this agent>",',
      '      "depends_on": []',
      "    }",
      "  ],",
      '  "sequential": [',
      "    {",
      '      "id": "step-2",',
      '      "agent": "<agent-name>",',
      '      "task": "<instruction that runs after the parallel batch>",',
      '      "depends_on": ["step-1"]',
      "    }",
      "  ]",
      "}",
      "",
      "Rules:",
      "- For simple tasks that one agent can handle, set is_multi_agent to false with a single step.",
      "- For complex tasks, break them into a parallel batch plus any sequential follow-up steps.",
      '- Put at most 4 independent steps in "parallel".',
      '- Each item in "parallel" must have an empty "depends_on" array.',
      '- "sequential" steps may depend on "parallel" results and/or earlier sequential steps.',
      "- Each step's task should be self-contained and actionable.",
      "- Only use agent names from the list above.",
    ].join("\n");

    const dynamicSuffix = `\n\nAvailable agents:\n${agentList}`;

    return { staticPrefix, dynamicSuffix };
  }

  private buildRegistryPrompt(): string {
    const { staticPrefix, dynamicSuffix } = this.buildRegistryPromptParts();
    return staticPrefix + dynamicSuffix;
  }

  private parseResponse(text: string, originalTask: string): Plan {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();

    let parsed: {
      is_multi_agent?: boolean;
      parallel?: PlanStep[];
      sequential?: PlanStep[];
      steps?: PlanStep[];
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Failed to parse planner response as JSON: ${cleaned.slice(0, 200)}`);
    }

    const { parallel, sequential, steps } = this.normalizePlanShape(parsed);
    if (parallel.length + sequential.length === 0) {
      throw new Error("Planner returned empty or invalid steps");
    }

    const combined = [...parallel, ...sequential];
    return {
      id: ulid(),
      original_task: originalTask,
      is_multi_agent: parsed.is_multi_agent ?? combined.length > 1,
      parallel,
      sequential,
      steps: steps ?? this.topologicalSort(combined),
    };
  }

  private normalizePlanShape(parsed: {
    parallel?: PlanStep[];
    sequential?: PlanStep[];
    steps?: PlanStep[];
  }): { parallel: PlanStep[]; sequential: PlanStep[]; steps?: PlanStep[] } {
    if (Array.isArray(parsed.parallel) || Array.isArray(parsed.sequential)) {
      const parallel = this.normalizeSteps(parsed.parallel ?? []);
      const sequential = this.normalizeSteps(parsed.sequential ?? []);
      return { parallel, sequential };
    }

    const legacySteps = this.normalizeSteps(parsed.steps ?? []);
    const parallel = legacySteps.filter((step) => step.depends_on.length === 0);
    const sequential = legacySteps.filter((step) => step.depends_on.length > 0);
    return { parallel, sequential };
  }

  private normalizeSteps(steps: PlanStep[]): PlanStep[] {
    return steps.map((step) => ({
      id: step.id,
      agent: step.agent,
      task: step.task,
      depends_on: Array.from(new Set(step.depends_on ?? [])),
    }));
  }

  private validate(plan: Plan): void {
    const legacySteps = Array.isArray(plan.steps) && plan.steps.length > 0 ? plan.steps : [];
    const parallel = Array.isArray(plan.parallel) && plan.parallel.length > 0
      ? plan.parallel
      : legacySteps.filter((step) => step.depends_on.length === 0);
    const sequential = Array.isArray(plan.sequential) && plan.sequential.length > 0
      ? plan.sequential
      : legacySteps.filter((step) => step.depends_on.length > 0);
    const allSteps = legacySteps.length > 0 ? legacySteps : [...parallel, ...sequential];
    const stepIds = new Set(allSteps.map((s) => s.id));

    if (parallel.length > 4) {
      throw new Error(`Planner returned ${parallel.length} parallel steps; maximum is 4`);
    }

    for (const step of allSteps) {
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

    for (const step of parallel) {
      if (step.depends_on.length > 0) {
        throw new Error(`Parallel step "${step.id}" cannot declare dependencies`);
      }
    }

    // Validate DAG (no cycles) via topological sort
    this.topologicalSort(allSteps);
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
