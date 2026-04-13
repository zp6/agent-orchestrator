/**
 * Integration tests for StateStore.getStandupHealth() and
 * recordStandupSynthesisEvent().
 *
 * These tests use a real SQLite in-memory store so they verify the actual SQL
 * query behaviour — in particular the date-format fix from issue #118 (review
 * item: recorded_at uses 'YYYY-MM-DD HH:MM:SS' but the old code passed
 * toISOString() 'YYYY-MM-DDTHH:MM:SS.mmmZ' params, causing rows to be
 * silently excluded from the 24h window).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../state/store.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-standup-health-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  return { store, dir, dbPath };
}

describe("StateStore.getStandupHealth()", () => {
  let store: StateStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = makeStore());
  });

  afterEach(() => {
    (store as unknown as { db: { close(): void } }).db.close();
    try { rmSync(dir, { recursive: true }); } catch { /* best effort */ }
  });

  it("returns empty summary when no events recorded", () => {
    const health = store.getStandupHealth();
    expect(health.window_days).toBe(7);
    expect(health.points).toHaveLength(0);
    expect(health.fallback_count_24h).toBe(0);
    expect(health.should_escalate).toBe(false);
  });

  it("counts a just-recorded fallback event in fallback_count_24h", () => {
    // The core regression test: rows are stored via DEFAULT (datetime('now'))
    // which produces 'YYYY-MM-DD HH:MM:SS'. The old code queried with
    // toISOString() ('YYYY-MM-DDTHH:MM:SS.mmmZ').  SQLite compares strings
    // lexicographically; space (0x20) < 'T' (0x54), so stored rows always
    // tested LESS than the ISO param, silently excluding the same-day rows.
    store.recordStandupSynthesisEvent("rapartlu/test", 1, "synthesis-fallback", 0);

    const health = store.getStandupHealth(1);

    expect(health.fallback_count_24h).toBe(1);
  });

  it("sets should_escalate=true when fallback_count_24h > 2", () => {
    for (let i = 0; i < 3; i++) {
      store.recordStandupSynthesisEvent("rapartlu/test", i + 1, "synthesis-fallback", 0);
    }

    const health = store.getStandupHealth(1);

    expect(health.fallback_count_24h).toBe(3);
    expect(health.should_escalate).toBe(true);
  });

  it("does not set should_escalate when all events are synthesized", () => {
    for (let i = 0; i < 5; i++) {
      store.recordStandupSynthesisEvent("rapartlu/test", i + 1, "synthesized", 3);
    }

    const health = store.getStandupHealth(1);

    expect(health.fallback_count_24h).toBe(0);
    expect(health.should_escalate).toBe(false);
  });

  it("includes today's events in the daily points", () => {
    store.recordStandupSynthesisEvent("rapartlu/test", 1, "synthesized", 2);
    store.recordStandupSynthesisEvent("rapartlu/test", 2, "synthesis-fallback", 0);

    const health = store.getStandupHealth(7);

    expect(health.points).toHaveLength(1);
    expect(health.points[0].total).toBe(2);
    expect(health.points[0].synthesized).toBe(1);
    expect(health.points[0].fallback).toBe(1);
    expect(health.points[0].success_rate).toBe(0.5);
  });

  it("counts empty-retry label as fallback, not synthesized", () => {
    store.recordStandupSynthesisEvent("rapartlu/test", 1, "empty-retry", 0);

    const health = store.getStandupHealth(1);

    expect(health.fallback_count_24h).toBe(1);
    expect(health.points[0].fallback).toBe(1);
    expect(health.points[0].synthesized).toBe(0);
  });

  it("returns success_rate=null for days with zero events (not a divide-by-zero)", () => {
    // When there are no events the points array is empty — success_rate on
    // an actual point is only null if total is 0 (can't happen in practice since
    // points only appear when there are rows, but check the mapping logic anyway).
    store.recordStandupSynthesisEvent("rapartlu/test", 1, "synthesized", 1);
    const health = store.getStandupHealth(7);
    // All points should have a non-null success_rate since total > 0
    for (const pt of health.points) {
      if (pt.total === 0) {
        expect(pt.success_rate).toBeNull();
      } else {
        expect(pt.success_rate).not.toBeNull();
      }
    }
  });
});
