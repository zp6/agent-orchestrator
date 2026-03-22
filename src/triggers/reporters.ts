import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

/**
 * Report task results back to the source.
 * GitHub: comment via gh CLI (orchestrator handles centrally since it fetches issues centrally).
 * Linear/Slack: agents report back directly using their own MCP tools during execution.
 */
export async function reportResult(
  _config: OrchestratorConfig,
  task: Task,
): Promise<void> {
  if (!task.source_ref || !task.result) return;

  if (task.source === "github") {
    reportToGitHub(task);
  }
}

function reportToGitHub(task: Task): void {
  const sourceRef = task.source_ref!;
  const hashIndex = sourceRef.lastIndexOf("#");
  if (hashIndex < 0) return;

  const repo = sourceRef.slice(0, hashIndex);
  const issueNumber = sourceRef.slice(hashIndex + 1);

  const comment = formatComment(task.result!);

  execSync(
    `gh issue comment ${issueNumber} --repo ${repo} --body ${shellEscape(comment)}`,
    { encoding: "utf-8", timeout: 30000 },
  );
}

function formatComment(result: string): string {
  const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n\n...(truncated)" : result;
  return `**Orchestrator Result:**\n\n${truncated}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
