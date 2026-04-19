/**
 * Tests for dispatch block tracking (issue #976).
 *
 * Verifies that:
 * - recordDispatchBlock() persists block events
 * - getDispatchBlockMetrics() correctly computes block rates and trends
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("Dispatch Block Tracking", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-dispatch-blocks-test-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  });

  describe("recordDispatchBlock", () => {
    it("records a block event without throwing", () => {
      expect(() =>
        store.recordDispatchBlock({
          sourceRef: "rapartlu/agent-orchestrator#976",
          agentName: "claude-agent-orchestrator",
          reason: "Open PR #123 is already in review",
          blockCode: "open_pr_exists",
          blockingPRNumber: 123,
        }),
      ).not.toThrow();
    });

    it("records a block event without optional fields", () => {
      expect(() =>
        store.recordDispatchBlock({
          sourceRef: "rapartlu/agent-orchestrator#100",
          reason: "Some block reason",
          blockCode: "approved_pr_waiting",
        }),
      ).not.toThrow();
    });

    it("supports multiple block events for the same source ref", () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#200",
        reason: "First block",
        blockCode: "open_pr_exists",
        blockingPRNumber: 201,
      });
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#200",
        reason: "Second block",
        blockCode: "open_pr_exists",
        blockingPRNumber: 201,
      });
      // Should not throw — duplicates are allowed
    });
  });

  describe("getDispatchBlockMetrics", () => {
    it("returns empty metrics when no blocks are recorded", () => {
      const metrics = store.getDispatchBlockMetrics(7);
      expect(metrics.days).toBe(7);
      expect(metrics.total_blocked).toBe(0);
      expect(metrics.avg_block_rate_pct).toBeNull();
      expect(metrics.trend).toBe("insufficient_data");
      expect(metrics.daily).toEqual([]);
    });

    it("returns block metrics after recording events", () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#300",
        agentName: "claude-agent-orchestrator",
        reason: "Open PR #301 is already in review",
        blockCode: "open_pr_exists",
        blockingPRNumber: 301,
      });

      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#302",
        agentName: "claude-agent-orchestrator",
        reason: "Approved PR #303 is awaiting merge",
        blockCode: "approved_pr_waiting",
        blockingPRNumber: 303,
      });

      const metrics = store.getDispatchBlockMetrics(7);
      expect(metrics.total_blocked).toBe(2);
      expect(metrics.daily.length).toBeGreaterThan(0);

      const today = metrics.daily.find((d) => d.blocked > 0);
      expect(today).toBeDefined();
      expect(today!.blocked).toBe(2);
    });

    it("reports trend as insufficient_data with fewer than 3 daily data points", () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#400",
        reason: "Open PR exists",
        blockCode: "open_pr_exists",
      });

      const metrics = store.getDispatchBlockMetrics(7);
      // Only 1 day of data — not enough for trend
      expect(metrics.trend).toBe("insufficient_data");
    });

    it("respects the days parameter", () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#500",
        reason: "Open PR exists",
        blockCode: "open_pr_exists",
      });

      const metrics7 = store.getDispatchBlockMetrics(7);
      const metrics30 = store.getDispatchBlockMetrics(30);

      expect(metrics7.days).toBe(7);
      expect(metrics30.days).toBe(30);
      // Both should see today's block
      expect(metrics7.total_blocked).toBe(1);
      expect(metrics30.total_blocked).toBe(1);
    });

    it("returns daily breakdown with correct structure", () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#600",
        agentName: "test-agent",
        reason: "PR already in review",
        blockCode: "open_pr_exists",
        blockingPRNumber: 601,
      });

      const metrics = store.getDispatchBlockMetrics(7);
      const day = metrics.daily[0];

      expect(day).toMatchObject({
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        blocked: expect.any(Number),
        total: expect.any(Number),
      });
      // block_rate_pct should be null when there are no actual dispatched tasks
      // (since we have blocks but no tasks created in this test DB)
      // OR it should be 100 if total equals blocked
      if (day.block_rate_pct !== null) {
        expect(day.block_rate_pct).toBeGreaterThanOrEqual(0);
        expect(day.block_rate_pct).toBeLessThanOrEqual(100);
      }
    });
  });
});
