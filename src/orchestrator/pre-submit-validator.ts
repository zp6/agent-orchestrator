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
    prExists: PreSubmitCheck;
    mergeConflicts: PreSubmitCheck;
    testsPass: PreSubmitCheck;
    unrelatedFiles: PreSubmitCheck;
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
 * Check whether an open PR already exists for the given branch on the repo.
 * Returns a failing check if an open PR is found (duplicate PR guard).
 */
export function validatePRExists(repo: string, branch: string): PreSubmitCheck {
  if (!repo || !branch) {
    return {
      passed: true,
      detail: "No repo or branch provided — skipping duplicate PR check.",
    };
  }

  try {
    const raw = execSync(
      `gh pr list --repo ${repo} --state open --json number,headRefName --jq '.[] | select(.headRefName == "${branch}") | .number'`,
      { encoding: "utf-8", timeout: 15000 },
    ).trim();

    if (raw) {
      const prNumber = raw.split("\n")[0].trim();
      return {
        passed: false,
        detail: `An open PR (#${prNumber}) already exists for branch "${branch}" on ${repo}. Push to the existing branch instead of creating a new PR.`,
      };
    }

    return {
      passed: true,
      detail: `No open PR exists for branch "${branch}" — safe to create.`,
    };
  } catch {
    // If the check fails, fail-open (don't block PRs because of a lookup error)
    return {
      passed: true,
      detail: "Could not check for existing PRs — skipping duplicate PR check.",
    };
  }
}

/**
 * Check whether a branch has merge conflicts with origin/main.
 * Uses the GitHub compare API (status field) when repo is provided,
 * or falls back to a local `git merge --no-commit --no-ff` dry-run.
 *
 * Fails-open: if neither check can run, the result is "passed" to avoid
 * blocking PRs solely due to an inability to verify.
 */
export function validateMergeConflicts(
  repo: string,
  branch: string,
  localPath: string | null,
): PreSubmitCheck {
  // Try GitHub compare API first — "diverged" status may indicate conflicts;
  // "conflicting" is the definitive signal when the API provides it.
  if (repo) {
    try {
      const status = execSync(
        `gh api "repos/${repo}/compare/main...${branch}" --jq '.status'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();

      if (status === "diverged") {
        // "diverged" means both branches have moved; conflicts may exist.
        // We treat this as a warning that the branch should be rebased but
        // don't hard-fail here (validateBranchFreshness will catch staleness).
        return {
          passed: true,
          detail: "Branch has diverged from main — ensure you have rebased to resolve any conflicts.",
        };
      }

      if (status === "conflicting") {
        return {
          passed: false,
          detail: `Branch "${branch}" has merge conflicts with main. Resolve conflicts before submitting: \`git fetch origin && git rebase origin/main\`.`,
        };
      }

      return {
        passed: true,
        detail: "No merge conflicts detected with main.",
      };
    } catch {
      // API call failed — fall through to local check
    }
  }

  // Fall back to local dry-run merge
  if (localPath) {
    try {
      execSync("git fetch origin", { cwd: localPath, encoding: "utf-8", timeout: 30000 });
      // Attempt a no-commit, no-ff merge to detect conflicts without touching the working tree
      try {
        execSync("git merge origin/main --no-commit --no-ff", {
          cwd: localPath,
          encoding: "utf-8",
          timeout: 30000,
        });
        // Clean up the merge state
        execSync("git merge --abort", { cwd: localPath, encoding: "utf-8", timeout: 10000 });
        return { passed: true, detail: "No merge conflicts detected with origin/main." };
      } catch (mergeErr) {
        // merge --no-commit exits non-zero on conflicts
        try {
          execSync("git merge --abort", { cwd: localPath, encoding: "utf-8", timeout: 10000 });
        } catch {
          // ignore abort errors
        }
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        if (msg.includes("CONFLICT") || msg.includes("conflict")) {
          return {
            passed: false,
            detail: `Branch has merge conflicts with origin/main. Resolve conflicts before submitting: \`git rebase origin/main\`.`,
          };
        }
        // Non-conflict merge error — fail-open
        return {
          passed: true,
          detail: "Could not complete merge conflict check locally — skipping.",
        };
      }
    } catch {
      return {
        passed: true,
        detail: "Could not run local merge conflict check — skipping.",
      };
    }
  }

  return {
    passed: true,
    detail: "No local path available — skipping merge conflict check.",
  };
}

/**
 * Files that are auto-generated, deployment markers, or secrets that should
 * never be committed as part of a feature branch PR. Any branch that touches
 * these files will be flagged as having unrelated changes.
 */
export const ALWAYS_EXCLUDED_FILES: readonly string[] = [
  ".orchestrator-deploy-sha",
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
];

/**
 * Check whether a branch contains obviously unrelated or problematic files.
 * Uses the GitHub compare API to enumerate changed files when a repo slug is
 * available, or falls back to a local `git diff --name-only origin/main`.
 *
 * Flags files that are auto-generated metadata (e.g. `.orchestrator-deploy-sha`)
 * or secret-adjacent (`.env*`). These should never be committed as part of a
 * feature branch PR.
 *
 * Fails-open: if neither check can run, the result is "passed" with a note.
 */
