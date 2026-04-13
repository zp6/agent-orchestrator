import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { DetectedImprovement } from "../client/reviewer-client.js";
import { createLogger } from "../service/logger.js";

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
}

/**
 * Default max open issues the orchestrator can auto-create per repo.
 * Configurable via `triggers.max_open_orchestrator_issues` in agents.yaml.
 */
const MAX_OPEN_ORCHESTRATOR_ISSUES = 10;

/** Minimum word-overlap Jaccard similarity to consider two issue titles duplicates. */
const DEDUP_SIMILARITY_THRESHOLD = 0.4;

/** Strip common noise words so similarity is based on meaningful terms. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with",
  "is", "are", "was", "be", "by", "as", "it", "its", "add", "fix", "update",
  "support", "use", "via", "from", "into", "that", "this", "when", "not",
]);

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

  /**
   * Fetch open issue titles for a repo (all issues, not just orchestrator-labelled ones)
   * so we can detect duplicates across all sources.
   */
  getOpenIssueTitles(repo: string): string[] {
    try {
      const raw = execSync(
        `gh issue list --repo ${shellEscape(repo)} --state open --json title -L 200`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (!raw) return [];
      const issues = JSON.parse(raw) as { title: string }[];
      return issues.map((i) => i.title);
    } catch {
      return []; // fail-open: if we can't check, allow creation
    }
  }

  /**
   * Compute Jaccard similarity between the meaningful-word sets of two titles.
   * Returns a value in [0, 1]. Values >= DEDUP_SIMILARITY_THRESHOLD are treated
   * as duplicates.
   */
  titleSimilarity(a: string, b: string): number {
    const words = (s: string): Set<string> => {
      const tokens = s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
      return new Set(tokens);
    };

    const setA = words(a);
    const setB = words(b);

    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const w of setA) {
      if (setB.has(w)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return intersection / union;
  }

  /**
   * Returns true if an existing open issue is similar enough to `title` that we
   * should skip creation.
   */
  isDuplicate(repo: string, title: string): boolean {
    const existingTitles = this.getOpenIssueTitles(repo);
    for (const existing of existingTitles) {
      const sim = this.titleSimilarity(title, existing);
      if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
        this.log.info("Skipping issue creation: similar issue already exists", {
          repo,
          newTitle: title,
          existingTitle: existing,
          similarity: sim.toFixed(2),
        });
        return true;
      }
    }
    return false;
  }

  createAcrossRepos(improvement: DetectedImprovement, extraLabels: string[] = []): CreatedIssue[] {
    const created: CreatedIssue[] = [];

    for (const agentName of improvement.affected_agents) {
      const agent = this.config.agents[agentName];
      if (!agent?.github) continue;

      // Throttle: skip if repo already has too many open orchestrator issues
      const openCount = this.getOpenOrchestratorIssueCount(agent.github);
      const maxIssues = this.config.triggers?.max_open_orchestrator_issues ?? MAX_OPEN_ORCHESTRATOR_ISSUES;
      if (openCount >= maxIssues) {
        this.log.warn("Skipping issue creation: too many open orchestrator issues", {
          repo: agent.github, openCount, threshold: maxIssues,
        });
        continue;
      }

      const candidateTitle = `[Orchestrator] ${improvement.title}`;

      if (this.isDuplicate(agent.github, candidateTitle)) {
        continue;
      }

      const body = this.formatIssueBody(improvement, agentName);

      // Ensure any extra labels exist on the repo before creating the issue
      for (const label of extraLabels) {
        this.ensureLabel(agent.github, label);
      }

      try {
        const issue = this.createIssue(
          agent.github,
          candidateTitle,
          body,
          ["orchestrator", ...extraLabels],
        );
        created.push(issue);
      } catch {
        // Continue creating issues for other repos
      }
    }

    return created;
  }

  /**
   * Idempotently ensure a GitHub label exists on a repo.
   * Creates it with a neutral colour if missing; silently ignores errors
   * (e.g. permission issues or network timeouts) so the caller can proceed.
   */
  ensureLabel(repo: string, label: string, color = "ededed"): void {
    try {
      // Check if label already exists
      execSync(
        `gh label list --repo ${shellEscape(repo)} --json name -L 500`,
        { encoding: "utf-8", timeout: 15000 },
      );
      // Attempt to create; gh returns non-zero if it already exists but we catch that
      try {
        execSync(
          `gh label create ${shellEscape(label)} --repo ${shellEscape(repo)} --color ${shellEscape(color)} --force`,
          { encoding: "utf-8", timeout: 15000, stdio: "pipe" },
        );
      } catch {
        // Label already exists or insufficient permissions — either way, proceed
      }
    } catch {
      // Could not list labels — skip label creation and let createIssue handle it
    }
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
