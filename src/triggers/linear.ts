import { createProxyClient } from "../client/proxy-client.js";
import type { OrchestratorConfig, AgentLinearConfig } from "../config/schema.js";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  team: string;
  status: string;
  labels: string[];
}

const SYSTEM_PROMPT = `You are a data fetcher. Use the Linear MCP tools available to you to fetch issues.
Return ONLY a JSON array (no markdown, no explanation, no code fences).
Each item should have: id, identifier, title, description, url, team, status, labels (array of strings).
If there are no issues, return an empty array: []`;

export async function fetchLinearIssues(
  config: OrchestratorConfig,
  linearConfig: AgentLinearConfig,
): Promise<LinearIssue[]> {
  const client = createProxyClient(
    config.proxy,
    config.orchestrator_dir,
    {},
  );

  const filters: string[] = [];
  if (linearConfig.teams?.length) {
    filters.push(`in teams: ${linearConfig.teams.join(", ")}`);
  }
  if (linearConfig.projects?.length) {
    filters.push(`in projects: ${linearConfig.projects.join(", ")}`);
  }

  const prompt = `Fetch open Linear issues${filters.length ? " " + filters.join(" and ") : ""}. Return as JSON array.`;

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
    throw new Error(`Linear fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseResponse(text: string): LinearIssue[] {
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item: Record<string, unknown>) => ({
      id: String(item.id ?? ""),
      identifier: String(item.identifier ?? ""),
      title: String(item.title ?? ""),
      description: String(item.description ?? ""),
      url: String(item.url ?? ""),
      team: String(item.team ?? ""),
      status: String(item.status ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
    }));
  } catch {
    return [];
  }
}
