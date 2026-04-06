/**
 * PR Reviewer — reviews open pull requests, manages a merge queue, and
 * auto-rebases stale branches.
 *
 * Migrated from rapartlu/claude-agent-orchestrator:src/orchestrator/pr-reviewer.ts
 * Adaptations:
 *   - Uses createLLMClient() from ../client/llm-client (no proxy routing)
 *   - Accepts IStateStore interface instead of concrete StateStore
 *   - Config replaced with ReviewerConfig
 *   - Removed Deployer dependency — agent restarts are signalled via the
 *     `onAgentRestart` callback so the orchestrator daemon handles the actual
 *     restart. Default no-op if not provided.
 *   - extractIssueNumberFromBranch and findMatchingIssueNumber inlined here
 *     (no longer imported from pr-creator.ts)
 */

import { execSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore, MergeQueueEntry } from "../state/types.js";

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
  /**
   * Set to true when escalation is due to unresolvable merge conflicts.
   * The orchestrator daemon uses this flag to decide when to auto-close a
   * persistently conflicting PR and re-dispatch the linked issue.
   */
  conflictEscalation?: boolean;
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

// ── Issue number helpers ──────────────────────────────────────────────────────

/**
 * Extract the issue number from a branch name following the `issue-N-*` convention.
 * Returns the number as a string, or null if not found.
 */
function extractIssueNumberFromBranch(branch: string): string | null {
  const match = branch.match(/^issue-(\d+)/i);
  return match ? match[1] : null;
}

/**
 * Find a matching open issue number for a branch using 3 tiers:
 *   1. Direct parse from branch name (issue-N-*)
 *   2. Fuzzy title match against open issues
 *   3. LLM disambiguation (if ANTHROPIC_API_KEY is available)
 *
 * Returns the issue number as a string, or null if no match found.
 */
