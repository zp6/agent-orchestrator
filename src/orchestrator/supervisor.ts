import { createLLMClient } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

export interface SupervisorDecision {
  action: "dispatch" | "verify" | "redeploy" | "create-issue" | "follow-up" | "none";
  agentName?: string;
  message?: string;
  reason: string;
}

const SYSTEM_PROMPT = `You are the orchestrator supervisor — the strategic brain of a multi-agent system. You review the current state of all agents and tasks, and decide what needs attention.

You have these capabilities:
- dispatch: send work to an agent
- verify: check quality of completed work
- redeploy: rebuild an agent's container with latest code
- create-issue: create a GitHub issue on an agent's repo
- follow-up: send a follow-up message to an agent about a previous task
- none: everything looks good, no action needed

Respond with ONLY a JSON array of decisions (no markdown, no code fences):
[
  {
    "action": "follow-up",
    "agentName": "cheese-hater",
    "message": "Your previous task on issue #2 is done but the branch wasn't pushed. Please push branch issue-2-expand-claude-md to origin.",
    "reason": "Branch created but not pushed to remote"
  }
]

Be specific and actionable. Only suggest actions that address real gaps. Return [] if everything is on track.`;

export class Supervisor {
  private log = createLogger("supervisor");

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
  ) {}

  async review(): Promise<SupervisorDecision[]> {
    const context = this.buildContext();

    const client = createLLMClient(this.config
    );

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      const decisions = this.parseDecisions(text);
      this.log.info("Supervisor review complete", { decisions: decisions.length, actions: decisions.map((d) => d.action) });
      return decisions;
    } catch (err) {
      this.log.error("Supervisor review failed", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  private buildContext(): string {
    const sections: string[] = [];

    // Agent registry
    const agents = Object.entries(this.config.agents)
      .map(([name, a]) => `- ${name}: ${a.description}${a.github ? ` (${a.github})` : ""}`)
      .join("\n");
    sections.push(`## Agents\n${agents}`);

    // Recent tasks
    const recent = this.store.getRecentCompleted(10);
    if (recent.length > 0) {
      const taskLines = recent.map((t) => this.formatTask(t)).join("\n");
      sections.push(`## Recent Completed Tasks\n${taskLines}`);
    }

    // Unverified tasks
    const unverified = this.store.getUnverified(10);
    if (unverified.length > 0) {
      const lines = unverified.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}`).join("\n");
      sections.push(`## Unverified Tasks (${unverified.length})\n${lines}`);
    }

    // Failed tasks
    const failed = this.store.listTasks({ status: "failed", limit: 5 });
    if (failed.length > 0) {
      const lines = failed.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}\n  Error: ${t.result?.slice(0, 100)}`).join("\n");
      sections.push(`## Recent Failures\n${lines}`);
    }

    // Agent stats
    const stats = this.store.getAgentStats();
    if (stats.length > 0) {
      const lines = stats.map((s) => {
        const rate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
        return `- ${s.agent_name}: ${s.done}/${s.total} done (${rate}%), ${s.failed} failed`;
      }).join("\n");
      sections.push(`## Agent Performance\n${lines}`);
    }

    return sections.join("\n\n");
  }

  private formatTask(t: Task): string {
    const verified = t.verification_status ? ` [${t.verification_status}${t.quality_score ? ` ${t.quality_score.toFixed(1)}` : ""}]` : " [unverified]";
    const result = t.result ? `\n  Result: ${t.result.slice(0, 150)}` : "";
    return `- ${t.id.slice(0, 8)} (${t.agent_name}) ${t.status}${verified}: ${t.title}${result}`;
  }

  private parseDecisions(text: string): SupervisorDecision[] {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((d: Record<string, unknown>) => d.action && d.reason)
        .map((d: Record<string, unknown>) => ({
          action: String(d.action) as SupervisorDecision["action"],
          agentName: d.agentName ? String(d.agentName) : undefined,
          message: d.message ? String(d.message) : undefined,
          reason: String(d.reason),
        }));
    } catch {
      return [];
    }
  }
}
