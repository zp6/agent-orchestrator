import { createLLMClient } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

export interface DetectedImprovement {
  title: string;
  description: string;
  affected_agents: string[];
  severity: "low" | "medium" | "high";
  evidence: Array<{ taskId: string; detail: string }>;
}

const SYSTEM_PROMPT = `You are an improvement analyst for a multi-agent orchestrator. Analyze recent task results and identify cross-cutting improvements that would benefit multiple agents.

Look for:
- Repeated failure patterns across agents
- Common quality issues (low verification scores)
- Missing capabilities that multiple agents need
- Process improvements (better error handling, documentation, testing)
- Agents consistently struggling with certain task types

Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "Short improvement title",
    "description": "Detailed description of the improvement and why it matters",
    "affected_agents": ["agent-name-1", "agent-name-2"],
    "severity": "low|medium|high"
  }
]

If no improvements are detected, return an empty array: []
Only suggest improvements that are actionable and specific. Do not suggest generic improvements.`;

export class ImprovementDetector {
  private log = createLogger("improvement-detector");

  constructor(private config: OrchestratorConfig) {}

  async analyze(recentTasks: Task[]): Promise<DetectedImprovement[]> {
    if (recentTasks.length === 0) return [];

    const client = createLLMClient(this.config
    );

    const taskSummaries = recentTasks.map((t) => ({
      id: t.id.slice(0, 8),
      agent: t.agent_name,
      title: t.title,
      status: t.status,
      source: t.source,
      quality_score: t.quality_score,
      verification: t.verification_status,
      result_preview: t.result?.slice(0, 200),
    }));

    const prompt = `Analyze these ${recentTasks.length} recent tasks and identify cross-cutting improvements:\n\n${JSON.stringify(taskSummaries, null, 2)}`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      return this.parseResponse(text, recentTasks);
    } catch {
      return [];
    }
  }

  private parseResponse(text: string, tasks: Task[]): DetectedImprovement[] {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      const agentNames = new Set(Object.keys(this.config.agents));

      return parsed
        .filter((item: Record<string, unknown>) =>
          item.title && item.description && Array.isArray(item.affected_agents),
        )
        .map((item: Record<string, unknown>) => ({
          title: String(item.title),
          description: String(item.description),
          affected_agents: (item.affected_agents as string[]).filter((a) => agentNames.has(a)),
          severity: (["low", "medium", "high"].includes(String(item.severity)) ? String(item.severity) : "medium") as "low" | "medium" | "high",
          evidence: tasks
            .filter((t) => (item.affected_agents as string[]).includes(t.agent_name ?? ""))
            .slice(0, 3)
            .map((t) => ({ taskId: t.id, detail: t.title })),
        }))
        .filter((imp) => imp.affected_agents.length > 0);
    } catch {
      return [];
    }
  }
}
