/**
 * Team Meeting — periodic alignment session where every agent contributes
 * their perspective and a supervisor synthesises decisions.
 *
 * Flow:
 *   1. Query each agent in parallel: blockers, opportunities, suggestions
 *   2. Synthesise all responses into aligned priorities and action items
 *   3. File a meeting summary issue, notify via Telegram
 *   4. Optionally update goals based on team input
 *
 * Designed to run weekly (configurable). Each agent speaks from its own
 * domain expertise — the proxy agent sees infrastructure issues the
 * orchestrator doesn't, the research agent surfaces findings, etc.
 */
import { AgentClient } from "../client/agent-client.js";
import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import { IssueCreator } from "./issue-creator.js";
import { loadGoals, measureGoalProgress, buildGoalsContext } from "./goals.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("team-meeting");

const DEFAULT_LLM_TIMEOUT_MS = 180_000; // 3 min for synthesis

export interface AgentPerspective {
  agentName: string;
  provider: string;
  pool: string | undefined;
  response: string | null;
  error: string | null;
}

export interface MeetingSummary {
  date: string;
  perspectives: AgentPerspective[];
  synthesis: string;
  actionItems: ActionItem[];
  goalAdjustments: string[];
}

export interface ActionItem {
  description: string;
  owner: string;
  priority: "high" | "medium" | "low";
}

const AGENT_PROMPT = `You are participating in a team meeting. Your role is to share your unique perspective as an agent working on this codebase.

Answer concisely (under 200 words total):

1. **Blockers**: What's preventing you from doing your best work? (tooling issues, missing context, recurring failures, unclear requirements)
2. **Opportunities**: What improvements could make the biggest impact in your domain? What patterns have you noticed that could be automated or improved?
3. **Suggestions for the team**: What should other agents know? Any cross-repo insights, shared pain points, or coordination improvements?

Be specific and actionable — not generic. Reference actual issues, PRs, or patterns you've encountered.`;

const SYNTHESIS_PROMPT = `You are the supervisor synthesising a team meeting for an autonomous AI agent fleet.

You'll receive perspectives from each agent about their blockers, opportunities, and suggestions. Your job:

1. **Cross-cutting themes**: Identify patterns that multiple agents mention — these are systemic issues worth prioritising
2. **Action items**: Concrete next steps with clear owners. Each action should be specific enough to become a GitHub issue
3. **Goal adjustments**: Based on team input, should any monthly goals be updated, added, or deprioritised?
4. **Resource allocation**: Are any agents under/over-utilised? Should work be redistributed?

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "themes": ["theme 1", "theme 2"],
  "action_items": [
    {"description": "specific action", "owner": "agent-name or pool", "priority": "high|medium|low"}
  ],
  "goal_adjustments": ["adjustment 1"],
  "resource_notes": "any rebalancing observations",
  "summary": "2-3 sentence executive summary of the meeting"
}`;

/**
 * Query a single agent for their perspective.
 * Uses a lightweight prompt — agent responds from its domain context.
 */
