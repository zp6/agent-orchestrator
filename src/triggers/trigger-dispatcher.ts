import { fetchOpenIssues, type GitHubIssue } from "./github.js";
import { fetchLinearIssues, type LinearIssue } from "./linear.js";
import { fetchSlackMessages, type SlackMessage } from "./slack.js";
import { reportResult } from "./reporters.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

export interface TriggerResult {
  dispatched: number;
  skipped: number;
  errors: string[];
}

export async function dispatchGitHubIssues(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
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

    for (const issue of issues) {
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

        // Report result back to GitHub
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

export async function dispatchLinearIssues(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.linear) continue;

    let issues: LinearIssue[];
    try {
      issues = await fetchLinearIssues(config, agent.linear);
    } catch (err) {
      result.errors.push(`linear/${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const issue of issues) {
      const sourceRef = issue.identifier;

      if (store.isProcessed("linear", sourceRef)) {
        result.skipped++;
        continue;
      }

      const message = `Linear Issue ${issue.identifier}: ${issue.title}\nStatus: ${issue.status}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.description}\n\nURL: ${issue.url}`;

      try {
        const dispatchResult = await dispatcher.dispatch(message, {
          agentName,
          source: "linear",
          sourceRef,
          title: `[${issue.identifier}] ${issue.title}`,
        });

        store.markProcessed("linear", sourceRef, dispatchResult.taskId);
        result.dispatched++;

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

export async function dispatchSlackMessages(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.slack) continue;

    let messages: SlackMessage[];
    try {
      messages = await fetchSlackMessages(config, agent.slack);
    } catch (err) {
      result.errors.push(`slack/${agentName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const msg of messages) {
      const sourceRef = `${msg.channel_id}:${msg.ts}`;

      if (store.isProcessed("slack", sourceRef)) {
        result.skipped++;
        continue;
      }

      const message = `Slack message from ${msg.user} in #${msg.channel}:\n\n${msg.text}`;

      try {
        const dispatchResult = await dispatcher.dispatch(message, {
          agentName,
          source: "slack",
          sourceRef,
          title: `[slack/#${msg.channel}] ${msg.text.slice(0, 80)}`,
        });

        store.markProcessed("slack", sourceRef, dispatchResult.taskId);
        result.dispatched++;

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
