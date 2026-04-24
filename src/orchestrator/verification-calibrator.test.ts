import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../state/store.js";
import { buildCalibrationReport } from "./verification-calibrator.js";

let store: StateStore;
let dbPath: string;

function makeDbPath(): string {
  const dir = join(tmpdir(), `orch-calibration-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.sqlite");
}

beforeEach(() => {
  dbPath = makeDbPath();
  store = new StateStore(dbPath);
});

afterEach(() => {
  try {
    if (existsSync(dbPath)) unlinkSync(dbPath);
    if (existsSync(dbPath + "-wal")) unlinkSync(dbPath + "-wal");
    if (existsSync(dbPath + "-shm")) unlinkSync(dbPath + "-shm");
  } catch {
    // best-effort cleanup
  }
});

function createVerifiedTask(overrides: {
  agentName: string;
  qualityScore: number;
  revisionCount?: number;
  status?: "done" | "failed";
}): void {
  const task = store.createTask({
    title: "Calibration sample",
    description: "Calibration sample task",
    source: "github",
    source_ref: `owner/repo#${Math.floor(Math.random() * 999999)}`,
    agent_name: overrides.agentName,
    task_type: "implementation",
  });

  store.updateTask(task.id, {
    status: overrides.status ?? "done",
    verification_status: "approved",
    quality_score: overrides.qualityScore,
    revision_count: overrides.revisionCount ?? 0,
    agent_name: overrides.agentName,
  });
}

describe("buildCalibrationReport", () => {
  it("persists strong recommendations and auto-applies the threshold override", () => {
    for (let i = 0; i < 15; i++) {
      createVerifiedTask({
        agentName: "claude-reviewer-alpha",
        qualityScore: 0.83,
        revisionCount: 0,
      });
    }

    const report = buildCalibrationReport(store, 0.7);

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(report.recommendations[0].suggestedThreshold).toBeCloseTo(0.8);

    const rows = store.getVerificationCalibrationRecommendations();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("applied");
    expect(rows[0].verifier_agent).toBe("claude-reviewer-alpha");

    const overrides = store.getAppliedVerificationCalibrationThresholds();
    expect(overrides["claude-reviewer-alpha"]).toBeCloseTo(0.8);
  });

  it("keeps lower-confidence recommendations pending for operator review", () => {
    for (let i = 0; i < 3; i++) {
      createVerifiedTask({
        agentName: "claude-reviewer-beta",
        qualityScore: 0.84,
        revisionCount: 0,
      });
    }

    const report = buildCalibrationReport(store, 0.7);

    expect(report.recommendations).toHaveLength(1);
    expect(report.recommendations[0].confidence).toBeLessThan(0.85);

    const rows = store.getVerificationCalibrationRecommendations();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");

    const overrides = store.getAppliedVerificationCalibrationThresholds();
    expect(overrides["claude-reviewer-beta"]).toBeUndefined();
  });
});
