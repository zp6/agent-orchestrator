/**
 * Strategic roadmap proposer — generates blue-sky feature proposals
 * based on system-wide patterns, not just recent task results.
 *
 * Runs daily. Produces high-level proposals tagged with estimated
 * impact and effort for the operator to evaluate, prioritize, or drop.
 */
import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { IssueCreator } from "./issue-creator.js";
import { loadGoals, measureGoalProgress, buildGoalsContext } from "./goals.js";
import { createLogger } from "../service/logger.js";
import { extractJSON } from "../utils/json-extract.js";

const log = createLogger("roadmap-proposer");

const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export interface RoadmapProposal {
  title: string;
  description: string;
  impact: "transformative" | "high" | "medium";
  effort: "small" | "medium" | "large";
  category: "capability" | "intelligence" | "efficiency" | "resilience" | "ux";
  affected_repos: string[];
}

const ROADMAP_SYSTEM_PROMPT = `You are a strategic product thinker for an autonomous AI agent fleet. The fleet consists of coding agents (Claude + Codex) managed by an orchestrator that dispatches work from GitHub issues, reviews PRs, verifies quality, and self-improves.

Your job: propose TRANSFORMATIVE features — not bug fixes, not incremental improvements, but game-changing capabilities that would fundamentally level-up what this system can do.

Think like a CTO planning the next quarter. What would make this system 10x more capable, not 10% better?

Categories:
- **capability**: entirely new things the system can do that it can't today
- **intelligence**: making the system smarter about decisions, learning, or adaptation
- **efficiency**: dramatic cost/speed improvements (not minor optimizations)
- **resilience**: self-healing, fault tolerance, graceful degradation at a systemic level
- **ux**: transforming how operators interact with and oversee the fleet

Rules:
- Each proposal must be specific enough to implement (not "make it better")
- Include clear success criteria
- Be bold — propose things that seem ambitious but are technically feasible
- Don't repeat features that already exist (you'll see current capabilities in the context)
- Every proposal should pass the "would I be excited to demo this?" test

Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "Short compelling title",
    "description": "What it does, why it matters, specific success criteria. 2-3 sentences max.",
    "impact": "transformative|high|medium",
    "effort": "small|medium|large",
    "category": "capability|intelligence|efficiency|resilience|ux",
    "affected_repos": ["rapartlu/agent-orchestrator"]
  }
]

Propose 3-5 ideas. Quality over quantity.`;

function buildSystemContext(config: OrchestratorConfig, store: StateStore): string {
  const agents = Object.entries(config.agents).map(([name, a]) => ({
    name,
    provider: a.provider ?? "claude",
    pool: a.pool,
    capabilities: a.capabilities,
  }));

  const stats = store.getAgentStats(168); // 7 days
  const totalDone = stats.reduce((sum, s) => sum + s.done, 0);
  const totalFailed = stats.reduce((sum, s) => sum + s.failed, 0);

  const goals = loadGoals(config.orchestrator_dir);
  const goalsContext = goals.goals.length > 0
    ? buildGoalsContext(measureGoalProgress(goals, store))
    : "";

  return `## Current Fleet
${agents.map((a) => `- ${a.name} (${a.provider}, pool: ${a.pool ?? "none"})`).join("\n")}

## 7-Day Performance
- Tasks completed: ${totalDone}, failed: ${totalFailed}
- Success rate: ${totalDone + totalFailed > 0 ? Math.round((totalDone / (totalDone + totalFailed)) * 100) : 0}%

## Current Capabilities
- Multi-provider pools (Claude + Codex round-robin with rate limit failover)
- Smart model routing (haiku/sonnet/opus by task complexity)
- Priority scoring for dispatch ordering (labels, age, stuck status)
- Verification calibration tracking score accuracy against outcomes
- Post-merge staging validation with auto-revert
- Proactive issue discovery (CI failures, stale branches)
- Daily standup + weekly blue sky meetings (multi-round)
- Cross-task learning from PR review feedback
- Monthly goals with progress tracking
- Issue age monitoring (14d nudge, 30d force-boost)
- Follow-up chain depth limiter

${goalsContext}`;
}

export async function proposeRoadmapItems(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<RoadmapProposal[]> {
  const { client, model } = createLLMClient(config, "supervisor");
  const context = buildSystemContext(config, store);

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), DEFAULT_LLM_TIMEOUT_MS);

  try {
    let response;
    try {
      response = await client.messages.create({
        model: getLLMModel(config, "supervisor") ?? model,
        max_tokens: 4096,
        system: ROADMAP_SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
      }, { signal: abortController.signal });
    } finally {
      clearTimeout(timer);
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => "text" in b ? b.text : "")
      .join("");

    const parsed = extractJSON<RoadmapProposal[]>(text);
    return Array.isArray(parsed) ? parsed.filter((p) => p.title && p.description) : [];
  } catch (err) {
    log.error("Roadmap proposal generation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function proposeAndFileRoadmapItems(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<number> {
  const proposals = await proposeRoadmapItems(config, store);
  if (proposals.length === 0) return 0;

  const issueCreator = new IssueCreator(config);
  let filed = 0;

  for (const proposal of proposals) {
    const repo = proposal.affected_repos?.[0] ?? "rapartlu/agent-orchestrator";
    const body = `## Roadmap Proposal (auto-generated)

**Impact:** ${proposal.impact} | **Effort:** ${proposal.effort} | **Category:** ${proposal.category}

${proposal.description}

---
*Generated by the strategic roadmap proposer.*`;

    try {
      issueCreator.createIssue(repo, `[Proposal] ${proposal.title}`, body, ["roadmap-proposal", proposal.category]);
      filed++;
      log.info("Filed roadmap proposal", { title: proposal.title, repo });
    } catch (err) {
      log.warn("Failed to file roadmap proposal", {
        title: proposal.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return filed;
}
