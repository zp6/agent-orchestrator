import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config as loadDotenv } from "dotenv";

// We test the dotenv-loading logic directly (following the pid.test.ts convention)
// rather than importing daemon-entry.ts, which has side effects (starts the daemon).
// The logic under test: loadDotenv({ path: <canonical-path> }) correctly populates
// process.env from the operator's ~/.claude-orchestrator/.env file.
// See: agent-orchestrator#1539.

describe("daemon-entry dotenv loading logic", () => {
  let envPath: string;
  const TEST_VAR = `ORCH_DOTENV_TEST_${Date.now()}`;

  beforeEach(() => {
    envPath = join(tmpdir(), `orch-daemon-entry-test-${Date.now()}.env`);
    // Ensure any previous value is cleared
    delete process.env[TEST_VAR];
  });

  afterEach(() => {
    try {
      unlinkSync(envPath);
    } catch {}
    delete process.env[TEST_VAR];
  });

  it("loads a var from a .env file at the configured canonical path", () => {
    writeFileSync(envPath, `${TEST_VAR}=hello-from-dotenv\n`);

    loadDotenv({ path: envPath });

    expect(process.env[TEST_VAR]).toBe("hello-from-dotenv");
  });

  it("does not override a var already set in the shell environment", () => {
    // Simulate the shell having exported the var before starting the daemon
    process.env[TEST_VAR] = "from-shell";
    writeFileSync(envPath, `${TEST_VAR}=from-dotenv-file\n`);

    // override: false (the default) means shell-set values win
    loadDotenv({ path: envPath, override: false });

    expect(process.env[TEST_VAR]).toBe("from-shell");
  });

  it("ignores a missing .env file gracefully (no exception thrown)", () => {
    const missingPath = join(tmpdir(), `orch-daemon-entry-missing-${Date.now()}.env`);
    expect(existsSync(missingPath)).toBe(false);

    // dotenv silently skips missing files when debug is not set
    expect(() => loadDotenv({ path: missingPath })).not.toThrow();
  });

  it("loads multiple vars from one .env file", () => {
    const varA = `${TEST_VAR}_A`;
    const varB = `${TEST_VAR}_B`;
    delete process.env[varA];
    delete process.env[varB];

    writeFileSync(envPath, `${varA}=alpha\n${varB}=beta\n`);

    loadDotenv({ path: envPath });

    expect(process.env[varA]).toBe("alpha");
    expect(process.env[varB]).toBe("beta");

    delete process.env[varA];
    delete process.env[varB];
  });

  it("correctly represents the REVENUE_EXECUTOR_ENABLED flag pattern", () => {
    writeFileSync(envPath, `REVENUE_EXECUTOR_ENABLED_TEST_${Date.now()}=true\n`);
    // More relevant: use TEST_VAR which we own
    writeFileSync(envPath, `${TEST_VAR}=true\n`);

    loadDotenv({ path: envPath });

    // Flags read as strings; callers typically compare against "true" or check truthiness
    expect(process.env[TEST_VAR]).toBe("true");
    expect(process.env[TEST_VAR] === "true").toBe(true);
  });
});
