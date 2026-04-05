import { AgentClient, type AgentResponse } from "../client/agent-client.js";
import { Router } from "./router.js";
import { LLMRouter } from "./llm-router.js";
import { Planner, type Plan } from "./planner.js";
import { PlanExecutor, type ExecutionResult } from "./executor.js";
import { StateStore, type Task, type TaskSource, type TaskType } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { ulid } from "ulid";
import { createLogger } from "../service/logger.js";
import { validateGhAuth, GhAuthError } from "../triggers/github.js";
import { reportEscalation, DEFAULT_ESCALATION_RETRY_LIMIT } from "../triggers/reporters.js";

/** Maximum number of retry attempts for a failed dispatch. */
export const MAX_RETRIES = 3;

/** Backoff delays in milliseconds for each retry attempt (index = retry_count - 1). */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

/**
 * Maximum number of automatic retries for timeout failures (exit code 143 / SIGTERM).
 * Kept lower than MAX_RETRIES so transient timeouts self-heal quickly without burning
 * the full generic retry budget before the supervisor notices.
 */
export const TIMEOUT_RETRY_MAX = 2;

/**
 * Backoff in milliseconds before the first retry of a timeout failure.
 * 2 minutes gives the container/proxy time to recover before the next attempt.
 */
export const TIMEOUT_RETRY_BACKOFF_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Extract the owner/repo portion from a source_ref string like "owner/repo#42".
 * Returns undefined when the ref has no "#" separator or does not look like a
 * GitHub repo ref (e.g. "linear-check:agentName:2026-01-01T00").
 */
export function extractRepoFromSourceRef(sourceRef: string | undefined | null): string | undefined {
  if (!sourceRef) return undefined;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return undefined;
  const candidate = sourceRef.slice(0, hashIdx);
  // Must look like "owner/repo" — at least one slash present
  if (!candidate.includes("/")) return undefined;
  return candidate;
}

/**
 * Build the structured target-repo header injected at the top of every
 * dispatched message when a GitHub source_ref is available.  The header
 * makes the destination repository unambiguous, preventing agents from
 * accidentally opening PRs on the wrong repo (issue #338).
 */