async function gatherPerspective(
  client: AgentClient,
  agentName: string,
  goalsContext: string,
): Promise<AgentPerspective> {
  const config = (client as unknown as { config: OrchestratorConfig }).config;
  const agent = config.agents[agentName];

  try {
    const response = await client.send(agentName, AGENT_PROMPT + "\n\n" + goalsContext, {
      systemPrompt: `You are ${agentName}. Your domain: ${agent?.description ?? "unknown"}. Capabilities: ${agent?.capabilities?.join(", ") ?? "general"}.`,
    });

    return {
      agentName,
      provider: agent?.provider ?? "claude",
      pool: agent?.pool,
      response: response.content,
      error: null,
    };
  } catch (err) {
    log.warn("Failed to gather perspective from agent", {
      agentName,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      agentName,
      provider: agent?.provider ?? "claude",
      pool: agent?.pool,
      response: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Synthesise all agent perspectives into a meeting summary.
 */
async function synthesise(
  config: OrchestratorConfig,
  perspectives: AgentPerspective[],
  goalsContext: string,
): Promise<{ synthesis: string; actionItems: ActionItem[]; goalAdjustments: string[] }> {
  const { client, model } = createLLMClient(config, "supervisor");

  const perspectiveText = perspectives
    .filter((p) => p.response)
    .map((p) => `### ${p.agentName} (${p.provider}, pool: ${p.pool ?? "none"})\n${p.response}`)
    .join("\n\n");

  const prompt = `${goalsContext}\n\n## Agent Perspectives\n\n${perspectiveText}`;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await client.messages.create({
        model: getLLMModel(config, "supervisor") ?? model,
        max_tokens: 4096,
        system: SYNTHESIS_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }, { signal: abortController.signal });
    } finally {
      clearTimeout(timer);
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? b.text : "")
      .join("");

    return parseSynthesis(text);
  } catch (err) {
    log.error("Meeting synthesis failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      synthesis: "Synthesis failed — see agent perspectives for raw input.",
      actionItems: [],
      goalAdjustments: [],
    };
  }
}

function parseSynthesis(text: string): {
  synthesis: string;
  actionItems: ActionItem[];
  goalAdjustments: string[];
} {
  const strategies = [
    () => JSON.parse(text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()),
    () => {
      const match = text.match(/\{[\s\S]*"action_items"[\s\S]*\}/);
      if (!match) throw new Error("No JSON found");
      return JSON.parse(match[0]);
    },
  ];

  for (const strategy of strategies) {
    try {
      const parsed = strategy();
      return {
        synthesis: parsed.summary ?? text.slice(0, 500),
        actionItems: (parsed.action_items ?? []).map((a: Record<string, string>) => ({
          description: a.description ?? "",
          owner: a.owner ?? "system",
          priority: (a.priority as ActionItem["priority"]) ?? "medium",
        })),
        goalAdjustments: parsed.goal_adjustments ?? [],
      };
    } catch {
      continue;
    }
  }

  return { synthesis: text.slice(0, 500), actionItems: [], goalAdjustments: [] };
}

/**
 * Run a full team meeting: gather perspectives, synthesise, file summary.
 */
export async function runTeamMeeting(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<MeetingSummary> {
  log.info("Starting team meeting");

  const goals = loadGoals(config.orchestrator_dir);
  const progress = goals.goals.length > 0 ? measureGoalProgress(goals, store) : [];
  const goalsContext = buildGoalsContext(progress);

  const client = new AgentClient(config);

  // Pick one agent per pool (avoid querying duplicates)
  const seenPools = new Set<string>();
  const agentsToQuery: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.docker?.port) continue;
    // Skip Telegram handler — not a coding agent
    if (name.includes("telegram")) continue;
    // One per pool
    const poolKey = agent.pool ?? name;
    if (seenPools.has(poolKey)) continue;
    seenPools.add(poolKey);
    agentsToQuery.push(name);
  }

  log.info("Gathering agent perspectives", { agents: agentsToQuery });

  // Query all agents in parallel
  const perspectivePromises = agentsToQuery.map((name) =>
    gatherPerspective(client, name, goalsContext),
  );
  const perspectives = await Promise.all(perspectivePromises);

  const responded = perspectives.filter((p) => p.response).length;
  const failed = perspectives.filter((p) => p.error).length;
  log.info("Perspectives gathered", { responded, failed, total: perspectives.length });

  // Synthesise
  const { synthesis, actionItems, goalAdjustments } = await synthesise(
    config, perspectives, goalsContext,
  );

  const summary: MeetingSummary = {
    date: new Date().toISOString().slice(0, 10),
    perspectives,
    synthesis,
    actionItems,
    goalAdjustments,
  };

  // File meeting summary as GitHub issue
  try {
    const issueCreator = new IssueCreator(config);
    const perspectivesSection = perspectives
      .filter((p) => p.response)
      .map((p) => `### ${p.agentName}\n${p.response}`)
      .join("\n\n");

    const actionSection = actionItems.length > 0
      ? actionItems.map((a) => `- [${a.priority.toUpperCase()}] ${a.description} (owner: ${a.owner})`).join("\n")
      : "No action items identified.";

    const goalSection = goalAdjustments.length > 0
      ? goalAdjustments.map((g) => `- ${g}`).join("\n")
      : "No goal adjustments proposed.";

    const body = `## Team Meeting — ${summary.date}

### Executive Summary
${synthesis}

### Action Items
${actionSection}

### Goal Adjustments
${goalSection}

### Agent Perspectives
${perspectivesSection}

---
*Auto-generated by the team meeting system. Review action items and create follow-up issues as needed.*`;

    issueCreator.createIssue(
      "rapartlu/agent-orchestrator",
      `[Team Meeting] ${summary.date} — ${actionItems.length} action items`,
      body,
      ["team-meeting"],
    );
  } catch (err) {
    log.warn("Failed to file meeting summary issue", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Send full meeting report via Telegram (multiple messages to fit limits)
  await sendMeetingToTelegram(summary).catch((err) => {
    log.warn("Failed to send meeting report to Telegram", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info("Team meeting complete", {
    perspectives: responded,
    actionItems: actionItems.length,
    goalAdjustments: goalAdjustments.length,
  });

  return summary;
}

// ── Telegram full report ────────────────────────────────────────────────────

function loadTelegramConfig(): { botToken: string; chatId: string } | null {
  const envPath = join(homedir(), ".claude-orchestrator", ".env");
  try {
    const content = readFileSync(envPath, "utf-8");
    const botToken = content.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
    const chatId = content.match(/^TELEGRAM_CHAT_ID=(.+)$/m)?.[1]?.trim();
    if (botToken && chatId) return { botToken, chatId };
  } catch { /* no config */ }
  return null;
}

async function sendTelegramText(config: { botToken: string; chatId: string }, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: "Markdown" }),
  });
}

/**
 * Send the full meeting report as a series of Telegram messages:
 *   1. Header + synthesis + action items
 *   2. Each agent's perspective (one message per agent)
 */
async function sendMeetingToTelegram(summary: MeetingSummary): Promise<void> {
  const config = loadTelegramConfig();
  if (!config) return;

  // Message 1: Summary + actions
  const actionLines = summary.actionItems.length > 0
    ? summary.actionItems.map((a) => `  [${a.priority.toUpperCase()}] ${a.description} → ${a.owner}`).join("\n")
    : "  None identified.";

  const goalLines = summary.goalAdjustments.length > 0
    ? summary.goalAdjustments.map((g) => `  • ${g}`).join("\n")
    : "  No changes proposed.";

  const responded = summary.perspectives.filter((p) => p.response).length;

  const header = `🤝 *Team Meeting — ${summary.date}*
${responded}/${summary.perspectives.length} agents participated

*Synthesis:*
${summary.synthesis}

*Action Items:*
${actionLines}

*Goal Adjustments:*
${goalLines}`;

  await sendTelegramText(config, header);

  // Message 2+: Agent perspectives (batched to stay under 4096 chars)
  let batch = "*Agent Perspectives:*\n";
  for (const p of summary.perspectives) {
    const entry = p.response
      ? `\n*${p.agentName}* (${p.provider}):\n${p.response.slice(0, 600)}\n`
      : `\n*${p.agentName}*: ❌ no response\n`;

    if (batch.length + entry.length > 3800) {
      await sendTelegramText(config, batch);
      batch = "";
    }
    batch += entry;
  }
  if (batch.trim()) {
    await sendTelegramText(config, batch);
  }
}
