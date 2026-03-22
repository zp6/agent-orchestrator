import { execSync } from "node:child_process";
import { createProxyClient } from "../client/proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

export async function reportResult(
  config: OrchestratorConfig,
  task: Task,
): Promise<void> {
  if (!task.source_ref || !task.result) return;

  switch (task.source) {
    case "github":
      await reportToGitHub(task);
      break;
    case "linear":
      await reportToLinear(config, task);
      break;
    case "slack":
      await reportToSlack(config, task);
      break;
  }
}

async function reportToGitHub(task: Task): Promise<void> {
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

async function reportToLinear(config: OrchestratorConfig, task: Task): Promise<void> {
  const client = createProxyClient(config.proxy, config.orchestrator_dir, {});
  const comment = formatComment(task.result!);

  await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: "You are a helper. Use the Linear MCP tools to post a comment on an issue. Do not add any extra text, just post the comment.",
    messages: [{
      role: "user",
      content: `Post this comment on Linear issue ${task.source_ref}:\n\n${comment}`,
    }],
  });
}

async function reportToSlack(config: OrchestratorConfig, task: Task): Promise<void> {
  const sourceRef = task.source_ref!;
  const colonIndex = sourceRef.indexOf(":");
  if (colonIndex < 0) return;

  const channelId = sourceRef.slice(0, colonIndex);
  const threadTs = sourceRef.slice(colonIndex + 1);

  const client = createProxyClient(config.proxy, config.orchestrator_dir, {});
  const comment = formatComment(task.result!);

  await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: "You are a helper. Use the Slack MCP tools to send a message. Do not add any extra text, just send the message.",
    messages: [{
      role: "user",
      content: `Send this message to Slack channel ${channelId} as a reply to thread ${threadTs}:\n\n${comment}`,
    }],
  });
}

function formatComment(result: string): string {
  const truncated = result.length > 2000 ? result.slice(0, 2000) + "\n\n...(truncated)" : result;
  return `**Orchestrator Result:**\n\n${truncated}`;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
