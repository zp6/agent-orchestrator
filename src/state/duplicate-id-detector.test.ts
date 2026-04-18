/**
 * Tests for DuplicateIdDetector (issue #935)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { DuplicateIdDetector } from "./duplicate-id-detector.js";

// Silence logger noise in tests
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock notifyOperator so tests don't need Telegram credentials
vi.mock("../service/notify.js", () => ({
  notifyOperator: vi.fn().mockResolvedValue(undefined),
}));

import { notifyOperator } from "../service/notify.js";

describe("DuplicateIdDetector", () => {
  let detector: DuplicateIdDetector;

  beforeEach(() => {
    detector = new DuplicateIdDetector();
    vi.clearAllMocks();
  });

  // ── startCycle ─────────────────────────────────────────────────────────────

  describe("startCycle()", () => {
    it("clears IDs from the previous cycle", async () => {
      await detector.recordId("id-1", "Task One");
      detector.startCycle();
      // After cycle reset, recording the same ID should NOT be a collision
      const ok = await detector.recordId("id-1", "Task One Again");
      expect(ok).toBe(true);
    });
  });

  // ── recordId ──────────────────────────────────────────────────────────────

  describe("recordId()", () => {
    it("returns true for a fresh ID", async () => {
      const result = await detector.recordId("id-abc", "My Task");
      expect(result).toBe(true);
    });

    it("returns false when the same ID is recorded twice in a cycle", async () => {
      await detector.recordId("id-dup", "First Task");
      const result = await detector.recordId("id-dup", "Second Task");
      expect(result).toBe(false);
    });

    it("does NOT treat the same ID in separate cycles as a collision", async () => {
      await detector.recordId("id-x", "Task X");
      detector.startCycle();
      const result = await detector.recordId("id-x", "Task X v2");
      expect(result).toBe(true);
    });

    it("fires Telegram alert on collision", async () => {
      await detector.recordId("id-coll", "First");
      await detector.recordId("id-coll", "Second");

      expect(notifyOperator).toHaveBeenCalledOnce();
      const [title] = (notifyOperator as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(title).toContain("Duplicate Task ID");
    });
  });

  // ── handleCollision ────────────────────────────────────────────────────────

  describe("handleCollision()", () => {
    it("increments totalCollisions", async () => {
      expect(detector.getTotalCollisions()).toBe(0);
      await detector.handleCollision("id-z", "Alpha", "Beta");
      expect(detector.getTotalCollisions()).toBe(1);
      await detector.handleCollision("id-y", "Gamma", "Delta");
      expect(detector.getTotalCollisions()).toBe(2);
    });

    it("records an incident with correct fields", async () => {
      await detector.handleCollision("id-q", "First Title", "Second Title");
      const incidents = detector.getIncidents();
      expect(incidents).toHaveLength(1);
      expect(incidents[0].id).toBe("id-q");
      expect(incidents[0].firstTitle).toBe("First Title");
      expect(incidents[0].secondTitle).toBe("Second Title");
      expect(incidents[0].detectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("caps incident list at 100 entries (memory safety)", async () => {
      for (let i = 0; i < 110; i++) {
        await detector.handleCollision(`id-${i}`, `First ${i}`, `Second ${i}`);
      }
      expect(detector.getIncidents().length).toBe(100);
    });

    it("persists incident to the store when one is attached", async () => {
      const mockStore = {
        recordDuplicateIdIncident: vi.fn(),
      } as unknown as Parameters<DuplicateIdDetector["attachStore"]>[0];

      detector.attachStore(mockStore as never);
      await detector.handleCollision("id-p", "Store First", "Store Second");

      expect(mockStore.recordDuplicateIdIncident).toHaveBeenCalledOnce();
      expect(mockStore.recordDuplicateIdIncident).toHaveBeenCalledWith({
        taskId: "id-p",
        firstTitle: "Store First",
        secondTitle: "Store Second",
      });
    });

    it("does not throw if store.recordDuplicateIdIncident throws", async () => {
      const mockStore = {
        recordDuplicateIdIncident: vi.fn().mockImplementation(() => {
          throw new Error("DB error");
        }),
      } as unknown as Parameters<DuplicateIdDetector["attachStore"]>[0];

      detector.attachStore(mockStore as never);
      // Should not throw even when the store fails
      await expect(detector.handleCollision("id-err", "A", "B")).resolves.not.toThrow();
    });
  });

  // ── getFlaggedIds ──────────────────────────────────────────────────────────

  describe("getFlaggedIds()", () => {
    it("returns an empty set when no collisions have occurred", () => {
      expect(detector.getFlaggedIds().size).toBe(0);
    });

    it("includes all IDs that had a collision", async () => {
      await detector.handleCollision("id-1", "A", "B");
      await detector.handleCollision("id-2", "C", "D");
      const flagged = detector.getFlaggedIds();
      expect(flagged.has("id-1")).toBe(true);
      expect(flagged.has("id-2")).toBe(true);
    });

    it("does not include IDs that were only recorded once", async () => {
      await detector.recordId("id-clean", "Clean Task");
      expect(detector.getFlaggedIds().has("id-clean")).toBe(false);
    });
  });

  // ── getIncidents ───────────────────────────────────────────────────────────

  describe("getIncidents()", () => {
    it("returns incidents in reverse chronological order (most recent first)", async () => {
      await detector.handleCollision("id-early", "E1", "E2");
      await detector.handleCollision("id-late", "L1", "L2");
      const incidents = detector.getIncidents();
      expect(incidents[0].id).toBe("id-late");
      expect(incidents[1].id).toBe("id-early");
    });
  });
});