export function validateUnrelatedFiles(
  repo: string,
  branch: string,
  localPath: string | null,
): PreSubmitCheck {
  let changedFiles: string[] = [];

  // Try GitHub API first (works without a local checkout)
  if (repo && branch) {
    try {
      const raw = execSync(
        `gh api "repos/${repo}/compare/main...${branch}" --jq '[.files[].filename] | join("\\n")'`,
        { encoding: "utf-8", timeout: 15000 },
      ).trim();
      if (raw) changedFiles = raw.split("\n").filter(Boolean);
    } catch {
      // Fall through to local check
    }
  }

  // Fall back to local git diff
  if (changedFiles.length === 0 && localPath) {
    try {
      execSync("git fetch origin", { cwd: localPath, encoding: "utf-8", timeout: 30000 });
      const raw = execSync("git diff --name-only origin/main", {
        cwd: localPath,
        encoding: "utf-8",
        timeout: 15000,
      }).trim();
      if (raw) changedFiles = raw.split("\n").filter(Boolean);
    } catch {
      // Can't determine changed files
    }
  }

  if (changedFiles.length === 0) {
    return {
      passed: true,
      detail: "Could not determine changed files — skipping unrelated files check.",
    };
  }

  // Check for always-excluded files
  const problematic = changedFiles.filter((f) =>
    ALWAYS_EXCLUDED_FILES.some(
      (excluded) => f === excluded || f.endsWith(`/${excluded}`),
    ),
  );

  if (problematic.length > 0) {
    return {
      passed: false,
      detail: `Branch contains files that must not be committed in a feature PR: ${problematic.join(", ")}. Remove these from the branch before submitting (use \`git rm --cached <file>\` or amend the offending commit).`,
    };
  }

  return {
    passed: true,
    detail: `${changedFiles.length} changed file(s) look appropriate for a PR.`,
  };
}

/**
 * Check whether the TypeScript type-check and unit tests pass on the local
 * repo checkout. Runs `npx tsc --noEmit` followed by `npx vitest run`.
 *
 * Skips gracefully (fail-open) when no local path is available or when the
 * directory does not contain a `package.json`.
 *
 * Both commands are capped with a timeout to avoid blocking the daemon
 * indefinitely on slow test suites.
 */
export function validateTestsPass(localPath: string | null): PreSubmitCheck {
  if (!localPath) {
    return {
      passed: true,
      detail: "No local path available — skipping test check.",
    };
  }

  // Verify package.json exists so we know we're in a Node project
  try {
    execSync("test -f package.json", { cwd: localPath, encoding: "utf-8", timeout: 5000 });
  } catch {
    return {
      passed: true,
      detail: "No package.json found — skipping test check.",
    };
  }

  // TypeScript type-check
  try {
    execSync("npx tsc --noEmit", {
      cwd: localPath,
      encoding: "utf-8",
      timeout: 120000, // 2 min
    });
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      detail: `TypeScript type check failed. Fix type errors before submitting.\n${output.slice(0, 600)}`,
    };
  }

  // Unit tests
  try {
    execSync("npx vitest run", {
      cwd: localPath,
      encoding: "utf-8",
      timeout: 180000, // 3 min
    });
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    return {
      passed: false,
      detail: `Unit tests failed. Fix failing tests before submitting.\n${output.slice(0, 600)}`,
    };
  }

  return {
    passed: true,
    detail: "TypeScript type check and unit tests passed.",
  };
}

/**
 * Run all pre-submit checks for a PR about to be created.
 *
 * Checks performed:
 * 1. **issueRef** — PR body contains "Closes #N" (or an issue can be inferred)
 * 2. **branchFresh** — branch is not behind origin/main
 * 3. **prExists** — no open PR already exists for this branch (duplicate guard)
 * 4. **mergeConflicts** — branch has no merge conflicts with main
 * 5. **testsPass** — TypeScript type check and unit tests pass locally
 * 6. **unrelatedFiles** — branch contains no auto-generated/secrets files
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

  // --- Check 3: No open PR already exists for this branch ---
  const prExistsCheck = validatePRExists(repo, branch);

  if (!prExistsCheck.passed) {
    blockers.push(prExistsCheck.detail);
  }

  // --- Check 4: No merge conflicts with main ---
  const mergeConflictsCheck = validateMergeConflicts(repo, branch, localPath);

  if (!mergeConflictsCheck.passed) {
    blockers.push(mergeConflictsCheck.detail);
  }

  // --- Check 5: Tests pass locally ---
  const testsPassCheck = validateTestsPass(localPath);

  if (!testsPassCheck.passed) {
    blockers.push(testsPassCheck.detail);
  }

  // --- Check 6: No unrelated/excluded files in the branch ---
  const unrelatedFilesCheck = validateUnrelatedFiles(repo, branch, localPath);

  if (!unrelatedFilesCheck.passed) {
    blockers.push(unrelatedFilesCheck.detail);
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
      prExists: prExistsCheck,
      mergeConflicts: mergeConflictsCheck,
      testsPass: testsPassCheck,
      unrelatedFiles: unrelatedFilesCheck,
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
  lines.push(`${checkIcon(result.checks.prExists.passed)} **No duplicate PR**: ${result.checks.prExists.detail}`);
  lines.push(`${checkIcon(result.checks.mergeConflicts.passed)} **Merge conflicts**: ${result.checks.mergeConflicts.detail}`);
  lines.push(`${checkIcon(result.checks.testsPass.passed)} **Tests pass**: ${result.checks.testsPass.detail}`);
  lines.push(`${checkIcon(result.checks.unrelatedFiles.passed)} **No unrelated files**: ${result.checks.unrelatedFiles.detail}`);

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
