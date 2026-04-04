import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PRLister,
  toPRRow,
  extractLinkedIssue,
  formatAge,
  formatStaleDays,
  rollupCIStatus,
  computeMergeReady,
} from "./pr-lister.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { PRListItem, PRRow, StatusCheck } from "./pr-lister.js";

const mockExecFileSync = vi.fn();

vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "agent-a": {
      dir: "agent-a",
      description: "Agent A",
      capabilities: ["typescript"],
      owns_topics: ["frontend"],
      github: "owner/repo-a",
    },
    "agent-b": {
      dir: "agent-b",
      description: "Agent B",
      capabilities: ["python"],
      owns_topics: ["backend"],
      github: "owner/repo-b",
    },
    "agent-no-github": {
      dir: "agent-c",
      description: "Agent C (no github)",
      capabilities: [],
      owns_topics: [],
    },
  },
};

const makePR = (overrides: Partial<PRListItem> = {}): PRListItem => ({
  number: 1,
  title: "Fix something",
  createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
  updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
  mergeable: "MERGEABLE",
  reviewDecision: null,
  headRefName: "fix-something",
  body: "Closes #42",
  statusCheckRollup: null,
  reviewRequests: null,
  ...overrides,
});

describe("extractLinkedIssue", () => {
  it("extracts 'Closes #N'", () => {
    expect(extractLinkedIssue("Closes #42")).toBe("#42");
  });

  it("extracts 'Fixes #N' case-insensitive", () => {
    expect(extractLinkedIssue("fixes #7")).toBe("#7");
  });

  it("extracts 'Resolves #N'", () => {
    expect(extractLinkedIssue("Resolves #100")).toBe("#100");
  });

  it("returns em-dash when no issue reference", () => {
    expect(extractLinkedIssue("No issue here")).toBe("—");
  });

  it("returns em-dash for empty body", () => {
    expect(extractLinkedIssue("")).toBe("—");
  });
});

describe("formatAge", () => {
  it("formats < 1 day", () => {
    expect(formatAge(0)).toBe("< 1d");
  });

  it("formats exactly 1 day", () => {
    expect(formatAge(1)).toBe("1d");
  });

  it("formats multiple days", () => {
    expect(formatAge(7)).toBe("7d");
  });
});

describe("formatStaleDays", () => {
  it("formats < 1 day", () => {
    expect(formatStaleDays(0)).toBe("< 1d");
  });

  it("formats exactly 1 day", () => {
    expect(formatStaleDays(1)).toBe("1d");
  });

  it("formats moderate staleness", () => {
    expect(formatStaleDays(5)).toBe("5d");
  });

  it("prefixes > for staleness beyond 7 days", () => {
    expect(formatStaleDays(10)).toBe(">10d");
  });

  it("prefixes > for exactly 8 days", () => {
    expect(formatStaleDays(8)).toBe(">8d");
  });

  it("does not prefix > for exactly 7 days", () => {
    expect(formatStaleDays(7)).toBe("7d");
  });
});

describe("rollupCIStatus", () => {
  const check = (status: string, conclusion: string | null): StatusCheck => ({
    name: "test",
    status,
    conclusion,
  });

  it("returns 'none' for null checks", () => {
    expect(rollupCIStatus(null)).toBe("none");
  });

  it("returns 'none' for empty array", () => {
    expect(rollupCIStatus([])).toBe("none");
  });

  it("returns 'failing' when any check has FAILURE conclusion", () => {
    expect(rollupCIStatus([check("COMPLETED", "FAILURE")])).toBe("failing");
  });

  it("returns 'failing' when any check has TIMED_OUT conclusion", () => {
    expect(rollupCIStatus([check("COMPLETED", "TIMED_OUT"), check("COMPLETED", "SUCCESS")])).toBe("failing");
  });

  it("returns 'failing' when any check has ACTION_REQUIRED conclusion", () => {
    expect(rollupCIStatus([check("COMPLETED", "ACTION_REQUIRED")])).toBe("failing");
  });

  it("returns 'pending' when any check is in progress with no conclusion", () => {
    expect(rollupCIStatus([check("IN_PROGRESS", null)])).toBe("pending");
  });

  it("returns 'pending' when any check is queued", () => {
    expect(rollupCIStatus([check("QUEUED", null), check("COMPLETED", "SUCCESS")])).toBe("pending");
  });

  it("returns 'passing' when all checks succeeded", () => {
    expect(
      rollupCIStatus([check("COMPLETED", "SUCCESS"), check("COMPLETED", "SKIPPED")]),
    ).toBe("passing");
  });

  it("'failing' takes priority over 'pending'", () => {
    expect(
      rollupCIStatus([check("IN_PROGRESS", null), check("COMPLETED", "FAILURE")]),
    ).toBe("failing");
  });
});

