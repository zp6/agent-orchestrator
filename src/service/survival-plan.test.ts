/**
 * Tests for the 30-day fleet survival plan tracker (issue #1267).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkDay7Checkpoint,
  checkAndEscalateDay7,
  getSurvivalStatusPayload,
  formatSurvivalStatusForTelegram,
  renderRevenueLandingPage,
  getRevenuePath,
  setRevenuePath,
  markPathInMotion,
  recordEarnings,
  getTotalEarnedUsd,
  getFirstDollarAt,
  countActiveRevenuePaths,
  DAY7_CHECKPOINT_ISO,
  SURVIVAL_DEADLINE_ISO,
  SURVIVAL_TARGET_USD,
  APPROVED_REVENUE_PATH_IDS,
  type ISurvivalPlanStore,
} from "./survival-plan.js";

// ── Minimal in-memory store stub ─────────────────────────────────────────────

function makeStore(): ISurvivalPlanStore & { flags: Map<string, string> } {
  const flags = new Map<string, string>();
  return {
    flags,
    getSystemFlag(key: string) { return flags.get(key) ?? null; },
    setSystemFlag(key: string, value: string) { flags.set(key, value); },
  };
}

// ── getRevenuePath / setRevenuePath ──────────────────────────────────────────

describe("getRevenuePath", () => {
  it("returns not_started defaults when flag is absent", () => {
    const store = makeStore();
    const path = getRevenuePath(store, "bounty-claiming");
    expect(path.status).toBe("not_started");
    expect(path.earnedUsd).toBe(0);
    expect(path.url).toBe("");
  });

  it("round-trips through setRevenuePath", () => {
    const store = makeStore();
    setRevenuePath(store, {
      id: "bounty-claiming",
      label: "bounty-claiming",
      status: "in_motion",
      updatedAt: "2026-04-28T00:00:00Z",
      earnedUsd: 0,
      url: "https://algora.io",
    });
    const path = getRevenuePath(store, "bounty-claiming");
    expect(path.status).toBe("in_motion");
    expect(path.url).toBe("https://algora.io");
  });

  it("returns defaults when flag value is malformed JSON", () => {
    const store = makeStore();
    store.flags.set("survival:path:bounty-claiming", "{bad json");
    const path = getRevenuePath(store, "bounty-claiming");
    expect(path.status).toBe("not_started");
  });
});

// ── markPathInMotion ──────────────────────────────────────────────────────────

describe("markPathInMotion", () => {
  it("transitions not_started → in_motion", () => {
    const store = makeStore();
    markPathInMotion(store, "github-sponsors", "https://github.com/sponsors/fleet");
    const path = getRevenuePath(store, "github-sponsors");
    expect(path.status).toBe("in_motion");
    expect(path.url).toBe("https://github.com/sponsors/fleet");
  });

  it("does not downgrade earned → in_motion", () => {
    const store = makeStore();
    setRevenuePath(store, {
      id: "github-sponsors",
      label: "github-sponsors",
      status: "earned",
      updatedAt: "2026-04-28T00:00:00Z",
      earnedUsd: 10,
      url: "https://github.com/sponsors/fleet",
    });
    markPathInMotion(store, "github-sponsors");
    expect(getRevenuePath(store, "github-sponsors").status).toBe("earned");
  });
});

// ── recordEarnings ────────────────────────────────────────────────────────────

describe("recordEarnings", () => {
  it("upgrades path to earned and records amount", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 50);
    const path = getRevenuePath(store, "bounty-claiming");
    expect(path.status).toBe("earned");
    expect(path.earnedUsd).toBe(50);
  });

  it("accumulates multiple earnings on same path", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 20);
    recordEarnings(store, "bounty-claiming", 30);
    expect(getRevenuePath(store, "bounty-claiming").earnedUsd).toBe(50);
  });

  it("records first-dollar timestamp on first earning", () => {
    const store = makeStore();
    expect(getFirstDollarAt(store)).toBeNull();
    recordEarnings(store, "bounty-claiming", 1);
    expect(getFirstDollarAt(store)).not.toBeNull();
  });

  it("does not overwrite first-dollar timestamp on subsequent earnings", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 1);
    const first = getFirstDollarAt(store);
    recordEarnings(store, "github-sponsors", 5);
    expect(getFirstDollarAt(store)).toBe(first);
  });

  it("updates aggregate total across paths", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 10);
    recordEarnings(store, "github-sponsors", 25.50);
    expect(getTotalEarnedUsd(store)).toBeCloseTo(35.50, 2);
  });
});

// ── countActiveRevenuePaths ───────────────────────────────────────────────────

describe("countActiveRevenuePaths", () => {
  it("returns 0 when nothing is set", () => {
    expect(countActiveRevenuePaths(makeStore())).toBe(0);
  });

  it("counts in_motion paths", () => {
    const store = makeStore();
    markPathInMotion(store, "bounty-claiming");
    markPathInMotion(store, "github-sponsors");
    expect(countActiveRevenuePaths(store)).toBe(2);
  });

  it("counts earned paths too", () => {
    const store = makeStore();
    markPathInMotion(store, "bounty-claiming");
    recordEarnings(store, "github-sponsors", 5);
    expect(countActiveRevenuePaths(store)).toBe(2);
  });
});

// ── checkDay7Checkpoint ───────────────────────────────────────────────────────

describe("checkDay7Checkpoint", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns checkpointMet=false when nothing is set up", () => {
    const store = makeStore();
    const result = checkDay7Checkpoint(store);
    expect(result.checkpointMet).toBe(false);
    expect(result.firstDollarReceived).toBe(false);
    expect(result.activePathCount).toBe(0);
  });

  it("returns checkpointMet=true when first dollar received AND 3+ active paths", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 1);
    markPathInMotion(store, "github-sponsors");
    markPathInMotion(store, "algora-bounties");
    const result = checkDay7Checkpoint(store);
    expect(result.checkpointMet).toBe(true);
    expect(result.firstDollarReceived).toBe(true);
    expect(result.activePathCount).toBe(3);
  });

  it("returns checkpointMet=false when only 2 active paths even if first dollar received", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 1);
    markPathInMotion(store, "github-sponsors");
    const result = checkDay7Checkpoint(store);
    expect(result.checkpointMet).toBe(false);
    expect(result.activePathCount).toBe(2);
  });

  it("deadlinePassed is false before 2026-05-04", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
    const store = makeStore();
    const result = checkDay7Checkpoint(store);
    expect(result.deadlinePassed).toBe(false);
  });

  it("deadlinePassed is true on or after 2026-05-04", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T00:00:00Z"));
    const store = makeStore();
    const result = checkDay7Checkpoint(store);
    expect(result.deadlinePassed).toBe(true);
  });

  it("daysUntilSurvivalDeadline counts from now to 2026-05-27", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T00:00:00Z"));
    const store = makeStore();
    const result = checkDay7Checkpoint(store);
    expect(result.daysUntilSurvivalDeadline).toBe(30);
  });

  it("daysUntilSurvivalDeadline is 0 after deadline has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const store = makeStore();
    const result = checkDay7Checkpoint(store);
    expect(result.daysUntilSurvivalDeadline).toBe(0);
  });
});

// ── checkAndEscalateDay7 ──────────────────────────────────────────────────────

describe("checkAndEscalateDay7", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not escalate if checkpoint is met", async () => {
    const notifyMod = await import("../notify.js");
    const spy = vi.spyOn(notifyMod, "notifyOperator").mockResolvedValue(undefined);

    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 1);
    markPathInMotion(store, "github-sponsors");
    markPathInMotion(store, "algora-bounties");
    // checkpoint met — no deadline needed
    await checkAndEscalateDay7(store);
    expect(spy).not.toHaveBeenCalled();
  });

  it("does not escalate if deadline has not yet passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z")); // before Day-7

    const notifyMod = await import("../notify.js");
    const spy = vi.spyOn(notifyMod, "notifyOperator").mockResolvedValue(undefined);

    const store = makeStore();
    await checkAndEscalateDay7(store);
    expect(spy).not.toHaveBeenCalled();
  });

  it("escalates via notifyOperator when deadline passed and checkpoint not met", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z")); // after Day-7

    const notifyMod = await import("../notify.js");
    const spy = vi.spyOn(notifyMod, "notifyOperator").mockResolvedValue(undefined);

    const store = makeStore();
    await checkAndEscalateDay7(store);
    expect(spy).toHaveBeenCalledOnce();
    // notifyOperator signature: (title, body, urgency) — no key parameter.
    const [title, , severity] = spy.mock.calls[0] as [string, string, string];
    expect(title).toContain("Day-7");
    expect(severity).toBe("high");
  });

  it("records day7EscalatedAt flag after escalation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-06T00:00:00Z"));

    const notifyMod = await import("../notify.js");
    vi.spyOn(notifyMod, "notifyOperator").mockResolvedValue(undefined);

    const store = makeStore();
    await checkAndEscalateDay7(store);
    expect(store.getSystemFlag("survival:day7_escalated_at")).not.toBeNull();
  });
});

// ── getSurvivalStatusPayload ──────────────────────────────────────────────────

describe("getSurvivalStatusPayload", () => {
  it("returns sane defaults when store is empty", () => {
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    expect(payload.totalEarnedUsd).toBe(0);
    expect(payload.targetUsd).toBe(SURVIVAL_TARGET_USD);
    expect(payload.progressPct).toBe(0);
    expect(payload.firstDollarAt).toBeNull();
    expect(payload.activePathCount).toBe(0);
    expect(payload.day7CheckpointMet).toBe(false);
    expect(payload.revenuePaths).toHaveLength(APPROVED_REVENUE_PATH_IDS.length);
  });

  it("reflects recorded earnings in totalEarnedUsd and progressPct", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 200);
    const payload = getSurvivalStatusPayload(store);
    expect(payload.totalEarnedUsd).toBe(200);
    expect(payload.progressPct).toBeCloseTo(50, 1);
  });
});

// ── formatSurvivalStatusForTelegram ──────────────────────────────────────────

describe("formatSurvivalStatusForTelegram", () => {
  it("includes the issue reference", () => {
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toContain("#1267");
  });

  it("shows progress bar", () => {
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toMatch(/\[.*\]/); // progress bar
  });

  it("shows MISSED badge when deadline passed and checkpoint not met", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:00Z"));
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toContain("MISSED");
    vi.useRealTimers();
  });

  it("shows met badge when checkpoint is satisfied", () => {
    const store = makeStore();
    recordEarnings(store, "bounty-claiming", 1);
    markPathInMotion(store, "github-sponsors");
    markPathInMotion(store, "algora-bounties");
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toContain("met");
  });

  it("prompts operator to configure wallet when address is missing", () => {
    const originalEnv = process.env.FLEET_WALLET_ADDRESS;
    delete process.env.FLEET_WALLET_ADDRESS;
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toContain("FLEET");
    if (originalEnv !== undefined) {
      process.env.FLEET_WALLET_ADDRESS = originalEnv;
    }
  });

  it("shows wallet address when env var is set", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const output = formatSurvivalStatusForTelegram(payload);
    expect(output).toContain("0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF");
    delete process.env.FLEET_WALLET_ADDRESS;
  });

  it("renders the landing page with the full wallet address and direct-pay CTA", () => {
    process.env.FLEET_WALLET_ADDRESS = "0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF";
    const store = makeStore();
    const payload = getSurvivalStatusPayload(store);
    const html = renderRevenueLandingPage(payload);

    expect(html).toContain("Tip the autonomous fleet directly.");
    expect(html).toContain("0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF");
    expect(html).toContain("Pay on Base");
    delete process.env.FLEET_WALLET_ADDRESS;
  });
});
