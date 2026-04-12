import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { unlinkSync } from "node:fs";
import { ReviewerClient } from "../client/reviewer-client.js";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { StateStore, type MergeQueueEntry, type DiffShape, type WriteAntibodyLogParams } from "../state/store.js";
import { Deployer } from "./deployer.js";
import { extractIssueNumberFromBranch, findMatchingIssueNumber } from "./pr-creator.js";
import { notifyOperator } from "../service/notify.js";
import { extractCrossRepoIssueRefs } from "../service/daemon.js";
import {
  getAndRecordPatterns,
  buildPatternsBlock,
  recordFirstPassSaves,
  seedDefaultPatterns,
} from "./learned-patterns.js";

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

export type { PRReviewResult } from "../client/reviewer-client.js";
import type { PRReviewResult } from "../client/reviewer-client.js";

export class PRReviewer {
  private log = createLogger("pr-reviewer");
  private deployer: Deployer;
  private store: StateStore;
  private reviewerClient: ReviewerClient;

  /**
   * In-memory counter tracking how many times each PR has been escalated due
   * to unresolvable merge conflicts (auto-rebase failed or no local repo).
   * Key: "repo#prNumber", value: consecutive conflict escalation count.
   * Resets on daemon restart — acceptable since a few extra cycles before
   * re-hitting the threshold is harmless.
   */
  private conflictEscalationCount = new Map<string, number>();

  constructor(private config: OrchestratorConfig, store?: StateStore, reviewerClient?: ReviewerClient) {
    this.deployer = new Deployer(config);
    this.store = store ?? new StateStore();
    this.reviewerClient = reviewerClient ?? new ReviewerClient(config);
  }

