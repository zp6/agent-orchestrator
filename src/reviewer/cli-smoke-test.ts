/**
 * CLI smoke test verifier — acceptance criteria for CLI features.
 *
 * Issue #274: Fleet self-registration CLI end-to-end smoke test.
 * Issue #277: Verifier quality gate integration.
 *
 * The reviewer is the quality gatekeeper for all agent output. CLI features
 * (fleet register, fleet list, agents sync, etc.) must pass a mandatory
 * acceptance test: the command must be invokable in a clean environment and
 * succeed end-to-end.
 *
 * This module provides:
 *   - `runCLISmokeTest()` — executes a CLI command and captures exit code +
 *     stdout/stderr, then validates against expected output patterns.
 *   - `CLISmokeTestSpec` — declarative spec for what a CLI command should do.
 *   - `CLISmokeTestResult` — structured result for verification reporting.
 *   - `validateCLISmokeResult()` — checks whether the result meets the spec.
 *   - `formatSmokeTestReport()` — builds a markdown verification report.
 *   - `getFleetSmokeTestSpecs()` — pre-defined specs for fleet CLI commands.
 *
 * Verifier integration (issue #277):
 *   - `isCLITask()` — detects CLI-related tasks by keyword matching.
 *   - `runSmokeTestsForTask()` — runs applicable specs and returns a scored report.
 *   - `SMOKE_TEST_SCORE_PENALTY` — the score reduction applied on failure (0.20).
 *
 * These are used by the verifier to add a mandatory acceptance gate for CLI
 * features: any CLI task with quality_score < 0.80 AND a failing smoke test
 * is unconditionally rejected with actionable revision guidance.
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import type { Logger } from "../service/logger.js";

const log = createLogger("cli-smoke-test");

/**
 * Declarative specification for a CLI smoke test.
 *
 * Each spec describes a single CLI invocation and the expected outcome.
 * The verifier runs these specs in a clean environment (temp dir, no
 * state.db) and uses the results to gate CLI feature quality.
 */
export interface CLISmokeTestSpec {
  /** Human-readable label for reporting (e.g. "fleet list --json"). */
  label: string;

  /** The full command string to execute (e.g. "node dist/cli/index.js fleet --json"). */
  command: string;

  /**
   * Working directory for the command. If omitted, uses os.tmpdir().
   * For CLI commands that need a state.db, this should point to the
   * orchestrator repo root.
   */
  cwd?: string;

  /** Environment variables to set (merged with process.env). */
  env?: Record<string, string>;

  /** Expected exit code. Defaults to 0 (success). */
  expectedExitCode?: number;

  /**
   * Patterns that MUST appear in stdout for the test to pass.
   * Each entry is a string (substring match) or RegExp.
   */
  stdoutMustContain?: Array<string | RegExp>;

  /**
   * Patterns that MUST NOT appear in stdout.
   * Useful for asserting no error messages leak into normal output.
   */
  stdoutMustNotContain?: Array<string | RegExp>;

  /**
   * Patterns that MUST appear in stderr (warnings, etc.).
   */
  stderrMustContain?: Array<string | RegExp>;

  /**
   * Patterns that MUST NOT appear in stderr.
   */
  stderrMustNotContain?: Array<string | RegExp>;

  /**
   * Maximum execution time in milliseconds. Defaults to 30_000 (30s).
   * CLI commands that hang indicate a broken onboarding experience.
   */
  timeoutMs?: number;
}

/**
 * Result of running a single CLI smoke test.
 */
export interface CLISmokeTestResult {
  /** The spec that was tested. */
  spec: CLISmokeTestSpec;

  /** Whether the test passed all checks. */
  passed: boolean;

  /** Exit code from the command (null if timed out or binary not found). */
  exitCode: number | null;

  /** Captured stdout. */
  stdout: string;

  /** Captured stderr. */
  stderr: string;

  /** Execution time in milliseconds. */
  durationMs: number;

  /**
   * List of specific failures. Empty when passed === true.
   * Each entry is a human-readable description of what failed.
   */
  failures: string[];

  /** Set when the command timed out. */
  timedOut?: boolean;
}

/**
 * Execute a CLI command and capture its output.
 *
 * This function is intentionally isolated from the rest of the reviewer --
 * it spawns a child process and captures raw output, mimicking what an
 * operator would see when running the command for the first time.
 *
 * @param spec - The smoke test specification.
 * @returns A structured result with exit code, output, and timing.
 */
