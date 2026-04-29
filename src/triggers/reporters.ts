import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";

/** Default retry limit used when `escalation.retry_limit` is not configured. */
export const DEFAULT_ESCALATION_RETRY_LIMIT = 3;

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

// ─────────────────────────────────────────────────────────────────────────────
// Escalation reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post an escalation notice back to the original trigger source.
 * For GitHub tasks this adds an issue comment flagging that the task was
 * auto-escalated after exceeding the configured retry limit so a human knows
 * manual attention is needed.
 *
 * Returns true if the comment was successfully posted (or was already present),
 * false on any posting failure (non-fatal — escalation still proceeds).
 */
export function reportEscalation(
  _config: OrchestratorConfig,
  task: Task,
  retryLimit: number,
): boolean {
  if (!task.source_ref) return false;
  if (task.source === "github") {
    return postEscalationCommentToGitHub(task, retryLimit);
  }
  // Linear / Slack: agents handle their own reporting; nothing to do here.
  return false;
}

function postEscalationCommentToGitHub(task: Task, retryLimit: number): boolean {
  const sourceRef = task.source_ref!;
  const hashIndex = sourceRef.lastIndexOf("#");
  if (hashIndex < 0) return false;

  const repo = sourceRef.slice(0, hashIndex);
  const issueNumber = sourceRef.slice(hashIndex + 1);

  // Skip if an escalation comment was already posted (idempotent).
  if (hasExistingEscalationComment(repo, issueNumber)) return true;

  const agentTag = task.agent_name ? `[${task.agent_name}]` : "[claude-agent-orchestrator]";
  const body =
    `**${agentTag} Auto-Escalation Notice**\n\n` +
    `This issue has been automatically escalated after **${retryLimit} failed retry attempt(s)** ` +
    `by agent \`${task.agent_name ?? "unknown"}\`.\n\n` +
    `**Last error:**\n${(task.result ?? "No error details available.").slice(0, 800)}\n\n` +
    `Manual intervention is required. The orchestrator has stopped automatic retries for this issue.\n\n` +
    `> Task ID: \`${task.id}\` | Source: \`${task.source_ref}\``;

  try {
    execSync(
      `gh issue comment ${issueNumber} --repo ${repo} --body ${shellEscape(body)}`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return true;
  } catch {
    return false;
  }
}

function hasExistingEscalationComment(repo: string, issueNumber: string): boolean {
  try {
    const raw = execSync(
      `gh api "repos/${repo}/issues/${issueNumber}/comments?per_page=100" --jq '.[].body'`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();
    if (!raw) return false;
    return raw.split("\n").some((line) => line.includes("Auto-Escalation Notice"));
  } catch {
    return false; // fail-open: better to duplicate than to stay silent
  }
}
