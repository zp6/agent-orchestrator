/**
 * Tests for the Low-Score Approved Feed module (issue #278).
 *
 * Covers:
 *  1. getLowScoreApprovedFeed — basic threshold filtering
 *  2. Correct ordering: lowest score first
 *  3. Per-agent summary: count, avg_score, min_score
 *  4. auto_approved_marginal vs below_floor_approved counts
 *  5. Dimension breakdown parsed from verification_notes
 *  6. PR URL extraction from source_ref
 *  7. Custom threshold and limit overrides
 *  8. Empty store edge case
 *  9. formatLowScoreFeedForTelegram — output sections
 * 10. Tasks at exactly the threshold are excluded (strict <)
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";
import {
  getLowScoreApprovedFeed,
  formatLowScoreFeedForTelegram,
  LOW_SCORE_FEED_THRESHOLD,
  LOW_SCORE_FEED_DEFAULT_LIMIT,
} from "../reviewer/low-score-feed.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-lsf-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    verification_notes?: string | null;
    source_ref?: string | null;
    updated_at?: string;
    status?: string;
    task_type?: string;
  }) => {
    seq += 1;
    const id = `01TEST${String(seq).padStart(14, "0")}`;
    const now = overrides.updated_at ?? isoNow();
    writer
      .prepare(
        `INSERT INTO tasks
           (id, title, description, status, agent_name, task_type, source_ref,
            verification_status, quality_score, verification_notes,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${seq}`,
        null,
        overrides.status ?? "done",
        overrides.agent_name ?? "test-agent",
        overrides.task_type ?? "implementation",
        overrides.source_ref ?? null,
        overrides.verification_status ?? "approved",
        overrides.quality_score ?? null,
        overrides.verification_notes ?? null,
        now,
        now,
      );
    return id;
  };

  const cleanup = () => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { store, writer, insertTask, dir, cleanup };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("getLowScoreApprovedFeed", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it("returns empty feed when no approved tasks exist", () => {
    const feed = getLowScoreApprovedFeed(fixture.store);
    expect(feed.total).toBe(0);
    expect(feed.tasks).toHaveLength(0);
    expect(feed.per_agent).toHaveLength(0);
    expect(feed.auto_approved_marginal).toBe(0);
    expect(feed.below_floor_approved).toBe(0);
  });

  it("uses default threshold (0.75) when no options provided", () => {
    const feed = getLowScoreApprovedFeed(fixture.store);
    expect(feed.threshold).toBe(LOW_SCORE_FEED_THRESHOLD);
    expect(feed.threshold).toBe(0.75);
  });

  it("includes approved tasks below threshold", () => {
    fixture.insertTask({ quality_score: 0.62, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.70, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.total).toBe(2);
    expect(feed.tasks.map((t) => t.quality_score)).toEqual([0.62, 0.70]);
  });

  it("excludes tasks at exactly the threshold (strict <)", () => {
    fixture.insertTask({ quality_score: 0.75, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.74, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.total).toBe(1);
    expect(feed.tasks[0]!.quality_score).toBe(0.74);
  });

  it("excludes rejected tasks", () => {
    fixture.insertTask({ quality_score: 0.55, verification_status: "rejected" });
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.total).toBe(1);
    expect(feed.tasks[0]!.quality_score).toBe(0.65);
  });

  it("excludes tasks with null quality_score", () => {
    fixture.insertTask({ quality_score: null, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.total).toBe(1);
  });

  it("orders tasks by quality_score ascending (riskiest first)", () => {
    fixture.insertTask({ quality_score: 0.70, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.tasks.map((t) => t.quality_score)).toEqual([0.50, 0.65, 0.70]);
  });

  it("counts auto_approved_marginal (>= 0.60) and below_floor_approved (< 0.60) correctly", () => {
    fixture.insertTask({ quality_score: 0.48, verification_status: "approved" }); // below floor
    fixture.insertTask({ quality_score: 0.62, verification_status: "approved" }); // marginal
    fixture.insertTask({ quality_score: 0.70, verification_status: "approved" }); // marginal

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.below_floor_approved).toBe(1);
    expect(feed.auto_approved_marginal).toBe(2);
    expect(feed.total).toBe(3);
  });

  it("builds per_agent summary sorted by count descending", () => {
    fixture.insertTask({ quality_score: 0.62, agent_name: "agent-a" });
    fixture.insertTask({ quality_score: 0.65, agent_name: "agent-a" });
    fixture.insertTask({ quality_score: 0.70, agent_name: "agent-b" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.per_agent[0]!.agent_name).toBe("agent-a");
    expect(feed.per_agent[0]!.count).toBe(2);
    expect(feed.per_agent[1]!.agent_name).toBe("agent-b");
    expect(feed.per_agent[1]!.count).toBe(1);
  });

  it("computes avg_score and min_score in per_agent summary", () => {
    fixture.insertTask({ quality_score: 0.60, agent_name: "agent-a" });
    fixture.insertTask({ quality_score: 0.70, agent_name: "agent-a" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    const agentEntry = feed.per_agent.find((a) => a.agent_name === "agent-a");
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.avg_score).toBeCloseTo(0.65, 5);
    expect(agentEntry!.min_score).toBe(0.60);
  });

  it("respects custom threshold option", () => {
    fixture.insertTask({ quality_score: 0.55, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.72, verification_status: "approved" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.65 });
    expect(feed.threshold).toBe(0.65);
    expect(feed.total).toBe(1);
    expect(feed.tasks[0]!.quality_score).toBe(0.55);
  });

  it("respects custom limit option", () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.60 + i * 0.02, verification_status: "approved" });
    }

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75, limit: 3 });
    expect(feed.tasks).toHaveLength(3);
  });

  it("extracts PR url from source_ref in the form owner/repo/pull/N", () => {
    fixture.insertTask({
      quality_score: 0.65,
      source_ref: "owner/my-repo/pull/42",
    });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.tasks[0]!.pr_url).toBe("https://github.com/owner/my-repo/pull/42");
    expect(feed.tasks[0]!.source_ref).toBe("owner/my-repo/pull/42");
  });

  it("sets pr_url to null when source_ref is not a PR ref", () => {
    fixture.insertTask({ quality_score: 0.65, source_ref: "owner/repo#123" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.tasks[0]!.pr_url).toBeNull();
    expect(feed.tasks[0]!.source_ref).toBe("owner/repo#123");
  });

  it("parses dimension breakdown from verification_notes", () => {
    const notes = [
      "## Quality Dimensions Breakdown",
      "- **Correctness**: 70/100 ✓ (logic, no bugs)",
      "- **Completeness**: 60/100 ✗ (requirements met)",
      "- **Test Coverage**: 55/100 ✗ (edge cases covered)",
      "- **Code Quality**: 65/100 ✓ (clarity, documentation)",
    ].join("\n");

    fixture.insertTask({ quality_score: 0.62, verification_notes: notes });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    const dims = feed.tasks[0]!.dimensions;
    expect(dims).not.toBeNull();
    expect(dims!.correctness).toBeCloseTo(0.70, 5);
    expect(dims!.completeness).toBeCloseTo(0.60, 5);
    expect(dims!.test_coverage).toBeCloseTo(0.55, 5);
    expect(dims!.code_quality).toBeCloseTo(0.65, 5);
  });

  it("sets dimensions to null when verification_notes has no breakdown", () => {
    fixture.insertTask({
      quality_score: 0.62,
      verification_notes: "Task was incomplete.",
    });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.tasks[0]!.dimensions).toBeNull();
  });

  it("sets task_id_short to first 8 chars of task_id", () => {
    fixture.insertTask({ quality_score: 0.65 });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    const t = feed.tasks[0]!;
    expect(t.task_id_short).toBe(t.task_id.slice(0, 8));
    expect(t.task_id_short).toHaveLength(8);
  });

  it("includes task_type in each entry", () => {
    fixture.insertTask({ quality_score: 0.65, task_type: "research" });

    const feed = getLowScoreApprovedFeed(fixture.store, { threshold: 0.75 });
    expect(feed.tasks[0]!.task_type).toBe("research");
  });

  it("reports generated_at as recent ISO timestamp", () => {
    const before = Date.now();
    const feed = getLowScoreApprovedFeed(fixture.store);
    const after = Date.now();
    const generatedMs = new Date(feed.generated_at).getTime();
    expect(generatedMs).toBeGreaterThanOrEqual(before);
    expect(generatedMs).toBeLessThanOrEqual(after);
  });
});

// ── formatLowScoreFeedForTelegram ─────────────────────────────────────────────

describe("formatLowScoreFeedForTelegram", () => {
  it("returns empty feed message when no tasks", () => {
    const feed = getLowScoreApprovedFeed({ getLowScoreApprovedTasks: () => [] });
    const msg = formatLowScoreFeedForTelegram(feed);
    expect(msg).toContain("No approved tasks");
    expect(msg).toContain("75%"); // default threshold
  });

  it("includes header with threshold", () => {
    const feed = getLowScoreApprovedFeed({ getLowScoreApprovedTasks: () => [] }, { threshold: 0.65 });
    const msg = formatLowScoreFeedForTelegram(feed);
    expect(msg).toContain("65%");
  });

  it("includes per-agent summary and task list when tasks exist", () => {
    const store = {
      getLowScoreApprovedTasks: () => [
        {
          id: "01ABCD12345678901234",
          title: "Fix the broken widget",
          status: "done" as const,
          task_type: "implementation" as const,
          agent_name: "agent-alpha",
          quality_score: 0.62,
          verification_status: "approved" as const,
          verification_notes: null,
          source_ref: "owner/repo/pull/5",
          result: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
    };

    const feed = getLowScoreApprovedFeed(store, { threshold: 0.75 });
    const msg = formatLowScoreFeedForTelegram(feed);

    expect(msg).toContain("agent-alpha");
    expect(msg).toContain("62%");
    expect(msg).toContain("Fix the broken widget");
    expect(msg).toContain("By agent:");
  });

  it("shows dashboard link when dashboardUrl provided", () => {
    const feed = getLowScoreApprovedFeed({ getLowScoreApprovedTasks: () => [] });
    const msg = formatLowScoreFeedForTelegram(feed, 10, "https://dash.example.com");
    // Empty feed — no dashboard link because we return early
    expect(msg).not.toContain("dash.example.com");
  });

  it("shows dashboard link when tasks exist and dashboardUrl provided", () => {
    const store = {
      getLowScoreApprovedTasks: () => [
        {
          id: "01ABCD12345678901234",
          title: "Task",
          status: "done" as const,
          task_type: "implementation" as const,
          agent_name: "agent-x",
          quality_score: 0.65,
          verification_status: "approved" as const,
          verification_notes: null,
          source_ref: null,
          result: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ],
    };

    const feed = getLowScoreApprovedFeed(store, { threshold: 0.75 });
    const msg = formatLowScoreFeedForTelegram(feed, 10, "https://dash.example.com");
    expect(msg).toContain("dash.example.com");
    expect(msg).toContain("low-score-approved");
  });

  it("truncates long task lists to maxTasks", () => {
    const tasks = Array.from({ length: 15 }, (_, i) => ({
      id: `01TASK${String(i).padStart(14, "0")}`,
      title: `Task ${i}`,
      status: "done" as const,
      task_type: "implementation" as const,
      agent_name: "agent-a",
      quality_score: 0.60 + i * 0.005,
      verification_status: "approved" as const,
      verification_notes: null,
      source_ref: null,
      result: null,
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }));

    const feed = getLowScoreApprovedFeed({ getLowScoreApprovedTasks: () => tasks }, { threshold: 0.75 });
    const msg = formatLowScoreFeedForTelegram(feed, 5);
    expect(msg).toContain("…and 10 more");
  });

  it("shows breakdown counts in output", () => {
    const tasks = [
      {
        id: "01ABCD12345678901234",
        title: "Below floor task",
        status: "done" as const,
        task_type: "implementation" as const,
        agent_name: "agent-a",
        quality_score: 0.55,
        verification_status: "approved" as const,
        verification_notes: null,
        source_ref: null,
        result: null,
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
    ];

    const feed = getLowScoreApprovedFeed({ getLowScoreApprovedTasks: () => tasks }, { threshold: 0.75 });
    const msg = formatLowScoreFeedForTelegram(feed);
    expect(msg).toContain("Below-floor approved");
    expect(msg).toContain("Auto-approved marginal");
  });
});
