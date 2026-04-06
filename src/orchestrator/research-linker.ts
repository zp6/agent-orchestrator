import { createLLMClient } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";
import type { IssueCreator, CreatedIssue } from "./issue-creator.js";
import { createLogger } from "../service/logger.js";

/**
 * An actionable implementation gap extracted from a research task's findings.
 */
export interface ImplementationGap {
  /** Short title for the implementation issue */
  title: string;
  /** Detailed description of what to build and why */
  description: string;
  /** Target repo (e.g. "rapartlu/claude-proxy") where the issue should be filed */
  target_repo: string;
  /** Severity: how impactful is this gap */
  severity: "low" | "medium" | "high";
}

/**
 * Minimum quality score a research task must have before its findings
 * are analyzed for implementation gaps.  Only high-quality research
 * should trigger automatic issue creation.
 */
export const RESEARCH_LINK_MIN_SCORE = 0.8;

/**
 * Source ref prefix used for tasks/issues created from research findings.
 * Format: `research-link:<researchTaskId>`
 */
export const RESEARCH_LINK_SOURCE_PREFIX = "research-link";

const SYSTEM_PROMPT = `You are an implementation gap analyst. Given a research task and its findings, identify concrete implementation tasks that should be filed as GitHub issues on the relevant agent repositories.

For each gap you identify, determine:
1. Which repository should own the implementation (based on where the code change belongs)
2. A specific, actionable title
3. A description with clear acceptance criteria

RULES:
- Only identify gaps that are DIRECTLY supported by evidence in the research findings
- Each gap must be a single, atomic piece of work (not a bundle)
- Title should be concise (under 80 characters)
- Description must include: what to build, why it matters, and specific acceptance criteria
- target_repo must be a valid GitHub "owner/repo" string
- Do NOT suggest gaps for research, documentation, or testing-only work
- Do NOT suggest gaps that are vague ("improve performance") — be specific
- If no clear implementation gaps exist, return an empty array

Respond with ONLY a JSON array (no markdown, no code fences):
[
  {
    "title": "Short implementation title",
    "description": "What to build, why, and acceptance criteria",
    "target_repo": "owner/repo",
    "severity": "low|medium|high"
  }
]

If no implementation gaps are found, return: []`;

