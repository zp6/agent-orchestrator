import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateEngagementProposal,
  getRepoEngagementSummary,
  getActiveExternalProjects,
  isExternalRepo,
  buildTransparencySignature,
  MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER,
  MAX_CONCURRENT_EXTERNAL_PROJECTS,
  type EngagementProposal,
} from "./oss-engagement-validator.js";

// ── Minimal StateStore mock ──────────────────────────────────────────────────

function createMockStore(records: Array<{
  id: number;
  repo: string;
  engagement_type: string;
  reference: string;
  agent: string;
  notes: string | null;
  created_at: string;
}> = []) {
  return {
    getOSSEngagementRecords: vi.fn((repo: string) =>
      records.filter((r) => r.repo === repo),
    ),
    getRecentOSSEngagementRecords: vi.fn((since: string) =>
      records.filter((r) => r.created_at >= since),
    ),
    writeSignal: vi.fn(),
    addOSSEngagementRecord: vi.fn(),
  } as any;
}

function makeRecord(overrides: Partial<{
  id: number;
  repo: string;
  engagement_type: string;
  reference: string;
  agent: string;
  notes: string | null;
  created_at: string;
}> = {}) {
  return {
    id: 1,
    repo: "external/repo",
    engagement_type: "bug_report",
    reference: "https://github.com/external/repo/issues/1",
    agent: "claude-agent-a",
    notes: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("isExternalRepo", () => {
  const fleetRepos = ["rapartlu/agent-orchestrator", "rapartlu/dashboard"];

  it("returns true for repos not in fleet", () => {
    expect(isExternalRepo(fleetRepos, "facebook/react")).toBe(true);
  });

  it("returns false for fleet-owned repos", () => {
    expect(isExternalRepo(fleetRepos, "rapartlu/agent-orchestrator")).toBe(false);
  });
});

describe("getRepoEngagementSummary", () => {
  it("returns empty summary for repo with no records", () => {
    const store = createMockStore([]);
    const summary = getRepoEngagementSummary(store, "external/repo");

    expect(summary.repo).toBe("external/repo");
    expect(summary.totalContributions).toBe(0);
    expect(summary.prsThisQuarter).toBe(0);
    expect(summary.bugReportsThisQuarter).toBe(0);
    expect(summary.acceptances).toBe(0);
    expect(summary.rejections).toBe(0);
    expect(summary.lastEngagement).toBeNull();
    expect(summary.hasMaintainerInvitation).toBe(false);
  });

  it("calculates summary from records", () => {
    const now = new Date().toISOString();
    const store = createMockStore([
      makeRecord({ id: 1, engagement_type: "bug_report", created_at: now }),
      makeRecord({ id: 2, engagement_type: "pr_submitted", created_at: now }),
      makeRecord({ id: 3, engagement_type: "pr_accepted", created_at: now }),
      makeRecord({ id: 4, engagement_type: "maintainer_invitation", created_at: now }),
    ]);

    const summary = getRepoEngagementSummary(store, "external/repo");

    expect(summary.totalContributions).toBe(4);
    expect(summary.prsThisQuarter).toBe(1);
    expect(summary.bugReportsThisQuarter).toBe(1);
    expect(summary.acceptances).toBe(1);
    expect(summary.hasMaintainerInvitation).toBe(true);
  });
});

describe("validateEngagementProposal", () => {
  const baseProposal: EngagementProposal = {
    targetRepo: "external/repo",
    engagementType: "bug_report",
    agent: "claude-agent-a",
    rationale: "Found a bug worth reporting",
  };

  it("allows bug reports on new repos", () => {
    const store = createMockStore([]);
    const result = validateEngagementProposal(store, baseProposal);

    expect(result.allowed).toBe(true);
    expect(result.constraintViolated).toBeNull();
  });

  it("blocks PR on repo with no prior engagement (bug reports before patches)", () => {
    const store = createMockStore([]);
    const proposal: EngagementProposal = {
      ...baseProposal,
      engagementType: "pr_submitted",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(false);
    expect(result.constraintViolated).toBe("bug_reports_before_patches");
  });

  it("allows PR after prior bug report engagement", () => {
    const now = new Date().toISOString();
    const store = createMockStore([
      makeRecord({ id: 1, engagement_type: "bug_report", created_at: now }),
    ]);

    const proposal: EngagementProposal = {
      ...baseProposal,
      engagementType: "pr_submitted",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(true);
  });

  it("allows PR when maintainer invitation exists", () => {
    const now = new Date().toISOString();
    const store = createMockStore([
      makeRecord({ id: 1, engagement_type: "maintainer_invitation", created_at: now }),
    ]);

    const proposal: EngagementProposal = {
      ...baseProposal,
      engagementType: "pr_submitted",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(true);
  });

  it("blocks PR when quarterly ceiling is reached", () => {
    const now = new Date().toISOString();
    const records = [
      makeRecord({ id: 1, engagement_type: "bug_report", created_at: now }),
      ...Array.from({ length: MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER }, (_, i) =>
        makeRecord({ id: i + 2, engagement_type: "pr_submitted", created_at: now }),
      ),
    ];
    const store = createMockStore(records);

    const proposal: EngagementProposal = {
      ...baseProposal,
      engagementType: "pr_submitted",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(false);
    expect(result.constraintViolated).toBe("no_unsolicited_pr_floods");
  });

  it("blocks new project when max concurrent projects reached without standing", () => {
    const now = new Date().toISOString();
    // Active engagement on another repo
    const store = createMockStore([
      makeRecord({ id: 1, repo: "other/project", engagement_type: "bug_report", created_at: now }),
    ]);

    // Trying to engage a new repo
    const proposal: EngagementProposal = {
      targetRepo: "new/project",
      engagementType: "bug_report",
      agent: "claude-agent-a",
      rationale: "Expanding engagement",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(false);
    expect(result.constraintViolated).toBe("earn_standing_one_at_a_time");
  });

  it("allows new project when existing project has earned standing", () => {
    const now = new Date().toISOString();
    // Active engagement with acceptance on existing project
    const store = createMockStore([
      makeRecord({ id: 1, repo: "other/project", engagement_type: "bug_report", created_at: now }),
      makeRecord({ id: 2, repo: "other/project", engagement_type: "pr_accepted", created_at: now }),
    ]);

    const proposal: EngagementProposal = {
      targetRepo: "new/project",
      engagementType: "bug_report",
      agent: "claude-agent-a",
      rationale: "Expanding engagement after earning standing",
    };

    const result = validateEngagementProposal(store, proposal);

    expect(result.allowed).toBe(true);
  });
});

describe("buildTransparencySignature", () => {
  it("includes agent name and fleet identity", () => {
    const sig = buildTransparencySignature("claude-agent-a");

    expect(sig).toContain("claude-agent-a");
    expect(sig).toContain("autonomous AI agent");
    expect(sig).toContain("Claude Agent Orchestrator");
    expect(sig).toContain("rapartlu/agent-orchestrator");
  });
});

describe("getActiveExternalProjects", () => {
  it("returns unique repos from recent records", () => {
    const now = new Date().toISOString();
    const store = createMockStore([
      makeRecord({ id: 1, repo: "ext/a", created_at: now }),
      makeRecord({ id: 2, repo: "ext/b", created_at: now }),
      makeRecord({ id: 3, repo: "ext/a", created_at: now }),
    ]);

    const projects = getActiveExternalProjects(store);

    expect(projects).toContain("ext/a");
    expect(projects).toContain("ext/b");
    expect(projects).toHaveLength(2);
  });
});
