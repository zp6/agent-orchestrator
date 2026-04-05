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

    const llmResult = await this.llmRouter.route(task);
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
    // Exact repo match — highest confidence
    if (sourceRepo && agent.github === sourceRepo) {
      return { confidence: 1.0, reason: `Owns repo ${sourceRepo}` };
    }

    const taskLower = task.toLowerCase();
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
