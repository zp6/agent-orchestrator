import { execAsync } from "../utils/exec-async.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("merge-stall-guard");

/**
 * Default stale threshold (hours) after which a MERGEABLE PR is considered
 * "rotting" and blocks new dispatches for its agent.
 *
 * Configurable via `triggers.merge_stall_threshold_hours` in agents.yaml.
 */
export const DEFAULT_MERGE_STALL_THRESHOLD_HOURS = 4;

let configuredThresholdHours: number | undefined;

/**
 * Set the merge-stall threshold from the loaded config.
 * Called once at daemon startup.
 */
export function setMergeStallThresholdHours(hours: number | undefined): void {
  configuredThresholdHours = hours;
}

/**
 * Get the effective merge-stall threshold (config override or default).
 */
export function getMergeStallThresholdHours(): number {
  return configuredThresholdHours ?? DEFAULT_MERGE_STALL_THRESHOLD_HOURS;
}

export interface MergeablePR {
  number: number;
  title: string;
  url: string;
  repo: string;
  updatedAt: string;
  headRefName: string;
  /** PR author login (used by auto-merge sweep allowlist) */
  authorLogin: string;
  /** Hours since last update */
  staleHours: number;
}

export interface MergeStallCheckResult {
  /** Whether this agent should be blocked from new dispatches */
  blocked: boolean;
  /** Human-readable reason */
  reason: string;
  /** The stale MERGEABLE PRs causing the block */
  stalePRs: MergeablePR[];
}

/**
 * Check whether an agent has stale MERGEABLE PRs that should block new
 * dispatches.
 *
 * The guard queries GitHub for open PRs in the agent's repo that are in a
 * mergeable state (CI passing, no conflicts, not draft) and have not been
 * updated within the stale threshold. If any are found, the agent is blocked
 * from receiving new work — it should land its existing PRs first.
 *
 * Fails open on any error: if we can't query GitHub, the agent proceeds with
 * dispatch rather than being permanently blocked.
 */
export async function checkMergeStall(
  repo: string,
  agentName: string,
  execFn: (cmd: string, opts: { encoding?: "utf-8"; timeout: number }) => Promise<string> = (cmd, opts) =>
    execAsync(cmd, opts),
): Promise<MergeStallCheckResult> {
  const thresholdHours = getMergeStallThresholdHours();
  const now = Date.now();

  try {
    const raw = await execFn(
      `gh pr list --repo ${repo} --state open --json number,title,url,updatedAt,headRefName,isDraft,reviewDecision,statusCheckRollup,author --limit 50`,
      { encoding: "utf-8", timeout: 15000 },
    );

    const prs = JSON.parse(raw.trim() || "[]") as Array<{
      number: number;
      title: string;
      url: string;
      updatedAt: string;
      headRefName: string;
      isDraft: boolean;
      reviewDecision: string;
      statusCheckRollup: Array<{ conclusion: string; state: string }> | null;
      author: { login: string } | null;
    }>;

    const stalePRs: MergeablePR[] = [];

    for (const pr of prs) {
      // Skip draft PRs — they're intentionally not ready
      if (pr.isDraft) continue;

      // Check if CI is passing (all checks concluded with SUCCESS)
      const checks = pr.statusCheckRollup ?? [];
      const ciPassing =
        checks.length > 0 && checks.every((c) => c.conclusion === "SUCCESS");
      if (!ciPassing) continue;

      // Check staleness
      const updatedAt = new Date(pr.updatedAt).getTime();
      const ageHours = (now - updatedAt) / (1000 * 60 * 60);
      if (ageHours < thresholdHours) continue;

      stalePRs.push({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        repo,
        updatedAt: pr.updatedAt,
        headRefName: pr.headRefName,
        authorLogin: pr.author?.login ?? "",
        staleHours: Math.round(ageHours * 10) / 10,
      });
    }

    if (stalePRs.length === 0) {
      return {
        blocked: false,
        reason: `No stale MERGEABLE PRs for ${agentName} in ${repo}`,
        stalePRs: [],
      };
    }

    const prNumbers = stalePRs.map((pr) => `#${pr.number}`).join(", ");
    log.warn("Merge-stall guard: blocking dispatch — agent has stale MERGEABLE PRs", {
      agentName,
      repo,
      stalePRCount: stalePRs.length,
      prNumbers,
      thresholdHours,
    });

    return {
      blocked: true,
      reason: `${agentName} has ${stalePRs.length} stale MERGEABLE PR(s) in ${repo} (${prNumbers}) — land before launching new work`,
      stalePRs,
    };
  } catch (err) {
    // Fail open: if we can't query GitHub, don't block dispatch
    log.warn("Merge-stall guard failed — proceeding with dispatch", {
      agentName,
      repo,
      error: err instanceof Error ? err.message : String(err),
    });

    return {
      blocked: false,
      reason: `Guard error: ${err instanceof Error ? err.message : String(err)} — proceeding with dispatch`,
      stalePRs: [],
    };
  }
}

