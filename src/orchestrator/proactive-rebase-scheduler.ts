/**
 * Proactive Rebase Scheduler
 *
 * Detects stale branches (behind origin/main) before tasks are dispatched and
 * during periodic daemon scans, then auto-rebases them so agents never start
 * work on a stale base.
 *
 * Two entry points:
 *   1. `checkAndRebaseBeforeDispatch` — called from the dispatcher just before
 *      a task is sent to an agent.  Given the source_ref (owner/repo#N) it
 *      looks for an existing branch whose name contains the issue number, and
 *      auto-rebases it if it is stale.  Non-blocking: failures are logged but
 *      never abort the dispatch.
 *
 *   2. `runScheduledRebases` — called from the daemon's periodic cycle.  Scans
 *      all branches across agent repos, auto-rebases any that are behind main
 *      within the safe threshold, and records each attempt in the state store.
 */

import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";

const log = createLogger("proactive-rebase-scheduler");

/**
 * Branches this far behind origin/main or more will be proactively rebased.
 * Set low so stale lag is caught early, before conflicts accumulate.
 */
export const PROACTIVE_REBASE_THRESHOLD = 3; // commits

/**
 * Branches behind by more than this many commits are skipped.
 * They are either already stale-deleted (>STALE_BRANCH_BEHIND_THRESHOLD) or
 * carry too many divergent commits for a safe automated rebase.
 * Matches the cap used by the pre-submit validator.
 */
export const PROACTIVE_REBASE_MAX_BEHIND = 20; // commits

/** Outcome of a single proactive-rebase attempt. */
export type RebaseOutcome = "rebased" | "conflict" | "skipped" | "error";

