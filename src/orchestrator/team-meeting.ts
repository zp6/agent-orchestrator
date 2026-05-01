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
import { loadGoals, measureGoalProgress, buildGoalsContext, type GoalsConfig, findGoalsPath } from "./goals.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { cacheableSystemPrompt } from "../utils/prompt-cache.js";
import { execSync } from "node:child_process";
import { StandupActionClient, type StandupActionItemInput } from "../client/standup-action-client.js";
import { readFileSync, writeFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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
  /** Custom format overriding the built-in standup/bluesky types. */
  format?: import("./meeting-formats.js").MeetingFormat;
  /** Explicit participant list (overrides selectAgents). */
  participants?: string[];
  /** Topic/title prepended to the meeting agenda. */
  topic?: string;
}

// ── Prompts per meeting type ────────────────────────────────────────────────

const STANDUP_ROUND1 = `You are in a daily standup. Share your perspective concisely (under 200 words):

1. **Blockers**: What's preventing you from doing your best work?
2. **Opportunities**: What improvements could make the biggest impact in your domain?
3. **Suggestions for the team**: What should other agents know?
4. **Coverage gaps**: Are there tasks in your domain that a more specialised agent should handle?
5. **External engagement review** (if applicable): Any interactions with external OSS projects this cycle? Report:
   - Bug reports filed, PRs submitted/accepted/rejected on non-fleet repos
   - Maintainer reactions or invitations received
   - Proposed new external engagement and why it's valuable
   Note: Charter Article IV requires trust-commons discipline — bug reports before patches, max 1 PR per external project per quarter, earn standing one project at a time, radical transparency (agent identity disclosed).
6. **Meeting request** (optional): If there's a cross-cutting topic that needs structured discussion beyond this standup, you can request an ad-hoc meeting. Add a section like:
   **REQUEST MEETING:** <topic> [format: rfc|retrospective|design-review|triage|incident-postmortem|investigation-spike]
   The meeting facilitator will evaluate and schedule it. Only request one if the topic genuinely needs multi-agent structured discussion.

Be specific — reference actual issues, PRs, or patterns. ONLY reference issues and PRs listed in the Live Fleet State section above.`;

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

// ── Live issue/PR context for meetings ─────────────────────────────────────

/**
 * Build a context block with live issue and PR state across all repos so
 * agents don't reference stale/closed issues in their standup responses.
 * Fetches open issues and PRs per repo via `gh` CLI.
 */
