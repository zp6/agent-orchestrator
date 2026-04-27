/**
 * Unit tests for synthesis-watchdog.ts (issue #553)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SynthesisWatchdog,
  registerSynthesisIntake,
  recordSynthesisComplete,
  formatMissingSynthesisAlert,
  SYNTHESIS_MISSING_THRESHOLD_HOURS,
  SYNTHESIS_ALERT_COOLDOWN_HOURS,
  SYNTHESIS_WATCHDOG_MIGRATION_SQL,
} from "../reviewer/synthesis-watchdog.js";
import type {
  ISynthesisWatchdogStore,
  SynthesisWatchEntry,
  SynthesisWatchdogCheckResult,
} from "../reviewer/synthesis-watchdog.js";
import type { Notifier } from "../notify.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<SynthesisWatchEntry> = {}): SynthesisWatchEntry {
  return {
    id: "01ABC123",
    repo: "rapartlu/agent-orchestrator",
    issue_number: 1241,
    intake_at: new Date(Date.now() - 26 * 3_600_000).toISOString(), // 26h ago
    synthesized_at: null,
    alerted_at: null,
    reintake_at: null,
    ...overrides,
  };
}

function makeStore(
  entries: SynthesisWatchEntry[] = [],
): ISynthesisWatchdogStore & {
  registered: { repo: string; issueNumber: number }[];
  completed: { repo: string; issueNumber: number }[];
  alerted: { repo: string; issueNumber: number }[];
  reintakes: { repo: string; issueNumber: number }[];
} {
  const registered: { repo: string; issueNumber: number }[] = [];
  const completed: { repo: string; issueNumber: number }[] = [];
  const alerted: { repo: string; issueNumber: number }[] = [];
  const reintakes: { repo: string; issueNumber: number }[] = [];

  return {
    registered,
    completed,
    alerted,
    reintakes,
    registerSynthesisIntake: vi.fn((repo, issueNumber) => registered.push({ repo, issueNumber })),
    recordSynthesisComplete: vi.fn((repo, issueNumber) => completed.push({ repo, issueNumber })),
    getMissingSynthesisEntries: vi.fn(() => entries),
    markWatchdogAlerted: vi.fn((repo, issueNumber) => alerted.push({ repo, issueNumber })),
    markWatchdogReintake: vi.fn((repo, issueNumber) => reintakes.push({ repo, issueNumber })),
  };
}

function makeNotifier(notifyResult = true): Notifier {
  return {
    send: vi.fn(),
    escalation: vi.fn(),
    taskRejected: vi.fn(),
    notifyOperator: vi.fn(async () => notifyResult),
    supervisorDecision: vi.fn(),
    healthRecovery: vi.fn(),
    memoryDigest: vi.fn(),
    isConfigured: vi.fn(() => true),
  } as unknown as Notifier;
}

// ── SYNTHESIS_WATCHDOG_MIGRATION_SQL ──────────────────────────────────────────

describe("SYNTHESIS_WATCHDOG_MIGRATION_SQL", () => {
  it("creates synthesis_watchlist table", () => {
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain(
      "CREATE TABLE IF NOT EXISTS synthesis_watchlist",
    );
  });

  it("includes required columns", () => {
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("repo");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("issue_number");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("intake_at");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("synthesized_at");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("alerted_at");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("reintake_at");
  });

  it("includes a UNIQUE constraint on (repo, issue_number)", () => {
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("UNIQUE(repo, issue_number)");
  });

  it("creates an index on intake_at", () => {
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("CREATE INDEX IF NOT EXISTS");
    expect(SYNTHESIS_WATCHDOG_MIGRATION_SQL).toContain("intake_at");
  });
});

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("threshold is 24 hours", () => {
    expect(SYNTHESIS_MISSING_THRESHOLD_HOURS).toBe(24);
  });

  it("alert cooldown is 6 hours", () => {
    expect(SYNTHESIS_ALERT_COOLDOWN_HOURS).toBe(6);
  });
});

// ── registerSynthesisIntake ───────────────────────────────────────────────────

describe("registerSynthesisIntake", () => {
  it("delegates to store", () => {
    const store = makeStore();
    registerSynthesisIntake(store, "owner/repo", 42);
    expect(store.registerSynthesisIntake).toHaveBeenCalledWith("owner/repo", 42);
    expect(store.registered).toEqual([{ repo: "owner/repo", issueNumber: 42 }]);
  });

  it("swallows store errors gracefully", () => {
    const store = makeStore();
    vi.spyOn(store, "registerSynthesisIntake").mockImplementation(() => {
      throw new Error("DB error");
    });
    // Should not throw
    expect(() => registerSynthesisIntake(store, "owner/repo", 1)).not.toThrow();
  });
});

// ── recordSynthesisComplete ───────────────────────────────────────────────────

describe("recordSynthesisComplete", () => {
  it("delegates to store", () => {
    const store = makeStore();
    recordSynthesisComplete(store, "owner/repo", 99);
    expect(store.recordSynthesisComplete).toHaveBeenCalledWith("owner/repo", 99);
    expect(store.completed).toEqual([{ repo: "owner/repo", issueNumber: 99 }]);
  });

  it("swallows store errors gracefully", () => {
    const store = makeStore();
    vi.spyOn(store, "recordSynthesisComplete").mockImplementation(() => {
      throw new Error("DB error");
    });
    expect(() => recordSynthesisComplete(store, "owner/repo", 1)).not.toThrow();
  });
});

// ── formatMissingSynthesisAlert ───────────────────────────────────────────────

describe("formatMissingSynthesisAlert", () => {
  it("returns a success message when no entries", () => {
    const msg = formatMissingSynthesisAlert([]);
    expect(msg).toContain("✅");
    expect(msg).toContain("All tracked meetings");
  });

  it("returns a warning with entries", () => {
    const entries = [
      makeEntry({ repo: "rapartlu/agent-orchestrator", issue_number: 100 }),
      makeEntry({ repo: "rapartlu/agent-dashboard", issue_number: 200 }),
    ];
    const msg = formatMissingSynthesisAlert(entries);
    expect(msg).toContain("⚠️");
    expect(msg).toContain("Synthesis missing");
    expect(msg).toContain("rapartlu/agent-orchestrator#100");
    expect(msg).toContain("rapartlu/agent-dashboard#200");
  });

  it("shows age in hours when < 48h", () => {
    const entry = makeEntry({
      intake_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    });
    const msg = formatMissingSynthesisAlert([entry]);
    expect(msg).toMatch(/30h/);
  });

  it("shows age in days when >= 48h", () => {
    const entry = makeEntry({
      intake_at: new Date(Date.now() - 72 * 3_600_000).toISOString(),
    });
    const msg = formatMissingSynthesisAlert([entry]);
    expect(msg).toMatch(/3d/);
  });
});

// ── SynthesisWatchdog.checkAndAlert ──────────────────────────────────────────

describe("SynthesisWatchdog.checkAndAlert", () => {
  it("returns zeros when no missing entries", async () => {
    const store = makeStore([]);
    const notifier = makeNotifier();
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    expect(result.alertsFired).toBe(0);
    expect(result.reintakeAttempts).toBe(0);
    expect(result.processed).toHaveLength(0);
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
  });

  it("fires alert for missing entry past threshold", async () => {
    const entry = makeEntry();
    const store = makeStore([entry]);
    const notifier = makeNotifier(true);
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
    const [title, body, urgency] = (notifier.notifyOperator as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(title).toContain("Synthesis missing after 24h");
    expect(body).toContain("rapartlu/agent-orchestrator#1241");
    expect(urgency).toBe("high");
    expect(result.alertsFired).toBe(1);
    expect(result.processed).toHaveLength(1);
  });

  it("records alerted_at after firing alert", async () => {
    const entry = makeEntry();
    const store = makeStore([entry]);
    const notifier = makeNotifier(true);
    const watchdog = new SynthesisWatchdog(store, notifier);
    await watchdog.checkAndAlert();
    expect(store.markWatchdogAlerted).toHaveBeenCalledWith(
      entry.repo,
      entry.issue_number,
    );
  });

  it("skips entry within alert cooldown window", async () => {
    // alerted_at = 2h ago, cooldown = 6h → should skip
    const entry = makeEntry({
      alerted_at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    const store = makeStore([entry]);
    const notifier = makeNotifier();
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    expect(notifier.notifyOperator).not.toHaveBeenCalled();
    expect(result.alertsFired).toBe(0);
    expect(result.processed).toHaveLength(0);
  });

  it("does not skip entry after cooldown has expired", async () => {
    // alerted_at = 8h ago, cooldown = 6h → should fire
    const entry = makeEntry({
      alerted_at: new Date(Date.now() - 8 * 3_600_000).toISOString(),
    });
    const store = makeStore([entry]);
    const notifier = makeNotifier(true);
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    expect(notifier.notifyOperator).toHaveBeenCalledOnce();
    expect(result.alertsFired).toBe(1);
  });

  it("does not record alerted_at when notifyOperator returns false", async () => {
    const entry = makeEntry();
    const store = makeStore([entry]);
    const notifier = makeNotifier(false); // notifyOperator returns false
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    expect(store.markWatchdogAlerted).not.toHaveBeenCalled();
    expect(result.alertsFired).toBe(0);
  });

  it("handles multiple missing entries independently", async () => {
    const entries = [
      makeEntry({ id: "A", issue_number: 10 }),
      makeEntry({ id: "B", issue_number: 20 }),
      // This one is within cooldown — should be skipped
      makeEntry({
        id: "C",
        issue_number: 30,
        alerted_at: new Date(Date.now() - 1 * 3_600_000).toISOString(),
      }),
    ];
    const store = makeStore(entries);
    const notifier = makeNotifier(true);
    const watchdog = new SynthesisWatchdog(store, notifier);
    const result = await watchdog.checkAndAlert();
    // Two entries processed (third is in cooldown)
    expect(result.processed).toHaveLength(2);
    expect(result.alertsFired).toBe(2);
  });
});
