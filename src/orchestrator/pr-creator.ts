import { execSync } from "node:child_process";
import { join } from "node:path";
import { createLogger } from "../service/logger.js";
import { createLLMClient, getLLMModel } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { validatePreSubmit, formatValidationSummary } from "./pre-submit-validator.js";
import type { StateStore } from "../state/store.js";
import { validateGhAuth } from "../triggers/github.js";

/** Maximum number of times to retry `gh pr create` after a transient failure. */
export const PR_CREATE_MAX_RETRIES = 2;
/** Base delay in ms between `gh pr create` retry attempts. */
export const PR_CREATE_RETRY_DELAY_MS = 2_000;
/**
 * Branches more than this many commits behind main are considered permanently
 * stale. They are auto-deleted without running validation or tests — any PR
 * they produced would conflict anyway, and running `npx vitest run` on 34+
 * stale branches was the #1 cause of long daemon cycle times.
 */
export const STALE_BRANCH_BEHIND_THRESHOLD = 10;

const log = createLogger("pr-creator");

export interface OrphanBranch {
  repo: string;
  branch: string;
  agentName: string;
}

/**
 * Extract issue number from a branch name.
 * Matches patterns like: issue-105-description, issue-105, fix-issue-105, 105-description,
 * fix/issue-134-description (slash separators)
 * Returns the issue number as a string, or null if not found.
 */
export function extractIssueNumberFromBranch(branch: string): string | null {
  // Most common: issue-N or issue-N-description (also handles slash separators like fix/issue-N)
  const issuePrefix = branch.match(/(?:^|[-_/])issue[-_](\d+)/i);
  if (issuePrefix) return issuePrefix[1];

  // Branch starts with a number: 105-description
  const leadingNumber = branch.match(/^(\d+)[-_]/);
  if (leadingNumber) return leadingNumber[1];

  return null;
}

/**
 * Stop words stripped from branch names before fuzzy token matching.
 * These are generic words that appear in branch names but don't meaningfully
 * identify a specific issue.
 */
const BRANCH_STOP_WORDS = new Set([
  "fix", "feature", "feat", "issue", "add", "update", "refactor", "chore",
  "bug", "hotfix", "patch", "improve", "improvement", "enhancement", "docs",
  "style", "test", "ci", "revert", "merge", "wip", "draft", "init",
]);

/**
 * Fuzzy-match a branch name against a list of open issues by tokenizing the
 * branch and scoring issues by how many tokens appear in their title.
 *
 * Returns candidate issues sorted by score (highest first), filtered to those
 * that score above the minimum threshold.
 */
export function fuzzyMatchIssues(
  branch: string,
  issues: Array<{ number: number; title: string }>,
): Array<{ number: number; title: string; score: number }> {
  // Normalize branch: replace slashes/underscores with dashes, lowercase, split
  const tokens = branch
    .toLowerCase()
    .replace(/[/_]/g, "-")
    .split("-")
    .filter((t) => t.length > 2 && !BRANCH_STOP_WORDS.has(t) && !/^\d+$/.test(t));

  if (tokens.length === 0) return [];

  // Require at least this many tokens to match for a candidate to qualify
  const minScore = Math.max(1, Math.floor(tokens.length * 0.4));

  return issues
    .map((issue) => {
      const titleLower = issue.title.toLowerCase();
      const score = tokens.filter((t) => titleLower.includes(t)).length;
      return { ...issue, score };
    })
    .filter((i) => i.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

/**
 * Use an LLM to disambiguate between multiple fuzzy-matched issue candidates.
 * Returns the issue number of the best match, or null if none fit.
 */
async function llmPickIssue(
  branch: string,
  candidates: Array<{ number: number; title: string; score: number }>,
  config: OrchestratorConfig,
): Promise<number | null> {
  try {
    const { client, model } = createLLMClient(config);
    const issueList = candidates.map((c) => `#${c.number}: ${c.title}`).join("\n");

    const LLM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard timeout
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), LLM_TIMEOUT_MS);
    let response;
    try {
      response = await client.messages.create({
        model: getLLMModel(config, "issue_matcher") ?? model,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: `Which GitHub issue does the branch "${branch}" most likely implement? Pick exactly one from this list, or respond "none" if none fit.\n\n${issueList}\n\nRespond with ONLY the issue number (e.g. "42") or "none".`,
          },
        ],
      }, { signal: abortController.signal });
    } finally {
      clearTimeout(timer);
    }

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? b.text : ""))
      .join("")
      .trim();

    if (text === "none") return null;
    const num = parseInt(text, 10);
    return isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

