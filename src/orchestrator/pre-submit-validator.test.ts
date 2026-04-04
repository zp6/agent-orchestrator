import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateIssueRef,
  validateBranchFreshness,
  validatePreSubmit,
  formatValidationSummary,
} from "./pre-submit-validator.js";
import type { OrchestratorConfig } from "../config/schema.js";

const mockExecSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock LLM client — tests will override when needed
vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    messages: {
      create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "none" }] }),
    },
  }),
}));

const minimalConfig = {
  agents: {},
  base_dir: "/tmp",
  orchestrator_dir: "/tmp/orch",
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 30000 },
} as unknown as OrchestratorConfig;

beforeEach(() => {
  mockExecSync.mockReset();
});

// ─── validateIssueRef ────────────────────────────────────────────────────────

describe("validateIssueRef", () => {
  it("passes when body contains 'Closes #N'", async () => {
    const { check } = await validateIssueRef(
      "Implements the feature.\n\nCloses #42",
      "owner/repo",
      "issue-42-feature",
    );
    expect(check.passed).toBe(true);
  });

  it("passes for 'closes' (lowercase)", async () => {
    const { check } = await validateIssueRef(
      "closes #10",
      "owner/repo",
      "issue-10-branch",
    );
    expect(check.passed).toBe(true);
  });

  it("passes for 'Fixes #N'", async () => {
    const { check } = await validateIssueRef(
      "Fixes #99",
      "owner/repo",
      "issue-99-fix",
    );
    expect(check.passed).toBe(true);
  });

  it("passes for 'Resolves #N'", async () => {
    const { check } = await validateIssueRef(
      "Resolves #7",
      "owner/repo",
      "issue-7-branch",
    );
    expect(check.passed).toBe(true);
  });

  it("fails when body has no issue reference", async () => {
    // execSync called for gh issue list — return empty
    mockExecSync.mockReturnValueOnce("[]");

    const { check } = await validateIssueRef(
      "Just a description with no issue ref",
      "owner/repo",
      "feature-branch",
    );
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/missing/i);
  });

  it("fails but infers issue number from branch name when body missing ref", async () => {
    // findMatchingIssueNumber uses branch-name parsing — no execSync needed
    const { check, inferredIssueNumber } = await validateIssueRef(
      "No closes ref in here",
      "owner/repo",
      "issue-55-some-feature",
    );
    expect(check.passed).toBe(false);
    expect(inferredIssueNumber).toBe("55");
    expect(check.detail).toContain("55");
  });

  it("fails with actionable message when no issue can be inferred", async () => {
    mockExecSync.mockReturnValueOnce("[]");

    const { check, inferredIssueNumber } = await validateIssueRef(
      "Description only",
      "owner/repo",
      "generic-branch-no-number",
    );
    expect(check.passed).toBe(false);
    expect(inferredIssueNumber).toBeUndefined();
    expect(check.detail).toContain("gh issue list");
  });
});

// ─── validateBranchFreshness ─────────────────────────────────────────────────

