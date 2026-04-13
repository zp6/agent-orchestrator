/**
 * Team Meeting — periodic alignment sessions where agents contribute
 * perspectives across multiple rounds of discussion.
 *
 * Two meeting types:
 *   - standup: blockers, opportunities, action items (daily)
 *   - bluesky: creative ideation, "what if" thinking, bold proposals (daily)
 *
 * Multi-round flow:
 *   Round 1: Each agent shares initial perspective (parallel)
 *   Round 2: Each agent sees all Round 1 responses and reacts (parallel)
 *   Round 3+: Optional — supervisor can ask follow-up questions
 *   Final: Supervisor synthesises all rounds into outcomes
 *
 * Each round is parallel (all agents queried simultaneously).
 * Conversation builds because each round's context includes all prior rounds.
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

const DEFAULT_LLM_TIMEOUT_MS = 180_000;

// ── Types ───────────────────────────────────────────────────────────────────

export type MeetingType = "standup" | "bluesky";

export interface RoundEntry {
  agentName: string;
  provider: string;
  pool: string | undefined;
  response: string | null;
  error: string | null;
}

export interface MeetingRound {
  roundNumber: number;
  prompt: string;
  entries: RoundEntry[];
}

export interface ActionItem {
  description: string;
  owner: string;
  priority: "high" | "medium" | "low";
}

export interface MeetingSummary {
  date: string;
  type: MeetingType;
  rounds: MeetingRound[];
  synthesis: string;
  actionItems: ActionItem[];
  goalAdjustments: string[];
}

export interface MeetingOptions {
  type?: MeetingType;
  rounds?: number;
}

// ── Prompts per meeting type ────────────────────────────────────────────────

const STANDUP_ROUND1 = `You are in a daily standup. Share your perspective concisely (under 200 words):

1. **Blockers**: What's preventing you from doing your best work?
2. **Opportunities**: What improvements could make the biggest impact in your domain?
3. **Suggestions for the team**: What should other agents know?
4. **Coverage gaps**: Are there tasks in your domain that a more specialised agent should handle?

Be specific — reference actual issues, PRs, or patterns.`;

const STANDUP_ROUND2 = `Round 2: You've seen what every other agent said. Now react (under 150 words):

1. **Agree/build**: Which points from other agents resonate? How can you help?
2. **Disagree/clarify**: Anything you see differently?
3. **Cross-team opportunity**: Any collaboration that would multiply impact?

Don't repeat your Round 1 points. Focus on what's new from seeing others' perspectives.`;

const BLUESKY_ROUND1 = `This is a blue-sky thinking session. No constraints, no "but we can't because..." — just possibilities.

In under 200 words, propose 1-2 bold ideas:

1. **What if**: What capability would be game-changing for this system? Think 10x, not 10%.
2. **Wild connection**: What would happen if we combined two things that haven't been combined?
3. **Inspiration from elsewhere**: What do other systems (biological, social, industrial) do that we should steal?
4. **New agent idea**: If you could spin up a new sibling agent, what would it specialise in?

Be creative and specific. Bad ideas are welcome — they often lead to good ones.`;

const BLUESKY_ROUND2 = `Round 2: You've seen everyone's blue-sky ideas. Now build on them (under 200 words):

1. **Extend**: Pick someone else's idea and make it bigger/better
2. **Combine**: What happens if you merge two ideas from different agents?
3. **First step**: For the most exciting idea, what's the smallest experiment that would test it?

Don't critique — build. There are no bad ideas in this round.`;

const BLUESKY_ROUND3 = `Round 3: Final convergence. You've seen two rounds of ideas and reactions.

In under 100 words: What's the ONE idea from this session that you'd bet on? Why? What would it take to prototype it this week?`;

const PROMPTS: Record<MeetingType, string[]> = {
  standup: [STANDUP_ROUND1, STANDUP_ROUND2],
  bluesky: [BLUESKY_ROUND1, BLUESKY_ROUND2, BLUESKY_ROUND3],
};

const SYNTHESIS_PROMPTS: Record<MeetingType, string> = {
  standup: `You are synthesising a daily standup for an autonomous AI agent fleet.

Produce a JSON object (no markdown, no code fences):
{
  "themes": ["cross-cutting theme 1", "theme 2"],
  "action_items": [{"description": "specific action", "owner": "agent or pool", "priority": "high|medium|low"}],
  "goal_adjustments": ["adjustment if any"],
  "resource_notes": "rebalancing observations",
  "summary": "2-3 sentence executive summary"
}`,

  bluesky: `You are synthesising a blue-sky thinking session for an autonomous AI agent fleet.

The agents proposed bold ideas across multiple rounds, building on each other's thinking. Your job:
1. Identify the 3-5 most promising ideas (the ones with energy from multiple agents)
2. For each, describe what it would look like if implemented and what the first prototype step would be
3. Flag any ideas that could be started this week with minimal effort

Produce a JSON object (no markdown, no code fences):
{
  "themes": ["big idea 1", "big idea 2"],
  "action_items": [{"description": "prototype or investigation step", "owner": "agent or pool", "priority": "high|medium|low"}],
  "goal_adjustments": ["proposed new goal or adjustment"],
  "resource_notes": "which agents are best positioned for which ideas",
  "summary": "2-3 sentence summary of the most exciting outcomes"
}`,
};

// ── Core meeting logic ──────────────────────────────────────────────────────

function selectAgents(config: OrchestratorConfig): string[] {
  const seenPools = new Set<string>();
  const agents: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.docker?.port) continue;
    if (name.includes("telegram")) continue;
    const poolKey = agent.pool ?? name;
    if (seenPools.has(poolKey)) continue;
    seenPools.add(poolKey);
    agents.push(name);
  }
  return agents;
}

async function queryAgent(
  client: AgentClient,
  config: OrchestratorConfig,
  agentName: string,
  prompt: string,
  systemPrompt: string,
): Promise<RoundEntry> {
  const agent = config.agents[agentName];
  try {
    const response = await client.send(agentName, prompt, { systemPrompt });
    return {
      agentName,
      provider: agent?.provider ?? "claude",
      pool: agent?.pool,
      response: response.content,
      error: null,
    };
  } catch (err) {
    log.warn("Agent failed to respond in meeting", {
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

function formatPriorRounds(rounds: MeetingRound[]): string {
  if (rounds.length === 0) return "";

  return rounds.map((r) => {
    const entries = r.entries
      .filter((e) => e.response)
      .map((e) => `**${e.agentName}**: ${e.response}`)
      .join("\n\n");
    return `## Round ${r.roundNumber}\n${entries}`;
  }).join("\n\n---\n\n");
}

async function runRound(
  client: AgentClient,
  config: OrchestratorConfig,
  agents: string[],
  roundNumber: number,
  roundPrompt: string,
  priorRounds: MeetingRound[],
  goalsContext: string,
): Promise<MeetingRound> {
  const priorContext = formatPriorRounds(priorRounds);
  const fullPrompt = priorContext
    ? `${goalsContext}\n\n${priorContext}\n\n---\n\n${roundPrompt}`
    : `${goalsContext}\n\n${roundPrompt}`;

  const entries = await Promise.all(
    agents.map((name) => {
      const agent = config.agents[name];
      const systemPrompt = `You are ${name}. Domain: ${agent?.description ?? "unknown"}. Capabilities: ${agent?.capabilities?.join(", ") ?? "general"}.`;
      return queryAgent(client, config, name, fullPrompt, systemPrompt);
    }),
  );

  return { roundNumber, prompt: roundPrompt, entries };
}

async function synthesiseMeeting(
  config: OrchestratorConfig,
  meetingType: MeetingType,
  rounds: MeetingRound[],
  goalsContext: string,
): Promise<{ synthesis: string; actionItems: ActionItem[]; goalAdjustments: string[] }> {
  const { client, model } = createLLMClient(config, "supervisor");

  const fullTranscript = formatPriorRounds(rounds);
  const prompt = `${goalsContext}\n\n${fullTranscript}`;

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await client.messages.create({
        model: getLLMModel(config, "supervisor") ?? model,
        max_tokens: 4096,
        system: SYNTHESIS_PROMPTS[meetingType],
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
      synthesis: "Synthesis failed — see round transcripts for raw input.",
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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run a multi-round team meeting.
 *
 * @param options.type - "standup" (blockers/actions) or "bluesky" (creative ideation)
 * @param options.rounds - number of discussion rounds (default: per type)
 */
