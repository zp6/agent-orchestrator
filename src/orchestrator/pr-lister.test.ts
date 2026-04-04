import { describe, it, expect, vi, beforeEach } from "vitest";
import { PRLister, toPRRow, extractLinkedIssue, formatAge } from "./pr-lister.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { PRListItem } from "./pr-lister.js";

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
  mergeable: "MERGEABLE",
  reviewDecision: null,
  headRefName: "fix-something",
  body: "Closes #42",
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

describe("toPRRow", () => {
  const now = new Date("2024-01-10T12:00:00Z");

  it("maps MERGEABLE → 'yes'", () => {
    const item = makePR({ mergeable: "MERGEABLE", createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("yes");
  });

  it("maps CONFLICTING → 'conflict'", () => {
    const item = makePR({ mergeable: "CONFLICTING", createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("conflict");
  });

  it("maps UNKNOWN → 'unknown'", () => {
    const item = makePR({ mergeable: "UNKNOWN", createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.mergeable).toBe("unknown");
  });

  it("maps APPROVED review decision", () => {
    const item = makePR({ reviewDecision: "APPROVED", createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("approved");
  });

  it("maps CHANGES_REQUESTED review decision", () => {
    const item = makePR({ reviewDecision: "CHANGES_REQUESTED", createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("changes-requested");
  });

  it("maps null/empty review decision → 'pending'", () => {
    const item = makePR({ reviewDecision: null, createdAt: "2024-01-08T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.reviewStatus).toBe("pending");
  });

  it("computes age correctly", () => {
    const item = makePR({ createdAt: "2024-01-07T12:00:00Z" }); // 3 days before now
    const row = toPRRow(item, "owner/repo", now);
    expect(row.ageDays).toBe(3);
  });

  it("extracts linked issue from body", () => {
    const item = makePR({ body: "This PR closes #99", createdAt: "2024-01-09T12:00:00Z" });
    const row = toPRRow(item, "owner/repo", now);
    expect(row.linkedIssue).toBe("#99");
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

  it("filters stale PRs (≥3 days) with --stale flag", () => {
    const old = makePR({ number: 1, title: "Old PR", createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() });
    const fresh = makePR({ number: 2, title: "Fresh PR", createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() });

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
    const clean = makePR({ number: 1, mergeable: "MERGEABLE", createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() });
    const conflicting = makePR({ number: 2, mergeable: "CONFLICTING", createdAt: new Date(Date.now() - 0).toISOString() });

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

  it("limits to a specific repo when --repo is provided", () => {
    mockExecFileSync.mockReturnValue("[]");

    const lister = new PRLister(config);
    lister.listAll({ repo: "custom/repo" });

    expect(mockExecFileSync.mock.calls).toHaveLength(1);
    const args = mockExecFileSync.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--repo") + 1]).toBe("custom/repo");
  });

  it("returns empty rows when gh CLI fails", () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const lister = new PRLister(config);
    const { rows } = lister.listAll();

    expect(rows).toHaveLength(0);
  });
});
