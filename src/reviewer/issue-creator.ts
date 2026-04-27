/**
 * Issue creator — creates GitHub issues for detected improvements.
 *
 * Migrated from rapartlu/claude-agent-orchestrator:src/orchestrator/issue-creator.ts
 * Adaptations:
 *   - Config replaced with ReviewerConfig
 *   - No functional changes; pure gh CLI calls
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { DetectedImprovement } from "./improvement-detector.js";

export interface CreatedIssue {
  repo: string;
  number: number;
  url: string;
}

/**
 * A follow-up that was not created as an issue because the cross-repo cap
 * was reached. These are posted as comments on the source PR instead.
 */
export interface DeferredFollowUp {
  repo: string;
  agentName: string;
  title: string;
  body: string;
}

export interface CreateAcrossReposResult {
  /** Issues that were actually created on GitHub. */
  created: CreatedIssue[];
  /** Follow-ups deferred because the cross-repo cap was reached. */
  deferred: DeferredFollowUp[];
  /** True when at least one follow-up was deferred due to the cap. */
  capReached: boolean;
}

export interface CreateAcrossReposOptions {
  /**
   * Maximum number of cross-repo issues to create per call.
   * When the cap is reached, remaining follow-ups are returned as `deferred`
   * items that should be posted as comments on the source PR.
   *
   * Set to 0 for unlimited (legacy behavior). Default: 1.
   */
  maxCrossRepoIssues?: number;
  /** Extra labels to add beyond the default "orchestrator" label. */
  extraLabels?: string[];
}

