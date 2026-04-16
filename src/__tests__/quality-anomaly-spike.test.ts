import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  QualityAnomalySpikeDetector,
  formatQualityAnomalySpikeAlert,
} from "../reviewer/quality-anomalies.js";
import type { Notifier } from "../notify.js";

type RawDb = { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } };

function seedAnomaly(
  store: StateStore,
  id: string,
  agentName: string,
  score: number,
  status: "approved" | "rejected",
  timeOffset: string,
): void {
  const insert = (store as unknown as RawDb).db.prepare(`
    INSERT INTO tasks (
      id, title, description, status, agent_name, task_type, source, source_ref,
      result, verification_status, quality_score, verification_notes, created_at, updated_at
    ) VALUES (?, ?, ?, 'done', ?, 'implementation', ?, ?, ?, ?, ?, ?, datetime('now', ?), datetime('now', ?))
  `);

  insert.run(
    id,
    `task ${id}`,
    null,
    agentName,
    null,
    null,
    null,
    status,
    score,
    null,
    timeOffset,
    timeOffset,
  );
}

function makeNotifier() {
  return {
    isConfigured: () => true,
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as Notifier;
}

describe("QualityAnomalySpikeDetector", () => {
  it("sends one Telegram alert when 3 or more anomalies land in the rolling window", async () => {
    const store = new StateStore(":memory:");
    seedAnomaly(store, "A1", "agent-a", 0.58, "approved", "-45 minutes");
    seedAnomaly(store, "A2", "agent-a", 0.57, "approved", "-20 minutes");
    seedAnomaly(store, "B1", "agent-b", 0.87, "rejected", "-10 minutes");

    const notifier = makeNotifier();
    const detector = new QualityAnomalySpikeDetector(store, notifier, {
      windowMs: 60 * 60 * 1000,
      feedUrl: "https://dashboard.example.com/quality-anomalies",
    });

    const sent = await detector.checkAndAlert();

    expect(sent).toBe(true);
    expect(notifier.send).toHaveBeenCalledOnce();

    const [message] = (notifier.send as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(message).toContain("Quality anomaly spike detected");
    expect(message).toContain("3 anomalies");
    expect(message).toContain("agent-a");
    expect(message).toContain("agent-b");
    expect(message).toContain("quality anomaly feed");
    expect(message).toContain("https://dashboard.example.com/quality-anomalies");
  });

  it("ignores anomalies older than the rolling window", async () => {
    const store = new StateStore(":memory:");
    seedAnomaly(store, "OLD1", "agent-old", 0.58, "approved", "-2 hours");
    seedAnomaly(store, "OLD2", "agent-old", 0.59, "approved", "-90 minutes");
    seedAnomaly(store, "RECENT", "agent-new", 0.86, "rejected", "-15 minutes");

    const notifier = makeNotifier();
    const detector = new QualityAnomalySpikeDetector(store, notifier, {
      windowMs: 60 * 60 * 1000,
      feedUrl: "https://dashboard.example.com/quality-anomalies",
    });

    const sent = await detector.checkAndAlert();

    expect(sent).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("suppresses repeat alerts while the rolling window cooldown is active", async () => {
    const store = new StateStore(":memory:");
    seedAnomaly(store, "A1", "agent-a", 0.58, "approved", "-45 minutes");
    seedAnomaly(store, "A2", "agent-a", 0.57, "approved", "-20 minutes");
    seedAnomaly(store, "B1", "agent-b", 0.87, "rejected", "-10 minutes");

    const notifier = makeNotifier();
    const detector = new QualityAnomalySpikeDetector(store, notifier, {
      windowMs: 60 * 60 * 1000,
      feedUrl: "https://dashboard.example.com/quality-anomalies",
    });

    const now = Date.now();
    const first = await detector.checkAndAlert(now);
    const second = await detector.checkAndAlert(now + 10 * 60 * 1000);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it("does not alert when the threshold is not reached", async () => {
    const store = new StateStore(":memory:");
    seedAnomaly(store, "A1", "agent-a", 0.58, "approved", "-20 minutes");
    seedAnomaly(store, "A2", "agent-a", 0.57, "approved", "-10 minutes");

    const notifier = makeNotifier();
    const detector = new QualityAnomalySpikeDetector(store, notifier, {
      windowMs: 60 * 60 * 1000,
      feedUrl: "https://dashboard.example.com/quality-anomalies",
    });

    await expect(detector.checkAndAlert()).resolves.toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });
});

describe("formatQualityAnomalySpikeAlert", () => {
  it("renders the spike summary and feed link", () => {
    const message = formatQualityAnomalySpikeAlert(
      {
        generated_at: "2026-04-16T12:00:00.000Z",
        window_ms: 60 * 60 * 1000,
        threshold: 3,
        total: 4,
        anomalies: [],
        per_agent: [
          { agent_name: "agent-a", count: 3 },
          { agent_name: "agent-b", count: 1 },
        ],
      },
      "https://dashboard.example.com/quality-anomalies",
    );

    expect(message).toContain("Quality anomaly spike detected");
    expect(message).toContain("last 1 hour");
    expect(message).toContain("4 anomalies");
    expect(message).toContain("agent-a");
    expect(message).toContain("https://dashboard.example.com/quality-anomalies");
  });
});
