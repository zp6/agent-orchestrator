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
import { fileURLToPath } from "node:url";
import { unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { buildCachedSystemContent, createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore, IStandupHealthStore, MergeQueueEntry, ReviewCategory } from "../state/types.js";
import { isExampleOrTemplateFile as isExampleOrTemplateFileFromConfig } from "../config/security-allowlist.js";
import {
  detectSchemaChanges,
  detectSchemaContractDrift,
  extractChangedFilesFromDiff,
  buildSchemaImpactNotice,
  buildDownstreamImpactSection,
  validateStoreSchemaAgainstContract,
  loadSchemaContractRegistry,
  type SchemaImpactHit,
} from "./schema-impact.js";
import {
  isStandupIssue,
  extractActionItemCount,
  handleZeroActionStandup,
  type GitHubIssue,
} from "./standup-handler.js";
import { categoriseReviewComment } from "./pr-iteration-metrics.js";
import {
  checkPRScope,
  formatScopeViolationComment,
} from "./pr-scope-checker.js";

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

/**
 * Category for why a re-dispatch was triggered.  The orchestrator uses this
 * to build the dispatch-efficiency breakdown:
 *
 *   - `quality-revision`    — code review requested changes (normal feedback loop)
 *   - `conflict-redispatch` — PR closed due to persistent merge conflicts,
 *                             issue re-dispatched to agent for a fresh start
 *   - `conflict-escalation` — merge conflict could not be auto-resolved,
 *                             escalated to human
 *   - `stale-branch-nudge`  — branch was >48 h behind main; agent nudged to
 *                             rebase before opening a PR
 */
export type RedispatchCategory =
  | "quality-revision"
  | "conflict-redispatch"
  | "conflict-escalation"
  | "stale-branch-nudge"
  | null;

export interface PRReviewResult {
  decision: "approve" | "request-changes" | "escalate";
  comment: string;
  reason: string;
  /**
   * Reviewer confidence in the decision, as a 0.0–1.0 float.
   *
   * - 1.0 — very confident (clear approval or obvious blocking bug)
   * - 0.7 — reasonably confident (normal review)
   * - 0.5 — borderline (uncertain about impact or risk)
   * - < 0.7 — low confidence; supervisor should consider second-pass or spot-check
   *
   * Null when confidence is not available (e.g. conflict or parse failure paths).
   */
  confidence?: number | null;
  /**
   * Set to true when escalation is due to unresolvable merge conflicts.
   * The orchestrator daemon uses this flag to decide when to auto-close a
   * persistently conflicting PR and re-dispatch the linked issue.
   */
  conflictEscalation?: boolean;
  /**
   * Categorises the reason behind the review outcome so the orchestrator can
   * attribute the cycle cost: quality issue vs. merge conflict vs. stale branch.
   * Null when the review is a straightforward approve or first-time review.
   */
  redispatchCategory?: RedispatchCategory;
  /**
   * How many hours behind `origin/main` the branch was at the time of review.
   * The orchestrator uses this to surface a "conflict-prone branches" indicator
   * and to compute cycles lost to merge conflicts in the weekly summary.
   */
  branchStalenessHours?: number;
  /**
   * Set to true when a PR should be closed instead of merged.
   * Used for zero-action standup PRs that shouldn't appear in merge history.
   * When true, executeDecision will close the PR with an explanatory comment
   * instead of enqueueing it for merge.
   */
  shouldCloseInsteadOfMerge?: boolean;
  /**
   * Populated on `request-changes` decisions only. How urgent is the fix?
   *   - 'critical' — security vulnerability or data loss risk
   *   - 'major'    — runtime bug that will break functionality
   *   - 'minor'    — missing non-critical functionality
   * Null on approve/escalate or when the LLM did not supply the field.
   */
  severity?: "critical" | "major" | "minor" | null;
  /**
   * Populated on `request-changes` decisions only. What type of issue?
   *   - 'security'              — credential leak, injection, auth bypass
   *   - 'correctness'           — logic error, wrong output, crash
   *   - 'data-integrity'        — data loss, corruption, missing persistence
   *   - 'missing-functionality' — required feature not implemented
   * Null on approve/escalate or when the LLM did not supply the field.
   */
  category?: "security" | "correctness" | "data-integrity" | "missing-functionality" | null;
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

CREDENTIAL & SECRET DETECTION RULES:
Example and template files routinely contain intentional placeholder text that looks like a secret but is not. Apply these rules before flagging anything as a credential leak:

1. **Example/template files are never a security violation.** Files whose path contains '.example.', '.template.', '.sample.', 'example.', 'template.', 'sample.' (prefix), or that live under an 'examples/', 'templates/', or 'samples/' directory are documentation artifacts. Placeholder values in these files are expected and must NOT be flagged.

2. **Placeholder values are not real secrets.** The following patterns are definitionally safe — they are instructions to the user, not leaked credentials:
   - Generic labels: 'your-api-key-here', 'your-token', 'your-secret', 'YOUR_API_KEY', 'INSERT_KEY_HERE'
   - Common stand-ins: 'changeme', 'CHANGEME', 'REPLACE_ME', 'replace-me', 'xxx', 'XXX', 'todo', 'TODO'
   - Angle-bracket templates: '<your-key>', '<API_KEY>', '<token>'
   - Obvious fakes: '1234567890', 'abcdefghij', 'test-key', 'dummy', 'example-key'

3. **Only flag values that look like real, leaked credentials:** high-entropy random strings (20+ chars of mixed alphanumeric), values matching known API key formats (e.g. 'sk-...', 'ghp_...', 'AKIA...'), or values that appear to be copy-pasted real tokens based on their structure. When in doubt, approve.

SHELL INJECTION DETECTION RULES:
Template literals in exec/spawn calls are NOT automatically a security issue. Only flag shell injection when ALL THREE conditions are met simultaneously:

1. The interpolated value is externally controlled -- it comes from: user input, an HTTP request parameter, a GitHub API response field (branch name, PR title, commit message, author name, label, etc.), a file path from disk, or environment variable set by an untrusted source. Internally-defined constants, TypeScript enum values, hardcoded strings, numeric IDs, and boolean flags are NOT externally controlled.

2. The value is passed to a shell interpreter unescaped -- specifically: passed to exec(), execSync(), or child_process.exec() which interprets its argument through /bin/sh. Using spawn() or spawnSync() with an array of arguments (not a shell string) is safe regardless of escaping, because no shell is invoked.

3. No sanitization is applied -- the value is NOT wrapped in shellEscape(), shell-quote, shlex.quote(), or equivalent escaping. If shellEscape(value) wraps the interpolated variable, the call is safe.

SAFE patterns -- do NOT flag these:
- execSync with numeric prNumber or repo from internal config (numbers and internal state cannot be injected)
- execSync where the interpolated variable is wrapped in shellEscape()
- spawn('git', ['checkout', branch]) -- array form, no shell interpolation
- exec calls where all interpolated values are numbers, booleans, or string constants defined in the same file

GENUINELY BLOCKING -- flag with severity "critical", category "security":
- exec or execSync where a branch name, PR title, commit message, author name, or other GitHub API string is interpolated WITHOUT shellEscape()
- Any exec call taking direct HTTP request body fields (req.body.*, request.params.*, query.*) without escaping

When in doubt about whether a value is externally controlled, APPROVE and note the concern as a non-blocking suggestion. Do not block a PR based on the mere presence of template literals in exec calls.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "decision": "approve|request-changes|escalate",
  "comment": "Your review comment to post on the PR",
  "reason": "Brief internal reason for the decision",
  "confidence": 0.0,
  "severity": null,
  "category": null
}

The confidence field (required) is a 0.0-1.0 float reflecting your certainty:
- 0.9-1.0: very confident (obvious approval or clear blocking bug)
- 0.7-0.89: reasonably confident (standard review)
- 0.5-0.69: borderline (uncertain about scope, impact, or correctness)
- below 0.5: very uncertain (incomplete information, complex tradeoffs)

The severity and category fields are REQUIRED when decision is "request-changes", otherwise set them to null:
- severity: "critical" (security vulnerability or data loss risk) | "major" (runtime bug that breaks functionality) | "minor" (missing non-critical functionality)
- category: "security" (credential leak, injection, auth bypass) | "correctness" (logic error, wrong output, crash) | "data-integrity" (data loss, corruption, missing persistence) | "missing-functionality" (required feature not implemented)`;

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

/**
 * Aggregate conflict-related statistics exposed via `getConflictStats()`.
 * The orchestrator feeds these into the weekly summary and the dashboard's
 * dispatch-efficiency chart.
 */
export interface ConflictStats {
  /** Number of unique PRs that hit conflict escalation since last reset */
  totalConflictEscalations: number;
  /** Number of PRs auto-closed due to persistent conflicts */
  totalAutoClosedConflictPRs: number;
  /** Number of stale-branch nudges issued (branch >48 h behind main) */
  totalStaleBranchNudges: number;
  /** Per-repo breakdown of conflict escalation counts */
  perRepo: Record<string, { escalations: number; autoCloses: number; staleNudges: number }>;
}

export class PRReviewer {
  private log = createLogger("pr-reviewer");
  private conflictEscalationCount = new Map<string, number>();

  // ── Conflict tracking counters (for ConflictStats) ─────────────────────
  private conflictAutoCloseCount = new Map<string, number>();
  private staleBranchNudgeCount = new Map<string, number>();

  /**
   * Optional callback invoked after a PR merge so the orchestrator daemon can
   * restart the affected agents (e.g. docker restart). Defaults to a no-op.
   */
  private onAgentRestart: (repo: string) => Promise<void>;

  /** Threshold in hours before a branch is considered stale (default 48h). */
  private staleBranchThresholdHours: number;

  constructor(
    private config: ReviewerConfig,
    private store: IStateStore,
    opts: { onAgentRestart?: (repo: string) => Promise<void> } = {},
  ) {
    this.onAgentRestart = opts.onAgentRestart ?? (async () => {});
    this.staleBranchThresholdHours = config.pr_review?.stale_branch_threshold_hours ?? 48;
  }

  async reviewPR(repo: string, prNumber: number): Promise<PRReviewResult> {
    const pr = this.fetchPRInfo(repo, prNumber);

    // ── Zero-action standup check ─────────────────────────────────────────
    // If this PR is for a zero-action standup issue, handle it specially
    // (no PR review, just an acknowledgment comment on the associated issue).
    // Try branch name first, then fall back to PR body/title to handle
    // non-standard branch naming conventions (e.g. "standup-721-response").
    const standupIssueNumber = this.resolveIssueNumberForStandupCheck(pr);
    if (standupIssueNumber !== null) {
      const wasHandledAsStandup = await this.handleStandupIssueIfNeeded(repo, standupIssueNumber);
      if (wasHandledAsStandup) {
        // Zero-action standup was handled — close the PR instead of merging it
        this.log.info("Closing zero-action standup PR", {
          repo,
          prNumber,
          issueNumber: standupIssueNumber,
          branch: pr.branch,
        });
        const result: PRReviewResult = {
          decision: "approve",
          comment: "Auto-closed: no action items in this standup cycle. The associated standup issue has been acknowledged.",
          reason: "Zero-action standup — PR closed, issue acknowledged",
          shouldCloseInsteadOfMerge: true,
        };
        await this.executeDecision(repo, prNumber, result, pr.branch);
        return result;
      }
    }

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
            redispatchCategory: "conflict-escalation",
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
          redispatchCategory: "conflict-escalation",
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

    // ── Branch staleness check ─────────────────────────────────────────────
    const stalenessHours = this.measureBranchStaleness(repo, pr.branch);

    if (stalenessHours !== null && stalenessHours > this.staleBranchThresholdHours) {
      const repoKey = repo.split("/").pop() ?? repo;
      this.staleBranchNudgeCount.set(
        repoKey,
        (this.staleBranchNudgeCount.get(repoKey) ?? 0) + 1,
      );
      this.log.warn("Branch is stale — nudging agent to rebase", {
        repo,
        prNumber,
        branch: pr.branch,
        stalenessHours: Math.round(stalenessHours),
        thresholdHours: this.staleBranchThresholdHours,
      });
      // Post a nudge comment but don't block the review — the review
      // still proceeds normally.  The orchestrator can use branchStalenessHours
      // in the result to track cycles lost.
      try {
        execSync(
          `gh pr comment ${prNumber} --repo ${shellEscape(repo)} --body ${shellEscape(
            `**[orchestrator] Stale branch warning** ⚠️\n\n` +
            `This branch is ~${Math.round(stalenessHours)} hours behind \`main\`. ` +
            `Branches that drift for more than ${this.staleBranchThresholdHours}h are ` +
            `much more likely to hit merge conflicts.\n\n` +
            `Consider rebasing before pushing more commits:\n` +
            `\`\`\`\ngit fetch origin && git rebase origin/main && git push --force-with-lease\n\`\`\``,
          )}`,
          { encoding: "utf-8", timeout: 30000 },
        );
      } catch {
        // Best effort — don't fail the review for a nudge
      }
    }

    // ── PR body linter: all PRs must include "Closes #N" (issue #137) ───────
    if (!this.hasIssueRef(pr)) {
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

    // ── PR scope pre-flight (issue #358) ─────────────────────────────────
    // Run BEFORE the LLM review so we save the round-trip cost for bundled PRs.
    // Uses the full diff (not truncated) for reliable file extraction.
    const scopeResult = checkPRScope(pr.body, pr.diff);
    if (scopeResult.violation) {
      this.log.warn("PR scope pre-flight blocked — bundled PR detected", {
        repo,
        prNumber,
        violation_type: scopeResult.violation_type,
        closes_refs: scopeResult.closes_refs,
        feature_groups: scopeResult.feature_groups.map((g) => g.label),
        reason: scopeResult.reason,
      });
      const result: PRReviewResult = {
        decision: "request-changes",
        comment: formatScopeViolationComment(scopeResult, prNumber),
        reason: `PR scope violation (${scopeResult.violation_type}): ${scopeResult.reason}`,
        redispatchCategory: "quality-revision",
        severity: "minor",
      };
      await this.executeDecision(repo, prNumber, result);
      return result;
    }

    // ── LLM review ────────────────────────────────────────────────────────
    const client = createLLMClient();

    // Detect schema-consumer impact and inject a notice when schema files changed
    const changedFiles = extractChangedFilesFromDiff(truncatedDiff);
    const schemaHits = detectSchemaChanges(truncatedDiff, changedFiles);
    const schemaContractHits = detectSchemaContractDrift(truncatedDiff, changedFiles);

    // Static contract validator (issue #168): when store.ts or schema-contract.json
    // is touched in this repo's own PRs, validate the *full* current store.ts against
    // the contract to catch accumulated drift, not just the current PR's diff.
    const staticContractHits = this.runStaticContractValidation(repo, changedFiles);

    const allSchemaHits = [...schemaHits, ...schemaContractHits, ...staticContractHits];
    const schemaNotice = buildSchemaImpactNotice(allSchemaHits);
    if (allSchemaHits.length > 0) {
      this.log.info("Schema-consumer impact detected", {
        repo,
        prNumber,
        schemas: allSchemaHits.map((h) => h.schemaLabel),
        consumers: [...new Set(allSchemaHits.flatMap((h) => h.consumers))],
      });
    }

    // Static shell injection pre-scan: annotate risky exec() interpolations so
    // the LLM has per-line context. Returns null when no risky lines exist
    // (the common case), keeping the prompt clean when everything is safe.
    const shellInjectionNotice = annotateShellInjectionRisks(truncatedDiff);

    const prompt = `## PR #${pr.number}: ${pr.title}\n**Repo:** ${pr.repo}\n**Author:** ${pr.author}\n**Branch:** ${pr.branch}\n**Files changed:** ${pr.files_changed}${diffWarning}${schemaNotice}${shellInjectionNotice ?? ""}\n\n### Description\n${pr.body}\n\n### Diff\n\`\`\`diff\n${truncatedDiff}\n\`\`\``;

    const LLM_TIMEOUT_MS = 5 * 60 * 1000;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    const callStart = Date.now();
    try {
      let response;
      try {
        response = await client.messages.create(
          {
            model: "claude-sonnet-4-6",
            max_tokens: 2048,
            system: buildCachedSystemContent(SYSTEM_PROMPT),
            messages: [{ role: "user", content: prompt }],
          },
          { signal: abortController.signal },
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.usage) {
        this.store.recordLlmCallEvent({
          call_type: "pr_review",
          model: response.model,
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
          duration_ms: Date.now() - callStart,
          pr_number: prNumber,
        });
      }

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("");

      const result = this.parseResponse(text);

      // Annotate with staleness & re-dispatch category
      if (stalenessHours !== null) {
        result.branchStalenessHours = stalenessHours;
      }
      if (result.decision === "request-changes") {
        result.redispatchCategory = "quality-revision";
      }
      if (
        stalenessHours !== null &&
        stalenessHours > this.staleBranchThresholdHours
      ) {
        result.redispatchCategory = "stale-branch-nudge";
      }

      this.log.info("PR review complete", {
        repo,
        prNumber,
        decision: result.decision,
        confidence: result.confidence,
        reason: result.reason,
        branchStalenessHours: result.branchStalenessHours,
        redispatchCategory: result.redispatchCategory,
      });

      await this.executeDecision(repo, prNumber, result, pr.branch, allSchemaHits, pr.author);
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

  /**
   * Processes a GitHub issue for standup handling.
   *
   * If the issue is a standup with 0 action items, posts an acknowledgment
   * comment and optionally closes the issue if all referenced PRs are merged.
   *
   * Returns true if the issue was handled as a zero-action standup (preventing
   * normal PR review flow), false otherwise.
   */
  async handleStandupIssueIfNeeded(repo: string, issueNumber: number): Promise<boolean> {
    try {
      // Fetch issue details
      const jsonOutput = execSync(
        `gh issue view ${issueNumber} --repo ${shellEscape(repo)} --json number,title,body,labels,state --jq '.'`,
        { encoding: "utf-8", timeout: 30000 },
      );

      const issueData = JSON.parse(jsonOutput);
      const issue: GitHubIssue = {
        number: issueData.number,
        title: issueData.title,
        body: issueData.body || "",
        labels: issueData.labels?.map((l: Record<string, string>) => l.name) || [],
        state: issueData.state,
      };

      // Check if this is a standup issue
      if (!isStandupIssue(issue)) {
        return false;
      }

      // Check if it has zero action items
      const actionItemCount = extractActionItemCount(issue);
      if (actionItemCount !== 0) {
        // Has action items, proceed with normal flow
        return false;
      }

      // Handle zero-action standup
      this.log.info("Processing zero-action standup issue", {
        repo,
        issueNumber,
        title: issue.title,
      });

      // Pass the store for synthesis health tracking (cast to IStandupHealthStore
      // since StateStore implements it but IStateStore doesn't declare it)
      const standupStore = (this.store as unknown as IStandupHealthStore);
      const hasStandupHealthStore =
        typeof standupStore.recordStandupSynthesisEvent === "function";
      await handleZeroActionStandup(
        repo,
        issueNumber,
        issue,
        true,
        undefined,
        hasStandupHealthStore ? standupStore : undefined,
      );
      return true;
    } catch (err) {
      // If we can't process as standup, let normal flow handle it
      this.log.info("Failed to check standup status, continuing with normal review", {
        repo,
        issueNumber,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Resolve an issue number for the zero-action standup check.
   *
   * Tries multiple sources to find the linked issue number:
   * 1. Branch name: `issue-N-*` pattern (most common)
   * 2. PR body: `Closes #N` / `Fixes #N` / `Resolves #N` keywords
   * 3. PR body: fully qualified `Closes owner/repo#N` references
   *
   * This ensures standup PRs with non-standard branch names (e.g.
   * "standup-721-response") are still caught by the zero-action guard.
   */
  resolveIssueNumberForStandupCheck(pr: PRInfo): number | null {
    // Tier 1: branch name (fast, no regex ambiguity)
    const branchIssue = extractIssueNumberFromBranch(pr.branch);
    if (branchIssue) {
      return parseInt(branchIssue, 10);
    }

    // Tier 2: PR body — bare "Closes #N" / "Fixes #N" / "Resolves #N"
    const bodyMatch = pr.body.match(
      /(?:closes|fixes|resolves)\s+#(\d+)/i,
    );
    if (bodyMatch) {
      return parseInt(bodyMatch[1], 10);
    }

    // Tier 3: PR body — fully qualified "Closes owner/repo#N"
    const qualifiedMatch = pr.body.match(
      /(?:closes|fixes|resolves)\s+\S+#(\d+)/i,
    );
    if (qualifiedMatch) {
      return parseInt(qualifiedMatch[1], 10);
    }

    // Tier 4: PR title — standup-related issue reference
    const titleMatch = pr.title.match(/#(\d+)/);
    if (titleMatch) {
      return parseInt(titleMatch[1], 10);
    }

    return null;
  }

  private async executeDecision(
    repo: string,
    prNumber: number,
    result: PRReviewResult,
    prBranch?: string,
    schemaHits: SchemaImpactHit[] = [],
    agentName?: string | null,
  ): Promise<void> {
    // Build downstream impact section if schema changes were detected
    const downstreamImpact = buildDownstreamImpactSection(schemaHits);

    switch (result.decision) {
      case "approve": {
        try {
          // Check if this PR should be closed instead of merged
          if (result.shouldCloseInsteadOfMerge) {
            // Close the PR with an explanatory comment
            execSync(
              `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Closed** 🔄\n\n${result.comment}`)}`,
              { encoding: "utf-8", timeout: 30000 },
            );
            execSync(`gh pr close ${prNumber} --repo ${repo} --delete-branch`, {
              encoding: "utf-8",
              timeout: 30000,
            });
            this.log.info("PR closed (not merged)", {
              repo,
              prNumber,
              reason: result.reason,
            });
            this.recordReview(repo, prNumber, "approve", result, agentName);
            break;
          }

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
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Approved** ✅\n\n${result.comment}${downstreamImpact}\n\n---\n🔀 Added to merge queue (${positionMsg}). PRs merge sequentially to avoid branch conflicts.`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR approved and added to merge queue", {
            repo,
            prNumber,
            position: entry.position,
          });
          this.recordReview(repo, prNumber, "approve", result, agentName);
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
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**[orchestrator] PR Review — Changes Requested**\n\n${result.comment}${downstreamImpact}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR changes requested", { repo, prNumber });
          this.recordReview(repo, prNumber, "request-changes", result, agentName);
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
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**Orchestrator escalation:** ${result.comment}${downstreamImpact}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR escalated to human", {
            repo,
            prNumber,
            reason: result.reason,
          });
          this.recordReview(repo, prNumber, "escalate", result, agentName);
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

  /**
   * Persist a PR review record, enriching it with iteration metadata when the
   * store supports `recordPRReviewDetails` (IPRIterationStore).
   *
   * Falls back to the narrower `recordPRReview` for orchestrator-injected stores
   * that only implement `IStateStore`.
   */
  private recordReview(
    repo: string,
    prNumber: number,
    decision: string,
    result: PRReviewResult,
    agentName?: string | null,
  ): void {
    const store = this.store as unknown as Record<string, unknown>;
    if (typeof store["recordPRReviewDetails"] === "function") {
      // Extract review categories from the comment for request-changes outcomes
      const reviewCategories: ReviewCategory[] =
        decision === "request-changes" || decision === "escalate"
          ? categoriseReviewComment(result.comment)
          : [];

      (store["recordPRReviewDetails"] as (
        repo: string,
        prNumber: number,
        decision: string,
        opts?: {
          confidence?: number | null;
          agentName?: string | null;
          reviewCategories?: ReviewCategory[];
        },
      ) => void)(repo, prNumber, decision, {
        confidence: result.confidence ?? null,
        agentName: agentName ?? null,
        reviewCategories,
      });
    } else {
      this.store.recordPRReview(repo, prNumber, decision, result.confidence ?? null);
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
      this.recordReview(
        repo,
        prNumber,
        "escalate",
        { decision: "escalate", comment: "Auto-closed persistently conflicting PR", reason: "merge-conflict" },
        null,
      );

      // Track for conflict stats
      const repoKey = repo.split("/").pop() ?? repo;
      this.conflictAutoCloseCount.set(
        repoKey,
        (this.conflictAutoCloseCount.get(repoKey) ?? 0) + 1,
      );

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

  /**
   * Return aggregate conflict/staleness statistics since the last daemon
   * restart.  The orchestrator feeds these into the weekly summary ("X cycles
   * lost to merge conflicts") and the dashboard's dispatch-efficiency chart.
   */
  getConflictStats(): ConflictStats {
    let totalEscalations = 0;
    let totalAutoCloses = 0;
    let totalNudges = 0;
    const perRepo: ConflictStats["perRepo"] = {};

    // Aggregate escalation counts (keyed by "repo#prNumber")
    for (const [key, count] of this.conflictEscalationCount) {
      const repo = key.split("#")[0].split("/").pop() ?? key;
      if (!perRepo[repo]) perRepo[repo] = { escalations: 0, autoCloses: 0, staleNudges: 0 };
      perRepo[repo].escalations += count;
      totalEscalations += count;
    }

    for (const [repo, count] of this.conflictAutoCloseCount) {
      if (!perRepo[repo]) perRepo[repo] = { escalations: 0, autoCloses: 0, staleNudges: 0 };
      perRepo[repo].autoCloses += count;
      totalAutoCloses += count;
    }

    for (const [repo, count] of this.staleBranchNudgeCount) {
      if (!perRepo[repo]) perRepo[repo] = { escalations: 0, autoCloses: 0, staleNudges: 0 };
      perRepo[repo].staleNudges += count;
      totalNudges += count;
    }

    return {
      totalConflictEscalations: totalEscalations,
      totalAutoClosedConflictPRs: totalAutoCloses,
      totalStaleBranchNudges: totalNudges,
      perRepo,
    };
  }

  /** Reset all conflict counters (e.g. after a weekly summary is generated). */
  resetConflictStats(): void {
    this.conflictAutoCloseCount.clear();
    this.staleBranchNudgeCount.clear();
    // Note: conflictEscalationCount is NOT reset here because it's also
    // used for the auto-close-after-N-escalations logic in the daemon.
  }

  /**
   * Measure how many hours behind `origin/main` the given branch is.
   * Returns null if the measurement fails (no local repo, git error, etc.).
   *
   * Uses the commit timestamp of `origin/main` that is NOT an ancestor of
   * the branch — i.e. how long ago main diverged from the branch point.
   */
  private measureBranchStaleness(repo: string, branch: string): number | null {
    const localPath = this.findLocalRepoPath(repo);
    if (!localPath) return null;

    try {
      // Get the timestamp of the merge-base (where branch diverged from main)
      const mergeBase = execSync(
        `git merge-base origin/main ${branch}`,
        { cwd: localPath, encoding: "utf-8", timeout: 10000 },
      ).trim();

      if (!mergeBase) return null;

      // Get the timestamp of the merge-base commit
      const baseTimestamp = execSync(
        `git show -s --format=%ct ${mergeBase}`,
        { cwd: localPath, encoding: "utf-8", timeout: 10000 },
      ).trim();

      const baseTime = parseInt(baseTimestamp, 10) * 1000; // to ms
      if (isNaN(baseTime)) return null;

      const hoursOld = (Date.now() - baseTime) / (1000 * 60 * 60);
      return hoursOld;
    } catch {
      // Git not available or branch doesn't exist locally — fail open
      return null;
    }
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
        const rawConfidence = parsed.confidence;
        const confidence =
          typeof rawConfidence === "number" &&
          Number.isFinite(rawConfidence) &&
          rawConfidence >= 0 &&
          rawConfidence <= 1
            ? rawConfidence
            : null;
        const VALID_SEVERITIES = ["critical", "major", "minor"] as const;
        const VALID_CATEGORIES = [
          "security",
          "correctness",
          "data-integrity",
          "missing-functionality",
        ] as const;
        const severity =
          decision === "request-changes" &&
          VALID_SEVERITIES.includes(parsed.severity as (typeof VALID_SEVERITIES)[number])
            ? (parsed.severity as PRReviewResult["severity"])
            : null;
        const category =
          decision === "request-changes" &&
          VALID_CATEGORIES.includes(parsed.category as (typeof VALID_CATEGORIES)[number])
            ? (parsed.category as PRReviewResult["category"])
            : null;
        return {
          decision,
          comment: decision === "request-changes" ? enforceChecklist(comment) : comment,
          reason: String(parsed.reason ?? ""),
          confidence,
          severity,
          category,
        };
      } catch {
        continue;
      }
    }

    return {
      decision: "escalate",
      comment: "Could not parse review — escalating to human.",
      reason: "Parse failure",
      confidence: null,
      severity: null,
      category: null,
    };
  }

  /**
   * Run the static schema-contract validator against the local store.ts when a
   * PR in this repo touches `src/state/store.ts` or `schema-contract.json`.
   *
   * Unlike `detectSchemaContractDrift()` (diff-based), this reads the **full**
   * store.ts to catch accumulated drift from previous PRs that were never
   * reflected in the contract.
   *
   * Gated to `rapartlu/agent-reviewer` PRs only — other repos have their own
   * store.ts files and their own validation gate.
   *
   * @returns SchemaImpactHit array (empty when clean or when the file cannot be read).
   */
  private runStaticContractValidation(repo: string, changedFiles: string[]): SchemaImpactHit[] {
    const REVIEWER_REPO = "rapartlu/agent-reviewer";
    if (repo !== REVIEWER_REPO) return [];

    const schemaFilesChanged = changedFiles.some(
      (f) => f.includes("state/store.ts") || f.includes("schema-contract.json"),
    );
    if (!schemaFilesChanged) return [];

    try {
      const storeUrl = new URL("../state/store.ts", import.meta.url);
      const storeSource = readFileSync(fileURLToPath(storeUrl), "utf-8");
      const validation = validateStoreSchemaAgainstContract(storeSource);

      if (validation.clean) return [];

      const registry = loadSchemaContractRegistry();
      const hits: SchemaImpactHit[] = [];

      for (const w of validation.warnings) {
        const entry = registry.tables.find(
          (t) => t.table.toLowerCase() === w.table.toLowerCase(),
        );
        const consumers = entry ? [...entry.consumer_repos] : [];

        hits.push({
          schemaLabel: `schema contract stale: ${w.table}`,
          consumers,
          matchedFiles: ["src/state/store.ts", "src/reviewer/schema-contract.json"],
          contractMismatch: true,
          missingColumns: w.missingFromStore,
          extraColumns: w.extraInStore,
        });
      }

      this.log.warn("Static contract validator found schema drift", {
        repo,
        warnings: validation.warnings.map((w) => ({
          table: w.table,
          missingFromStore: w.missingFromStore,
          extraInStore: w.extraInStore,
        })),
      });

      return hits;
    } catch (err) {
      this.log.warn("Static contract validator could not read store.ts", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
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

// ── Example/template file helpers (exported for testing) ─────────────────────

/**
 * Returns true if the file path is an example, template, or sample file that
 * is expected to contain placeholder credential values.
 *
 * This function is re-exported from src/config/security-allowlist.ts to ensure
 * consistency with the security scanner in agent-proxy. Both systems must use
 * the same patterns to prevent false-positive security alerts on example files.
 *
 * Matches:
 *   - Files whose basename contains `.example.`, `.template.`, or `.sample.`
 *     (e.g. `docker-compose.example.yml`, `config.template.json`)
 *   - Files whose basename starts with `example.`, `template.`, or `sample.`
 *     (e.g. `example.env`, `template.yaml`)
 *   - Files under an `examples/`, `templates/`, or `samples/` directory
 *     anywhere in their path
 *   - Files whose first 5 lines contain example/template headers
 */
export function isExampleOrTemplateFile(filePath: string, content?: string): boolean {
  return isExampleOrTemplateFileFromConfig(filePath, content);
}

/**
 * Returns true if the value looks like an intentional placeholder rather than
 * a real leaked credential.
 *
 * Placeholders are values that instruct the user to replace them — they carry
 * no secret entropy and are safe to commit.
 */
/**
 * Shell injection risk classification for a single interpolated expression.
 *
 * Called by annotateShellInjectionRisks() to classify each `${...}` inside
 * an exec/execSync call found in a diff.
 *
 * @param expr   The raw text inside `${...}`, e.g. "branch", "shellEscape(repo)", "req.body.name"
 * @returns      "safe" | "escaped" | "risky"
 */
export function classifyShellInjectionRisk(
  expr: string,
): "safe" | "escaped" | "risky" {
  const e = expr.trim();

  // Already wrapped in an escape helper — safe
  if (/shellEscape\(|shlex\.quote\(|shell-quote|escapeShell\(|shellescape\(/.test(e)) {
    return "escaped";
  }

  // spawn() with array args doesn't use a shell — safe
  // (handled at call-site detection level, not expression level)

  // Pure numeric/boolean literals or expressions — safe
  if (/^\d+$/.test(e) || e === "true" || e === "false") return "safe";

  // Number-typed variable names that conventionally hold IDs — safe
  if (/^(prNumber|issueNumber|taskId|id|count|limit|offset|page|index|num|port)$/.test(e)) {
    return "safe";
  }

  // Internal config fields that are controlled by the system — safe
  if (
    /^(repo|this\.repo|config\.(repo|branch)|REPO|BASE_BRANCH|DEFAULT_BRANCH)$/.test(e)
  ) {
    return "safe";
  }

  // Externally-sourced fields that are commonly exploitable without escaping
  const externalPatterns =
    /\b(req\.|request\.|body\.|params\.|query\.|headers\.|userInput|userName|authorName|prTitle|commitMessage|label|refName|tagName|branchName)\b/;
  if (externalPatterns.test(e)) return "risky";

  // GitHub API response fields commonly containing attacker-controlled data
  const githubApiFields = /^(branch|ref|head|base|sha|title|name|login|email|body)$/;
  if (githubApiFields.test(e)) return "risky";

  // Default: unknown — treat as safe to avoid false positives
  return "safe";
}

/**
 * Scan a diff for exec/execSync calls that interpolate variables into shell
 * strings, and return an annotation notice if genuinely risky patterns are
 * found.
 *
 * Returns null when no exec calls with template literals are present, or when
 * all detected patterns are safe. Returns a notice string when one or more
 * lines look risky — the notice is injected into the review prompt so the LLM
 * has per-line context rather than just the general system prompt rules.
 *
 * SAFE patterns generate no annotation (to avoid cluttering the prompt with
 * noise). Only risky patterns generate an annotation.
 */
export function annotateShellInjectionRisks(diff: string): string | null {
  const lines = diff.split("\n");
  const risky: Array<{ line: number; code: string; exprs: string[] }> = [];

  // Matches exec/execSync with a backtick template literal argument
  const execPattern = /\bexec(?:Sync)?\s*\(\s*`([^`]*)`/;
  // Extract ${...} expressions from a template literal
  const interpolationPattern = /\$\{([^}]+)\}/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only look at added/modified lines in the diff
    if (!line.startsWith("+")) continue;

    const execMatch = execPattern.exec(line);
    if (!execMatch) continue;

    const template = execMatch[1];
    const riskyExprs: string[] = [];
    let m: RegExpExecArray | null;
    interpolationPattern.lastIndex = 0;
    while ((m = interpolationPattern.exec(template)) !== null) {
      const expr = m[1];
      if (classifyShellInjectionRisk(expr) === "risky") {
        riskyExprs.push(expr);
      }
    }

    if (riskyExprs.length > 0) {
      risky.push({ line: i + 1, code: line.slice(1).trim(), exprs: riskyExprs });
    }
  }

  if (risky.length === 0) return null;

  const items = risky
    .map(
      (r) =>
        `- Line ~${r.line}: \`${r.code.slice(0, 120)}\`\n  ⚠️ Unescaped external expression(s): ${r.exprs.map((e) => `\`${e}\``).join(", ")} — wrap with \`shellEscape()\` or use spawn() array form`,
    )
    .join("\n");

  return `\n\n> **🔍 Shell Injection Pre-Scan** — The following added lines interpolate potentially externally-controlled values into exec/execSync shell strings without visible escaping. Review carefully:\n${items}`;
}

export function isPlaceholderCredential(value: string): boolean {
  const v = value.trim();

  // Angle-bracket templates: <your-key>, <API_KEY>, etc.
  if (/^<[^>]+>$/.test(v)) return true;

  // All-uppercase or mixed-case instruction-style labels
  const instructionPattern =
    /\b(your[_-]?(api[_-]?key|token|secret|key|password)|insert[_-]?key|replace[_-]?me|change[_-]?me|put[_-]?your|add[_-]?your)\b/i;
  if (instructionPattern.test(v)) return true;

  // Common stand-in words
  const standIns = new Set([
    "changeme",
    "replace_me",
    "replace-me",
    "todo",
    "placeholder",
    "dummy",
    "example-key",
    "example_key",
    "test-key",
    "test_key",
    "fake-key",
    "fake_key",
    "xxx",
    "xxxx",
    "1234567890",
    "abcdefghij",
    "abcdefghijklmnopqrstuvwxyz",
  ]);
  if (standIns.has(v.toLowerCase())) return true;

  // ALL_CAPS with underscores (environment variable name used as its own value)
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(v)) return true;

  return false;
}
