/**
 * Unit tests for the in-flight dispatch reservation mechanism (issue #927).
 *
 * The in-flight reservation is a write-ahead DB record created the moment an
 * issue claim is acquired — before the agent even starts work. It prevents
 * duplicate dispatch during the 5–25 minute window between claim acquisition
 * and PR creation, which the 10-minute dispatch_lock TTL does not fully cover.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("StateStore — in-flight reservations (issue #927)", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-test-ifr-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
  });

  // ── addInFlightReservation ───────────────────────────────────────────────

  describe("addInFlightReservation", () => {
    it("creates a reservation that getInFlightReservation can retrieve", () => {
      store.addInFlightReservation("github", "owner/repo#42", "agent-a");
      const r = store.getInFlightReservation("github", "owner/repo#42");
      expect(r).toBeDefined();
      expect(r!.source).toBe("github");
      expect(r!.source_ref).toBe("owner/repo#42");
      expect(r!.agent_name).toBe("agent-a");
      expect(r!.task_id).toBeNull();
    });

    it("sets expires_at to approximately now + ttlMs", () => {
      const ttl = 60_000; // 1 minute
      const before = Date.now();
      store.addInFlightReservation("github", "owner/repo#42", "agent-a", ttl);
      const after = Date.now();
      const r = store.getInFlightReservation("github", "owner/repo#42");
      const expiresMs = new Date(r!.expires_at).getTime();
      expect(expiresMs).toBeGreaterThanOrEqual(before + ttl - 50);
      expect(expiresMs).toBeLessThanOrEqual(after + ttl + 50);
    });

    it("defaults ttl to IN_FLIGHT_RESERVATION_TTL_MS (20 minutes)", () => {
      const before = Date.now();
      store.addInFlightReservation("github", "owner/repo#42", "agent-a");
      const r = store.getInFlightReservation("github", "owner/repo#42");
      const expiresMs = new Date(r!.expires_at).getTime();
      const expectedMs = StateStore.IN_FLIGHT_RESERVATION_TTL_MS;
      expect(expiresMs).toBeGreaterThanOrEqual(before + expectedMs - 100);
    });

    it("replaces an existing reservation with a refreshed one (INSERT OR REPLACE)", () => {
      store.addInFlightReservation("github", "owner/repo#42", "agent-a", 60_000);
      store.addInFlightReservation("github", "owner/repo#42", "agent-b", 120_000);
      const r = store.getInFlightReservation("github", "owner/repo#42");
      // Should be the newer reservation (agent-b with longer TTL)
      expect(r!.agent_name).toBe("agent-b");
    });

    it("stores reservations independently per (source, source_ref)", () => {
      store.addInFlightReservation("github", "repo-a#1", "agent-a");
      store.addInFlightReservation("github", "repo-b#2", "agent-b");
      expect(store.getInFlightReservation("github", "repo-a#1")!.agent_name).toBe("agent-a");
      expect(store.getInFlightReservation("github", "repo-b#2")!.agent_name).toBe("agent-b");
    });
  });

  // ── getInFlightReservation ───────────────────────────────────────────────

  describe("getInFlightReservation", () => {
    it("returns undefined when no reservation exists", () => {
      const r = store.getInFlightReservation("github", "owner/repo#99");
      expect(r).toBeUndefined();
    });

    it("returns undefined for an expired reservation", () => {
      // Write a reservation that expired 1 ms in the past
      store.addInFlightReservation("github", "owner/repo#42", "agent-a", -1);
      const r = store.getInFlightReservation("github", "owner/repo#42");
      expect(r).toBeUndefined();
    });

    it("returns the reservation for a source with no reservation even when another exists", () => {
      store.addInFlightReservation("github", "repo-a#1", "agent-a");
      expect(store.getInFlightReservation("github", "repo-b#999")).toBeUndefined();
    });
  });

  // ── updateInFlightReservationTaskId ─────────────────────────────────────

  describe("updateInFlightReservationTaskId", () => {
    it("sets the task_id field after task creation", () => {
      store.addInFlightReservation("github", "owner/repo#42", "agent-a");
      store.updateInFlightReservationTaskId("github", "owner/repo#42", "task-001");
      const r = store.getInFlightReservation("github", "owner/repo#42");
      expect(r!.task_id).toBe("task-001");
    });

    it("is a no-op when no reservation exists for the sourceRef", () => {
      // Should not throw
      expect(() =>
        store.updateInFlightReservationTaskId("github", "owner/repo#999", "task-xyz"),
      ).not.toThrow();
    });
  });

  // ── removeInFlightReservation ────────────────────────────────────────────

  describe("removeInFlightReservation", () => {
    it("deletes the reservation so getInFlightReservation returns undefined", () => {
      store.addInFlightReservation("github", "owner/repo#42", "agent-a");
      store.removeInFlightReservation("github", "owner/repo#42");
      expect(store.getInFlightReservation("github", "owner/repo#42")).toBeUndefined();
    });

    it("is a no-op when no reservation exists (does not throw)", () => {
      expect(() =>
        store.removeInFlightReservation("github", "owner/repo#999"),
      ).not.toThrow();
    });

    it("only removes the specified sourceRef, leaving others intact", () => {
      store.addInFlightReservation("github", "repo-a#1", "agent-a");
      store.addInFlightReservation("github", "repo-b#2", "agent-b");
      store.removeInFlightReservation("github", "repo-a#1");
      expect(store.getInFlightReservation("github", "repo-a#1")).toBeUndefined();
      expect(store.getInFlightReservation("github", "repo-b#2")).toBeDefined();
    });
  });

  // ── cleanExpiredInFlightReservations ─────────────────────────────────────

  describe("cleanExpiredInFlightReservations", () => {
    it("returns 0 when no expired reservations exist", () => {
      store.addInFlightReservation("github", "owner/repo#1", "agent-a", 60_000);
      expect(store.cleanExpiredInFlightReservations()).toBe(0);
    });

    it("deletes expired reservations and returns count", () => {
      store.addInFlightReservation("github", "repo#1", "agent-a", -1); // expired
      store.addInFlightReservation("github", "repo#2", "agent-b", -1); // expired
      store.addInFlightReservation("github", "repo#3", "agent-c", 60_000); // active
      const cleaned = store.cleanExpiredInFlightReservations();
      expect(cleaned).toBe(2);
      expect(store.getInFlightReservation("github", "repo#3")).toBeDefined();
    });

    it("does not delete active reservations", () => {
      store.addInFlightReservation("github", "owner/repo#42", "agent-a", 60_000);
      store.cleanExpiredInFlightReservations();
      expect(store.getInFlightReservation("github", "owner/repo#42")).toBeDefined();
    });
  });

  // ── listActiveInFlightReservations ───────────────────────────────────────

  describe("listActiveInFlightReservations", () => {
    it("returns empty array when no active reservations exist", () => {
      expect(store.listActiveInFlightReservations()).toEqual([]);
    });

    it("returns all active reservations, excluding expired ones", () => {
      store.addInFlightReservation("github", "repo#1", "agent-a", 60_000);
      store.addInFlightReservation("github", "repo#2", "agent-b", 60_000);
      store.addInFlightReservation("github", "repo#3", "agent-c", -1); // expired
      const active = store.listActiveInFlightReservations();
      expect(active).toHaveLength(2);
      const refs = active.map((r) => r.source_ref);
      expect(refs).toContain("repo#1");
      expect(refs).toContain("repo#2");
      expect(refs).not.toContain("repo#3");
    });
  });

  // ── IN_FLIGHT_RESERVATION_TTL_MS constant ────────────────────────────────

  describe("IN_FLIGHT_RESERVATION_TTL_MS", () => {
    it("is 20 minutes (1200000 ms)", () => {
      expect(StateStore.IN_FLIGHT_RESERVATION_TTL_MS).toBe(1_200_000);
    });
  });

  // ── Interaction with dispatch_locks ──────────────────────────────────────
  // Verify that reservations and dispatch_locks are independent mechanisms.

  describe("reservation independence from dispatch_locks", () => {
    it("reservations persist after releasing dispatch lock", () => {
      store.addInFlightReservation("github", "repo#1", "agent-a");
      store.acquireDispatchLock("github", "repo#1", "agent-a");
      store.releaseDispatchLock("github", "repo#1");
      // Reservation should still be active
      expect(store.getInFlightReservation("github", "repo#1")).toBeDefined();
    });

    it("can have a reservation without a dispatch_lock (and vice versa)", () => {
      store.addInFlightReservation("github", "repo#1", "agent-a");
      expect(store.getDispatchLock("github", "repo#1")).toBeUndefined();
      expect(store.getInFlightReservation("github", "repo#1")).toBeDefined();
    });
  });
});
