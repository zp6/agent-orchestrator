import { execSync } from "node:child_process";
import { createLogger } from "../service/logger.js";
import { findMatchingIssueNumber } from "./pr-creator.js";
import type { OrchestratorConfig } from "../config/schema.js";

const log = createLogger("pre-submit-validator");

export interface PreSubmitCheck {
  passed: boolean;
  detail: string;
}

export interface PreSubmitValidationResult {
  valid: boolean;
  checks: {
    issueRef: PreSubmitCheck;
    branchFresh: PreSubmitCheck;
  };
  /** Hard failures that must be fixed before the PR can be submitted. */
  blockers: string[];
  /** Non-blocking observations (e.g. CI not yet run). */
  warnings: string[];
  /** If inferred during validation, the matching issue number. */
  inferredIssueNumber?: string;
}

/**
 * Validate a PR body contains "Closes #N" (case-insensitive).
 * Optionally tries to infer the issue number from the branch name if missing.
 */
export async function validateIssueRef(
  body: string,
  repo: string,
  branch: string,
  config?: OrchestratorConfig,
): Promise<{ check: PreSubmitCheck; inferredIssueNumber?: string }> {
  const hasRef = /(?:closes|fixes|resolves)\s+#\d+/i.test(body);

  if (hasRef) {
    return {
      check: {
        passed: true,
        detail: 'PR body contains a "Closes #N" reference.',
      },
    };
  }

  // No ref found — try to infer from the branch name
  let inferredIssueNumber: string | undefined;
  try {
    const inferred = await findMatchingIssueNumber(repo, branch, config);
    if (inferred) {
      inferredIssueNumber = inferred;
      return {
        check: {
          passed: false,
          detail: `PR body is missing "Closes #N". Inferred issue #${inferred} from branch "${branch}" — add 'Closes #${inferred}' to the PR body.`,
        },
        inferredIssueNumber,
      };
    }
  } catch {
    // If lookup fails, report as missing ref without a suggestion
  }

  return {
    check: {
      passed: false,
      detail: `PR body is missing a "Closes #N" reference and no matching issue could be found for branch "${branch}". Run \`gh issue list --repo ${repo} --state open\` to find the relevant issue.`,
    },
  };
}

/**
 * Check whether a branch is up to date with origin/main.
 * Uses the GitHub compare API when a repo slug is available,
 * or falls back to local git commands when a localPath is provided.
 *
 * Returns a check indicating whether the branch needs rebasing.
 */
export function validateBranchFreshness(
  repo: string,
  branch: string,
  localPath: string | null,
): PreSubmitCheck {
  // Try GitHub API first (works without a local checkout)
  if (repo) {
    try {
      const raw = execSync(
        `gh api "repos/${repo}/compare/main...${branch}" --jq '.behind_by'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      const behindBy = parseInt(raw, 10);

      if (isNaN(behindBy)) {
        return {
          passed: true,
          detail: "Could not determine branch freshness via API — skipping staleness check.",
        };
      }

      if (behindBy === 0) {
        return {
          passed: true,
          detail: "Branch is up to date with main.",
        };
      }

      return {
        passed: false,
        detail: `Branch "${branch}" is ${behindBy} commit(s) behind main. Rebase before submitting: \`git fetch origin && git rebase origin/main && git push --force-with-lease\`.`,
      };
    } catch {
      // API call failed — fall through to local git check
    }
  }

  // Fall back to local git comparison
  if (localPath) {
    try {
      execSync("git fetch origin", { cwd: localPath, encoding: "utf-8", timeout: 30000 });
      const behindRaw = execSync(
        `git rev-list --count HEAD..origin/main`,
        { cwd: localPath, encoding: "utf-8", timeout: 10000 },
      ).trim();
      const behindBy = parseInt(behindRaw, 10);

      if (behindBy > 0) {
        return {
          passed: false,
          detail: `Branch is ${behindBy} commit(s) behind origin/main. Rebase before submitting: \`git rebase origin/main && git push --force-with-lease\`.`,
        };
      }

      return { passed: true, detail: "Branch is up to date with origin/main." };
    } catch {
      // Local check failed — treat as warning, not blocker
      return {
        passed: true,
        detail: "Could not determine branch freshness locally — skipping staleness check.",
      };
    }
  }

  return {
    passed: true,
    detail: "No local path available — skipping branch freshness check.",
  };
}

/**
 * Run all pre-submit checks for a PR about to be created.
 *
 * Checks performed:
 * 1. **issueRef** — PR body contains "Closes #N" (or an issue can be inferred)
 * 2. **branchFresh** — branch is not behind origin/main
 *
 * Returns a `PreSubmitValidationResult` with `valid: true` only when all
 * blocking checks pass. Non-blocking observations are reported as `warnings`.
 */
export async function validatePreSubmit(
  repo: string,
  branch: string,
  prBody: string,
  localPath: string | null,
  config?: OrchestratorConfig,
): Promise<PreSubmitValidationResult> {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // --- Check 1: Issue reference in PR body ---
  const { check: issueRefCheck, inferredIssueNumber } = await validateIssueRef(
    prBody,
    repo,
    branch,
    config,
  );

  if (!issueRefCheck.passed) {
    blockers.push(issueRefCheck.detail);
  }

  // --- Check 2: Branch freshness (not behind main) ---
  const branchFreshCheck = validateBranchFreshness(repo, branch, localPath);

  if (!branchFreshCheck.passed) {
    blockers.push(branchFreshCheck.detail);
  }

  const valid = blockers.length === 0;

  log.info("Pre-submit validation complete", {
    repo,
    branch,
    valid,
    blockers: blockers.length,
    warnings: warnings.length,
    inferredIssueNumber,
  });

  return {
    valid,
    checks: {
      issueRef: issueRefCheck,
      branchFresh: branchFreshCheck,
    },
    blockers,
    warnings,
    ...(inferredIssueNumber ? { inferredIssueNumber } : {}),
  };
}

/**
 * Format a validation result as a human-readable summary suitable for
 * logging or posting as a PR comment.
 */
export function formatValidationSummary(result: PreSubmitValidationResult): string {
  const lines: string[] = ["**Pre-submit validation report**", ""];

  const checkIcon = (passed: boolean) => (passed ? "✅" : "❌");

  lines.push(`${checkIcon(result.checks.issueRef.passed)} **Issue reference**: ${result.checks.issueRef.detail}`);
  lines.push(`${checkIcon(result.checks.branchFresh.passed)} **Branch freshness**: ${result.checks.branchFresh.detail}`);

  if (result.warnings.length > 0) {
    lines.push("", "**Warnings:**");
    for (const w of result.warnings) lines.push(`- ⚠️ ${w}`);
  }

  if (!result.valid) {
    lines.push("", "**Action required before PR can be submitted:**");
    for (const b of result.blockers) lines.push(`- ${b}`);
  }

  return lines.join("\n");
}