  async reviewPR(repo: string, prNumber: number): Promise<PRReviewResult> {
    const pr = this.fetchPRInfo(repo, prNumber);
    this.log.info("Reviewing PR", { repo, prNumber, title: pr.title, filesChanged: pr.files_changed, mergeable: pr.mergeable });

    // Session identity sanity check: when parallel subtask execution is active, multiple
    // agents may submit PRs from forked sessions sharing a common conversation_id prefix.
    // A branch/author mismatch is a signal that a session may have been hijacked or
    // mis-routed.  We log a warning but never block the review — this is observability only.
    this.checkSessionIdentity(repo, prNumber, pr);

    // Pre-review rebase: attempt to keep the branch current with origin/main before evaluating
    // code quality. This covers two scenarios:
    //   1. CONFLICTING — the branch has actual merge conflicts; rebase or escalate.
    //   2. MERGEABLE/UNKNOWN — the branch may be stale (behind main); proactively rebase so
    //      reviews reflect the current codebase. Best-effort: always continue to review.
    const localPath = this.findLocalRepoPath(repo);

    if (pr.mergeable === "CONFLICTING") {
      if (localPath) {
        this.log.info("PR has merge conflicts, attempting auto-rebase", {
          repo,
          prNumber,
          branch: pr.branch,
          localPath,
        });
        const rebaseOutcome = this.tryAutoRebase(localPath, pr.branch);
        if (rebaseOutcome === "success") {
          this.log.info("Auto-rebase succeeded — continuing with review", {
            repo,
            prNumber,
            branch: pr.branch,
          });
          // Fall through to normal review — the branch is now rebased onto main
        } else {
          // Rebase failed — escalate instead of dispatching a rebase task to the agent
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
        // No local repo path found — escalate rather than dispatch a rebase task
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
    } else if (localPath) {
      // Proactive rebase for stale branches (behind main but not yet CONFLICTING).
      // This prevents slow accumulation of lag that eventually causes conflicts.
      // Always continue to review regardless of outcome — this is best-effort.
      const rebaseOutcome = this.tryAutoRebase(localPath, pr.branch);
      this.log.info("Proactive pre-review rebase", {
        repo,
        prNumber,
        branch: pr.branch,
        outcome: rebaseOutcome,
      });
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
          await this.executeDecision(repo, prNumber, result, undefined, pr);
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
        await this.executeDecision(repo, prNumber, result, undefined, pr);
        return result;
      }
    }

    // Escalate after too many review rounds instead of endlessly requesting changes.
    // The ceiling is configurable via agents.yaml: pr_review.feedback_ceiling (default: 3).
    const reviewCeiling = this.config.pr_review?.feedback_ceiling ?? 3;
    const priorReviews = this.countPriorReviews(repo, prNumber);
    if (priorReviews >= reviewCeiling) {
      const result: PRReviewResult = {
        decision: "escalate",
        comment: `This PR has gone through ${priorReviews} revision rounds without merging — escalating to human review.`,
        reason: `${priorReviews} revision rounds without merging — escalating to break the loop`,
      };
      this.log.info("PR review cycle cap reached, escalating", { repo, prNumber, priorReviews, reviewCeiling });
      await this.executeDecision(repo, prNumber, result, undefined, pr);
      return result;
    }

    // Diff size safety check
    const DIFF_WARN_THRESHOLD = 80_000;   // 80 KB — warn LLM that diff is truncated
    const DIFF_ESCALATE_THRESHOLD = 200_000; // 200 KB — auto-escalate, too large to review safely
    const diffSize = pr.diff.length;

    if (diffSize > DIFF_ESCALATE_THRESHOLD) {
      // Skip size check for bootstrap PRs (first PR on a repo with no merged PRs yet)
      const isBootstrap = this.isBootstrapPR(repo);
      if (!isBootstrap) {
        const result: PRReviewResult = {
          decision: "escalate",
          comment: `This PR's diff is ${Math.round(diffSize / 1024)} KB, which exceeds the safe review limit (200 KB). Automated review would only see a small fraction of the changes and could give false confidence. Escalating to human review.`,
          reason: `Diff too large for automated review (${Math.round(diffSize / 1024)} KB > 200 KB threshold)`,
        };
        this.log.warn("PR diff too large — auto-escalating", { repo, prNumber, diffSize });
        await this.executeDecision(repo, prNumber, result, undefined, pr);
        return result;
      }
      this.log.info("Large diff allowed — bootstrap PR on new repo", { repo, prNumber, diffSize });
    }

    const diffTruncated = diffSize > DIFF_WARN_THRESHOLD;
    const truncatedDiff = pr.diff.slice(0, 100_000);
    const diffWarning = diffTruncated
      ? `\n\n> ⚠️ **TRUNCATED DIFF WARNING**: The full diff is ${Math.round(diffSize / 1024)} KB but only the first ~${Math.round(truncatedDiff.length / 1024)} KB is shown here. Your review is INCOMPLETE — you have not seen all the changes. Factor this into your decision: note in your comment which files/areas you could not review, and consider escalating if the unseen portion looks significant based on file names or context.`
      : "";

    // ── Immune system: inject known anti-patterns into the review prompt ──────
    // Seed defaults on first run (idempotent), then fetch active patterns.
    seedDefaultPatterns(this.store);
    const patterns = getAndRecordPatterns(this.store, repo);
    const patternsBlock = buildPatternsBlock(patterns);
    const patternIds = patterns.map((p) => p.id);

    const prompt =
      `## PR #${pr.number}: ${pr.title}\n` +
      `**Repo:** ${pr.repo}\n` +
      `**Author:** ${pr.author}\n` +
      `**Branch:** ${pr.branch}\n` +
      `**Files changed:** ${pr.files_changed}` +
      diffWarning +
      patternsBlock +
      `\n\n### Description\n${pr.body}\n\n### Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

    if (patterns.length > 0) {
      this.log.debug("Injected learned patterns into review prompt", { repo, prNumber, patternCount: patterns.length });
    }

    try {
      const result = await this.reviewerClient.reviewPRDiff(prompt);
      this.log.info("PR review complete", { repo, prNumber, decision: result.decision, reason: result.reason });

      // Record first-pass save when PR is approved with no prior review rounds.
      // This measures how often the immune-system injection prevents a rejection.
      if (result.decision === "approve" && priorReviews === 0 && patternIds.length > 0) {
        recordFirstPassSaves(this.store, patternIds);
      }

      // Execute the decision — pass branch so approve can enqueue without an extra API call.
      // Pass the full PRInfo so executeDecision can log a rich diff shape to the antibody log.
      await this.executeDecision(repo, prNumber, result, pr.branch, pr);

      return result;
    } catch (err) {
      this.log.error("PR review failed", { repo, prNumber, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async reviewOpenPRs(repo: string): Promise<Array<{ prNumber: number; result: PRReviewResult; prBody: string; prBranch: string; prDiff: string }>> {
    const results: Array<{ prNumber: number; result: PRReviewResult; prBody: string; prBranch: string; prDiff: string }> = [];

    const prs = this.fetchOpenPRs(repo);
    for (const pr of prs) {
      try {
        const result = await this.reviewPR(repo, pr.number);
        // Fetch diff only for request-changes decisions — used to build structured
        // feedback context (flagged files + relevant hunks) without paying the cost
        // for approve/escalate decisions where the diff is not dispatched to the agent.
        let prDiff = "";
        if (result.decision === "request-changes") {
          try {
            prDiff = execSync(
              `gh pr diff ${pr.number} --repo ${repo}`,
              { encoding: "utf-8", timeout: 30000 },
            );
          } catch {
            // Non-fatal — feedback message degrades gracefully without diff context
          }
        }
        results.push({ prNumber: pr.number, result, prBody: pr.body, prBranch: pr.branch, prDiff });
      } catch {
        // Continue reviewing other PRs
      }
    }

    return results;
  }

  /**
   * Session identity sanity check — observability-only, never blocks review.
   *
   * When parallel subtask execution is active, multiple agents submit PRs from
   * forked sessions that share a common `conversation_id` prefix.  A mismatch
   * between a PR's branch naming convention and its author is a signal that a
   * session may have been hijacked or mis-routed by the proxy.
   *
   * Convention: agent branches follow `issue-N-<slug>` and are authored by the
   * agent's GitHub identity (e.g. `rapartlu` acting on behalf of the agent, or
   * the agent's own bot account).  We warn when:
   *   - The branch looks like an agent branch (`issue-\d+-`) but the author is
   *     not a recognised agent account.
   *   - Two distinct agent accounts have recently opened PRs on branches with
   *     the same `issue-N` prefix (possible session collision).
   */
  private checkSessionIdentity(repo: string, prNumber: number, pr: PRInfo): void {
    // Branch naming check: agent branches always start with "issue-<N>-"
    const agentBranchRe = /^issue-(\d+)-/;
    const branchMatch = pr.branch.match(agentBranchRe);

    if (!branchMatch) {
      // Not an agent-style branch — no identity check needed
      return;
    }

    const issueNum = branchMatch[1];

    // Warn if two open PRs share the same issue-N prefix (potential session collision)
    try {
      const raw = execSync(
        `gh pr list --repo ${repo} --state open --json number,headRefName,author --limit 50`,
        { encoding: "utf-8", timeout: 10000 },
      );
      const openPRs = JSON.parse(raw) as Array<{ number: number; headRefName: string; author: { login: string } }>;
      const siblings = openPRs.filter(
        (p) => p.number !== prNumber && p.headRefName.startsWith(`issue-${issueNum}-`),
      );
      if (siblings.length > 0) {
        this.log.warn("Session identity: multiple open PRs share the same issue prefix — possible parallel session collision", {
          repo,
          prNumber,
          branch: pr.branch,
          issuePrefix: `issue-${issueNum}-`,
          siblingPRs: siblings.map((p) => ({ number: p.number, branch: p.headRefName, author: p.author.login })),
        });
      }
    } catch {
      // gh call is best-effort — never fail the review over this
    }
  }

  /**
   * Compute a lightweight DiffShape summary from a PRInfo for antibody log storage.
   * Extensions and directories are derived from the diff hunks' file headers.
   */
  private buildDiffShape(pr: PRInfo): DiffShape {
    const extensions = new Set<string>();
    const directories = new Set<string>();

    // Parse file paths from unified diff headers: lines starting with "+++ b/…"
    for (const line of pr.diff.split("\n")) {
      const m = line.match(/^\+{3} b\/(.+)$/);
      if (m) {
        const filePath = m[1];
        const dotIdx = filePath.lastIndexOf(".");
        if (dotIdx !== -1) extensions.add(filePath.slice(dotIdx));
        const slashIdx = filePath.lastIndexOf("/");
        if (slashIdx !== -1) {
          // Keep only the top two path segments for grouping
          const parts = filePath.split("/");
          directories.add(parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
        }
      }
    }

    const extArr = Array.from(extensions);
    const dirArr = Array.from(directories);
    const schemaKeywords = ["migration", "schema", "state.db", "store.ts"];
    const testKeywords = [".test.", ".spec.", "__tests__"];

    return {
      files_changed: pr.files_changed,
      diff_size_bytes: pr.diff.length,
      extensions: extArr,
      directories: dirArr,
      touches_schema: extArr.some((e) => schemaKeywords.some((k) => e.includes(k))) ||
        dirArr.some((d) => schemaKeywords.some((k) => d.includes(k))) ||
        pr.diff.includes("CREATE TABLE") || pr.diff.includes("ALTER TABLE"),
      touches_tests: extArr.some((e) => testKeywords.some((k) => e.includes(k))) ||
        dirArr.some((d) => testKeywords.some((k) => d.includes(k))),
    };
  }

  private async executeDecision(
    repo: string,
    prNumber: number,
    result: PRReviewResult,
    prBranch?: string,
    pr?: PRInfo,
  ): Promise<void> {
    switch (result.decision) {
      case "approve":
        try {
          // Fetch branch name if not provided
          const branch = prBranch ?? this.fetchPRBranch(repo, prNumber);

          // Skip if already in queue to avoid duplicate enqueues
          if (this.store.isPRInMergeQueue(repo, prNumber)) {
            this.log.info("PR already in merge queue, skipping re-enqueue", { repo, prNumber });
            break;
          }

          // Enqueue instead of merging immediately — the merge queue processes one at a time
          const entry = this.store.queuePRForMerge(repo, prNumber, branch);
          const queueSize = this.store.getMergeQueue(repo).length;
          const positionMsg = entry.position === 0
            ? "next in queue"
            : `position ${entry.position + 1} of ${queueSize} in queue`;

          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Approved** ✅\n\n${result.comment}\n\n---\n🔀 Added to merge queue (${positionMsg}). PRs merge sequentially to avoid branch conflicts.`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR approved and added to merge queue", { repo, prNumber, position: entry.position });
          this.store.recordPRReview(repo, prNumber, "approve");
        } catch (err) {
          this.log.error("Failed to approve/enqueue PR", { repo, prNumber, error: String(err) });
        }
        break;

      case "request-changes":
        try {
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Changes Requested**\n\n${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR changes requested", { repo, prNumber });
          this.store.recordPRReview(repo, prNumber, "request-changes");
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
          this.store.recordPRReview(repo, prNumber, "escalate");
          // Notify operator via Telegram
          notifyOperator(
            `PR #${prNumber} escalated`,
            `${repo}#${prNumber}: ${result.reason}`,
            "warning",
            `escalate:${repo}#${prNumber}`,
          ).catch(() => {});

        } catch (err) {
          this.log.error("Failed to escalate PR", { repo, prNumber, error: String(err) });
        }
        break;

      case "error":
        // Review LLM call failed (timeout, parse failure, rate limit).
        // Don't escalate to human — just skip. The PR will be re-reviewed
        // on the next cycle when the reviewer may have recovered.
        this.log.warn("PR review skipped due to LLM error — will retry next cycle", {
          repo,
          prNumber,
          reason: result.reason,
        });
        break;
    }

    // ── Antibody log: record every non-error decision as a structured entry ────
    // Errors are skipped — they represent LLM failures, not reviewer judgements.
    if (result.decision !== "error") {
      try {
        const diffShape: DiffShape = pr
          ? this.buildDiffShape(pr)
          : {
              files_changed: 0,
              diff_size_bytes: 0,
              extensions: [],
              directories: [],
              touches_schema: false,
              touches_tests: false,
            };

        this.store.recordAntibodyEntry({
          repo,
          pr_number: prNumber,
          diff_shape: diffShape,
          decision: result.decision as WriteAntibodyLogParams["decision"],
          reason: result.reason ?? undefined,
          agent: pr?.author ?? undefined,
        });
      } catch (err) {
        // Non-fatal — antibody logging must never block review operations
        this.log.warn("Failed to record antibody log entry", { repo, prNumber, error: String(err) });
      }
    }
  }

