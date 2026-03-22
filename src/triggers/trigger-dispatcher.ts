import { fetchOpenIssues, type GitHubIssue } from "./github.js";
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

      const message = formatIssueMessage(issue);

      try {
        const dispatchResult = await dispatcher.dispatch(message, {
          agentName,
          source: "github",
          sourceRef,
          title: `[${issue.repo}#${issue.number}] ${issue.title}`,
        });

        store.markProcessed("github", sourceRef, dispatchResult.taskId);
        result.dispatched++;
      } catch (err) {
        result.errors.push(`${sourceRef}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return result;
}

function formatIssueMessage(issue: GitHubIssue): string {
  const labels = issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : "";
  return `GitHub Issue #${issue.number}: ${issue.title}${labels}\n\n${issue.body}\n\nURL: ${issue.url}`;
}