export async function runTeamMeeting(
  config: OrchestratorConfig,
  store: StateStore,
  options?: MeetingOptions,
): Promise<MeetingSummary> {
  const meetingType = options?.type ?? "standup";
  const roundPrompts = PROMPTS[meetingType];
  const numRounds = options?.rounds ?? roundPrompts.length;

  log.info("Starting team meeting", { type: meetingType, rounds: numRounds });

  const goals = loadGoals(config.orchestrator_dir);
  const progress = goals.goals.length > 0 ? measureGoalProgress(goals, store) : [];
  const goalsContext = buildGoalsContext(progress);

  const client = new AgentClient(config);
  const agents = selectAgents(config);

  log.info("Meeting participants", { agents, type: meetingType });

  // Run rounds sequentially (each round needs prior round context)
  const rounds: MeetingRound[] = [];
  for (let i = 0; i < numRounds; i++) {
    const prompt = roundPrompts[i] ?? roundPrompts[roundPrompts.length - 1];
    log.info(`Starting round ${i + 1}/${numRounds}`, { type: meetingType });

    const round = await runRound(client, config, agents, i + 1, prompt, rounds, goalsContext);
    rounds.push(round);

    const responded = round.entries.filter((e) => e.response).length;
    log.info(`Round ${i + 1} complete`, { responded, total: round.entries.length });
  }

  // Synthesise all rounds
  const { synthesis, actionItems, goalAdjustments } = await synthesiseMeeting(
    config, meetingType, rounds, goalsContext,
  );

  const summary: MeetingSummary = {
    date: new Date().toISOString().slice(0, 10),
    type: meetingType,
    rounds,
    synthesis,
    actionItems,
    goalAdjustments,
  };

  // Persist to SQLite for dashboard access
  try {
    store.saveMeeting({
      type: meetingType,
      date: summary.date,
      rounds: summary.rounds.map((r) => ({
        roundNumber: r.roundNumber,
        prompt: r.prompt,
        entries: r.entries,
      })),
      synthesis,
      actionItems,
      goalAdjustments,
    });
  } catch (err) {
    log.warn("Failed to save meeting to store", { error: err instanceof Error ? err.message : String(err) });
  }

  // File as GitHub issue
  fileMeetingIssue(config, summary);

  // Send full Telegram report
  await sendMeetingToTelegram(summary).catch((err) => {
    log.warn("Failed to send meeting report to Telegram", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  log.info("Team meeting complete", {
    type: meetingType,
    rounds: rounds.length,
    actionItems: actionItems.length,
  });

  return summary;
}

// ── GitHub issue filing ─────────────────────────────────────────────────────

function fileMeetingIssue(config: OrchestratorConfig, summary: MeetingSummary): void {
  try {
    const issueCreator = new IssueCreator(config);
    const typeLabel = summary.type === "bluesky" ? "🚀 Blue Sky" : "📋 Standup";

    const roundSections = summary.rounds.map((r) => {
      const entries = r.entries
        .filter((e) => e.response)
        .map((e) => `#### ${e.agentName}\n${e.response}`)
        .join("\n\n");
      return `### Round ${r.roundNumber}\n${entries}`;
    }).join("\n\n---\n\n");

    const actionSection = summary.actionItems.length > 0
      ? summary.actionItems.map((a) => `- [${a.priority.toUpperCase()}] ${a.description} (owner: ${a.owner})`).join("\n")
      : "No action items.";

    const goalSection = summary.goalAdjustments.length > 0
      ? summary.goalAdjustments.map((g) => `- ${g}`).join("\n")
      : "No adjustments proposed.";

    const body = `## ${typeLabel} — ${summary.date}

### Synthesis
${summary.synthesis}

### Action Items
${actionSection}

### Goal Adjustments
${goalSection}

${roundSections}

---
*Auto-generated ${summary.rounds.length}-round ${summary.type} meeting.*`;

    issueCreator.createIssue(
      "rapartlu/agent-orchestrator",
      `[${typeLabel}] ${summary.date} — ${summary.actionItems.length} action items`,
      body,
      ["team-meeting", summary.type],
    );
  } catch (err) {
    log.warn("Failed to file meeting issue", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

async function sendTelegramText(tgConfig: { botToken: string; chatId: string }, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${tgConfig.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: tgConfig.chatId, text, parse_mode: "Markdown" }),
  });
}

async function sendMeetingToTelegram(summary: MeetingSummary): Promise<void> {
  const tgConfig = loadTelegramConfig();
  if (!tgConfig) return;

  const typeEmoji = summary.type === "bluesky" ? "🚀" : "🤝";
  const typeLabel = summary.type === "bluesky" ? "Blue Sky Session" : "Team Standup";

  // Message 1: Header + synthesis + actions
  const actionLines = summary.actionItems.length > 0
    ? summary.actionItems.map((a) => `  [${a.priority.toUpperCase()}] ${a.description} → ${a.owner}`).join("\n")
    : "  None.";

  const goalLines = summary.goalAdjustments.length > 0
    ? summary.goalAdjustments.map((g) => `  • ${g}`).join("\n")
    : "  No changes.";

  const totalResponded = summary.rounds[0]?.entries.filter((e) => e.response).length ?? 0;
  const totalAgents = summary.rounds[0]?.entries.length ?? 0;

  const header = `${typeEmoji} *${typeLabel} — ${summary.date}*
${summary.rounds.length} rounds, ${totalResponded}/${totalAgents} agents

*Synthesis:*
${summary.synthesis}

*Action Items:*
${actionLines}

*Goal Adjustments:*
${goalLines}`;

  await sendTelegramText(tgConfig, header);

  // Messages 2+: Each round's perspectives
  for (const round of summary.rounds) {
    let batch = `*Round ${round.roundNumber}:*\n`;
    for (const entry of round.entries) {
      const text = entry.response
        ? `\n*${entry.agentName}*:\n${entry.response.slice(0, 500)}\n`
        : `\n*${entry.agentName}*: ❌ no response\n`;

      if (batch.length + text.length > 3800) {
        await sendTelegramText(tgConfig, batch);
        batch = "";
      }
      batch += text;
    }
    if (batch.trim()) {
      await sendTelegramText(tgConfig, batch);
    }
  }
}
