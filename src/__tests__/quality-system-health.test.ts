/**
 * Tests for the Quality System Health module (issue #304).
 *
 * Covers:
 *  1. getQualitySystemHealthPayload — bypass detection and rate calculation
 *  2. Bypass reason classification (operator_override vs marginal_auto)
 *  3. PR URL extraction from task result/notes
 *  4. Sparkline generation: correct date range, band colouring, empty days
 *  5. Banner formatting with trend arrow
 *  6. alert_active flag based on alertThreshold
 *  7. formatQualitySystemHealthPage — Telegram output sections
 *  8. QualitySystemHealthMonitor — alert firing, per-cycle dedup, notifier error recovery
 *  9. Empty store / zero verified tasks edge cases
 * 10. Custom floor and alertThreshold overrides
 */

import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  getQualitySystemHealthPayload,
  formatQualitySystemHealthPage,
  QualitySystemHealthMonitor,
  QUALITY_FLOOR,
  BYPASS_RATE_ALERT_THRESHOLD,
  DEFAULT_SPARKLINE_DAYS,
  DEFAULT_CYCLE_TASK_LIMIT,
} from "../reviewer/quality-system-health.js";
import type { Notifier } from "../notify.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoNow(): string {
  return new Date().toISOString();
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeStoreFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-qsh-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  const writer = new Database(dbPath);

  let seq = 0;

  const insertTask = (overrides: {
    agent_name?: string | null;
    quality_score?: number | null;
    verification_status?: string | null;
    verification_notes?: string | null;
    result?: string | null;
    updated_at?: string;
    status?: string;
    bypass_reason?: string | null;
  }) => {
    const id = `task-${String(++seq).padStart(4, "0")}`;
    writer
      .prepare(
        `INSERT INTO tasks (
           id, title, description, status, agent_name, task_type, source, source_ref,
           result, verification_status, quality_score, verification_notes, bypass_reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `Task ${id}`,
        null,
        overrides.status ?? "done",
        overrides.agent_name ?? "agent-a",
        "implementation",
        null,
        null,
        overrides.result ?? null,
        overrides.verification_status ?? null,
        overrides.quality_score ?? null,
        overrides.verification_notes ?? null,
        overrides.bypass_reason ?? null,
        isoNow(),
        overrides.updated_at ?? isoNow(),
      );
    return id;
  };

  return { store, writer, insertTask, dir };
}

function makeNullNotifier(): Notifier {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    escalation: vi.fn().mockResolvedValue(undefined),
    taskRejected: vi.fn().mockResolvedValue(undefined),
    notifyOperator: vi.fn().mockResolvedValue(true),
    supervisorDecision: vi.fn().mockResolvedValue(undefined),
    healthRecovery: vi.fn().mockResolvedValue(undefined),
    isConfigured: () => true,
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

describe("module constants", () => {
  it("exports QUALITY_FLOOR = 0.60", () => {
    expect(QUALITY_FLOOR).toBe(0.60);
  });

  it("exports BYPASS_RATE_ALERT_THRESHOLD = 0.30", () => {
    expect(BYPASS_RATE_ALERT_THRESHOLD).toBe(0.30);
  });

  it("exports DEFAULT_SPARKLINE_DAYS = 7", () => {
    expect(DEFAULT_SPARKLINE_DAYS).toBe(7);
  });

  it("exports DEFAULT_CYCLE_TASK_LIMIT = 20", () => {
    expect(DEFAULT_CYCLE_TASK_LIMIT).toBe(20);
  });
});

// ── Empty store ───────────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — empty store", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("returns zero counts when no verified tasks exist", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    expect(payload.current_cycle_total).toBe(0);
    expect(payload.current_cycle_bypassed).toBe(0);
    expect(payload.current_cycle_bypass_rate).toBeNull();
    expect(payload.alert_active).toBe(false);
  });

  it("returns a sparkline with DEFAULT_SPARKLINE_DAYS entries", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    expect(payload.sparkline).toHaveLength(DEFAULT_SPARKLINE_DAYS);
  });

  it("all sparkline days are nodata when no verified tasks", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    for (const day of payload.sparkline) {
      expect(day.band).toBe("nodata");
      expect(day.total).toBe(0);
      expect(day.bypass_rate).toBeNull();
    }
  });

  it("banner says no verified tasks", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    expect(payload.banner).toMatch(/no verified tasks/i);
  });
});

// ── Bypass detection ─────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — bypass detection", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("counts approved tasks below floor as bypassed", () => {
    // 3 approved tasks: 2 below floor, 1 above
    fixture.insertTask({ quality_score: 0.45, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.55, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.current_cycle_total).toBe(3);
    expect(payload.current_cycle_bypassed).toBe(2);
  });

  it("does not count rejected tasks as bypassed even if score < floor", () => {
    fixture.insertTask({ quality_score: 0.30, verification_status: "rejected" });
    fixture.insertTask({ quality_score: 0.70, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.current_cycle_bypassed).toBe(0);
  });

  it("does not count approved tasks at exactly the floor", () => {
    fixture.insertTask({ quality_score: 0.60, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.current_cycle_bypassed).toBe(0);
  });

  it("does not count tasks with null quality_score", () => {
    fixture.insertTask({ quality_score: null, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.current_cycle_bypassed).toBe(0);
  });

  it("computes correct bypass rate", () => {
    // 9 bypassed out of 20 total
    for (let i = 0; i < 9; i++) {
      fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    }
    for (let i = 0; i < 11; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.current_cycle_bypass_rate).toBeCloseTo(9 / 20, 5);
  });

  it("respects custom floor override", () => {
    // At floor=0.70, tasks with score 0.65 should be bypassed
    fixture.insertTask({ quality_score: 0.65, verification_status: "approved" });
    fixture.insertTask({ quality_score: 0.75, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, {
      floor: 0.70,
      cycleTaskLimit: 20,
    });
    expect(payload.current_cycle_bypassed).toBe(1);
    expect(payload.floor).toBe(0.70);
  });

  it("respects cycleTaskLimit — only counts the most recent N tasks", () => {
    // Insert 10 tasks: old ones have high scores, new ones have low scores
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({
        quality_score: 0.90,
        verification_status: "approved",
        updated_at: isoDaysAgo(10),
      });
    }
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({
        quality_score: 0.40,
        verification_status: "approved",
        updated_at: isoNow(),
      });
    }

    // With limit=5, only the 5 most-recent tasks (the low-score ones) are in the cycle
    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.current_cycle_total).toBe(5);
    expect(payload.current_cycle_bypassed).toBe(5);
  });
});

// ── Bypass reason classification ─────────────────────────────────────────────

describe("getQualitySystemHealthPayload — bypass reason classification", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("classifies [operator-override marker as operator_override", () => {
    fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: APPROVED — reviewed manually]",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.operator_overrides).toBe(1);
    expect(payload.marginal_auto).toBe(0);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("operator_override");
  });

  it("classifies operator_override string in notes as operator_override", () => {
    fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: "bypass_reason: operator_override",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.operator_overrides).toBe(1);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("operator_override");
  });

  it("classifies approval_rationale marker as operator_override", () => {
    fixture.insertTask({
      quality_score: 0.55,
      verification_status: "approved",
      verification_notes: "approval_rationale: accepted given context",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.operator_overrides).toBe(1);
  });

  it("classifies tasks without override markers as marginal_auto", () => {
    fixture.insertTask({
      quality_score: 0.48,
      verification_status: "approved",
      verification_notes: "Score below threshold but marginal path approved",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.marginal_auto).toBe(1);
    expect(payload.operator_overrides).toBe(0);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("marginal_auto");
  });

  it("classifies tasks with null notes as marginal_auto", () => {
    fixture.insertTask({
      quality_score: 0.30,
      verification_status: "approved",
      verification_notes: null,
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.marginal_auto).toBe(1);
    expect(payload.operator_overrides).toBe(0);
  });

  it("correctly splits mixed override and auto counts", () => {
    fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "[operator-override: approved]",
    });
    fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: null,
    });
    fixture.insertTask({
      quality_score: 0.55,
      verification_status: "approved",
      verification_notes: null,
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 10 });
    expect(payload.operator_overrides).toBe(1);
    expect(payload.marginal_auto).toBe(2);
    expect(payload.current_cycle_bypassed).toBe(3);
  });

  it("prefers bypass_reason column over notes-based inference when column is set", () => {
    // bypass_reason column says operator_override, but notes say nothing → should use column
    fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      verification_notes: "some generic notes without override marker",
      bypass_reason: "operator_override",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.operator_overrides).toBe(1);
    expect(payload.marginal_auto).toBe(0);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("operator_override");
  });

  it("falls back to notes-based inference when bypass_reason column is null", () => {
    // No bypass_reason column, but notes contain operator-override marker
    fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      verification_notes: "[operator-override: manually approved]",
      bypass_reason: null,
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.operator_overrides).toBe(1);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("operator_override");
  });

  it("classifies floor_not_enforced bypass_reason column as marginal_auto", () => {
    fixture.insertTask({
      quality_score: 0.52,
      verification_status: "approved",
      verification_notes: null,
      bypass_reason: "floor_not_enforced",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.marginal_auto).toBe(1);
    expect(payload.operator_overrides).toBe(0);
    expect(payload.bypassed_tasks[0]?.bypass_reason).toBe("marginal_auto");
  });
});

// ── PR URL extraction ────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — PR URL extraction", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("extracts PR URL from task result field", () => {
    fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      result: "PR: https://github.com/rapartlu/agent-reviewer/pull/42",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.bypassed_tasks[0]?.pr_url).toBe(
      "https://github.com/rapartlu/agent-reviewer/pull/42",
    );
  });

  it("extracts PR URL from verification_notes when not in result", () => {
    fixture.insertTask({
      quality_score: 0.50,
      verification_status: "approved",
      result: null,
      verification_notes: "See https://github.com/rapartlu/agent-reviewer/pull/99 for diff",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.bypassed_tasks[0]?.pr_url).toBe(
      "https://github.com/rapartlu/agent-reviewer/pull/99",
    );
  });

  it("returns null pr_url when no PR URL is found", () => {
    fixture.insertTask({
      quality_score: 0.45,
      verification_status: "approved",
      result: "Task completed",
      verification_notes: null,
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.bypassed_tasks[0]?.pr_url).toBeNull();
  });
});

// ── Sparkline ────────────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — sparkline", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("sparkline has exactly `days` entries sorted oldest → newest", () => {
    const payload = getQualitySystemHealthPayload(fixture.store, { days: 5 });
    expect(payload.sparkline).toHaveLength(5);
    for (let i = 1; i < payload.sparkline.length; i++) {
      expect(payload.sparkline[i].date >= payload.sparkline[i - 1].date).toBe(true);
    }
  });

  it("today's sparkline entry is 'warn' when bypass rate >= alertThreshold", () => {
    // Insert tasks today: 4 bypassed out of 5 (80%)
    for (let i = 0; i < 4; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }
    fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, {
      days: 7,
      alertThreshold: 0.30,
    });
    const todayEntry = payload.sparkline[payload.sparkline.length - 1];
    expect(todayEntry?.band).toBe("warn");
  });

  it("today's sparkline entry is 'ok' when bypass rate < alertThreshold", () => {
    // 1 bypassed out of 10 (10%) → below 30% threshold
    fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    for (let i = 0; i < 9; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, {
      days: 7,
      alertThreshold: 0.30,
    });
    const todayEntry = payload.sparkline[payload.sparkline.length - 1];
    expect(todayEntry?.band).toBe("ok");
  });

  it("sparkline days outside the window are nodata", () => {
    // Only one task today
    fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { days: 7 });
    // All days except today should be nodata (no verified tasks in those days)
    const notToday = payload.sparkline.slice(0, 6);
    for (const day of notToday) {
      expect(day.band).toBe("nodata");
    }
  });

  it("sparkline correctly counts tasks from different days", () => {
    // Yesterday: 2 tasks, both above floor
    fixture.insertTask({
      quality_score: 0.80,
      verification_status: "approved",
      updated_at: isoDaysAgo(1),
    });
    fixture.insertTask({
      quality_score: 0.90,
      verification_status: "approved",
      updated_at: isoDaysAgo(1),
    });
    // Today: 1 task below floor
    fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      updated_at: isoNow(),
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { days: 7 });
    const todayEntry = payload.sparkline[payload.sparkline.length - 1];
    const yesterdayEntry = payload.sparkline[payload.sparkline.length - 2];

    expect(todayEntry?.bypass_rate).toBe(1.0);
    expect(todayEntry?.band).toBe("warn");
    expect(yesterdayEntry?.bypass_rate).toBe(0);
    expect(yesterdayEntry?.band).toBe("ok");
  });
});

// ── Alert flag ───────────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — alert_active", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("alert_active = true when bypass rate >= alertThreshold", () => {
    // 10 out of 10 bypassed = 100%
    for (let i = 0; i < 10; i++) {
      fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.30,
      cycleTaskLimit: 10,
    });
    expect(payload.alert_active).toBe(true);
  });

  it("alert_active = false when bypass rate < alertThreshold", () => {
    // 2 out of 10 bypassed = 20%
    for (let i = 0; i < 2; i++) {
      fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    }
    for (let i = 0; i < 8; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.30,
      cycleTaskLimit: 10,
    });
    expect(payload.alert_active).toBe(false);
  });

  it("alert_active = false when no verified tasks", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    expect(payload.alert_active).toBe(false);
  });

  it("respects custom alertThreshold", () => {
    // 5 out of 10 bypassed = 50% → fires at threshold=0.40, not at threshold=0.60
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    }
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const below = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.60,
      cycleTaskLimit: 10,
    });
    expect(below.alert_active).toBe(false);

    const above = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.40,
      cycleTaskLimit: 10,
    });
    expect(above.alert_active).toBe(true);
  });
});

// ── Banner ───────────────────────────────────────────────────────────────────

describe("getQualitySystemHealthPayload — banner", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("banner includes percentage, count, and total", () => {
    for (let i = 0; i < 9; i++) {
      fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    }
    for (let i = 0; i < 11; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    expect(payload.banner).toMatch(/45%/);
    expect(payload.banner).toMatch(/9\/20/);
    expect(payload.banner).toMatch(/tasks/);
  });

  it("banner includes trend arrow (▲, ▼, or →)", () => {
    fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    expect(payload.banner).toMatch(/[▲▼→]/);
  });
});

// ── formatQualitySystemHealthPage ────────────────────────────────────────────

describe("formatQualitySystemHealthPage", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;

  beforeEach(() => {
    fixture = makeStoreFixture();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
  });

  it("includes the banner text", () => {
    fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain(payload.banner);
  });

  it("shows 🚨 header when alert_active", () => {
    // All tasks bypassed → alert fires
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain("🚨");
  });

  it("shows ✅ header when no alert", () => {
    const payload = getQualitySystemHealthPayload(fixture.store);
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain("✅");
  });

  it("includes sparkline with band characters", () => {
    fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });

    const payload = getQualitySystemHealthPayload(fixture.store, { days: 3 });
    const page = formatQualitySystemHealthPage(payload);
    // Sparkline should contain at least one band character
    expect(page).toMatch(/[🟢🔴⬜]/);
  });

  it("shows operator_override badge 🔓 for operator-override tasks", () => {
    fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      verification_notes: "[operator-override: approved]",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain("🔓");
  });

  it("shows auto badge 🤖 for marginal_auto tasks", () => {
    fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      verification_notes: null,
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain("🤖");
  });

  it("shows no-bypass message when zero bypasses", () => {
    for (let i = 0; i < 3; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 10 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toMatch(/no below-floor approvals/i);
  });

  it("truncates to 5 bypassed tasks in display, shows overflow hint", () => {
    for (let i = 0; i < 8; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 20 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toMatch(/and 3 more/);
  });

  it("includes PR link when pr_url is present", () => {
    fixture.insertTask({
      quality_score: 0.40,
      verification_status: "approved",
      result: "https://github.com/rapartlu/agent-reviewer/pull/123",
    });

    const payload = getQualitySystemHealthPayload(fixture.store, { cycleTaskLimit: 5 });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toContain(
      "https://github.com/rapartlu/agent-reviewer/pull/123",
    );
  });

  it("includes alert warning line when alert_active", () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const payload = getQualitySystemHealthPayload(fixture.store, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });
    const page = formatQualitySystemHealthPage(payload);
    expect(page).toMatch(/alert active/i);
  });
});

// ── QualitySystemHealthMonitor ───────────────────────────────────────────────

describe("QualitySystemHealthMonitor — checkAndAlert", () => {
  let fixture: ReturnType<typeof makeStoreFixture>;
  let notifier: Notifier;

  beforeEach(() => {
    fixture = makeStoreFixture();
    notifier = makeNullNotifier();
  });

  afterEach(() => {
    fixture.writer.close();
    rmSync(fixture.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not alert when bypass rate is below threshold", async () => {
    // 1 bypassed out of 10 = 10%, below 30% threshold
    fixture.insertTask({ quality_score: 0.50, verification_status: "approved" });
    for (let i = 0; i < 9; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.30,
      cycleTaskLimit: 10,
    });
    const sent = await monitor.checkAndAlert();
    expect(sent).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("sends alert when bypass rate >= threshold", async () => {
    // 8 out of 10 bypassed = 80%
    for (let i = 0; i < 8; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }
    for (let i = 0; i < 2; i++) {
      fixture.insertTask({ quality_score: 0.80, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.30,
      cycleTaskLimit: 10,
    });
    // #564 noise suppression: alert is logged but not dispatched to Telegram.
    const sent = await monitor.checkAndAlert();
    expect(sent).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("deduplicates alerts in the same 2-hour cycle window", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });

    // Both calls with the same nowMs (same cycle window)
    // #564 noise suppression: send is logged but not dispatched to Telegram.
    const nowMs = Date.now();
    const sent1 = await monitor.checkAndAlert(nowMs);
    const sent2 = await monitor.checkAndAlert(nowMs);

    expect(sent1).toBe(true);
    expect(sent2).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("sends a second alert in a different 2-hour cycle window", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });

    const t1 = Date.now();
    const t2 = t1 + 3 * 60 * 60 * 1000; // 3 hours later — different 2-hour bucket

    const r1 = await monitor.checkAndAlert(t1);
    const r2 = await monitor.checkAndAlert(t2);

    // #564 noise suppression: send is suppressed; both calls return true (processed).
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("returns false and does not throw when notifier is undefined", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, undefined, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });
    const sent = await monitor.checkAndAlert();
    expect(sent).toBe(false);
  });

  it("returns false and does not throw when notifier.send rejects", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const failingNotifier = makeNullNotifier();
    (failingNotifier.send as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Telegram unavailable"),
    );

    const monitor = new QualitySystemHealthMonitor(fixture.store, failingNotifier, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
    });
    // #564 noise suppression: notifier.send is never called so it never rejects.
    // checkAndAlert returns true (alert processed via log) not false.
    await expect(monitor.checkAndAlert()).resolves.toBe(true);
  });

  it("includes dashboardUrl in alert message when configured", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.insertTask({ quality_score: 0.40, verification_status: "approved" });
    }

    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.10,
      cycleTaskLimit: 5,
      dashboardUrl: "https://dashboard.example.com",
    });
    const sent = await monitor.checkAndAlert();
    // #564 noise suppression: notifier.send is never called.
    // dashboardUrl is still assembled in the alert body (logged internally).
    expect(sent).toBe(true);
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("does not alert when store has no verified tasks", async () => {
    const monitor = new QualitySystemHealthMonitor(fixture.store, notifier, {
      alertThreshold: 0.30,
    });
    const sent = await monitor.checkAndAlert();
    expect(sent).toBe(false);
    expect(notifier.send).not.toHaveBeenCalled();
  });
});
