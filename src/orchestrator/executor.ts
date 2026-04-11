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
    const { parallel, sequential } = this.normalizePlan(plan);
    const parallelResults = await this.executeBatch(parallel, parentTaskId, results, true);
    if (parallelResults instanceof StepError) {
      this.store.updateTask(parentTaskId, {
        status: "failed",
        result: `Failed at ${parallelResults.stepId}: ${parallelResults.message}`,
      });
      return {
        parentTaskId,
        stepResults,
        status: "failed",
        failedStep: parallelResults.stepId,
        error: parallelResults.message,
      };
    }
    stepResults.push(...parallelResults);
    for (const stepResult of parallelResults) {
      results.set(stepResult.stepId, stepResult);
    }

    for (const step of sequential) {
      try {
        const stepResult = await this.executeStep(step, parentTaskId, results);
        results.set(step.id, stepResult);
        stepResults.push(stepResult);
      } catch (err) {
        if (err instanceof StepError) {
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

  private normalizePlan(plan: Plan): { parallel: PlanStep[]; sequential: PlanStep[] } {
    const steps = plan.steps ?? [];
    const stepOrder = new Map(steps.map((step, index) => [step.id, index]));
    const sortByPlanOrder = (items: PlanStep[]): PlanStep[] =>
      [...items].sort((a, b) => (stepOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (stepOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER));

    if (steps.length > 0) {
      return {
        parallel: sortByPlanOrder(steps.filter((step) => step.depends_on.length === 0)),
        sequential: sortByPlanOrder(steps.filter((step) => step.depends_on.length > 0)),
      };
    }

    return {
      parallel: sortByPlanOrder(plan.parallel ?? []),
      sequential: sortByPlanOrder(plan.sequential ?? []),
    };
  }

  private async executeBatch(
    steps: PlanStep[],
    parentTaskId: string,
    results: Map<string, StepResult>,
    parallel: boolean,
  ): Promise<StepResult[] | StepError> {
    if (steps.length === 0) return [];

    const controller = parallel ? new AbortController() : null;
    const promises = steps.map((step) =>
      this.executeStep(step, parentTaskId, results, controller?.signal).catch((err) => {
        if (controller && isAbortError(err)) {
          return null;
        }
        if (controller && !controller.signal.aborted) {
          controller.abort();
        }
        throw err;
      }),
    );

    try {
      const settled = await Promise.all(promises);
      return settled.filter((step): step is StepResult => step !== null);
    } catch (err) {
      if (err instanceof StepError) {
        return err;
      }
      throw err;
    }
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

  private async executeStep(
    step: PlanStep,
    parentTaskId: string,
    results: Map<string, StepResult>,
    signal?: AbortSignal,
  ): Promise<StepResult> {
    const message = this.buildStepMessage(step, results);

    try {
      const result = await this.dispatcher.dispatch(message, {
        agentName: step.agent,
        title: `[${step.id}] ${step.task.slice(0, 80)}`,
        parentTaskId,
        stepId: step.id,
        signal,
      });

      return {
        stepId: step.id,
        taskId: result.taskId,
        agentName: step.agent,
        response: result.response,
      };
    } catch (err) {
      if (signal?.aborted && isAbortError(err)) {
        throw err;
      }
      throw new StepError(step.id, step.agent, err instanceof Error ? err.message : String(err));
    }
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

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"));
}
