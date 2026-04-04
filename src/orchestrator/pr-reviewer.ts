import { execSync } from "node:child_process";
import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { Deployer } from "./deployer.js";
import { extractIssueNumberFromBranch, findMatchingIssueNumber } from "./pr-creator.js";

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  repo: string;
  author: string;
  branch: string;
  diff: string;
  files_changed: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

export interface PRReviewResult {
  decision: "approve" | "request-changes" | "escalate";
  comment: string;
  reason: string;
}

const SYSTEM_PROMPT = `You are a code reviewer for a multi-agent system. Your job is to catch real bugs and security issues, NOT to enforce style preferences.

Decide ONE of:

1. **approve** — the code works, is safe, and achieves its goal. Approve even if you'd write it differently.
2. **request-changes** — there are BLOCKING issues only: bugs that will break at runtime, security vulnerabilities, data loss risks, or missing critical functionality. Style, naming, structure preferences, and "could be cleaner" observations are NOT blocking.
3. **escalate** — needs human review (security-sensitive, architectural, breaking changes, or genuinely uncertain)

IMPORTANT:
- Default to APPROVE. Most PRs that work correctly should be approved.
- Only request changes for issues that would cause real failures or security problems.
- Never block on: code style, naming conventions, missing comments/docs, "could use a helper function", edge cases that are unlikely in practice, or suggestions for follow-up work.
- If you have minor suggestions, include them in an approval comment — don't block the PR for them.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "decision": "approve|request-changes|escalate",
  "comment": "Your review comment to post on the PR",
  "reason": "Brief internal reason for the decision"
}`;

export class PRReviewer {
  private log = createLogger("pr-reviewer");
  private deployer: Deployer;

  constructor(private config: OrchestratorConfig) {
    this.deployer = new Deployer(config);
  }

