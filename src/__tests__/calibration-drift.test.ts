/**
 * Tests for the calibration drift monitor (issue #71).
 *
 * Covers:
 *  - StateStore.getScoreDistributions()
 *  - StateStore.getCalibrationDriftAlerts()
 *  - formatAgentDistribution()
 *  - formatDriftAlertLine()
 *  - CalibrationDriftMonitor.buildReport()
 *  - CalibrationDriftMonitor.formatDistributionPage()
 *  - CalibrationDriftMonitor.checkAndAlert()
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  CalibrationDriftMonitor,
  formatAgentDistribution,
  formatDriftAlertLine,
} from "../reviewer/calibration-drift.js";
import type { AgentScoreDistribution, CalibrationDriftAlert } from "../state/types.js";

// ── Helper: raw DB insert ─────────────────────────────────────────────────

type RawDb = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

function seedTask(
  store: StateStore,
  id: string,
  agentName: string,
  qualityScore: number | null,
  verificationStatus: string | null,
  daysAgo: number,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, created_at, updated_at)
    VALUES (?, ?, 'done', ?, 'implementation', ?, ?, datetime('now', ?), datetime('now', ?))
  `);
  insert.run(id, `task ${id}`, agentName, qualityScore, verificationStatus, `-${daysAgo} days`, `-${daysAgo} days`);
}

// ── StateStore.getScoreDistributions() ────────────────────────────────────

describe("StateStore.getScoreDistributions", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
    // agent-a: varied scores, some approved/rejected
    seedTask(store, "A1", "agent-a", 0.95, "approved", 1);
    seedTask(store, "A2", "agent-a", 0.85, "approved", 2);
    seedTask(store, "A3", "agent-a", 0.72, "approved", 3);
    seedTask(store, "A4", "agent-a", 0.65, "rejected", 4); // low-conf approval would be 0 here
    seedTask(store, "A5", "agent-a", 0.55, "approved", 5); // low-conf: score < 0.8
    // agent-b: only one score
    seedTask(store, "B1", "agent-b", 0.80, "approved", 1);
    // agent-c: no quality_score
    seedTask(store, "C1", "agent-c", null, null, 1);
  });

  it("returns one entry per agent that has scored tasks", () => {
    const dists = store.getScoreDistributions(30);
    const agents = dists.map((d) => d.agent_name).sort();
    expect(agents).toEqual(["agent-a", "agent-b"]);
    // agent-c has no quality_score, so excluded
  });

  it("computes correct task_count and mean_score for agent-a", () => {
    const dists = store.getScoreDistributions(30);
    const a = dists.find((d) => d.agent_name === "agent-a")!;
    expect(a.task_count).toBe(5);
    const expectedMean = (0.95 + 0.85 + 0.72 + 0.65 + 0.55) / 5;
    expect(a.mean_score).toBeCloseTo(expectedMean, 4);
  });

  it("computes low_confidence_approval_rate correctly", () => {
    const dists = store.getScoreDistributions(30);
    const a = dists.find((d) => d.agent_name === "agent-a")!;
    // Approved: A1(0.95), A2(0.85), A3(0.72), A5(0.55) — 4 approvals
    // Low-conf approved (< 0.8): A3(0.72), A5(0.55) — 2
    // Rate = 2/4 = 0.5
    expect(a.low_confidence_approval_rate).toBeCloseTo(0.5, 4);
  });

  it("returns null low_confidence_approval_rate when no approvals", () => {
    const store2 = new StateStore(":memory:");
    seedTask(store2, "X1", "agent-x", 0.4, "rejected", 1);
    const dists = store2.getScoreDistributions(30);
    const x = dists.find((d) => d.agent_name === "agent-x")!;
    expect(x.low_confidence_approval_rate).toBeNull();
  });

  it("places scores into correct 0.1-wide buckets", () => {
    const dists = store.getScoreDistributions(30);
    const a = dists.find((d) => d.agent_name === "agent-a")!;
    // 0.95 → bucket 0.9; 0.85 → bucket 0.8; 0.72 → bucket 0.7; 0.65 → bucket 0.6; 0.55 → bucket 0.5
    const bucketMap = Object.fromEntries(a.buckets.map((b) => [b.bucket_min.toFixed(1), b.count]));
    expect(bucketMap["0.9"]).toBe(1);
    expect(bucketMap["0.8"]).toBe(1);
    expect(bucketMap["0.7"]).toBe(1);
    expect(bucketMap["0.6"]).toBe(1);
    expect(bucketMap["0.5"]).toBe(1);
  });

  it("respects the days look-back window", () => {
    // Add a very old task (40 days ago)
    seedTask(store, "OLD", "agent-z", 0.9, "approved", 40);
    const dists30 = store.getScoreDistributions(30);
    expect(dists30.find((d) => d.agent_name === "agent-z")).toBeUndefined();

    const dists60 = store.getScoreDistributions(60);
    expect(dists60.find((d) => d.agent_name === "agent-z")).toBeDefined();
  });

  it("handles a store with no scored tasks", () => {
    const empty = new StateStore(":memory:");
    expect(empty.getScoreDistributions(30)).toEqual([]);
  });
});

// ── StateStore.getCalibrationDriftAlerts() ────────────────────────────────

describe("StateStore.getCalibrationDriftAlerts", () => {
  let store: StateStore;

  beforeEach(() => {
    store = new StateStore(":memory:");
    // agent-a: baseline (31-90 days ago) avg ≈ 0.9; recent (0-30 days) avg ≈ 0.7 → drift −0.2
    seedTask(store, "B1", "agent-a", 0.90, "approved", 40);
    seedTask(store, "B2", "agent-a", 0.88, "approved", 50);
    seedTask(store, "B3", "agent-a", 0.92, "approved", 60);
    seedTask(store, "R1", "agent-a", 0.70, "approved", 5);
    seedTask(store, "R2", "agent-a", 0.72, "approved", 10);
    seedTask(store, "R3", "agent-a", 0.68, "approved", 15);

    // agent-b: baseline ≈ 0.75; recent ≈ 0.78 → drift +0.03 (below threshold)
    seedTask(store, "C1", "agent-b", 0.75, "approved", 45);
    seedTask(store, "C2", "agent-b", 0.76, "approved", 55);
    seedTask(store, "C3", "agent-b", 0.78, "approved", 8);
    seedTask(store, "C4", "agent-b", 0.79, "approved", 12);

    // agent-c: only recent data, no baseline → should be excluded
    seedTask(store, "D1", "agent-c", 0.85, "approved", 3);
  });

  it("returns alerts for agents with data in both windows", () => {
    const alerts = store.getCalibrationDriftAlerts(30, 60);
    const agents = alerts.map((a) => a.agent_name).sort();
    expect(agents).toEqual(["agent-a", "agent-b"]);
    // agent-c excluded (no baseline)
  });

  it("correctly computes signed drift for agent-a", () => {
    const alerts = store.getCalibrationDriftAlerts(30, 60);
    const a = alerts.find((x) => x.agent_name === "agent-a")!;
    // baseline ≈ (0.90+0.88+0.92)/3 = 0.9; recent ≈ (0.70+0.72+0.68)/3 ≈ 0.7
    expect(a.baseline_mean).toBeCloseTo(0.9, 1);
    expect(a.recent_mean).toBeCloseTo(0.7, 1);
    expect(a.drift).toBeCloseTo(-0.2, 1);
    expect(a.alerted).toBe(true);
  });

  it("does not alert when drift is within threshold for agent-b", () => {
    const alerts = store.getCalibrationDriftAlerts(30, 60);
    const b = alerts.find((x) => x.agent_name === "agent-b")!;
    expect(Math.abs(b.drift)).toBeLessThanOrEqual(0.1);
    expect(b.alerted).toBe(false);
  });

  it("sorts results by |drift| descending", () => {
    const alerts = store.getCalibrationDriftAlerts(30, 60);
    for (let i = 0; i < alerts.length - 1; i++) {
      expect(Math.abs(alerts[i].drift)).toBeGreaterThanOrEqual(Math.abs(alerts[i + 1].drift));
    }
  });

  it("includes baseline_task_count and recent_task_count", () => {
    const alerts = store.getCalibrationDriftAlerts(30, 60);
    const a = alerts.find((x) => x.agent_name === "agent-a")!;
    expect(a.baseline_task_count).toBe(3);
    expect(a.recent_task_count).toBe(3);
  });
});

// ── formatAgentDistribution() ─────────────────────────────────────────────

describe("formatAgentDistribution", () => {
  it("includes agent name, task count, mean, and low-conf rate", () => {
    const dist: AgentScoreDistribution = {
      agent_name: "my-agent",
      task_count: 10,
      mean_score: 0.82,
      low_confidence_approval_rate: 0.25,
      buckets: [
        { bucket_min: 0.7, count: 3 },
        { bucket_min: 0.8, count: 7 },
      ],
    };
    const lines = formatAgentDistribution(dist);
    expect(lines[0]).toContain("my-agent");
    expect(lines[0]).toContain("10 tasks");
    expect(lines[0]).toContain("mean 0.82");
    expect(lines[0]).toContain("25% low-conf approvals");
  });

  it("renders a bar for each bucket", () => {
    const dist: AgentScoreDistribution = {
      agent_name: "agent-x",
      task_count: 5,
      mean_score: 0.75,
      low_confidence_approval_rate: null,
      buckets: [
        { bucket_min: 0.7, count: 2 },
        { bucket_min: 0.8, count: 3 },
      ],
    };
    const lines = formatAgentDistribution(dist);
    // First line is header; subsequent lines are buckets
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain("0.7─0.8");
    expect(lines[2]).toContain("0.8─0.9");
  });

  it("handles no buckets gracefully", () => {
    const dist: AgentScoreDistribution = {
      agent_name: "new-agent",
      task_count: 0,
      mean_score: null,
      low_confidence_approval_rate: null,
      buckets: [],
    };
    const lines = formatAgentDistribution(dist);
    expect(lines[0]).toContain("new-agent");
    expect(lines[1]).toContain("no scored tasks");
  });

  it("shows 'no approvals' when low_confidence_approval_rate is null", () => {
    const dist: AgentScoreDistribution = {
      agent_name: "agent-y",
      task_count: 2,
      mean_score: 0.4,
      low_confidence_approval_rate: null,
      buckets: [{ bucket_min: 0.4, count: 2 }],
    };
    const lines = formatAgentDistribution(dist);
    expect(lines[0]).toContain("no approvals");
  });
});

// ── formatDriftAlertLine() ────────────────────────────────────────────────

describe("formatDriftAlertLine", () => {
  it("shows downward drift with ▼ indicator", () => {
    const alert: CalibrationDriftAlert = {
      agent_name: "agent-a",
      baseline_mean: 0.9,
      baseline_task_count: 10,
      recent_mean: 0.7,
      recent_task_count: 8,
      drift: -0.2,
      alerted: true,
    };
    const lines = formatDriftAlertLine(alert);
    expect(lines.join("\n")).toContain("agent-a");
    expect(lines.join("\n")).toContain("▼");
    expect(lines.join("\n")).toContain("0.90");
    expect(lines.join("\n")).toContain("0.70");
  });

  it("shows upward drift with ▲ indicator", () => {
    const alert: CalibrationDriftAlert = {
      agent_name: "agent-b",
      baseline_mean: 0.6,
      baseline_task_count: 5,
      recent_mean: 0.75,
      recent_task_count: 4,
      drift: 0.15,
      alerted: true,
    };
    const lines = formatDriftAlertLine(alert);
    expect(lines.join("\n")).toContain("▲");
    expect(lines.join("\n")).toContain("+0.15");
  });
});

// ── CalibrationDriftMonitor ───────────────────────────────────────────────

describe("CalibrationDriftMonitor.buildReport", () => {
  let store: StateStore;
  let monitor: CalibrationDriftMonitor;

  beforeEach(() => {
    store = new StateStore(":memory:");
    monitor = new CalibrationDriftMonitor(store);
    seedTask(store, "T1", "test-agent", 0.85, "approved", 2);
    seedTask(store, "T2", "test-agent", 0.78, "approved", 5);
  });

  it("returns a report with generated_at and window_days", () => {
    const report = monitor.buildReport({ windowDays: 14 });
    expect(report.generated_at).toBeTruthy();
    expect(report.window_days).toBe(14);
  });

  it("includes distributions and drift_alerts arrays", () => {
    const report = monitor.buildReport();
    expect(Array.isArray(report.distributions)).toBe(true);
    expect(Array.isArray(report.drift_alerts)).toBe(true);
  });

  it("distributions include the seeded agent", () => {
    const report = monitor.buildReport();
    const dist = report.distributions.find((d) => d.agent_name === "test-agent");
    expect(dist).toBeDefined();
    expect(dist!.task_count).toBe(2);
  });
});

describe("CalibrationDriftMonitor.formatDistributionPage", () => {
  it("shows the page header and no-data message for empty store", () => {
    const store = new StateStore(":memory:");
    const monitor = new CalibrationDriftMonitor(store);
    const report = monitor.buildReport();
    const page = monitor.formatDistributionPage(report);
    expect(page).toContain("Verification Calibration");
    expect(page).toContain("No verified tasks");
  });

  it("shows agent distribution when tasks exist", () => {
    const store = new StateStore(":memory:");
    seedTask(store, "P1", "prod-agent", 0.9, "approved", 3);
    seedTask(store, "P2", "prod-agent", 0.82, "approved", 7);
    const monitor = new CalibrationDriftMonitor(store);
    const report = monitor.buildReport();
    const page = monitor.formatDistributionPage(report);
    expect(page).toContain("prod-agent");
    expect(page).toContain("mean");
  });

  it("shows drift alert section when an agent has drifted", () => {
    const store = new StateStore(":memory:");
    // baseline
    seedTask(store, "BL1", "drift-agent", 0.9, "approved", 40);
    seedTask(store, "BL2", "drift-agent", 0.9, "approved", 50);
    // recent — significantly lower
    seedTask(store, "R1", "drift-agent", 0.6, "approved", 5);
    seedTask(store, "R2", "drift-agent", 0.6, "approved", 10);
    const monitor = new CalibrationDriftMonitor(store);
    const report = monitor.buildReport();
    const page = monitor.formatDistributionPage(report);
    expect(page).toContain("Drift Alerts");
    expect(page).toContain("drift-agent");
  });

  it("shows no-drift message when all agents are within threshold", () => {
    const store = new StateStore(":memory:");
    // baseline and recent within 0.1
    seedTask(store, "BL1", "stable-agent", 0.8, "approved", 40);
    seedTask(store, "R1", "stable-agent", 0.82, "approved", 5);
    const monitor = new CalibrationDriftMonitor(store);
    const report = monitor.buildReport();
    const page = monitor.formatDistributionPage(report);
    expect(page).toContain("No calibration drift detected");
  });
});

describe("CalibrationDriftMonitor.checkAndAlert", () => {
  it("calls notify when drift is detected", async () => {
    const store = new StateStore(":memory:");
    // baseline
    seedTask(store, "BL1", "alert-agent", 0.9, "approved", 40);
    seedTask(store, "BL2", "alert-agent", 0.9, "approved", 50);
    // recent
    seedTask(store, "R1", "alert-agent", 0.6, "approved", 5);
    seedTask(store, "R2", "alert-agent", 0.6, "approved", 10);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockResolvedValue(undefined);
    await monitor.checkAndAlert(notify);

    expect(notify).toHaveBeenCalledOnce();
    const [msg] = notify.mock.calls[0] as [string];
    expect(msg).toContain("Calibration Drift Detected");
    expect(msg).toContain("alert-agent");
  });

  it("does not call notify when no agents have drifted", async () => {
    const store = new StateStore(":memory:");
    // stable agent
    seedTask(store, "S1", "stable", 0.8, "approved", 40);
    seedTask(store, "S2", "stable", 0.82, "approved", 5);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockResolvedValue(undefined);
    await monitor.checkAndAlert(notify);

    expect(notify).not.toHaveBeenCalled();
  });

  it("does not throw when notify rejects", async () => {
    const store = new StateStore(":memory:");
    seedTask(store, "BL1", "err-agent", 0.9, "approved", 40);
    seedTask(store, "R1", "err-agent", 0.6, "approved", 5);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockRejectedValue(new Error("network error"));
    // Should not throw — errors are swallowed
    await expect(monitor.checkAndAlert(notify)).resolves.toBeUndefined();
  });

  it("suppresses repeat alerts for the same agent within the cooldown window", async () => {
    const store = new StateStore(":memory:");
    // Seed a drifted agent
    seedTask(store, "BL1", "cd-agent", 0.9, "approved", 40);
    seedTask(store, "BL2", "cd-agent", 0.9, "approved", 50);
    seedTask(store, "R1", "cd-agent", 0.6, "approved", 5);
    seedTask(store, "R2", "cd-agent", 0.6, "approved", 10);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockResolvedValue(undefined);

    // First call — should fire
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledOnce();

    // Second call immediately after — cooldown not expired, should be suppressed
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledOnce(); // still only once
  });

  it("re-alerts after the cooldown window expires", async () => {
    const store = new StateStore(":memory:");
    seedTask(store, "BL1", "cd-agent2", 0.9, "approved", 40);
    seedTask(store, "R1", "cd-agent2", 0.6, "approved", 5);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockResolvedValue(undefined);

    // First call
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledOnce();

    // Manually backdate the last-alerted timestamp to simulate expiry
    const lastAlertedAt = (monitor as unknown as { lastAlertedAt: Map<string, number> }).lastAlertedAt;
    const COOLDOWN = (monitor as unknown as { ALERT_COOLDOWN_MS: number }).ALERT_COOLDOWN_MS;
    lastAlertedAt.set("cd-agent2", Date.now() - COOLDOWN - 1);

    // Second call after expiry — should fire again
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("only includes due agents in the alert when multiple agents are drifted", async () => {
    const store = new StateStore(":memory:");
    // Agent A: drifted
    seedTask(store, "A_BL1", "agent-a", 0.9, "approved", 40);
    seedTask(store, "A_R1", "agent-a", 0.6, "approved", 5);
    // Agent B: also drifted
    seedTask(store, "B_BL1", "agent-b", 0.9, "approved", 40);
    seedTask(store, "B_R1", "agent-b", 0.6, "approved", 5);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockResolvedValue(undefined);

    // First call — both agents are due, both included
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledOnce();
    const firstMsg = notify.mock.calls[0][0] as string;
    expect(firstMsg).toContain("agent-a");
    expect(firstMsg).toContain("agent-b");

    // Expire only agent-a's cooldown
    const lastAlertedAt = (monitor as unknown as { lastAlertedAt: Map<string, number> }).lastAlertedAt;
    const COOLDOWN = (monitor as unknown as { ALERT_COOLDOWN_MS: number }).ALERT_COOLDOWN_MS;
    lastAlertedAt.set("agent-a", Date.now() - COOLDOWN - 1);
    // agent-b cooldown is NOT expired (just alerted)

    // Second call — only agent-a should be in the alert
    await monitor.checkAndAlert(notify);
    expect(notify).toHaveBeenCalledTimes(2);
    const secondMsg = notify.mock.calls[1][0] as string;
    expect(secondMsg).toContain("agent-a");
    expect(secondMsg).not.toContain("agent-b");
  });

  it("does not record lastAlertedAt when notify throws", async () => {
    const store = new StateStore(":memory:");
    seedTask(store, "BL1", "throw-agent", 0.9, "approved", 40);
    seedTask(store, "R1", "throw-agent", 0.6, "approved", 5);

    const monitor = new CalibrationDriftMonitor(store);
    const notify = vi.fn().mockRejectedValue(new Error("send failed"));

    // First call fails
    await monitor.checkAndAlert(notify);

    const lastAlertedAt = (monitor as unknown as { lastAlertedAt: Map<string, number> }).lastAlertedAt;
    // Timestamp should NOT be recorded since notify threw
    expect(lastAlertedAt.has("throw-agent")).toBe(false);

    // Second call should still attempt to notify (no cooldown recorded)
    const notify2 = vi.fn().mockResolvedValue(undefined);
    await monitor.checkAndAlert(notify2);
    expect(notify2).toHaveBeenCalledOnce();
  });
});
