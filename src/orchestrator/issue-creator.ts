import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { DetectedImprovement } from "./improvement-detector.js";
import { createLogger } from "../service/logger.js";

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
}

const MAX_OPEN_ORCHESTRATOR_ISSUES = 10;

export class IssueCreator {
  private log = createLogger("issue-creator");

  constructor(private config: OrchestratorConfig) {}

  createIssue(
    repo: string,
    title: string,
    body: string,
    labels: string[] = ["orchestrator"],
  ): CreatedIssue {
    const labelArgs = labels.map((l) => `--label ${shellEscape(l)}`).join(" ");
    const output = execSync(
      `gh issue create --repo ${shellEscape(repo)} --title ${shellEscape(title)} --body ${shellEscape(body)} ${labelArgs}`,
      { encoding: "utf-8", timeout: 30000 },
    ).trim();

    // gh issue create returns the URL
    const url = output;
    const match = url.match(/\/issues\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;

    return { repo, number, url };
  }

  getOpenOrchestratorIssueCount(repo: string): number {
    try {
      const raw = execSync(
        `gh issue list --repo ${shellEscape(repo)} --state open --label orchestrator --json number -L 100`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (!raw) return 0;
      return (JSON.parse(raw) as unknown[]).length;
    } catch {
      return 0; // fail-open
    }
  }

  createAcrossRepos(improvement: DetectedImprovement): CreatedIssue[] {
    const created: CreatedIssue[] = [];

    for (const agentName of improvement.affected_agents) {
      const agent = this.config.agents[agentName];
      if (!agent?.github) continue;

      const openCount = this.getOpenOrchestratorIssueCount(agent.github);
      if (openCount >= MAX_OPEN_ORCHESTRATOR_ISSUES) {
        this.log.warn("Skipping issue creation: too many open orchestrator issues", {
          repo: agent.github, openCount, threshold: MAX_OPEN_ORCHESTRATOR_ISSUES,
        });
        continue;
      }

      const body = this.formatIssueBody(improvement, agentName);

      try {
        const issue = this.createIssue(
          agent.github,
          `[Orchestrator] ${improvement.title}`,
          body,
        );
        created.push(issue);
      } catch {
        // Continue creating issues for other repos
      }
    }

    return created;
  }

  private formatIssueBody(improvement: DetectedImprovement, agentName: string): string {
    const evidenceList = improvement.evidence
      .map((e) => `- Task \`${e.taskId.slice(0, 8)}\`: ${e.detail}`)
      .join("\n");

    return `## Improvement Identified by Orchestrator

**Severity:** ${improvement.severity}
**Affected agent:** ${agentName}

### Description

${improvement.description}

### Evidence

${evidenceList || "No specific task evidence available."}

---
*This issue was automatically created by the claude-agent-orchestrator based on analysis of recent task patterns.*`;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
