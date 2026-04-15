import { AgentClient, type AgentResponse } from "../client/agent-client.js";
import { Router, LLM_FALLBACK_THRESHOLD } from "./router.js";
import { LLMRouter } from "./llm-router.js";
import { Planner, type Plan } from "./planner.js";
import { PlanExecutor, type ExecutionResult } from "./executor.js";
import { StateStore, type Task, type TaskSource, type TaskType, type AgentHealth } from "../state/store.js";
import { type OrchestratorConfig, getPoolMembers } from "../config/schema.js";
import { ulid } from "ulid";
import { createLogger } from "../service/logger.js";
import { validateGhAuth, GhAuthError, countOpenPRs } from "../triggers/github.js";
import { cachedValidateForDispatch } from "../triggers/issue-state-bridge.js";
import { checkDuplicate } from "../triggers/duplicate-guard.js";
import { reportEscalation, DEFAULT_ESCALATION_RETRY_LIMIT } from "../triggers/reporters.js";
import { buildRejectionHistoryBlock } from "./rejection-history.js";
import { getAndApplyRules } from "./learned-rules.js";
import { runAntibodyPreDispatchCheck } from "./antibody-filter.js";
import {
  findBestReferenceImplementation,
  buildReferenceImplementationBlock,
} from "./reference-implementation.js";
import { notifyOperator } from "../service/notify.js";
import { resolveAgentBudget } from "../cli/commands/budget.js";
import {
  isRateLimitError,
  markProviderExhausted,
  markProviderAvailable,
  isProviderAvailable,
  parseResetTime,
} from "../service/provider-state.js";
import { routeModel } from "./model-router.js";
import { detectAndCreateFollowUps, formatFollowUpNote } from "./cross-repo-tracker.js";
import {
  detectMultiRepoChangeSets,
  createCoordinationGroup,
  checkAndAdvanceCoordination,
} from "./multi-repo-coordinator.js";
import {
  runGitHubPreDispatchValidation,
  type PreDispatchValidationResult,
} from "./pre-dispatch-validator.js";
import {
  checkCapabilityEnforcement,
  runRemoteCapabilityCheck,
  type CapabilityEnforcementReroute,
} from "./capability-enforcer.js";

/**
 * Walk the parent_task_id chain upward from `taskId` (or a parent task id) and
 * return the depth the *new* task would be at.
 *
 * Depth definition:
 *   - A root task (no parent) is at depth 0.
 *   - A direct follow-up of a root task is at depth 1.
 *   - And so on.
 *
 * @param parentTaskId The parent_task_id of the task about to be created.
 *   Pass `undefined` for root tasks (depth will be 0).
 * @param store        The state store used to resolve parent tasks.
 * @param maxWalk      Safety guard — stops walking after this many hops to
 *   prevent infinite loops on corrupt chains.  Defaults to 20.
 * @returns The depth of the new task (parent's depth + 1, or 0 for roots).
 */
export function computeChainDepth(
  parentTaskId: string | undefined | null,
  store: StateStore,
  maxWalk = 20,
): number {
  if (!parentTaskId) return 0;

  let depth = 0;
  let currentId: string | null = parentTaskId;

  for (let i = 0; i < maxWalk; i++) {
    if (!currentId) break;
    const task = store.getTask(currentId);
    if (!task) break;
    depth++;
    currentId = task.parent_task_id ?? null;
  }

  return depth;
}

/** Default maximum follow-up chain depth before a task is escalated instead of dispatched. */
export const DEFAULT_MAX_FOLLOWUP_DEPTH = 3;

/** Maximum number of retry attempts for a failed dispatch. */
export const MAX_RETRIES = 3;
export const FAILURE_REROUTE_THRESHOLD = 3;

/**
 * Default backoff delays in milliseconds for each retry attempt (index = retry_count - 1).
 * Configurable via `dispatch.retry_delays_ms` in agents.yaml.
 */
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
 * Maximum number of automatic retry attempts for connection errors
 * (ECONNREFUSED, ETIMEDOUT, HTTP 5xx, etc.) before the task is permanently
 * failed with reason "connection-error-exhausted".
 *
 * Configurable via `retry.max_connection_retries` in agents.yaml.
 */
export const MAX_CONNECTION_RETRIES = 3;

/**
 * Default backoff delays for connection-error retries (30s → 60s → 120s).
 * Unlike generic retry delays, these are short because connection errors are
 * caused by transient container restarts or network blips — the container
 * typically recovers within seconds.
 *
 * Configurable via `retry.connection_error_delays_ms` in agents.yaml.
 */
export const CONNECTION_ERROR_RETRY_DELAYS_MS = [30_000, 60_000, 120_000] as const;

/**
 * Detect whether an error is a transient connection failure that warrants an
 * automatic retry.  Connection errors are categorically different from logic
 * errors (bad agent output, invalid instructions) because they are caused by
 * infrastructure problems — container restarts, network blips, proxy 5xx —
 * not by the task content.
 *
 * Recognised patterns:
 * - Node.js network error codes: ECONNREFUSED, ETIMEDOUT, ECONNRESET, ENOTFOUND
 * - HTTP 5xx status codes (Anthropic SDK wraps these as errors with `.status`)
 * - Generic "connection error" / "connection refused" phrases in the message
 * - Proxy spawn failures: "Failed to spawn claude CLI" (E2BIG, ENOENT, EAGAIN)
 *   which are transient infrastructure errors when the container or CLI isn't
 *   ready yet. The proxy returns 503 for these.
 *
 * Logic errors (bad output, wrong tool call, etc.) and timeout errors
 * (exit code 143 / SIGTERM handled by the daemon watchdog) are NOT
 * connection errors and must return false.
 */
export function isConnectionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Node.js network error codes
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("connection error") ||
    msg.includes("connection refused") ||
    msg.includes("network error") ||
    msg.includes("socket hang up") ||
    msg.includes("connect ehostunreach")
  ) {
    return true;
  }

  // Proxy CLI spawn failures — transient infrastructure errors (E2BIG, ENOENT
  // on working directory, EAGAIN under memory pressure).  The proxy returns
  // these as 503 with "Failed to spawn claude CLI" in the message body.
  if (
    msg.includes("failed to spawn") ||
    msg.includes("e2big") ||
    msg.includes("spawn enoent") ||
    msg.includes("eagain")
  ) {
    return true;
  }

  // HTTP 5xx status codes from the Anthropic SDK / proxy
  if (err instanceof Error && "status" in err) {
    const status = (err as Error & { status?: unknown }).status;
    if (typeof status === "number" && status >= 500 && status < 600) {
      return true;
    }
  }

  return false;
}

/**
 * Select the healthiest pool instance from a list of pool members.
 * Prefers instances that are:
 *   1. Idle (no active task)
 *   2. Healthy (fewer consecutive failures)
 *   3. Least recently errored (longest time since last failure)
 *
 * When all instances are unhealthy, falls back to the one with the fewest
 * consecutive failures and the oldest last_error_at timestamp (most likely
 * to have recovered).
 */
/** Round-robin counter for pool dispatch — distributes work across providers. */
let poolRRIndex = 0;

