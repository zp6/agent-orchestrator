/**
 * Tests for post-merge-regression-detector (issue #993)
 *
 * Verifies:
 *  - parseFailingTests() correctly extracts test names from vitest/jest output
 *  - buildRegressionIssueBody() generates a well-formed issue body
 *  - openRegressionIssue() creates a GitHub issue with correct title/labels
 *  - Duplicate detection prevents double-creation for the same PR
 *  - Fail-open: errors in gh CLI never throw to callers
 *  - PostMergeRegressionDetector.run() delegates to openRegressionIssue
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as childProcess from "node:child_process";
import {
  parseFailingTests,
  buildRegressionIssueBody,
  openRegressionIssue,
  PostMergeRegressionDetector,
  REGRESSION_LABEL,
  MAX_FAILING_TESTS_IN_ISSUE,
} from "./post-merge-regression-detector.js";
import type { OrchestratorConfig } from "../config/schema.js";

vi.mock("node:child_process");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CONFIG = {
  proxy: { url: "http://localhost:3471", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "test-agent": {
      dir: "agent",
      description: "Test agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/repo",
    },
  },
} satisfies OrchestratorConfig;

const NOW_ISO = "2026-04-19T12:00:00.000Z";

// ── parseFailingTests ─────────────────────────────────────────────────────────

describe("parseFailingTests", () => {
  it("parses vitest verbose × markers", () => {
    const output = `
 ✓ passing test 1
 × failing test A
 ✓ passing test 2
 × failing test B
`;
    const result = parseFailingTests(output);
    expect(result).toEqual(["failing test A", "failing test B"]);
  });

  it("parses vitest verbose ✕ markers", () => {
    const output = ` ✕ test suite > my failing test`;
    const result = parseFailingTests(output);
    expect(result).toContain("test suite > my failing test");
  });

  it("parses vitest FAILED summary lines", () => {
    const output = `
FAILED src/__tests__/foo.test.ts > Suite > my test
FAILED src/__tests__/bar.test.ts > Other > another test
`;
    const result = parseFailingTests(output);
    expect(result).toContain("Suite > my test");
    expect(result).toContain("Other > another test");
  });

  it("parses jest ● bullet format", () => {
    const output = `
  ● Suite › should do the thing
  ● Suite › should do the other thing
`;
    const result = parseFailingTests(output);
    expect(result).toContain("should do the thing");
    expect(result).toContain("should do the other thing");
  });

  it("falls back to suite file names when no individual tests found", () => {
    const output = `
 FAIL src/__tests__/flaky.test.ts
 FAIL src/__tests__/other.spec.ts
`;
    const result = parseFailingTests(output);
    expect(result).toContain("src/__tests__/flaky.test.ts");
    expect(result).toContain("src/__tests__/other.spec.ts");
  });

  it("deduplicates repeated test names", () => {
    const output = `
 × duplicate test
 × duplicate test
 × unique test
`;
    const result = parseFailingTests(output);
    expect(result.filter((t) => t === "duplicate test")).toHaveLength(1);
    expect(result).toContain("unique test");
  });

  it("returns empty array for empty output", () => {
    expect(parseFailingTests("")).toEqual([]);
    expect(parseFailingTests("   ")).toEqual([]);
  });

  it("returns empty array when all tests pass", () => {
    const output = `
 ✓ passing test 1
 ✓ passing test 2
 Test Files  1 passed (1)
 Tests  2 passed (2)
`;
    expect(parseFailingTests(output)).toEqual([]);
  });
});

// ── buildRegressionIssueBody ──────────────────────────────────────────────────

describe("buildRegressionIssueBody", () => {
  const baseOpts = {
    repo: "owner/repo",
    prNumber: 42,
    mergeSha: "abc1234567890",
    testOutput: "× test A failed\n× test B failed",
    nowIso: NOW_ISO,
  };

  it("includes the PR number and link", () => {
    const body = buildRegressionIssueBody(baseOpts, ["test A failed", "test B failed"]);
    expect(body).toContain("[#42](https://github.com/owner/repo/pull/42)");
  });

  it("includes the short merge SHA", () => {
    const body = buildRegressionIssueBody(baseOpts, []);
    expect(body).toContain("`abc12345`");
  });

  it("includes the detection timestamp", () => {
    const body = buildRegressionIssueBody(baseOpts, []);
    expect(body).toContain(NOW_ISO);
  });

  it("lists failing test names as code items", () => {
    const body = buildRegressionIssueBody(baseOpts, ["failing test A", "failing test B"]);
    expect(body).toContain("- `failing test A`");
    expect(body).toContain("- `failing test B`");
  });

  it("shows fallback message when no test names parsed", () => {
    const body = buildRegressionIssueBody(baseOpts, []);
    expect(body).toMatch(/could not parse individual test names/i);
  });

  it("truncates raw output longer than MAX_RAW_OUTPUT_IN_ISSUE", () => {
    const longOutput = "x".repeat(5000);
    const body = buildRegressionIssueBody({ ...baseOpts, testOutput: longOutput }, []);
    expect(body).toContain("…(truncated)");
  });

  it("caps the number of failing tests at MAX_FAILING_TESTS_IN_ISSUE", () => {
    const manyTests = Array.from({ length: 30 }, (_, i) => `test ${i}`);
    const body = buildRegressionIssueBody(baseOpts, manyTests);
    expect(body).toContain(`…and ${30 - MAX_FAILING_TESTS_IN_ISSUE} more`);
  });
});

// ── openRegressionIssue ───────────────────────────────────────────────────────

describe("openRegressionIssue", () => {
  beforeEach(() => vi.resetAllMocks());

  it("creates a GitHub issue and returns the result", async () => {
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce("[]") // gh issue list (duplicate check)
      .mockReturnValueOnce("https://github.com/owner/repo/issues/55\n"); // gh issue create

    const result = await openRegressionIssue({
      repo: "owner/repo",
      prNumber: 42,
      mergeSha: "abc1234",
      testOutput: "× failing test A\n× failing test B",
      nowIso: NOW_ISO,
    });

    expect(result).not.toBeNull();
    expect(result!.url).toContain("issues/55");
    expect(result!.number).toBe(55);
    expect(result!.title).toBe("[post-merge regression] PR #42 broke tests");
    expect(result!.failingTests).toEqual(["failing test A", "failing test B"]);
  });

  it("passes --label regression to gh issue create", async () => {
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce("https://github.com/owner/repo/issues/56\n");

    await openRegressionIssue({
      repo: "owner/repo",
      prNumber: 43,
      mergeSha: "def5678",
      testOutput: "× test failed",
      nowIso: NOW_ISO,
    });

    const createCall = vi.mocked(childProcess.execSync).mock.calls[1][0] as string;
    expect(createCall).toContain("gh issue create");
    expect(createCall).toContain(REGRESSION_LABEL);
  });

  it("skips creation when a duplicate issue already exists", async () => {
    vi.mocked(childProcess.execSync).mockReturnValueOnce(
      JSON.stringify([{ number: 50, url: "https://github.com/owner/repo/issues/50" }]),
    );

    const result = await openRegressionIssue({
      repo: "owner/repo",
      prNumber: 42,
      mergeSha: "abc1234",
      testOutput: "× test failed",
      nowIso: NOW_ISO,
    });

    // Should return existing issue, not create a new one
    expect(result).not.toBeNull();
    expect(result!.number).toBe(50);
    // gh issue create should NOT have been called
    expect(vi.mocked(childProcess.execSync)).toHaveBeenCalledTimes(1);
  });

  it("returns null and does not throw when gh CLI fails", async () => {
    vi.mocked(childProcess.execSync).mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const result = await openRegressionIssue({
      repo: "owner/repo",
      prNumber: 42,
      mergeSha: "abc1234",
      testOutput: "× test failed",
      nowIso: NOW_ISO,
    });

    expect(result).toBeNull(); // fail-open
  });
});

// ── PostMergeRegressionDetector ───────────────────────────────────────────────

describe("PostMergeRegressionDetector", () => {
  beforeEach(() => vi.resetAllMocks());

  it("run() creates a regression issue and returns it", async () => {
    vi.mocked(childProcess.execSync)
      .mockReturnValueOnce("[]")
      .mockReturnValueOnce("https://github.com/owner/repo/issues/60\n");

    const detector = new PostMergeRegressionDetector(MOCK_CONFIG);
    const result = await detector.run(
      "owner/repo",
      42,
      "deadbeef",
      "× a failing test",
      NOW_ISO,
    );

    expect(result).not.toBeNull();
    expect(result!.number).toBe(60);
    expect(result!.failingTests).toContain("a failing test");
  });

  it("run() returns null on gh error (fail-open)", async () => {
    vi.mocked(childProcess.execSync).mockImplementation(() => {
      throw new Error("network error");
    });

    const detector = new PostMergeRegressionDetector(MOCK_CONFIG);
    const result = await detector.run("owner/repo", 1, "sha", "× broken", NOW_ISO);
    expect(result).toBeNull();
  });
});
