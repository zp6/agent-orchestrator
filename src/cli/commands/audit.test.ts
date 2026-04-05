import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";
import { registerAuditCommand } from "./audit.js";

// ── Mock the auditor module ───────────────────────────────────────────────────

const mockAuditAll = vi.fn();

vi.mock("../../orchestrator/auditor.js", () => ({
  auditAll: (...args: unknown[]) => mockAuditAll(...args),
}));

vi.mock("../../config/schema.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    agents: {
      "agent-a": { github: "owner/agent-a", dir: "agent-a", description: "", capabilities: [], owns_topics: [] },
      "agent-b": { github: "owner/agent-b", dir: "agent-b", description: "", capabilities: [], owns_topics: [] },
      "agent-no-github": { dir: "agent-no-github", description: "", capabilities: [], owns_topics: [] },
    },
    base_dir: "/tmp",
    orchestrator_dir: "/tmp/orch",
    proxy: { url: "http://localhost:3457", timeout_ms: 30000 },
  }),
}));

const mockExit = vi
  .spyOn(process, "exit")
  .mockImplementation((code?: number | string | null | undefined) => {
    throw new Error(`process.exit(${code})`);
  });

const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

const CLEAN_RESULT = {
  repos: [],
  totalGaps: 0,
  orphanIssues: 0,
  zombieIssues: 0,
  unlinkedPRs: 0,
  elapsedMs: 42,
};

const GAPS_RESULT = {
  repos: [
    {
      repo: "owner/agent-a",
      agent: "agent-a",
      gaps: [
        {
          kind: "orphan-issue" as const,
          repo: "owner/agent-a",
          agent: "agent-a",
          issueNumber: 10,
          title: "Fix the thing",
          ageDays: 14,
          url: "https://github.com/owner/agent-a/issues/10",
          fix: 'orch dispatch "Investigate issue #10" --agent=agent-a',
        },
        {
          kind: "zombie-issue" as const,
          repo: "owner/agent-a",
          agent: "agent-a",
          issueNumber: 7,
          title: "Old bug",
          mergedPrNumber: 11,
          url: "https://github.com/owner/agent-a/issues/7",
          fix: "gh issue close 7 --repo owner/agent-a --comment \"...\"",
        },
        {
          kind: "unlinked-pr" as const,
          repo: "owner/agent-a",
          agent: "agent-a",
          prNumber: 12,
          title: "My new feature",
          url: "https://github.com/owner/agent-a/pull/12",
          fix: "gh pr edit 12 --repo owner/agent-a ...",
        },
      ],
    },
  ],
  totalGaps: 3,
  orphanIssues: 1,
  zombieIssues: 1,
  unlinkedPRs: 1,
  elapsedMs: 99,
};

function buildProgram(): Command {
  const program = new Command();
  program.option("-c, --config <path>", "Config path");
  registerAuditCommand(program);
  return program;
}

beforeEach(() => {
  mockAuditAll.mockReset();
  mockExit.mockClear();
  consoleSpy.mockClear();
});

describe("registerAuditCommand", () => {
  it("registers the 'audit' command on the program", () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("audit");
  });

  it("calls auditAll with default minAgeDays=7 when --min-age is not provided", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(program.parseAsync(["node", "orch", "audit"])).rejects.toThrow("process.exit(0)");

    expect(mockAuditAll).toHaveBeenCalledWith(
      expect.objectContaining({ "agent-a": expect.anything() }),
      { minAgeDays: 7 },
    );
  });

  it("passes custom --min-age to auditAll", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--min-age", "14"]),
    ).rejects.toThrow("process.exit(0)");

    expect(mockAuditAll).toHaveBeenCalledWith(expect.anything(), { minAgeDays: 14 });
  });

  it("exits 0 when no gaps are found", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(program.parseAsync(["node", "orch", "audit"])).rejects.toThrow("process.exit(0)");

    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it("exits 1 when gaps are found", async () => {
    mockAuditAll.mockReturnValue(GAPS_RESULT);

    const program = buildProgram();
    await expect(program.parseAsync(["node", "orch", "audit"])).rejects.toThrow("process.exit(1)");

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("outputs JSON and exits 0 when --json flag is used and no gaps", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--json"]),
    ).rejects.toThrow("process.exit(0)");

    const jsonCall = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return typeof parsed === "object" && "totalGaps" in parsed;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.totalGaps).toBe(0);
  });

  it("outputs JSON and exits 1 when --json flag is used and gaps exist", async () => {
    mockAuditAll.mockReturnValue(GAPS_RESULT);

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--json"]),
    ).rejects.toThrow("process.exit(1)");

    const jsonCall = consoleSpy.mock.calls.find((args) => {
      try {
        const parsed = JSON.parse(args[0] as string);
        return typeof parsed === "object" && "totalGaps" in parsed;
      } catch {
        return false;
      }
    });
    expect(jsonCall).toBeDefined();
    const parsed = JSON.parse(jsonCall![0] as string);
    expect(parsed.totalGaps).toBe(3);
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("filters to a single agent when --agent is provided", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--agent", "agent-a"]),
    ).rejects.toThrow("process.exit(0)");

    const [passedAgents] = mockAuditAll.mock.calls[0] as Parameters<typeof mockAuditAll>;
    expect(Object.keys(passedAgents as object)).toEqual(["agent-a"]);
  });

  it("filters to a single repo when --repo is provided", async () => {
    mockAuditAll.mockReturnValue(CLEAN_RESULT);

    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--repo", "owner/agent-b"]),
    ).rejects.toThrow("process.exit(0)");

    const [passedAgents] = mockAuditAll.mock.calls[0] as Parameters<typeof mockAuditAll>;
    expect(Object.keys(passedAgents as object)).toEqual(["agent-b"]);
  });

  it("exits 2 when --agent references an unknown agent", async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--agent", "does-not-exist"]),
    ).rejects.toThrow("process.exit(2)");

    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it("exits 2 when --repo references a repo not linked to any agent", async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(["node", "orch", "audit", "--repo", "owner/no-such-repo"]),
    ).rejects.toThrow("process.exit(2)");

    expect(mockExit).toHaveBeenCalledWith(2);
  });
});
