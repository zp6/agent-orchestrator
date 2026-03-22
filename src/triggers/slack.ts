import { createProxyClient } from "../client/proxy-client.js";
import type { OrchestratorConfig, AgentSlackConfig } from "../config/schema.js";

export interface SlackMessage {
  channel: string;
  channel_id: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

const SYSTEM_PROMPT = `You are a data fetcher. Use the Slack MCP tools available to you to search for messages.
Return ONLY a JSON array (no markdown, no explanation, no code fences).
Each item should have: channel (name), channel_id, user, text, ts (timestamp string), thread_ts (optional).
If there are no matching messages, return an empty array: []`;

export async function fetchSlackMessages(
  config: OrchestratorConfig,
  slackConfig: AgentSlackConfig,
): Promise<SlackMessage[]> {
  const client = createProxyClient(
    config.proxy,
    config.orchestrator_dir,
    {},
  );

  const pattern = slackConfig.mention_pattern ?? "@orchestrator";
  const channelFilter = slackConfig.channels?.length
    ? ` in channels: ${slackConfig.channels.join(", ")}`
    : "";

  const prompt = `Search Slack for recent messages mentioning "${pattern}"${channelFilter}. Return as JSON array.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? b.text : "")
      .join("");

    return parseResponse(text);
  } catch (err) {
    throw new Error(`Slack fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseResponse(text: string): SlackMessage[] {
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: Record<string, unknown>) => ({
      channel: String(item.channel ?? ""),
      channel_id: String(item.channel_id ?? ""),
      user: String(item.user ?? ""),
      text: String(item.text ?? ""),
      ts: String(item.ts ?? ""),
      thread_ts: item.thread_ts ? String(item.thread_ts) : undefined,
    }));
  } catch {
    return [];
  }
}
