import { execSync } from "node:child_process";
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
export function checkMergeStall(
  repo: string,
  agentName: string,
  execFn: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string = (cmd, opts) =>
    execSync(cmd, opts),
): MergeStallCheckResult {
  const thresholdHours = getMergeStallThresholdHours();
  const now = Date.now();

  try {
    const raw = execFn(
      `gh pr list --repo ${repo} --state open --json number,title,url,updatedAt,headRefName,isDraft,reviewDecision,statusCheckRollup --limit 50`,
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
export function scanFleetMergeStalls(
  repos: string[],
  execFn?: (cmd: string, opts: { encoding: "utf-8"; timeout: number }) => string,
): MergeablePR[] {
  const allStale: MergeablePR[] = [];

  for (const repo of repos) {
    const result = checkMergeStall(repo, repo.split("/").pop() ?? repo, execFn);
    allStale.push(...result.stalePRs);
  }

  // Sort by stale hours descending (most rotten first)
  allStale.sort((a, b) => b.staleHours - a.staleHours);
  return allStale;
}