export function selectHealthiestPoolInstance(
  members: string[],
  healthRecords: AgentHealth[],
  hasActiveTask: (name: string) => boolean,
): string {
  if (members.length === 0) {
    throw new Error("selectHealthiestPoolInstance: empty members list");
  }
  if (members.length === 1) return members[0];

  const healthMap = new Map(healthRecords.map((h) => [h.agent_name, h]));

  interface Candidate {
    name: string;
    idle: boolean;
    health: AgentHealth;
  }

  const candidates: Candidate[] = members.map((name) => ({
    name,
    idle: !hasActiveTask(name),
    health: healthMap.get(name) ?? {
      agent_name: name,
      consecutive_failures: 0,
      last_error_at: null,
      last_error_message: null,
      last_success_at: null,
      is_healthy: true,
      auth_status: "ok" as const,
      auth_degraded_at: null,
    },
  }));

  // Sort by: idle first → healthy first → fewest failures → oldest error
  candidates.sort((a, b) => {
    // Prefer idle
    if (a.idle !== b.idle) return a.idle ? -1 : 1;
    // Prefer healthy
    if (a.health.is_healthy !== b.health.is_healthy) return a.health.is_healthy ? -1 : 1;
    // Fewest consecutive failures
    if (a.health.consecutive_failures !== b.health.consecutive_failures) {
      return a.health.consecutive_failures - b.health.consecutive_failures;
    }
    // Oldest error (most likely recovered) — null errors sort first (no error ever)
    const aErr = a.health.last_error_at ?? "";
    const bErr = b.health.last_error_at ?? "";
    return aErr.localeCompare(bErr);
  });

  // Round-robin among equally-qualified candidates: find all candidates that
  // tie with the best on ALL sort criteria, then rotate among them.
  // Without this, the first member always wins when both are idle+healthy,
  // starving Codex agents of work and producing zero Codex token usage.
  const best = candidates[0];
  const tied = candidates.filter(
    (c) =>
      c.idle === best.idle &&
      c.health.is_healthy === best.health.is_healthy &&
      c.health.consecutive_failures === best.health.consecutive_failures &&
      (c.health.last_error_at ?? "") === (best.health.last_error_at ?? ""),
  );

  if (tied.length > 1) {
    const selected = tied[poolRRIndex % tied.length];
    poolRRIndex++;
    return selected.name;
  }

  return best.name;
}

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
  validation?: PreDispatchValidationResult;
}

interface FailureRerouteDecision {
  fromAgent: string;
  toAgent: string;
  sourceRef: string;
  taskType: TaskType;
  failedAttempts: number;
  fromStats: { total: number; done: number; successRate: number | null };
  toStats: { total: number; done: number; successRate: number | null };
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

  private compareHealth(a: AgentHealth, b: AgentHealth): number {
    if (a.is_healthy !== b.is_healthy) return a.is_healthy ? -1 : 1;
    if (a.consecutive_failures !== b.consecutive_failures) {
      return a.consecutive_failures - b.consecutive_failures;
    }
    return (a.last_error_at ?? "").localeCompare(b.last_error_at ?? "");
  }

  private defaultHealth(agentName: string): AgentHealth {
    return {
      agent_name: agentName,
      consecutive_failures: 0,
      last_error_at: null,
      last_error_message: null,
      last_success_at: null,
      is_healthy: true,
      auth_status: "ok",
      auth_degraded_at: null,
    };
  }

  private pickBestRerouteCandidate(currentAgentName: string, taskType: TaskType): string | null {
    const currentAgent = this.config.agents[currentAgentName];
    if (!currentAgent) return null;

    const candidateEntries = Object.entries(this.config.agents)
      .filter(([name]) => name !== currentAgentName)
      .filter(([name]) => !this.store.hasActiveTask(name))
      .filter(([name]) => taskType === "research" || !this.store.isAgentAuthDegraded(name));

    const samePool = currentAgent.pool
      ? candidateEntries.filter(([, agent]) => agent.pool === currentAgent.pool)
      : [];

    const scopedCandidates = samePool.length > 0
      ? samePool
      : candidateEntries.filter(([, agent]) => {
          const capabilityOverlap = agent.capabilities
            .filter((cap) => currentAgent.capabilities.includes(cap)).length;
          const topicOverlap = agent.owns_topics
            .filter((topic) => currentAgent.owns_topics.includes(topic)).length;
          return Boolean(
            (agent.repo && currentAgent.repo && agent.repo === currentAgent.repo) ||
            (agent.github && currentAgent.github && agent.github === currentAgent.github) ||
            capabilityOverlap > 0 ||
            topicOverlap > 0,
          );
        });

    if (scopedCandidates.length === 0) return null;

    const candidateNames = scopedCandidates.map(([name]) => name);
    const rateMap = new Map(
      this.store.getTaskTypeSuccessRates(taskType, candidateNames).map((row) => [row.agent_name, row]),
    );
    const healthMap = new Map(
      this.store.getAgentHealthBatch(candidateNames).map((health) => [health.agent_name, health]),
    );

    return [...candidateNames].sort((a, b) => {
      const aRate = rateMap.get(a)?.success_rate ?? null;
      const bRate = rateMap.get(b)?.success_rate ?? null;
      if (aRate !== bRate) {
        if (aRate === null) return 1;
        if (bRate === null) return -1;
        return bRate - aRate;
      }

      const aTotal = rateMap.get(a)?.total ?? 0;
      const bTotal = rateMap.get(b)?.total ?? 0;
      if (aTotal !== bTotal) return bTotal - aTotal;

      return this.compareHealth(
        healthMap.get(a) ?? this.defaultHealth(a),
        healthMap.get(b) ?? this.defaultHealth(b),
      );
    })[0] ?? null;
  }

  private maybeGetFailureRerouteDecision(
    sourceRef: string | undefined,
    agentName: string,
    taskType: TaskType,
  ): FailureRerouteDecision | null {
    if (!sourceRef) return null;

    const failedAttempts = this.store.countFailuresForSourceRefByAgent(sourceRef, agentName);
    if (failedAttempts < FAILURE_REROUTE_THRESHOLD) return null;

    const substitute = this.pickBestRerouteCandidate(agentName, taskType);
    if (!substitute) {
      this.log.warn("Failure reroute threshold reached, but no substitute agent is available", {
        sourceRef,
        agentName,
        failedAttempts,
        taskType,
      });
      return null;
    }

    const statsMap = new Map(
      this.store.getTaskTypeSuccessRates(taskType, [agentName, substitute]).map((row) => [row.agent_name, row]),
    );
    const fromStats = statsMap.get(agentName);
    const toStats = statsMap.get(substitute);

    return {
      fromAgent: agentName,
      toAgent: substitute,
      sourceRef,
      taskType,
      failedAttempts,
      fromStats: {
        total: fromStats?.total ?? 0,
        done: fromStats?.done ?? 0,
        successRate: fromStats?.success_rate ?? null,
      },
      toStats: {
        total: toStats?.total ?? 0,
        done: toStats?.done ?? 0,
        successRate: toStats?.success_rate ?? null,
      },
    };
  }

  private formatSuccessRate(stats: { total: number; done: number; successRate: number | null }): string {
    if (stats.successRate === null) return "no prior history";
    return `${(stats.successRate * 100).toFixed(0)}% (${stats.done}/${stats.total})`;
  }

  private buildFailureRerouteHeader(decision: FailureRerouteDecision): string {
    return (
      "## Auto-Reroute Context\n" +
      `This issue has already failed ${decision.failedAttempts} time(s) with ${decision.fromAgent}. ` +
      `It is now reassigned to ${decision.toAgent}.\n` +
      `Selection basis: ${decision.taskType} success rate ${this.formatSuccessRate(decision.toStats)} ` +
      `for ${decision.toAgent} vs ${this.formatSuccessRate(decision.fromStats)} for ${decision.fromAgent}.\n` +
      "Take a fresh pass and avoid repeating the prior failed approach.\n\n"
    );
  }