describe("toPRRow", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("maps MERGEABLE → 'yes'", () => {
    const item = makePR({ mergeable: "MERGEABLE", createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("yes");
  });

  it("maps CONFLICTING → 'conflict'", () => {
    const item = makePR({ mergeable: "CONFLICTING", createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("conflict");
  });

  it("maps UNKNOWN → 'unknown'", () => {
    const item = makePR({ mergeable: "UNKNOWN", createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("unknown");
  });

  it("maps APPROVED review decision", () => {
    const item = makePR({ reviewDecision: "APPROVED", createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("approved");
  });

  it("maps CHANGES_REQUESTED review decision", () => {
    const item = makePR({ reviewDecision: "CHANGES_REQUESTED", createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("changes-requested");
  });

  it("maps null/empty review decision → 'pending'", () => {
    const item = makePR({ reviewDecision: null, createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("pending");
  });

  it("computes ageDays from createdAt correctly", () => {
    const item = makePR({ createdAt: "2024-01-07T12:00:00Z", updatedAt: "2024-01-09T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ageDays).toBe(3);
  });

  it("computes staleDays from updatedAt correctly", () => {
    const item = makePR({ createdAt: "2024-01-01T12:00:00Z", updatedAt: "2024-01-09T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.staleDays).toBe(1);
  });

  it("staleDays is 0 when updatedAt is today", () => {
    const item = makePR({ createdAt: "2024-01-01T12:00:00Z", updatedAt: "2024-01-10T06:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.staleDays).toBe(0);
  });

  it("staleDays matches ageDays when updatedAt equals createdAt", () => {
    const item = makePR({ createdAt: "2024-01-07T12:00:00Z", updatedAt: "2024-01-07T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ageDays).toBe(3);
    expect(row.staleDays).toBe(3);
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    const item = makePR({ createdAt: "2024-01-08T12:00:00Z" });
    // @ts-expect-error — intentionally omitting updatedAt to test fallback
    delete item.updatedAt;
    const row = toPRRow(item, "owner/repo", now);
    expect(row.staleDays).toBe(2);
  });

  it("extracts linked issue from body", () => {
    const item = makePR({ body: "This PR closes #99", createdAt: "2024-01-09T12:00:00Z", updatedAt: "2024-01-09T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.linkedIssue).toBe("#99");
  });

  it("maps passing CI checks to ciStatus 'passing'", () => {
    const item = makePR({
      createdAt: "2024-01-09T12:00:00Z",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ciStatus).toBe("passing");
  });

  it("maps failing CI check to ciStatus 'failing'", () => {
    const item = makePR({
      createdAt: "2024-01-09T12:00:00Z",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ciStatus).toBe("failing");
  });

  it("maps null statusCheckRollup to ciStatus 'none'", () => {
    const item = makePR({ createdAt: "2024-01-09T12:00:00Z", statusCheckRollup: null });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ciStatus).toBe("none");
  });
});

describe("PRLister", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("fetches PRs from all repos with github configured", () => {
    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repoIdx = args.indexOf("--repo") + 1;
      const repo = args[repoIdx] ?? "";
      if (repo.includes("repo-a")) {
        return JSON.stringify([makePR({ number: 1, title: "PR in repo-a" })]);
      }
      if (repo.includes("repo-b")) {
        return JSON.stringify([makePR({ number: 2, title: "PR in repo-b" })]);
      }
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.repo)).toContain("owner/repo-a");
    expect(rows.map((r) => r.repo)).toContain("owner/repo-b");
  });

  it("fetches updatedAt field from gh pr list", () => {
    mockExecFileSync.mockReturnValue("[]");
    const lister = new PRLister(config);
    lister.listAll({ repo: "owner/repo-a" });

    const args = mockExecFileSync.mock.calls[0][1] as string[];
    const jsonFields = args[args.indexOf("--json") + 1] ?? "";
    expect(jsonFields).toContain("updatedAt");
  });

  it("skips agents without github field", () => {
    mockExecFileSync.mockReturnValue("[]");
    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    // Only repo-a and repo-b should be queried, not agent-no-github
    const getRepo = (c: unknown[]) => {
      const args = c[1] as string[];
      return args[args.indexOf("--repo") + 1] ?? "";
    };
    const calledRepos = mockExecFileSync.mock.calls.map(getRepo);
    expect(calledRepos.some((r) => r.includes("repo-a"))).toBe(true);
    expect(calledRepos.some((r) => r.includes("repo-b"))).toBe(true);
    expect(calledRepos.some((r) => r.includes("agent-no-github"))).toBe(false);
    expect(rows).toHaveLength(0);
  });

  it("deduplicates repos when multiple agents share the same github repo", () => {
    const sharedConfig: OrchestratorConfig = {
      ...config,
      agents: {
        "agent-1": { ...config.agents["agent-a"]!, github: "owner/shared-repo" },
        "agent-2": { ...config.agents["agent-b"]!, github: "owner/shared-repo" },
      },
    };

    mockExecFileSync.mockReturnValue(JSON.stringify([makePR({ number: 5 })]));

    const lister = new PRLister(sharedConfig);
    lister.listAll();

    // Should only call gh pr list once for shared-repo
    const calls = mockExecFileSync.mock.calls.filter((c) => {
      const args = c[1] as string[];
      return (args[args.indexOf("--repo") + 1] ?? "").includes("owner/shared-repo");
    });
    expect(calls).toHaveLength(1);
  });

  it("filters stale PRs (staleDays ≥3) with --stale flag", () => {
    const now = Date.now();
    // old push: 5 days ago
    const old = makePR({
      number: 1,
      title: "Old PR",
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // fresh push: 1 day ago
    const fresh = makePR({
      number: 2,
      title: "Fresh PR",
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([old, fresh]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ stale: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
  });

  it("filters by --stale-days N (staleDays ≥N)", () => {
    const now = Date.now();
    const veryOld = makePR({
      number: 1,
      title: "Very old PR",
      createdAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const moderatelyOld = makePR({
      number: 2,
      title: "Moderately old PR",
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const fresh = makePR({
      number: 3,
      title: "Fresh PR",
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([veryOld, moderatelyOld, fresh]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ staleDays: 7 });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
  });

  it("filters conflict PRs with --conflicts flag", () => {
    const conflicting = makePR({ number: 3, title: "Conflict PR", mergeable: "CONFLICTING" });
    const clean = makePR({ number: 4, title: "Clean PR", mergeable: "MERGEABLE" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([conflicting, clean]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ conflicts: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].mergeable).toBe("conflict");
  });

  it("filters conflict PRs with --conflict flag (singular alias)", () => {
    const conflicting = makePR({ number: 5, title: "Conflict PR", mergeable: "CONFLICTING" });
    const clean = makePR({ number: 6, title: "Clean PR", mergeable: "MERGEABLE" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([conflicting, clean]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ conflict: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].mergeable).toBe("conflict");
  });

  it("reports hasConflicts=true when any PR has conflicts (even when --conflicts not set)", () => {
    const conflicting = makePR({ number: 3, mergeable: "CONFLICTING" });
    const clean = makePR({ number: 4, mergeable: "MERGEABLE" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([conflicting, clean]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { hasConflicts } = lister.listAll();

    expect(hasConflicts).toBe(true);
  });

  it("reports hasConflicts=false when no PR has conflicts", () => {
    const clean = makePR({ number: 1, mergeable: "MERGEABLE" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([clean]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { hasConflicts } = lister.listAll();

    expect(hasConflicts).toBe(false);
  });

  it("sorts conflicts before non-conflicts", () => {
    const now = Date.now();
    const clean = makePR({
      number: 1,
      mergeable: "MERGEABLE",
      createdAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const conflicting = makePR({
      number: 2,
      mergeable: "CONFLICTING",
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([clean, conflicting]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    expect(rows[0].mergeable).toBe("conflict");
    expect(rows[1].mergeable).toBe("yes");
  });

  it("sorts by staleDays descending within same conflict bucket", () => {
    const now = Date.now();
    const fresh = makePR({
      number: 1,
      mergeable: "MERGEABLE",
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const stale = makePR({
      number: 2,
      mergeable: "MERGEABLE",
      createdAt: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([fresh, stale]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    // stale (8d since push) should come before fresh (1d since push)
    expect(rows[0].number).toBe(2);
    expect(rows[1].number).toBe(1);
  });

  it("limits to a specific repo when --repo is provided", () => {
    mockExecFileSync.mockReturnValue("[]");

    const lister = new PRLister(config);
    lister.listAll({ repo: "custom/repo" });

    expect(mockExecFileSync.mock.calls).toHaveLength(1);
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--repo") + 1]).toBe("custom/repo");
  });

  it("filters CI-failed PRs with --ci-failed flag", () => {
    const failing = makePR({
      number: 5,
      title: "Failing CI",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "FAILURE" }],
    });
    const passing = makePR({
      number: 6,
      title: "Passing CI",
      statusCheckRollup: [{ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }],
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([failing, passing]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ ciFailed: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(5);
    expect(rows[0].ciStatus).toBe("failing");
  });

  it("returns empty rows when gh CLI fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    expect(rows).toHaveLength(0);
  });

  it("populates agent name from config when repo matches", () => {
    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo === "owner/repo-a") return JSON.stringify([makePR({ number: 1 })]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ repo: "owner/repo-a" });

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("agent-a");
  });

  it("uses empty string for agent when repo is not in config", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([makePR({ number: 1 })]));

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ repo: "unknown/repo" });

    expect(rows).toHaveLength(1);
    expect(rows[0].agent).toBe("");
  });

  it("filters by --agent option using config-derived repo", () => {
    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo === "owner/repo-a") return JSON.stringify([makePR({ number: 1, title: "Agent A PR" })]);
      if (repo === "owner/repo-b") return JSON.stringify([makePR({ number: 2, title: "Agent B PR" })]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ agent: "agent-a" });

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Agent A PR");
    expect(rows[0].agent).toBe("agent-a");
  });

  it("returns empty rows when --agent has no github configured", () => {
    mockExecFileSync.mockReturnValue(JSON.stringify([makePR()]));

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ agent: "agent-no-github" });

    expect(rows).toHaveLength(0);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });
});

// Helper to build a partial PRRow for computeMergeReady tests
const makePartialRow = (
  overrides: Partial<Omit<PRRow, "mergeReady" | "agent">> = {},
): Omit<PRRow, "mergeReady" | "agent"> => ({
  repo: "owner/repo",
  number: 1,
  title: "Test PR",
  ageDays: 1,
  staleDays: 1,
  reviewStatus: "approved",
  mergeable: "yes",
  ciStatus: "passing",
  linkedIssue: "#1",
  escalated: false,
  ...overrides,
});

describe("computeMergeReady", () => {
  it("returns 'ready' when all signals are green", () => {
    expect(computeMergeReady(makePartialRow())).toBe("ready");
  });

  it("returns 'ready' when CI is 'none' (no checks configured)", () => {
    expect(computeMergeReady(makePartialRow({ ciStatus: "none" }))).toBe("ready");
  });

  it("returns 'conflict' for conflicting PRs (highest priority)", () => {
    expect(
      computeMergeReady(
        makePartialRow({ mergeable: "conflict", ciStatus: "failing", reviewStatus: "pending" }),
      ),
    ).toBe("conflict");
  });

  it("returns 'ci-failing' when CI fails but no conflict", () => {
    expect(
      computeMergeReady(makePartialRow({ ciStatus: "failing", reviewStatus: "pending" })),
    ).toBe("ci-failing");
  });

  it("returns 'changes-requested' when review requested changes (no conflict/ci-fail)", () => {
    expect(
      computeMergeReady(makePartialRow({ reviewStatus: "changes-requested" })),
    ).toBe("changes-requested");
  });

  it("returns 'needs-review' when review is pending (no conflict/ci-fail)", () => {
    expect(computeMergeReady(makePartialRow({ reviewStatus: "pending" }))).toBe("needs-review");
  });

  it("returns 'stale' when staleDays ≥7 and all other signals green", () => {
    expect(
      computeMergeReady(makePartialRow({ staleDays: 7 })),
    ).toBe("stale");
  });

  it("returns 'ready' when staleDays is 6 (below stale threshold)", () => {
    expect(computeMergeReady(makePartialRow({ staleDays: 6 }))).toBe("ready");
  });

  it("conflict takes priority over stale", () => {
    expect(
      computeMergeReady(makePartialRow({ mergeable: "conflict", staleDays: 10 })),
    ).toBe("conflict");
  });

  it("ci-failing takes priority over needs-review", () => {
    expect(
      computeMergeReady(makePartialRow({ ciStatus: "failing", reviewStatus: "pending" })),
    ).toBe("ci-failing");
  });

  it("changes-requested takes priority over stale", () => {
    expect(
      computeMergeReady(makePartialRow({ reviewStatus: "changes-requested", staleDays: 10 })),
    ).toBe("changes-requested");
  });
});

describe("toPRRow — agent field", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("sets agent to provided agentName", () => {
    const item = makePR({ createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now, "cheese-hater");
    expect(row.agent).toBe("cheese-hater");
  });

  it("defaults agent to empty string when not provided", () => {
    const item = makePR({ createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.agent).toBe("");
  });

  it("includes mergeReady in the returned row", () => {
    const item = makePR({
      createdAt: "2024-01-08T12:00:00Z",
      updatedAt: "2024-01-08T12:00:00Z",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeReady).toBe("ready");
  });

  it("mergeReady reflects conflict when PR is conflicting", () => {
    const item = makePR({
      createdAt: "2024-01-08T12:00:00Z",
      updatedAt: "2024-01-08T12:00:00Z",
      mergeable: "CONFLICTING",
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeReady).toBe("conflict");
  });
});

describe("toPRRow — escalated field", () => {
  const now = new Date("2024-01-10T12:00:00Z");
  const base = { createdAt: "2024-01-08T12:00:00Z", updatedAt: "2024-01-08T12:00:00Z" };

  it("sets escalated=true when rapartlu is a requested reviewer", () => {
    const item = makePR({
      ...base,
      reviewRequests: [{ login: "rapartlu" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.escalated).toBe(true);
  });

  it("sets escalated=false when reviewRequests is null", () => {
    const item = makePR({ ...base, reviewRequests: null });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.escalated).toBe(false);
  });

  it("sets escalated=false when reviewRequests is empty", () => {
    const item = makePR({ ...base, reviewRequests: [] });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.escalated).toBe(false);
  });

  it("sets escalated=false when rapartlu is not in reviewRequests", () => {
    const item = makePR({
      ...base,
      reviewRequests: [{ login: "someoneelse" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.escalated).toBe(false);
  });

  it("sets escalated=true when rapartlu is among multiple reviewers", () => {
    const item = makePR({
      ...base,
      reviewRequests: [{ login: "alice" }, { login: "rapartlu" }, { login: "bob" }],
    });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.escalated).toBe(true);
  });
});

describe("PRLister — --needs-action filter", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("filters to changes-requested PRs", () => {
    const changesReq = makePR({ number: 1, title: "Needs fixes", reviewDecision: "CHANGES_REQUESTED" });
    const approved = makePR({ number: 2, title: "Approved PR", reviewDecision: "APPROVED" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([changesReq, approved]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
    expect(rows[0].reviewStatus).toBe("changes-requested");
  });

  it("filters to conflicting PRs", () => {
    const conflicting = makePR({ number: 1, title: "Has conflict", mergeable: "CONFLICTING" });
    const clean = makePR({ number: 2, title: "Clean PR", mergeable: "MERGEABLE" });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([conflicting, clean]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
    expect(rows[0].mergeable).toBe("conflict");
  });

  it("filters to escalated PRs (rapartlu as requested reviewer)", () => {
    const escalated = makePR({
      number: 1,
      title: "Escalated to human",
      reviewRequests: [{ login: "rapartlu" }],
    });
    const normal = makePR({ number: 2, title: "Normal PR", reviewRequests: null });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([escalated, normal]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe(1);
    expect(rows[0].escalated).toBe(true);
  });

  it("returns empty when no PRs require action", () => {
    const ready = makePR({
      number: 1,
      title: "Ready PR",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
      reviewRequests: null,
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([ready]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows).toHaveLength(0);
  });

  it("returns all three action types when present", () => {
    const changesReq = makePR({ number: 1, title: "Needs fixes", reviewDecision: "CHANGES_REQUESTED", reviewRequests: null });
    const conflicting = makePR({ number: 2, title: "Has conflict", mergeable: "CONFLICTING", reviewRequests: null });
    const escalated = makePR({ number: 3, title: "Escalated", reviewRequests: [{ login: "rapartlu" }] });
    const ready = makePR({ number: 4, title: "Ready", reviewDecision: "APPROVED", reviewRequests: null });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([changesReq, conflicting, escalated, ready]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows).toHaveLength(3);
    const numbers = rows.map((r) => r.number);
    expect(numbers).toContain(1);
    expect(numbers).toContain(2);
    expect(numbers).toContain(3);
    expect(numbers).not.toContain(4);
  });

  it("sorts: conflicts first, then escalated, then changes-requested", () => {
    const now = Date.now();
    const changesReq = makePR({
      number: 1,
      title: "Changes req",
      reviewDecision: "CHANGES_REQUESTED",
      reviewRequests: null,
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const conflicting = makePR({
      number: 2,
      title: "Conflict",
      mergeable: "CONFLICTING",
      reviewRequests: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    });
    const escalated = makePR({
      number: 3,
      title: "Escalated",
      reviewRequests: [{ login: "rapartlu" }],
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });

    mockExecFileSync.mockImplementation((_prog: string, args: string[]) => {
      const repo = args[args.indexOf("--repo") + 1] ?? "";
      if (repo.includes("repo-a")) return JSON.stringify([changesReq, escalated, conflicting]);
      return "[]";
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll({ needsAction: true });

    expect(rows[0].number).toBe(2); // conflict first
    expect(rows[1].number).toBe(3); // then escalated
    expect(rows[2].number).toBe(1); // then changes-requested
  });
});

describe("PRLister — reviewRequests fetched from gh CLI", () => {
  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  it("includes reviewRequests in the gh pr list --json fields", () => {
    mockExecFileSync.mockReturnValue("[]");
    const lister = new PRLister(config);
    lister.listAll({ repo: "owner/repo-a" });

    const args = mockExecFileSync.mock.calls[0][1] as string[];
    const jsonFields = args[args.indexOf("--json") + 1] ?? "";
    expect(jsonFields).toContain("reviewRequests");
  });
});
