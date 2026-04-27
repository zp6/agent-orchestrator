/**
 * Fleet self-registration CLI end-to-end smoke test (issue #274).
 *
 * Validates that fleet management CLI commands can be invoked in a clean
 * environment and succeed end-to-end. This is a mandatory acceptance gate
 * for CLI features — operators who run `orch fleet` or `orch agents list`
 * must get a working experience, not a crash or silent failure.
 *
 * Test structure:
 *   1. **Unit tests** — validate the smoke test infrastructure itself
 *      (validateCLISmokeResult, formatSmokeTestReport) using synthetic
 *      results, no child_process execution needed.
 *   2. **Spec tests** — validate that getFleetSmokeTestSpecs() returns
 *      well-formed specs for the fleet CLI commands.
 *   3. **Integration tests** — execute `runCLISmokeTest()` with mocked
 *      execSync to verify end-to-end flow without requiring a live
 *      orchestrator build.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import {
  validateCLISmokeResult,
  formatSmokeTestReport,
  getFleetSmokeTestSpecs,
  runCLISmokeTest,
  type CLISmokeTestSpec,
  type CLISmokeTestResult,
} from "../reviewer/cli-smoke-test.js";

// Mock child_process so tests never spawn real processes
vi.mock("child_process");
// Suppress logger output in tests
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSpec(overrides?: Partial<CLISmokeTestSpec>): CLISmokeTestSpec {
  return {
    label: "test command",
    command: "echo hello",
    expectedExitCode: 0,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function makeResult(
  overrides?: Partial<CLISmokeTestResult>,
): CLISmokeTestResult {
  const spec = overrides?.spec ?? makeSpec();
  return {
    spec,
    passed: false,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 100,
    failures: [],
    ...overrides,
  };
}

// ── validateCLISmokeResult ───────────────────────────────────────────────────

describe("validateCLISmokeResult", () => {
  it("passes when exit code matches and no assertions defined", () => {
    const result = validateCLISmokeResult(makeResult({ exitCode: 0 }));
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("fails when exit code does not match expected", () => {
    const result = validateCLISmokeResult(
      makeResult({ exitCode: 1, spec: makeSpec({ expectedExitCode: 0 }) }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("exit code");
    expect(result.failures[0]).toContain("1");
  });

  it("fails when exit code is null (timeout/signal)", () => {
    const result = validateCLISmokeResult(makeResult({ exitCode: null }));
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("null");
  });

  it("passes when stdoutMustContain patterns are present", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stdout: '["agent-1", "agent-2"]',
        spec: makeSpec({ stdoutMustContain: ["[", "agent-1"] }),
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when stdoutMustContain pattern is missing", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stdout: "some output",
        spec: makeSpec({ stdoutMustContain: ["fleet"] }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("stdout missing required pattern");
    expect(result.failures[0]).toContain("fleet");
  });

  it("supports RegExp patterns in stdoutMustContain", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stdout: "Fleet Comparison — last 7 days",
        spec: makeSpec({ stdoutMustContain: [/fleet/i] }),
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when stdoutMustNotContain pattern is found", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stdout: "Error: ENOENT no such file",
        spec: makeSpec({ stdoutMustNotContain: [/ENOENT/] }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("forbidden pattern");
  });

  it("passes when stdoutMustNotContain pattern is absent", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stdout: "all good",
        spec: makeSpec({ stdoutMustNotContain: [/error/i] }),
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("validates stderr patterns", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stderr: "Warning: deprecated flag",
        spec: makeSpec({
          stderrMustContain: ["Warning"],
          stderrMustNotContain: [/fatal/i],
        }),
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("fails when stderrMustContain pattern is missing", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stderr: "",
        spec: makeSpec({ stderrMustContain: ["expected warning"] }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toContain("stderr missing required pattern");
  });

  it("fails when stderrMustNotContain pattern is found", () => {
    const result = validateCLISmokeResult(
      makeResult({
        stderr: "FATAL: database locked",
        spec: makeSpec({ stderrMustNotContain: [/FATAL/] }),
      }),
    );
    expect(result.passed).toBe(false);
  });

  it("reports timeout failure", () => {
    const result = validateCLISmokeResult(
      makeResult({
        timedOut: true,
        exitCode: null,
        spec: makeSpec({ timeoutMs: 5_000 }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("timed out"),
      ]),
    );
  });

  it("accumulates multiple failures", () => {
    const result = validateCLISmokeResult(
      makeResult({
        exitCode: 1,
        stdout: "",
        stderr: "FATAL crash",
        spec: makeSpec({
          expectedExitCode: 0,
          stdoutMustContain: ["fleet"],
          stderrMustNotContain: [/FATAL/],
        }),
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });
});

// ── formatSmokeTestReport ────────────────────────────────────────────────────

describe("formatSmokeTestReport", () => {
  it("formats a passing result with checkmark icon", () => {
    const result = makeResult({ passed: true });
    const report = formatSmokeTestReport([result]);
    expect(report).toContain("\u2705"); // checkmark
    expect(report).toContain("PASS");
    expect(report).toContain("All CLI smoke tests passed");
  });

  it("formats a failing result with X icon and failure details", () => {
    const result = makeResult({
      passed: false,
      exitCode: 1,
      failures: ["Expected exit code 0, got 1"],
      stderr: "Error: something went wrong",
    });
    const report = formatSmokeTestReport([result]);
    expect(report).toContain("\u274C"); // X
    expect(report).toContain("FAIL");
    expect(report).toContain("Expected exit code 0, got 1");
    expect(report).toContain("stderr preview");
    expect(report).toContain("not ready for operators");
  });

  it("reports mixed pass/fail counts", () => {
    const results = [
      makeResult({ passed: true, spec: makeSpec({ label: "fleet --help" }) }),
      makeResult({
        passed: false,
        spec: makeSpec({ label: "fleet --json" }),
        failures: ["exit code mismatch"],
      }),
      makeResult({
        passed: false,
        spec: makeSpec({ label: "agents --help" }),
        failures: ["missing pattern"],
      }),
    ];
    const report = formatSmokeTestReport(results);
    expect(report).toContain("2/3 smoke test(s) failed");
  });

  it("includes timeout information", () => {
    const result = makeResult({
      passed: false,
      timedOut: true,
      spec: makeSpec({ timeoutMs: 10_000 }),
      failures: ["Command timed out"],
    });
    const report = formatSmokeTestReport([result]);
    expect(report).toContain("Timed out");
    expect(report).toContain("10000ms");
  });

  it("truncates long stderr to 300 chars", () => {
    const longStderr = "x".repeat(500);
    const result = makeResult({
      passed: false,
      failures: ["some failure"],
      stderr: longStderr,
    });
    const report = formatSmokeTestReport([result]);
    // Should contain at most 300 chars of stderr
    expect(report).toContain("x".repeat(300));
    expect(report).not.toContain("x".repeat(301));
  });
});

// ── getFleetSmokeTestSpecs ───────────────────────────────────────────────────

describe("getFleetSmokeTestSpecs", () => {
  it("returns at least 3 specs for fleet CLI commands", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    expect(specs.length).toBeGreaterThanOrEqual(3);
  });

  it("all specs have required fields", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    for (const spec of specs) {
      expect(spec.label).toBeTruthy();
      expect(spec.command).toBeTruthy();
      expect(spec.cwd).toBe("/fake/orchestrator");
      expect(spec.timeoutMs).toBeGreaterThan(0);
      expect(spec.expectedExitCode).toBe(0);
    }
  });

  it("includes fleet --help spec", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const helpSpec = specs.find((s) => s.label.includes("fleet --help"));
    expect(helpSpec).toBeDefined();
    expect(helpSpec!.command).toContain("fleet --help");
    expect(helpSpec!.stdoutMustContain).toEqual(
      expect.arrayContaining(["fleet"]),
    );
  });

  it("includes fleet --json spec", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const jsonSpec = specs.find((s) => s.label.includes("fleet --json"));
    expect(jsonSpec).toBeDefined();
    expect(jsonSpec!.command).toContain("fleet --json");
    expect(jsonSpec!.stdoutMustContain).toEqual(
      expect.arrayContaining(["["]),
    );
  });

  it("includes agents --help spec", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const agentsSpec = specs.find((s) => s.label.includes("agents --help"));
    expect(agentsSpec).toBeDefined();
    expect(agentsSpec!.command).toContain("agents --help");
  });

  it("sets STATE_DB_PATH env when stateDbPath is provided", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orch", "/tmp/test.db");
    for (const spec of specs) {
      expect(spec.env).toBeDefined();
      expect(spec.env!["STATE_DB_PATH"]).toBe("/tmp/test.db");
    }
  });

  it("does not set STATE_DB_PATH env when stateDbPath is omitted", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orch");
    for (const spec of specs) {
      expect(spec.env?.["STATE_DB_PATH"]).toBeUndefined();
    }
  });

  it("all specs forbid ENOENT in output", () => {
    const specs = getFleetSmokeTestSpecs("/fake/orch");
    for (const spec of specs) {
      // At least one of stdout/stderr should guard against ENOENT
      const allForbidden = [
        ...(spec.stdoutMustNotContain ?? []),
        ...(spec.stderrMustNotContain ?? []),
      ];
      const hasEnoentGuard = allForbidden.some((p) =>
        typeof p === "string" ? p.includes("ENOENT") : p.source.includes("ENOENT"),
      );
      expect(hasEnoentGuard).toBe(true);
    }
  });
});

// ── runCLISmokeTest (integration with mocked execSync) ───────────────────────

describe("runCLISmokeTest", () => {
  const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("returns passed=true when command succeeds and output matches", () => {
    mockExecSync.mockReturnValueOnce('["agent-1"]');

    const result = runCLISmokeTest(
      makeSpec({
        command: "node cli fleet --json",
        stdoutMustContain: ["["],
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('["agent-1"]');
    expect(result.failures).toHaveLength(0);
  });

  it("returns passed=false when command exits with non-zero", () => {
    const error = new Error("Command failed") as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = "";
    error.stderr = "Error: database not found";
    mockExecSync.mockImplementationOnce(() => {
      throw error;
    });

    const result = runCLISmokeTest(makeSpec({ expectedExitCode: 0 }));

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("database not found");
  });

  it("detects timeout (killed process)", () => {
    const error = new Error("TIMEOUT") as Error & {
      killed: boolean;
      status: null;
      stdout: string;
      stderr: string;
    };
    error.killed = true;
    error.status = null;
    error.stdout = "";
    error.stderr = "";
    mockExecSync.mockImplementationOnce(() => {
      throw error;
    });

    const result = runCLISmokeTest(makeSpec({ timeoutMs: 1_000 }));

    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining("timed out"),
      ]),
    );
  });

  it("captures stderr from failed command", () => {
    const error = new Error("fail") as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = "partial output";
    error.stderr = "ENOENT: no such file /dist/cli/index.js";
    mockExecSync.mockImplementationOnce(() => {
      throw error;
    });

    const result = runCLISmokeTest(
      makeSpec({
        stdoutMustNotContain: [/ENOENT/],
      }),
    );

    expect(result.stdout).toBe("partial output");
    expect(result.stderr).toContain("ENOENT");
  });

  it("passes env variables to the command", () => {
    mockExecSync.mockReturnValueOnce("ok");

    runCLISmokeTest(
      makeSpec({
        env: { STATE_DB_PATH: "/tmp/test.db", CUSTOM_VAR: "value" },
      }),
    );

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          STATE_DB_PATH: "/tmp/test.db",
          CUSTOM_VAR: "value",
        }),
      }),
    );
  });

  it("uses specified cwd", () => {
    mockExecSync.mockReturnValueOnce("ok");

    runCLISmokeTest(makeSpec({ cwd: "/home/user/orchestrator" }));

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "/home/user/orchestrator" }),
    );
  });

  it("measures execution duration", () => {
    mockExecSync.mockReturnValueOnce("ok");

    const result = runCLISmokeTest(makeSpec());

    // Duration should be a non-negative number (may be 0 since mock returns instantly)
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles Buffer stdout/stderr from execSync error", () => {
    const error = new Error("fail") as Error & {
      status: number;
      stdout: Buffer;
      stderr: Buffer;
    };
    error.status = 1;
    error.stdout = Buffer.from("buffered output");
    error.stderr = Buffer.from("buffered error");
    mockExecSync.mockImplementationOnce(() => {
      throw error;
    });

    const result = runCLISmokeTest(makeSpec());

    expect(result.stdout).toBe("buffered output");
    expect(result.stderr).toBe("buffered error");
  });
});

// ── End-to-end smoke test scenario ───────────────────────────────────────────

describe("fleet CLI smoke test end-to-end scenario", () => {
  const mockExecSync = execSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it("fleet --help succeeds with expected output structure", () => {
    mockExecSync.mockReturnValueOnce(
      "Usage: orch fleet [options]\n\n" +
      "Side-by-side Claude vs Codex fleet performance comparison\n\n" +
      "Options:\n" +
      "  -d, --days <n>  Rolling window in days (default: 7)\n" +
      "  --json           Output raw JSON\n" +
      "  -h, --help       display help for command\n",
    );

    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const helpSpec = specs.find((s) => s.label.includes("fleet --help"))!;
    const result = runCLISmokeTest(helpSpec);

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("fleet");
    expect(result.stdout).toContain("comparison");
  });

  it("fleet --json returns valid JSON array", () => {
    const jsonOutput = JSON.stringify([
      {
        provider: "claude",
        agent_count: 5,
        done: 42,
        total_tasks: 50,
        success_rate_pct: 84,
        avg_quality_score: 0.87,
        avg_duration_ms: 120000,
        total_tokens: 500000,
      },
      {
        provider: "openai",
        agent_count: 5,
        done: 38,
        total_tasks: 45,
        success_rate_pct: 80,
        avg_quality_score: 0.82,
        avg_duration_ms: 95000,
        total_tokens: 350000,
      },
    ]);
    mockExecSync.mockReturnValueOnce(jsonOutput);

    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const jsonSpec = specs.find((s) => s.label.includes("fleet --json"))!;
    const result = runCLISmokeTest(jsonSpec);

    expect(result.passed).toBe(true);
    // Verify the output is actually parseable JSON
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].provider).toBe("claude");
    expect(parsed[1].provider).toBe("openai");
  });

  it("fleet --json returns empty array when no data (clean environment)", () => {
    mockExecSync.mockReturnValueOnce("[]");

    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const jsonSpec = specs.find((s) => s.label.includes("fleet --json"))!;
    const result = runCLISmokeTest(jsonSpec);

    expect(result.passed).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([]);
  });

  it("agents --help succeeds with expected output", () => {
    mockExecSync.mockReturnValueOnce(
      "Usage: orch agents [options] [command]\n\n" +
      "Manage fleet agents\n\n" +
      "Commands:\n" +
      "  list    List all registered agents\n" +
      "  sync    Sync agents from agents.yaml\n" +
      "  health  Check agent health\n",
    );

    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const agentsSpec = specs.find((s) => s.label.includes("agents --help"))!;
    const result = runCLISmokeTest(agentsSpec);

    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("agents");
  });

  it("generates comprehensive report when fleet CLI is broken", () => {
    // Simulate a broken CLI: fleet command exits with error
    const error = new Error("fail") as Error & {
      status: number;
      stdout: string;
      stderr: string;
    };
    error.status = 1;
    error.stdout = "";
    error.stderr = "Error: Cannot find module '../state/store.js'";

    // All three commands fail
    mockExecSync.mockImplementation(() => {
      throw error;
    });

    const specs = getFleetSmokeTestSpecs("/fake/orchestrator");
    const results = specs.map((spec) => runCLISmokeTest(spec));

    // All should fail
    expect(results.every((r) => !r.passed)).toBe(true);

    // Report should contain actionable information
    const report = formatSmokeTestReport(results);
    expect(report).toContain("FAIL");
    expect(report).toContain("not ready for operators");
    expect(report).toContain(`${specs.length}/${specs.length} smoke test(s) failed`);
  });
});