  /**
   * Expose escalation as a public method so the daemon's dispatch loop can trigger it
   * directly when the feedback ceiling is hit (without going through the full review flow).
   */
  async escalatePR(repo: string, prNumber: number, reason: string): Promise<void> {
    const result: PRReviewResult = {
      decision: "escalate",
      comment: reason,
      reason,
    };
    this.log.info("Escalating PR via public escalatePR()", { repo, prNumber, reason });
    await this.executeDecision(repo, prNumber, result);
  }

  /**
   * Returns the number of consecutive conflict escalations recorded for a PR
   * (in-memory — resets on daemon restart).
   */
  getConflictEscalationCount(repo: string, prNumber: number): number {
    return this.conflictEscalationCount.get(`${repo}#${prNumber}`) ?? 0;
  }

  /**
   * Clears the conflict escalation counter for a PR (called after auto-close
   * so the same branch/issue pair doesn't immediately re-trigger).
   */
  resetConflictEscalation(repo: string, prNumber: number): void {
    this.conflictEscalationCount.delete(`${repo}#${prNumber}`);
  }

  /**
   * Auto-close a persistently conflicting PR and delete its branch.
   * Posts an explanatory comment before closing so the history is clear.
   * Returns true on success, false if any step failed.
   */
  autoCloseConflictingPR(repo: string, prNumber: number, branch: string, conflictCount: number): boolean {
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
      this.log.error("Failed to post auto-close comment on conflicting PR", { repo, prNumber, error: String(err) });
      // Continue — still try to close
    }

