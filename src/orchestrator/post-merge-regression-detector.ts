/**
 * Post-merge test regression auto-detector — issue #993
 *
 * After each squash-merge, if the post-merge test run exits non-zero, this
 * module:
 *   1. Parses the failing test names out of the raw test output (vitest / jest format)
 *   2. Opens a GitHub issue titled "[post-merge regression] PR #N broke tests"
 *      on the merged repo, labelled "regression", including the failing test
 *      names and the PR that introduced them
 *   3. Returns the created issue URL so the caller can log/notify
 *
 * Acceptance criteria (issue #993):
 *   ✓ A broken test after merge generates a GitHub issue within 5 minutes
 *   ✓ The issue includes the test name(s) and the PR that introduced the regression
 *
 * Integration — call `openRegressionIssue()` from `staging-validator.ts`
 * inside `handleFailedValidation()` BEFORE the revert step:
 *
 *   const issue = await openRegressionIssue({ repo, prNumber, mergeSha, testOutput });
 *   log.info("Regression issue created", { url: issue?.url });
 *
 * Or use `PostMergeRegressionDetector` for full lifecycle (detect + open issue):
 *
 *   const detector = new PostMergeRegressionDetector(config);
 *   const result = await detector.run(repo, prNumber, mergeSha, testOutput);
 */

import { execSync } from "node:child_process";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";
import {
  consumeActionQuota,
  guardPublicContent,
  DEFAULT_PUBLIC_POSTS_PER_HOUR,
} from "../service/security-guard.js";

const log = createLogger("post-merge-regression-detector");

// ── Constants ─────────────────────────────────────────────────────────────────

/** GitHub label applied to auto-created regression issues. */
export const REGRESSION_LABEL = "regression";

/** Maximum number of failing test names to list in the issue body. */
export const MAX_FAILING_TESTS_IN_ISSUE = 20;

/** Maximum raw output length included verbatim in the issue body. */
export const MAX_RAW_OUTPUT_IN_ISSUE = 2000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegressionIssueOptions {
  /** Repository in "owner/repo" format. */
  repo: string;
  /** PR number that was merged and triggered the test failure. */
  prNumber: number;
  /** Merge commit SHA (short or full). */
  mergeSha: string;
  /** Raw test output (stdout + stderr from the test runner). */
  testOutput: string;
  /**
   * Override the timestamp used in the issue body (for testing).
   * Defaults to `new Date().toISOString()`.
   */
  nowIso?: string;
}

export interface RegressionIssueResult {
  /** The opened GitHub issue URL. */
  url: string;
  /** The issue number. */
  number: number;
  /** Parsed failing test names included in the issue. */
  failingTests: string[];
  /** Title of the created issue. */
  title: string;
}

// ── Vitest / Jest output parsers ──────────────────────────────────────────────

/**
 * Parse failing test names from raw vitest / jest output.
 *
 * Handles these common vitest formats:
 *   - `× failing test name` (verbose reporter, ×/✕/x markers)
 *   - ` FAIL src/__tests__/foo.test.ts > Suite > test name`
 *   - `● Suite › test name` (jest dot-notation)
 *   - `FAILED src/__tests__/foo.test.ts > Suite > test name` (vitest summary)
 *
 * Returns a deduplicated list of test names. If no individual test names can
 * be parsed, falls back to extracting the file names of failing test suites.
 */
export function parseFailingTests(output: string): string[] {
  if (!output || !output.trim()) return [];

  const tests = new Set<string>();

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // vitest verbose: "× test name" or "✕ test name" or "x test name"
    const vitestVerboseMatch = trimmed.match(/^[×✕x✗]\s+(.+)/u);
    if (vitestVerboseMatch) {
      tests.add(vitestVerboseMatch[1].trim());
      continue;
    }

    // vitest summary line: "FAILED src/__tests__/foo.test.ts > Suite > test name"
    const vitestSummaryMatch = trimmed.match(/^FAILED\s+\S+\s+>\s+(.+)/);
    if (vitestSummaryMatch) {
      tests.add(vitestSummaryMatch[1].trim());
      continue;
    }

    // jest / vitest nested: " ● Suite › test name" or "● Suite > test name"
    const jestBulletMatch = trimmed.match(/^●\s+(.+)/);
    if (jestBulletMatch) {
      // Strip leading "Suite ›" / "Suite >" prefixes to get just the test name
      const inner = jestBulletMatch[1].replace(/^.+[›>]\s*/, "").trim();
      if (inner) tests.add(inner);
      continue;
    }
  }

  // Fallback: extract failing test *file* names when no individual tests found
  if (tests.size === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      // " FAIL src/__tests__/foo.test.ts" (vitest/jest suite-level FAIL)
      const suiteMatch = trimmed.match(/^(?:FAIL|FAILED)\s+([\w/._-]+\.(?:test|spec)\.[jt]sx?)/);
      if (suiteMatch) {
        tests.add(suiteMatch[1].trim());
      }
    }
  }

  return Array.from(tests);
}

/**
 * Build the GitHub issue body markdown for a post-merge regression.
 */