  private async recordFailureReroute(decision: FailureRerouteDecision, message: string, taskId?: string): Promise<void> {
    const rationale =
      `Auto-rerouted ${decision.sourceRef} from ${decision.fromAgent} to ${decision.toAgent} ` +
      `after ${decision.failedAttempts} failed attempt(s). ` +
      `${decision.taskType} success rate: ${decision.toAgent} ${this.formatSuccessRate(decision.toStats)} ` +
      `vs ${decision.fromAgent} ${this.formatSuccessRate(decision.fromStats)}.`;

    this.store.addSupervisorDecision({
      action: "dispatch",
      agent_name: decision.toAgent,
      reason: "auto-reroute-failed-attempts",
      message,
      rationale,
      outcome: taskId ? "dispatched" : "failed",
      task_id: taskId,
    });

    await notifyOperator(
      "Issue auto-rerouted after repeated failures",
      `Issue ${decision.sourceRef} was reassigned from ${decision.fromAgent} to ${decision.toAgent} ` +
      `after ${decision.failedAttempts} failed attempt(s). ` +
      `${decision.taskType} success rate: ${decision.toAgent} ${this.formatSuccessRate(decision.toStats)} ` +
      `vs ${decision.fromAgent} ${this.formatSuccessRate(decision.fromStats)}.`,
      "warning",
      `auto-reroute-failures:${decision.sourceRef}:${decision.fromAgent}:${decision.toAgent}`,
    );
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
       * The GitHub repo that triggered this task (e.g. "rapartlu/agent-proxy").
       * Passed to the router so cross-repo destination detection
       * (`scoreCrossRepoDestination` / `taskMentionsOtherAgent`) can activate.
       * Without this, both helpers return immediately and the deterministic
       * cross-repo routing logic never fires.
       */
      sourceRepo?: string;
      /** Internal escape hatch for orchestrator-managed auto-reroutes. */
      skipDuplicateCheck?: boolean;
      prevalidated?: boolean;
      /**
       * AbortSignal that cancels the in-flight HTTP call to the agent.
       * When the claim-lock supersession system aborts a duplicate task,
       * this signal interrupts the long-running Anthropic API call so the
       * agent's compute is freed as soon as possible.
       */
      signal?: AbortSignal;
      /** Optional parent task id when creating a child task record. */
      parentTaskId?: string;
      /** Optional step id when this dispatch is part of a plan execution. */
      stepId?: string;
    },
  ): Promise<DispatchResult> {
    // Block infrastructure-marker tasks from being dispatched to agents.
    // These are dashboard escalation markers (e.g. health-check failures),
    // not coding tasks. They should only be resolved by the system, not agents.
    if (options?.sourceRef?.startsWith("health-check-fail:")) {
      return {
        taskId: "",
        agentName: options?.agentName ?? "",
        response: {
          content: "Health check tasks are infrastructure markers — not dispatchable to agents.",
          model: "",
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "skipped",
        },
      };
    }

    // Resolve agent
    let agentName = options?.agentName;
    let routeReason = "Explicitly specified";
    let routeMethod: "deterministic" | "llm" | "explicit" | "capability-enforcement" = "explicit";
    let routeConfidence: number | null = null;
    let capabilityReroute: CapabilityEnforcementReroute | null = null;

    if (!agentName) {
      // Run deterministic routing first to detect if LLM fallback was used
      const deterministicMatches = this.router.route(message, options?.sourceRepo);
      const usedLLM =
        deterministicMatches.length === 0 ||
        deterministicMatches[0].confidence < LLM_FALLBACK_THRESHOLD;

      const matches = await this.router.routeWithFallback(message, options?.sourceRepo);
      if (matches.length === 0) {
        throw new Error(
          "Could not determine which agent to route to. Specify --agent explicitly.",
        );
      }
      agentName = matches[0].agentName;
      routeMethod = usedLLM ? "llm" : "deterministic";
      routeConfidence = matches[0].confidence;
      routeReason = `Auto-routed (${matches[0].reason}, confidence: ${matches[0].confidence.toFixed(2)})`;
      this.log.info("Routed task", { agentName, reason: routeReason, confidence: matches[0].confidence });
    }

    // ── Unknown-agent guard (issue #864) ──────────────────────────────────────
    // Reject dispatches to agents that are not present in the registered agent
    // registry.  This must fire BEFORE pool resolution so we don't silently
    // succeed when the target is an alias, a renamed agent, or a stale entry.
    // We log the rejection to both the service logger and the supervisor
    // decision log so it appears in the dashboard routing timeline.
    if (!this.config.agents[agentName]) {
      const knownAgents = Object.keys(this.config.agents).join(", ");
      const reason =
        `Dispatch rejected: agent "${agentName}" is not in the registered agent registry. ` +
        `Known agents: [${knownAgents}]`;
      this.log.warn("UNKNOWN_AGENT dispatch rejected", {
        agentName,
        sourceRef: options?.sourceRef,
        knownAgents,
      });
      this.store.addSupervisorDecision({
        action: "reject",
        agent_name: agentName,
        reason,
        hard_gates: ["UNKNOWN_AGENT"],
        outcome: "skipped",
        task_id: undefined,
        route_method: options?.agentName ? "explicit" : "deterministic",
      });
      await notifyOperator(
        `UNKNOWN_AGENT: dispatch to unregistered agent blocked`,
        `Attempted dispatch to agent \`${agentName}\` which is not registered.\n` +
          (options?.sourceRef ? `Source: ${options.sourceRef}\n` : "") +
          `Known agents: \`${knownAgents}\``,
        "warning",
        `unknown-agent:${agentName}:${options?.sourceRef ?? ""}`,
      );
      return {
        taskId: "",
        agentName,
        response: {
          content: reason,
          model: "",
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "unknown-agent",
        },
      };
    }

    // Pool resolution: if the selected agent belongs to a pool, pick the
    // healthiest idle member instead of just the first idle one.  This prevents
    // routing to an instance that is 503-ing (issue #385).
    const allPoolMembers = getPoolMembers(this.config, agentName);
    // Filter out members whose provider is rate-limited / exhausted
    const poolMembers = allPoolMembers.filter((name) => {
      const provider = this.config.agents[name]?.provider ?? "claude";
      return isProviderAvailable(provider);
    });

    // Hard block: if ALL providers in this pool are exhausted, don't dispatch.
    // The task stays in the queue and will be picked up when a provider recovers.
    if (poolMembers.length === 0) {
      const providers = [...new Set(allPoolMembers.map((n) => this.config.agents[n]?.provider ?? "claude"))];
      this.log.warn("Dispatch blocked: all providers exhausted for this pool", {
        agentName,
        pool: this.config.agents[agentName]?.pool,
        providers,
        sourceRef: options?.sourceRef,
      });
      return {
        taskId: "",
        agentName,
        response: {
          content: `All providers exhausted (${providers.join(", ")}). Task will retry when limits reset.`,
          model: "",
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: "provider-exhausted",
        },
      };
    }

    const effectiveMembers = poolMembers;

    if (effectiveMembers.length > 1) {
      const healthRecords = this.store.getAgentHealthBatch(effectiveMembers);
      const selected = selectHealthiestPoolInstance(
        effectiveMembers,
        healthRecords,
        (name) => this.store.hasActiveTask(name),
      );
      this.log.info("Pool routing: picked healthiest member", {
        pool: this.config.agents[agentName]?.pool,
        selected,
        from: agentName,
        health: healthRecords.find((h) => h.agent_name === selected),
      });
      agentName = selected;
    }

    // Capability tag enforcement (issue #817): block research-only agents from
    // receiving implementation tasks and reroute to the correct agent instead.
    // This runs before all other pre-flight checks so no budget/auth resources
    // are consumed by a mis-routed task.
    const taskTypeForCap = options?.taskType ?? "implementation";
    capabilityReroute = checkCapabilityEnforcement({
      config: this.config,
      agentName,
      taskType: taskTypeForCap,
      title: options?.title,
      sourceRef: options?.sourceRef,
    });
    if (capabilityReroute) {
      this.log.warn("Capability enforcement: rerouting implementation task away from research-only agent", {
        blockedAgent: capabilityReroute.blockedAgent,
        toAgent: capabilityReroute.toAgent,
        reason: capabilityReroute.redirectReason,
        sourceRef: options?.sourceRef,
      });
      agentName = capabilityReroute.toAgent;
      routeMethod = "capability-enforcement";
      routeReason = capabilityReroute.redirectReason;
      // Notify the operator so the misconfigured routing is surfaced in Telegram.
      await notifyOperator(
        "Capability enforcement: research-only agent received implementation task",
        `Rerouted task from \`${capabilityReroute.blockedAgent}\` (research-only) ` +
          `to \`${capabilityReroute.toAgent}\`.\n` +
          (options?.title ? `Task: "${options.title}"\n` : "") +
          (options?.sourceRef ? `Source: ${options.sourceRef}` : ""),
        "warning",
        `capability-enforcement:${capabilityReroute.blockedAgent}:${options?.sourceRef ?? ""}`,
      );
    }

    // Remote capability pre-flight (issue #837): belt-and-suspenders check that
    // calls the agent's own /capability-check endpoint before committing dispatch.
    // This catches cases where the local tag-based enforcer didn't trigger but the
    // agent's container would reject the task at execution time (e.g., a research
    // agent receiving a dashboard implementation task whose title pattern wasn't
    // matched locally).  The call is non-blocking: 404 and network errors are
    // treated as "accept" so no dispatch is blocked if the endpoint is absent.
    if (!capabilityReroute) {
      let remoteCapCheck: Awaited<ReturnType<typeof runRemoteCapabilityCheck>> = null;
      try {
        remoteCapCheck = await runRemoteCapabilityCheck({
          config: this.config,
          agentName,
          taskType: taskTypeForCap,
          title: options?.title,
          sourceRef: options?.sourceRef,
        });
      } catch (err) {
        this.log.warn("Remote capability check failed — proceeding with dispatch", {
          agentName, error: err instanceof Error ? err.message : String(err),
        });
      }
      if (remoteCapCheck) {
        this.log.warn(
          "Remote capability pre-flight: agent rejected task — rerouting",
          {
            blockedAgent: remoteCapCheck.blockedAgent,
            toAgent: remoteCapCheck.toAgent,
            reason: remoteCapCheck.redirectReason,
            sourceRef: options?.sourceRef,
          },
        );
        agentName = remoteCapCheck.toAgent;
        routeMethod = "capability-enforcement";
        routeReason = remoteCapCheck.redirectReason;
        capabilityReroute = remoteCapCheck;
        await notifyOperator(
          "Runtime capability check: agent rejected task via /capability-check",
          `Agent \`${remoteCapCheck.blockedAgent}\` rejected the task at runtime.\n` +
            `Rerouted to \`${remoteCapCheck.toAgent}\`.\n` +
            (options?.title ? `Task: "${options.title}"\n` : "") +
            (options?.sourceRef ? `Source: ${options.sourceRef}` : ""),
          "warning",
          `remote-cap-check:${remoteCapCheck.blockedAgent}:${options?.sourceRef ?? ""}`,
        );
      }
    }

    // Pre-flight: check token budget pause (issue #436).
    // When an agent has pause_on_exceeded: true and has consumed >= critical_pct of
    // its daily budget, block dispatch so runaway spend is contained automatically.
    const { budget, critPct, pauseOnExceeded } = resolveAgentBudget(this.config, agentName, "daily");
    if (pauseOnExceeded && budget !== null) {
      const usageRows = this.store.getAgentTokenUsage(24);
      const agentUsage = usageRows.find((r) => r.agent_name === agentName);
      const usedTokens = agentUsage?.total_tokens ?? 0;
      if (usedTokens / budget * 100 >= critPct) {
        this.log.warn("Dispatch blocked: agent has exceeded daily token budget", {
          agentName,
          usedTokens,
          budget,
          critPct,
        });
        throw new Error(
          `Agent "${agentName}" has exceeded its daily token budget ` +
          `(${usedTokens.toLocaleString()} / ${budget.toLocaleString()} tokens, ` +
          `pause_on_exceeded is enabled). Dispatch will resume when the budget window resets.`,
        );
      }
    }

    // Pre-flight: check agent auth quarantine status (issue #418).
    // Auth-degraded agents can only receive read-only tasks (research/analysis).
    // Implementation tasks require GH_TOKEN for PR creation, so block them.
    const taskType = options?.taskType ?? "implementation";
    const failureReroute = this.maybeGetFailureRerouteDecision(options?.sourceRef, agentName, taskType);
    if (failureReroute) {
      this.log.warn("Failure reroute hard gate triggered", {
        sourceRef: failureReroute.sourceRef,
        fromAgent: failureReroute.fromAgent,
        toAgent: failureReroute.toAgent,
        failedAttempts: failureReroute.failedAttempts,
        taskType: failureReroute.taskType,
      });
      agentName = failureReroute.toAgent;
      message = this.buildFailureRerouteHeader(failureReroute) + message;
    }

    if (taskType !== "research" && this.store.isAgentAuthDegraded(agentName)) {
      this.log.warn("Dispatch blocked: agent is auth-degraded", {
        agentName,
        taskType,
        sourceRef: options?.sourceRef,
      });
      throw new GhAuthError(
        `Agent "${agentName}" is auth-degraded (GH_TOKEN missing/invalid). ` +
        `Only research tasks can be dispatched to auth-degraded agents. ` +
        `Fix the agent's GH_TOKEN to resume normal operation.`,
        "agent-auth-degraded",
      );
    }

    // Pre-flight: for GitHub-sourced tasks, verify gh is authenticated before
    // dispatching.  A missing/expired credential lets the agent push a branch
    // successfully (via SSH) but then fail on `gh pr create`, producing a silent
    // orphan branch.  Blocking here gives a clear error and keeps the issue in
    // the unprocessed queue so the daemon retries when auth recovers.
    // Also quarantines the agent if auth fails (issue #418).
    if (options?.source === "github") {
      const authStatus = validateGhAuth();
      if (!authStatus.ok) {
        const reason = authStatus.reason ?? "gh CLI is not authenticated";

        // Quarantine the agent — mark as auth-degraded
        this.store.setAgentAuthDegraded(agentName, reason);
        this.log.error("GitHub dispatch blocked: gh auth pre-flight failed — agent quarantined", {
          agentName,
          reason,
          sourceRef: options?.sourceRef,
        });

        // Fire Telegram alert so operator is notified immediately
        notifyOperator(
          "Agent quarantined: auth-degraded",
          `Agent "${agentName}" has been quarantined due to missing/invalid GH_TOKEN. ` +
          `Reason: ${reason}. Only research tasks will be dispatched until auth is restored.`,
          "critical",
          `auth-degraded:${agentName}`,
        );

        throw new GhAuthError(
          `GH auth pre-flight failed — agent "${agentName}" quarantined as auth-degraded: ${reason}`,
          reason,
        );
      }
    }

    // Repo PR capacity gate (issue #626).
    // Pause new implementation dispatches when the destination repo already
    // has too many open PRs so merge conflicts do not snowball.
    const agentConf = this.config.agents[agentName];
    const shouldCheckRepoCapacity =
      taskType !== "research" &&
      !!agentConf?.github &&
      (!options?.sourceRef || options?.prevalidated);
    if (shouldCheckRepoCapacity) {
      const repo = agentConf?.github;
      const cap = agentConf?.max_open_prs ?? this.config.dispatch?.max_open_prs ?? 3;
      const openPRCount = repo ? countOpenPRs(repo) : null;
      if (repo && openPRCount !== null && openPRCount >= cap) {
        this.log.warn("Dispatch blocked: repo at PR capacity", {
          agentName,
          repo,
          openPRCount,
          cap,
          sourceRef: options?.sourceRef,
          source: options?.source,
        });
        return {
          taskId: "",
          agentName,
          response: {
            content: `Skipped: repo at PR capacity (${openPRCount}/${cap})`,
            model: "",
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: "skipped",
          },
        };
      }
      if (openPRCount === null) {
        this.log.warn("Dispatch repo-capacity check failed open", {
          agentName,
          repo,
          sourceRef: options?.sourceRef,
          source: options?.source,
        });
      }
    }

    // Borrow policy enforcement (issue #448).
    // A "borrow" occurs when the agent's own github repo differs from the
    // source_ref's repo.  If the agent has a borrow config, enforce the
    // declared rules before proceeding.  Agents without borrow config are
    // allowed cross-domain dispatches unchanged (backward compatibility).
    if (options?.sourceRef) {
      const taskRepo = options.sourceRef.split("#")[0] ?? null;
      const agentRepo = agentConf?.github ?? null;
      const isBorrowed = taskRepo && agentRepo && taskRepo !== agentRepo;

      if (isBorrowed) {
        const borrow = agentConf?.borrow;
        if (borrow?.enabled) {
          // 1. Allowlist check
          const allowList = borrow.can_work_on;
          if (allowList && allowList.length > 0 && !allowList.includes(taskRepo)) {
            throw new Error(
              `Agent "${agentName}" borrow policy blocks dispatch to "${taskRepo}": ` +
              `allowed repos are [${allowList.join(", ")}]. ` +
              `Add "${taskRepo}" to borrow.can_work_on to permit this.`,
            );
          }

          // 2. Minimum idle time
          const minIdleMs = (borrow.min_idle_minutes ?? 0) * 60_000;
          if (minIdleMs > 0) {
            const idleMs = this.store.getAgentIdleSinceMs(agentName);
            if (idleMs === null || idleMs < minIdleMs) {
              const actualMin = idleMs !== null ? Math.floor(idleMs / 60_000) : 0;
              throw new Error(
                `Agent "${agentName}" borrow policy requires ${borrow.min_idle_minutes}m idle ` +
                `before borrowing "${taskRepo}", but agent has been idle for ${actualMin}m.`,
              );
            }
          }

          // 3. Max concurrent borrowed tasks
          const maxConcurrent = borrow.max_concurrent_borrowed ?? 1;
          const activeBorrowed = this.store.countActiveBorrowedTasks(agentName, agentRepo);
          if (activeBorrowed >= maxConcurrent) {
            throw new Error(
              `Agent "${agentName}" is at borrow limit: ${activeBorrowed}/${maxConcurrent} ` +
              `active borrowed task(s). Wait for a borrowed task to complete before dispatching another.`,
            );
          }
        }

        this.log.info("Cross-domain (borrowed) dispatch", {
          agentName,
          agentRepo,
          taskRepo,
          sourceRef: options.sourceRef,
          policyApplied: !!agentConf?.borrow?.enabled,
        });
      }
    }

    if (!options?.prevalidated && options?.sourceRef) {
      const repo = extractRepoFromSourceRef(options.sourceRef);
      const issueMatch = options.sourceRef.match(/#(\d+)$/);
      if (repo && issueMatch) {
        const issueNumber = parseInt(issueMatch[1], 10);
        const validation = runGitHubPreDispatchValidation({
          config: this.config,
          store: this.store,
          source: options?.source ?? "manual",
          agentName,
          issue: { repo, number: issueNumber },
        });
        if (validation.outcome === "blocked") {
          this.log.warn("Dispatch skipped: pre-dispatch validation blocked dispatch", {
            agentName,
            source: options?.source,
            sourceRef: options.sourceRef,
            failureCheck: validation.failureCheck,
            failureCode: validation.failureCode,
            failureReason: validation.failureReason,
          });
          return {
            taskId: "",
            agentName,
            response: {
              content: `Skipped: ${validation.failureReason ?? "pre-dispatch validation blocked dispatch"}`,
              model: "",
              usage: { input_tokens: 0, output_tokens: 0 },
              stop_reason: "skipped",
            },
            validation,
          };
        }
      }
    }
    // Idempotency guard (issue #469): prevent the same source_ref from being
    // dispatched to multiple agents simultaneously.  The trigger layer already
    // checks this via inFlightDispatches + checkDuplicate, but direct callers
    // (supervisor, CLI, Telegram, retries) bypass the trigger layer entirely.
    // Placing the guard here in dispatch() itself closes that gap.
    if (options?.sourceRef && options?.source && !options.skipDuplicateCheck && !failureReroute) {
      const dupCheck = checkDuplicate(this.store, options.source, options.sourceRef);
      if (dupCheck.isDuplicate) {
        this.log.warn("Dispatch blocked: duplicate guard triggered", {
          agentName,
          source: options.source,
          sourceRef: options.sourceRef,
          reason: dupCheck.reason,
          existingTaskId: dupCheck.existingTask?.id,
        });
        return {
          taskId: "",
          agentName,
          response: {
            content: `Duplicate: ${dupCheck.reason}`,
            model: "",
            usage: { input_tokens: 0, output_tokens: 0 },
            stop_reason: "duplicate",
          },
        };
      }
    }
    // Pre-dispatch: enforce follow-up chain depth cap (issue #823).
    // When this task has a parent, walk the parent_task_id chain to compute the
    // depth of the new task.  If it would exceed the configured maximum, create
    // the task as "escalated" immediately so a human can decide whether to
    // continue the chain — rather than letting the orchestrator auto-dispatch
    // an unbounded cascade.
    if (options?.parentTaskId) {
      const maxDepth: number =
        this.config.escalation?.max_followup_depth ?? DEFAULT_MAX_FOLLOWUP_DEPTH;

      if (maxDepth > 0) {
        const depth = computeChainDepth(options.parentTaskId, this.store);
        if (depth > maxDepth) {
          this.log.warn("Follow-up chain depth cap exceeded — escalating instead of dispatching", {
            parentTaskId: options.parentTaskId,
            depth,
            maxDepth,
            sourceRef: options?.sourceRef,
            agentName,
          });

          const cappedTask = this.store.createTask({
            title: options?.title ?? message.slice(0, 100),
            description: message,
            source: options?.source ?? "manual",
            source_ref: options?.sourceRef,
            agent_name: agentName,
            task_type: taskType,
            parent_task_id: options.parentTaskId,
            step_id: options?.stepId,
          });
          this.store.updateTask(cappedTask.id, { status: "escalated" });

          await notifyOperator(
            "Follow-up chain depth cap exceeded",
            `Task \`${cappedTask.id}\` is at depth ${depth} (max: ${maxDepth}). ` +
              `Auto-dispatch was blocked. Resolve the escalation queue to continue manually.\n` +
              (options?.sourceRef ? `Source: ${options.sourceRef}` : ""),
            "warning",
            `chain-depth-cap:${options.parentTaskId}:depth-${depth}`,
          );

          return {
            taskId: cappedTask.id,
            agentName,
            response: {
              content:
                `Follow-up chain depth cap exceeded (depth ${depth} > max ${maxDepth}). ` +
                `Task ${cappedTask.id} has been escalated for human review.`,
              model: "",
              usage: { input_tokens: 0, output_tokens: 0 },
              stop_reason: "chain-depth-cap",
            },
          };
        }
      }
    }

    // Create task — reuse the caller's conversationId when provided (e.g. PR
    // feedback or revision tasks that should resume the agent's prior session).
    const conversationId = options?.conversationId ?? ulid();
    const task = this.store.createTask({
      title: options?.title ?? message.slice(0, 100),
      description: message,
      source: options?.source ?? "manual",
      source_ref: options?.sourceRef,
      agent_name: agentName,
      task_type: taskType,
      parent_task_id: options?.parentTaskId,
      step_id: options?.stepId,
    });

    // Update to dispatched
    this.store.updateTask(task.id, {
      status: "dispatched",
      conversation_id: conversationId,
    });

    // Record routing decision for accuracy feedback loop (issue #656).
    // quality_score is null at dispatch time; filled when the task is verified.
    this.store.recordRoutingDecision({
      taskId: task.id,
      agentChosen: agentName,
      taskType,
      routeMethod,
      routeConfidence,
      sourceRef: options?.sourceRef,
      redirectReason: capabilityReroute?.redirectReason,
    });

    // Prepend the target-repo header so the agent always knows which repo to
    // target, even when instructions are deeply nested in a long message.
    const repoHeader = buildTargetRepoHeader(options?.sourceRef);
    let messageToSend = repoHeader ? `${repoHeader}\n${message}` : message;

    // Inject rejection history from prior attempts for the same source_ref
    // so the agent avoids repeating failed approaches.
    if (options?.sourceRef) {
      const priorAttempts = this.store.getPriorAttempts(options.sourceRef);
      const rejectionBlock = buildRejectionHistoryBlock(priorAttempts);
      if (rejectionBlock) {
        this.log.info("Injecting rejection history into dispatch", {
          taskId: task.id,
          agentName,
          sourceRef: options.sourceRef,
          priorAttemptCount: priorAttempts.length,
        });
        messageToSend = messageToSend + rejectionBlock;
      }
    }

    // Inject cross-repo reference implementation hint (issue #772).
    // When this task is part of a lineage group (cross-repo feature), find the
    // highest-scoring peer implementation and attach it as a consistency anchor
    // so the agent doesn't re-derive the design from scratch.
    const targetRepo: string | null = options?.sourceRef
      ? (extractRepoFromSourceRef(options.sourceRef) ?? null)
      : (this.config.agents[agentName]?.github ?? null);
    const refImpl = findBestReferenceImplementation(this.store, task, targetRepo);
    const refImplBlock = buildReferenceImplementationBlock(refImpl);
    if (refImplBlock) {
      this.log.info("Injecting reference implementation hint into dispatch", {
        taskId: task.id,
        agentName,
        lineageGroupId: task.lineage_group_id,
        refTaskId: refImpl!.taskId,
        refSourceRef: refImpl!.sourceRef,
        refQualityScore: refImpl!.qualityScore,
      });
      messageToSend = messageToSend + refImplBlock;
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        agent_name: agentName,
        content: `[reference-impl] Attached peer implementation from ${refImpl!.sourceRef ?? refImpl!.taskId} (score: ${refImpl!.qualityScore.toFixed(2)})`,
      });
    }

    // Inject per-repo learned rules (conventions from prior PR reviews)
    const sourceRepo = targetRepo;
    if (sourceRepo) {
      const { block: rulesBlock, ruleIds } = getAndApplyRules(this.store, sourceRepo);
      if (rulesBlock) {
        this.log.info("Injecting learned rules into dispatch", {
          taskId: task.id,
          agentName,
          repo: sourceRepo,
          ruleCount: ruleIds.length,
        });
        messageToSend = messageToSend + rulesBlock;
        // Log the applied rule IDs for later confidence tracking
        this.store.addLog({
          task_id: task.id,
          direction: "system",
          agent_name: agentName,
          content: `[learned-rules] Applied rule IDs: ${ruleIds.join(",")}`,
        });
      }
    }

    // Antibody pre-dispatch check: attach known-risk warning when the task
    // matches failure patterns from the antibody log (issue #750).
    const antibodyRepo = sourceRepo ?? undefined;
    const antibodyCheck = runAntibodyPreDispatchCheck(this.store, message, antibodyRepo);
    if (antibodyCheck.flagged) {
      this.log.warn("Antibody pre-dispatch: task matches known failure pattern(s)", {
        taskId: task.id,
        agentName,
        repo: antibodyRepo,
        matchCount: antibodyCheck.matches.length,
        topScore: antibodyCheck.matches[0]?.score?.toFixed(3),
      });
      messageToSend = messageToSend + antibodyCheck.warningBlock;
      // Record the flag as a system log so operators and dashboards can query for
      // antibody-flagged tasks via task_logs (same pattern as [learned-rules]).
      const matchSummary = antibodyCheck.matches
        .map((m) => `${m.entry.repo}#${m.entry.pr_number}(${(m.score * 100).toFixed(0)}%)`)
        .join(",");
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        agent_name: agentName,
        content: `[antibody-flagged] Matched ${antibodyCheck.matches.length} risk pattern(s): ${matchSummary}`,
      });
    }

    // Log the outgoing message
    this.log.info("Dispatching to agent", { taskId: task.id, agentName, title: task.title });
    this.store.addLog({
      task_id: task.id,
      direction: "to_agent",
      agent_name: agentName,
      content: messageToSend,
    });

    // Smart model routing: pick cheapest model that can handle this task
    const provider = this.config.agents[agentName]?.provider ?? "claude";
    const isRevision = message.includes("[revision]") || message.includes("[PR feedback]");
    const modelRoute = routeModel(provider, message, {
      taskType,
      isRevision,
      sourceRef: options?.sourceRef,
    });

    try {
      // Send to agent with complexity-routed model
      const response = await this.client.send(agentName, messageToSend, {
        conversationId,
        taskType,
        model: modelRoute.model,
        signal: options?.signal,
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

      // Record token usage for provider tracking (including cache stats)
      this.store.recordTokenUsage(
        provider, agentName,
        response.usage.input_tokens, response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
        response.usage.cache_creation_input_tokens ?? 0,
      );

      // Update task to done
      this.log.info("Task completed", {
        taskId: task.id, agentName,
        model: modelRoute.model, tier: modelRoute.tier, complexity: modelRoute.complexity.toFixed(2),
        tokensIn: response.usage.input_tokens, tokensOut: response.usage.output_tokens,
      });

      // Guard: another claim may have superseded this task while the HTTP call
      // was running (e.g. the claim TTL expired and a new agent claimed the
      // issue).  Do NOT overwrite "superseded" with "done" — the task has
      // already been marked terminal by cancelSupersededTasks().
      {
        const latestTask = this.store.getTask(task.id);
        if (latestTask?.status === "superseded") {
          this.log.info("Task was superseded while running — skipping done update", {
            taskId: task.id,
            agentName,
          });
          return { taskId: task.id, agentName, response };
        }
      }

      // Detect cross-repo follow-ups: if the task description mentions work
      // that belongs to a peer repo, coordinate it as a linked set of tasks
      // rather than creating orphan GitHub issues.
      //
      // Strategy:
      //   1. If this task is a CHILD of a coordination group, advance the group
      //      (link PRs, trigger ordered merge when all siblings are done).
      //   2. If this is a TOP-LEVEL task with multi-repo requirements, create a
      //      coordination group with child tasks per peer repo (replaces orphan
      //      follow-up issues for implementation tasks).
      //   3. Fall back to the legacy orphan-issue path for edge cases that the
      //      coordinator doesn't handle (research tasks, depth-limited chains).
      const completedTask = this.store.getTask(task.id);
      let finalResult = response.content;
      if (completedTask) {
        // Step 1: if this task is part of a coordination group, advance it.
        try {
          await checkAndAdvanceCoordination(task.id, this.store, this.config);
        } catch (err) {
          this.log.error("checkAndAdvanceCoordination failed (non-fatal)", {
            taskId: task.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Step 2: detect multi-repo requirements for implementation tasks.
        // Only fire when this is NOT already a coordination child task, to
        // prevent cascade creation (child tasks should not spawn more groups).
        const isCoordinationChild = !!this.store.getCoordinationGroupByChildTaskId(task.id);
        if (!isCoordinationChild && completedTask.task_type === "implementation") {
          const changeSets = detectMultiRepoChangeSets(completedTask, agentName, this.config);
          if (changeSets.length > 0) {
            try {
              const coordGroup = createCoordinationGroup(completedTask, changeSets, this.store);
              finalResult +=
                `\n\n---\n**Multi-repo coordination group created:** \`${coordGroup.id}\`\n` +
                `Child tasks dispatched to:\n` +
                changeSets.map((cs) => `- \`${cs.repo}\` → agent \`${cs.agentName}\` (merge order ${cs.mergeOrder})`).join("\n");

              // Record lineage so all child tasks share the parent's lineage group
              const lineageGroupId = completedTask.lineage_group_id ?? completedTask.id;
              for (const cs of changeSets) {
                const childTaskId = coordGroup.childTaskIds[cs.repo];
                if (childTaskId && completedTask.source_ref) {
                  this.store.recordLineageMapping(
                    `${cs.repo}#coord-${coordGroup.id}`,
                    lineageGroupId,
                    completedTask.source_ref,
                  );
                }
              }

              this.log.info("Multi-repo coordination group created", {
                taskId: task.id,
                agentName,
                groupId: coordGroup.id,
                repos: changeSets.map((cs) => cs.repo),
              });
            } catch (err) {
              this.log.error("Failed to create coordination group (falling back to legacy follow-ups)", {
                taskId: task.id,
                error: err instanceof Error ? err.message : String(err),
              });
              // Fall through to legacy path below
            }
          }
        }

        // Step 3: legacy orphan-issue fallback for tasks that don't qualify for
        // coordination (research tasks, chain-depth limit, etc.).
        // Skip if we already created a coordination group above.
        const alreadyCoordinated = !!this.store.getCoordinationGroupByParentTaskId(task.id);
        if (!alreadyCoordinated) {
          const followUps = detectAndCreateFollowUps(
            completedTask,
            agentName,
            this.config,
            // AC#3: increment the "follow_ups_avoided" counter whenever a
            // cross-repo follow-up is skipped because an open PR already closes
            // the parent issue.  The improvement detector surfaces this count as
            // a positive efficiency signal in the supervisor context.
            () => { this.store.incrementStat("follow_ups_avoided"); },
          );
          if (followUps.length > 0) {
            finalResult += formatFollowUpNote(followUps);
            // Record lineage mappings so that when trigger polling picks up the
            // follow-up issues, the resulting tasks inherit this task's lineage group.
            const lineageGroupId = completedTask.lineage_group_id ?? completedTask.id;
            for (const followUp of followUps) {
              const followUpSourceRef = `${followUp.repo}#${followUp.issueNumber}`;
              this.store.recordLineageMapping(
                followUpSourceRef,
                lineageGroupId,
                completedTask.source_ref ?? undefined,
              );
            }
            this.log.info("Cross-repo follow-ups created with lineage tracking", {
              taskId: task.id,
              agentName,
              lineageGroupId,
              followUps: followUps.map((f) => `${f.repo}#${f.issueNumber}`),
            });
          }
        }
      }

      this.store.updateTask(task.id, {
        status: "done",
        result: finalResult,
      });

      // Record healthy dispatch for pool failover routing
      this.store.recordAgentSuccess(agentName);
      // Clear provider exhaustion on success (auto-recovery)
      markProviderAvailable(this.config.agents[agentName]?.provider ?? "claude");

      if (failureReroute) {
        await this.recordFailureReroute(failureReroute, message, task.id);
      }

      return { taskId: task.id, agentName, response };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newRetryCount = (task.retry_count ?? 0) + 1;

      // Guard: if the task was superseded (claim lock cancelled it) while the
      // HTTP call was in-flight, the abort signal causes the call to throw.
      // Do NOT overwrite "superseded" with "failed" — the task is already in
      // the correct terminal state.
      {
        const latestTask = this.store.getTask(task.id);
        if (latestTask?.status === "superseded") {
          this.log.info("Task was superseded while running (abort); skipping failed update", {
            taskId: task.id,
            agentName,
            error: errorMsg,
          });
          throw err; // propagate so fireAndForget catch handler runs claim release
        }
      }

      // Record failure for pool failover routing
      this.store.recordAgentFailure(agentName, errorMsg);

      // Rate limit detection: mark the provider as exhausted so pool selection
      // skips all agents on this provider until the limit resets.
      if (isRateLimitError(err)) {
        const provider = this.config.agents[agentName]?.provider ?? "claude";
        const resetAt = parseResetTime(err);
        markProviderExhausted(provider, errorMsg, resetAt ?? undefined);
        this.log.warn("Rate limit detected — provider marked exhausted", {
          taskId: task.id,
          agentName,
          provider,
          resetAt: resetAt?.toISOString(),
        });
      }

      if (isConnectionError(err)) {
        // Connection errors are transient — retry with exponential backoff.
        const maxConnRetries =
          this.config.retry?.max_connection_retries ?? MAX_CONNECTION_RETRIES;
        const connDelays =
          this.config.retry?.connection_error_delays_ms ?? CONNECTION_ERROR_RETRY_DELAYS_MS;

        // Use strict less-than so that once retry_count == maxConnRetries the task
        // is permanently failed (next_retry_at = null).
        const willRetry = newRetryCount < maxConnRetries;
        const nextRetryAt = willRetry
          ? new Date(
              Date.now() +
                (connDelays[newRetryCount - 1] ?? connDelays[connDelays.length - 1]),
            ).toISOString()
          : null;
        const exhaustedResult = `connection-error-exhausted: ${errorMsg}`;

        this.log.error("Task failed (connection error)", {
          taskId: task.id,
          agentName,
          error: errorMsg,
          willRetry,
          retryCount: newRetryCount,
          maxConnRetries,
        });
        this.store.addLog({
          task_id: task.id,
          direction: "system",
          content: willRetry
            ? `Connection error: ${errorMsg} — retry ${newRetryCount}/${maxConnRetries} scheduled at ${nextRetryAt}`
            : `Connection error: ${errorMsg} — max connection retries (${maxConnRetries}) exhausted, task permanently failed`,
        });
        this.store.updateTask(task.id, {
          status: "failed",
          result: willRetry ? errorMsg : exhaustedResult,
          retry_count: newRetryCount,
          next_retry_at: nextRetryAt,
        });
      } else {
        // Logic errors are not transient — failing immediately without retry
        // prevents wasting agent tokens re-running a task that will fail the
        // same way each time.
        this.log.error("Task failed (logic error, no retry)", {
          taskId: task.id,
          agentName,
          error: errorMsg,
          retryCount: newRetryCount,
        });
        this.store.addLog({
          task_id: task.id,
          direction: "system",
          content: `Error: ${errorMsg} — logic/auth error, task permanently failed (no retry)`,
        });
        this.store.updateTask(task.id, {
          status: "failed",
          result: errorMsg,
          retry_count: newRetryCount,
          next_retry_at: null,
        });
      }

      if (failureReroute) {
        await this.recordFailureReroute(failureReroute, message);
      }
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
        const retryDelays = this.config.dispatch?.retry_delays_ms ?? RETRY_DELAYS_MS;
        const deferredAt = new Date(Date.now() + (retryDelays[0] ?? RETRY_DELAYS_MS[0])).toISOString();
        this.store.updateTask(task.id, { next_retry_at: deferredAt });
        return;
      }
    }

    // Pre-retry closed-issue guard (issue #431): if the source issue has been
    // closed since the task was originally dispatched, skip the retry entirely
    // and mark the task as resolved externally. This prevents wasting an agent
    // cycle on work that is no longer needed.
    if (task.source === "github" && task.source_ref) {
      const repo = extractRepoFromSourceRef(task.source_ref);
      const issueMatch = task.source_ref.match(/#(\d+)$/);
      if (repo && issueMatch) {
        const issueNumber = parseInt(issueMatch[1], 10);
        const skipReason = cachedValidateForDispatch(repo, issueNumber);
        if (skipReason) {
          this.log.info("Retry skipped: issue state validation failed (cached)", {
            taskId: task.id,
            agentName,
            sourceRef: task.source_ref,
            issueNumber,
            reason: skipReason,
          });
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Resolved externally: ${skipReason} — retry cancelled.`,
          });
          this.store.updateTask(task.id, {
            status: "failed",
            result: `Resolved externally: ${skipReason} — retry cancelled.`,
            next_retry_at: null,
          });
          return;
        }

        // Note: cachedValidateForDispatch above already covers closed issues,
        // merged PRs, and open PRs in a single cached check (issue #458).
      }
    }

    const taskType = task.task_type ?? "implementation";
    const failureReroute = this.maybeGetFailureRerouteDecision(task.source_ref ?? undefined, agentName, taskType);
    if (failureReroute) {
      const reroutedMessage = this.buildFailureRerouteHeader(failureReroute) + (task.description ?? task.title);
      this.log.warn("Retry converted into failure reroute", {
        taskId: task.id,
        sourceRef: failureReroute.sourceRef,
        fromAgent: failureReroute.fromAgent,
        toAgent: failureReroute.toAgent,
        failedAttempts: failureReroute.failedAttempts,
      });
      this.store.addLog({
        task_id: task.id,
        direction: "system",
        content:
          `Auto-rerouted after ${failureReroute.failedAttempts} failed attempt(s): ` +
          `${failureReroute.fromAgent} -> ${failureReroute.toAgent}`,
      });
      this.store.updateTask(task.id, { next_retry_at: null });
      try {
        const rerouted = await this.dispatch(reroutedMessage, {
          agentName: failureReroute.toAgent,
          source: task.source,
          sourceRef: task.source_ref ?? undefined,
          title: `[auto-reroute] ${task.title}`,
          taskType,
          skipDuplicateCheck: true,
        });
        await this.recordFailureReroute(failureReroute, reroutedMessage, rerouted.taskId);
      } catch (err) {
        await this.recordFailureReroute(failureReroute, reroutedMessage);
        throw err;
      }
      return;
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
    let messageToSend = repoHeader ? `${repoHeader}\n${message}` : message;

    // Inject rejection history from prior attempts for the same source_ref
    // so the agent avoids repeating failed approaches on retry.
    if (task.source_ref) {
      const priorAttempts = this.store.getPriorAttempts(task.source_ref);
      const rejectionBlock = buildRejectionHistoryBlock(priorAttempts);
      if (rejectionBlock) {
        this.log.info("Injecting rejection history into retry", {
          taskId: task.id,
          agentName,
          sourceRef: task.source_ref,
          priorAttemptCount: priorAttempts.length,
        });
        messageToSend = messageToSend + rejectionBlock;
      }
    }

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

      const retryProvider = this.config.agents[agentName]?.provider ?? "claude";
      this.store.recordTokenUsage(
        retryProvider, agentName,
        response.usage.input_tokens, response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
        response.usage.cache_creation_input_tokens ?? 0,
      );

      this.log.info("Retry succeeded", { taskId: task.id, agentName });
      this.store.updateTask(task.id, {
        status: "done",
        result: response.content,
        next_retry_at: null,
      });

      // Record healthy dispatch for pool failover routing
      this.store.recordAgentSuccess(agentName);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const newRetryCount = task.retry_count + 1;

      // Record failure for pool failover routing
      this.store.recordAgentFailure(agentName, errorMsg);

      if (isConnectionError(err)) {
        // Connection error during retry — apply connection-specific backoff policy.
        const maxConnRetries =
          this.config.retry?.max_connection_retries ?? MAX_CONNECTION_RETRIES;
        const connDelays =
          this.config.retry?.connection_error_delays_ms ?? CONNECTION_ERROR_RETRY_DELAYS_MS;

        // Connection-error exhaustion takes priority over generic escalation:
        // these are infrastructure failures, not logic problems, so we mark
        // them as permanently failed rather than escalating to a human.
        // Escalation only fires when NOT yet exhausted.
        const connExhausted = newRetryCount >= maxConnRetries;
        const escalationLimit =
          this.config.escalation?.retry_limit ?? DEFAULT_ESCALATION_RETRY_LIMIT;
        const shouldEscalate = !connExhausted && escalationLimit > 0 && newRetryCount >= escalationLimit;
        const willRetry = !shouldEscalate && !connExhausted;
        const nextRetryAt = willRetry
          ? new Date(
              Date.now() +
                (connDelays[newRetryCount - 1] ?? connDelays[connDelays.length - 1]),
            ).toISOString()
          : null;

        this.log.error("Retry failed (connection error)", {
          taskId: task.id,
          agentName,
          error: errorMsg,
          willRetry,
          shouldEscalate,
          connExhausted,
          retryCount: newRetryCount,
          maxConnRetries,
          escalationLimit,
        });

        if (shouldEscalate) {
          const escalationMsg =
            `Escalated after ${newRetryCount} connection-error retry attempt(s): ${errorMsg}. ` +
            `Manual intervention required — orchestrator will no longer retry this task automatically.`;
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Connection error: ${errorMsg} — escalation threshold (${escalationLimit}) reached after ${newRetryCount} attempt(s). Task escalated.`,
          });
          this.store.updateTask(task.id, {
            status: "escalated",
            result: escalationMsg,
            retry_count: newRetryCount,
            next_retry_at: null,
          });
          reportEscalation(
            this.config,
            this.store.getTask(task.id) ?? { ...task, result: escalationMsg, retry_count: newRetryCount },
            escalationLimit,
          );
        } else if (connExhausted) {
          const exhaustedResult = `connection-error-exhausted: ${errorMsg}`;
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Connection error: ${errorMsg} — max connection retries (${maxConnRetries}) exhausted, task permanently failed`,
          });
          this.store.updateTask(task.id, {
            status: "failed",
            result: exhaustedResult,
            retry_count: newRetryCount,
            next_retry_at: null,
          });
        } else {
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Connection error: ${errorMsg} — retry ${newRetryCount}/${maxConnRetries} scheduled at ${nextRetryAt}`,
          });
          this.store.updateTask(task.id, {
            status: "failed",
            result: errorMsg,
            retry_count: newRetryCount,
            next_retry_at: nextRetryAt,
          });
        }
      } else {
        // Logic error during retry — determine whether to escalate or permanently fail.
        // Logic errors are not retried again (no next_retry_at).
        const escalationLimit =
          this.config.escalation?.retry_limit ?? DEFAULT_ESCALATION_RETRY_LIMIT;
        const shouldEscalate = escalationLimit > 0 && newRetryCount >= escalationLimit;

        this.log.error("Retry failed (logic error, no further retry)", {
          taskId: task.id,
          agentName,
          error: errorMsg,
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
          reportEscalation(
            this.config,
            this.store.getTask(task.id) ?? { ...task, result: escalationMsg, retry_count: newRetryCount },
            escalationLimit,
          );
        } else {
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Retry error (logic error, no retry): ${errorMsg} — task permanently failed`,
          });
          this.store.updateTask(task.id, {
            status: "failed",
            result: errorMsg,
            retry_count: newRetryCount,
            next_retry_at: null,
          });
        }
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
