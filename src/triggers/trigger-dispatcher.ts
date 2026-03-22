import { fetchOpenIssues, type GitHubIssue } from "./github.js";
import { reportResult } from "./reporters.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

export interface TriggerResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

/**
 * GitHub: fetch issues centrally via gh CLI, dispatch each to the owning agent.
 */
export async function dispatchGitHubIssues(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  maxPerAgent = 1,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;

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

      const message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

      try {
        const dispatchResult = await dispatcher.dispatch(message, {
          agentName,
          source: "github",
          sourceRef,
          title: `[${issue.repo}#${issue.number}] ${issue.title}`,
        });

        store.markProcessed("github", sourceRef, dispatchResult.taskId);
        result.dispatched++;
        dispatchedForAgent++;

        const task = store.getTask(dispatchResult.taskId);
        if (task) {
          try { await reportResult(config, task); } catch { /* non-blocking */ }
        }
      } catch (err) {
        result.errors.push(`${sourceRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

/**
 * Linear: ask each agent to check its own Linear issues and work on them.
 * The agent uses Linear MCP tools directly — no central fetching needed.
 */
export async function dispatchLinearChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.linear) continue;

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

    try {
      const dispatchResult = await dispatcher.dispatch(message, {
        agentName,
        source: "linear",
        sourceRef,
        title: `[linear] Check issues for ${agentName}`,
      });

      store.markProcessed("linear", sourceRef, dispatchResult.taskId);
      result.dispatched++;
    } catch (err) {
      result.errors.push(`linear/${agentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Slack: ask each agent to check its Slack channels and respond to mentions.
 * The agent uses Slack MCP tools directly.
 */
export async function dispatchSlackChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.slack) continue;

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

    try {
      const dispatchResult = await dispatcher.dispatch(message, {
        agentName,
        source: "slack",
        sourceRef,
        title: `[slack] Check messages for ${agentName}`,
      });

      store.markProcessed("slack", sourceRef, dispatchResult.taskId);
      result.dispatched++;
    } catch (err) {
      result.errors.push(`slack/${agentName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
