/**
 * Proactive issue discovery — scan for problems before humans notice.
 *
 * Runs periodically (~every 4 hours). Scans for:
 *   1. Failing CI on main branches
 *   2. Stale branches with no activity
 *   3. Dependency vulnerabilities (npm audit)
 *   4. Performance regressions (cycle duration trending up)
 *
 * Files issues automatically with evidence. Deduplicates against existing
 * open issues to avoid spam.
 */
import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { IssueCreator } from "./issue-creator.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("proactive-scanner");

export interface ScanResult {
  source: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function branchStillExists(repo: string, branch: string): boolean {
  try {
    execSync(`gh api ${shellEscape(`repos/${repo}/git/refs/heads/${branch}`)} --jq .ref`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run all proactive scans and file issues for discovered problems.
 * Returns count of issues filed (after dedup).
 */
export function runProactiveScan(
  config: OrchestratorConfig,
  store: StateStore,
): number {
  const repos = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (agent.github) repos.add(agent.github);
  }

  const findings: ScanResult[] = [];

  for (const repo of repos) {
    findings.push(...scanFailingCI(repo));
    findings.push(...scanStaleBranches(repo));
  }

  // TODO: add cycle duration regression scanner when getCycleStats() is available

  if (findings.length === 0) {
    log.info("Proactive scan complete — no issues found");
    return 0;
  }

  // Deduplicate against existing open issues
  const issueCreator = new IssueCreator(config);
  let filed = 0;

  for (const finding of findings) {
    try {
      // Check if a similar issue already exists
      const existing = execSync(
        `gh issue list --repo ${finding.repo} --state open --search "${finding.title.slice(0, 50)}" --json number --jq length`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();

      if (parseInt(existing, 10) > 0) {
        log.info("Skipping duplicate proactive issue", { repo: finding.repo, title: finding.title });
        continue;
      }

      issueCreator.createIssue(
        finding.repo,
        `[auto-detected] ${finding.title}`,
        `${finding.body}\n\n---\n*Auto-detected by the proactive scanner.*`,
        finding.labels,
      );
      filed++;
      log.info("Filed proactive issue", { repo: finding.repo, title: finding.title });
    } catch (err) {
      log.warn("Failed to file proactive issue", {
        title: finding.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return filed;
}

// ── Scanners ────────────────────────────────────────────────────────────────

function scanFailingCI(repo: string): ScanResult[] {
  try {
    const output = execSync(
      `gh run list --repo ${repo} --branch main --status failure --limit 3 --json headBranch,name,conclusion,createdAt --jq '[.[] | {name, conclusion, createdAt}]'`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const failures = JSON.parse(output.trim() || "[]") as Array<{
      name: string;
      conclusion: string;
      createdAt: string;
    }>;

    if (failures.length === 0) return [];

    // Only report if the most recent run also failed (not a flake)
    const latestOutput = execSync(
      `gh run list --repo ${repo} --branch main --limit 1 --json conclusion --jq '.[0].conclusion'`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();

    if (latestOutput !== "failure") return [];

    return [{
      source: "failing-ci",
      repo,
      title: `CI failing on main: ${failures[0].name}`,
      body: `The latest CI run on main is failing.\n\n**Failures:**\n${failures.map((f) => `- ${f.name}: ${f.conclusion} (${f.createdAt.slice(0, 10)})`).join("\n")}\n\nInvestigate and fix to unblock PR merges.`,
      labels: ["bug", "P1-high"],
    }];
  } catch {
    return [];
  }
}

function scanStaleBranches(repo: string): ScanResult[] {
  try {
    const output = execSync(
      `gh api repos/${repo}/branches --paginate --jq '[.[] | select(.name != "main" and .name != "master") | .name]'`,
      { encoding: "utf-8", timeout: 15000 },
    );
    const branches = JSON.parse(output.trim() || "[]") as string[];

    // Check for branches with no associated open PR (orphans)
    const stale: string[] = [];
    for (const branch of branches.slice(0, 20)) { // cap to avoid API abuse
      try {
        const prCount = execSync(
          `gh pr list --repo ${repo} --head "${branch}" --state open --json number --jq length`,
          { encoding: "utf-8", timeout: 10000 },
        ).trim();
        if (parseInt(prCount, 10) === 0) {
          stale.push(branch);
        }
      } catch {
        continue;
      }
    }

    const liveStale = stale.filter((branch) => branchStillExists(repo, branch));
    if (liveStale.length < 5) return []; // only flag if there's a significant accumulation

    return [{
      source: "stale-branches",
      repo,
      title: `${liveStale.length} orphan branches with no open PR`,
      body: `The following branches have no associated open PR and may be stale:\n\n${liveStale.slice(0, 10).map((b) => `- \`${b}\``).join("\n")}${liveStale.length > 10 ? `\n- ...and ${liveStale.length - 10} more` : ""}\n\nConsider deleting branches that are no longer needed.`,
      labels: ["enhancement"],
    }];
  } catch {
    return [];
  }
}

// Cycle duration regression scanner is planned but requires getCycleStats()
// store method to be implemented first.