/**
 * Scan all repos for stale MERGEABLE PRs across the fleet.
 *
 * Used by `orch merge-sweep` CLI command to surface the full merge backlog.
 * Returns all stale MERGEABLE PRs grouped by repo.
 */
export async function scanFleetMergeStalls(
  repos: string[],
  execFn?: (cmd: string, opts: { encoding?: "utf-8"; timeout: number }) => Promise<string>,
): Promise<MergeablePR[]> {
  const allStale: MergeablePR[] = [];

  for (const repo of repos) {
    const result = await checkMergeStall(repo, repo.split("/").pop() ?? repo, execFn);
    allStale.push(...result.stalePRs);
  }

  // Sort by stale hours descending (most rotten first)
  allStale.sort((a, b) => b.staleHours - a.staleHours);
  return allStale;
}

export interface MergeResult {
  pr: MergeablePR;
  success: boolean;
  error?: string;
}

/**
 * Attempt to squash-merge a single PR via the GitHub CLI.
 *
 * Returns a MergeResult indicating success or failure.
 * Never throws — failures are captured in the result.
 */
export async function mergePR(
  pr: MergeablePR,
  execFn: (cmd: string, opts: { encoding?: "utf-8"; timeout: number }) => Promise<string> = (cmd, opts) =>
    execAsync(cmd, opts),
): Promise<MergeResult> {
  try {
    await execFn(
      `gh pr merge ${pr.number} --repo ${pr.repo} --squash --delete-branch`,
      { encoding: "utf-8", timeout: 30000 },
    );

    log.info("Auto-merged stale PR", {
      repo: pr.repo,
      prNumber: pr.number,
      title: pr.title,
      staleHours: pr.staleHours,
    });

    return { pr, success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("Failed to auto-merge PR", {
      repo: pr.repo,
      prNumber: pr.number,
      error,
    });

    return { pr, success: false, error };
  }
}

/**
 * Auto-merge all stale MERGEABLE PRs across the fleet.
 *
 * Used by `orch merge-sweep --execute` to land rotting PRs.
 * Merges sequentially (one at a time) to avoid race conditions.
 */
export async function autoMergeFleetPRs(
  prs: MergeablePR[],
  execFn?: (cmd: string, opts: { encoding?: "utf-8"; timeout: number }) => Promise<string>,
): Promise<MergeResult[]> {
  const results: MergeResult[] = [];

  for (const pr of prs) {
    const result = await (execFn ? mergePR(pr, execFn) : mergePR(pr));
    results.push(result);
  }

  return results;
}

// ── Auto-merge sweep helpers (issue #1587) ──────────────────────────────────

export interface AutoMergeSweepConfig {
  /** Master kill switch (false = sweep skipped entirely). */
  enabled: boolean;
  /** PR-author logins eligible for auto-merge. External contributors must be excluded. */
  authorAllowlist: Set<string>;
  /** Maximum successful auto-merges per trailing 24h window. */
  dailyCap: number;
}

export interface SelectMergeCandidatesResult {
  /** True when no merges should be attempted this sweep. */
  skipped: boolean;
  /** Why the sweep was skipped, if it was. */
  reason?: "disabled" | "no-stale" | "no-eligible" | "daily-cap";
  /** PRs the daemon should attempt to merge. */
  toMerge: MergeablePR[];
  /** Eligible PRs that exceeded the daily cap and were deferred. */
  deferred: number;
}

/**
 * Pure function that decides which stale PRs to merge in a sweep cycle.
 *
 * Splits the decision logic out of the daemon so it can be tested without
 * spinning up a Daemon instance. The daemon method composes:
 *   stale = await scanFleetMergeStalls(repos);
 *   merged24h = store.countAutoMergesIn(24*60*60*1000);
 *   const decision = selectMergeCandidates(stale, config, merged24h);
 *   if (decision.skipped) return;
 *   const results = await autoMergeFleetPRs(decision.toMerge);
 *   for (const r of results) store.recordAutoMerge(...);
 */
export function selectMergeCandidates(
  stale: MergeablePR[],
  config: AutoMergeSweepConfig,
  merged24h: number,
): SelectMergeCandidatesResult {
  if (!config.enabled) {
    return { skipped: true, reason: "disabled", toMerge: [], deferred: 0 };
  }
  if (stale.length === 0) {
    return { skipped: true, reason: "no-stale", toMerge: [], deferred: 0 };
  }
  const eligible = stale.filter((pr) => config.authorAllowlist.has(pr.authorLogin));
  if (eligible.length === 0) {
    return { skipped: true, reason: "no-eligible", toMerge: [], deferred: 0 };
  }
  const remaining = config.dailyCap - merged24h;
  if (remaining <= 0) {
    return { skipped: true, reason: "daily-cap", toMerge: [], deferred: eligible.length };
  }
  if (remaining >= eligible.length) {
    return { skipped: false, toMerge: eligible, deferred: 0 };
  }
  return { skipped: false, toMerge: eligible.slice(0, remaining), deferred: eligible.length - remaining };
}
