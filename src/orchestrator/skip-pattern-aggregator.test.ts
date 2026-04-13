/**
 * Tests for skip-pattern-aggregator (issue #787) — Telegram alert integration
 * tests for issue #795.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normaliseReasonKey,
  SYSTEMIC_SKIP_THRESHOLD,
  SKIP_PATTERN_WINDOW_DAYS,
} from "./skip-pattern-aggregator.js";

// ── Module-level mocks ─────────────────────────────────────────────────────

// Mock notifyOperator before any module imports so the static import in
// skip-pattern-aggregator.ts is intercepted.
const mockNotifyOperator = vi.fn().mockResolvedValue(undefined);
vi.mock("../service/notify.js", () => ({
  notifyOperator: (...args: unknown[]) => mockNotifyOperator(...args),
}));

// Mock IssueCreator so gh CLI is not required in tests.
const mockCreateIssue = vi.fn();
const mockIsDuplicate = vi.fn().mockReturnValue(false);
vi.mock("./issue-creator.js", () => {
  function IssueCreator() {}
  IssueCreator.prototype.createIssue = (...args: unknown[]) => mockCreateIssue(...args);
  IssueCreator.prototype.isDuplicate = (...args: unknown[]) => mockIsDuplicate(...args);
  return { IssueCreator };
});

// Import after mocks are in place.
const { runSkipPatternCheck } = await import("./skip-pattern-aggregator.js");

// ── normaliseReasonKey ─────────────────────────────────────────────────────

describe("normaliseReasonKey", () => {
  it("lowercases and normalises whitespace", () => {
    expect(normaliseReasonKey("Agent Degraded")).toBe("agent degraded");
  });

  it("strips special characters", () => {
    expect(normaliseReasonKey("no agent! (available)")).toBe("no agent available");
  });

  it("truncates to 120 characters", () => {
    const long = "a".repeat(200);
    expect(normaliseReasonKey(long)).toHaveLength(120);
  });

  it("collapses minor phrasing differences to the same key", () => {
    expect(normaliseReasonKey("Agent is degraded")).toBe(
      normaliseReasonKey("agent is degraded"),
    );
  });
});

// ── runSkipPatternCheck ────────────────────────────────────────────────────

function makeStore(patterns = [], activeKeys: Set<string> = new Set()) {
  return {
    getSkipPatterns: vi.fn().mockReturnValue(patterns),
    getActiveSkipPatternIssueKeys: vi.fn().mockReturnValue(activeKeys),
    recordSkipPatternIssue: vi.fn(),
  };
}

function makeConfig() {
  return { github: { token: "tok" } } as never;
}

describe("runSkipPatternCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsDuplicate.mockReturnValue(false);
  });

  it("returns 0 when all patterns are below the threshold", async () => {
    const store = makeStore([
      {
        reason: "minor skip",
        skip_count: SYSTEMIC_SKIP_THRESHOLD - 1,
        affected_agents: [],
        sample_issue_refs: [],
        first_seen: "2026-04-01",
        last_seen: "2026-04-10",
      },
    ]);

    const created = await runSkipPatternCheck(makeConfig(), store as never);
    expect(created).toBe(0);
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("returns 0 when all over-threshold patterns already have active issues", async () => {
    const reason = "no healthy agent available";
    const key = normaliseReasonKey(reason);
    const store = makeStore(
      [
        {
          reason,
          skip_count: SYSTEMIC_SKIP_THRESHOLD + 2,
          affected_agents: ["claude-proxy"],
          sample_issue_refs: ["rapartlu/agent-proxy#10"],
          first_seen: "2026-04-01",
          last_seen: "2026-04-10",
        },
      ],
      new Set([key]),
    );

    const created = await runSkipPatternCheck(makeConfig(), store as never);
    expect(created).toBe(0);
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("creates an issue and fires notifyOperator for a new blocker", async () => {
    const issueUrl = "https://github.com/rapartlu/agent-orchestrator/issues/999";
    mockCreateIssue.mockReturnValue({ number: 999, url: issueUrl, repo: "rapartlu/agent-orchestrator" });

    const reason = "no healthy agent available";
    const skipCount = SYSTEMIC_SKIP_THRESHOLD + 3;
    const store = makeStore([
      {
        reason,
        skip_count: skipCount,
        affected_agents: ["claude-proxy"],
        sample_issue_refs: ["rapartlu/agent-proxy#10"],
        first_seen: "2026-04-01",
        last_seen: "2026-04-10",
      },
    ]);

    const created = await runSkipPatternCheck(makeConfig(), store as never);
    expect(created).toBe(1);
    expect(mockNotifyOperator).toHaveBeenCalledOnce();

    const [title, body, urgency, rateLimitKey] = mockNotifyOperator.mock.calls[0];
    expect(title).toBe("Systemic skip pattern detected");
    expect(body).toContain(reason);
    expect(body).toContain(String(skipCount));
    expect(body).toContain(String(SKIP_PATTERN_WINDOW_DAYS));
    expect(body).toContain(issueUrl);
    expect(urgency).toBe("warning");
    expect(rateLimitKey).toMatch(/^skip-blocker-/);
  });

  it("uses a per-reason rate-limit key so different blockers get separate alerts", async () => {
    mockCreateIssue
      .mockReturnValueOnce({ number: 901, url: "https://github.com/rapartlu/agent-orchestrator/issues/901", repo: "rapartlu/agent-orchestrator" })
      .mockReturnValueOnce({ number: 902, url: "https://github.com/rapartlu/agent-orchestrator/issues/902", repo: "rapartlu/agent-orchestrator" });

    const store = makeStore([
      {
        reason: "auth token expired",
        skip_count: 10,
        affected_agents: ["claude-proxy"],
        sample_issue_refs: [],
        first_seen: "2026-04-01",
        last_seen: "2026-04-10",
      },
      {
        reason: "no capacity in queue",
        skip_count: 8,
        affected_agents: ["claude-agent-orchestrator"],
        sample_issue_refs: [],
        first_seen: "2026-04-02",
        last_seen: "2026-04-10",
      },
    ]);

    const created = await runSkipPatternCheck(makeConfig(), store as never);
    expect(created).toBe(2);
    expect(mockNotifyOperator).toHaveBeenCalledTimes(2);

    const keys = mockNotifyOperator.mock.calls.map((call) => call[3] as string);
    expect(keys[0]).toMatch(/^skip-blocker-/);
    expect(keys[1]).toMatch(/^skip-blocker-/);
    // Each reason must produce a distinct rate-limit key
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("does not fire notifyOperator when issue creation fails", async () => {
    mockCreateIssue.mockImplementation(() => { throw new Error("gh CLI unavailable"); });

    const store = makeStore([
      {
        reason: "failing reason",
        skip_count: SYSTEMIC_SKIP_THRESHOLD + 1,
        affected_agents: [],
        sample_issue_refs: [],
        first_seen: "2026-04-01",
        last_seen: "2026-04-10",
      },
    ]);

    const created = await runSkipPatternCheck(makeConfig(), store as never);
    expect(created).toBe(0);
    // Telegram alert must NOT fire if the GitHub issue was not created
    expect(mockNotifyOperator).not.toHaveBeenCalled();
  });

  it("records the new issue in the state store", async () => {
    const issueUrl = "https://github.com/rapartlu/agent-orchestrator/issues/888";
    mockCreateIssue.mockReturnValue({ number: 888, url: issueUrl, repo: "rapartlu/agent-orchestrator" });

    const reason = "auth degraded";
    const store = makeStore([
      {
        reason,
        skip_count: SYSTEMIC_SKIP_THRESHOLD + 1,
        affected_agents: ["claude-proxy"],
        sample_issue_refs: [],
        first_seen: "2026-04-01",
        last_seen: "2026-04-10",
      },
    ]);

    await runSkipPatternCheck(makeConfig(), store as never);

    expect(store.recordSkipPatternIssue).toHaveBeenCalledWith({
      reason_key: normaliseReasonKey(reason),
      issue_number: 888,
      issue_url: issueUrl,
      repo: "rapartlu/agent-orchestrator",
    });
  });
});
