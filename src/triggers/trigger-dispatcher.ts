import { fetchOpenIssues, type GitHubIssue } from "./github.js";
import { reportResult } from "./reporters.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("trigger-dispatcher");

export interface TriggerResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

/**
 * Check if an agent already has a task in-flight (dispatched but not done/failed).
 * Only one task per agent at a time to avoid context conflicts.
 */
function hasInFlightTask(store: StateStore, agentName: string): boolean {
  const tasks = store.listTasks({ status: "dispatched", agent_name: agentName, limit: 1 });
  return tasks.length > 0;
}

/**
 * Fire-and-forget dispatch: starts the dispatch without blocking.
 * The daemon continues its cycle while the agent works.
 */
function fireAndForget(
  dispatcher: Dispatcher,
  store: StateStore,
  config: OrchestratorConfig,
  message: string,
  options: { agentName: string; source: "github" | "linear" | "slack"; sourceRef: string; title: string },
): void {
  dispatcher.dispatch(message, options).then((result) => {
    store.markProcessed(options.source, options.sourceRef, result.taskId);
    log.info("Fire-and-forget dispatch completed", { taskId: result.taskId, agentName: options.agentName });

    // Report result back to source
    const task = store.getTask(result.taskId);
    if (task) {
      reportResult(config, task).catch(() => {});
    }
  }).catch((err) => {
    log.error("Fire-and-forget dispatch failed", { agentName: options.agentName, sourceRef: options.sourceRef, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * GitHub: fetch issues centrally via gh CLI, dispatch each to the owning agent.
 */
export async function dispatchGitHubIssues(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  maxPerAgent = 1,
  registeredAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) {
      log.info("Skipping agent with in-flight task", { agentName });
      continue;
    }

    let issues: GitHubIssue[];
    try {
      issues = fetchOpenIssues(agent.github);
    } catch (err) {
      result.errors.push(`${agent.github}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let dispatchedForAgent = 0;
    for (const issue of issues) {
      if (dispatchedForAgent >= maxPerAgent) break;

      const sourceRef = `${issue.repo}#${issue.number}`;

      if (store.isProcessed("github", sourceRef)) {
        result.skipped++;
        continue;
      }

      const message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}\n\n---\nWhen done: create a branch, commit, push, and open a PR with \`gh pr create --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`. The "Closes #${issue.number}" is required so the issue auto-closes on merge.`;

      // Mark processed immediately to prevent duplicate dispatches
      store.markProcessed("github", sourceRef, "pending");

      // Fire and forget — don't block the daemon cycle
      fireAndForget(dispatcher, store, config, message, {
        agentName,
        source: "github",
        sourceRef,
        title: `[${issue.repo}#${issue.number}] ${issue.title}`,
      });

      result.dispatched++;
      dispatchedForAgent++;
    }
  }

  return result;
}

/**
 * Linear: ask each agent to check its own Linear issues and work on them.
 */
export async function dispatchLinearChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  registeredAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.linear) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) continue;

    const sourceRef = `linear-check:${agentName}:${new Date().toISOString().slice(0, 13)}`;

    if (store.isProcessed("linear", sourceRef)) {
      result.skipped++;
      continue;
    }

    const filters: string[] = [];
    if (agent.linear.teams?.length) {
      filters.push(`in teams: ${agent.linear.teams.join(", ")}`);
    }
    if (agent.linear.projects?.length) {
      filters.push(`in projects: ${agent.linear.projects.join(", ")}`);
    }

    const message = `Check Linear for open issues assigned to you${filters.length ? " " + filters.join(" and ") : ""}. For each issue you find:
1. Review the issue description
2. If you can address it, do the work
3. Comment on the Linear issue with your progress or result
4. If you can't address it, note why

Report back what you found and what you did.`;

    store.markProcessed("linear", sourceRef, "pending");

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "linear",
      sourceRef,
      title: `[linear] Check issues for ${agentName}`,
    });

    result.dispatched++;
  }

  return result;
}

/**
 * Slack: ask each agent to check its Slack channels and respond to mentions.
 */
export async function dispatchSlackChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  registeredAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.slack) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) continue;

    const sourceRef = `slack-check:${agentName}:${new Date().toISOString().slice(0, 13)}`;

    if (store.isProcessed("slack", sourceRef)) {
      result.skipped++;
      continue;
    }

    const pattern = agent.slack.mention_pattern ?? "@orchestrator";
    const channelFilter = agent.slack.channels?.length
      ? ` in channels: ${agent.slack.channels.join(", ")}`
      : "";

    const message = `Check Slack for recent messages mentioning "${pattern}"${channelFilter}. For each relevant message:
1. Read the message and any thread context
2. If it's a task or question you can handle, do the work
3. Reply in the Slack thread with your response
4. If it's not for you, skip it

Report back what you found and what you did.`;

    store.markProcessed("slack", sourceRef, "pending");

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "slack",
      sourceRef,
      title: `[slack] Check messages for ${agentName}`,
    });

    result.dispatched++;
  }

  return result;
}
