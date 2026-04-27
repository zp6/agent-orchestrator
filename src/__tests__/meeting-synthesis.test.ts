import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import { MeetingIntakeClient, MeetingSynthesisReconciler, buildMeetingSynthesisAlertMessage } from "../reviewer/meeting-synthesis.js";
import type { MeetingOutcome } from "../reviewer/meeting-outcome-client.js";
import type { MeetingOutcomeLookup } from "../reviewer/meeting-synthesis.js";
import type { Notifier } from "../notify.js";

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "meeting-synthesis-"));
  const store = new StateStore(join(dir, "state.db"));
  return { dir, store };
}

function makeOutcome(overrides: Partial<MeetingOutcome> = {}): MeetingOutcome {
  return {
    meeting_id: "mtg-01ABC",
    topic: "Weekly planning",
    status: "complete",
    priority_ranking: [],
    sequencing_constraints: [],
    follow_up_recommended: false,
    follow_up_rationale: null,
    decisions: ["Proceed with implementation"],
    action_items: ["Ship the pending fix"],
    verifier_score: 91,
    decided_at: "2026-04-25T12:00:00.000Z",
    created_at: "2026-04-25T11:50:00.000Z",
    updated_at: "2026-04-25T12:00:00.000Z",
    ...overrides,
  };
}

describe("meeting synthesis persistence", () => {
  let dir: string;
  let store: StateStore;

  beforeEach(() => {
    ({ dir, store } = makeStore());
  });

  afterEach(() => {
    (store as unknown as { db: { close(): void } }).db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("persists and resolves pending meeting synthesis rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));

    store.recordMeetingSynthesisPending(
      "mtg-01ABC",
      "Weekly planning",
      "2026-04-25T10:00:00.000Z",
    );

    const pending = store.getPendingMeetingSynthesisSignals();
    expect(pending).toHaveLength(1);
    expect(pending[0].meeting_id).toBe("mtg-01ABC");
    expect(pending[0].signal_type).toBe("meeting_synthesis_pending");
    expect(store.getStaleMeetingSynthesisSignals(24)).toHaveLength(1);

    const updated = store.resolveMeetingSynthesis(
      "mtg-01ABC",
      "2026-04-25T13:00:00.000Z",
      "complete",
    );

    expect(updated).toBe(true);
    expect(store.getPendingMeetingSynthesisSignals()).toHaveLength(0);
  });

  it("writes a pending signal before the intake request fails", async () => {
    const client = new MeetingIntakeClient({
      baseUrl: "http://localhost:3485",
      store,
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });

    const result = await client.submitIntake({
      meeting_id: "mtg-02DEF",
      topic: "Dispatch review",
    });

    expect(result).toBeNull();
    const pending = store.getPendingMeetingSynthesisSignals();
    expect(pending).toHaveLength(1);
    expect(pending[0].meeting_id).toBe("mtg-02DEF");
    expect(pending[0].topic).toBe("Dispatch review");
  });

  it("reconciles completed meetings and alerts on stale unresolved rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));

    store.recordMeetingSynthesisPending(
      "mtg-03GHI",
      "Weekly planning",
      "2026-04-25T10:00:00.000Z",
    );
    store.recordMeetingSynthesisPending(
      "mtg-04JKL",
      "Retrospective",
      "2026-04-27T11:45:00.000Z",
    );

    const outcomeLookup: MeetingOutcomeLookup = {
      fetchOutcome: vi.fn(async (meetingId: string) => {
        if (meetingId === "mtg-04JKL") {
          return makeOutcome({
            meeting_id: meetingId,
            topic: "Retrospective",
            status: "complete",
            decided_at: "2026-04-27T11:50:00.000Z",
          });
        }
        return null;
      }),
    };

    const notifier = {
      isConfigured: () => true,
      notifyOperator: vi.fn().mockResolvedValue(true),
    } as unknown as Notifier;

    const retryIntake = vi.fn(async () => undefined);

    const reconciler = new MeetingSynthesisReconciler(
      store,
      outcomeLookup,
      notifier,
      {
        staleAfterHours: 24,
        scanLimit: 10,
        retryIntake,
      },
    );

    const result = await reconciler.reconcile();

    expect(result.checked).toBe(2);
    expect(result.resolved).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.alerted).toBe(1);
    expect(result.retried).toBe(1);
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
    expect(retryIntake).toHaveBeenCalledOnce();

    const pending = store.getPendingMeetingSynthesisSignals();
    expect(pending).toHaveLength(1);
    expect(pending[0].meeting_id).toBe("mtg-03GHI");
    expect(pending[0].alerted_at).toBeTruthy();
    expect(pending[0].retry_count).toBe(1);
  });

  it("builds a Telegram-friendly stale alert body", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));

    const body = buildMeetingSynthesisAlertMessage({
      id: 1,
      meeting_id: "mtg-99XYZ",
      topic: "Weekly planning",
      signal_type: "meeting_synthesis_pending",
      dispatched_at: "2026-04-25T10:00:00.000Z",
      resolved_at: null,
      alerted_at: null,
      retry_count: 2,
      last_outcome_status: null,
      updated_at: "2026-04-25T10:00:00.000Z",
    });

    expect(body).toContain("mtg-99XYZ");
    expect(body).toContain("Weekly planning");
    expect(body).toContain("24h");
  });
});
