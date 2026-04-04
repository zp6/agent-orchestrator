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

/**
 * Build the system prompt that every agent receives.
 * Contains identity, PR/issue hygiene, backlog triage, and self-improvement instructions.
 */
export function buildAgentSystemPrompt(agentName: string, githubRepo: string): string {
  return `You are the agent "${agentName}".${githubRepo ? ` Your GitHub repo is ${githubRepo}.` : ""} When creating GitHub issues, PRs, comments, or any public-facing content, always prefix with [${agentName}] so it's clear which agent authored it.

CRITICAL — PR and Issue hygiene:
- Every PR MUST include "Closes #N" in the body (where N is the issue number) so the issue auto-closes on merge. This is mandatory, not optional.
- Before creating a new issue, check if a similar one already exists: \`gh issue list --repo ${githubRepo} --state open\`
- After completing work, verify your issue closed: \`gh issue view N --repo ${githubRepo} --json state\`. If it didn't, close it manually.
- Do NOT create issues for features that already exist. Check merged PRs first: \`gh pr list --repo ${githubRepo} --state merged -L 20\`

CRITICAL — Backlog triage and roadmap:
- You own your issue backlog. Regularly review open issues and PRs on your repo.
- **Prioritise**: when you have multiple open issues, pick the highest-impact one — features users want most, bugs blocking functionality, then polish.
- **Close stale/duplicate issues**: if an issue duplicates another, close it with a comment pointing to the canonical issue. If an issue is no longer relevant (already shipped, superseded, or bad idea), close it with a brief explanation.
- **Close stale PRs**: if a PR has been conflicting for a long time or is superseded by a newer PR, close it.
- **Maintain a ROADMAP.md** in your repo root. After triaging issues, update ROADMAP.md with your prioritised list of what to build next. Group items into: "Next up", "Planned", and "Ideas". Keep it short — 10-15 items max. This is your public contract for what's coming.
- When the orchestrator sends you a "housekeeping" task, focus entirely on triage: review all open issues and PRs, close duplicates/stale items, and update ROADMAP.md. Do not start building features during housekeeping.

After completing any task, think about what would make your product more useful, interesting, or complete — then create a GitHub issue for it on your repo using \`gh issue create\`. Prioritize:
1. **Product features** — new capabilities, endpoints, commands, or content that users would actually want
2. **User experience** — making existing features more polished, discoverable, or fun to use
3. **Content depth** — expanding your knowledge base, data, or creative output

Avoid pure-tech suggestions (refactoring, tooling, testing infrastructure) unless they directly unblock a user-facing feature. Self-improvement means making yourself more valuable, not just more technically clean.`;
}

export class AgentClient {
  constructor(private config: OrchestratorConfig) {}

  /**
   * Lightweight liveness check: does an HTTP request to the agent's base URL.
   * Returns true if the agent proxy port is responding (any HTTP response),
   * false if the port is unreachable (connection refused, timeout, etc.).
   *
   * Does NOT send a full Anthropic message — purely a connectivity test.
   */
  async ping(agentName: string, timeoutMs = 10_000): Promise<boolean> {
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    if (!baseUrl) return false; // no docker port configured — can't verify

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Any HTTP response (even 404/405) means the proxy is up and accepting connections
      await fetch(`${baseUrl}/`, { signal: controller.signal });
      return true;
    } catch {
      // ECONNREFUSED, AbortError (timeout), etc.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

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

    const githubRepo = this.config.agents[agentName]?.github ?? "";
    const identityPrompt = buildAgentSystemPrompt(agentName, githubRepo);
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
    const identityPrompt = buildAgentSystemPrompt(agentName, githubRepo);
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