export function buildTargetRepoHeader(sourceRef: string | undefined | null): string | undefined {
  const repo = extractRepoFromSourceRef(sourceRef);
  if (!repo) return undefined;
  return (
    `> **Target repository: \`${repo}\`**\n` +
    `> All git operations (branches, commits, PRs) for this task must target **${repo}** only.\n` +
    `> Do NOT open PRs or push branches to any other repository.\n`
  );
}

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
    this.client = new AgentClient(config, store);
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
      taskType?: TaskType;
      /** Resume an existing CLI session by reusing a prior conversation ID. */
      conversationId?: string;
      /**
       * The GitHub repo that triggered this task (e.g. "rapartlu/claude-proxy").
       * Passed to the router so cross-repo destination detection
       * (`scoreCrossRepoDestination` / `taskMentionsOtherAgent`) can activate.
       * Without this, both helpers return immediately and the deterministic
       * cross-repo routing logic never fires.
       */
      sourceRepo?: string;
    },
  ): Promise<DispatchResult> {
    // Resolve agent
    let agentName = options?.agentName;
    let routeReason = "Explicitly specified";

    if (!agentName) {
      const matches = await this.router.routeWithFallback(message, options?.sourceRepo);
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

    // Pre-flight: for GitHub-sourced tasks, verify gh is authenticated before
    // dispatching.  A missing/expired credential lets the agent push a branch
    // successfully (via SSH) but then fail on `gh pr create`, producing a silent
    // orphan branch.  Blocking here gives a clear error and keeps the issue in
    // the unprocessed queue so the daemon retries when auth recovers.
    if (options?.source === "github") {
      const authStatus = validateGhAuth();
      if (!authStatus.ok) {
        const reason = authStatus.reason ?? "gh CLI is not authenticated";
        this.log.error("GitHub dispatch blocked: gh auth pre-flight failed", {
          agentName,
          reason,
          sourceRef: options?.sourceRef,
        });
        throw new GhAuthError(
          `GH auth pre-flight failed — aborting dispatch to prevent orphan branch: ${reason}`,
          reason,
        );
      }
    }

    // Create task — reuse the caller's conversationId when provided (e.g. PR
    // feedback or revision tasks that should resume the agent's prior session).
    const conversationId = options?.conversationId ?? ulid();
    const taskType = options?.taskType ?? "implementation";
    const task = this.store.createTask({
      title: options?.title ?? message.slice(0, 100),
      description: message,
      source: options?.source ?? "manual",
      source_ref: options?.sourceRef,
      agent_name: agentName,
      task_type: taskType,
    });

    // Update to dispatched
    this.store.updateTask(task.id, {
      status: "dispatched",
      conversation_id: conversationId,
    });

    // Prepend the target-repo header so the agent always knows which repo to
    // target, even when instructions are deeply nested in a long message.
    const repoHeader = buildTargetRepoHeader(options?.sourceRef);
    const messageToSend = repoHeader ? `${repoHeader}\n${message}` : message;

    // Log the outgoing message
    this.log.info("Dispatching to agent", { taskId: task.id, agentName, title: task.title });
    this.store.addLog({
      task_id: task.id,
      direction: "to_agent",
      agent_name: agentName,
      content: messageToSend,
    });

    try {
      // Send to agent
      const response = await this.client.send(agentName, messageToSend, {
        conversationId,
        taskType,
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

    // Pre-flight: for GitHub-sourced tasks, skip the retry attempt (without
    // burning a retry slot) when gh is not authenticated.  Auth failures are
    // typically transient — the token may be refreshed before the next daemon
    // cycle.  Incrementing retry_count would waste budget on a problem the
    // agent cannot fix by retrying.
    if (task.source === "github") {
      const authStatus = validateGhAuth();
      if (!authStatus.ok) {
        const reason = authStatus.reason ?? "gh CLI is not authenticated";
        this.log.warn("Retry skipped: gh auth pre-flight failed — will try again next cycle", {
          taskId: task.id,
          agentName,
          reason,
        });
        // Restore next_retry_at so the task is eligible for the next cycle
        // without consuming a retry attempt.
        const deferredAt = new Date(Date.now() + RETRY_DELAYS_MS[0]).toISOString();
        this.store.updateTask(task.id, { next_retry_at: deferredAt });
        return;
      }
    }

    // Pre-retry escalation guard: if the cumulative failure count for this
    // source_ref (across all task records) already meets or exceeds the
    // configured escalation limit, escalate immediately rather than burning
    // another retry slot and consuming more agent tokens.
    if (task.source_ref) {
      const escalationLimit = this.config.escalation?.retry_limit ?? DEFAULT_ESCALATION_RETRY_LIMIT;
      if (escalationLimit > 0) {
        const totalFailures = this.store.countFailuresForSourceRef(task.source_ref);
        if (totalFailures >= escalationLimit) {
          this.log.warn("Escalating task: retry limit for source_ref exceeded (pre-retry check)", {
            taskId: task.id,
            agentName,
            sourceRef: task.source_ref,
            totalFailures,
            escalationLimit,
          });
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Escalated: source_ref "${task.source_ref}" has ${totalFailures} cumulative failure(s) — limit is ${escalationLimit}. No further retries will be attempted.`,
          });
          this.store.updateTask(task.id, {
            status: "escalated",
            result: `Escalated: exceeded ${escalationLimit} cumulative retry attempt(s) across all tasks for source_ref "${task.source_ref}". Manual intervention required.`,
            next_retry_at: null,
          });
          reportEscalation(this.config, this.store.getTask(task.id) ?? task, escalationLimit);
          return;
        }
      }
    }

    const message = task.description ?? task.title;
    const conversationId = task.conversation_id ?? ulid();
    const repoHeader = buildTargetRepoHeader(task.source_ref);
    const messageToSend = repoHeader ? `${repoHeader}\n${message}` : message;

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
      const response = await this.client.send(agentName, messageToSend, { conversationId });

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

      // Determine whether to escalate, retry, or permanently fail.
      const escalationLimit = this.config.escalation?.retry_limit ?? DEFAULT_ESCALATION_RETRY_LIMIT;
      const shouldEscalate = escalationLimit > 0 && newRetryCount >= escalationLimit;
      const willRetry = !shouldEscalate && newRetryCount < MAX_RETRIES;
      const nextRetryAt = willRetry
        ? new Date(Date.now() + (RETRY_DELAYS_MS[newRetryCount - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1])).toISOString()
        : null;

      this.log.error("Retry failed", {
        taskId: task.id,
        agentName,
        error: errorMsg,
        willRetry,
        shouldEscalate,
        retryCount: newRetryCount,
        escalationLimit,
      });

      if (shouldEscalate) {
        const escalationMsg =
          `Escalated after ${newRetryCount} retry attempt(s): ${errorMsg}. ` +
          `Manual intervention required — orchestrator will no longer retry this task automatically.`;
        this.store.addLog({
          task_id: task.id,
          direction: "system",
          content: `Retry error: ${errorMsg} — escalation threshold (${escalationLimit}) reached after ${newRetryCount} attempt(s). Task escalated.`,
        });
        this.store.updateTask(task.id, {
          status: "escalated",
          result: escalationMsg,
          retry_count: newRetryCount,
          next_retry_at: null,
        });
        // Report escalation back to the source (e.g. GitHub issue comment).
        reportEscalation(this.config, this.store.getTask(task.id) ?? { ...task, result: escalationMsg, retry_count: newRetryCount }, escalationLimit);
      } else {
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
