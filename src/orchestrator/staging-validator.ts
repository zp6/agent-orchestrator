/**
 * Post-merge staging validation — run tests after PRs merge and
 * auto-revert if they break main.
 *
 * Flow:
 *   1. Daemon detects a PR was just merged (via merge queue completion)
 *   2. Run tests against the merged main branch in the agent's container
 *   3. If tests pass → mark as validated
 *   4. If tests fail → auto-revert the merge commit, re-open the issue
 *
 * Only triggers for repos with agents that have docker containers.
 * Uses the existing agent containers to run tests (no separate staging env).
 */
import { execSync } from "node:child_process";
import { AgentClient } from "../client/agent-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { notifyOperator } from "../service/notify.js";
import { openRegressionIssue } from "./post-merge-regression-detector.js";

const log = createLogger("staging-validator");

export interface ValidationResult {
  repo: string;
  prNumber: number;
  sha: string;
  passed: boolean;
  output: string;
  duration_ms: number;
}

/**
 * Validate a recently merged PR by running tests on the merged main branch.
 * Returns the validation result.
 */
export async function validateMergedPR(
  config: OrchestratorConfig,
  store: StateStore,
  repo: string,
  prNumber: number,
  mergeSha: string,
): Promise<ValidationResult> {
  const start = Date.now();

  // Find an agent that owns this repo
  const agentName = Object.entries(config.agents).find(
    ([, a]) => a.github === repo && a.docker?.port,
  )?.[0];

  if (!agentName) {
    log.warn("No agent found for repo — skipping validation", { repo });
    return {
      repo, prNumber, sha: mergeSha, passed: true,
      output: "No agent available for this repo — skipped.",
      duration_ms: Date.now() - start,
    };
  }

  log.info("Running post-merge validation", { repo, prNumber, agentName, sha: mergeSha });

  // Per-call timeout: abort if the validation agent doesn't respond within 120s.
  // Without this a single hung test runner can consume the entire daemon cycle budget
  // (1200s), causing a DEADLOCK for all other pending work.
  const VALIDATION_TIMEOUT_MS = 120_000;
  const controller = new AbortController();
  const validationTimer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const client = new AgentClient(config);
    const response = await client.send(agentName, [
      `Post-merge validation for PR #${prNumber} (${mergeSha.slice(0, 8)}).`,
      "",
      "1. Pull the latest main branch: git pull origin main",
      "2. Install dependencies if needed: npm install (only if package.json changed)",
      "3. Run the test suite: npx vitest run",
      "4. Report: did all tests pass? Include the test summary line.",
      "",
      "Reply with ONLY: PASS or FAIL followed by the test summary.",
    ].join("\n"), {
      systemPrompt: "You are a CI validator. Run the commands exactly as given and report the result. No commentary — just PASS/FAIL and the test output.",
      signal: controller.signal,
    });
    clearTimeout(validationTimer);

    // Use word-boundary regex to avoid false negatives from "failures" matching "FAIL"
    const upperContent = response.content.toUpperCase();
    const passed = /\bPASS\b/.test(upperContent) && !/\bFAIL\b/.test(upperContent);

    const result: ValidationResult = {
      repo, prNumber, sha: mergeSha, passed,
      output: response.content.slice(0, 1000),
      duration_ms: Date.now() - start,
    };

    if (passed) {
      log.info("Post-merge validation PASSED", { repo, prNumber, duration: result.duration_ms });
      // Use recordStagingValidation instead of addLog: staging validation events are
      // not tied to a specific task, so addLog(task_id: "") would violate the
      // FOREIGN KEY constraint on task_logs.task_id → tasks.id.
      store.recordStagingValidation({
        repo,
        prNumber,
        sha: mergeSha,
        passed: true,
        output: result.output,
        duration_ms: result.duration_ms,
      });
    } else {
      log.error("Post-merge validation FAILED", { repo, prNumber, output: result.output.slice(0, 200) });
      await handleFailedValidation(config, repo, prNumber, mergeSha, result.output);
    }

    return result;
  } catch (err) {
    clearTimeout(validationTimer);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const errorMsg = isTimeout
      ? `Validation timed out after ${VALIDATION_TIMEOUT_MS / 1000}s — agent unresponsive`
      : (err instanceof Error ? err.message : String(err));
    if (isTimeout) {
      log.warn("Post-merge validation timed out — skipping revert (fail-open)", { repo, prNumber, timeoutMs: VALIDATION_TIMEOUT_MS });
    } else {
      log.error("Post-merge validation error", { repo, prNumber, error: errorMsg });
    }
    return {
      repo, prNumber, sha: mergeSha, passed: true, // fail-open: don't revert on validation errors or timeouts
      output: `Validation error: ${errorMsg}`,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Handle a failed validation: revert the merge commit and notify.
 */
async function handleFailedValidation(
  config: OrchestratorConfig,
  repo: string,
  prNumber: number,
  mergeSha: string,
  testOutput: string,
): Promise<void> {
  // Check if tests were passing before this merge
  // (compare with prior commit to avoid reverting pre-existing failures)
  let priorPassed = true;
  try {
    const priorSha = execSync(
      `gh api repos/${repo}/commits/${mergeSha} --jq '.parents[0].sha'`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    const priorRun = execSync(
      `gh run list --repo ${repo} --commit ${priorSha} --limit 1 --json conclusion --jq '.[0].conclusion'`,
      { encoding: "utf-8", timeout: 10000 },
    ).trim();

    priorPassed = priorRun === "success";
  } catch {
    // Can't determine prior state — proceed with revert
  }

  if (!priorPassed) {
    // Tests were already failing before this merge — skip revert and skip the
    // Telegram warning. Notifying on every PR merge for a pre-existing failure
    // creates noise that masks real regressions. The log entry below is
    // sufficient for operators to investigate when they choose to.
    log.warn("Tests were already failing before this merge — not reverting", { repo, prNumber });
    return;
  }

  // Open a regression issue BEFORE reverting so operators can track the failure
  // even if the revert step itself throws.
  openRegressionIssue({ repo, prNumber, mergeSha, testOutput }).then((issue) => {
    if (issue) {
      log.info("Regression issue created", { repo, prNumber, issueUrl: issue.url, failingTests: issue.failingTests.length });
    }
  }).catch((err) => {
    log.warn("Failed to open regression issue (non-fatal)", {
      repo, prNumber, error: err instanceof Error ? err.message : String(err),
    });
  });

  // Revert via gh CLI
  log.warn("Reverting merge due to test failure", { repo, prNumber, sha: mergeSha });

  try {
    execSync(
      `gh api repos/${repo}/git/refs/heads/main --method PATCH -f sha="${mergeSha}~1" --silent`,
      { encoding: "utf-8", timeout: 15000 },
    );
    log.info("Revert successful — main reset to parent commit", { repo, prNumber });
  } catch (err) {
    // Force push revert failed — try creating a revert PR instead
    log.warn("Direct revert failed, creating revert PR", { repo, error: err instanceof Error ? err.message : String(err) });
    try {
      execSync(
        `gh pr create --repo ${repo} --title "Revert PR #${prNumber}: tests failed after merge" --body "Auto-revert: post-merge validation detected test failures.\n\nTest output:\n\`\`\`\n${testOutput.slice(0, 500)}\n\`\`\`" --head revert-${prNumber} --base main`,
        { encoding: "utf-8", timeout: 15000 },
      );
    } catch {
      log.error("Failed to create revert PR", { repo, prNumber });
    }
  }

  notifyOperator(
    `REVERTED: ${repo}#${prNumber} — tests failed after merge`,
    `PR #${prNumber} was auto-reverted because post-merge tests failed.\n\nOutput:\n${testOutput.slice(0, 300)}`,
    "critical",
    `staging-revert:${repo}#${prNumber}`,
  ).catch(() => {});
}
