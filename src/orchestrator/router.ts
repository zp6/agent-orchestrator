import type { OrchestratorConfig, AgentConfig } from "../config/schema.js";
import type { LLMRouter } from "./llm-router.js";

export const LLM_FALLBACK_THRESHOLD = 0.3;

export interface AgentMatch {
  agentName: string;
  confidence: number;
  reason: string;
}

export class Router {
  private llmRouter?: LLMRouter;

  constructor(
    private config: OrchestratorConfig,
    llmRouter?: LLMRouter,
  ) {
    this.llmRouter = llmRouter;
  }

  route(task: string, sourceRepo?: string): AgentMatch[] {
    const matches: AgentMatch[] = [];

    for (const [name, agent] of Object.entries(this.config.agents)) {
      const score = this.score(task, name, agent, sourceRepo);
      if (score.confidence > 0) {
        matches.push({ agentName: name, ...score });
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  routeToRepo(repo: string): string | undefined {
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (agent.github === repo) {
        return name;
      }
    }
    return undefined;
  }

  async routeWithFallback(task: string, sourceRepo?: string): Promise<AgentMatch[]> {
    const matches = this.route(task, sourceRepo);

    // If deterministic routing is confident enough, use it
    if (matches.length > 0 && matches[0].confidence >= LLM_FALLBACK_THRESHOLD) {
      return matches;
    }

    // Fall back to LLM routing
    if (!this.llmRouter) {
      return matches;
    }

    const llmResult = await this.llmRouter.route(task, sourceRepo);
    if (!llmResult) {
      return matches;
    }

    // Merge LLM result with deterministic matches
    const llmMatch: AgentMatch = {
      agentName: llmResult.agentName,
      confidence: llmResult.confidence,
      reason: `LLM: ${llmResult.reason}`,
    };

    // Replace or insert the LLM match
    const existing = matches.findIndex((m) => m.agentName === llmMatch.agentName);
    if (existing >= 0 && matches[existing].confidence < llmMatch.confidence) {
      matches[existing] = llmMatch;
    } else if (existing < 0) {
      matches.push(llmMatch);
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  private score(
    task: string,
    agentName: string,
    agent: AgentConfig,
    sourceRepo?: string,
  ): { confidence: number; reason: string } {
    const taskLower = task.toLowerCase();

    // Cross-repo destination detection: if the task explicitly mentions another
    // agent's repo or name, prefer that destination agent over the source agent.
    // This handles cases like: issue from claude-proxy saying "update
    // claude-agent-orchestrator to consume X".
    const destinationBoost = this.scoreCrossRepoDestination(
      taskLower,
      agentName,
      agent,
      sourceRepo,
    );
    if (destinationBoost > 0) {
      return {
        confidence: destinationBoost,
        reason: `Cross-repo destination: task targets this agent's repo/name`,
      };
    }

    // Exact repo match — high confidence for the source repo agent, BUT only
    // when the task does NOT explicitly target a different agent's repo.
    // If the task explicitly names another agent, suppress the source-repo
    // default so the destination agent can win.
    if (sourceRepo && agent.github === sourceRepo) {
      const taskTargetsDifferentAgent = this.taskMentionsOtherAgent(
        taskLower,
        agentName,
        sourceRepo,
      );
      if (taskTargetsDifferentAgent) {
        // Return a low-ish score so the destination agent (0.9) beats us,
        // but keep some signal that this agent is involved in the issue.
        return { confidence: 0.4, reason: `Source repo (${sourceRepo}), but task targets another agent` };
      }
      return { confidence: 1.0, reason: `Owns repo ${sourceRepo}` };
    }

    let confidence = 0;
    const reasons: string[] = [];

    // Agent name mentioned directly
    if (taskLower.includes(agentName.toLowerCase())) {
      confidence += 0.8;
      reasons.push(`Agent name "${agentName}" mentioned in task`);
    }

    // Topic keyword matching
    const topicHits = agent.owns_topics.filter((t) =>
      taskLower.includes(t.toLowerCase()),
    );
    if (topicHits.length > 0) {
      confidence += 0.3 * Math.min(topicHits.length, 3);
      reasons.push(`Topic match: ${topicHits.join(", ")}`);
    }

    // Capability matching
    const capHits = agent.capabilities.filter((c) =>
      taskLower.includes(c.toLowerCase()),
    );
    if (capHits.length > 0) {
      confidence += 0.15 * Math.min(capHits.length, 3);
      reasons.push(`Capability match: ${capHits.join(", ")}`);
    }

    // Integration phrasing: prefer destination agent over source agent.
    // Patterns: "wire X into Y", "integrate X into/with Y", "plug X into Y",
    //           "add X to Y", "consume X in Y", "use X in Y" (when X/Y are distinct system names)
    const integrationBoost = this.scoreIntegrationDestination(taskLower, agentName, agent);
    if (integrationBoost > 0) {
      confidence += integrationBoost;
      reasons.push(`Integration destination match (+${integrationBoost})`);
    }

    // Cap at 1.0
    confidence = Math.min(confidence, 1.0);

    return {
      confidence,
      reason: reasons.join("; ") || "No match",
    };
  }

  /**
   * Detects explicit cross-repo destination mentions in the task text.
   *
   * When a task is triggered from repo A but explicitly names repo B (or its
   * agent name) in the title/description as the target, this returns a high
   * confidence score for the agent that owns repo B.
   *
   * Examples:
   *   - "update claude-agent-orchestrator to consume the new reviewer API"
   *     → boosts claude-agent-orchestrator, not claude-proxy (the source repo)
   *   - "rapartlu/claude-agent-orchestrator should handle X"
   *     → boosts claude-agent-orchestrator
   *
   * Returns 0.9 if this agent is the explicit destination (to beat the source
   * repo's default 1.0 only when the mention is strong), 0 otherwise.
   *
   * Note: only applies when a sourceRepo is provided AND the task mentions a
   * DIFFERENT agent's identity than the source.
   */
  private scoreCrossRepoDestination(
    taskLower: string,
    agentName: string,
    agent: AgentConfig,
    sourceRepo?: string,
  ): number {
    // Only applies when there is a source repo context
    if (!sourceRepo) return 0;

    // If this agent IS the source repo owner, skip (handled by the default path)
    if (agent.github === sourceRepo) return 0;

    // Check if the task explicitly mentions this agent's GitHub repo (full or short form)
    if (agent.github) {
      const fullRepo = agent.github.toLowerCase(); // e.g. "rapartlu/claude-agent-orchestrator"
      const shortRepo = fullRepo.split("/")[1]; // e.g. "claude-agent-orchestrator"

      if (taskLower.includes(fullRepo) || taskLower.includes(shortRepo)) {
        return 0.9;
      }
    }

    // Check if the task explicitly mentions this agent's name
    if (taskLower.includes(agentName.toLowerCase())) {
      return 0.9;
    }

    return 0;
  }

  /**
   * Returns true if the task text explicitly names a different agent's repo or
   * agent name (not the current source agent). Used to suppress the default
   * source-repo confidence boost when the task clearly targets a different agent.
   */
  private taskMentionsOtherAgent(
    taskLower: string,
    sourceAgentName: string,
    sourceRepo: string,
  ): boolean {
    for (const [name, agent] of Object.entries(this.config.agents)) {
      // Skip the source agent itself
      if (name === sourceAgentName || agent.github === sourceRepo) continue;

      if (agent.github) {
        const fullRepo = agent.github.toLowerCase();
        const shortRepo = fullRepo.split("/")[1];
        if (taskLower.includes(fullRepo) || taskLower.includes(shortRepo)) {
          return true;
        }
      }

      if (taskLower.includes(name.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Detects integration-phrasing patterns (e.g. "wire X into Y", "integrate X with Y")
   * and returns +0.3 if this agent owns the DESTINATION system (Y).
   *
   * The destination is the system being modified to consume the source (X).
   * Routing to the destination agent is correct because that's the repo getting changed.
   */
  private scoreIntegrationDestination(
    taskLower: string,
    agentName: string,
    agent: AgentConfig,
  ): number {
    // Each pattern captures the destination portion after the preposition
    const integrationPatterns: RegExp[] = [
      /\bwire\b.+?\binto\b\s+(.+)/,
      /\bintegrate\b.+?\binto\b\s+(.+)/,
      /\bintegrate\b.+?\bwith\b\s+(.+)/,
      /\bplug\b.+?\binto\b\s+(.+)/,
      /\bconsume\b.+?\bin(?:to)?\b\s+(.+)/,
      /\badd\b.+?\bpackage\b.+?\bto\b\s+(.+)/,
    ];

    for (const pattern of integrationPatterns) {
      const match = taskLower.match(pattern);
      if (!match) continue;

      const destination = match[1];

      // Agent name appears in destination portion
      if (destination.includes(agentName.toLowerCase())) {
        return 0.3;
      }

      // One of this agent's owned topics appears in destination portion
      const topicInDestination = agent.owns_topics.some((t) =>
        destination.includes(t.toLowerCase()),
      );
      if (topicInDestination) {
        return 0.3;
      }
    }

    return 0;
  }
}
