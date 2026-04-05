import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";

/**
 * Report task results back to the source.
 * GitHub: comment via gh CLI (orchestrator handles centrally since it fetches issues centrally).
 * Linear/Slack: agents report back directly using their own MCP tools during execution.
 */
export async function reportResult(
  _config: OrchestratorConfig,
  task: Task,
  store?: StateStore,
): Promise<void> {
  if (!task.source_ref || !task.result) return;

  // DB-level dedup: skip if already reported (survives daemon restarts)
  if (task.reported) return;

  if (task.source === "github") {
    const posted = reportToGitHub(task);
    if (posted && store) {
      store.markReported(task.id);
    }
  }
}

function reportToGitHub(task: Task): boolean {
  const sourceRef = task.source_ref!;
  const hashIndex = sourceRef.lastIndexOf("#");
  if (hashIndex < 0) return false;

  const repo = sourceRef.slice(0, hashIndex);
  const issueNumber = sourceRef.slice(hashIndex + 1);

  if (hasExistingResultComment(repo, issueNumber, task.agent_name ?? undefined)) {
    return false;
  }

  const comment = formatComment(task.result!, task.agent_name ?? undefined);

  try {
    execSync(
      `gh issue comment ${issueNumber} --repo ${repo} --body ${shellEscape(comment)}`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return true;
  } catch {
    return false;
  }
}

function hasExistingResultComment(repo: string, issueNumber: string, agentName?: string): boolean {
  try {
    const prefix = agentName ? `**[${agentName}] Orchestrator Result:**` : `**[orchestrator] Result:**`;
    const raw = execSync(
      `gh api "repos/${repo}/issues/${issueNumber}/comments?per_page=100" --jq '.[].body'`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();
    if (!raw) return false;
    return raw.split("\n").some((line) => line.startsWith(prefix));
  } catch {
    return true; // fail-closed: better to skip than to duplicate
  }
}

function formatComment(result: string, agentName?: string): string {
  const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n\n...(truncated)" : result;
  const attribution = agentName ? `**[${agentName}] Orchestrator Result:**` : `**[orchestrator] Result:**`;
  return `${attribution}\n\n${truncated}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
