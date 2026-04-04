import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateIssueRef,
  validateBranchFreshness,
  validatePRExists,
  validateMergeConflicts,
  validateTestsPass,
  validateUnrelatedFiles,
  validatePreSubmit,
  formatValidationSummary,
  ALWAYS_EXCLUDED_FILES,
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

// ─── validatePRExists ────────────────────────────────────────────────────────

describe("validatePRExists", () => {
  it("passes when no open PR exists for the branch", () => {
    mockExecSync.mockReturnValueOnce(""); // empty → no PR found

    const check = validatePRExists("owner/repo", "feature-branch");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/safe to create/i);
  });

  it("fails when an open PR already exists for the branch", () => {
    mockExecSync.mockReturnValueOnce("42\n"); // PR #42 found

    const check = validatePRExists("owner/repo", "feature-branch");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain("42");
    expect(check.detail).toMatch(/already exists/i);
  });

  it("passes (fail-open) when the gh CLI call fails", () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("gh error"); });

    const check = validatePRExists("owner/repo", "feature-branch");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });

  it("passes (skip) when no repo or branch is provided", () => {
    const check = validatePRExists("", "");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });
});

// ─── validateMergeConflicts ──────────────────────────────────────────────────

describe("validateMergeConflicts", () => {
  it("passes when GitHub API reports status 'ahead'", () => {
    mockExecSync.mockReturnValueOnce("ahead\n");

    const check = validateMergeConflicts("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no merge conflicts/i);
  });

  it("fails when GitHub API reports status 'conflicting'", () => {
    mockExecSync.mockReturnValueOnce("conflicting\n");

    const check = validateMergeConflicts("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/merge conflicts/i);
    expect(check.detail).toContain("rebase");
  });

  it("passes with a diverged note when status is 'diverged'", () => {
    mockExecSync.mockReturnValueOnce("diverged\n");

    const check = validateMergeConflicts("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/diverged/i);
  });

  it("falls back to local merge check when API fails and no conflicts found", () => {
    // API call fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch succeeds
    mockExecSync.mockReturnValueOnce("");
    // git merge --no-commit --no-ff succeeds (no conflicts)
    mockExecSync.mockReturnValueOnce("");
    // git merge --abort
    mockExecSync.mockReturnValueOnce("");

    const check = validateMergeConflicts("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no merge conflicts/i);
  });

  it("fails via local check when merge detects conflicts", () => {
    // API call fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch succeeds
    mockExecSync.mockReturnValueOnce("");
    // git merge --no-commit --no-ff fails with CONFLICT message
    mockExecSync.mockImplementationOnce(() => { throw new Error("CONFLICT (content): file.ts"); });
    // git merge --abort
    mockExecSync.mockReturnValueOnce("");

    const check = validateMergeConflicts("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/merge conflicts/i);
  });

  it("passes (fail-open) when both API and local checks fail", () => {
    mockExecSync.mockImplementation(() => { throw new Error("fail"); });

    const check = validateMergeConflicts("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });

  it("passes (skip) when no repo and no local path available", () => {
    const check = validateMergeConflicts("", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });
});

// ─── validatePreSubmit ───────────────────────────────────────────────────────

describe("validatePreSubmit", () => {
  it("returns valid when all six checks pass", async () => {
    // validateBranchFreshness → 0 behind
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → ahead (no conflicts)
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateTestsPass → no localPath, skips (no mock needed)
    // validateUnrelatedFiles → API returns normal files (no excluded)
    mockExecSync.mockReturnValueOnce("src/foo.ts\nsrc/foo.test.ts\n");

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
    expect(result.checks.prExists.passed).toBe(true);
    expect(result.checks.mergeConflicts.passed).toBe(true);
    expect(result.checks.testsPass.passed).toBe(true);
    expect(result.checks.unrelatedFiles.passed).toBe(true);
  });

  it("returns invalid when issue ref is missing", async () => {
    // validateIssueRef → findMatchingIssueNumber → gh issue list (no match)
    mockExecSync.mockReturnValueOnce("[]");
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

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
    // validateBranchFreshness → 2 behind
    mockExecSync.mockReturnValueOnce("2\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

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

  it("returns invalid with multiple blockers when issue ref and branch freshness fail", async () => {
    // validateIssueRef → findMatchingIssueNumber → gh issue list (no match)
    mockExecSync.mockReturnValueOnce("[]");
    // validateBranchFreshness → gh api compare → 4 behind
    mockExecSync.mockReturnValueOnce("4\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

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

  it("returns invalid when a duplicate PR already exists for the branch", async () => {
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → PR #99 already exists
    mockExecSync.mockReturnValueOnce("99\n");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-30-feat",
      "Closes #30",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.checks.prExists.passed).toBe(false);
    expect(result.blockers.some((b) => b.includes("99"))).toBe(true);
  });

  it("returns invalid when branch has merge conflicts", async () => {
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → conflicting
    mockExecSync.mockReturnValueOnce("conflicting\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-40-feat",
      "Closes #40",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.checks.mergeConflicts.passed).toBe(false);
    expect(result.blockers.some((b) => b.toLowerCase().includes("conflict"))).toBe(true);
  });

  it("returns invalid when branch contains excluded files", async () => {
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → returns an excluded file
    mockExecSync.mockReturnValueOnce("src/feature.ts\n.orchestrator-deploy-sha\n");

    const result = await validatePreSubmit(
      "owner/repo",
      "issue-50-feat",
      "Closes #50",
      null,
      minimalConfig,
    );

    expect(result.valid).toBe(false);
    expect(result.checks.unrelatedFiles.passed).toBe(false);
    expect(result.blockers.some((b) => b.includes(".orchestrator-deploy-sha"))).toBe(true);
  });

  it("includes inferredIssueNumber when branch encodes an issue", async () => {
    // validateBranchFreshness → current
    mockExecSync.mockReturnValueOnce("0\n");
    // validatePRExists → no existing PR
    mockExecSync.mockReturnValueOnce("");
    // validateMergeConflicts → no conflicts
    mockExecSync.mockReturnValueOnce("ahead\n");
    // validateUnrelatedFiles → API fails, skip
    mockExecSync.mockImplementationOnce(() => { throw new Error("API unavailable"); });

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

// ─── validateTestsPass ───────────────────────────────────────────────────────

describe("validateTestsPass", () => {
  it("passes (skip) when no local path is provided", () => {
    const check = validateTestsPass(null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("passes (skip) when package.json does not exist in localPath", () => {
    // test -f package.json fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("not found"); });

    const check = validateTestsPass("/some/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/no package\.json/i);
  });

  it("passes when tsc and vitest both succeed", () => {
    // test -f package.json
    mockExecSync.mockReturnValueOnce("");
    // npx tsc --noEmit
    mockExecSync.mockReturnValueOnce("");
    // npx vitest run
    mockExecSync.mockReturnValueOnce("");

    const check = validateTestsPass("/some/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/passed/i);
  });

  it("fails when tsc type-check fails", () => {
    // test -f package.json
    mockExecSync.mockReturnValueOnce("");
    // npx tsc --noEmit fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("src/foo.ts(10,3): error TS2322: Type 'number' is not assignable to type 'string'.");
    });

    const check = validateTestsPass("/some/path");
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/type check failed/i);
    expect(check.detail).toContain("TS2322");
  });

  it("fails when vitest run fails (tsc passes)", () => {
    // test -f package.json
    mockExecSync.mockReturnValueOnce("");
    // npx tsc --noEmit passes
    mockExecSync.mockReturnValueOnce("");
    // npx vitest run fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error("FAIL src/foo.test.ts\n× expected 1 to equal 2");
    });

    const check = validateTestsPass("/some/path");
    expect(check.passed).toBe(false);
    expect(check.detail).toMatch(/tests failed/i);
  });
});

// ─── validateUnrelatedFiles ──────────────────────────────────────────────────

describe("validateUnrelatedFiles", () => {
  it("passes when changed files contain no excluded entries (via API)", () => {
    mockExecSync.mockReturnValueOnce("src/foo.ts\nsrc/foo.test.ts\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("2 changed file(s)");
  });

  it("fails when API reports .orchestrator-deploy-sha in the diff", () => {
    mockExecSync.mockReturnValueOnce("src/foo.ts\n.orchestrator-deploy-sha\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain(".orchestrator-deploy-sha");
    expect(check.detail).toMatch(/must not be committed/i);
  });

  it("fails when API reports a .env file in the diff", () => {
    mockExecSync.mockReturnValueOnce("src/index.ts\n.env\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain(".env");
  });

  it("detects excluded file nested in a subdirectory path", () => {
    mockExecSync.mockReturnValueOnce("config/.env.local\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", null);
    expect(check.passed).toBe(false);
    expect(check.detail).toContain(".env.local");
  });

  it("falls back to local git diff when API fails", () => {
    // GitHub API fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch
    mockExecSync.mockReturnValueOnce("");
    // git diff --name-only origin/main → only normal files
    mockExecSync.mockReturnValueOnce("src/bar.ts\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toContain("1 changed file(s)");
  });

  it("fails via local git diff when excluded file is detected", () => {
    // GitHub API fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // git fetch
    mockExecSync.mockReturnValueOnce("");
    // git diff --name-only origin/main → contains excluded file
    mockExecSync.mockReturnValueOnce("src/bar.ts\n.orchestrator-deploy-sha\n");

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(false);
    expect(check.detail).toContain(".orchestrator-deploy-sha");
  });

  it("passes (skip) when no changed files can be determined", () => {
    // API fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("API error"); });
    // local git also fails
    mockExecSync.mockImplementationOnce(() => { throw new Error("git error"); });

    const check = validateUnrelatedFiles("owner/repo", "feature-branch", "/local/path");
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });

  it("passes (skip) when no repo and no local path available", () => {
    const check = validateUnrelatedFiles("", "feature-branch", null);
    expect(check.passed).toBe(true);
    expect(check.detail).toMatch(/skipping/i);
  });

  it("ALWAYS_EXCLUDED_FILES includes the orchestrator deploy sha marker", () => {
    expect(ALWAYS_EXCLUDED_FILES).toContain(".orchestrator-deploy-sha");
  });

  it("ALWAYS_EXCLUDED_FILES includes .env variants", () => {
    expect(ALWAYS_EXCLUDED_FILES).toContain(".env");
    expect(ALWAYS_EXCLUDED_FILES).toContain(".env.local");
    expect(ALWAYS_EXCLUDED_FILES).toContain(".env.production");
  });
});

// ─── formatValidationSummary ─────────────────────────────────────────────────

/** Helper to build a minimal passing PreSubmitValidationResult for summary tests. */
function makeResult(overrides: Partial<{
  valid: boolean;
  issueRef: { passed: boolean; detail: string };
  branchFresh: { passed: boolean; detail: string };
  prExists: { passed: boolean; detail: string };
  mergeConflicts: { passed: boolean; detail: string };
  testsPass: { passed: boolean; detail: string };
  unrelatedFiles: { passed: boolean; detail: string };
  blockers: string[];
  warnings: string[];
}> = {}) {
  return {
    valid: overrides.valid ?? true,
    checks: {
      issueRef: overrides.issueRef ?? { passed: true, detail: "Has Closes #1" },
      branchFresh: overrides.branchFresh ?? { passed: true, detail: "Up to date" },
      prExists: overrides.prExists ?? { passed: true, detail: "No duplicate PR" },
      mergeConflicts: overrides.mergeConflicts ?? { passed: true, detail: "No merge conflicts" },
      testsPass: overrides.testsPass ?? { passed: true, detail: "Tests passed" },
      unrelatedFiles: overrides.unrelatedFiles ?? { passed: true, detail: "No unrelated files" },
    },
    blockers: overrides.blockers ?? [],
    warnings: overrides.warnings ?? [],
  };
}

describe("formatValidationSummary", () => {
  it("includes check icons for passing and failing checks", () => {
    const result = makeResult({
      valid: false,
      issueRef: { passed: false, detail: "Missing Closes #N" },
      blockers: ["Missing Closes #N"],
    });

    const summary = formatValidationSummary(result);
    expect(summary).toContain("❌");
    expect(summary).toContain("✅");
    expect(summary).toContain("Missing Closes #N");
    expect(summary).toContain("Up to date");
  });

  it("includes all six check lines in the summary", () => {
    const summary = formatValidationSummary(makeResult());
    expect(summary).toContain("Issue reference");
    expect(summary).toContain("Branch freshness");
    expect(summary).toContain("No duplicate PR");
    expect(summary).toContain("Merge conflicts");
    expect(summary).toContain("Tests pass");
    expect(summary).toContain("No unrelated files");
  });

  it("includes blockers section when validation fails", () => {
    const result = makeResult({
      valid: false,
      issueRef: { passed: false, detail: "Missing ref" },
      branchFresh: { passed: false, detail: "Branch is stale" },
      mergeConflicts: { passed: false, detail: "Has conflicts" },
      blockers: ["Missing ref", "Branch is stale", "Has conflicts"],
    });

    const summary = formatValidationSummary(result);
    expect(summary).toContain("Action required");
    expect(summary).toContain("Missing ref");
    expect(summary).toContain("Branch is stale");
    expect(summary).toContain("Has conflicts");
  });

  it("does not include action required section when valid", () => {
    const summary = formatValidationSummary(makeResult());
    expect(summary).not.toContain("Action required");
    expect(summary).toContain("✅");
  });

  it("includes warnings section when warnings are present", () => {
    const result = makeResult({ warnings: ["CI not yet run on this branch"] });

    const summary = formatValidationSummary(result);
    expect(summary).toContain("Warnings");
    expect(summary).toContain("CI not yet run");
  });

  it("shows failing tests check in summary when tests fail", () => {
    const result = makeResult({
      valid: false,
      testsPass: { passed: false, detail: "Unit tests failed. Fix failing tests before submitting." },
      blockers: ["Unit tests failed."],
    });

    const summary = formatValidationSummary(result);
    expect(summary).toContain("Tests pass");
    expect(summary).toContain("❌");
    expect(summary).toContain("Unit tests failed");
  });

  it("shows failing unrelated files check in summary when excluded file found", () => {
    const result = makeResult({
      valid: false,
      unrelatedFiles: { passed: false, detail: "Branch contains .orchestrator-deploy-sha" },
      blockers: ["Branch contains .orchestrator-deploy-sha"],
    });

    const summary = formatValidationSummary(result);
    expect(summary).toContain("No unrelated files");
    expect(summary).toContain(".orchestrator-deploy-sha");
  });
});