function buildLiveIssueContext(config: OrchestratorConfig, store: StateStore): string {
  const sections: string[] = ["## Live Fleet State (auto-generated — do NOT reference issues/PRs not listed here)"];

  // Task stats
  const stats = store.getAgentStats(168); // 7 days
  const totalDone = stats.reduce((s, a) => s + a.done, 0);
  const totalFailed = stats.reduce((s, a) => s + a.failed, 0);
  const failRate = totalDone + totalFailed > 0
    ? ((totalFailed / (totalDone + totalFailed)) * 100).toFixed(1)
    : "0";
  sections.push(`\n### 7-Day Performance\n- Completed: ${totalDone}, Failed: ${totalFailed} (${failRate}% failure rate)`);

  // Per-repo: open issues and PRs
  const repos = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (agent.github) repos.add(agent.github);
  }

  const repoSections: string[] = [];
  for (const repo of repos) {
    try {
      const issuesRaw = execSync(
        `gh issue list --repo ${repo} --state open --json number,title,labels --limit 15`,
        { encoding: "utf-8", timeout: 15_000 },
      );
      const issues = JSON.parse(issuesRaw.trim() || "[]") as Array<{ number: number; title: string; labels: Array<{ name: string }> }>;

      const prsRaw = execSync(
        `gh pr list --repo ${repo} --state open --json number,title,mergeable --limit 10`,
        { encoding: "utf-8", timeout: 15_000 },
      );
      const prs = JSON.parse(prsRaw.trim() || "[]") as Array<{ number: number; title: string; mergeable: string }>;

      if (issues.length === 0 && prs.length === 0) continue;

      const lines: string[] = [`\n### ${repo}`];
      if (issues.length > 0) {
        lines.push(`**Open issues (${issues.length}):**`);
        for (const i of issues) {
          const labels = i.labels.map((l) => l.name).join(", ");
          lines.push(`- #${i.number}: ${i.title}${labels ? ` [${labels}]` : ""}`);
        }
      }
      if (prs.length > 0) {
        lines.push(`**Open PRs (${prs.length}):**`);
        for (const pr of prs) {
          lines.push(`- PR #${pr.number}: ${pr.title} (${pr.mergeable})`);
        }
      }
      repoSections.push(lines.join("\n"));
    } catch (err) {
      log.debug("Failed to fetch live state for repo", { repo, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (repoSections.length === 0) return "";
  sections.push(...repoSections);

  // Recent task failures for context
  try {
    const recentFails = store.listTasks({ status: "failed", limit: 5 });
    if (recentFails.length > 0) {
      sections.push("\n### Recent failures");
      for (const t of recentFails) {
        const result = t.result?.substring(0, 80) ?? "(no result)";
        sections.push(`- ${t.source_ref ?? t.title?.substring(0, 60)}: ${result}`);
      }
    }
  } catch { /* non-fatal */ }

  return sections.join("\n");
}

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
    client.emitMonologue(
      agentName,
      null,
      "plan",
      "I am joining the meeting round now and reviewing the shared context before I respond.",
    );
    const response = await client.send(agentName, prompt, { systemPrompt });
    client.emitMonologue(
      agentName,
      null,
      "reflection",
      "I have finished my meeting response and am handing it back to the facilitator.",
    );
    return {
      agentName,
      provider: agent?.provider ?? "claude",
      pool: agent?.pool,
      response: response.content,
      error: null,
    };
  } catch (err) {
    client.emitMonologue(
      agentName,
      null,
      "escalation",
      "The meeting response failed, so I am recording the blocker and moving on.",
    );
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

/** Number of LLM synthesis retry attempts after the initial attempt fails. */
const SYNTHESIS_MAX_RETRIES = 2;
/** Base delay in ms between synthesis retries (doubles on each attempt). */
const SYNTHESIS_RETRY_BASE_MS = 2_000;

/**
 * Wait helper for retry backoff.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // Attempt LLM synthesis up to (1 + SYNTHESIS_MAX_RETRIES) times with
  // exponential backoff. Each retry uses a fresh AbortController so the
  // prior timeout does not bleed into the next attempt.
  let lastError: unknown;
  for (let attempt = 0; attempt <= SYNTHESIS_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMs = SYNTHESIS_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log.warn("Meeting synthesis failed — retrying", {
        attempt,
        maxRetries: SYNTHESIS_MAX_RETRIES,
        retryAfterMs: waitMs,
        error: lastError instanceof Error ? lastError.message : String(lastError),
      });
      await delay(waitMs);
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);

    try {
      let response;
      try {
        response = await client.messages.create({
          model: getLLMModel(config, "supervisor") ?? model,
          max_tokens: 4096,
          system: cacheableSystemPrompt(SYNTHESIS_PROMPTS[meetingType]),
          messages: [{ role: "user", content: prompt }],
        }, { signal: abortController.signal });
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      const result = parseSynthesis(text);
      if (attempt > 0) {
        log.info("Meeting synthesis succeeded after retry", { attempt });
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  // All LLM attempts exhausted — fall back to transcript extraction so the
  // meeting still surfaces at least minimal action items derived from the
  // raw round responses (issue #1111).
  log.error("Meeting synthesis failed after all retries — using transcript fallback", {
    attempts: SYNTHESIS_MAX_RETRIES + 1,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  });

  const fallbackItems = extractFallbackActionItems(rounds);
  const fallbackNote = fallbackItems.length > 0
    ? `Synthesis failed after ${SYNTHESIS_MAX_RETRIES + 1} attempts. ${fallbackItems.length} action item(s) extracted from round transcripts.`
    : "Synthesis failed — see round transcripts for raw input.";

  return {
    synthesis: fallbackNote,
    actionItems: fallbackItems,
    goalAdjustments: [],
  };
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

// ── Transcript fallback action item extraction ────────────────────────────
//
// When LLM synthesis fails, heuristically parse round transcripts to extract
// at least some signal. This prevents standup issues from having zero action
// items when agents actually discussed concrete work (issue #1111).
//
// Strategy (in priority order):
//   1. Extract lines containing action verbs near GitHub issue/PR refs (#N)
//   2. Attribute each item to the agent who wrote it
//   3. Cap at FALLBACK_MAX_ITEMS to avoid flooding
//
// This is intentionally coarse — the goal is minimal viable signal, not
// perfect extraction. The full round transcripts are preserved in the DB.

/** Maximum action items produced by the transcript fallback. */
const FALLBACK_MAX_ITEMS = 5;

/** Action verbs that suggest something concrete was proposed. */
const ACTION_VERB_RE =
  /(?:^|[\s(])(?:merge|ship|implement|prioritize|prioritise|fix|close|review|wire|expand|add|create|dispatch|update|refactor)\b/i;

/** GitHub issue or PR reference. */
const ISSUE_REF_INLINE_RE = /#(\d+)/g;

/**
 * Extract a capped list of action items from round transcripts when LLM
 * synthesis is unavailable.
 *
 * Scans every line of every agent response for lines that contain both an
 * action verb and a GitHub issue/PR reference. Deduplicates by normalising
 * the line and capping per-agent contributions to 2 items so no single agent
 * dominates the output.
 */
export function extractFallbackActionItems(rounds: MeetingRound[]): ActionItem[] {
  const items: ActionItem[] = [];
  const seenDescriptions = new Set<string>();

  // Use the last round's responses first (most reactive, most concrete).
  const orderedRounds = [...rounds].sort((a, b) => b.roundNumber - a.roundNumber);

  for (const round of orderedRounds) {
    if (items.length >= FALLBACK_MAX_ITEMS) break;

    for (const entry of round.entries) {
      if (!entry.response || items.length >= FALLBACK_MAX_ITEMS) continue;

      let agentContributions = 0;
      const lines = entry.response.split("\n");

      for (const rawLine of lines) {
        if (items.length >= FALLBACK_MAX_ITEMS) break;
        if (agentContributions >= 2) break;

        // Normalise the line first: strip markdown and leading bullet markers
        // so that patterns like "**Merge PR #171**" are correctly matched by
        // ACTION_VERB_RE (which requires word-boundary context around the verb).
        const line = rawLine
          .trim()
          .replace(/^\s*[-*•]\s*/, "")
          .replace(/\*\*/g, "")
          .replace(/\*/g, "")
          .trim();
        if (!line || line.length < 15) continue;

        // Must contain an action verb
        if (!ACTION_VERB_RE.test(line)) continue;

        // Must reference at least one GitHub issue or PR
        ISSUE_REF_INLINE_RE.lastIndex = 0;
        const refs: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = ISSUE_REF_INLINE_RE.exec(line)) !== null) {
          refs.push(`#${m[1]}`);
        }
        if (refs.length === 0) continue;

        // Truncate to 120 chars
        const description = line.slice(0, 120).trim();

        if (seenDescriptions.has(description.toLowerCase())) continue;
        seenDescriptions.add(description.toLowerCase());

        items.push({
          description,
          owner: entry.agentName,
          priority: "medium",
        });
        agentContributions++;
      }
    }
  }

  return items;
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

  // Custom format overrides built-in prompts
  const customFormat = options?.format;
  const roundPrompts = customFormat
    ? customFormat.rounds.map((r) => r.prompt)
    : PROMPTS[meetingType];
  const numRounds = options?.rounds ?? roundPrompts.length;

  const formatLabel = customFormat ? customFormat.name : meetingType;
  log.info("Starting team meeting", { type: formatLabel, rounds: numRounds, topic: options?.topic });

  const goals = loadGoals(config.orchestrator_dir);
  const progress = goals.goals.length > 0 ? measureGoalProgress(goals, store) : [];
  let goalsContext = buildGoalsContext(progress);

  // Prepend topic to context if provided
  if (options?.topic) {
    goalsContext = `## Meeting Topic\n${options.topic}\n\n${goalsContext}`;
  }

  // Inject live issue/PR state so agents reference real, current data
  const liveContext = buildLiveIssueContext(config, store);
  if (liveContext) {
    goalsContext += `\n\n${liveContext}`;
  }

  const client = new AgentClient(config, store);
  // Use explicit participants if provided, otherwise auto-select
  const agents = options?.participants ?? selectAgents(config);

  log.info("Meeting participants", { agents, type: formatLabel });

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

  // Check if any agent actually responded — if not, this meeting is a wash
  // (e.g. all agents returned connection errors during a Docker outage).
  // Don't save it or file it, so the time-based scheduler retries next cycle.
  const totalResponses = rounds.reduce(
    (sum, r) => sum + r.entries.filter((e) => e.response).length, 0,
  );
  if (totalResponses === 0) {
    log.warn("Meeting abandoned: zero responses from all agents", { type: meetingType, rounds: rounds.length });
    return {
      date: new Date().toISOString().slice(0, 10),
      type: meetingType,
      rounds,
      synthesis: "Meeting abandoned — no agents responded (likely infrastructure outage).",
      actionItems: [],
      goalAdjustments: [],
    };
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

  // Extract meeting requests from agent responses and write as signals
  extractMeetingRequests(store, rounds);

  // Extract structured priority outcomes (issue rankings, sequencing constraints)
  // and write them as signals for the supervisor to consume next cycle.
  extractPriorityOutcomes(store, summary, options?.topic);

  // File high-priority action items as GitHub issues so they enter the dispatch pipeline
  fileActionItemsAsIssues(config, summary);

  // Apply goal adjustments from the meeting synthesis to goals.yaml
  if (goalAdjustments.length > 0) {
    applyGoalAdjustments(goalAdjustments, config.orchestrator_dir);
  }

  // Record action-item dispositions to the dashboard (issue #798).
  // Fire-and-forget: dashboard outages must not block standup processing.
  void flushStandupDispositions(config, summary);

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

// ── Dashboard standup action disposition flush (issue #798) ───────────────

/**
 * POST the disposition of every action item from a standup summary to the
 * agent-dashboard `/api/standup-items/batch` endpoint.
 *
 * Currently the orchestrator does not auto-dispatch standup action items as
 * tasks, so every item is recorded as "deferred" with a reason that explains
 * it is logged for operator review.  This establishes the plumbing so future
 * work can upgrade individual dispositions to "dispatched" once auto-dispatch
 * is implemented.
 *
 * The call is fire-and-forget — any error is logged at warn level and does
 * not interrupt standup processing.
 */
async function flushStandupDispositions(
  config: OrchestratorConfig,
  summary: MeetingSummary,
): Promise<void> {
  const dashboardUrl = config.dashboard?.url;
  if (!dashboardUrl || summary.actionItems.length === 0) return;

  const client = new StandupActionClient(dashboardUrl);

  const records: StandupActionItemInput[] = summary.actionItems.map((item) => ({
    standup_date: summary.date,
    action_item: item.description,
    // Action items are not currently auto-dispatched from standup synthesis.
    // Record them as "deferred" so operators see them in the dashboard view.
    status: "deferred",
    reason: `Logged from ${summary.type} synthesis — pending manual review or auto-dispatch`,
    agent_name: item.owner,
  }));

  try {
    const ids = await client.recordBatch(records);
    if (ids !== null) {
      log.info("Flushed standup action dispositions to dashboard", {
        count: ids.length,
        meeting_date: summary.date,
        type: summary.type,
      });
    }
  } catch (err) {
    // Should never reach here — StandupActionClient swallows errors — but
    // belt-and-suspenders: standup must not fail due to dashboard issues.
    log.warn("Failed to flush standup dispositions to dashboard", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Meeting priority outcome extraction ──────────────────────────────────────

/**
 * Structured priority outcome extracted from a meeting synthesis.
 * Written as a `meeting_priority_outcome` stigmergy signal so the supervisor
 * can consume it during the next dispatch cycle.
 */
export interface MeetingPriorityOutcome {
  /** Ordered list of issue refs from highest to lowest priority (e.g. ["agent-orchestrator#1113", "agent-reviewer#391"]). */
  priorityRanking: string[];
  /** Human-readable sequencing constraints (e.g. "#1113 must precede #391"). */
  sequencingConstraints: string[];
  /** Whether the meeting concluded that a follow-up coordination meeting is needed before implementation. */
  followUpMeetingRecommended: boolean;
  /** Free-form rationale extracted from synthesis. */
  rationale: string;
  /** ISO timestamp of the meeting that produced this outcome. */
  meetingDate: string;
  /** Topic string if the meeting had an explicit topic. */
  topic?: string;
}

// Regex patterns for extracting priority outcomes from synthesis text
const PRIORITY_RANK_RE = /(?:priority|ranked?|order)[^\n]*?(?:#(\d+)[^\n#]*?){2,}/gi;
const ISSUE_REF_RE = /(?:(?:[\w-]+)#(\d+)|#(\d+))/g;
const SEQUENCING_RE = /(?:must|should|needs?\s+to)\s+(?:precede|come\s+before|be\s+done\s+(?:before|first))[^\n.]+/gi;
const FOLLOWUP_RE = /(?:follow[-\s]?up\s+(?:meeting|coordination|session)|coordination\s+meeting)[^\n.]*(?:recommended|needed|required|before\s+implementation)/gi;

/**
 * Parse priority ranking from synthesis text.
 * Looks for ordered issue references in "priority" or "ranking" contexts.
 * Returns refs in the format "repo#N" or "#N" as found in text.
 */
function parsePriorityRanking(synthesis: string): string[] {
  // Look for numbered list patterns indicating priority order (1. #N, 2. #N ...)
  const numberedRefs: Array<{ rank: number; ref: string }> = [];
  const numberedListRE = /^\s*(\d+)[.)]\s+(?:.*?)((?:[\w/-]+)?#(\d+))/gm;
  let m: RegExpExecArray | null;
  while ((m = numberedListRE.exec(synthesis)) !== null) {
    numberedRefs.push({ rank: parseInt(m[1], 10), ref: m[2] });
  }
  if (numberedRefs.length >= 2) {
    return numberedRefs
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.ref);
  }

  // Fallback: look for issue refs near the word "priority" or "highest"
  const prioritySection = synthesis.match(
    /(?:highest\s+priority|priority\s+order|implementation\s+order)[^\n]{0,300}/i,
  );
  if (prioritySection) {
    const refs: string[] = [];
    ISSUE_REF_RE.lastIndex = 0;
    while ((m = ISSUE_REF_RE.exec(prioritySection[0])) !== null) {
      refs.push(m[0]);
    }
    if (refs.length > 0) return refs;
  }

  return [];
}

/**
 * Scan meeting synthesis for structured priority outcomes and write them
 * as `meeting_priority_outcome` signals for the supervisor to consume.
 *
 * The function is intentionally lenient — partial extraction is better than
 * none.  A signal is only written if at least one issue ref is found.
 */
export function extractPriorityOutcomes(
  store: StateStore,
  summary: MeetingSummary,
  topic?: string,
): void {
  const { synthesis, date } = summary;

  const priorityRanking = parsePriorityRanking(synthesis);

  // Sequencing constraints: "X must precede Y", "X must be done before Y"
  const sequencingConstraints: string[] = [];
  SEQUENCING_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = SEQUENCING_RE.exec(synthesis)) !== null) {
    sequencingConstraints.push(sm[0].trim());
  }

  // Follow-up recommendation: explicit mention of follow-up meeting needed
  FOLLOWUP_RE.lastIndex = 0;
  const followUpMeetingRecommended = FOLLOWUP_RE.test(synthesis);

  // Only write a signal if we found at least one issue ref (otherwise it's noise)
  if (priorityRanking.length === 0 && sequencingConstraints.length === 0) {
    log.debug("No priority outcomes found in meeting synthesis — skipping signal", { date, topic });
    return;
  }

  const outcome: MeetingPriorityOutcome = {
    priorityRanking,
    sequencingConstraints,
    followUpMeetingRecommended,
    rationale: synthesis.slice(0, 600),
    meetingDate: date,
    ...(topic ? { topic } : {}),
  };

  const key = `meeting-priority-outcome-${date}-${Date.now()}`;
  try {
    store.writeSignal({
      agent: "claude-agent-orchestrator",
      signal_type: "meeting_priority_outcome",
      key,
      value: outcome,
      confidence: 0.85,
      ttl_hours: 336, // 14 days — priority outcomes stay relevant longer
    });
    log.info("Meeting priority outcome extracted and written as signal", {
      date,
      topic,
      priorityRanking,
      sequencingConstraints: sequencingConstraints.length,
      followUpMeetingRecommended,
    });
  } catch (err) {
    log.warn("Failed to write meeting priority outcome signal", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Meeting request extraction ────────────────────────────────────────────

const MEETING_REQUEST_RE = /\*\*REQUEST MEETING:\*\*\s*(.+?)(?:\[format:\s*([\w-]+)\])?$/gmi;

/**
 * Scan agent responses for "REQUEST MEETING: <topic>" blocks and write
 * them as meeting_request signals for the facilitator to evaluate.
 */
function extractMeetingRequests(store: StateStore, rounds: MeetingRound[]): void {
  for (const round of rounds) {
    for (const entry of round.entries) {
      if (!entry.response) continue;

      // Reset regex state
      MEETING_REQUEST_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MEETING_REQUEST_RE.exec(entry.response)) !== null) {
        const topic = match[1].trim();
        const format = match[2]?.trim() ?? undefined;
        if (!topic) continue;

        const key = `meeting-request-${Date.now()}-${entry.agentName}`;
        try {
          store.writeSignal({
            agent: entry.agentName,
            signal_type: "meeting_request",
            key,
            value: {
              topic,
              suggestedFormat: format,
              suggestedParticipants: [],
              urgency: "normal",
              context: `Requested by ${entry.agentName} during standup round ${round.roundNumber}`,
            },
            confidence: 0.8,
            ttl_hours: 168,
          });
          log.info("Meeting request extracted from standup", {
            agent: entry.agentName,
            topic,
            format,
          });
        } catch (err) {
          log.warn("Failed to write meeting request signal", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

// ── GitHub issue filing ─────────────────────────────────────────────────────

// ── Action item → GitHub issue pipeline ───────────────────────────────────

/**
 * File high-priority action items from meeting synthesis as GitHub issues
 * so they enter the normal dispatch pipeline. Only files items with
 * priority "high" to avoid flooding repos with low-priority chores.
 *
 * Targets the repo based on the action item's owner field — maps agent
 * pool names to their GitHub repos. Falls back to agent-orchestrator.
 */
function fileActionItemsAsIssues(config: OrchestratorConfig, summary: MeetingSummary): void {
  const highPriority = summary.actionItems.filter((item) => item.priority === "high");
  if (highPriority.length === 0) return;

  const issueCreator = new IssueCreator(config);
  let filed = 0;

  for (const item of highPriority) {
    const repo = resolveRepoForOwner(config, item.owner);
    const title = `[${summary.type}] ${item.description.slice(0, 100)}`;
    const body = `## Action Item (from ${summary.type} meeting ${summary.date})\n\n` +
      `**Priority:** ${item.priority}\n` +
      `**Owner:** ${item.owner}\n\n` +
      `${item.description}\n\n` +
      `---\n*Auto-filed from ${summary.type} meeting synthesis.*`;

    try {
      issueCreator.createIssue(repo, title, body, ["meeting-action", summary.type]);
      filed++;
    } catch (err) {
      log.warn("Failed to file action item as issue", {
        description: item.description.slice(0, 80),
        repo,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (filed > 0) {
    log.info("Filed meeting action items as GitHub issues", { filed, total: highPriority.length, type: summary.type });
  }
}

/**
 * Map an action item owner (agent name or pool name) to a GitHub repo.
 * Falls back to agent-orchestrator for unknown owners.
 */
function resolveRepoForOwner(config: OrchestratorConfig, owner: string): string {
  const ownerLower = owner.toLowerCase();

  // Direct agent name match
  const agent = config.agents[owner] ?? config.agents[ownerLower];
  if (agent?.github) return agent.github;

  // Pool name match — find the first agent in that pool
  for (const a of Object.values(config.agents)) {
    if (a.pool === ownerLower && a.github) return a.github;
  }

  // Keyword match
  if (ownerLower.includes("dashboard")) return "rapartlu/agent-dashboard";
  if (ownerLower.includes("reviewer")) return "rapartlu/agent-reviewer";
  if (ownerLower.includes("research")) return "rapartlu/research-agent";
  if (ownerLower.includes("proxy")) return "rapartlu/agent-proxy";
  if (ownerLower.includes("facilitator")) return "rapartlu/meeting-facilitator-agent";

  return "rapartlu/agent-orchestrator";
}

// ── Goal adjustment application ───────────────────────────────────────────

/**
 * Apply goal adjustments proposed by meeting synthesis to goals.yaml.
 * Appends adjustments as new key results to the most relevant goal,
 * or adds a note to the goals file if no matching goal is found.
 */
function applyGoalAdjustments(adjustments: string[], orchestratorDir?: string): void {
  try {
    const goalsPath = findGoalsPath(orchestratorDir);
    if (!goalsPath) {
      log.warn("Cannot apply goal adjustments — goals.yaml not found");
      return;
    }

    const raw = readFileSync(goalsPath, "utf-8");
    const goals = parseYaml(raw) as GoalsConfig;
    if (!goals?.goals?.length) return;

    let applied = 0;
    for (const adj of adjustments) {
      const adjLower = adj.toLowerCase();

      // Find the best matching goal by keyword overlap
      let bestGoal = goals.goals[0];
      let bestScore = 0;
      for (const goal of goals.goals) {
        const goalWords = `${goal.id} ${goal.title} ${goal.target}`.toLowerCase().split(/\s+/);
        const adjWords = adjLower.split(/\s+/);
        const overlap = adjWords.filter((w) => w.length > 4 && goalWords.some((gw) => gw.includes(w))).length;
        if (overlap > bestScore) {
          bestScore = overlap;
          bestGoal = goal;
        }
      }

      // Add as a new key result
      bestGoal.key_results.push({
        description: adj,
      });
      applied++;
    }

    if (applied > 0) {
      writeFileSync(goalsPath, stringifyYaml(goals, { lineWidth: 120 }));
      log.info("Applied goal adjustments from meeting", { applied, path: goalsPath });
    }
  } catch (err) {
    log.warn("Failed to apply goal adjustments", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