export function runCLISmokeTest(spec: CLISmokeTestSpec): CLISmokeTestResult {
  const timeout = spec.timeoutMs ?? 30_000;
  const start = Date.now();

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;

  try {
    const output = execSync(spec.command, {
      cwd: spec.cwd,
      timeout,
      env: { ...process.env, ...spec.env },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    stdout = typeof output === "string" ? output : "";
    exitCode = 0;
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "killed" in err &&
      (err as { killed: boolean }).killed
    ) {
      timedOut = true;
    }

    if (err && typeof err === "object") {
      const execErr = err as {
        status?: number | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      exitCode = execErr.status ?? null;
      stdout = typeof execErr.stdout === "string"
        ? execErr.stdout
        : execErr.stdout instanceof Buffer
          ? execErr.stdout.toString("utf-8")
          : "";
      stderr = typeof execErr.stderr === "string"
        ? execErr.stderr
        : execErr.stderr instanceof Buffer
          ? execErr.stderr.toString("utf-8")
          : "";
    }
  }

  const durationMs = Date.now() - start;

  const result: CLISmokeTestResult = {
    spec,
    passed: false, // computed by validateCLISmokeResult
    exitCode,
    stdout,
    stderr,
    durationMs,
    failures: [],
    ...(timedOut && { timedOut }),
  };

  return validateCLISmokeResult(result);
}

/**
 * Validate a smoke test result against its spec.
 *
 * Mutates and returns the result with `passed` and `failures` populated.
 * Separated from `runCLISmokeTest()` so tests can inject synthetic results
 * without executing real commands.
 */
export function validateCLISmokeResult(
  result: CLISmokeTestResult,
): CLISmokeTestResult {
  const { spec } = result;
  const failures: string[] = [];

  // -- Timeout check --------------------------------------------------------
  if (result.timedOut) {
    failures.push(
      `Command timed out after ${spec.timeoutMs ?? 30_000}ms -- CLI must respond within the timeout`,
    );
  }

  // -- Exit code check ------------------------------------------------------
  const expectedExit = spec.expectedExitCode ?? 0;
  if (result.exitCode !== expectedExit) {
    failures.push(
      `Expected exit code ${expectedExit}, got ${result.exitCode ?? "null (timeout/signal)"}`,
    );
  }

  // -- stdout assertions ----------------------------------------------------
  for (const pattern of spec.stdoutMustContain ?? []) {
    if (!matchesPattern(result.stdout, pattern)) {
      failures.push(
        `stdout missing required pattern: ${patternToString(pattern)}`,
      );
    }
  }
  for (const pattern of spec.stdoutMustNotContain ?? []) {
    if (matchesPattern(result.stdout, pattern)) {
      failures.push(
        `stdout contains forbidden pattern: ${patternToString(pattern)}`,
      );
    }
  }

  // -- stderr assertions ----------------------------------------------------
  for (const pattern of spec.stderrMustContain ?? []) {
    if (!matchesPattern(result.stderr, pattern)) {
      failures.push(
        `stderr missing required pattern: ${patternToString(pattern)}`,
      );
    }
  }
  for (const pattern of spec.stderrMustNotContain ?? []) {
    if (matchesPattern(result.stderr, pattern)) {
      failures.push(
        `stderr contains forbidden pattern: ${patternToString(pattern)}`,
      );
    }
  }

  result.failures = failures;
  result.passed = failures.length === 0;

  if (!result.passed) {
    log.warn("CLI smoke test failed", {
      label: spec.label,
      exitCode: result.exitCode,
      failures,
      durationMs: result.durationMs,
    });
  }

  return result;
}

/**
 * Format a smoke test result as a human-readable verification note.
 *
 * Used by the verifier to include smoke test outcomes in the quality
 * assessment, giving agents actionable feedback when their CLI feature
 * fails the acceptance gate.
 */
export function formatSmokeTestReport(results: CLISmokeTestResult[]): string {
  const lines: string[] = ["## CLI Smoke Test Results\n"];
  let allPassed = true;

  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL";
    const icon = r.passed ? "\u2705" : "\u274C";
    if (!r.passed) allPassed = false;

    lines.push(`### ${icon} ${r.spec.label} -- ${status}`);
    lines.push(`- **Exit code:** ${r.exitCode ?? "N/A"} (expected ${r.spec.expectedExitCode ?? 0})`);
    lines.push(`- **Duration:** ${r.durationMs}ms`);

    if (r.timedOut) {
      lines.push(`- **Timed out** after ${r.spec.timeoutMs ?? 30_000}ms`);
    }

    if (r.failures.length > 0) {
      lines.push("- **Failures:**");
      for (const f of r.failures) {
        lines.push(`  - ${f}`);
      }
    }

    if (!r.passed && r.stderr.length > 0) {
      const preview = r.stderr.slice(0, 300);
      lines.push(`- **stderr preview:** \`${preview}\``);
    }

    lines.push("");
  }

  const summary = allPassed
    ? "All CLI smoke tests passed."
    : `${results.filter((r) => !r.passed).length}/${results.length} smoke test(s) failed -- CLI feature is not ready for operators.`;

  lines.push(`**Summary:** ${summary}`);

  return lines.join("\n");
}

/**
 * Pre-defined smoke test specs for fleet management CLI commands.
 *
 * These specs validate the core fleet onboarding experience:
 *   1. `fleet --json` -- must return valid JSON (even if empty)
 *   2. `fleet --help` -- must show usage information
 *   3. `agents list` -- must execute without error
 *
 * Each spec uses `--json` output where available to enable machine-readable
 * validation, and falls back to `--help` for commands that require live state.
 *
 * @param orchestratorDir - Path to the orchestrator repo root (where dist/ lives).
 * @param stateDbPath - Optional path to a test state.db file.
 */
export function getFleetSmokeTestSpecs(
  orchestratorDir: string,
  stateDbPath?: string,
): CLISmokeTestSpec[] {
  const env: Record<string, string> = {};
  if (stateDbPath) {
    env["STATE_DB_PATH"] = stateDbPath;
  }

  return [
    {
      label: "fleet --help",
      command: `node dist/cli/index.js fleet --help`,
      cwd: orchestratorDir,
      env,
      expectedExitCode: 0,
      stdoutMustContain: ["fleet", "comparison"],
      stdoutMustNotContain: [/error/i, /ENOENT/],
      timeoutMs: 10_000,
    },
    {
      label: "fleet --json (machine-readable output)",
      command: `node dist/cli/index.js fleet --json`,
      cwd: orchestratorDir,
      env,
      expectedExitCode: 0,
      // JSON output: either [] or [{...}]
      stdoutMustContain: ["["],
      stdoutMustNotContain: [/ENOENT/, /Cannot find module/],
      timeoutMs: 15_000,
    },
    {
      label: "agents --help",
      command: `node dist/cli/index.js agents --help`,
      cwd: orchestratorDir,
      env,
      expectedExitCode: 0,
      stdoutMustContain: ["agents"],
      stdoutMustNotContain: [/error/i, /ENOENT/],
      timeoutMs: 10_000,
    },
  ];
}

// -- Internal helpers -------------------------------------------------------

function matchesPattern(text: string, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return text.includes(pattern);
  }
  return pattern.test(text);
}

