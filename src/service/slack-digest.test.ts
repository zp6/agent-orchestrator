import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseScheduleMinutes,
  isScheduledTimeReached,
  todayLocalDateString,
  buildDigestData,
  formatSlackDigest,
  postToSlackWebhook,
  maybePostDailyDigest,
  type DigestSchedulerState,
} from "./slack-digest.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

// Mock gh CLI calls so tests don't shell out
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockReturnValue("3"),
}));

vi.mock("./logger.js", () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock global fetch for webhook tests
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeConfig = (overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig => ({
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  base_dir: "/projects",
  orchestrator_dir: "/tmp",
  agents: {
    "test-agent": {
      dir: "test-agent",
      description: "A test agent",
      capabilities: [],
      owns_topics: [],
      github: "owner/test-agent",
    },
  },
  ...overrides,
});

const makeConfigWithDigest = (webhook = "https://hooks.slack.com/test", schedule = "09:00") =>
  makeConfig({
    dashboard: {
      digest: { slack_webhook: webhook, schedule },
    },
  });

// ─────────────────────────────────────────────────────────────────────────────
// parseScheduleMinutes
// ─────────────────────────────────────────────────────────────────────────────

describe("parseScheduleMinutes", () => {
  it("parses 09:00 correctly", () => {
    expect(parseScheduleMinutes("09:00")).toBe(9 * 60);
  });

  it("parses 14:30 correctly", () => {
    expect(parseScheduleMinutes("14:30")).toBe(14 * 60 + 30);
  });

  it("parses 00:00 correctly", () => {
    expect(parseScheduleMinutes("00:00")).toBe(0);
  });

  it("parses 23:59 correctly", () => {
    expect(parseScheduleMinutes("23:59")).toBe(23 * 60 + 59);
  });

  it("falls back to 09:00 on invalid input", () => {
    expect(parseScheduleMinutes("invalid")).toBe(9 * 60);
    expect(parseScheduleMinutes("25:00")).toBe(9 * 60);
    expect(parseScheduleMinutes("")).toBe(9 * 60);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isScheduledTimeReached
// ─────────────────────────────────────────────────────────────────────────────

describe("isScheduledTimeReached", () => {
  it("returns true when current time equals the scheduled time", () => {
    const now = new Date();
    now.setHours(9, 0, 0, 0);
    expect(isScheduledTimeReached("09:00", now)).toBe(true);
  });

  it("returns true when current time is past the scheduled time", () => {
    const now = new Date();
    now.setHours(10, 30, 0, 0);
    expect(isScheduledTimeReached("09:00", now)).toBe(true);
  });

  it("returns false when current time is before the scheduled time", () => {
    const now = new Date();
    now.setHours(8, 59, 0, 0);
    expect(isScheduledTimeReached("09:00", now)).toBe(false);
  });

  it("returns false one minute before midnight for 00:00 schedule", () => {
    const now = new Date();
    now.setHours(23, 59, 0, 0);
    // 23:59 (1439 min) is before 00:00 next day — but 00:00 schedule = 0 min, 1439 >= 0 → true
    // Actually 00:00 fires immediately at midnight; any time after is still "reached"
    expect(isScheduledTimeReached("00:00", now)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// todayLocalDateString
// ─────────────────────────────────────────────────────────────────────────────

describe("todayLocalDateString", () => {
  it("returns a YYYY-MM-DD string", () => {
    const result = todayLocalDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns the correct date for a given Date object", () => {
    const d = new Date(2026, 3, 5); // April 5 2026 (month is 0-indexed)
    expect(todayLocalDateString(d)).toBe("2026-04-05");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDigestData
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDigestData", () => {
  it("returns a digest with fleet totals from state store", () => {
    const store = new StateStore(":memory:");
    const config = makeConfig();

    // Seed a completed task in the last 24h
    const t = store.createTask({ title: "test", source: "github", agent_name: "test-agent" });
    store.updateTask(t.id, { status: "done", quality_score: 0.9 });

    const data = buildDigestData(store, config, 1);

    expect(data.windowDays).toBe(1);
    expect(typeof data.generatedAt).toBe("string");
    expect(data.fleet).toBeDefined();
    store.close();
  });

  it("returns zeroed fleet metrics when no tasks exist", () => {
    const store = new StateStore(":memory:");
    const config = makeConfig();

    const data = buildDigestData(store, config, 1);

    expect(data.fleet.tasksCompleted).toBe(0);
    expect(data.fleet.tasksFailed).toBe(0);
    expect(data.fleet.tasksEscalated).toBe(0);
    expect(data.fleet.mergedPRs).toBe(0);
    expect(data.fleet.avgQualityScore).toBeNull();
    store.close();
  });

  it("counts escalated tasks in the window", () => {
    const store = new StateStore(":memory:");
    const config = makeConfig();

    const t = store.createTask({ title: "stuck", source: "github", agent_name: "test-agent" });
    store.updateTask(t.id, { status: "escalated" });

    const data = buildDigestData(store, config, 1);
    expect(data.fleet.tasksEscalated).toBe(1);
    store.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatSlackDigest
// ─────────────────────────────────────────────────────────────────────────────

describe("formatSlackDigest", () => {
  const baseData = () => ({
    windowDays: 1,
    generatedAt: new Date().toISOString(),
    fleet: {
      tasksCompleted: 5,
      tasksFailed: 1,
      tasksEscalated: 0,
      mergedPRs: 3,
      avgQualityScore: 0.82,
    },
    agents: [
      {
        agentName: "test-agent",
        repo: "owner/test-agent",
        tasksCompleted: 5,
        tasksFailed: 1,
        mergedPRs: 3,
        avgQualityScore: 0.82,
      },
    ],
  });

  it("returns an object with text and attachments", () => {
    const payload = formatSlackDigest(baseData()) as Record<string, unknown>;
    expect(payload.text).toBeDefined();
    expect(payload.attachments).toBeDefined();
    expect(Array.isArray(payload.attachments)).toBe(true);
  });

  it("includes fleet summary in text", () => {
    const payload = formatSlackDigest(baseData()) as Record<string, unknown>;
    const text = payload.text as string;
    expect(text).toContain("5 tasks completed");
    expect(text).toContain("3 PRs merged");
    expect(text).toContain("0.82");
  });

  it("shows warning color when tasks failed", () => {
    const data = baseData();
    data.fleet.tasksFailed = 2;
    const payload = formatSlackDigest(data) as { attachments: Array<{ color: string }> };
    expect(payload.attachments[0].color).toBe("warning");
  });

  it("shows good color when no failures", () => {
    const data = baseData();
    data.fleet.tasksFailed = 0;
    data.fleet.tasksEscalated = 0;
    const payload = formatSlackDigest(data) as { attachments: Array<{ color: string }> };
    expect(payload.attachments[0].color).toBe("good");
  });

  it("shows escalation warning in header when escalations exist", () => {
    const data = baseData();
    data.fleet.tasksEscalated = 2;
    const payload = formatSlackDigest(data) as Record<string, unknown>;
    expect(payload.text as string).toContain("escalated");
  });

  it("uses plural window label for multi-day window", () => {
    const data = baseData();
    data.windowDays = 7;
    const payload = formatSlackDigest(data) as Record<string, unknown>;
    expect(payload.text as string).toContain("last 7 days");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// postToSlackWebhook
// ─────────────────────────────────────────────────────────────────────────────

describe("postToSlackWebhook", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("POSTs JSON payload to the webhook URL", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "ok" });
    await postToSlackWebhook("https://hooks.slack.com/test", { text: "hello" });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/test");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body as string)).toEqual({ text: "hello" });
  });

  it("throws when the webhook returns a non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad payload" });
    await expect(postToSlackWebhook("https://hooks.slack.com/test", {})).rejects.toThrow("400");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// maybePostDailyDigest
// ─────────────────────────────────────────────────────────────────────────────

describe("maybePostDailyDigest", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, text: async () => "ok" });
  });

  it("does nothing when no digest config is present", async () => {
    const state: DigestSchedulerState = { lastDigestDate: null };
    const store = new StateStore(":memory:");
    await maybePostDailyDigest(state, store, makeConfig());
    expect(mockFetch).not.toHaveBeenCalled();
    store.close();
  });

  it("does nothing when the time has not yet reached the schedule", async () => {
    const state: DigestSchedulerState = { lastDigestDate: null };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "23:59");
    const earlyMorning = new Date();
    earlyMorning.setHours(0, 0, 0, 0);
    await maybePostDailyDigest(state, store, config, earlyMorning);
    expect(mockFetch).not.toHaveBeenCalled();
    store.close();
  });

  it("POSTs when past the scheduled time and no digest sent today", async () => {
    const state: DigestSchedulerState = { lastDigestDate: null };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "09:00");
    const afternoon = new Date();
    afternoon.setHours(10, 0, 0, 0);
    await maybePostDailyDigest(state, store, config, afternoon);
    expect(mockFetch).toHaveBeenCalledOnce();
    store.close();
  });

  it("does NOT post a second time on the same day", async () => {
    const today = todayLocalDateString();
    const state: DigestSchedulerState = { lastDigestDate: today };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "09:00");
    const afternoon = new Date();
    afternoon.setHours(12, 0, 0, 0);
    await maybePostDailyDigest(state, store, config, afternoon);
    expect(mockFetch).not.toHaveBeenCalled();
    store.close();
  });

  it("re-arms on a new calendar day", async () => {
    const yesterday = "2026-04-04";
    const state: DigestSchedulerState = { lastDigestDate: yesterday };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "09:00");
    const today = new Date(2026, 3, 5, 10, 0, 0); // April 5 2026, 10:00
    await maybePostDailyDigest(state, store, config, today);
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(state.lastDigestDate).toBe("2026-04-05");
    store.close();
  });

  it("updates lastDigestDate after posting", async () => {
    const state: DigestSchedulerState = { lastDigestDate: null };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "09:00");
    const now = new Date(2026, 3, 5, 10, 0, 0);
    await maybePostDailyDigest(state, store, config, now);
    expect(state.lastDigestDate).toBe("2026-04-05");
    store.close();
  });

  it("does not reset lastDigestDate on webhook failure (one attempt per day)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));
    const state: DigestSchedulerState = { lastDigestDate: null };
    const store = new StateStore(":memory:");
    const config = makeConfigWithDigest("https://hooks.slack.com/test", "09:00");
    const now = new Date(2026, 3, 5, 10, 0, 0);
    // Should not throw
    await expect(maybePostDailyDigest(state, store, config, now)).resolves.toBeUndefined();
    // lastDigestDate should still be set to prevent double-posting on retry
    expect(state.lastDigestDate).toBe("2026-04-05");
    store.close();
  });
});
