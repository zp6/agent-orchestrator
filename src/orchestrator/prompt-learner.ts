import type { StateStore } from "../state/store.js";

export class PromptLearner {
  constructor(private store: StateStore) {}

  buildPlannerContext(): string {
    const stats = this.store.getAgentStats();
    const recent = this.store.getRecentCompleted(5);

    const sections: string[] = [];

    if (stats.length > 0) {
      const agentLines = stats.map((s) => {
        const successRate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
        const scoreStr = s.avg_score !== null ? ` avg quality: ${s.avg_score.toFixed(2)}` : "";
        return `- ${s.agent_name}: ${s.done}/${s.total} tasks done (${successRate}% success)${scoreStr}`;
      });
      sections.push(`## Agent Performance\n${agentLines.join("\n")}`);
    }

    if (recent.length > 0) {
      const examples = recent
        .filter((t) => t.plan)
        .slice(0, 3)
        .map((t) => {
          const score = t.quality_score !== null ? ` (score: ${t.quality_score.toFixed(1)})` : "";
          return `- "${t.title}"${score}: ${t.status}`;
        });
      if (examples.length > 0) {
        sections.push(`## Recent Plans\n${examples.join("\n")}`);
      }
    }

    return sections.length > 0 ? "\n\n" + sections.join("\n\n") : "";
  }

  buildRouterContext(): string {
    const stats = this.store.getAgentStats();
    if (stats.length === 0) return "";

    const lines = stats.map((s) => {
      const successRate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
      return `- ${s.agent_name}: ${successRate}% success rate (${s.total} tasks)`;
    });

    return `\n\nAgent track record:\n${lines.join("\n")}`;
  }
}