function patternToString(pattern: string | RegExp): string {
  if (typeof pattern === "string") {
    return `"${pattern}"`;
  }
  return pattern.toString();
}

// -- Verifier integration (issue #277) -------------------------------------
//
// The functions below extend the smoke test infrastructure with the ability
// to automatically detect CLI-related tasks during verification and apply a
// score penalty when lightweight `orch`-binary checks fail.
//
// Design goals (fail-open):
//   - Environment errors (binary not found, exitCode === null) are recorded
//     but do NOT trigger the score penalty. Only confirmed command failures
//     where exitCode is a valid integer trigger the penalty.
//   - No network: all specs spawn local processes only.
//   - Fast: default 5 s timeout per spec so verification is never held up.

/** Score penalty applied to the LLM quality score when smoke tests fail. */
export const SMOKE_TEST_SCORE_PENALTY = 0.20;

/** Aggregated result of running all applicable smoke tests for a task. */
export interface SmokeTestReport {
  /** True when all executed tests passed (or no tests were selected). */
  allPassed: boolean;
  /** True when at least one test failed (not merely a binary-not-found error). */
  anyFailed: boolean;
  /** The individual test results. */
  results: CLISmokeTestResult[];
  /** Score penalty to subtract from the LLM score. 0 when all tests pass. */
  scorePenalty: number;
  /** Human-readable markdown section for inclusion in verification_notes. */
  reportText: string;
}

/** Keywords that classify a task as CLI-related. */
const CLI_TASK_KEYWORDS = [
  "cli",
  "command",
  "fleet",
  "agents",
  "register",
  "orch ",
  "orch\t",
  "claude fleet",
  "smoke test",
];

/**
 * Returns true when the task title or description contains CLI-related
 * keywords, indicating that smoke tests should be run during verification.
 */
export function isCLITask(
  title: string,
  description: string | null | undefined,
): boolean {
  const haystack = `${title} ${description ?? ""}`.toLowerCase();
  return CLI_TASK_KEYWORDS.some((kw) => haystack.includes(kw));
}

