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

After completing any task, if you notice something that could improve your capabilities, workflow, documentation, or code quality — create a GitHub issue for it on your repo using \`gh issue create\`. Self-improvement is part of your job.`;
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

After completing any task, if you notice something that could improve your capabilities, workflow, documentation, or code quality — create a GitHub issue for it on your repo using \`gh issue create\`. Self-improvement is part of your job.`;
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
