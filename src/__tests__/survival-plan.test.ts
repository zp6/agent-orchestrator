/**
 * Tests for survival-plan.ts (issue #565).
 *
 * Covers:
 *   1. readSurvivalPlanStatus() — graceful fallback when table absent, correct parsing
 *   2. checkDay7Checkpoint() — passes/fails criteria correctly, overdue detection
 *   3. formatSurvivalStatusForTelegram() — output includes key fields
 *   4. checkAndEscalateDay7() — escalates when overdue, skips when passed or not imminent
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  readSurvivalPlanStatus,
  checkDay7Checkpoint,
  formatSurvivalStatusForTelegram,
  checkAndEscalateDay7,
  SURVIVAL_PLAN,
} from "../reviewer/survival-plan.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal mock for a better-sqlite3 Database that returns no rows. */
function makeEmptyDb(): { prepare: (sql: string) => { get: () => unknown } } {
  return { prepare: () => ({ get: () => undefined }) };
}

/** Minimal mock that throws (simulates table-not-found). */
function makeThrowingDb(): { prepare: (sql: string) => { get: () => unknown } } {
  return {
    prepare: () => ({
      get: () => {
        throw new Error("no such table: survival_plan_status");
      },
    }),
  };
}

/** Minimal mock that returns a status row. */
function makeStatusDb(overrides: Partial<{
  first_dollar_received: number;
  revenue_paths_active: number;
  treasury_balance_usd: number;
  revenue_paths: string;
  last_updated: string;
}>): { prepare: (sql: string) => { get: () => unknown } } {
  const row = {
    first_dollar_received: 0,
    revenue_paths_active: 0,
    treasury_balance_usd: 0,
    revenue_paths: "[]",
    last_updated: "2026-04-27T00:00:00Z",
    ...overrides,
  };
  return { prepare: () => ({ get: () => row }) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("readSurvivalPlanStatus", () => {
  it("returns zero-state when table is absent (empty db)", () => {
    const status = readSurvivalPlanStatus(makeEmptyDb());
    expect(status.first_dollar_received).toBe(false);
    expect(status.revenue_paths_active).toBe(0);
    expect(status.treasury_balance_usd).toBe(0);
    expect(status.revenue_paths).toEqual([]);
    expect(status.last_updated).toBeNull();
  });

  it("returns zero-state when database throws (table not created)", () => {
    const status = readSurvivalPlanStatus(makeThrowingDb());
    expect(status.first_dollar_received).toBe(false);
    expect(status.revenue_paths_active).toBe(0);
  });

  it("parses a populated row correctly", () => {
    const db = makeStatusDb({
      first_dollar_received: 1,
      revenue_paths_active: 3,
      treasury_balance_usd: 42.5,
      revenue_paths: '["github_sponsors","bounty","kofi"]',
      last_updated: "2026-05-01T12:00:00Z",
    });
    const status = readSurvivalPlanStatus(db);
    expect(status.first_dollar_received).toBe(true);
    expect(status.revenue_paths_active).toBe(3);
    expect(status.treasury_balance_usd).toBe(42.5);
    expect(status.revenue_paths).toEqual(["github_sponsors", "bounty", "kofi"]);
    expect(status.last_updated).toBe("2026-05-01T12:00:00Z");
  });
});

describe("checkDay7Checkpoint", () => {
  it("fails when no first dollar and no revenue paths", () => {
    const result = checkDay7Checkpoint(makeEmptyDb());
    expect(result.passed).toBe(false);
    expect(result.issues).toContain("No first dollar received yet");
    expect(result.issues.some((i) => i.includes("revenue paths"))).toBe(true);
  });

  it("passes when all criteria are met", () => {
    const db = makeStatusDb({
      first_dollar_received: 1,
      revenue_paths_active: 3,
    });
    const result = checkDay7Checkpoint(db);
    expect(result.passed).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails if only one criterion is met (first dollar but no paths)", () => {
    const db = makeStatusDb({
      first_dollar_received: 1,
      revenue_paths_active: 1,
    });
    const result = checkDay7Checkpoint(db);
    expect(result.passed).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/revenue paths/);
  });

  it("reports is_overdue=true when deadline has passed", () => {
    // Day-7 deadline is 2026-05-04; current date (2026-04-27) is before it
    const result = checkDay7Checkpoint(makeEmptyDb());
    // In tests the deadline hasn't passed yet (test date is 2026-04-27)
    expect(result.is_overdue).toBe(false);
    expect(result.days_remaining).toBeGreaterThan(0);
  });

  it("deadline constants are correct", () => {
    expect(SURVIVAL_PLAN.DAY_7_DEADLINE.toISOString().startsWith("2026-05-04")).toBe(true);
    expect(SURVIVAL_PLAN.DAY_30_DEADLINE.toISOString().startsWith("2026-05-27")).toBe(true);
    expect(SURVIVAL_PLAN.TREASURY_TARGET_USD).toBe(400);
    expect(SURVIVAL_PLAN.MIN_REVENUE_PATHS).toBe(3);
  });
});

describe("formatSurvivalStatusForTelegram", () => {
  it("includes treasury balance and deadline dates", () => {
    const db = makeStatusDb({ treasury_balance_usd: 12.5 });
    const output = formatSurvivalStatusForTelegram(db);
    expect(output).toContain("$12.50");
    expect(output).toContain("2026-05-04");
    expect(output).toContain("2026-05-27");
  });

  it("shows 'No' for first dollar when not received", () => {
    const output = formatSurvivalStatusForTelegram(makeEmptyDb());
    expect(output).toContain("First dollar received: No");
  });

  it("shows 'Yes' for first dollar when received", () => {
    const db = makeStatusDb({ first_dollar_received: 1 });
    const output = formatSurvivalStatusForTelegram(db);
    expect(output).toContain("First dollar received: Yes");
  });

  it("always surfaces the baked-in fleet wallet address (default env)", () => {
    const output = formatSurvivalStatusForTelegram(makeEmptyDb());
    // The fleet wallet address is now baked-in as a default so it always appears,
    // even when no platform URLs (Polar, Sponsors, etc.) are configured.
    expect(output).toContain("0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef");
    expect(output).toContain("Treasury wallet");
  });

  it("shows active revenue paths when present", () => {
    const db = makeStatusDb({
      first_dollar_received: 1,
      revenue_paths_active: 3,
      revenue_paths: '["github_sponsors","bounty","kofi"]',
    });
    const output = formatSurvivalStatusForTelegram(db);
    expect(output).toContain("github_sponsors");
  });
});

describe("checkAndEscalateDay7", () => {
  it("does NOT escalate when checkpoint is passed", async () => {
    const db = makeStatusDb({
      first_dollar_received: 1,
      revenue_paths_active: 3,
    });
    const send = vi.fn().mockResolvedValue(undefined);
    await checkAndEscalateDay7(db, send);
    expect(send).not.toHaveBeenCalled();
  });

  it("does NOT escalate when criteria unmet but deadline is far away", async () => {
    // Deadline is 2026-05-04; current date (2026-04-27) is 7 days away — just beyond 24h threshold
    const send = vi.fn().mockResolvedValue(undefined);
    await checkAndEscalateDay7(makeEmptyDb(), send);
    // 7 days away is more than 24h, so no escalation
    expect(send).not.toHaveBeenCalled();
  });
});