export function buildRegressionIssueBody(
  opts: RegressionIssueOptions,
  failingTests: string[],
): string {
  const { repo, prNumber, mergeSha, testOutput, nowIso } = opts;
  const ts = nowIso ?? new Date().toISOString();
  const shortSha = mergeSha.slice(0, 8);
  const prUrl = `https://github.com/${repo}/pull/${prNumber}`;

  const testSection =
    failingTests.length > 0
      ? [
          "## Failing tests",
          "",
          failingTests
            .slice(0, MAX_FAILING_TESTS_IN_ISSUE)
            .map((t) => `- \`${t}\``)
            .join("\n"),
          failingTests.length > MAX_FAILING_TESTS_IN_ISSUE
            ? `\n_…and ${failingTests.length - MAX_FAILING_TESTS_IN_ISSUE} more (see raw output below)_`
            : "",
        ].join("\n")
      : "## Failing tests\n\n_Could not parse individual test names — see raw output below._";

  const rawSection = [
    "## Raw test output",
    "",
    "```",
    testOutput.slice(0, MAX_RAW_OUTPUT_IN_ISSUE),
    testOutput.length > MAX_RAW_OUTPUT_IN_ISSUE ? "…(truncated)" : "",
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return [
    `## Post-merge regression detected`,
    ``,
    `**Merged PR:** [#${prNumber}](${prUrl})`,
    `**Merge commit:** \`${shortSha}\``,
    `**Detected at:** ${ts}`,
    `**Repo:** \`${repo}\``,
    ``,
    testSection,
    ``,
    rawSection,
    ``,
    `---`,
    `_Auto-created by the post-merge regression detector._`,
    `_Fix the regression or revert PR #${prNumber} to restore green main._`,
  ].join("\n");
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Open a GitHub regression issue for a failed post-merge test run.
 *
 * Fails open: returns null on any error so callers are never blocked.
 *
 * @param opts - Options describing the failing merge event
 * @returns Created issue info, or null if creation failed
 */
export async function openRegressionIssue(
  opts: RegressionIssueOptions,
): Promise<RegressionIssueResult | null> {
  const { repo, prNumber, testOutput } = opts;
  const failingTests = parseFailingTests(testOutput);

  const title = `[post-merge regression] PR #${prNumber} broke tests`;
  const body = buildRegressionIssueBody(opts, failingTests);

  log.info("Opening regression issue", {
    repo,
    prNumber,
    failingTestCount: failingTests.length,
  });

  try {
    guardPublicContent(title, `post-merge regression title ${repo}#${prNumber}`);
    guardPublicContent(body, `post-merge regression body ${repo}#${prNumber}`);
    // Check for duplicate open regression issue for this PR first
    const existingRaw = execSync(
      `gh issue list --repo ${shellEscape(repo)} --state open --label ${shellEscape(REGRESSION_LABEL)} --search ${shellEscape(`[post-merge regression] PR #${prNumber}`)} --json number,url --limit 5`,
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();

    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as Array<{ number: number; url: string }>;
      if (existing.length > 0) {
        log.info("Regression issue already exists — skipping creation", {
          repo,
          prNumber,
          existingNumber: existing[0].number,
        });
        return {
          url: existing[0].url,
          number: existing[0].number,
          failingTests,
          title,
        };
      }
    }

    consumeActionQuota({
      action: "public-post",
      scope: repo,
      limit: DEFAULT_PUBLIC_POSTS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
    });
    const output = execSync(
      `gh issue create --repo ${shellEscape(repo)} --title ${shellEscape(title)} --body ${shellEscape(body)} --label ${shellEscape(REGRESSION_LABEL)}`,
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();

    // gh issue create returns the URL on stdout
    const match = output.match(/\/issues\/(\d+)$/);
    const number = match ? parseInt(match[1], 10) : 0;

    log.info("Regression issue created", { repo, prNumber, issueNumber: number, url: output });

    return { url: output, number, failingTests, title };
  } catch (err) {
    log.error("Failed to create regression issue — continuing without it", {
      repo,
      prNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── Class API ─────────────────────────────────────────────────────────────────

/**
 * Full lifecycle class: detect regression in test output, open GitHub issue.
 *
 * Preferred for use inside the daemon / staging-validator where the
 * OrchestratorConfig is already available.
 */
export class PostMergeRegressionDetector {
  private readonly log = createLogger("post-merge-regression-detector");

  constructor(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    private readonly config: OrchestratorConfig,
  ) {}

  /**
   * Detect failing tests in `testOutput` and open a GitHub regression issue.
   *
   * Call this when `validateMergedPR()` reports `passed: false`.
   *
   * @returns The created issue result, or null if creation failed (fail-open).
   */
  async run(
    repo: string,
    prNumber: number,
    mergeSha: string,
    testOutput: string,
    nowIso?: string,
  ): Promise<RegressionIssueResult | null> {
    this.log.info("Running post-merge regression detection", {
      repo,
      prNumber,
      sha: mergeSha.slice(0, 8),
    });

    return openRegressionIssue({ repo, prNumber, mergeSha, testOutput, nowIso });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shellEscape(s: string): string {
  if (!s) return "''";
  if (/[^a-zA-Z0-9._/:@#-]/.test(s)) return `'${s.replace(/'/g, "'\\''")}'`;
  return s;
}