  async reviewPR(repo: string, prNumber: number): Promise<PRReviewResult> {
    const pr = this.fetchPRInfo(repo, prNumber);
    this.log.info("Reviewing PR", { repo, prNumber, title: pr.title, filesChanged: pr.files_changed, mergeable: pr.mergeable });

    // Short-circuit: skip review entirely if PR has merge conflicts
    if (pr.mergeable === "CONFLICTING") {
      const result: PRReviewResult = {
        decision: "request-changes",
        comment: `This PR has merge conflicts and cannot be merged. Please rebase onto main:\n\n\`\`\`\ngit fetch origin\ngit rebase origin/main\n# resolve conflicts\ngit push --force-with-lease\n\`\`\``,
        reason: "Merge conflict detected — skipping review",
      };
      this.log.info("PR has merge conflicts, skipping review", { repo, prNumber });
      await this.executeDecision(repo, prNumber, result);
      return result;
    }

    // PR body linter: agent PRs must include "Closes #N"
    if (this.isAgentPR(pr) && !this.hasIssueRef(pr)) {
      this.log.warn("PR body linter: missing Closes #N", {
        repo,
        prNumber,
        title: pr.title,
        branch: pr.branch,
        hasAgentTitlePrefix: Object.keys(this.config.agents).some((name) => pr.title.includes(`[${name}]`)),
      });
      // Try to auto-patch the PR body by inferring the issue number from the branch name,
      // rather than wasting a full review cycle dispatching feedback to the agent.
      // Uses all 3 tiers: direct branch parse → fuzzy title match → LLM disambiguation.
      const inferredIssue = await findMatchingIssueNumber(repo, pr.branch, this.config);
      if (inferredIssue) {
        const patched = await this.patchPRBodyWithIssueRef(repo, prNumber, pr.body, inferredIssue);
        if (patched) {
          // Successfully patched — refresh body and continue to LLM review
          pr.body = pr.body.trim()
            ? `${pr.body.trim()}\n\nCloses #${inferredIssue}`
            : `Closes #${inferredIssue}`;
          this.log.info("PR body auto-patched with issue ref", { repo, prNumber, inferredIssue });
        } else {
          // Patch failed — fall back to requesting changes from the agent
          const result: PRReviewResult = {
            decision: "request-changes",
            comment: `PR body must include "Closes #${inferredIssue}" so the issue auto-closes on merge. Please update the PR body with \`gh pr edit ${prNumber} --body "...Closes #${inferredIssue}"\`.`,
            reason: "PR body missing issue reference (Closes #N) — auto-patch failed",
          };
          this.log.info("PR body linter: auto-patch failed, requesting changes", { repo, prNumber, inferredIssue });
          await this.executeDecision(repo, prNumber, result);
          return result;
        }
      } else {
        // Can't infer issue number from branch even after fuzzy + LLM matching — give the agent actionable steps
        const result: PRReviewResult = {
          decision: "request-changes",
          comment: `PR body is missing a "Closes #N" reference and no matching open issue could be found for branch \`${pr.branch}\`.\n\nFind the relevant issue:\n\`\`\`\ngh issue list --repo ${repo} --state open\n\`\`\`\n\nThen add the reference to the PR body:\n\`\`\`\ngh pr edit ${prNumber} --repo ${repo} --body "$(gh pr view ${prNumber} --repo ${repo} --json body -q .body)\n\nCloses #N"\n\`\`\`\n\nReplace \`N\` with the actual issue number before running.`,
          reason: "PR body missing issue reference (Closes #N) — could not infer from branch name, fuzzy match, or LLM",
        };
        this.log.warn("PR body linter: missing issue ref, cannot infer from branch (all 3 tiers failed)", {
          repo,
          prNumber,
          branch: pr.branch,
          title: pr.title,
        });
        await this.executeDecision(repo, prNumber, result);
        return result;
      }
    }

    // Escalate after too many review rounds instead of endlessly requesting changes
    const priorReviews = this.countPriorReviews(repo, prNumber);
    if (priorReviews >= 3) {
      const result: PRReviewResult = {
        decision: "escalate",
        comment: `This PR has been through ${priorReviews} review cycles. Escalating to human reviewer rather than continuing to request changes.`,
        reason: `${priorReviews} review cycles — escalating to break the loop`,
      };
      this.log.info("PR review cycle cap reached, escalating", { repo, prNumber, priorReviews });
      await this.executeDecision(repo, prNumber, result);
      return result;
    }

    // Diff size safety check
    const DIFF_WARN_THRESHOLD = 80_000;   // 80 KB — warn LLM that diff is truncated
    const DIFF_ESCALATE_THRESHOLD = 200_000; // 200 KB — auto-escalate, too large to review safely
    const diffSize = pr.diff.length;

    if (diffSize > DIFF_ESCALATE_THRESHOLD) {
      const result: PRReviewResult = {
        decision: "escalate",
        comment: `This PR's diff is ${Math.round(diffSize / 1024)} KB, which exceeds the safe review limit (200 KB). Automated review would only see a small fraction of the changes and could give false confidence. Escalating to human review.`,
        reason: `Diff too large for automated review (${Math.round(diffSize / 1024)} KB > 200 KB threshold)`,
      };
      this.log.warn("PR diff too large — auto-escalating", { repo, prNumber, diffSize });
      await this.executeDecision(repo, prNumber, result);
      return result;
    }

    const diffTruncated = diffSize > DIFF_WARN_THRESHOLD;
    const truncatedDiff = pr.diff.slice(0, 100_000);
    const diffWarning = diffTruncated
      ? `\n\n> ⚠️ **TRUNCATED DIFF WARNING**: The full diff is ${Math.round(diffSize / 1024)} KB but only the first ~${Math.round(truncatedDiff.length / 1024)} KB is shown here. Your review is INCOMPLETE — you have not seen all the changes. Factor this into your decision: note in your comment which files/areas you could not review, and consider escalating if the unseen portion looks significant based on file names or context.`
      : "";

    const client = createLLMClient(this.config
    );

    const prompt = `## PR #${pr.number}: ${pr.title}\n**Repo:** ${pr.repo}\n**Author:** ${pr.author}\n**Branch:** ${pr.branch}\n**Files changed:** ${pr.files_changed}${diffWarning}\n\n### Description\n${pr.body}\n\n### Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      const result = this.parseResponse(text);
      this.log.info("PR review complete", { repo, prNumber, decision: result.decision, reason: result.reason });

      // Execute the decision
      await this.executeDecision(repo, prNumber, result);

      return result;
    } catch (err) {
      this.log.error("PR review failed", { repo, prNumber, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async reviewOpenPRs(repo: string): Promise<Array<{ prNumber: number; result: PRReviewResult }>> {
    const results: Array<{ prNumber: number; result: PRReviewResult }> = [];

    const prs = this.fetchOpenPRs(repo);
    for (const pr of prs) {
      try {
        const result = await this.reviewPR(repo, pr.number);
        results.push({ prNumber: pr.number, result });
      } catch {
        // Continue reviewing other PRs
      }
    }

    return results;
  }

  private async executeDecision(repo: string, prNumber: number, result: PRReviewResult): Promise<void> {
    switch (result.decision) {
      case "approve":
        try {
          // Comment with the review, then merge (can't approve own PRs on GitHub)
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Approved**\n\n${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          execSync(
            `gh pr merge ${prNumber} --repo ${repo} --squash --delete-branch`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR approved and merged", { repo, prNumber });
          // Restart repo-based agent containers so they pull latest main
          await this.restartAgentsForRepo(repo);
        } catch (err) {
          this.log.error("Failed to approve/merge PR", { repo, prNumber, error: String(err) });
        }
        break;

      case "request-changes":
        try {
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Changes Requested**\n\n${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR changes requested", { repo, prNumber });
        } catch (err) {
          this.log.error("Failed to request changes on PR", { repo, prNumber, error: String(err) });
        }
        break;

      case "escalate":
        try {
          // Try to add human reviewer (may fail if rapartlu is the PR author)
          try {
            execSync(
              `gh pr edit ${prNumber} --repo ${repo} --add-reviewer rapartlu`,
              { encoding: "utf-8", timeout: 30000 },
            );
          } catch {
            // Can't request review from PR author — add label instead
            try {
              execSync(
                `gh pr edit ${prNumber} --repo ${repo} --add-label "needs-human-review"`,
                { encoding: "utf-8", timeout: 30000 },
              );
            } catch {
              // Label may not exist, that's fine — the comment below is the important part
            }
          }
          // Leave a comment explaining why
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**Orchestrator escalation:** ${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR escalated to human", { repo, prNumber, reason: result.reason });
        } catch (err) {
          this.log.error("Failed to escalate PR", { repo, prNumber, error: String(err) });
        }
        break;
    }
  }

  private countPriorReviews(repo: string, prNumber: number): number {
    try {
      const raw = execSync(
        `gh api "repos/${repo}/issues/${prNumber}/comments?per_page=100" --jq '[.[] | select(.body | startswith("**[orchestrator] PR Review"))] | length'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      return parseInt(raw, 10) || 0;
    } catch {
      return 0; // fail-open
    }
  }

  private isAgentPR(pr: PRInfo): boolean {
    // Match PRs where the title contains [agent-name]
    const agentNames = Object.keys(this.config.agents);
    if (agentNames.some((name) => pr.title.includes(`[${name}]`))) return true;

    // Also match PRs whose branch follows the issue-N-* naming convention.
    // Agents are instructed to use this format, so a branch like "issue-42-add-feature"
    // is almost certainly agent-created even if the title prefix was omitted.
    // This catches the common failure mode where an agent forgets [agent-name] in the
    // title and the Closes #N linter would otherwise silently be skipped.
    if (extractIssueNumberFromBranch(pr.branch) !== null) return true;

    return false;
  }

  private hasIssueRef(pr: PRInfo): boolean {
    return /(?:closes|fixes|resolves)\s+#\d+/i.test(pr.body);
  }

  /**
   * Auto-patch a PR body to include "Closes #N" using gh pr edit.
   * Returns true if the patch succeeded, false otherwise.
   */
  private async patchPRBodyWithIssueRef(repo: string, prNumber: number, currentBody: string, issueNumber: string): Promise<boolean> {
    try {
      const newBody = currentBody.trim()
        ? `${currentBody.trim()}\n\nCloses #${issueNumber}`
        : `Closes #${issueNumber}`;
      execSync(
        `gh pr edit ${prNumber} --repo ${repo} --body ${shellEscape(newBody)}`,
        { encoding: "utf-8", timeout: 30000 },
      );
      return true;
    } catch (err) {
      this.log.error("Failed to auto-patch PR body with issue ref", { repo, prNumber, issueNumber, error: String(err) });
      return false;
    }
  }

  private async restartAgentsForRepo(repo: string): Promise<void> {
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (agent.github === repo && agent.repo) {
        this.log.info("Restarting agent after PR merge", { agentName: name, repo });
        await this.deployer.restartAgent(name);
      }
    }
  }

  isPROpen(repo: string, prNumber: number): boolean {
    try {
      const state = execSync(
        `gh pr view ${prNumber} --repo ${repo} --json state -q .state`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      return state === "OPEN";
    } catch {
      // Fail-safe: if we can't verify the state, don't dispatch
      this.log.warn("Could not verify PR state, skipping feedback dispatch", { repo, prNumber });
      return false;
    }
  }

  private fetchPRInfo(repo: string, prNumber: number): PRInfo {
    const prJson = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json number,title,body,author,headRefName,changedFiles,mergeable`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const pr = JSON.parse(prJson);

    const diff = execSync(
      `gh pr diff ${prNumber} --repo ${repo}`,
      { encoding: "utf-8", timeout: 30000 },
    );

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      repo,
      author: pr.author?.login ?? "unknown",
      branch: pr.headRefName,
      diff,
      files_changed: pr.changedFiles ?? 0,
      mergeable: pr.mergeable ?? "UNKNOWN",
    };
  }

  private fetchOpenPRs(repo: string): Array<{ number: number; title: string }> {
    const output = execSync(
      `gh pr list --repo ${repo} --state open --json number,title`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return JSON.parse(output);
  }

  private parseResponse(text: string): PRReviewResult {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      const decision = ["approve", "request-changes", "escalate"].includes(parsed.decision)
        ? parsed.decision as PRReviewResult["decision"]
        : "escalate";
      return {
        decision,
        comment: String(parsed.comment ?? ""),
        reason: String(parsed.reason ?? ""),
      };
    } catch {
      return { decision: "escalate", comment: "Could not parse review — escalating to human.", reason: "Parse failure" };
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
