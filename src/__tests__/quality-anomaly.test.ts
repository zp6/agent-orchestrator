/**
 * Tests for Quality Anomaly feed (issue #153).
 *
 * Verifies that the StateStore correctly identifies tasks where the
 * verifier's quality_score contradicts its verification_status:
 *   (a) score < 0.60 AND status = approved  → low_score_approved
 *   (b) score > 0.85 AND status = rejected  → high_score_rejected
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "../state/store.js";
import fs from "node:fs";
import path from "node:path";

function insertTask(
  store: StateStore,
  id: string,
  opts: {
    title?: string;
    agent_name?: string;
    task_type?: string;
    quality_score?: number | null;
    verification_status?: string | null;
    quality_explanation?: string | null;
    updated_at?: string;
  },
): void {
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
  db.prepare(
    `INSERT INTO tasks (id, title, status, agent_name, task_type, quality_score, verification_status, quality_explanation, created_at, updated_at)
     VALUES (?, ?, 'done', ?, ?, ?, ?, ?, datetime('now', '-1 day'), ?)`,
  ).run(
    id,
    opts.title ?? `Task ${id}`,
    opts.agent_name ?? "test-agent",
    opts.task_type ?? "implementation",
    opts.quality_score ?? null,
    opts.verification_status ?? null,
    opts.quality_explanation ?? null,
    opts.updated_at ?? new Date().toISOString(),
  );
}

describe("Quality Anomaly Feed", () => {
  let dbPath: string;
  let store: StateStore;

  beforeEach(() => {
    dbPath = path.join(__dirname, `test-anomaly-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
  });

  describe("getQualityAnomalies()", () => {
    it("returns empty array when no tasks exist", () => {
      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toEqual([]);
    });

    it("returns empty array when no anomalies exist", () => {
      // Normal: good score + approved
      insertTask(store, "T01", { quality_score: 0.90, verification_status: "approved" });
      // Normal: low score + rejected
      insertTask(store, "T02", { quality_score: 0.40, verification_status: "rejected" });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toEqual([]);
    });

    it("detects low_score_approved anomaly (score < 0.60, approved)", () => {
      insertTask(store, "T01", {
        title: "Suspicious approval",
        agent_name: "agent-a",
        quality_score: 0.35,
        verification_status: "approved",
        quality_explanation: "Score fell below threshold",
      });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].task_id).toBe("T01");
      expect(anomalies[0].anomaly_type).toBe("low_score_approved");
      expect(anomalies[0].quality_score).toBe(0.35);
      expect(anomalies[0].verification_status).toBe("approved");
      expect(anomalies[0].quality_explanation).toBe("Score fell below threshold");
    });

    it("detects high_score_rejected anomaly (score > 0.85, rejected)", () => {
      insertTask(store, "T02", {
        title: "Surprising rejection",
        agent_name: "agent-b",
        quality_score: 0.92,
        verification_status: "rejected",
      });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0].task_id).toBe("T02");
      expect(anomalies[0].anomaly_type).toBe("high_score_rejected");
      expect(anomalies[0].quality_score).toBe(0.92);
    });

    it("detects both types of anomalies simultaneously", () => {
      insertTask(store, "T01", { quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { quality_score: 0.95, verification_status: "rejected" });
      // Not anomalies:
      insertTask(store, "T03", { quality_score: 0.90, verification_status: "approved" });
      insertTask(store, "T04", { quality_score: 0.40, verification_status: "rejected" });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toHaveLength(2);
    });

    it("respects days filter", () => {
      // Old anomaly (35 days ago)
      insertTask(store, "T01", {
        quality_score: 0.30,
        verification_status: "approved",
        updated_at: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
      });
      // Recent anomaly (1 day ago)
      insertTask(store, "T02", {
        quality_score: 0.25,
        verification_status: "approved",
        updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const last7 = store.getQualityAnomalies({ days: 7 });
      expect(last7).toHaveLength(1);
      expect(last7[0].task_id).toBe("T02");

      const last60 = store.getQualityAnomalies({ days: 60 });
      expect(last60).toHaveLength(2);
    });

    it("filters by anomaly_type", () => {
      insertTask(store, "T01", { quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { quality_score: 0.95, verification_status: "rejected" });

      const lowOnly = store.getQualityAnomalies({ anomaly_type: "low_score_approved" });
      expect(lowOnly).toHaveLength(1);
      expect(lowOnly[0].anomaly_type).toBe("low_score_approved");

      const highOnly = store.getQualityAnomalies({ anomaly_type: "high_score_rejected" });
      expect(highOnly).toHaveLength(1);
      expect(highOnly[0].anomaly_type).toBe("high_score_rejected");
    });

    it("filters by agent_name", () => {
      insertTask(store, "T01", { agent_name: "agent-a", quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { agent_name: "agent-b", quality_score: 0.25, verification_status: "approved" });

      const agentA = store.getQualityAnomalies({ agent_name: "agent-a" });
      expect(agentA).toHaveLength(1);
      expect(agentA[0].agent_name).toBe("agent-a");
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        insertTask(store, `T${i}`, { quality_score: 0.30, verification_status: "approved" });
      }

      const limited = store.getQualityAnomalies({ limit: 3 });
      expect(limited).toHaveLength(3);
    });

    it("does not flag boundary scores (0.60 approved is not anomaly)", () => {
      // score = 0.60 exactly is NOT an anomaly (threshold is < 0.60)
      insertTask(store, "T01", { quality_score: 0.60, verification_status: "approved" });
      // score = 0.85 exactly is NOT an anomaly (threshold is > 0.85)
      insertTask(store, "T02", { quality_score: 0.85, verification_status: "rejected" });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toEqual([]);
    });

    it("does not include tasks without verification_status", () => {
      insertTask(store, "T01", { quality_score: 0.30, verification_status: null });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toEqual([]);
    });

    it("does not include tasks without quality_score", () => {
      insertTask(store, "T01", { quality_score: null, verification_status: "approved" });

      const anomalies = store.getQualityAnomalies();
      expect(anomalies).toEqual([]);
    });
  });

  describe("getQualityAnomalySummary()", () => {
    it("returns zeroed summary when no anomalies exist", () => {
      const summary = store.getQualityAnomalySummary();
      expect(summary.total).toBe(0);
      expect(summary.low_score_approved).toBe(0);
      expect(summary.high_score_rejected).toBe(0);
      expect(summary.per_agent).toEqual([]);
      expect(summary.anomalies).toEqual([]);
    });

    it("returns correct counts by type", () => {
      insertTask(store, "T01", { quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { quality_score: 0.20, verification_status: "approved" });
      insertTask(store, "T03", { quality_score: 0.95, verification_status: "rejected" });

      const summary = store.getQualityAnomalySummary();
      expect(summary.total).toBe(3);
      expect(summary.low_score_approved).toBe(2);
      expect(summary.high_score_rejected).toBe(1);
    });

    it("returns per-agent breakdown sorted by count desc", () => {
      insertTask(store, "T01", { agent_name: "agent-a", quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { agent_name: "agent-a", quality_score: 0.25, verification_status: "approved" });
      insertTask(store, "T03", { agent_name: "agent-b", quality_score: 0.95, verification_status: "rejected" });

      const summary = store.getQualityAnomalySummary();
      expect(summary.per_agent).toHaveLength(2);
      expect(summary.per_agent[0]).toEqual({ agent_name: "agent-a", count: 2 });
      expect(summary.per_agent[1]).toEqual({ agent_name: "agent-b", count: 1 });
    });

    it("passes query options through to getQualityAnomalies", () => {
      insertTask(store, "T01", { agent_name: "agent-a", quality_score: 0.30, verification_status: "approved" });
      insertTask(store, "T02", { agent_name: "agent-b", quality_score: 0.25, verification_status: "approved" });

      const summary = store.getQualityAnomalySummary({ agent_name: "agent-a" });
      expect(summary.total).toBe(1);
      expect(summary.anomalies[0].agent_name).toBe("agent-a");
    });
  });
});
