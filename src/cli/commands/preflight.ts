import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import {
  validatePreSubmit,
  type PreSubmitValidationResult,
} from "../../orchestrator/pre-submit-validator.js";

/**
 * `orch preflight` — run the PR pre-flight checklist before `gh pr create`.
 *
 * Checks (in order):
 *   1. Issue reference   — PR body includes "Closes #N" / "Fixes #N" / "Resolves #N"
 *   2. Branch freshness  — branch is not behind origin/main
 *   3. Duplicate PR      — no open PR already exists for this branch
 *   4. Merge conflicts   — branch has no merge conflicts with main
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed (blockers present)
 *   2 — usage or config error
 */
export function registerPreflightCommand(program: Command): void {
  program
    .command("preflight")
    .description(
      "Run the PR pre-flight checklist for a branch before gh pr create",
    )
    .requiredOption("--repo <owner/repo>", "GitHub repository (e.g. acme/my-repo)")
    .requiredOption("--branch <name>", "Branch name to validate")
    .option(
      "--body <text>",
      'PR body draft (used to check for "Closes #N"). If omitted, only the branch name is checked for an issue reference.',
      "",
    )
    .option(
      "--local-path <path>",
      "Path to a local checkout of the repo (enables local git fallbacks)",
    )
    .option("--json", "Output raw JSON instead of the human-readable report")
    .action(
      async (opts: {
        repo: string;
        branch: string;
        body: string;
        localPath?: string;
        json?: boolean;
      }) => {
        let config;
        try {
          config = loadConfig(program.opts().config);
        } catch {
          // Config is optional for preflight — it's only used for LLM-based issue
          // disambiguation. If it fails to load we simply skip that tier.
          config = undefined;
        }

        console.log(
          chalk.bold(`\nPre-flight checklist for ${opts.repo} / ${chalk.cyan(opts.branch)}\n`),
        );

        const result = await validatePreSubmit(
          opts.repo,
          opts.branch,
          opts.body,
          opts.localPath ?? null,
          config,
        );

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          process.exit(result.valid ? 0 : 1);
        }

        // Human-readable report
        printChecklist(result);

        if (result.valid) {
          console.log(chalk.green.bold("\n✅ All checks passed — safe to run gh pr create.\n"));
          process.exit(0);
        } else {
          console.log(
            chalk.red.bold(
              `\n❌ ${result.blockers.length} check(s) failed — fix the issues above before creating the PR.\n`,
            ),
          );
          if (result.inferredIssueNumber) {
            console.log(
              chalk.yellow(
                `  Tip: add 'Closes #${result.inferredIssueNumber}' to the PR body (inferred from branch name).\n`,
              ),
            );
          }
          process.exit(1);
        }
      },
    );
}

function printChecklist(result: PreSubmitValidationResult): void {
  const icon = (passed: boolean) => (passed ? chalk.green("✅") : chalk.red("❌"));

  const checks = [
    {
      label: "Issue reference  ",
      check: result.checks.issueRef,
    },
    {
      label: "Branch freshness ",
      check: result.checks.branchFresh,
    },
    {
      label: "No duplicate PR  ",
      check: result.checks.prExists,
    },
    {
      label: "Merge conflicts  ",
      check: result.checks.mergeConflicts,
    },
  ];

  for (const { label, check } of checks) {
    const status = check.passed
      ? chalk.green("PASS")
      : chalk.red("FAIL");
    console.log(`  ${icon(check.passed)}  ${chalk.bold(label)}  [${status}]`);
    console.log(`       ${chalk.dim(check.detail)}\n`);
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow("  Warnings:"));
    for (const w of result.warnings) {
      console.log(`    ⚠️  ${w}`);
    }
    console.log();
  }
}
