import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";

const log = createLogger("pr-creator");

export interface OrphanBranch {
  repo: string;
  branch: string;
  agentName: string;
}

/**
 * Find branches that have been pushed, have commits ahead of main,
 * and don't have open PRs. Creates PRs for them.
 */
export function findOrphanBranches(config: OrchestratorConfig): OrphanBranch[] {
  const orphans: OrphanBranch[] = [];

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;

    try {
      // Get open PR branches
      const prsRaw = execSync(
        `gh pr list --repo ${agent.github} --state open --json headRefName --jq '.[].headRefName'`,
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

        // Check if branch has commits ahead of main
        try {
          const ahead = execSync(
            `gh api "repos/${agent.github}/compare/main...${branch}" --jq '.ahead_by'`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          if (parseInt(ahead, 10) > 0) {
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

export function createPRForBranch(orphan: OrphanBranch): string | null {
  try {
    const url = execSync(
      `gh pr create --repo ${orphan.repo} --head ${orphan.branch} --title "[${orphan.agentName}] ${orphan.branch}" --body "Auto-created by orchestrator for orphan branch."`,
      { encoding: "utf-8", timeout: 30000 },
    ).trim();

    log.info("Created PR for orphan branch", { repo: orphan.repo, branch: orphan.branch, url });
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