describe("validateBranchFreshness", () => {
  it("passes when branch is 0 commits behind main (via API)", () => {
    mockExecSync.mockReturnValueOnce("0\n");

    const check = validateBranchFreshness("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/up to date/i);
  });

  it("fails when branch is behind main (via API)", () => {
    mockExecSync.mockReturnValueOnce("3\n");

    const check = validateBranchFreshness("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("3 commit(s) behind");
    expect(check.detail).toContain("rebase");
  });

  it("passes when API fails but local git shows branch is current", () => {
    // API call fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch
    mockExecSync.mockReturnValueOnce("");
    // rev-list: 0 commits behind
    mockExecSync.mockReturnValueOnce("0\n");

    const check = validateBranchFreshness("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(true);
  });

  it("fails when local git shows branch is behind main", () => {
    // API call fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch
    mockExecSync.mockReturnValueOnce("");
    // rev-list: 5 commits behind
    mockExecSync.mockReturnValueOnce("5\n");

    const check = validateBranchFreshness("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("5 commit(s) behind");
  });

  it("passes (with warning detail) when both API and local checks fail", () => {
    mockExecSync.mockImplementation(() => { throw new Error("fail"); });

    const check = validateBranchFreshness("owner/repo", "feature-branch", "/local/path");
    // Fail-open: don't block PRs just because we can't check freshness
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });

  it("passes (with skip detail) when no repo or local path available", () => {
    const check = validateBranchFreshness("", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });
});

// ─── validatePreSubmit ───────────────────────────────────────────────────────

describe("validatePreSubmit", () => {
  it("returns valid when both checks pass", async () => {
    // branchFreshness API call → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-10-feature",
      "Implements stuff.\n\nCloses #10",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(true);
    expect(result.blockers).toHaveLength(0);
    expect(result.checks.issueRef.passed).toBe(true);
    expect(result.checks.branchFresh.passed).toBe(true);
  });

  it("returns invalid when issue ref is missing", async () => {
    // validateIssueRef → findMatchingIssueNumber → gh issue list (no match)
    mockExecSync.mockReturnValueOnce("[]");
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "generic-feature-branch",
      "No closes reference here",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.checks.issueRef.passed).toBe(false);
    expect(result.blockers.length).toBeGreaterThanOrEqual(1);
  });

  it("returns invalid when branch is behind main", async () => {
    // branchFreshness → 2 behind
    mockExecSync.mockReturnValueOnce("2\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-20-feat",
      "Closes #20",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.checks.branchFresh.passed).toBe(false);
    expect(result.blockers.some((b) => b.includes("behind"))).toBe(true);
  });

  it("returns invalid with multiple blockers when both checks fail", async () => {
    // validateIssueRef → findMatchingIssueNumber → gh issue list (no match)
    mockExecSync.mockReturnValueOnce("[]");
    // validateBranchFreshness → gh api compare → 4 behind
    mockExecSync.mockReturnValueOnce("4\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "no-number-branch",
      "Just a description",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.blockers.length).toBe(2);
  });

  it("includes inferredIssueNumber when branch encodes an issue", async () => {
    // branchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-77-some-feature",
      "No closes ref in body",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.inferredIssueNumber).toBe("77");
  });
});

// ─── formatValidationSummary ─────────────────────────────────────────────────

describe("formatValidationSummary", () => {
  it("includes check icons for passing and failing checks", () => {
    const result = {
      valid: false,
      checks: {
        issueRef: { passed: false, detail: "Missing Closes #N" },
        branchFresh: { passed: true, detail: "Up to date with main" },
      },
      blockers: ["Missing Closes #N"],
      warnings: [],
    };

    const summary = formatValidationSummary(result);
    expect(summary).toContain("❌");
    expect(summary).toContain("✅");
    expect(summary).toContain("Missing Closes #N");
    expect(summary).toContain("Up to date with main");
  });

  it("includes blockers section when validation fails", () => {
    const result = {
      valid: false,
      checks: {
        issueRef: { passed: false, detail: "Missing ref" },
        branchFresh: { passed: false, detail: "Branch is stale" },
      },
      blockers: ["Missing ref", "Branch is stale"],
      warnings: [],
    };

    const summary = formatValidationSummary(result);
    expect(summary).toContain("Action required");
    expect(summary).toContain("Missing ref");
    expect(summary).toContain("Branch is stale");
  });

  it("does not include action required section when valid", () => {
    const result = {
      valid: true,
      checks: {
        issueRef: { passed: true, detail: "Has Closes #42" },
        branchFresh: { passed: true, detail: "Up to date" },
      },
      blockers: [],
      warnings: [],
    };

    const summary = formatValidationSummary(result);
    expect(summary).not.toContain("Action required");
    expect(summary).toContain("✅");
  });

  it("includes warnings section when warnings are present", () => {
    const result = {
      valid: true,
      checks: {
        issueRef: { passed: true, detail: "Has ref" },
        branchFresh: { passed: true, detail: "Up to date" },
      },
      blockers: [],
      warnings: ["CI not yet run on this branch"],
    };

    const summary = formatValidationSummary(result);
    expect(summary).toContain("Warnings");
    expect(summary).toContain("CI not yet run");
  });
});
