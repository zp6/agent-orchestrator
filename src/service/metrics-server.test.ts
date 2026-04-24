/**
 * Tests for the metrics HTTP server (issue #976).
 *
 * Verifies that:
 * - /health returns 200
 * - /dispatch-efficiency returns correct JSON shape
 * - Unknown routes return 404
 * - ?days query param is respected
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { StateStore } from "../state/store.js";
import { startMetricsServer } from "./metrics-server.js";
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
});
