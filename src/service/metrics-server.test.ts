/**
 * Tests for the metrics HTTP server (issue #976).
 *
 * Verifies that:
 * - /health returns 200
 * - /dispatch-efficiency returns correct JSON shape
 * - Unknown routes return 404
 * - ?days query param is respected
 * - /api/compliance returns selfUpdate-lag rule (issue #1597)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { StateStore } from "../state/store.js";
import { startMetricsServer, buildSelfUpdateLagRule, type ComplianceRule, type ComplianceResponse } from "./metrics-server.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Helper: find a free port for testing
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Helper: fetch JSON from URL
async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = await res.json();
  return { status: res.status, body };
}

describe("MetricsServer", () => {
  let store: StateStore;
  let dbPath: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `orch-metrics-server-test-${randomUUID()}.db`);
    store = new StateStore(dbPath);
    port = await getFreePort();
    server = startMetricsServer(store, port);
    // Wait briefly for the server to start listening
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(() => {
    server.close();
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  });

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/health`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        status: "ok",
        service: "orchestrator-metrics",
      });
    });
  });

  describe("GET /dispatch-efficiency", () => {
    it("returns 200 with correct shape when no blocks recorded", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/dispatch-efficiency`);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        days: 7,
        total_blocked: 0,
        total_dispatches: 0,
        block_rate_pct: null,
        trend: "insufficient_data",
        daily: [],
        generated_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });

    it("returns block data after recording events", async () => {
      store.recordDispatchBlock({
        sourceRef: "rapartlu/agent-orchestrator#976",
        agentName: "test-agent",
        reason: "Open PR #123 is already in review",
        blockCode: "open_pr_exists",
        blockingPRNumber: 123,
      });

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/dispatch-efficiency`) as {
        status: number;
        body: Record<string, unknown>;
      };
      expect(status).toBe(200);
      expect(body.total_blocked).toBe(1);
      expect(Array.isArray(body.daily)).toBe(true);
    });

    it("respects the ?days query parameter", async () => {
      const { body } = await fetchJson(`http://127.0.0.1:${port}/dispatch-efficiency?days=30`) as {
        body: Record<string, unknown>;
      };
      expect(body.days).toBe(30);
    });

    it("caps invalid days to 7 default", async () => {
      const { body } = await fetchJson(`http://127.0.0.1:${port}/dispatch-efficiency?days=abc`) as {
        body: Record<string, unknown>;
      };
      expect(body.days).toBe(7);
    });
  });

  describe("GET /api/pr-guard-surge-suppressions", () => {
    it("returns active multi-issue suppressions", async () => {
      store.setPRGuardMultiIssueSuppression({
        repo: "owner/repo",
        blockingPrNumber: 77,
        blockedIssueNumbers: [10, 11],
        eventCount: 2,
        suppressedUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/pr-guard-surge-suppressions`) as {
        status: number;
        body: {
          repo_filter: string | null;
          total: number;
          suppressions: Array<{
            repo: string;
            blocking_pr_number: number;
            blocked_issues: number[];
            event_count: number;
          }>;
          generated_at: string;
        };
      };

      expect(status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.repo_filter).toBeNull();
      expect(body.suppressions[0]).toMatchObject({
        repo: "owner/repo",
        blocking_pr_number: 77,
        blocked_issues: [10, 11],
        event_count: 2,
      });
    });
  });

  describe("GET /guard-health", () => {
    it("includes active PR surge suppression counts", async () => {
      store.setPRGuardMultiIssueSuppression({
        repo: "owner/repo",
        blockingPrNumber: 77,
        blockedIssueNumbers: [10, 11],
        eventCount: 2,
        suppressedUntil: new Date(Date.now() + 2 * 60 * 60 * 1000),
      });

      const { body } = await fetchJson(`http://127.0.0.1:${port}/guard-health?hours=24`) as {
        body: {
          metrics: {
            active_pr_surge_suppressions: number;
            pr_surge_suppressions: Array<{
              repo: string;
              blocking_pr_number: number;
              blocked_issues: number[];
            }>;
          };
        };
      };

      expect(body.metrics.active_pr_surge_suppressions).toBe(1);
      expect(body.metrics.pr_surge_suppressions).toHaveLength(1);
      expect(body.metrics.pr_surge_suppressions[0]).toMatchObject({
        repo: "owner/repo",
        blocking_pr_number: 77,
        blocked_issues: [10, 11],
      });
    });
  });

  describe("GET /monologue", () => {
    it("returns paginated prose monologue entries", async () => {
      const first = store.createTask({ title: "Monologue task 1", source: "manual", agent_name: "agent-a" });
      const second = store.createTask({ title: "Monologue task 2", source: "manual", agent_name: "agent-a" });

      store.emitMonologue({
        agent_name: "agent-a",
        task_id: first.id,
        kind: "plan",
        prose: "I am mapping the task first.",
      });
      store.emitMonologue({
        agent_name: "agent-a",
        task_id: second.id,
        kind: "execution",
        prose: "I am sending the work now.",
      });

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/monologue?agent=agent-a&limit=1&offset=0`) as {
        status: number;
        body: {
          total: number;
          items: Array<{ task_id: string; kind: string; prose: string }>;
          agent: string | null;
          kind: string | null;
        };
      };

      expect(status).toBe(200);
      expect(body.total).toBe(2);
      expect(body.agent).toBe("agent-a");
      expect(body.items).toHaveLength(1);
      expect(body.items[0].kind).toBe("execution");
    });
  });

  describe("GET /unknown-route", () => {
    it("returns 404", async () => {
      const { status } = await fetchJson(`http://127.0.0.1:${port}/unknown-route`);
      expect(status).toBe(404);
    });
  });

  // ── /api/ulid-collisions (issue #1133) ────────────────────────────────────

  describe("GET /api/ulid-collisions", () => {
    it("returns empty collision list when no collisions recorded", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/ulid-collisions`) as {
        status: number;
        body: { total_collisions: number; collisions: unknown[]; generated_at: string };
      };
      expect(status).toBe(200);
      expect(body.total_collisions).toBe(0);
      expect(Array.isArray(body.collisions)).toBe(true);
      expect(body.collisions).toHaveLength(0);
      expect(typeof body.generated_at).toBe("string");
    });

    it("returns recorded collisions with correct shape", async () => {
      store.recordUlidCollision({
        collidingId: "01ABCDEF12",
        existingTitle: "Existing Task",
        newTitle: "New Conflicting Task",
      });

      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/ulid-collisions`) as {
        status: number;
        body: {
          total_collisions: number;
          collisions: Array<{
            id: number;
            colliding_id: string;
            existing_title: string;
            new_title: string;
            detected_at: string;
          }>;
          generated_at: string;
        };
      };

      expect(status).toBe(200);
      expect(body.total_collisions).toBe(1);
      expect(body.collisions).toHaveLength(1);

      const collision = body.collisions[0];
      expect(collision.colliding_id).toBe("01ABCDEF12");
      expect(collision.existing_title).toBe("Existing Task");
      expect(collision.new_title).toBe("New Conflicting Task");
      expect(typeof collision.detected_at).toBe("string");
    });

    it("returns multiple collisions ordered newest first", async () => {
      store.recordUlidCollision({ collidingId: "ID001", existingTitle: "Old Task", newTitle: "New Task A" });
      store.recordUlidCollision({ collidingId: "ID002", existingTitle: "Older Task", newTitle: "New Task B" });

      const { body } = await fetchJson(`http://127.0.0.1:${port}/api/ulid-collisions`) as {
        body: { total_collisions: number; collisions: Array<{ colliding_id: string }> };
      };

      expect(body.total_collisions).toBe(2);
      // Most recent is last-inserted, so ID002 appears first (DESC order)
      expect(body.collisions[0].colliding_id).toBe("ID002");
      expect(body.collisions[1].colliding_id).toBe("ID001");
    });
  });

  // ── GET /api/low-score-approved (issue #1706) ────────────────────────────────

  describe("GET /api/low-score-approved", () => {
    it("returns empty entries when no low-score tasks exist", async () => {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${port}/api/low-score-approved`,
      ) as { status: number; body: { window_days: number; count: number; entries: unknown[] } };

      expect(status).toBe(200);
      expect(body.window_days).toBe(7);
      expect(body.count).toBe(0);
      expect(body.entries).toEqual([]);
    });

    it("returns low-score entries (< 0.10) and excludes higher scores", async () => {
      // Low-score (should appear)
      store.insertVerificationOutcome({
        task_id: "task-low-001",
        pr_url: "https://github.com/rapartlu/test/pull/1",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.05,
        task_type: "implementation",
        bypass_path: "triage-schema-gate-passed / llm-score-zero",
      });
      // Exactly 0.10 (should NOT appear — threshold is strictly < 0.10)
      store.insertVerificationOutcome({
        task_id: "task-threshold-010",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.10,
        task_type: "implementation",
      });
      // High score (should not appear)
      store.insertVerificationOutcome({
        task_id: "task-high-001",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.85,
        task_type: "implementation",
      });

      const { status, body } = await fetchJson(
        `http://127.0.0.1:${port}/api/low-score-approved`,
      ) as {
        status: number;
        body: {
          count: number;
          entries: Array<{
            task_id: string;
            bypass_path: string | null;
            verification_score: number;
          }>;
        };
      };

      expect(status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.entries[0].task_id).toBe("task-low-001");
      expect(body.entries[0].bypass_path).toBe("triage-schema-gate-passed / llm-score-zero");
      expect(body.entries[0].verification_score).toBe(0.05);
    });

    it("returns null bypass_path when not set", async () => {
      store.insertVerificationOutcome({
        task_id: "task-no-bypass",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.02,
        task_type: "implementation",
        // bypass_path intentionally omitted
      });

      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/low-score-approved`,
      ) as { body: { entries: Array<{ bypass_path: unknown }> } };

      expect(body.entries[0].bypass_path).toBeNull();
    });

    it("respects ?days query parameter", async () => {
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/low-score-approved?days=30`,
      ) as { body: { window_days: number } };

      expect(body.window_days).toBe(30);
    });

    it("caps days at 90", async () => {
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/low-score-approved?days=999`,
      ) as { body: { window_days: number } };

      expect(body.window_days).toBe(90);
    });

    it("returns 405 for POST method", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/low-score-approved`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });

  // ── GET /api/verified-task-count (issue #1706) ───────────────────────────────

  describe("GET /api/verified-task-count", () => {
    it("returns 0 when no tasks exist", async () => {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${port}/api/verified-task-count`,
      ) as { status: number; body: { window_days: number; count: number } };

      expect(status).toBe(200);
      expect(body.window_days).toBe(7);
      expect(body.count).toBe(0);
    });

    it("counts all verified tasks regardless of score", async () => {
      store.insertVerificationOutcome({
        task_id: "task-low",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.05,
        task_type: "implementation",
      });
      store.insertVerificationOutcome({
        task_id: "task-high",
        verifier_agent: "claude-orchestrator-reviewer",
        verification_score: 0.92,
        task_type: "implementation",
      });

      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/verified-task-count`,
      ) as { body: { count: number } };

      expect(body.count).toBe(2);
    });

    it("respects ?days query parameter", async () => {
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/verified-task-count?days=14`,
      ) as { body: { window_days: number } };

      expect(body.window_days).toBe(14);
    });
  });

  // ── GET /api/compliance (issue #1597) ──────────────────────────────────────

  describe("GET /api/compliance", () => {
    it("returns 200 with correct shape", async () => {
      const { status, body } = await fetchJson(
        `http://127.0.0.1:${port}/api/compliance`,
      ) as { status: number; body: ComplianceResponse };

      expect(status).toBe(200);
      expect(body.overall_status).toMatch(/^(ok|warning|failing)$/);
      expect(Array.isArray(body.rules)).toBe(true);
      expect(body.rules.length).toBeGreaterThanOrEqual(1);
      expect(typeof body.generated_at).toBe("string");
    });

    it("includes the daemon-selfupdate-lag rule", async () => {
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/compliance`,
      ) as { body: ComplianceResponse };

      const lagRule = body.rules.find((r: ComplianceRule) => r.rule === "daemon-selfupdate-lag");
      expect(lagRule).toBeDefined();
      expect(lagRule!.status).toMatch(/^(ok|warning|failing)$/);
      expect(typeof lagRule!.detail).toBe("string");
      // commits_behind may be null if git fetch errored, but should be a number or null
      expect(lagRule!.commits_behind === null || typeof lagRule!.commits_behind === "number").toBe(true);
    });

    it("fails when no successful self-update has been recorded", async () => {
      // Empty store — no self_update_cycles rows
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/compliance`,
      ) as { body: ComplianceResponse };

      const lagRule = body.rules.find((r: ComplianceRule) => r.rule === "daemon-selfupdate-lag")!;
      expect(lagRule.last_self_update_at).toBeNull();
      // No successful cycle recorded = failing (regardless of commits_behind)
      expect(lagRule.status).toBe("failing");
    });

    it("reports last_self_update_at after recording a successful cycle", async () => {
      store.recordSelfUpdateCycle({ durationMs: 1000, success: true, outcome: "up-to-date" });

      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/compliance`,
      ) as { body: ComplianceResponse };

      const lagRule = body.rules.find((r: ComplianceRule) => r.rule === "daemon-selfupdate-lag")!;
      expect(lagRule.last_self_update_at).not.toBeNull();
      expect(typeof lagRule.last_self_update_at).toBe("string");
    });

    it("overall_status is failing when selfupdate-lag rule is failing", async () => {
      // Empty store means lag rule is failing
      const { body } = await fetchJson(
        `http://127.0.0.1:${port}/api/compliance`,
      ) as { body: ComplianceResponse };

      expect(body.overall_status).toBe("failing");
    });

    it("returns 405 for non-GET requests", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/compliance`, { method: "POST" });
      expect(res.status).toBe(405);
    });
  });

  // ── buildSelfUpdateLagRule unit tests (issue #1597) ───────────────────────

  describe("buildSelfUpdateLagRule", () => {
    it("returns failing status when no self-update cycles exist", () => {
      const result = buildSelfUpdateLagRule(store);
      expect(result.rule).toBe("daemon-selfupdate-lag");
      expect(result.status).toBe("failing");
      expect(result.last_self_update_at).toBeNull();
      expect(typeof result.detail).toBe("string");
    });

    it("returns non-failing when a recent successful cycle exists (assuming <= 20 commits behind)", () => {
      // Record a successful cycle just now
      store.recordSelfUpdateCycle({ durationMs: 500, success: true, outcome: "up-to-date" });

      const result = buildSelfUpdateLagRule(store);
      expect(result.last_self_update_at).not.toBeNull();
      // Status may be ok or warning depending on commits_behind, but NOT failing due to age
      // (we just recorded the cycle, so cycleAgeHours is effectively 0)
      // Only way to be failing is if commits_behind > 20
      if (result.commits_behind !== null && result.commits_behind <= 20) {
        expect(result.status).toMatch(/^(ok|warning)$/);
      }
      // commits_behind > 20 or null — status could be failing, but that's a real signal
    });

    it("detail includes commits_behind and last self-update info", () => {
      store.recordSelfUpdateCycle({ durationMs: 500, success: true, outcome: "up-to-date" });
      const result = buildSelfUpdateLagRule(store);
      // Detail should mention commits or git error
      expect(result.detail).toMatch(/commit|could not determine/);
      // And should mention self-update timing
      expect(result.detail).toMatch(/self-update/);
    });

    it("ignores failed cycles when finding last_self_update_at", () => {
      // Record a failed cycle only
      store.recordSelfUpdateCycle({ durationMs: 500, success: false, outcome: "error: git fetch failed" });
      const result = buildSelfUpdateLagRule(store);
      // Failed cycles don't count — last_self_update_at should still be null
      expect(result.last_self_update_at).toBeNull();
      expect(result.status).toBe("failing");
    });
  });
});