/** Default cap: a single PR review can spawn at most 1 cross-repo issue. */
export const DEFAULT_MAX_CROSS_REPO_ISSUES = 1;

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

  constructor(private config: ReviewerConfig) {}

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
   * Fetch open issue titles for a repo so we can detect duplicates across all sources.
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
   * Returns a value in [0, 1]. Values >= DEDUP_SIMILARITY_THRESHOLD are duplicates.
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
   * Returns true if an existing open issue is similar enough to `title` that
   * we should skip creation.
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

  /**
   * Create issues across repos for a detected improvement, respecting the
   * cross-repo follow-up cap.
   *
   * When `maxCrossRepoIssues` is reached, remaining follow-ups are returned
   * in `result.deferred` so the caller can post them as comments on the
   * source PR via `postDeferredFollowUps()`.
   *
   * For backward compatibility, the method also returns just the created
   * issues array when called without options (legacy callers).
   */
  createAcrossRepos(
    improvement: DetectedImprovement,
    optsOrLabels?: CreateAcrossReposOptions | string[],
  ): CreatedIssue[] {
    const result = this.createAcrossReposWithCap(improvement, optsOrLabels);
    return result.created;
  }

  /**
   * Full-result variant that returns both created issues and deferred follow-ups.
   * Callers that need to handle the cap should use this method.
   */
  createAcrossReposWithCap(
    improvement: DetectedImprovement,
    optsOrLabels?: CreateAcrossReposOptions | string[],
  ): CreateAcrossReposResult {
    // Backward compat: accept string[] as extraLabels (legacy signature)
    const opts: CreateAcrossReposOptions = Array.isArray(optsOrLabels)
      ? { extraLabels: optsOrLabels }
      : (optsOrLabels ?? {});

    const maxCrossRepo = opts.maxCrossRepoIssues ?? DEFAULT_MAX_CROSS_REPO_ISSUES;
    const labels = ["orchestrator", ...(opts.extraLabels ?? [])];

    const created: CreatedIssue[] = [];
    const deferred: DeferredFollowUp[] = [];
    let crossRepoCount = 0;

    for (const agentName of improvement.affected_agents) {
      const agent = this.config.agents[agentName];
      if (!agent?.github) continue;

      // Throttle: skip if repo already has too many open orchestrator issues
      const openCount = this.getOpenOrchestratorIssueCount(agent.github);
      if (openCount >= MAX_OPEN_ORCHESTRATOR_ISSUES) {
        this.log.warn("Skipping issue creation: too many open orchestrator issues", {
          repo: agent.github,
          openCount,
          threshold: MAX_OPEN_ORCHESTRATOR_ISSUES,
        });
        continue;
      }

      const candidateTitle = `[Orchestrator] ${improvement.title}`;

      if (this.isDuplicate(agent.github, candidateTitle)) {
        continue;
      }

      const body = this.formatIssueBody(improvement, agentName);

      // Check cross-repo cap (0 = unlimited)
      if (maxCrossRepo > 0 && crossRepoCount >= maxCrossRepo) {
        this.log.info("Cross-repo follow-up cap reached — deferring issue", {
          repo: agent.github,
          agentName,
          title: candidateTitle,
          crossRepoCount,
          maxCrossRepo,
        });
        deferred.push({ repo: agent.github, agentName, title: candidateTitle, body });
        continue;
      }

      try {
        const issue = this.createIssue(agent.github, candidateTitle, body, labels);
        created.push(issue);
        crossRepoCount++;
      } catch {
        // Continue creating issues for other repos
      }
    }

    const capReached = deferred.length > 0;
    if (capReached) {
      this.log.warn("Cross-repo follow-up cap reached", {
        created: created.length,
        deferred: deferred.length,
        maxCrossRepo,
      });
    }

    return { created, deferred, capReached };
  }

  /**
   * Post deferred follow-ups as a comment on the source PR so the concerns
   * are not lost. Called by the daemon after `createAcrossReposWithCap()` when
   * `result.capReached` is true.
   *
   * @param prRepo  The repo that owns the source PR (e.g. "rapartlu/agent-reviewer")
   * @param prNumber  The PR number that triggered the improvement detection
   * @param deferred  The deferred follow-ups from `createAcrossReposWithCap()`
   */
  postDeferredFollowUps(prRepo: string, prNumber: number, deferred: DeferredFollowUp[]): void {
    if (deferred.length === 0) return;

    const lines: string[] = [
      `### ⏳ Follow-up cap reached — ${deferred.length} deferred concern${deferred.length > 1 ? "s" : ""}`,
      "",
      "The improvement detector identified additional cross-repo concerns from this PR review, " +
        "but the per-cycle follow-up cap (1 issue per PR review) was reached. " +
        "These will be picked up in the next review cycle:",
      "",
    ];

    for (const d of deferred) {
      lines.push(`#### ${d.title}`);
      lines.push(`**Repo:** \`${d.repo}\` · **Agent:** \`${d.agentName}\``);
      lines.push("");
      // Include a condensed version of the body (description only, skip evidence/footer)
      const descMatch = d.body.match(/### Description\n\n([\s\S]*?)(?:\n###|\n---)/);
      if (descMatch) {
        lines.push(descMatch[1].trim());
      }
      lines.push("");
    }

    lines.push("---");
    lines.push("*Deferred by cross-repo follow-up cap. These concerns will be filed as issues in the next cycle.*");

    const comment = lines.join("\n");

    try {
      execSync(
        `gh pr comment ${prNumber} --repo ${shellEscape(prRepo)} --body ${shellEscape(comment)}`,
        { encoding: "utf-8", timeout: 15000 },
      );
      this.log.info("Posted deferred follow-ups as PR comment", {
        prRepo,
        prNumber,
        deferredCount: deferred.length,
      });
    } catch (err) {
      this.log.error("Failed to post deferred follow-ups comment", {
        prRepo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** @internal Exposed for testing; prefer createAcrossRepos in production code. */
  formatIssueBody(improvement: DetectedImprovement, agentName: string): string {
    const evidenceList = improvement.evidence
      .map((e) => `- Task \`${e.taskId.slice(0, 8)}\`: ${e.detail}`)
      .join("\n");

    const isResearch = improvement.source === "research-finding";

    const header = isResearch
      ? "## Implementation Proposal from Research Findings"
      : "## Improvement Identified by Orchestrator";

    const evidenceLabel = isResearch ? "### Source Research Tasks" : "### Evidence";

    const footer = isResearch
      ? "*This issue was automatically drafted by the claude-agent-orchestrator from the Recommendation / Next Steps sections of completed research reports.*"
      : "*This issue was automatically created by the claude-agent-orchestrator based on analysis of recent task patterns.*";

    return `${header}

**Severity:** ${improvement.severity}
**Affected agent:** ${agentName}

### Description

${improvement.description}

${evidenceLabel}

${evidenceList || "No specific task evidence available."}

---
${footer}`;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
