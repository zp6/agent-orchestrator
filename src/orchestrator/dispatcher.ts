import { AgentClient, type AgentResponse } from "../client/agent-client.js";
import { Router } from "./router.js";
import { LLMRouter } from "./llm-router.js";
import { Planner, type Plan } from "./planner.js";
import { PlanExecutor, type ExecutionResult } from "./executor.js";
import { StateStore, type Task, type TaskSource } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { ulid } from "ulid";
import { createLogger } from "../service/logger.js";

/** Maximum number of retry attempts for a failed dispatch. */
export const MAX_RETRIES = 3;

/** Backoff delays in milliseconds for each retry attempt (index = retry_count - 1). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

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
      const newRetryCount = (task.retry_count ?? 0) + 1;
      // Use strict less-than so that once retry_count == MAX_RETRIES the task is
      // permanently failed (next_retry_at = null).  getRetryableTasks() uses the
      // same boundary (retry_count < maxRetries) so both sides stay consistent.
      const willRetry = newRetryCount < MAX_RETRIES;
      const nextRetryAt = willRetry
        ? new Date(Date.now() + (RETRY_DELAYS_MS[newRetryCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])).toISOString()
        : null;

      this.log.error("Task failed", { taskId: task.id, agentName, error: errorMsg, willRetry, retryCount: newRetryCount });
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        content: willRetry
          ? `Error: ${errorMsg} — retry ${newRetryCount}/${MAX_RETRIES} scheduled at ${nextRetryAt}`
          : `Error: ${errorMsg} — max retries (${MAX_RETRIES}) exceeded, task permanently failed`,
      });
      this.store.updateTask(task.id, {
        status: "failed",
        result: errorMsg,
        retry_count: newRetryCount,
        next_retry_at: nextRetryAt,
      });
      throw err;
    }
  }

  /**
   * Retry an existing failed task. Resets the task status and re-sends the
   * original message to the agent without creating a new task record.
   */
  async retryTask(task: Task): Promise<void> {
    const agentName = task.agent_name;
    if (!agentName) {
      this.log.warn("Cannot retry task without agent_name", { taskId: task.id });
      this.store.updateTask(task.id, {
        status: "failed",
        result: "Cannot retry: no agent assigned",
        next_retry_at: null,
      });
      return;
    }

    if (!this.config.agents[agentName]) {
      this.log.warn("Cannot retry task: unknown agent", { taskId: task.id, agentName });
      this.store.updateTask(task.id, {
        status: "failed",
        result: `Cannot retry: unknown agent "${agentName}"`,
        next_retry_at: null,
      });
      return;
    }

    const message = task.description ?? task.title;
    const conversationId = task.conversation_id ?? ulid();

    // Reset to dispatched for this attempt
    this.store.updateTask(task.id, {
      status: "dispatched",
      next_retry_at: null,
      conversation_id: conversationId,
    });

    this.log.info("Retrying task", { taskId: task.id, agentName, retryCount: task.retry_count });
    this.store.addLog({
      task_id: task.id,
      direction: "system",
      content: `Retry attempt ${task.retry_count} of ${MAX_RETRIES}`,
    });

    try {
      const response = await this.client.send(agentName, message, { conversationId });

      this.store.addLog({
        task_id: task.id,
        direction: "from_agent",
        agent_name: agentName,
        content: response.content,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens,
      });

      this.log.info("Retry succeeded", { taskId: task.id, agentName });
      this.store.updateTask(task.id, {
        status: "done",
        result: response.content,
        next_retry_at: null,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newRetryCount = task.retry_count + 1;
      const willRetry = newRetryCount < MAX_RETRIES;
      const nextRetryAt = willRetry
        ? new Date(Date.now() + (RETRY_DELAYS_MS[newRetryCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])).toISOString()
        : null;

      this.log.error("Retry failed", { taskId: task.id, agentName, error: errorMsg, willRetry, retryCount: newRetryCount });
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        content: willRetry
          ? `Retry error: ${errorMsg} — retry ${newRetryCount}/${MAX_RETRIES} scheduled at ${nextRetryAt}`
          : `Retry error: ${errorMsg} — max retries (${MAX_RETRIES}) exceeded, task permanently failed`,
      });
      this.store.updateTask(task.id, {
        status: "failed",
        result: errorMsg,
        retry_count: newRetryCount,
        next_retry_at: nextRetryAt,
      });
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
