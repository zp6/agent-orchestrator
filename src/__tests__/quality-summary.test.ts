import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  buildQualitySummaryReport,
  formatQualitySummaryForTelegram,
  QualitySummaryScheduler,
  FLAG_LAST_QUALITY_SUMMARY_SENT,
  QUALITY_SUMMARY_THRESHOLD,
} from "../reviewer/quality-summary.js";
import type { QualitySummaryReport } from "../state/types.js";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-quality-summary-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    updated_at?: string;
    status?: string;
  }) => {
    seq += 1;
    const id = `01QSUM${String(seq).padStart(14, "0")}`;
    const now = overrides.updated_at ?? new Date().toISOString().slice(0, 19).replace("T", " ");
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
        "implementation",
        null,
        overrides.verification_status ?? "approved",
        overrides.quality_score ?? null,
        null,
        now,
        now,
      );
    return id;
  };

  const cleanup = () => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  };

  return { store, insertTask, cleanup };
}

describe("quality summary digest", () => {
  let fixture: ReturnType<typeof makeFixture>;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
    vi.useRealTimers();
  });

  it("builds a rolling 24h summary with worst-agent ordering", () => {
    fixture.insertTask({ agent_name: "alpha", quality_score: 0.95, verification_status: "approved", updated_at: hoursAgo(2) });
    fixture.insertTask({ agent_name: "alpha", quality_score: 0.91, verification_status: "approved", updated_at: hoursAgo(4) });
    fixture.insertTask({ agent_name: "beta", quality_score: 0.74, verification_status: "approved", updated_at: hoursAgo(3) });
    fixture.insertTask({ agent_name: "beta", quality_score: 0.78, verification_status: "approved", updated_at: hoursAgo(6) });
    fixture.insertTask({ agent_name: "gamma", quality_score: 0.82, verification_status: "approved", updated_at: hoursAgo(1) });
    fixture.insertTask({ agent_name: "delta", quality_score: 0.30, verification_status: "approved", updated_at: hoursAgo(30) });
    fixture.insertTask({ agent_name: "epsilon", quality_score: 0.40, verification_status: "rejected", updated_at: hoursAgo(2) });

    const report = buildQualitySummaryReport(fixture.store);

    expect(report.window_hours).toBe(24);
    expect(report.threshold).toBe(QUALITY_SUMMARY_THRESHOLD);
    expect(report.total_approved).toBe(5);
    expect(report.below_threshold_count).toBe(2);
    expect(report.below_threshold_rate).toBeCloseTo(0.4);
    expect(report.per_agent.map((row) => row.agent_name)).toEqual(["beta", "gamma", "alpha"]);
    expect(report.worst_agent?.agent_name).toBe("beta");
    expect(report.worst_agent?.avg_quality_score).toBeCloseTo(0.76);
  });

  it("formats the summary for Telegram operators", () => {
    const report: QualitySummaryReport = {
      generated_at: "2026-04-07T12:00:00.000Z",
      window_hours: 24,
      threshold: 0.8,
      total_approved: 5,
      below_threshold_count: 2,
      below_threshold_rate: 0.4,
      worst_agent: {
        agent_name: "beta",
        approved_count: 2,
        below_threshold_count: 2,
        below_threshold_rate: 1,
        avg_quality_score: 0.76,
      },
      per_agent: [
        {
          agent_name: "beta",
          approved_count: 2,
          below_threshold_count: 2,
          below_threshold_rate: 1,
          avg_quality_score: 0.76,
        },
        {
          agent_name: "gamma",
          approved_count: 1,
          below_threshold_count: 0,
          below_threshold_rate: 0,
          avg_quality_score: 0.82,
        },
      ],
    };

    const message = formatQualitySummaryForTelegram(report);

    expect(message).toContain("Quality Summary");
    expect(message).toContain("Approved scored tasks: *5*");
    expect(message).toContain("Below 0.80: *2* (40.0%)");
    expect(message).toContain("Worst agent: `beta`");
    expect(message).toContain("Worst agents");
  });

  it("fires once per day at the configured UTC hour", async () => {
    const report: QualitySummaryReport = {
      generated_at: "2026-04-07T12:00:00.000Z",
      window_hours: 24,
      threshold: 0.8,
      total_approved: 1,
      below_threshold_count: 1,
      below_threshold_rate: 1,
      worst_agent: {
        agent_name: "beta",
        approved_count: 1,
        below_threshold_count: 1,
        below_threshold_rate: 1,
        avg_quality_score: 0.74,
      },
      per_agent: [
        {
          agent_name: "beta",
          approved_count: 1,
          below_threshold_count: 1,
          below_threshold_rate: 1,
          avg_quality_score: 0.74,
        },
      ],
    };

    const flags = new Map<string, string>();
    const store = {
      getQualitySummaryReport: vi.fn(() => report),
      getSystemFlag: (key: string) => flags.get(key) ?? null,
      setSystemFlag: (key: string, value: string) => {
        flags.set(key, value);
      },
    };
    const notifier = {
      send: vi.fn(async (_text: string) => undefined),
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T09:15:00.000Z"));

    const scheduler = new QualitySummaryScheduler(store, notifier, { digestHourUtc: 9 });

    await expect(scheduler.maybeFireDigest()).resolves.toBe(true);
    await expect(scheduler.maybeFireDigest()).resolves.toBe(false);
    expect(store.getQualitySummaryReport).toHaveBeenCalledTimes(1);
    // #564 noise suppression: digest is logged but not dispatched to Telegram.
    expect(notifier.send).not.toHaveBeenCalled();
    expect(flags.get(FLAG_LAST_QUALITY_SUMMARY_SENT)).toBe("2026-04-25");
  });
});
