import type { AgentResponse } from "../client/agent-client.js";
import type { Dispatcher } from "./dispatcher.js";
import type { StateStore } from "../state/store.js";
import type { Plan, PlanStep } from "./planner.js";

export interface StepResult {
  stepId: string;
  taskId: string;
  agentName: string;
  response: AgentResponse;
}

export interface ExecutionResult {
  parentTaskId: string;
  stepResults: StepResult[];
  status: "done" | "failed";
  failedStep?: string;
  error?: string;
}

export class PlanExecutor {
  constructor(
    private dispatcher: Dispatcher,
    private store: StateStore,
  ) {}

  async execute(plan: Plan, parentTaskId: string): Promise<ExecutionResult> {
    const results = new Map<string, StepResult>();
    const stepResults: StepResult[] = [];
    const layers = this.buildLayers(plan.steps);

    for (const layer of layers) {
      const layerPromises = layer.map(async (step) => {
        const message = this.buildStepMessage(step, results);

        // Create sub-task
        const subTask = this.store.createSubTask({
          parent_task_id: parentTaskId,
          step_id: step.id,
          title: `[${step.id}] ${step.task.slice(0, 80)}`,
          description: step.task,
          source: "manual",
          agent_name: step.agent,
        });

        try {
          const result = await this.dispatcher.dispatch(message, {
            agentName: step.agent,
            title: subTask.title,
          });

          const stepResult: StepResult = {
            stepId: step.id,
            taskId: result.taskId,
            agentName: step.agent,
            response: result.response,
          };
          results.set(step.id, stepResult);
          return stepResult;
        } catch (err) {
          this.store.updateTask(subTask.id, { status: "failed", result: String(err) });
          throw new StepError(step.id, step.agent, err instanceof Error ? err.message : String(err));
        }
      });

      try {
        const layerResults = await Promise.all(layerPromises);
        stepResults.push(...layerResults);
      } catch (err) {
        if (err instanceof StepError) {
          // Update parent task
          this.store.updateTask(parentTaskId, {
            status: "failed",
            result: `Failed at ${err.stepId}: ${err.message}`,
          });
          return {
            parentTaskId,
            stepResults,
            status: "failed",
            failedStep: err.stepId,
            error: err.message,
          };
        }
        throw err;
      }
    }

    // Aggregate results
    const aggregated = stepResults
      .map((r) => `## ${r.stepId} (${r.agentName}):\n${r.response.content}`)
      .join("\n\n");

    this.store.updateTask(parentTaskId, {
      status: "done",
      result: aggregated,
    });

    return { parentTaskId, stepResults, status: "done" };
  }

  /** Group steps into parallel execution layers via topological sort. */
  private buildLayers(steps: PlanStep[]): PlanStep[][] {
    const layers: PlanStep[][] = [];
    const completed = new Set<string>();
    const remaining = new Map(steps.map((s) => [s.id, s]));

    while (remaining.size > 0) {
      const layer: PlanStep[] = [];
      for (const [id, step] of remaining) {
        if (step.depends_on.every((dep) => completed.has(dep))) {
          layer.push(step);
        }
      }

      if (layer.length === 0) {
        throw new Error("Deadlock: no steps can execute (dependency cycle?)");
      }

      for (const step of layer) {
        remaining.delete(step.id);
        completed.add(step.id);
      }
      layers.push(layer);
    }

    return layers;
  }

  /** Build the message for a step, injecting context from completed dependencies. */
  private buildStepMessage(step: PlanStep, results: Map<string, StepResult>): string {
    if (step.depends_on.length === 0) {
      return step.task;
    }

    const contextParts = step.depends_on
      .map((depId) => {
        const depResult = results.get(depId);
        if (!depResult) return null;
        return `## Context from ${depId} (${depResult.agentName}):\n${depResult.response.content}`;
      })
      .filter(Boolean);

    if (contextParts.length === 0) {
      return step.task;
    }

    return `${contextParts.join("\n\n")}\n\n---\n\nYour task: ${step.task}`;
  }
}

class StepError extends Error {
  constructor(
    public stepId: string,
    public agentName: string,
    message: string,
  ) {
    super(message);
    this.name = "StepError";
  }
}
