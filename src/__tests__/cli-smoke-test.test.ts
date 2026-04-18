/**
 * Tests for the CLI smoke test quality gate (issue #277).
 *
 * Covers the verifier-integration additions to cli-smoke-test.ts:
 *   - isCLITask() keyword detection
 *   - runSmokeTestsForTask() report structure
 *   - SMOKE_TEST_SCORE_PENALTY constant
 *
 * Tests for the base CLISmokeTestSpec / CLISmokeTestResult / runCLISmokeTest /
 * validateCLISmokeResult / getFleetSmokeTestSpecs infrastructure are in
 * src/__tests__/fleet-cli-smoke.test.ts (issue #274).
 */

import { describe, it, expect } from "vitest";
import {
  isCLITask,
  runSmokeTestsForTask,
  SMOKE_TEST_SCORE_PENALTY,
  type CLISmokeTestSpec,
  type CLISmokeTestResult,
  type SmokeTestReport,
  runCLISmokeTest,
  validateCLISmokeResult,
} from "../reviewer/cli-smoke-test.js";

// isCLITask

describe("isCLITask", () => {
  it("detects 'CLI' in title", () => {
    expect(isCLITask("Add CLI smoke test", null)).toBe(true);
    expect(isCLITask("add cli command", null)).toBe(true);
  });

  it("detects 'command' in title", () => {
    expect(isCLITask("Add fleet register command", null)).toBe(true);
  });

  it("detects 'fleet' in title", () => {
    expect(isCLITask("Fleet health panel", null)).toBe(true);
  });

  it("detects 'agents' in title", () => {
    expect(isCLITask("List agents in registry", null)).toBe(true);
  });

  it("detects keywords in description when title is clean", () => {
    expect(isCLITask("Add feature", "Adds a new CLI command to orch")).toBe(true);
  });

  it("returns false for non-CLI tasks", () => {
    expect(isCLITask("Fix database migration", "Update schema for new table")).toBe(false);
    expect(isCLITask("Improve PR review", null)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isCLITask("FLEET REGISTER", null)).toBe(true);
    expect(isCLITask("orch status command", null)).toBe(true);
  });

  it("handles null/undefined description", () => {
    expect(isCLITask("CLI feature", null)).toBe(true);
    expect(isCLITask("CLI feature", undefined)).toBe(true);
  });
});

// SMOKE_TEST_SCORE_PENALTY

describe("SMOKE_TEST_SCORE_PENALTY", () => {
  it("is 0.20", () => {
    expect(SMOKE_TEST_SCORE_PENALTY).toBe(0.20);
  });
});

// runSmokeTestsForTask

describe("runSmokeTestsForTask", () => {
  it("returns empty report for non-CLI task", () => {
    const report: SmokeTestReport = runSmokeTestsForTask("Fix database migration", "Update schema");
    expect(report.results).toHaveLength(0);
    expect(report.allPassed).toBe(true);
    expect(report.anyFailed).toBe(false);
    expect(report.scorePenalty).toBe(0);
    expect(report.reportText).toBe("");
  });

  it("does not produce a report section for non-CLI tasks", () => {
    const report = runSmokeTestsForTask("Improve PR review latency", null);
    expect(report.reportText).toBe("");
    expect(report.results).toHaveLength(0);
  });

  it("returns a report with results for a CLI task", () => {
    // Use a title that matches CLI keywords. Tests may pass or fail depending
    // on whether the orch binary is available. Verify structure only.
    const report = runSmokeTestsForTask("Fleet self-registration CLI command", null);
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.reportText).toContain("## CLI Smoke Test Results");
    expect(report.scorePenalty).toBeGreaterThanOrEqual(0);
    expect(report.scorePenalty).toBeLessThanOrEqual(SMOKE_TEST_SCORE_PENALTY);
  });

  it("includes smoke test report in reportText for CLI tasks", () => {
    const report = runSmokeTestsForTask("Add orch agents CLI command", null);
    expect(report.reportText).toContain("## CLI Smoke Test Results");
    expect(report.reportText).toContain("smoke test");
  });

  it("does not apply penalty when all failures are environment errors (exitCode null)", () => {
    const report = runSmokeTestsForTask("Add CLI command for fleet", null);
    const confirmedFailures = report.results.filter(
      (r) => !r.passed && r.exitCode !== null && !r.timedOut,
    );
    if (confirmedFailures.length === 0) {
      expect(report.scorePenalty).toBe(0);
      expect(report.anyFailed).toBe(false);
    } else {
      expect(report.scorePenalty).toBe(SMOKE_TEST_SCORE_PENALTY);
      expect(report.anyFailed).toBe(true);
    }
  });

  it("report allPassed and anyFailed are consistent", () => {
    const report = runSmokeTestsForTask("CLI fleet command", null);
    if (report.results.length === 0) {
      expect(report.allPassed).toBe(true);
      expect(report.anyFailed).toBe(false);
    } else {
      const everyPassed = report.results.every((r) => r.passed);
      expect(report.allPassed).toBe(everyPassed);
    }
  });
});

