import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentApiKey, getAgentBaseUrl } from "../config/schema.js";

export interface AgentResponse {
  content: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}

export class AgentClient {
  constructor(private config: OrchestratorConfig) {}

  async send(
    agentName: string,
    message: string,
    options?: {
      conversationId?: string;
      systemPrompt?: string;
      model?: string;
    },
  ): Promise<AgentResponse> {
    const workingDir = getAgentDir(this.config, agentName);
    const apiKey = getAgentApiKey(this.config, agentName);
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    const client = createProxyClient(this.config.proxy, workingDir, {
      conversationId: options?.conversationId,
      apiKey,
      baseUrl,
    });

    // Build system prompt with agent identity + self-improvement
    const githubRepo = this.config.agents[agentName]?.github ?? "";
    const identityPrompt = `You are the agent "${agentName}".${githubRepo ? ` Your GitHub repo is ${githubRepo}.` : ""} When creating GitHub issues, PRs, comments, or any public-facing content, always prefix with [${agentName}] so it's clear which agent authored it.

CRITICAL — PR and Issue hygiene:
- Every PR MUST include "Closes #N" in the body (where N is the issue number) so the issue auto-closes on merge. This is mandatory, not optional.
- Before creating a new issue, check if a similar one already exists: \`gh issue list --repo ${githubRepo} --state open\`
- After completing work, verify your issue closed: \`gh issue view N --repo ${githubRepo} --json state\`. If it didn't, close it manually.
- Do NOT create issues for features that already exist. Check merged PRs first: \`gh pr list --repo ${githubRepo} --state merged -L 20\`

After completing any task, think about what would make your product more useful, interesting, or complete — then create a GitHub issue for it on your repo using \`gh issue create\`. Prioritize:
1. **Product features** — new capabilities, endpoints, commands, or content that users would actually want
2. **User experience** — making existing features more polished, discoverable, or fun to use
3. **Content depth** — expanding your knowledge base, data, or creative output

Avoid pure-tech suggestions (refactoring, tooling, testing infrastructure) unless they directly unblock a user-facing feature. Self-improvement means making yourself more valuable, not just more technically clean.`;
    const systemPrompt = options?.systemPrompt
      ? `${identityPrompt}\n\n${options.systemPrompt}`
      : identityPrompt;

    const response = await client.messages.create({
      model: options?.model ?? "claude-sonnet-4-6",
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      content: textContent,
      model: response.model,
      usage: response.usage,
      stop_reason: response.stop_reason,
    };
  }

  async *stream(
    agentName: string,
    message: string,
    options?: {
      conversationId?: string;
      systemPrompt?: string;
      model?: string;
    },
  ): AsyncGenerator<string> {
    const workingDir = getAgentDir(this.config, agentName);
    const apiKey = getAgentApiKey(this.config, agentName);
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    const client = createProxyClient(this.config.proxy, workingDir, {
      conversationId: options?.conversationId,
      apiKey,
      baseUrl,
    });

    const githubRepo = this.config.agents[agentName]?.github ?? "";
    const identityPrompt = `You are the agent "${agentName}".${githubRepo ? ` Your GitHub repo is ${githubRepo}.` : ""} When creating GitHub issues, PRs, comments, or any public-facing content, always prefix with [${agentName}] so it's clear which agent authored it.

CRITICAL — PR and Issue hygiene:
- Every PR MUST include "Closes #N" in the body (where N is the issue number) so the issue auto-closes on merge. This is mandatory, not optional.
- Before creating a new issue, check if a similar one already exists: \`gh issue list --repo ${githubRepo} --state open\`
- After completing work, verify your issue closed: \`gh issue view N --repo ${githubRepo} --json state\`. If it didn't, close it manually.
- Do NOT create issues for features that already exist. Check merged PRs first: \`gh pr list --repo ${githubRepo} --state merged -L 20\`

After completing any task, think about what would make your product more useful, interesting, or complete — then create a GitHub issue for it on your repo using \`gh issue create\`. Prioritize:
1. **Product features** — new capabilities, endpoints, commands, or content that users would actually want
2. **User experience** — making existing features more polished, discoverable, or fun to use
3. **Content depth** — expanding your knowledge base, data, or creative output

Avoid pure-tech suggestions (refactoring, tooling, testing infrastructure) unless they directly unblock a user-facing feature. Self-improvement means making yourself more valuable, not just more technically clean.`;
    const systemPrompt = options?.systemPrompt
      ? `${identityPrompt}\n\n${options.systemPrompt}`
      : identityPrompt;

    const stream = client.messages.stream({
      model: options?.model ?? "claude-sonnet-4-6",
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
