/**
 * Tests for PR guard cooldown lock (issue #1095).
 *
 * Verifies that:
 * - tryAcquirePRGuardLock() is idempotent: only the first caller within the TTL succeeds
 * - INSERT OR IGNORE semantics prevent duplicate task creation even across concurrent reads
 * - Expired locks can be re-acquired after the TTL elapses
 * - Independent source refs each get their own lock slot
 * - recordPRGuardDuplicateAttempt() and getRecentPRGuardDuplicates() correctly track
 *   suppressed attempts for the 24h Telegram digest (AC #2)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("PR Guard Cooldown Lock (issue #1095)", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-pr-guard-lock-test-${randomUUID()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch {}
    }
  });

  // ── tryAcquirePRGuardLock ─────────────────────────────────────────────────

  describe("tryAcquirePRGuardLock", () => {
    it("returns true on first acquisition for a source_ref", () => {
      const result = store.tryAcquirePRGuardLock(
        "rapartlu/research-agent#133",
        3_600_000,
      );
      expect(result).toBe(true);
    });

    it("returns false on second acquisition for the same source_ref within TTL", () => {
      const ref = "rapartlu/research-agent#140";
      store.tryAcquirePRGuardLock(ref, 3_600_000);
      // Second call — lock already held
      const second = store.tryAcquirePRGuardLock(ref, 3_600_000);
      expect(second).toBe(false);
    });

    it("prevents duplicate task creation: same issue hitting guard twice gets exactly one lock", () => {
      const ref = "rapartlu/research-agent#150";
      const results: boolean[] = [];
      // Simulate two workers racing to acquire the lock
      results.push(store.tryAcquirePRGuardLock(ref, 3_600_000));
      results.push(store.tryAcquirePRGuardLock(ref, 3_600_000));
      results.push(store.tryAcquirePRGuardLock(ref, 3_600_000));

      const successes = results.filter(Boolean).length;
      expect(successes).toBe(1); // exactly one caller succeeds
      expect(results.filter((r) => !r).length).toBe(2); // remaining two are suppressed
    });

    it("returns true for different source_refs independently", () => {
      const a = store.tryAcquirePRGuardLock("rapartlu/research-agent#161", 3_600_000);
      const b = store.tryAcquirePRGuardLock("rapartlu/research-agent#162", 3_600_000);
      expect(a).toBe(true);
      expect(b).toBe(true);
    });

    it("lock for source_ref A does not block source_ref B", () => {
      store.tryAcquirePRGuardLock("rapartlu/research-agent#200", 3_600_000);
      const other = store.tryAcquirePRGuardLock("rapartlu/research-agent#201", 3_600_000);
      expect(other).toBe(true);
    });

    it("allows re-acquisition after the TTL expires", () => {
      const ref = "rapartlu/research-agent#133";
      // Acquire with a 1ms TTL (immediately expired on next call)
      store.tryAcquirePRGuardLock(ref, 1);
      // Wait a moment so the lock definitely expires
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait 5 ms */ }
      // Should succeed: the expired lock is evicted before the INSERT
      const reacquired = store.tryAcquirePRGuardLock(ref, 3_600_000);
      expect(reacquired).toBe(true);
    });

    it("does not throw when called without optional windowMs argument", () => {
      expect(() => store.tryAcquirePRGuardLock("rapartlu/agent-orchestrator#1095")).not.toThrow();
    });
  });

  // ── recordPRGuardDuplicateAttempt / getRecentPRGuardDuplicates ───────────

  describe("duplicate attempt tracking (AC #2)", () => {
    it("records a duplicate attempt without throwing", () => {
      expect(() =>
        store.recordPRGuardDuplicateAttempt("rapartlu/research-agent#133", 42),
      ).not.toThrow();
    });

    it("records duplicate attempt without blockingPRNumber", () => {
      expect(() =>
        store.recordPRGuardDuplicateAttempt("rapartlu/research-agent#133"),
      ).not.toThrow();
    });

    it("getRecentPRGuardDuplicates returns empty when no attempts recorded", () => {
      const result = store.getRecentPRGuardDuplicates(86_400_000);
      expect(result).toEqual([]);
    });

    it("returns aggregated counts per source_ref sorted descending", () => {
      const refA = "rapartlu/research-agent#133";
      const refB = "rapartlu/research-agent#140";

      store.recordPRGuardDuplicateAttempt(refA, 42);
      store.recordPRGuardDuplicateAttempt(refA, 42);
      store.recordPRGuardDuplicateAttempt(refA, 42); // 3× for A
      store.recordPRGuardDuplicateAttempt(refB, 43); // 1× for B

      const results = store.getRecentPRGuardDuplicates(86_400_000);
      expect(results.length).toBe(2);
      expect(results[0].source_ref).toBe(refA);
      expect(results[0].count).toBe(3);
      expect(results[1].source_ref).toBe(refB);
      expect(results[1].count).toBe(1);
    });

    it("returns records within a large window and finds recent attempts", () => {
      const ref = "rapartlu/research-agent#161";
      store.recordPRGuardDuplicateAttempt(ref, 99);

      // A 24h window should always include a just-inserted record
      const resultWide = store.getRecentPRGuardDuplicates(86_400_000);
      expect(resultWide.length).toBe(1);
      expect(resultWide[0].source_ref).toBe(ref);
      expect(resultWide[0].count).toBe(1);
    });
  });
});