export class ResearchLinker {
  private log = createLogger("research-linker");

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
    private issueCreator: IssueCreator,
  ) {}

  /**
   * Analyze approved research tasks and auto-file implementation issues
   * for any actionable gaps found in the findings.
   *
   * Returns the list of created issues (empty if none).
   */
  async linkResearchToImplementation(tasks: Task[]): Promise<CreatedIssue[]> {
    // Filter to approved research tasks with high enough quality
    const researchTasks = tasks.filter(
      (t) =>
        t.task_type === "research" &&
        t.verification_status === "approved" &&
        t.quality_score !== null &&
        t.quality_score >= RESEARCH_LINK_MIN_SCORE &&
        t.result,
    );

    if (researchTasks.length === 0) return [];

    const allCreated: CreatedIssue[] = [];

    for (const task of researchTasks) {
      // Check if we already processed this research task
      const sourceRef = `${RESEARCH_LINK_SOURCE_PREFIX}:${task.id}`;
      const existing = this.store.findTaskBySourceRef("manual", sourceRef);
      if (existing) {
        this.log.info("Research task already linked, skipping", {
          taskId: task.id,
          existingLinkTaskId: existing.id,
        });
        continue;
      }

      try {
        const gaps = await this.analyzeForGaps(task);
        if (gaps.length === 0) {
          this.log.info("No implementation gaps found in research", { taskId: task.id });
          // Record that we processed this task (even with no gaps) to avoid re-analyzing
          this.recordLinkAttempt(task, []);
          continue;
        }

        const created = this.fileGapIssues(task, gaps);
        allCreated.push(...created);

        // Record the link attempt with results
        this.recordLinkAttempt(task, created);
      } catch (err) {
        this.log.error("Failed to analyze research task for gaps", {
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return allCreated;
  }

  /**
   * Use an LLM to extract implementation gaps from a research task's findings.
   */
  async analyzeForGaps(task: Task): Promise<ImplementationGap[]> {
    const client = createLLMClient(this.config);

    // Build list of known repos so the LLM can target the right one
    const knownRepos = Object.entries(this.config.agents)
      .filter(([, a]) => a.github)
      .map(([name, a]) => `- ${name}: ${a.github} — ${a.description}`)
      .join("\n");

    const prompt = `## Research Task
**Title:** ${task.title}
**Agent:** ${task.agent_name ?? "unknown"}
**Quality Score:** ${task.quality_score?.toFixed(2) ?? "N/A"}

## Research Findings
${task.result}

## Known Agent Repositories
${knownRepos}

Analyze the research findings above and identify specific implementation tasks that should be filed as GitHub issues on the relevant repositories.`;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      return this.parseResponse(text);
    } catch (err) {
      this.log.error("LLM analysis failed", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * File GitHub issues for each gap, with duplicate detection.
   */
  private fileGapIssues(researchTask: Task, gaps: ImplementationGap[]): CreatedIssue[] {
    const created: CreatedIssue[] = [];

    for (const gap of gaps) {
      // Validate the target repo is one of our known agent repos
      const agentEntry = Object.entries(this.config.agents).find(
        ([, a]) => a.github === gap.target_repo,
      );
      if (!agentEntry) {
        this.log.warn("Gap targets unknown repo, skipping", {
          targetRepo: gap.target_repo,
          gapTitle: gap.title,
        });
        continue;
      }

      const candidateTitle = `[Orchestrator] ${gap.title}`;

      // Duplicate detection: check if similar issue already exists
      if (this.issueCreator.isDuplicate(gap.target_repo, candidateTitle)) {
        this.log.info("Skipping gap: duplicate issue already exists", {
          repo: gap.target_repo,
          title: candidateTitle,
        });
        continue;
      }

      const body = this.formatGapIssueBody(researchTask, gap);

      try {
        const issue = this.issueCreator.createIssue(
          gap.target_repo,
          candidateTitle,
          body,
          ["orchestrator", "research-implementation"],
        );
        created.push(issue);
        this.log.info("Created implementation issue from research", {
          repo: gap.target_repo,
          issueNumber: issue.number,
          researchTaskId: researchTask.id,
        });
      } catch (err) {
        this.log.error("Failed to create gap issue", {
          repo: gap.target_repo,
          title: candidateTitle,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return created;
  }

  /**
   * Record that we analyzed a research task for implementation gaps.
   * Creates a lightweight task entry so we don't re-analyze the same research.
   */
  private recordLinkAttempt(researchTask: Task, createdIssues: CreatedIssue[]): void {
    const sourceRef = `${RESEARCH_LINK_SOURCE_PREFIX}:${researchTask.id}`;
    const issueLinks = createdIssues
      .map((i) => `${i.repo}#${i.number}`)
      .join(", ");

    this.store.createTask({
      title: `[research-link] Analyzed: ${researchTask.title}`,
      description: createdIssues.length > 0
        ? `Filed ${createdIssues.length} implementation issue(s): ${issueLinks}`
        : "No implementation gaps identified",
      source: "manual",
      source_ref: sourceRef,
      agent_name: undefined,
      task_type: "implementation",
    });

    // Immediately mark as done since this is a bookkeeping record
    const linkTask = this.store.findTaskBySourceRef("manual", sourceRef);
    if (linkTask) {
      this.store.updateTask(linkTask.id, {
        status: "done",
        verification_status: "approved",
        quality_score: 1.0,
        result: createdIssues.length > 0
          ? `Created issues: ${issueLinks}`
          : "No gaps found",
      });
    }
  }

  /**
   * Format the GitHub issue body for an implementation gap.
   */
  private formatGapIssueBody(researchTask: Task, gap: ImplementationGap): string {
    // Try to find a PR URL in the research task's source_ref
    const sourceLink = researchTask.source_ref
      ? `\`${researchTask.source_ref}\``
      : `Task \`${researchTask.id.slice(0, 8)}\``;

    return `## Implementation Gap Identified from Research

**Severity:** ${gap.severity}
**Source research:** ${sourceLink}
**Research task:** \`${researchTask.id.slice(0, 8)}\` — ${researchTask.title}
**Quality score:** ${researchTask.quality_score?.toFixed(2) ?? "N/A"}

### Description

${gap.description}

### Research Context

This implementation gap was automatically identified by analyzing the findings of research task \`${researchTask.id.slice(0, 8)}\` (${researchTask.agent_name ?? "unknown agent"}).

---
*This issue was automatically created by the claude-agent-orchestrator from approved research findings.*`;
  }

  /**
   * Parse the LLM response into implementation gaps.
   */
  parseResponse(text: string): ImplementationGap[] {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];

      const validSeverities = new Set(["low", "medium", "high"]);

      return parsed
        .filter(
          (item: Record<string, unknown>) =>
            typeof item.title === "string" &&
            typeof item.description === "string" &&
            typeof item.target_repo === "string" &&
            item.title.length > 0 &&
            item.description.length > 0 &&
            item.target_repo.includes("/"),
        )
        .map((item: Record<string, unknown>) => ({
          title: String(item.title),
          description: String(item.description),
          target_repo: String(item.target_repo),
          severity: (validSeverities.has(String(item.severity))
            ? String(item.severity)
            : "medium") as "low" | "medium" | "high",
        }));
    } catch {
      this.log.warn("Failed to parse LLM response for implementation gaps");
      return [];
    }
  }
}