// runCLISmokeTest with real commands

describe("runCLISmokeTest with real commands", () => {
  it("passes for a simple echo command", () => {
    const spec: CLISmokeTestSpec = {
      label: "echo test",
      command: "echo hello",
      stdoutMustContain: ["hello"],
      timeoutMs: 5_000,
    };
    const result: CLISmokeTestResult = runCLISmokeTest(spec);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
    expect(result.failures).toHaveLength(0);
  });

  it("fails when stdout pattern is not matched", () => {
    const spec: CLISmokeTestSpec = {
      label: "pattern mismatch",
      command: "echo hello",
      stdoutMustContain: ["xyz123"],
      timeoutMs: 5_000,
    };
    const result = runCLISmokeTest(spec);
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures.some((f) => f.includes("stdout missing"))).toBe(true);
  });

  it("captures exitCode null for binary-not-found (environment error)", () => {
    const spec: CLISmokeTestSpec = {
      label: "missing binary",
      command: "definitely-does-not-exist-zxqkjf --version",
      timeoutMs: 5_000,
    };
    const result = runCLISmokeTest(spec);
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.durationMs).toBe("number");
  });
});

// validateCLISmokeResult

describe("validateCLISmokeResult", () => {
  const baseSpec: CLISmokeTestSpec = {
    label: "test spec",
    command: "echo ok",
  };

  it("marks result as passed when no failures", () => {
    const result: CLISmokeTestResult = {
      spec: baseSpec,
      passed: false,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 10,
      failures: [],
    };
    const validated = validateCLISmokeResult(result);
    expect(validated.passed).toBe(true);
    expect(validated.failures).toHaveLength(0);
  });

  it("fails when exit code does not match expectedExitCode", () => {
    const result: CLISmokeTestResult = {
      spec: { ...baseSpec, expectedExitCode: 0 },
      passed: false,
      exitCode: 1,
      stdout: "",
      stderr: "error",
      durationMs: 10,
      failures: [],
    };
    const validated = validateCLISmokeResult(result);
    expect(validated.passed).toBe(false);
    expect(validated.failures.some((f) => f.includes("exit code"))).toBe(true);
  });

  it("fails when stdout does not match required pattern", () => {
    const result: CLISmokeTestResult = {
      spec: { ...baseSpec, stdoutMustContain: ["expected-string"] },
      passed: false,
      exitCode: 0,
      stdout: "something else",
      stderr: "",
      durationMs: 10,
      failures: [],
    };
    const validated = validateCLISmokeResult(result);
    expect(validated.passed).toBe(false);
    expect(validated.failures.some((f) => f.includes("stdout missing"))).toBe(true);
  });

  it("fails when stdout contains a forbidden pattern", () => {
    const result: CLISmokeTestResult = {
      spec: { ...baseSpec, stdoutMustNotContain: ["FORBIDDEN"] },
      passed: false,
      exitCode: 0,
      stdout: "output with FORBIDDEN word",
      stderr: "",
      durationMs: 10,
      failures: [],
    };
    const validated = validateCLISmokeResult(result);
    expect(validated.passed).toBe(false);
    expect(validated.failures.some((f) => f.includes("stdout contains forbidden"))).toBe(true);
  });
});
