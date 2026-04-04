import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { registerPreflightCommand } from "./preflight.js";

const mockValidatePreSubmit = vi.fn();

vi.mock("../../orchestrator/pre-submit-validator.js", () => ({
  validatePreSubmit: (...args: unknown[]) => mockValidatePreSubmit(...args),
}));

vi.mock("../../config/schema.js", () => ({
  loadConfig: vi.fn().mockReturnValue({ agents: {}, base_dir: "/tmp", orchestrator_dir: "/tmp/orch", proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 30000 } }),
}));

// Capture process.exit calls without actually exiting
const mockExit = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null | undefined) => {
  throw new Error(`process.exit(${code})`);
});

// Suppress chalk output in tests
vi.spyOn(console, "log").mockImplementation(() => {});

const passingResult = {
  valid: true,
  checks: {
    issueRef: { passed: true, detail: "PR body contains Closes #N reference." },
    branchFresh: { passed: true, detail: "Branch is up to date with main." },
    prExists: { passed: true, detail: "No open PR exists for branch — safe to create." },
    mergeConflicts: { passed: true, detail: "No merge conflicts detected with main." },
  },
  blockers: [],
  warnings: [],
};

const failingResult = {
  valid: false,
  checks: {
    issueRef: { passed: false, detail: 'PR body is missing "Closes #N" reference.' },
    branchFresh: { passed: false, detail: "Branch is 2 commit(s) behind main. Rebase before submitting." },
    prExists: { passed: true, detail: "No open PR exists for branch — safe to create." },
    mergeConflicts: { passed: true, detail: "No merge conflicts detected with main." },
  },
  blockers: [
    'PR body is missing "Closes #N" reference.',
    "Branch is 2 commit(s) behind main. Rebase before submitting.",
  ],
  warnings: [],
};

function buildProgram(): Command {
  const program = new Command();
  program.option("-c, --config <path>", "Config path");
  registerPreflightCommand(program);
  return program;
}

beforeEach(() => {
  mockValidatePreSubmit.mockReset();
  mockExit.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("registerPreflightCommand", () => {
  it("registers the 'preflight' command on the program", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("preflight");
  });

  it("calls validatePreSubmit with the provided repo, branch, and body", async () => {
    mockValidatePreSubmit.mockResolvedValue(passingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-42-feature",
        "--body", "Implements the feature.\n\nCloses #42",
      ]),
    ).rejects.toThrow("process.exit(0)");

    expect(mockValidatePreSubmit).toHaveBeenCalledWith(
      "owner/repo",
      "issue-42-feature",
      "Implements the feature.\n\nCloses #42",
      null,
      expect.anything(),
    );
  });

  it("exits with code 0 when all checks pass", async () => {
    mockValidatePreSubmit.mockResolvedValue(passingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-10-feature",
        "--body", "Closes #10",
      ]),
    ).rejects.toThrow("process.exit(0)");

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("exits with code 1 when checks fail", async () => {
    mockValidatePreSubmit.mockResolvedValue(failingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "no-issue-branch",
        "--body", "Just a description",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("defaults body to empty string when --body is not provided", async () => {
    mockValidatePreSubmit.mockResolvedValue(passingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-55-feat",
      ]),
    ).rejects.toThrow("process.exit(0)");

    const [, , body] = mockValidatePreSubmit.mock.calls[0] as string[];
    expect(body).toBe("");
  });

  it("passes localPath to validatePreSubmit when --local-path is provided", async () => {
    mockValidatePreSubmit.mockResolvedValue(passingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-10-feat",
        "--local-path", "/workspace/repo",
      ]),
    ).rejects.toThrow("process.exit(0)");

    const [, , , localPath] = mockValidatePreSubmit.mock.calls[0] as string[];
    expect(localPath).toBe("/workspace/repo");
  });

  it("outputs JSON when --json flag is provided and exits 0 on pass", async () => {
    mockValidatePreSubmit.mockResolvedValue(passingResult);
    const logSpy = vi.spyOn(console, "log");

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-10-feat",
        "--body", "Closes #10",
        "--json",
      ]),
    ).rejects.toThrow("process.exit(0)");

    // Find the JSON output call
    const jsonCall = logSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return typeof parsed === "object" && "valid" in parsed;
      } catch {
        return false;
      }
    });

    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.valid).toBe(true);
  });

  it("outputs JSON with exit code 1 when checks fail (--json flag)", async () => {
    mockValidatePreSubmit.mockResolvedValue(failingResult);

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "no-issue-branch",
        "--json",
      ]),
    ).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("shows inferred issue number tip when available on failure", async () => {
    const resultWithInferred = {
      ...failingResult,
      inferredIssueNumber: "77",
    };
    mockValidatePreSubmit.mockResolvedValue(resultWithInferred);
    const logSpy = vi.spyOn(console, "log");

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-77-feat",
        "--body", "No closes ref",
      ]),
    ).rejects.toThrow("process.exit(1)");

    const allOutput = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    // The tip should mention the inferred issue number
    expect(allOutput).toContain("77");
  });

  it("shows warnings when present in the result", async () => {
    const resultWithWarning = {
      ...passingResult,
      warnings: ["CI not yet run on this branch"],
    };
    mockValidatePreSubmit.mockResolvedValue(resultWithWarning);
    const logSpy = vi.spyOn(console, "log");

    const program = buildProgram();

    await expect(
      program.parseAsync([
        "node", "orch", "preflight",
        "--repo", "owner/repo",
        "--branch", "issue-10-feat",
        "--body", "Closes #10",
      ]),
    ).rejects.toThrow("process.exit(0)");

    const allOutput = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(allOutput).toContain("CI not yet run");
  });
});
