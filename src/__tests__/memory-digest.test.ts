/**
 * Tests for Semantic Task Memory daily digest (issue #369).
 *
 * Covers:
 *  1. recordMemoryEntry() — inserts and upserts entries correctly
 *  2. getTopMemoryTopics() — returns top topics by query count in window
 *  3. getRepeatedAttemptTopics() — surfaces topics with 2+ entries
 *  4. getLowConfidenceTopics() — surfaces topics where ALL scores < threshold
 *  5. expandMemoryTopic() — exact match + FTS5 fallback
 *  6. buildMemoryDigest() — wires all three sections
 *  7. formatMemoryDigest() — renders expected Markdown structure
 *  8. MemoryDigestScheduler.maybeFireDigest() — fires once per day, respects hour
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  buildMemoryDigest,
  formatMemoryDigest,
  MemoryDigestScheduler,
  LOW_CONFIDENCE_THRESHOLD,
  DIGEST_LOOKBACK_DAYS,
} from "../reviewer/memory-digest.js";
import type { Notifier } from "../notify.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-mem-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  return { store, dir };
}

/**
 * Insert a minimal tasks row so FK constraints on semantic_task_memory
 * are satisfied (issue #366).  Uses INSERT OR IGNORE so repeated calls with
 * the same taskId are safe.
 */