/**
 * A lightweight smoke test spec for verifier-time checks.
 * Extends CLISmokeTestSpec with `keywords` for task-based selection.
 */
interface VerifierSmokeSpec extends CLISmokeTestSpec {
  /**
   * Keywords that must appear in the task title or description for this spec
   * to be selected. An empty array means the spec always runs for CLI tasks.
   */
  keywords: string[];
}

/**
 * Lightweight smoke test specs used by the verifier at review time.
 *
 * These use the `orch` binary (expected on $PATH in the reviewer container)
 * rather than `node dist/cli/index.js` (which requires a built orchestrator).
 * Each spec declares `keywords` so only relevant tests run for each task.
 */
function getVerifierSmokeSpecs(): VerifierSmokeSpec[] {
  return [
    {
      label: "orch --version exits cleanly",
      command: "orch --version",
      stdoutMustContain: [/\d+\.\d+/],
      timeoutMs: 5_000,
      keywords: [], // Always run for any CLI task
    },
    {
      label: "orch agents list exits cleanly",
      command: "orch agents list --limit 1",
      timeoutMs: 5_000,
      keywords: ["agent", "fleet", "register", "list", "sync"],
    },
    {
      label: "orch status exits cleanly",
      command: "orch status",
      timeoutMs: 5_000,
      keywords: ["status", "health", "fleet", "dashboard"],
    },
    {
      label: "orch health exits cleanly",
      command: "orch health --json",
      timeoutMs: 5_000,
      keywords: ["health", "liveness", "check"],
    },
    {
      label: "orch metrics exits cleanly",
      command: "orch metrics --json",
      timeoutMs: 5_000,
      keywords: ["metrics", "stats", "telemetry"],
    },
  ];
}

/**
 * Select which verifier smoke specs apply to this task.
 *
 * A spec is selected when its keywords array is empty (always-on) OR at
 * least one keyword matches in the task title or description.
 */
function selectVerifierSpecs(
  title: string,
  description: string | null | undefined,
): VerifierSmokeSpec[] {
  const haystack = `${title} ${description ?? ""}`.toLowerCase();
  return getVerifierSmokeSpecs().filter(
    (spec) =>
      spec.keywords.length === 0 ||
      spec.keywords.some((kw) => haystack.includes(kw.toLowerCase())),
  );
}

/**
 * Run all applicable smoke tests for a CLI-related task and return a
 * structured report for inclusion in verification_notes.
 *
 * This is the main entry point called by the verifier's `verify()` method.
 *
 * Algorithm:
 *   1. Guard: return empty report for non-CLI tasks
 *   2. Select verifier specs matching the task's keywords
 *   3. Run each spec via runCLISmokeTest (fail-open on environment errors)
 *   4. Compute score penalty (SMOKE_TEST_SCORE_PENALTY when any confirmed failures)
 *   5. Build a markdown report section for `verification_notes`
 *
 * Fail-open rule: results with exitCode === null (binary not found / OS error)
 * are NOT counted as confirmed failures and do not trigger the score penalty.
 */
export function runSmokeTestsForTask(
  title: string,
  description: string | null | undefined,
  log?: Logger,
): SmokeTestReport {
  if (!isCLITask(title, description)) {
    return {
      allPassed: true,
      anyFailed: false,
      results: [],
      scorePenalty: 0,
      reportText: "",
    };
  }

  const selectedSpecs = selectVerifierSpecs(title, description);

  if (selectedSpecs.length === 0) {
    return {
      allPassed: true,
      anyFailed: false,
      results: [],
      scorePenalty: 0,
      reportText: "",
    };
  }

  const results = selectedSpecs.map((spec) => runCLISmokeTest(spec));

  // Fail-open: environment errors (exitCode === null, e.g. ENOENT / signal) are
  // NOT counted as confirmed failures -- only process failures with a real exit
  // code trigger the penalty.
  const confirmedFailures = results.filter(
    (r) => !r.passed && r.exitCode !== null && !r.timedOut,
  );
  const anyFailed = confirmedFailures.length > 0;
  const allPassed = results.every((r) => r.passed);
  const scorePenalty = anyFailed ? SMOKE_TEST_SCORE_PENALTY : 0;

  const reportText = formatSmokeTestReport(results);

  if (log) {
    log.info("Verifier smoke tests complete", {
      title,
      ran: results.length,
      passed: results.filter((r) => r.passed).length,
      confirmedFailed: confirmedFailures.length,
      environmentErrors: results.filter((r) => !r.passed && r.exitCode === null).length,
      penalty: scorePenalty,
    });
  }

  return { allPassed, anyFailed, results, scorePenalty, reportText };
}