async function findMatchingIssueNumber(
  repo: string,
  branch: string,
  config: ReviewerConfig,
): Promise<string | null> {
  // Tier 1: direct parse
  const direct = extractIssueNumberFromBranch(branch);
  if (direct) return direct;

  // Tier 2: fuzzy title match
  try {
    const raw = execSync(
      `gh issue list --repo ${shellEscape(repo)} --state open --json number,title -L 50`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();
    if (raw) {
      const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
      // Normalize branch name to candidate words
      const branchWords = new Set(
        branch
          .toLowerCase()
          .replace(/[-_]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 2),
      );

      let bestMatch: { number: number; score: number } | null = null;
      for (const issue of issues) {
        const titleWords = new Set(
          issue.title
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((w) => w.length > 2),
        );
        let overlap = 0;
        for (const w of branchWords) {
          if (titleWords.has(w)) overlap++;
        }
        const score = overlap / Math.max(branchWords.size, titleWords.size, 1);
        if (score > 0.3 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { number: issue.number, score };
        }
      }
      if (bestMatch) return String(bestMatch.number);
    }
  } catch {
    // gh not available — fall through
  }

  // Tier 3: LLM disambiguation (best-effort)
  try {
    const client = createLLMClient();
    const raw = execSync(
      `gh issue list --repo ${shellEscape(repo)} --state open --json number,title -L 50`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();
    if (!raw) return null;
    const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
    const issueList = issues.map((i) => `#${i.number}: ${i.title}`).join("\n");
    const prompt = `Branch name: ${branch}\n\nOpen issues:\n${issueList}\n\nWhich issue number does this branch most likely relate to? Respond with ONLY the number (e.g. "42") or "none" if no match.`;
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();
    const num = text.match(/^\d+$/);
    if (num) return num[0];
  } catch {
    // LLM unavailable — return null
  }

  void config; // suppress unused-variable warning
  return null;
}

// ── PRReviewer ────────────────────────────────────────────────────────────────

export class PRReviewer {
  private log = createLogger("pr-reviewer");
  private conflictEscalationCount = new Map<string, number>();

  /**
   * Optional callback invoked after a PR merge so the orchestrator daemon can
   * restart the affected agents (e.g. docker restart). Defaults to a no-op.
   */
  private onAgentRestart: (repo: string) => Promise<void>;

  constructor(
    private config: ReviewerConfig,
    private store: IStateStore,
    opts: { onAgentRestart?: (repo: string) => Promise<void> } = {},
  ) {
    this.onAgentRestart = opts.onAgentRestart ?? (async () => {});
  }

  async reviewPR(repo: string, prNumber: number): Promise<PRReviewResult> {
    const pr = this.fetchPRInfo(repo, prNumber);

    // ── Merge conflict check ──────────────────────────────────────────────
    if (pr.mergeable === "CONFLICTING") {
      const localPath = this.findLocalRepoPath(repo);
      if (localPath) {
        const rebaseOutcome = await this.tryAutoRebase(localPath, pr.branch);
        if (rebaseOutcome === "success") {
          this.log.info("Auto-rebase succeeded — continuing with review", {
            repo,
            prNumber,
            branch: pr.branch,
          });
          // Fall through to normal review
        } else {
          const conflictKey = `${repo}#${prNumber}`;
          const conflictCount = (this.conflictEscalationCount.get(conflictKey) ?? 0) + 1;
          this.conflictEscalationCount.set(conflictKey, conflictCount);
          const result: PRReviewResult = {
            decision: "escalate",
            comment: `This PR has merge conflicts and auto-rebase onto \`origin/main\` failed (real conflicts need manual resolution).\n\n\`\`\`\ngit fetch origin\ngit rebase origin/main\n# resolve conflicts\ngit push --force-with-lease\n\`\`\``,
            reason: "Merge conflict — auto-rebase failed, escalating to human",
            conflictEscalation: true,
          };
          this.log.warn("Auto-rebase failed, escalating PR to human", {
            repo,
            prNumber,
            branch: pr.branch,
            conflictEscalationCount: conflictCount,
          });
          await this.executeDecision(repo, prNumber, result);
          return result;
        }
      } else {
        const conflictKey = `${repo}#${prNumber}`;
        const conflictCount = (this.conflictEscalationCount.get(conflictKey) ?? 0) + 1;
        this.conflictEscalationCount.set(conflictKey, conflictCount);
        const result: PRReviewResult = {
          decision: "escalate",
          comment: `This PR has merge conflicts. No local repository found for auto-rebase. Please rebase manually:\n\n\`\`\`\ngit fetch origin\ngit rebase origin/main\n# resolve conflicts\ngit push --force-with-lease\n\`\`\``,
          reason: "Merge conflict — no local repo for auto-rebase, escalating to human",
          conflictEscalation: true,
        };
        this.log.info("PR has merge conflicts and no local repo found, escalating", {
          repo,
          prNumber,
          conflictEscalationCount: conflictCount,
        });
        await this.executeDecision(repo, prNumber, result);
        return result;
      }
    } else {
      // Proactive rebase for stale branches (best-effort, review continues regardless)
      const localPath = this.findLocalRepoPath(repo);
      if (localPath) {
        const rebaseOutcome = await this.tryAutoRebase(localPath, pr.branch);
        this.log.info("Proactive pre-review rebase", {
          repo,
          prNumber,
          branch: pr.branch,
          outcome: rebaseOutcome,
        });
      }
    }

    // ── PR body linter: agent PRs must include "Closes #N" ────────────────
    if (this.isAgentPR(pr) && !this.hasIssueRef(pr)) {
      this.log.warn("PR body linter: missing Closes #N", {
        repo,
        prNumber,
        title: pr.title,
        branch: pr.branch,
      });
      const inferredIssue = await findMatchingIssueNumber(repo, pr.branch, this.config);
      if (inferredIssue) {
        const patched = await this.patchPRBodyWithIssueRef(
          repo,
          prNumber,
          pr.body,
          inferredIssue,
        );
        if (patched) {
          pr.body = pr.body.trim()
            ? `${pr.body.trim()}\n\nCloses #${inferredIssue}`
            : `Closes #${inferredIssue}`;
          this.log.info("PR body auto-patched with issue ref", {
            repo,
            prNumber,
            inferredIssue,
          });
        } else {
          const result: PRReviewResult = {
            decision: "request-changes",
            comment: `PR body must include "Closes #${inferredIssue}" so the issue auto-closes on merge. Please update the PR body with \`gh pr edit ${prNumber} --body "...Closes #${inferredIssue}"\`.`,
            reason: "PR body missing issue reference (Closes #N) — auto-patch failed",
          };
          await this.executeDecision(repo, prNumber, result);
          return result;
        }
      } else {
        const result: PRReviewResult = {
          decision: "request-changes",
          comment: `PR body is missing a "Closes #N" reference and no matching open issue could be found for branch \`${pr.branch}\`.\n\nFind the relevant issue:\n\`\`\`\ngh issue list --repo ${repo} --state open\n\`\`\`\n\nThen add the reference to the PR body:\n\`\`\`\ngh pr edit ${prNumber} --repo ${repo} --body "$(gh pr view ${prNumber} --repo ${repo} --json body -q .body)\n\nCloses #N"\n\`\`\`\n\nReplace \`N\` with the actual issue number before running.`,
          reason:
            "PR body missing issue reference (Closes #N) — could not infer from branch name, fuzzy match, or LLM",
        };
        await this.executeDecision(repo, prNumber, result);
        return result;
      }
    }

    // ── Cross-repo Closes #N validator (issue #373) ───────────────────────
    // GitHub only auto-closes issues via bare "Closes #N" within the SAME
    // repo.  Cross-repo references require "Closes owner/repo#N".  Agents
    // frequently get this wrong when they implement an issue from repo A but
    // open a PR on repo B.
    const issueRepo = this.inferIssueRepo(pr.body, repo);
    if (issueRepo && issueRepo !== repo) {
      const crossRepoIssues = validateClosesReferences(repo, pr.body, issueRepo);
      if (crossRepoIssues.length > 0) {
        // Auto-patch when there's exactly one bare ref and we have a confident repo match
        if (crossRepoIssues.length === 1) {
          const issue = crossRepoIssues[0];
          const patched = await this.autoPatchCrossRepoCloses(
            repo,
            prNumber,
            pr.body,
            issue,
          );
          if (patched) {
            this.log.info("Auto-patched cross-repo Closes reference", {
              repo,
              prNumber,
              issueRepo,
              from: `${issue.keyword} #${issue.number}`,
              to: `${issue.keyword} ${issue.suggestedRef}`,
            });
            // Continue with normal review — the body is now correct
          } else {
            // Auto-patch failed — fall back to request-changes
            this.log.warn("Auto-patch failed for cross-repo Closes ref, requesting changes", {
              repo,
              prNumber,
              issueRepo,
            });
            const result: PRReviewResult = {
              decision: "request-changes",
              comment:
                `This PR is on \`${repo}\` but uses a bare \`${issue.keyword} #${issue.number}\` reference that only works within the same repo. ` +
                `GitHub will **not** auto-close the linked issue on merge.\n\n` +
                `Please update the PR body:\n- \`${issue.keyword} #${issue.number}\` → \`${issue.keyword} ${issue.suggestedRef}\``,
              reason: "PR body uses bare Closes #N for cross-repo issue reference — GitHub won't auto-close (auto-patch failed)",
            };
            await this.executeDecision(repo, prNumber, result);
            return result;
          }
        } else {
          // Multiple bare refs — ambiguous, request manual review
          const fixes = crossRepoIssues
            .map(
              (issue) =>
                `- \`${issue.keyword} #${issue.number}\` → should be \`${issue.keyword} ${issue.suggestedRef}\``,
            )
            .join("\n");
          const result: PRReviewResult = {
            decision: "request-changes",
            comment:
              `This PR is on \`${repo}\` but uses bare \`Closes #N\` references that only work within the same repo. ` +
              `GitHub will **not** auto-close the linked issue(s) on merge.\n\n` +
              `Please update the PR body:\n${fixes}`,
            reason: "PR body uses multiple bare Closes #N for cross-repo issue references — GitHub won't auto-close",
          };
          this.log.warn("Multiple cross-repo Closes #N detected, requesting changes", {
            repo,
            prNumber,
            issueRepo,
            issues: crossRepoIssues,
          });
          await this.executeDecision(repo, prNumber, result);
          return result;
        }
      }
    }

    // ── Feedback ceiling: escalate after too many revision rounds ──────────
    const reviewCeiling = this.config.pr_review?.feedback_ceiling ?? 3;
    const priorReviews = this.countPriorReviews(repo, prNumber);
    if (priorReviews >= reviewCeiling) {
      const result: PRReviewResult = {
        decision: "escalate",
        comment: `This PR has gone through ${priorReviews} revision rounds without merging — escalating to human review.`,
        reason: `${priorReviews} revision rounds without merging — escalating to break the loop`,
      };
      this.log.info("PR review cycle cap reached, escalating", {
        repo,
        prNumber,
        priorReviews,
        reviewCeiling,
      });
      await this.executeDecision(repo, prNumber, result);
      return result;
    }

    // ── Diff size gates ───────────────────────────────────────────────────
    const DIFF_WARN_THRESHOLD = 80_000;
    const DIFF_ESCALATE_THRESHOLD = 200_000;
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

    // ── LLM review ────────────────────────────────────────────────────────
    const client = createLLMClient();
    const prompt = `## PR #${pr.number}: ${pr.title}\n**Repo:** ${pr.repo}\n**Author:** ${pr.author}\n**Branch:** ${pr.branch}\n**Files changed:** ${pr.files_changed}${diffWarning}\n\n### Description\n${pr.body}\n\n### Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
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

      const result = this.parseResponse(text);
      this.log.info("PR review complete", {
        repo,
        prNumber,
        decision: result.decision,
        reason: result.reason,
      });

      await this.executeDecision(repo, prNumber, result, pr.branch);
      return result;
    } catch (err) {
      this.log.error("PR review failed", {
        repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async reviewOpenPRs(
    repo: string,
  ): Promise<
    Array<{ prNumber: number; result: PRReviewResult; prBody: string; prBranch: string }>
  > {
    const results: Array<{
      prNumber: number;
      result: PRReviewResult;
      prBody: string;
      prBranch: string;
    }> = [];
    const prs = this.fetchOpenPRs(repo);
    for (const pr of prs) {
      try {
        const result = await this.reviewPR(repo, pr.number);
        results.push({
          prNumber: pr.number,
          result,
          prBody: pr.body,
          prBranch: pr.branch,
        });
      } catch {
        // Continue reviewing other PRs
      }
    }
    return results;
  }

  private async executeDecision(
    repo: string,
    prNumber: number,
    result: PRReviewResult,
    prBranch?: string,
  ): Promise<void> {
    switch (result.decision) {
      case "approve": {
        try {
          const branch = prBranch ?? this.fetchPRBranch(repo, prNumber);
          if (this.store.isPRInMergeQueue(repo, prNumber)) {
            this.log.info("PR already in merge queue, skipping re-enqueue", {
              repo,
              prNumber,
            });
            break;
          }
          const entry = this.store.queuePRForMerge(repo, prNumber, branch);
          const queueSize = this.store.getMergeQueue(repo).length;
          const positionMsg =
            entry.position === 0
              ? "next in queue"
              : `position ${entry.position + 1} of ${queueSize} in queue`;
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Approved** ✅\n\n${result.comment}\n\n---\n🔀 Added to merge queue (${positionMsg}). PRs merge sequentially to avoid branch conflicts.`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR approved and added to merge queue", {
            repo,
            prNumber,
            position: entry.position,
          });
          this.store.recordPRReview(repo, prNumber, "approve");
        } catch (err) {
          this.log.error("Failed to approve/enqueue PR", {
            repo,
            prNumber,
            error: String(err),
          });
        }
        break;
      }

      case "request-changes": {
        try {
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Changes Requested**\n\n${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR changes requested", { repo, prNumber });
          this.store.recordPRReview(repo, prNumber, "request-changes");
        } catch (err) {
          this.log.error("Failed to request changes on PR", {
            repo,
            prNumber,
            error: String(err),
          });
        }
        break;
      }

      case "escalate": {
        try {
          try {
            execSync(
              `gh pr edit ${prNumber} --repo ${repo} --add-reviewer rapartlu`,
              { encoding: "utf-8", timeout: 30000 },
            );
          } catch {
            try {
              execSync(
                `gh pr edit ${prNumber} --repo ${repo} --add-label "needs-human-review"`,
                { encoding: "utf-8", timeout: 30000 },
              );
            } catch {
              // Label may not exist — the comment is the important part
            }
          }
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**Orchestrator escalation:** ${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR escalated to human", {
            repo,
            prNumber,
            reason: result.reason,
          });
          this.store.recordPRReview(repo, prNumber, "escalate");
        } catch (err) {
          this.log.error("Failed to escalate PR", {
            repo,
            prNumber,
            error: String(err),
          });
        }
        break;
      }
    }
  }

  async escalatePR(repo: string, prNumber: number, reason: string): Promise<void> {
    const result: PRReviewResult = { decision: "escalate", comment: reason, reason };
    this.log.info("Escalating PR via public escalatePR()", { repo, prNumber, reason });
    await this.executeDecision(repo, prNumber, result);
  }

  /**
   * Fetch the most recent `[orchestrator] PR Review — Changes Requested` comment
   * for a PR, extract the checklist items, and return a structured dispatch
   * message the orchestrator can hand to the agent.
   *
   * Returns null if no change-request comment is found or the PR info cannot be
   * fetched (caller should fall back to a plain feedback message).
   */
  async buildPRFeedbackTaskMessage(
    repo: string,
    prNumber: number,
  ): Promise<string | null> {
    let prInfo: PRInfo;
    try {
      prInfo = this.fetchPRInfo(repo, prNumber);
    } catch (err) {
      this.log.warn("buildPRFeedbackTaskMessage: could not fetch PR info", {
        repo,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Fetch the last change-request comment body
    let reviewComment: string | null = null;
    try {
      const raw = execSync(
        `gh api "repos/${repo}/issues/${prNumber}/comments?per_page=100" --jq '[.[] | select(.body | contains("[orchestrator] PR Review — Changes Requested"))] | last | .body'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (raw && raw !== "null") reviewComment = raw;
    } catch {
      // gh not available or API error — fall through to return null
    }

    if (!reviewComment) {
      this.log.warn("buildPRFeedbackTaskMessage: no change-request comment found", {
        repo,
        prNumber,
      });
      return null;
    }

    // Strip the "**[orchestrator] PR Review — Changes Requested**\n\n" header
    const stripped = reviewComment
      .replace(/^\*\*\[orchestrator\] PR Review — Changes Requested\*\*\s*/i, "")
      .trim();

    return buildFeedbackTaskMessage({
      repo,
      prNumber,
      prTitle: prInfo.title,
      prBranch: prInfo.branch,
      reviewComment: stripped,
      diff: prInfo.diff,
    });
  }

  getConflictEscalationCount(repo: string, prNumber: number): number {
    return this.conflictEscalationCount.get(`${repo}#${prNumber}`) ?? 0;
  }

  resetConflictEscalation(repo: string, prNumber: number): void {
    this.conflictEscalationCount.delete(`${repo}#${prNumber}`);
  }

  autoCloseConflictingPR(
    repo: string,
    prNumber: number,
    branch: string,
    conflictCount: number,
  ): boolean {
    const comment = [
      `**[orchestrator] Auto-closed due to persistent merge conflicts**`,
      ``,
      `This PR has been in a conflict state for ${conflictCount} consecutive review cycles and auto-rebase has failed each time. Rather than continuing to escalate, the orchestrator is closing this PR and will re-dispatch the original issue so the agent can start fresh from \`main\`.`,
      ``,
      `The branch \`${branch}\` will be deleted to prevent the orphan-branch detector from recreating this PR.`,
      ``,
      `The linked issue will be re-opened automatically and dispatched to the agent.`,
    ].join("\n");

    try {
      execSync(
        `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(comment)}`,
        { encoding: "utf-8", timeout: 30000 },
      );
    } catch (err) {
      this.log.error("Failed to post auto-close comment on conflicting PR", {
        repo,
        prNumber,
        error: String(err),
      });
    }

    try {
      execSync(`gh pr close ${prNumber} --repo ${repo} --delete-branch`, {
        encoding: "utf-8",
        timeout: 30000,
      });
      this.log.info(
        "Auto-closed persistently conflicting PR and deleted branch",
        { repo, prNumber, branch, conflictCount },
      );
      this.store.recordPRReview(repo, prNumber, "escalate");
      return true;
    } catch (err) {
      this.log.error("Failed to auto-close conflicting PR", {
        repo,
        prNumber,
        branch,
        error: String(err),
      });
      try {
        execSync(`gh api repos/${repo}/git/refs/heads/${branch} -X DELETE`, {
          encoding: "utf-8",
          timeout: 15000,
        });
        this.log.info("Deleted conflicting branch via API after PR close failed", {
          repo,
          branch,
        });
      } catch {
        this.log.warn("Could not delete conflicting branch", { repo, branch });
      }
      return false;
    }
  }

  getMergeQueue(repo?: string): MergeQueueEntry[] {
    return this.store.getMergeQueue(repo);
  }

  async processMergeQueue(): Promise<void> {
    const queue = this.store.getMergeQueue();
    if (queue.length === 0) return;

    const repos = [...new Set(queue.map((e) => e.repo))];

    for (const repo of repos) {
      const repoQueue = this.store.getMergeQueue(repo);
      const merging = repoQueue.find((e) => e.status === "merging");
      if (merging) {
        const isOpen = this.isPROpen(repo, merging.pr_number);
        if (!isOpen) {
          this.store.markQueuedPRMerged(repo, merging.pr_number);
          this.log.info("Queued PR merge completed (detected closed)", {
            repo,
            prNumber: merging.pr_number,
          });
          await this.rebaseRemainingQueue(repo, merging.branch);
          await this.onAgentRestart(repo);
        } else {
          this.log.info("Merge still in progress, waiting", {
            repo,
            prNumber: merging.pr_number,
          });
        }
        continue;
      }

      const next = repoQueue.find((e) => e.status === "queued");
      if (!next) continue;

      if (!this.isPROpen(repo, next.pr_number)) {
        this.log.info("Queued PR is no longer open, removing from queue", {
          repo,
          prNumber: next.pr_number,
        });
        this.store.removeFromMergeQueue(repo, next.pr_number);
        continue;
      }

      this.store.markQueuedPRMerging(repo, next.pr_number);
      this.log.info("Processing merge queue: merging PR", {
        repo,
        prNumber: next.pr_number,
        branch: next.branch,
      });

      try {
        execSync(
          `gh pr merge ${next.pr_number} --repo ${repo} --squash --delete-branch`,
          { encoding: "utf-8", timeout: 60000 },
        );
        this.store.markQueuedPRMerged(repo, next.pr_number);
        this.log.info("Merge queue: PR merged successfully", {
          repo,
          prNumber: next.pr_number,
        });
        await this.rebaseRemainingQueue(repo, next.branch);
        await this.onAgentRestart(repo);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.store.markQueuedPRFailed(repo, next.pr_number, errMsg);
        this.log.error("Merge queue: PR merge failed", {
          repo,
          prNumber: next.pr_number,
          error: errMsg,
        });
        try {
          execSync(
            `gh pr comment ${next.pr_number} --repo ${repo} --body ${shellEscape(`**[orchestrator] Merge Queue — Merge Failed** ❌\n\nFailed to merge PR automatically:\n\`\`\`\n${errMsg.slice(0, 500)}\n\`\`\`\nThis PR has been removed from the merge queue. Please resolve any issues and re-open a review.`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
        } catch {
          // Best effort
        }
      }
    }
  }

  private async rebaseRemainingQueue(repo: string, justMergedBranch: string): Promise<void> {
    const localPath = this.findLocalRepoPath(repo);
    if (!localPath) {
      this.log.warn("Cannot rebase queued branches: no local repo path found", { repo });
      return;
    }

    const remaining = this.store
      .getMergeQueue(repo)
      .filter((e) => e.branch !== justMergedBranch);
    if (remaining.length === 0) return;

    this.log.info("Rebasing remaining queued branches after merge", {
      repo,
      count: remaining.length,
    });

    for (const entry of remaining) {
      try {
        const outcome = await this.tryAutoRebase(localPath, entry.branch);
        this.log.info("Rebase of queued branch", {
          repo,
          branch: entry.branch,
          outcome,
        });
        if (outcome === "failed") {
          this.store.markQueuedPRFailed(
            repo,
            entry.pr_number,
            "Rebase onto new main failed after previous merge",
          );
          try {
            execSync(
              `gh pr comment ${entry.pr_number} --repo ${repo} --body ${shellEscape(`**[orchestrator] Merge Queue — Rebase Failed** ⚠️\n\nAfter the preceding PR was merged, this branch could not be automatically rebased onto the new \`main\`. Please rebase manually and re-queue:\n\`\`\`\ngit fetch origin && git rebase origin/main\n# resolve conflicts\ngit push --force-with-lease\n\`\`\``)}`,
              { encoding: "utf-8", timeout: 30000 },
            );
          } catch {
            // Best effort
          }
        }
      } catch (err) {
        this.log.error("Error rebasing queued branch", {
          repo,
          branch: entry.branch,
          error: String(err),
        });
      }
    }
  }

  private fetchPRBranch(repo: string, prNumber: number): string {
    try {
      return execSync(
        `gh pr view ${prNumber} --repo ${repo} --json headRefName -q .headRefName`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
    } catch {
      return "unknown";
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
      this.log.warn("Could not verify PR state, skipping feedback dispatch", {
        repo,
        prNumber,
      });
      return false;
    }
  }

  private findLocalRepoPath(repo: string): string | null {
    for (const agent of Object.values(this.config.agents)) {
      if (agent.github === repo) {
        const candidate = resolve(this.config.base_dir, agent.dir);
        try {
          execSync("git rev-parse --git-dir", {
            cwd: candidate,
            encoding: "utf-8",
            timeout: 5000,
          });
          return candidate;
        } catch {
          this.log.warn("Agent repo path is not a valid git repo", {
            repo,
            path: candidate,
          });
          continue;
        }
      }
    }
    try {
      const remote = execSync("git remote get-url origin", {
        cwd: this.config.orchestrator_dir,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      if (remote.includes(repo)) {
        return this.config.orchestrator_dir;
      }
    } catch {
      // orchestrator_dir has no git remote — skip
    }
    return null;
  }

  private async tryAutoRebase(localPath: string, branch: string): Promise<"success" | "up-to-date" | "failed"> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.config.ssh_key) {
      const sshKeyPath = this.config.ssh_key.replace(/^~/, process.env.HOME ?? "");
      env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no`;
    }
    env.GIT_TERMINAL_PROMPT = "0";

    const opts = { cwd: localPath, encoding: "utf-8" as const, env };
    let currentBranch = "main";

    try {
      try {
        execSync("git rebase --abort", { ...opts, timeout: 5000 });
      } catch { /* no rebase in progress */ }
      try {
        unlinkSync(resolve(localPath, ".git/index.lock"));
      } catch { /* no lock file */ }
      try {
        execSync("git stash --include-untracked", { ...opts, timeout: 10000 });
      } catch { /* nothing to stash */ }

      currentBranch =
        execSync("git rev-parse --abbrev-ref HEAD", { ...opts, timeout: 10000 }).trim() || "main";

      execSync("git fetch origin", { ...opts, timeout: 30000 });
      execSync(`git checkout ${branch}`, { ...opts, timeout: 15000 });

      try {
        const rebaseOutput = execSync("git rebase origin/main", { ...opts, timeout: 60000 });
        if (rebaseOutput.includes("is up to date")) {
          return "up-to-date";
        }
      } catch {
        // Try LLM-powered conflict resolution before giving up
        const resolved = await this.resolveConflictsWithLLM(localPath, branch, opts);
        if (!resolved) {
          try { execSync("git rebase --abort", { ...opts, timeout: 10000 }); } catch { /* ignore */ }
          return "failed";
        }
        // LLM resolved conflicts — fall through to push
      }

      try {
        execSync(`git push --force-with-lease origin ${branch}`, { ...opts, timeout: 30000 });
        return "success";
      } catch (err) {
        this.log.warn("Rebase succeeded but push failed — will retry next cycle", {
          localPath,
          branch,
          error: err instanceof Error ? err.message : String(err),
        });
        return "failed";
      }
    } catch (err) {
      this.log.warn("Auto-rebase git error", {
        localPath,
        branch,
        error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    } finally {
      try {
        execSync(`git checkout ${currentBranch}`, { ...opts, timeout: 10000 });
      } catch { /* ignore */ }
    }
  }

  /**
   * Attempt to resolve merge conflicts using an LLM.
   * Returns true if all conflicts were resolved and the rebase completed,
   * false if resolution failed (caller should abort the rebase).
   */
  private async resolveConflictsWithLLM(
    localPath: string,
    branchName: string,
    opts: { cwd: string; encoding: "utf-8"; env: Record<string, string> },
  ): Promise<boolean> {
    const MAX_ROUNDS = 5;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      // Collect files that still have conflict markers
      const conflictingFiles = execSync(
        "git diff --name-only --diff-filter=U",
        { ...opts, timeout: 10000 },
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      if (conflictingFiles.length === 0) return true; // all conflicts resolved

      const client = createLLMClient();

      for (const file of conflictingFiles) {
        const filePath = resolve(localPath, file);
        let content: string;
        try {
          content = readFileSync(filePath, "utf-8");
        } catch {
          this.log.warn("resolveConflictsWithLLM: could not read conflicting file", { file });
          return false;
        }

        // Skip binary files or files that somehow lack conflict markers
        if (!content.includes("<<<<<<<")) continue;

        this.log.info("resolveConflictsWithLLM: resolving conflict via LLM", { file, round });

        let resolved: string;
        try {
          const response = await client.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            messages: [
              {
                role: "user",
                content:
                  `Resolve this merge conflict. The branch name is: "${branchName}".\n\n` +
                  `File: ${file}\n\n${content}\n\n` +
                  `Return ONLY the resolved file content. No explanation, no code fences. ` +
                  `Keep both sides' intent. Prefer the feature branch's changes when they ` +
                  `don't contradict main.`,
              },
            ],
          });

          resolved = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { type: "text"; text: string }).text)
            .join("");
        } catch (err) {
          this.log.warn("resolveConflictsWithLLM: LLM call failed", {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }

        try {
          if (resolved.includes("<<<<<<<")) {
            this.log.warn("resolveConflictsWithLLM: LLM output still contains conflict markers", { file, round });
            return false;
          }
          writeFileSync(filePath, resolved);
          const addResult = spawnSync("git", ["add", "--", file], { ...opts, timeout: 5000 });
          if (addResult.status !== 0) {
            throw new Error(
              `git add exited with status ${addResult.status}: ${String(addResult.stderr ?? "")}`,
            );
          }
        } catch (err) {
          this.log.warn("resolveConflictsWithLLM: failed to write/stage resolved file", {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
          return false;
        }
      }

      // Continue the rebase; more conflicts from the next commit will loop again
      try {
        execSync("git -c core.editor=true rebase --continue", { ...opts, timeout: 30000 });
      } catch {
        // Another conflict set from the next commit — the loop will handle it
        continue;
      }
    }

    // Check whether the rebase is still in progress (exceeded MAX_ROUNDS)
    try {
      execSync("git rebase --show-current-patch", { ...opts, timeout: 5000 });
      return false; // still in rebase
    } catch {
      return true; // rebase completed
    }
  }

  private fetchPRInfo(repo: string, prNumber: number): PRInfo {
    const prJson = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json number,title,body,author,headRefName,changedFiles,mergeable`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const pr = JSON.parse(prJson);
    const diff = execSync(`gh pr diff ${prNumber} --repo ${repo}`, {
      encoding: "utf-8",
      timeout: 30000,
    });
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

  private fetchOpenPRs(
    repo: string,
  ): Array<{ number: number; title: string; body: string; branch: string }> {
    const output = execSync(
      `gh pr list --repo ${repo} --state open --json number,title,body,headRefName`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const prs = JSON.parse(output) as Array<{
      number: number;
      title: string;
      body?: string;
      headRefName?: string;
    }>;
    return prs.map((pr) => ({
      ...pr,
      body: pr.body ?? "",
      branch: pr.headRefName ?? "",
    }));
  }

  private countPriorReviews(repo: string, prNumber: number): number {
    try {
      const raw = execSync(
        `gh api "repos/${repo}/issues/${prNumber}/comments?per_page=100" --jq '[.[] | select(.body | contains("[orchestrator] PR Review — Changes Requested"))] | length'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      return parseInt(raw, 10) || 0;
    } catch {
      return 0;
    }
  }

  private isAgentPR(pr: PRInfo): boolean {
    const agentNames = Object.keys(this.config.agents);
    if (agentNames.some((name) => pr.title.includes(`[${name}]`))) return true;
    if (extractIssueNumberFromBranch(pr.branch) !== null) return true;
    return false;
  }

  private hasIssueRef(pr: PRInfo): boolean {
    // Match both bare "#N" and fully qualified "owner/repo#N" forms
    return /(?:closes|fixes|resolves)\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i.test(pr.body);
  }

  /**
   * Try to determine which repo the PR's issue belongs to by scanning the
   * body for fully qualified references (e.g. `rapartlu/claude-agent-orchestrator#373`).
   * Returns the first `owner/repo` found, or undefined if none detected.
   */
  private inferIssueRepo(prBody: string, _prRepo: string): string | undefined {
    // Look for fully qualified "owner/repo#N" references in the body
    // (anywhere, not just after Closes/Fixes/Resolves — could be in a URL or description)
    const fullRefPattern = /([\w.-]+\/[\w.-]+)#(\d+)/g;
    let match;
    while ((match = fullRefPattern.exec(prBody)) !== null) {
      const candidate = match[1];
      // Filter out obvious non-repo strings (URLs with protocol, etc.)
      if (!candidate.includes(".") || candidate.includes("://")) continue;
      return candidate;
    }
    return undefined;
  }

  private async patchPRBodyWithIssueRef(
    repo: string,
    prNumber: number,
    currentBody: string,
    issueNumber: string,
  ): Promise<boolean> {
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
      this.log.error("Failed to auto-patch PR body with issue ref", {
        repo,
        prNumber,
        issueNumber,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * Auto-patch a single bare cross-repo `Closes #N` reference in the PR body
   * to use the fully qualified `Closes owner/repo#N` form.
   *
   * Returns true if the patch was applied successfully, false on failure.
   */
  private async autoPatchCrossRepoCloses(
    repo: string,
    prNumber: number,
    currentBody: string,
    issue: CrossRepoCloseIssue,
  ): Promise<boolean> {
    try {
      // Build a regex that matches the specific bare reference
      // e.g. "Closes #42" → "Closes rapartlu/claude-agent-orchestrator#42"
      const pattern = new RegExp(
        `(${issue.keyword})\\s+#${issue.number}\\b`,
        "gi",
      );
      const newBody = currentBody.replace(pattern, `$1 ${issue.suggestedRef}`);

      if (newBody === currentBody) {
        this.log.warn("Auto-patch produced no change — pattern may not match", {
          repo,
          prNumber,
          keyword: issue.keyword,
          number: issue.number,
        });
        return false;
      }

      execSync(
        `gh pr edit ${prNumber} --repo ${repo} --body ${shellEscape(newBody)}`,
        { encoding: "utf-8", timeout: 30000 },
      );
      return true;
    } catch (err) {
      this.log.error("Failed to auto-patch cross-repo Closes reference", {
        repo,
        prNumber,
        issue,
        error: String(err),
      });
      return false;
    }
  }

  private parseResponse(text: string): PRReviewResult {
    const strategies = [
      () => JSON.parse(text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()),
      () => {
        const match = text.match(/\{[\s\S]*?"decision"[\s\S]*?\}/);
        if (!match) throw new Error("No JSON object found");
        return JSON.parse(match[0]);
      },
      () => {
        const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (!match) throw new Error("No code fence found");
        return JSON.parse(match[1].trim());
      },
    ];

    for (const strategy of strategies) {
      try {
        const parsed = strategy();
        const decision = ["approve", "request-changes", "escalate"].includes(parsed.decision)
          ? (parsed.decision as PRReviewResult["decision"])
          : "escalate";
        const comment = String(parsed.comment ?? "");
        return {
          decision,
          comment: decision === "request-changes" ? enforceChecklist(comment) : comment,
          reason: String(parsed.reason ?? ""),
        };
      } catch {
        continue;
      }
    }

    return {
      decision: "escalate",
      comment: "Could not parse review — escalating to human.",
      reason: "Parse failure",
    };
  }
}

/**
 * Returned by validateClosesReferences for each bare `Closes #N` that should
 * use a fully qualified `owner/repo#N` form for cross-repo auto-close.
 */
export interface CrossRepoCloseIssue {
  /** The keyword used (e.g. "Closes", "Fixes", "Resolves") */
  keyword: string;
  /** The bare issue number */
  number: number;
  /** The suggested fully qualified reference (e.g. "rapartlu/claude-agent-orchestrator#373") */
  suggestedRef: string;
}

/**
 * Validate that `Closes/Fixes/Resolves` references in a PR body use the
 * correct form for cross-repo auto-close.
 *
 * GitHub only auto-closes issues via bare `Closes #N` when the PR and issue
 * are in the same repo.  For cross-repo references, the full `owner/repo#N`
 * form is required (e.g. `Closes rapartlu/claude-agent-orchestrator#373`).
 *
 * @param prRepo    The repo the PR is on (e.g. "rapartlu/claude-orchestrator-reviewer")
 * @param prBody    The PR body text
 * @param issueRepo The repo the issue lives on (e.g. "rapartlu/claude-agent-orchestrator")
 * @returns Array of bare references that need to be rewritten. Empty if all references are correct.
 *
 * Exported for testing.
 */
export function validateClosesReferences(
  prRepo: string,
  prBody: string,
  issueRepo: string,
): CrossRepoCloseIssue[] {
  // Same repo — bare references are fine
  if (prRepo === issueRepo) return [];

  const issues: CrossRepoCloseIssue[] = [];
  // Match bare "Closes #N" (NOT "Closes owner/repo#N")
  // Use a negative lookbehind to exclude fully qualified refs would be ideal,
  // but instead we use a pattern that explicitly captures the bare form:
  // keyword + whitespace + # + digits, ensuring there's no "word/" before the #
  const bareRefPattern = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
  let match;
  while ((match = bareRefPattern.exec(prBody)) !== null) {
    const fullMatch = match[0];
    const number = parseInt(match[1], 10);
    // Extract the keyword (Closes/Fixes/Resolves) from the match
    const keyword = fullMatch.split(/\s/)[0];

    // Check this isn't actually part of a fully-qualified ref by looking at
    // what comes before the match. If there's "owner/repo" immediately before
    // the "#", it's already qualified.
    const beforeMatch = prBody.slice(0, match.index);
    if (/[\w.-]+\/[\w.-]+\s*$/.test(beforeMatch)) continue;

    issues.push({
      keyword,
      number,
      suggestedRef: `${issueRepo}#${number}`,
    });
  }

  return issues;
}

/**
 * Extract individual checklist items from a change-request comment.
 *
 * Handles the output of enforceChecklist (numbered lines like "1. Fix X") as
 * well as plain bullet lists ("- Fix X", "* Fix X") and bare sentences.
 * Returns each item as a plain string (no prefix).
 * Exported for testing.
 */
export function extractChecklistItems(comment: string): string[] {
  const trimmed = comment.trim();
  if (!trimmed) return [];

  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Numbered list: "1. item", "1) item"
  const numberedLines = lines.filter((l) => /^\d+[.)]\s/.test(l));
  if (numberedLines.length > 0) {
    return numberedLines.map((l) => l.replace(/^\d+[.)]\s+/, "").trim());
  }

  // Bullet list: "- item", "* item", "• item"
  const bulletLines = lines.filter((l) => /^[-*•]\s/.test(l));
  if (bulletLines.length > 0) {
    return bulletLines.map((l) => l.replace(/^[-*•]\s+/, "").trim());
  }

  // Single line — split on sentence boundaries
  if (lines.length === 1) {
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 1) return sentences;
    return [trimmed];
  }

  // Multi-line paragraph — treat each line as an item
  return lines;
}

/**
 * Build a structured PR feedback dispatch message for an agent.
 *
 * Given the change-request review comment and the PR diff, returns a message
 * that the orchestrator can dispatch as a task to the agent.  The message
 * includes:
 *   - A `- [ ] item` GitHub task-list checklist of every requested change
 *   - Relevant diff context (capped to ~6 KB to stay readable)
 *
 * Exported for testing.
 */
export function buildFeedbackTaskMessage(opts: {
  repo: string;
  prNumber: number;
  prTitle: string;
  prBranch: string;
  reviewComment: string;
  diff: string;
}): string {
  const { repo, prNumber, prTitle, prBranch, reviewComment, diff } = opts;

  const items = extractChecklistItems(reviewComment);
  const checklist =
    items.length > 0
      ? items.map((item) => `- [ ] ${item}`).join("\n")
      : `- [ ] ${reviewComment.trim() || "Address reviewer feedback"}`;

  const MAX_DIFF_CHARS = 6_000;
  const diffTrimmed =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)`
      : diff;

  const lines: string[] = [
    `PR #${prNumber} (${repo}) needs changes before it can merge.`,
    `Branch: \`${prBranch}\`  Title: ${prTitle}`,
    ``,
    `## Requested changes`,
    ``,
    checklist,
    ``,
    `Address every item above, then push to the same branch (\`${prBranch}\`).`,
    `The reviewer will pick up the updated PR automatically.`,
  ];

  if (diffTrimmed.trim()) {
    lines.push(``, `## Diff context`, ``, `\`\`\`diff`, diffTrimmed, `\`\`\``);
  }

  return lines.join("\n");
}

/**
 * Ensure a request-changes comment is a numbered markdown checklist.
 * Exported for testing.
 */
export function enforceChecklist(comment: string): string {
  const trimmed = comment.trim();
  if (!trimmed) return trimmed;

  if (/^\d+[.)]\s/m.test(trimmed)) return trimmed;

  const lines = trimmed
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 1) {
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length > 1) {
      return sentences.map((s, i) => `${i + 1}. ${s}`).join("\n");
    }
    return `1. ${trimmed}`;
  }

  return lines
    .map((line, i) => {
      const stripped = line.replace(/^[-*•]\s*/, "");
      return `${i + 1}. ${stripped}`;
    })
    .join("\n");
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