    try {
      execSync(
        `gh pr close ${prNumber} --repo ${repo} --delete-branch`,
        { encoding: "utf-8", timeout: 30000 },
      );
      this.log.info("Auto-closed persistently conflicting PR and deleted branch", { repo, prNumber, branch, conflictCount });
      this.store.recordPRReview(repo, prNumber, "escalate"); // Record close as escalate for metrics
      return true;
    } catch (err) {
      this.log.error("Failed to auto-close conflicting PR", { repo, prNumber, branch, error: String(err) });
      // Branch deletion may have failed independently — try explicitly
      try {
        execSync(
          `gh api repos/${repo}/git/refs/heads/${branch} -X DELETE`,
          { encoding: "utf-8", timeout: 15000 },
        );
        this.log.info("Deleted conflicting branch via API after PR close failed", { repo, branch });
      } catch {
        // Best-effort — log and move on
        this.log.warn("Could not delete conflicting branch", { repo, branch });
      }
      return false;
    }
  }

  private countPriorReviews(repo: string, prNumber: number): number {
    try {
      // Count specifically "Changes Requested" review comments — not approvals or escalations.
      // Approvals cause the PR to be merged (no more reviews), so in practice we only want
      // to count the change-request rounds that are keeping the feedback loop alive.
      const raw = execSync(
        `gh api "repos/${repo}/issues/${prNumber}/comments?per_page=100" --jq '[.[] | select(.body | contains("[orchestrator] PR Review — Changes Requested"))] | length'`,
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

  /**
   * Return the current merge queue entries for display.
   * Pass repo to restrict to a single repo, or omit for all repos.
   */
  getMergeQueue(repo?: string): MergeQueueEntry[] {
    return this.store.getMergeQueue(repo);
  }

  /**
   * Sweep all open PRs across agent repos and add any that have an
   * orchestrator approval comment (and no newer change-request comment)
   * into the merge queue.
   *
   * This catches PRs approved in prior cycles that were never queued —
   * e.g. because the merge queue was introduced after the approval, or
   * because a transient error dropped the enqueue step.
   *
   * Skips PRs that are already queued, have an active change-request, or
   * have merge conflicts.
   *
   * Returns the number of PRs newly added to the queue.
   */
  async sweepApprovedPRsIntoQueue(): Promise<number> {
    let added = 0;

    for (const [, agent] of Object.entries(this.config.agents)) {
      if (!agent.github) continue;

      let openPRs: Array<{ number: number; headRefName: string; title: string; mergeable: string }>;
      try {
        const raw = execSync(
          `gh pr list --repo ${agent.github} --state open --json number,headRefName,title,mergeable`,
          { encoding: "utf-8", timeout: 15000 },
        );
        openPRs = JSON.parse(raw.trim() || "[]") as typeof openPRs;
      } catch {
        continue;
      }

      for (const pr of openPRs) {
        // Already handled by the queue — nothing to do
        if (this.store.isPRInMergeQueue(agent.github, pr.number)) continue;

        // Fetch the most recent orchestrator review comment on this PR
        let latestReviewBody: string | null;
        try {
          const raw = execSync(
            `gh pr view ${pr.number} --repo ${agent.github} --json comments ` +
            `--jq '[.comments[] | select(.body | startswith("**[orchestrator] PR Review"))] | last | .body'`,
            { encoding: "utf-8", timeout: 15000 },
          );
          const trimmed = raw.trim();
          latestReviewBody = trimmed === "" || trimmed === "null" ? null : trimmed;
        } catch {
          continue;
        }

        if (!latestReviewBody) continue;

        // Only enqueue when the latest orchestrator comment is an approval
        // (not a change request or escalation)
        const isApproved = latestReviewBody.includes("PR Review — Approved");
        if (!isApproved) continue;

        // Don't enqueue conflicting PRs — they need manual resolution first
        if (pr.mergeable === "CONFLICTING") {
          this.log.info("Sweep: approved PR has merge conflicts, skipping auto-queue", {
            repo: agent.github,
            prNumber: pr.number,
          });
          continue;
        }

        const entry = this.store.queuePRForMerge(agent.github, pr.number, pr.headRefName);
        this.log.info("Sweep: approved PR added to merge queue", {
          repo: agent.github,
          prNumber: pr.number,
          branch: pr.headRefName,
          position: entry.position,
        });

        // Post a comment so the PR author knows it was picked up
        try {
          execSync(
            `gh pr comment ${pr.number} --repo ${agent.github} --body ` +
            shellEscape(
              `**[orchestrator] Auto-merge sweep** 🔀\n\n` +
              `This PR was previously approved and has been added to the merge queue ` +
              `(position ${entry.position + 1}). It will be merged automatically.`,
            ),
            { encoding: "utf-8", timeout: 30000 },
          );
        } catch {
          // Best-effort comment — don't fail the sweep
        }

        added++;
      }
    }

    return added;
  }

  /**
   * Process the merge queue: dequeue one PR at a time, merge it, then rebase
   * remaining queued branches onto the new main so they don't conflict.
   *
   * Called by the daemon each cycle.  For each repo, we take the next queued PR,
   * attempt a squash merge, mark it merged, then rebase all remaining queued
   * branches for that repo so they stay current.
   */
  async processMergeQueue(): Promise<void> {
    // Build set of repos that have queued PRs
    const queue = this.store.getMergeQueue();
    if (queue.length === 0) return;

    const repos = [...new Set(queue.map((e) => e.repo))];

    for (const repo of repos) {
      // Skip if there's already a merge in progress for this repo
      const repoQueue = this.store.getMergeQueue(repo);
      const merging = repoQueue.find((e) => e.status === "merging");
      if (merging) {
        // A merge was started last cycle — check if the PR is now merged/closed
        const isOpen = this.isPROpen(repo, merging.pr_number);
        if (!isOpen) {
          // It's been merged (or closed) — mark completed and continue
          this.store.markQueuedPRMerged(repo, merging.pr_number);
          this.log.info("Queued PR merge completed (detected closed)", { repo, prNumber: merging.pr_number });
          this.closeCrossRepoIssuesForPR(repo, merging.pr_number);
          await this.rebaseRemainingQueue(repo, merging.branch);
          await this.restartAgentsForRepo(repo);
        } else {
          // Still in progress — wait for next cycle
          this.log.info("Merge still in progress, waiting", { repo, prNumber: merging.pr_number });
        }
        continue;
      }

      const next = repoQueue.find((e) => e.status === "queued");
      if (!next) continue;

      // Verify PR is still open before attempting merge
      if (!this.isPROpen(repo, next.pr_number)) {
        this.log.info("Queued PR is no longer open, removing from queue", { repo, prNumber: next.pr_number });
        this.store.removeFromMergeQueue(repo, next.pr_number);
        continue;
      }

      // Mark as merging and attempt the squash merge
      this.store.markQueuedPRMerging(repo, next.pr_number);
      this.log.info("Processing merge queue: merging PR", { repo, prNumber: next.pr_number, branch: next.branch });

      try {
        execSync(
          `gh pr merge ${next.pr_number} --repo ${repo} --squash --delete-branch`,
          { encoding: "utf-8", timeout: 60000 },
        );
        this.store.markQueuedPRMerged(repo, next.pr_number);
        this.log.info("Merge queue: PR merged successfully", { repo, prNumber: next.pr_number });

        // Close cross-repo issues referenced in the merged PR body
        this.closeCrossRepoIssuesForPR(repo, next.pr_number);

        // Rebase remaining queued branches now that main has advanced
        await this.rebaseRemainingQueue(repo, next.branch);
        await this.restartAgentsForRepo(repo);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.store.markQueuedPRFailed(repo, next.pr_number, errMsg);
        this.log.error("Merge queue: PR merge failed", { repo, prNumber: next.pr_number, error: errMsg });
        // Post a comment so the agent knows the merge failed
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

  /**
   * After a PR is merged, fetch its body and close any cross-repo issue references.
   *
   * GitHub only auto-closes issues within the same repo. When an agent's PR in
   * repo A contains "Closes owner/repoB#123", that issue stays open. This method
   * detects those references and explicitly closes them via the GitHub API.
   */
  private closeCrossRepoIssuesForPR(prRepo: string, prNumber: number): void {
    try {
      const prBodyRaw = execSync(
        `gh pr view ${prNumber} --repo ${prRepo} --json body -q .body`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (!prBodyRaw) return;

      const crossRefs = extractCrossRepoIssueRefs(prBodyRaw);
      for (const ref of crossRefs) {
        const targetRepo = `${ref.owner}/${ref.repo}`;
        // Skip same-repo refs — GitHub handles those natively
        if (targetRepo === prRepo) continue;

        try {
          // Verify the issue is still open
          const state = execSync(
            `gh issue view ${ref.number} --repo ${targetRepo} --json state -q .state`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          if (state !== "OPEN") continue;

          const comment = `Auto-closed by orchestrator: referenced in merged PR ${prRepo}#${prNumber}.`;
          execSync(
            `gh issue close ${ref.number} --repo ${targetRepo} --comment "${comment}"`,
            { encoding: "utf-8", timeout: 10000 },
          );
          this.log.info("Cross-repo issue closed post-merge", {
            targetRepo,
            issueNumber: ref.number,
            sourcePR: `${prRepo}#${prNumber}`,
          });
        } catch {
          // Best effort — target repo may not be accessible
        }
      }
    } catch {
      // Best effort — PR may no longer be fetchable
    }
  }

  /**
   * After a successful merge, rebase all remaining queued PRs for the repo
   * onto the new main so they stay conflict-free.
   */
  private async rebaseRemainingQueue(repo: string, justMergedBranch: string): Promise<void> {
    const localPath = this.findLocalRepoPath(repo);
    if (!localPath) {
      this.log.warn("Cannot rebase queued branches: no local repo path found", { repo });
      return;
    }

    const remaining = this.store.getMergeQueue(repo).filter((e) => e.branch !== justMergedBranch);
    if (remaining.length === 0) return;

    this.log.info("Rebasing remaining queued branches after merge", { repo, count: remaining.length });

    for (const entry of remaining) {
      try {
        const outcome = this.tryAutoRebase(localPath, entry.branch);
        this.log.info("Rebase of queued branch", { repo, branch: entry.branch, outcome });
        if (outcome === "failed") {
          // Remove from queue and notify — can't safely merge if rebase fails
          this.store.markQueuedPRFailed(repo, entry.pr_number, "Rebase onto new main failed after previous merge");
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
        this.log.error("Error rebasing queued branch", { repo, branch: entry.branch, error: String(err) });
      }
    }
  }

  /** Fetch only the branch name for a PR without pulling the full diff. */
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
      // Fail-safe: if we can't verify the state, don't dispatch
      this.log.warn("Could not verify PR state, skipping feedback dispatch", { repo, prNumber });
      return false;
    }
  }

  /**
   * Find the local filesystem path for a GitHub repo slug (owner/repo).
   * Checks agent configs first, then falls back to inspecting the orchestrator's
   * own git remote. Returns null when no local path is known.
   */
  /**
   * Check if a repo has no merged PRs yet (first PR = bootstrap).
   * Bootstrap PRs are exempt from the large-diff escalation threshold.
   */
  private isBootstrapPR(repo: string): boolean {
    try {
      const raw = execSync(
        `gh pr list --repo ${repo} --state merged --json number -L 1`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      const merged = JSON.parse(raw) as Array<{ number: number }>;
      return merged.length === 0;
    } catch {
      return false; // fail-closed: assume not bootstrap
    }
  }

  private findLocalRepoPath(repo: string): string | null {
    // Match agent repos by their github field
    for (const agent of Object.values(this.config.agents)) {
      if (agent.github === repo) {
        const candidate = resolve(this.config.base_dir, agent.dir);
        // Validate it's actually a git repo
        try {
          execSync("git rev-parse --git-dir", { cwd: candidate, encoding: "utf-8", timeout: 5000 });
          return candidate;
        } catch {
          this.log.warn("Agent repo path is not a valid git repo", { repo, path: candidate });
          continue;
        }
      }
    }
    // Check if the orchestrator's own repo matches
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

  /**
   * Attempt to rebase the given branch onto origin/main in a local repo directory.
   * Saves and restores the current branch regardless of outcome.
   * Returns:
   *   'up-to-date' — branch was already current with origin/main, nothing to do
   *   'success'    — rebase completed and changes were pushed
   *   'failed'     — rebase had conflicts or another git error prevented completion
   */
  private tryAutoRebase(localPath: string, branch: string): "success" | "up-to-date" | "failed" {
    // Build git env with credentials from config
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.config.proxy.ssh_key) {
      const sshKeyPath = this.config.proxy.ssh_key.replace(/^~/, process.env.HOME ?? "");
      env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no`;
    }
    env.GIT_TERMINAL_PROMPT = "0";

    const opts = { cwd: localPath, encoding: "utf-8" as const, env };
    let currentBranch = "main";

    try {
      // Clean stale git state that blocks future operations
      try { execSync("git rebase --abort", { ...opts, timeout: 5000 }); } catch { /* no rebase in progress */ }
      try { unlinkSync(resolve(localPath, ".git/index.lock")); } catch { /* no lock file */ }
      try { execSync("git stash --include-untracked", { ...opts, timeout: 10000 }); } catch { /* nothing to stash */ }

      currentBranch =
        execSync("git rev-parse --abbrev-ref HEAD", { ...opts, timeout: 10000 }).trim() || "main";

      execSync("git fetch origin", { ...opts, timeout: 30000 });
      execSync(`git checkout ${branch}`, { ...opts, timeout: 15000 });

      // Rebase step — separate try-catch so push failure doesn't abort the rebase
      try {
        const rebaseOutput = execSync("git rebase origin/main", { ...opts, timeout: 60000 });
        if (rebaseOutput.includes("is up to date")) {
          return "up-to-date";
        }
      } catch {
        try { execSync("git rebase --abort", { ...opts, timeout: 10000 }); } catch { /* ignore */ }
        return "failed";
      }

      // Push step — if this fails, the rebase succeeded but push didn't. Don't abort.
      try {
        execSync(`git push --force-with-lease origin ${branch}`, { ...opts, timeout: 30000 });
        return "success";
      } catch (err) {
        this.log.warn("Rebase succeeded but push failed — will retry next cycle", {
          localPath, branch, error: err instanceof Error ? err.message : String(err),
        });
        return "failed";
      }
    } catch (err) {
      this.log.warn("Auto-rebase git error", {
        localPath, branch, error: err instanceof Error ? err.message : String(err),
      });
      return "failed";
    } finally {
      // Restore original branch (best-effort)
      try {
        execSync(`git checkout ${currentBranch}`, { ...opts, timeout: 10000 });
      } catch { /* ignore */ }
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

  private fetchOpenPRs(repo: string): Array<{ number: number; title: string; body: string; branch: string }> {
    const output = execSync(
      `gh pr list --repo ${repo} --state open --json number,title,body,headRefName`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const prs = JSON.parse(output) as Array<{ number: number; title: string; body?: string; headRefName?: string }>;
    return prs.map((pr) => ({ ...pr, body: pr.body ?? "", branch: pr.headRefName ?? "" }));
  }

}

// Re-export enforceChecklist from the reviewer client for backward compatibility
export { enforceChecklist } from "../client/reviewer-client.js";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