export interface ProactiveRebaseResult {
  repo: string;
  branch: string;
  commitsBehind: number;
  outcome: RebaseOutcome;
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the number of commits `branch` is behind origin/main.
 * Uses the GitHub compare API when available (no local checkout needed).
 * Returns `null` when the count cannot be determined.
 */
function getBranchBehindCount(repo: string, branch: string): number | null {
  try {
    const raw = execSync(
      `gh api "repos/${repo}/compare/main...${encodeURIComponent(branch)}" --jq '.behind_by'`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    const n = parseInt(raw, 10);
    return isNaN(n) ? null : n;
  } catch {
    return null;
  }
}

/**
 * Attempt a rebase of `branch` onto origin/main in `localPath`.
 * Returns the outcome: "rebased", "conflict", or "error".
 */
function tryRebase(localPath: string, branch: string): Omit<RebaseOutcome, "skipped"> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.GIT_TERMINAL_PROMPT = "0";
  const opts = { cwd: localPath, encoding: "utf-8" as const, env, timeout: 60_000 };

  let prevBranch = "main";
  try {
    // Abort any leftover rebase state
    try { execSync("git rebase --abort", { ...opts, timeout: 5_000 }); } catch { /* ok */ }

    prevBranch = execSync("git rev-parse --abbrev-ref HEAD", { ...opts, timeout: 5_000 }).trim() || "main";
    execSync("git fetch origin", { ...opts, timeout: 30_000 });
    execSync(`git checkout ${branch}`, { ...opts, timeout: 15_000 });

    try {
      execSync("git rebase origin/main", opts);
    } catch {
      try { execSync("git rebase --abort", { ...opts, timeout: 5_000 }); } catch { /* ok */ }
      return "conflict";
    }

    execSync(`git push --force-with-lease origin ${branch}`, { ...opts, timeout: 30_000 });
    return "rebased";
  } catch {
    return "error";
  } finally {
    try { execSync(`git checkout ${prevBranch}`, { ...opts, timeout: 10_000 }); } catch { /* ok */ }
  }
}

/**
 * Resolve the local filesystem path for a repo by scanning agent configs.
 * Returns `null` when no agent owns the repo or its dir is not configured.
 */
function findLocalPath(config: OrchestratorConfig, repo: string): string | null {
  for (const [, agentCfg] of Object.entries(config.agents)) {
    if (agentCfg.github === repo && agentCfg.dir) {
      return agentCfg.dir;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-dispatch hook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a branch already exists for the issue referenced by
 * `sourceRef` and auto-rebase it if it is stale.
 *
 * Designed to be called from the dispatcher immediately before a task is
 * dispatched.  Never throws — all errors are logged and a result is returned.
 *
 * @param repo      The GitHub repo slug (e.g. "owner/repo").
 * @param sourceRef The issue source ref (e.g. "owner/repo#123").
 * @param config    Orchestrator config (for local path resolution).
 * @param store     State store (for recording the rebase event).
 */
export async function checkAndRebaseBeforeDispatch(
  repo: string,
  sourceRef: string,
  config: OrchestratorConfig,
  store: StateStore,
): Promise<ProactiveRebaseResult | null> {
  // Extract issue number from source_ref
  const issueMatch = sourceRef.match(/#(\d+)$/);
  if (!issueMatch) return null;
  const issueNumber = issueMatch[1];

  // Find all branches for this repo that reference this issue number
  let branches: string[] = [];
  try {
    const raw = execSync(
      `gh api "repos/${repo}/branches" --jq '.[].name'`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    if (!raw) return null;
    // Match branches whose name contains the issue number as a whole token
    const issuePattern = new RegExp(`(?:^|[-_/])${issueNumber}(?:[-_/]|$)`);
    branches = raw
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b && b !== "main" && b !== "master" && issuePattern.test(b));
  } catch {
    return null;
  }

  if (branches.length === 0) return null;

  // Use the first matching branch (most recently active is returned first by GitHub)
  const branch = branches[0];

  const commitsBehind = getBranchBehindCount(repo, branch);
  if (commitsBehind === null) {
    log.debug("Could not determine staleness — skipping pre-dispatch rebase", { repo, branch });
    return null;
  }

  if (commitsBehind === 0) {
    return {
      repo, branch, commitsBehind, outcome: "skipped",
      detail: "Branch is up to date with main — no rebase needed.",
    };
  }

  if (commitsBehind > PROACTIVE_REBASE_MAX_BEHIND) {
    const result: ProactiveRebaseResult = {
      repo, branch, commitsBehind, outcome: "skipped",
      detail: `Branch is ${commitsBehind} commit(s) behind main — too far behind for safe auto-rebase (max ${PROACTIVE_REBASE_MAX_BEHIND}).`,
    };
    store.recordProactiveRebase({
      repo, branch, sourceRef, commitsBehind, outcome: "skipped", detail: result.detail,
    });
    log.warn("Pre-dispatch rebase: branch too far behind main, skipping", {
      repo, branch, sourceRef, commitsBehind, max: PROACTIVE_REBASE_MAX_BEHIND,
    });
    return result;
  }

  if (commitsBehind < PROACTIVE_REBASE_THRESHOLD) {
    // Within acceptable lag — no rebase needed yet
    return {
      repo, branch, commitsBehind, outcome: "skipped",
      detail: `Branch is ${commitsBehind} commit(s) behind main — within acceptable threshold (${PROACTIVE_REBASE_THRESHOLD}).`,
    };
  }

  const localPath = findLocalPath(config, repo);
  if (!localPath) {
    const result: ProactiveRebaseResult = {
      repo, branch, commitsBehind, outcome: "skipped",
      detail: `No local repo path configured for ${repo} — cannot auto-rebase.`,
    };
    log.debug("Pre-dispatch rebase: no local path available", { repo, branch, sourceRef });
    return result;
  }

  log.info("Pre-dispatch rebase: branch is stale — attempting rebase", {
    repo, branch, sourceRef, commitsBehind,
  });

  const rawOutcome = tryRebase(localPath, branch);
  const outcome: RebaseOutcome = rawOutcome === "rebased" ? "rebased"
    : rawOutcome === "conflict" ? "conflict"
    : "error";

  const detail = outcome === "rebased"
    ? `Branch was ${commitsBehind} commit(s) behind main — auto-rebased and pushed before dispatch.`
    : outcome === "conflict"
    ? `Branch is ${commitsBehind} commit(s) behind main — rebase failed due to merge conflicts. Agent will need to resolve manually.`
    : `Branch is ${commitsBehind} commit(s) behind main — rebase attempt encountered an error. Proceeding with dispatch anyway.`;

  const result: ProactiveRebaseResult = { repo, branch, commitsBehind, outcome, detail };

  store.recordProactiveRebase({ repo, branch, sourceRef, commitsBehind, outcome, detail });

  log.info("Pre-dispatch rebase complete", { repo, branch, sourceRef, commitsBehind, outcome });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Periodic scan (daemon cycle)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan all branches across agent repos and proactively rebase any that are
 * behind origin/main by at least `PROACTIVE_REBASE_THRESHOLD` commits but
 * within `PROACTIVE_REBASE_MAX_BEHIND`.
 *
 * Designed to run on a periodic daemon cycle (every ~15 min).  All errors
 * are caught and logged individually so one failing repo never aborts the
 * full scan.
 *
 * @returns A summary of rebase outcomes keyed by repo/branch.
 */
export async function runScheduledRebases(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<ProactiveRebaseResult[]> {
  const results: ProactiveRebaseResult[] = [];

  for (const [, agentCfg] of Object.entries(config.agents)) {
    const repo = agentCfg.github;
    const localPath = agentCfg.dir ?? null;
    if (!repo) continue;

    let branches: string[] = [];
    try {
      const raw = execSync(
        `gh api "repos/${repo}/branches" --jq '.[].name'`,
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      branches = raw
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && b !== "main" && b !== "master");
    } catch (err) {
      log.warn("Scheduled rebase scan: failed to list branches", {
        repo, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Only process branches that already have (or had) a PR to avoid rebasing
    // scratch branches that are still in active development.
    let prBranches: Set<string> = new Set();
    try {
      const prRaw = execSync(
        `gh pr list --repo ${repo} --state all --json headRefName --jq '.[].headRefName'`,
        { encoding: "utf-8", timeout: 15_000 },
      ).trim();
      prBranches = new Set(prRaw.split("\n").map((b) => b.trim()).filter(Boolean));
    } catch {
      // Non-fatal: if we can't query PRs, skip this repo to avoid touching branches
      // that may not be ready for rebase.
      log.debug("Scheduled rebase scan: could not list PRs — skipping repo", { repo });
      continue;
    }

    for (const branch of branches) {
      // Only rebase branches associated with a PR (open or recently closed)
      if (!prBranches.has(branch)) continue;

      let commitsBehind: number | null = null;
      try {
        commitsBehind = getBranchBehindCount(repo, branch);
      } catch {
        continue;
      }

      if (commitsBehind === null || commitsBehind === 0) continue;

      if (commitsBehind > PROACTIVE_REBASE_MAX_BEHIND) {
        // Already handled by the stale-branch deleter — skip
        continue;
      }

      if (commitsBehind < PROACTIVE_REBASE_THRESHOLD) {
        // Within acceptable lag — no action needed
        continue;
      }

      if (!localPath) {
        log.debug("Scheduled rebase scan: no local path for repo — skipping branch", {
          repo, branch, commitsBehind,
        });
        continue;
      }

      log.info("Scheduled rebase: branch is stale — attempting rebase", {
        repo, branch, commitsBehind,
      });

      const rawOutcome = tryRebase(localPath, branch);
      const outcome: RebaseOutcome = rawOutcome === "rebased" ? "rebased"
        : rawOutcome === "conflict" ? "conflict"
        : "error";

      const detail = outcome === "rebased"
        ? `Scheduled rebase: branch was ${commitsBehind} commit(s) behind main — rebased and pushed.`
        : outcome === "conflict"
        ? `Scheduled rebase: branch is ${commitsBehind} commit(s) behind main — rebase failed (conflicts). Manual resolution required.`
        : `Scheduled rebase: branch is ${commitsBehind} commit(s) behind main — rebase attempt failed with an error.`;

      const result: ProactiveRebaseResult = { repo, branch, commitsBehind, outcome, detail };
      results.push(result);

      store.recordProactiveRebase({
        repo, branch, sourceRef: null, commitsBehind, outcome, detail,
      });

      log.info("Scheduled rebase complete", { repo, branch, commitsBehind, outcome });
    }
  }

  return results;
}