function ensureTaskExists(
  store: StateStore,
  taskId: string,
): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
  db.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, title, status, task_type, created_at, updated_at)
     VALUES (?, ?, 'done', 'implementation', datetime('now'), datetime('now'))`,
  ).run(taskId, `Task ${taskId}`);
}

/**
 * Wrapper around store.recordMemoryEntry that first ensures the parent
 * tasks row exists (issue #366 FK enforcement).
 */
function recordEntry(
  store: StateStore,
  topic: string,
  taskId: string,
  confidence: number,
  outcome: "success" | "failure" | "partial",
): void {
  ensureTaskExists(store, taskId);
  store.recordMemoryEntry(topic, taskId, confidence, outcome);
}

function makeNotifierSpy(): { notifier: Notifier; sends: string[] } {
  const sends: string[] = [];
  const notifier: Notifier = {
    isConfigured: () => true,
    async send(text) { sends.push(text); },
    async escalation() {},
    async taskRejected() {},
    async supervisorDecision() {},
    async healthRecovery() {},
    async notifyOperator() { return true; },
    async memoryDigest() { sends.push("digest-called"); },
  };
  return { notifier, sends };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("StateStore semantic memory", () => {
  let store: StateStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = makeTempStore());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("recordMemoryEntry", () => {
    it("inserts a new entry", () => {
      recordEntry(store, "authentication", "task-001", 0.85, "success");
      const entries = store.expandMemoryTopic("authentication");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.topic).toBe("authentication");
      expect(entries[0]?.task_id).toBe("task-001");
      expect(entries[0]?.confidence).toBe(0.85);
      expect(entries[0]?.outcome).toBe("success");
    });

    it("upserts when (topic, task_id) already exists", () => {
      recordEntry(store, "authentication", "task-001", 0.50, "failure");
      recordEntry(store, "authentication", "task-001", 0.90, "success");
      const entries = store.expandMemoryTopic("authentication");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.confidence).toBe(0.90);
      expect(entries[0]?.outcome).toBe("success");
    });

    it("normalises topic to lowercase", () => {
      recordEntry(store, "  Authentication  ", "task-001", 0.75, "partial");
      const entries = store.expandMemoryTopic("authentication");
      expect(entries).toHaveLength(1);
    });

    it("allows same topic with different task IDs", () => {
      recordEntry(store, "auth", "task-001", 0.80, "success");
      recordEntry(store, "auth", "task-002", 0.60, "failure");
      const entries = store.expandMemoryTopic("auth");
      expect(entries).toHaveLength(2);
    });
  });

  describe("getTopMemoryTopics", () => {
    it("returns topics ordered by query count descending", () => {
      // Topic A: 3 entries
      recordEntry(store, "topic-a", "t1", 0.80, "success");
      recordEntry(store, "topic-a", "t2", 0.70, "success");
      recordEntry(store, "topic-a", "t3", 0.90, "success");
      // Topic B: 1 entry
      recordEntry(store, "topic-b", "t4", 0.60, "failure");

      const since = new Date(Date.now() - 24 * 3600_000).toISOString();
      const topics = store.getTopMemoryTopics(5, since);
      expect(topics[0]?.topic).toBe("topic-a");
      expect(topics[0]?.query_count).toBe(3);
      expect(topics[1]?.topic).toBe("topic-b");
    });

    it("filters by sinceIso window", () => {
      recordEntry(store, "old-topic", "t1", 0.80, "success");
      // sinceIso = far future → nothing qualifies
      const future = new Date(Date.now() + 10 * 3600_000).toISOString();
      const topics = store.getTopMemoryTopics(5, future);
      expect(topics).toHaveLength(0);
    });

    it("includes example_task_ids (up to 5)", () => {
      for (let i = 0; i < 7; i++) {
        recordEntry(store, "big-topic", `task-${i}`, 0.75, "partial");
      }
      const since = new Date(Date.now() - 3600_000).toISOString();
      const topics = store.getTopMemoryTopics(1, since);
      expect(topics[0]?.example_task_ids.length).toBeLessThanOrEqual(5);
    });
  });

  describe("getRepeatedAttemptTopics", () => {
    it("returns topics with 2+ entries", () => {
      recordEntry(store, "repeated", "t1", 0.50, "failure");
      recordEntry(store, "repeated", "t2", 0.65, "partial");
      recordEntry(store, "single", "t3", 0.90, "success");

      const topics = store.getRepeatedAttemptTopics(5);
      expect(topics.map((t) => t.topic)).toContain("repeated");
      expect(topics.map((t) => t.topic)).not.toContain("single");
    });

    it("records best_score as the maximum confidence", () => {
      recordEntry(store, "rep", "t1", 0.40, "failure");
      recordEntry(store, "rep", "t2", 0.68, "partial");
      const topics = store.getRepeatedAttemptTopics(1);
      expect(topics[0]?.best_score).toBeCloseTo(0.68, 2);
    });

    it("orders by attempt_count descending", () => {
      recordEntry(store, "two-attempts", "t1", 0.50, "failure");
      recordEntry(store, "two-attempts", "t2", 0.55, "failure");
      recordEntry(store, "three-attempts", "ta", 0.40, "failure");
      recordEntry(store, "three-attempts", "tb", 0.45, "failure");
      recordEntry(store, "three-attempts", "tc", 0.50, "failure");

      const topics = store.getRepeatedAttemptTopics(5);
      expect(topics[0]?.topic).toBe("three-attempts");
      expect(topics[0]?.attempt_count).toBe(3);
    });
  });

  describe("getLowConfidenceTopics", () => {
    it("returns topics where all entries are below threshold", () => {
      recordEntry(store, "low-conf", "t1", 0.40, "failure");
      recordEntry(store, "low-conf", "t2", 0.55, "partial");
      recordEntry(store, "high-conf", "t3", 0.90, "success");

      const topics = store.getLowConfidenceTopics(LOW_CONFIDENCE_THRESHOLD, 5);
      expect(topics.map((t) => t.topic)).toContain("low-conf");
      expect(topics.map((t) => t.topic)).not.toContain("high-conf");
    });

    it("excludes topics where even ONE entry meets the threshold", () => {
      recordEntry(store, "mixed", "t1", 0.40, "failure");
      recordEntry(store, "mixed", "t2", 0.80, "success"); // above threshold

      const topics = store.getLowConfidenceTopics(LOW_CONFIDENCE_THRESHOLD, 5);
      expect(topics.map((t) => t.topic)).not.toContain("mixed");
    });

    it("orders worst-first (lowest max_score first)", () => {
      recordEntry(store, "very-bad", "t1", 0.20, "failure");
      recordEntry(store, "bad", "t2", 0.60, "failure");

      const topics = store.getLowConfidenceTopics(LOW_CONFIDENCE_THRESHOLD, 5);
      expect(topics[0]?.topic).toBe("very-bad");
    });
  });

  describe("expandMemoryTopic", () => {
    it("returns exact match entries ordered by recorded_at DESC", () => {
      recordEntry(store, "deploy", "t1", 0.70, "partial");
      recordEntry(store, "deploy", "t2", 0.85, "success");

      const entries = store.expandMemoryTopic("deploy");
      expect(entries.length).toBe(2);
      // Both should be returned (order by recorded_at DESC — t2 inserted last)
      expect(entries.map((e) => e.task_id)).toContain("t1");
      expect(entries.map((e) => e.task_id)).toContain("t2");
    });

    it("returns empty array for unknown topic", () => {
      const entries = store.expandMemoryTopic("completely-unknown-topic-xyz");
      expect(entries).toHaveLength(0);
    });

    it("handles FTS5 fallback for partial topic match", () => {
      recordEntry(store, "database migration", "t1", 0.75, "success");

      // Exact match on sub-word
      const entries = store.expandMemoryTopic("database migration");
      expect(entries).toHaveLength(1);
    });
  });
});

// ── buildMemoryDigest ─────────────────────────────────────────────────────────

describe("buildMemoryDigest", () => {
  let store: StateStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = makeTempStore());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a report with all three sections", () => {
    // Top queried: add one topic with multiple entries
    recordEntry(store, "auth", "t1", 0.85, "success");
    recordEntry(store, "auth", "t2", 0.78, "success");

    // Repeated: already covered by auth (2+ entries)

    // Low confidence: below threshold
    recordEntry(store, "flaky-feature", "t3", 0.40, "failure");
    recordEntry(store, "flaky-feature", "t4", 0.55, "failure");

    const report = buildMemoryDigest(store);

    expect(report.generated_at).toBeTruthy();
    expect(report.top_queried_topics.length).toBeGreaterThan(0);
    expect(report.repeated_attempt_topics.length).toBeGreaterThan(0);
    expect(report.low_confidence_topics.length).toBeGreaterThan(0);
    expect(report.low_confidence_topics[0]?.topic).toBe("flaky-feature");
  });

  it("returns empty sections when no memory entries exist", () => {
    const report = buildMemoryDigest(store);
    expect(report.top_queried_topics).toHaveLength(0);
    expect(report.repeated_attempt_topics).toHaveLength(0);
    expect(report.low_confidence_topics).toHaveLength(0);
  });
});

// ── formatMemoryDigest ────────────────────────────────────────────────────────

describe("formatMemoryDigest", () => {
  it("includes all three section headers", () => {
    const report = {
      generated_at: new Date().toISOString(),
      top_queried_topics: [
        { topic: "auth", query_count: 3, avg_confidence: 0.82, example_task_ids: ["task-abc"] },
      ],
      repeated_attempt_topics: [
        { topic: "deploy", attempt_count: 2, best_score: 0.65, task_ids: ["task-xyz"] },
      ],
      low_confidence_topics: [
        { topic: "flaky", attempt_count: 1, max_score: 0.45, task_ids: ["task-def"] },
      ],
    };

    const msg = formatMemoryDigest(report);
    expect(msg).toContain("Semantic Task Memory");
    expect(msg).toContain("Top Queried Topics");
    expect(msg).toContain("Re-attempted Topics");
    expect(msg).toContain("Persistent Low-Confidence");
    expect(msg).toContain("auth");
    expect(msg).toContain("deploy");
    expect(msg).toContain("flaky");
    expect(msg).toContain("/memory expand");
  });

  it("shows empty-state messages when sections are empty", () => {
    const report = {
      generated_at: new Date().toISOString(),
      top_queried_topics: [],
      repeated_attempt_topics: [],
      low_confidence_topics: [],
    };

    const msg = formatMemoryDigest(report);
    expect(msg).toContain("No queried topics");
    expect(msg).toContain("No topics with repeated attempts");
    expect(msg).toContain("No persistent low-confidence areas");
  });
});

// ── MemoryDigestScheduler ─────────────────────────────────────────────────────

describe("MemoryDigestScheduler", () => {
  let store: StateStore;
  let dir: string;
  let notifier: Notifier;
  let sends: string[];

  beforeEach(() => {
    ({ store, dir } = makeTempStore());
    ({ notifier, sends } = makeNotifierSpy());
    vi.useFakeTimers();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("fires when current UTC hour matches digestHourUtc", async () => {
    // Set current time to 09:00 UTC
    vi.setSystemTime(new Date("2025-06-15T09:30:00Z"));

    const scheduler = new MemoryDigestScheduler(store, notifier, { digestHourUtc: 9 });
    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(true);
    expect(sends.length).toBe(1);
  });

  it("does not fire when current UTC hour does not match", async () => {
    // Set current time to 15:00 UTC (wrong hour)
    vi.setSystemTime(new Date("2025-06-15T15:00:00Z"));

    const scheduler = new MemoryDigestScheduler(store, notifier, { digestHourUtc: 9 });
    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it("does not fire twice on the same calendar day", async () => {
    vi.setSystemTime(new Date("2025-06-15T09:00:00Z"));

    const scheduler = new MemoryDigestScheduler(store, notifier, { digestHourUtc: 9 });

    const first = await scheduler.maybeFireDigest();
    expect(first).toBe(true);
    // NOISE SUPPRESSION (#564): Memory digests no longer send to Telegram
    // Verify state change (system flag set) instead of send call
    const flagAfterFirst = store.getSystemFlag("last_memory_digest_sent");
    expect(flagAfterFirst).toBeDefined();

    // Advance clock 30 min (still 09:xx)
    vi.advanceTimersByTime(30 * 60 * 1000);
    const second = await scheduler.maybeFireDigest();
    expect(second).toBe(false);
  });

  it("fires again the next day", async () => {
    vi.setSystemTime(new Date("2025-06-15T09:00:00Z"));
    const scheduler = new MemoryDigestScheduler(store, notifier, { digestHourUtc: 9 });

    const first = await scheduler.maybeFireDigest();
    expect(first).toBe(true);
    // NOISE SUPPRESSION (#564): Memory digests no longer send to Telegram
    // Verify state change (system flag set for first day)
    const flagDay1 = store.getSystemFlag("last_memory_digest_sent");
    expect(flagDay1).toBe("2025-06-15");

    // Advance to next day 09:00 UTC
    vi.setSystemTime(new Date("2025-06-16T09:00:00Z"));
    const second = await scheduler.maybeFireDigest();
    expect(second).toBe(true);
    // Verify state changed to second day
    const flagDay2 = store.getSystemFlag("last_memory_digest_sent");
    expect(flagDay2).toBe("2025-06-16");
  });

  it("persists the last-sent date in system_flags", async () => {
    vi.setSystemTime(new Date("2025-06-15T09:00:00Z"));
    const scheduler = new MemoryDigestScheduler(store, notifier, { digestHourUtc: 9 });

    await scheduler.maybeFireDigest();

    const flag = store.getSystemFlag("semantic_memory_digest_last_sent");
    expect(flag).toBe("2025-06-15");
  });

  it("uses digestHourUtc=9 by default", async () => {
    vi.setSystemTime(new Date("2025-06-15T09:00:00Z"));
    const scheduler = new MemoryDigestScheduler(store, notifier);
    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(true);
  });
});