/**
 * Three-tier issue number resolution for a branch:
 *
 * 1. Parse issue number directly from branch name (e.g. issue-105-description → 105)
 * 2. Fuzzy-match branch tokens against open issue titles
 * 3. LLM disambiguation when multiple fuzzy candidates remain (requires config)
 *
 * Returns the resolved issue number as a string, or null if no match found.
 */
export async function findMatchingIssueNumber(
  repo: string,
  branch: string,
  config?: OrchestratorConfig,
): Promise<string | null> {
  // Tier 1: deterministic parse from branch name (instant, free)
  const fromBranch = extractIssueNumberFromBranch(branch);
  if (fromBranch) return fromBranch;

  // Tier 2: fuzzy token matching against open issues
  let issues: Array<{ number: number; title: string }> = [];
  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --state open --json number,title -L 100`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();
    if (raw) issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
  } catch {
    return null; // can't reach repo — skip linking
  }

  if (issues.length === 0) return null;

  const candidates = fuzzyMatchIssues(branch, issues);
  if (candidates.length === 0) return null;

  // Clear winner: only one candidate
  if (candidates.length === 1) {
    log.info("Fuzzy-matched issue from branch name", {
      repo,
      branch,
      issueNumber: candidates[0].number,
      score: candidates[0].score,
    });
    return String(candidates[0].number);
  }

  // Tier 3: LLM disambiguation when heuristics are ambiguous
  if (config) {
    const picked = await llmPickIssue(branch, candidates, config);
    if (picked !== null) {
      log.info("LLM-picked issue from branch name", { repo, branch, issueNumber: picked });
      return String(picked);
    }
  }

  // Fall back to highest-scoring fuzzy match
  log.info("Using top fuzzy match for branch", {
    repo,
    branch,
    issueNumber: candidates[0].number,
    score: candidates[0].score,
  });
  return String(candidates[0].number);
}

/**
 * Find branches that have been pushed, have commits ahead of main,
 * and don't have open PRs. Creates PRs for them.
 *
 * @param agentFilter - When provided, only check the specified agent's repo.
 *   Used by the post-dispatch orphan hook to scan a single repo immediately
 *   after its agent completes, rather than scanning all repos.
 */
export function findOrphanBranches(config: OrchestratorConfig, agentFilter?: string): OrphanBranch[] {
  const orphans: OrphanBranch[] = [];

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (agentFilter !== undefined && agentName !== agentFilter) continue;
    if (!agent.github) continue;

    try {
      // Get branches that already have PRs (open, merged, or closed)
      const prsRaw = execSync(
        `gh pr list --repo ${agent.github} --state all --json headRefName --jq '.[].headRefName'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      const prBranches = new Set(prsRaw ? prsRaw.split("\n") : []);

      // Get branches with commits ahead of main (not just any branch)
      const branchesRaw = execSync(
        `gh api "repos/${agent.github}/branches" --jq '.[].name'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (!branchesRaw) continue;

      const branches = branchesRaw.split("\n").filter((b) => b !== "main" && b !== "master");

      for (const branch of branches) {
        if (prBranches.has(branch)) continue;

        // Check commits ahead/behind main in a single API call
        try {
          const raw = execSync(
            `gh api "repos/${agent.github}/compare/main...${branch}" --jq '{ahead_by,behind_by}'`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          const { ahead_by: aheadBy, behind_by: behindBy } = JSON.parse(raw) as {
            ahead_by: number;
            behind_by: number;
          };

          if (behindBy > STALE_BRANCH_BEHIND_THRESHOLD) {
            // Branch is too far behind main — any PR would conflict.
            // Auto-delete it to avoid running expensive validation (tests, tsc)
            // on branches that are never going to merge cleanly.
            log.info("Auto-deleting stale orphan branch (too far behind main)", {
              repo: agent.github,
              branch,
              behindBy,
              threshold: STALE_BRANCH_BEHIND_THRESHOLD,
            });
            try {
              execSync(
                `gh api --method DELETE "repos/${agent.github}/git/refs/heads/${branch}"`,
                { encoding: "utf-8", timeout: 10000 },
              );
              log.info("Stale orphan branch deleted", { repo: agent.github, branch });
            } catch (delErr) {
              log.warn("Failed to delete stale orphan branch", {
                repo: agent.github,
                branch,
                error: delErr instanceof Error ? delErr.message : String(delErr),
              });
            }
            continue;
          }

          if (aheadBy > 0) {
            orphans.push({ repo: agent.github, branch, agentName });
          }
        } catch {
          // Branch may not be comparable — skip
        }
      }
    } catch {
      // Skip repos we can't access
    }
  }

  return orphans;
}

/**
 * Delete remote branches across all agent repos that:
 * - Have no open PR (merged/closed PRs are okay to clean up)
 * - Are more than STALE_BRANCH_BEHIND_THRESHOLD commits behind main
 *
 * This is the periodic "lint pass" that catches branches from merged PRs where
 * `--delete-branch` didn't fire (e.g. when the PR was merged manually or
 * `gh pr merge` lost its connection mid-run).
 *
 * Returns the number of branches deleted.
 */
export function deleteStaleOrphanBranches(config: OrchestratorConfig): number {
  let deleted = 0;

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;

    try {
      // Only consider branches that have no open PR
      const openPrBranchesRaw = execSync(
        `gh pr list --repo ${agent.github} --state open --json headRefName --jq '.[].headRefName'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      const openPrBranches = new Set(openPrBranchesRaw ? openPrBranchesRaw.split("\n") : []);

      const branchesRaw = execSync(
        `gh api "repos/${agent.github}/branches" --jq '.[].name'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (!branchesRaw) continue;

      const branches = branchesRaw.split("\n").filter((b) => b !== "main" && b !== "master");

      for (const branch of branches) {
        // Don't touch branches with an open PR — the pr-reviewer owns those
        if (openPrBranches.has(branch)) continue;

        try {
          const raw = execSync(
            `gh api "repos/${agent.github}/compare/main...${branch}" --jq '.behind_by'`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          const behindBy = parseInt(raw, 10);

          if (!isNaN(behindBy) && behindBy > STALE_BRANCH_BEHIND_THRESHOLD) {
            log.info("Periodic cleanup: deleting stale branch with no open PR", {
              repo: agent.github,
              branch,
              behindBy,
              agentName,
            });
            execSync(
              `gh api --method DELETE "repos/${agent.github}/git/refs/heads/${branch}"`,
              { encoding: "utf-8", timeout: 10000 },
            );
            deleted++;
          }
        } catch {
          // Branch may not be comparable or deletion may fail — skip
        }
      }
    } catch {
      // Skip repos we can't access
    }
  }

  return deleted;
}

/**
 * Resolve the local filesystem checkout path for an orphan branch's agent.
 * Returns null if config is unavailable or the agent has no configured dir.
 */
function getLocalPathForAgent(orphan: OrphanBranch, config?: OrchestratorConfig): string | null {
  if (!config?.base_dir) return null;
  const agent = config.agents[orphan.agentName];
  if (!agent?.dir) return null;
  return join(config.base_dir, agent.dir);
}

export async function createPRForBranch(
  orphan: OrphanBranch,
  config?: OrchestratorConfig,
  store?: StateStore,
): Promise<string | null> {
  // Pre-flight: verify gh is authenticated before attempting any remote git
  // operation.  A missing/expired credential causes branch push to succeed but
  // `gh pr create` to fail silently, burning 2 agent cycles per occurrence.
  const authStatus = validateGhAuth();
  if (!authStatus.ok) {
    log.error("gh auth pre-flight failed — skipping PR creation", {
      repo: orphan.repo,
      branch: orphan.branch,
      reason: authStatus.reason,
    });
    return null;
  }

  try {
    const issueNumber = await findMatchingIssueNumber(orphan.repo, orphan.branch, config);
    let body = issueNumber
      ? `Auto-created by orchestrator for orphan branch.\n\nCloses #${issueNumber}`
      : "Auto-created by orchestrator for orphan branch.";

    // Resolve local path so validatePreSubmit can use local git fallbacks for
    // conflict and freshness detection when the GitHub API is unavailable.
    const localPath = getLocalPathForAgent(orphan, config);

    // Pre-submit validation: ensure issue ref, branch freshness, no conflicts, and no duplicate PR.
    let validation = await validatePreSubmit(
      orphan.repo,
      orphan.branch,
      body,
      localPath,
      config,
    );

    // Auto-fix: if the only blocker is a missing issue ref AND we can infer the issue
    // number from the branch name, patch the body with "Closes #N" and re-validate.
    // This avoids dropping branches that could be auto-linked.
    if (
      !validation.valid &&
      validation.inferredIssueNumber &&
      !validation.checks.issueRef.passed &&
      validation.blockers.length === 1
    ) {
      const patchedBody = `Auto-created by orchestrator for orphan branch.\n\nCloses #${validation.inferredIssueNumber}`;
      log.info("Auto-fixing missing issue ref in orphan PR body", {
        repo: orphan.repo,
        branch: orphan.branch,
        issueNumber: validation.inferredIssueNumber,
      });
      body = patchedBody;
      validation = await validatePreSubmit(orphan.repo, orphan.branch, body, localPath, config);
    }

    // Log validation results to task_logs so the audit trail is visible in
    // `orch status` output for the associated task.
    if (store) {
      const resolvedIssue = issueNumber ?? validation.inferredIssueNumber;
      const task = resolvedIssue
        ? store.findTaskByIssueRef(orphan.repo, resolvedIssue)
        : undefined;
      if (task) {
        store.addLog({
          task_id: task.id,
          direction: "system",
          agent_name: orphan.agentName,
          content: `[pre-submit] ${formatValidationSummary(validation)}`,
        });
      }
    }

    if (!validation.valid) {
      log.warn("Pre-submit validation failed for orphan branch PR — skipping PR creation", {
        repo: orphan.repo,
        branch: orphan.branch,
        blockers: validation.blockers,
      });
      // Return null to signal that the PR was not created; the daemon will retry
      // on the next cycle once the branch has been fixed/rebased.
      return null;
    }

    const url = await createPRWithRetry(
      `gh pr create --repo ${orphan.repo} --head ${orphan.branch} --title "[${orphan.agentName}] ${orphan.branch}" --body ${shellEscape(body)}`,
    );

    log.info("Created PR for orphan branch", {
      repo: orphan.repo,
      branch: orphan.branch,
      url,
      issueNumber: issueNumber ?? "not detected",
    });
    return url;
  } catch (err) {
    log.error("Failed to create PR for orphan branch", {
      repo: orphan.repo,
      branch: orphan.branch,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Execute `gh pr create` with up to PR_CREATE_MAX_RETRIES retries on failure.
 *
 * Branch push and PR creation are treated as a single atomic unit: if the
 * branch was pushed successfully but `gh pr create` fails (e.g. due to a
 * transient auth hiccup or rate limit), we retry before giving up.
 *
 * @param cmd - The full `gh pr create` shell command to run.
 * @param delayFn - Optional override for the inter-retry delay (for tests).
 * @returns The PR URL string on success.
 * @throws The last error after all retries are exhausted.
 */
export async function createPRWithRetry(
  cmd: string,
  delayFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= PR_CREATE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      log.warn("Retrying gh pr create after failure", {
        attempt,
        maxRetries: PR_CREATE_MAX_RETRIES,
        delayMs: PR_CREATE_RETRY_DELAY_MS * attempt,
      });
      await delayFn(PR_CREATE_RETRY_DELAY_MS * attempt);
    }
    try {
      return execSync(cmd, { encoding: "utf-8", timeout: 30000 }).trim();
    } catch (err) {
      lastError = err;
      log.warn("gh pr create attempt failed", {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastError;
}
