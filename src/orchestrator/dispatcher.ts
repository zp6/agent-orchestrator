import { AgentClient, type AgentResponse } from "../client/agent-client.js";
import { Router } from "./router.js";
import { LLMRouter } from "./llm-router.js";
import { Planner, type Plan } from "./planner.js";
import { PlanExecutor, type ExecutionResult } from "./executor.js";
import { StateStore, type TaskSource } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { ulid } from "ulid";
import { createLogger } from "../service/logger.js";

export interface DispatchResult {
  taskId: string;
  agentName: string;
  response: AgentResponse;
}

export class Dispatcher {
  private client: AgentClient;
  private router: Router;
  private store: StateStore;
  private planner: Planner;
  private log = createLogger("dispatcher");

  constructor(
    private config: OrchestratorConfig,
    store: StateStore,
  ) {
    this.client = new AgentClient(config);
    const llmRouter = new LLMRouter(config, store);
    this.router = new Router(config, llmRouter);
    this.store = store;
    this.planner = new Planner(config, store);
  }

  async dispatch(
    message: string,
    options?: {
      agentName?: string;
      source?: TaskSource;
      sourceRef?: string;
      title?: string;
    },
  ): Promise<DispatchResult> {
    // Resolve agent
    let agentName = options?.agentName;
    let routeReason = "Explicitly specified";

    if (!agentName) {
      const matches = await this.router.routeWithFallback(message);
      if (matches.length === 0) {
        throw new Error(
          "Could not determine which agent to route to. Specify --agent explicitly.",
        );
      }
      agentName = matches[0].agentName;
      routeReason = `Auto-routed (${matches[0].reason}, confidence: ${matches[0].confidence.toFixed(2)})`;
      this.log.info("Routed task", { agentName, reason: routeReason, confidence: matches[0].confidence });
    }

    // Validate agent exists
    if (!this.config.agents[agentName]) {
      throw new Error(
        `Unknown agent: ${agentName}. Available: ${Object.keys(this.config.agents).join(", ")}`,
      );
    }

    // Create task
    const conversationId = ulid();
    const task = this.store.createTask({
      title: options?.title ?? message.slice(0, 100),
      description: message,
      source: options?.source ?? "manual",
      source_ref: options?.sourceRef,
      agent_name: agentName,
    });

    // Update to dispatched
    this.store.updateTask(task.id, {
      status: "dispatched",
      conversation_id: conversationId,
    });

    // Log the outgoing message
    this.log.info("Dispatching to agent", { taskId: task.id, agentName, title: task.title });
    this.store.addLog({
      task_id: task.id,
      direction: "to_agent",
      agent_name: agentName,
      content: message,
    });

    try {
      // Send to agent
      const response = await this.client.send(agentName, message, {
        conversationId,
      });

      // Log the response
      this.store.addLog({
        task_id: task.id,
        direction: "from_agent",
        agent_name: agentName,
        content: response.content,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens,
      });

      // Update task to done
      this.log.info("Task completed", { taskId: task.id, agentName, tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens });
      this.store.updateTask(task.id, {
        status: "done",
        result: response.content,
      });

      return { taskId: task.id, agentName, response };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.log.error("Task failed", { taskId: task.id, agentName, error: errorMsg });
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        content: `Error: ${errorMsg}`,
      });
      this.store.updateTask(task.id, {
        status: "failed",
        result: errorMsg,
      });
      throw err;
    }
  }

  async planTask(message: string): Promise<Plan> {
    return this.planner.plan(message);
  }

  async dispatchWithPlan(
    message: string,
    options?: {
      source?: TaskSource;
      sourceRef?: string;
      title?: string;
    },
  ): Promise<ExecutionResult> {
    // Create parent task
    const parentTask = this.store.createTask({
      title: options?.title ?? message.slice(0, 100),
      description: message,
      source: options?.source ?? "manual",
      source_ref: options?.sourceRef,
    });
    this.store.updateTask(parentTask.id, { status: "planning" });

    try {
      const plan = await this.planner.plan(message);

      // Store plan on parent task
      this.store.updateTask(parentTask.id, { plan: JSON.stringify(plan) });

      // Single-agent plan: delegate to normal dispatch
      if (!plan.is_multi_agent && plan.steps.length === 1) {
        const step = plan.steps[0];
        const result = await this.dispatch(message, {
          agentName: step.agent,
          source: options?.source,
          sourceRef: options?.sourceRef,
          title: options?.title,
        });

        this.store.updateTask(parentTask.id, {
          status: "done",
          agent_name: step.agent,
          result: result.response.content,
        });

        return {
          parentTaskId: parentTask.id,
          stepResults: [{
            stepId: step.id,
            taskId: result.taskId,
            agentName: step.agent,
            response: result.response,
          }],
          status: "done",
        };
      }

      // Multi-agent plan: use executor
      this.store.updateTask(parentTask.id, { status: "dispatched" });
      const executor = new PlanExecutor(this, this.store);
      return executor.execute(plan, parentTask.id);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.store.updateTask(parentTask.id, {
        status: "failed",
        result: errorMsg,
      });
      throw err;
    }
  }
}
