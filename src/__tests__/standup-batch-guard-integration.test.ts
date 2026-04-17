/**
 * Integration tests: standup-dispatch-guard + standup-batch-splitter — issue #259
 *
 * Verifies that shouldSkipStandupDispatch() correctly detects large standups
 * and populates shouldSplit + batches on the returned decision.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { execSync } from "child_process";
import { shouldSkipStandupDispatch } from "../reviewer/standup-dispatch-guard.js";

vi.mock("child_process");
vi.mock("../service/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const execSyncMock = execSync as unknown as ReturnType<typeof vi.fn>;

/** Build a standup issue JSON body with N action items of given priority. */
function buildLargeStandupIssueJson(actionItems: number, priority = "HIGH"): string {
  const bullets = Array.from({ length: actionItems }, (_, i) =>
    `- [${priority}] Action item ${i + 1}`,
  ).join("\n");

  return JSON.stringify({
    number: 703,
    title: "[📋 Standup] Daily standup 2026-04-17",
    body: `### Action Items\n${bullets}`,
    labels: [{ name: "standup" }],
    state: "OPEN",
  });
}

/** Build a standup with mixed priorities. */
function buildMixedPriorityStandupJson(counts: { HIGH: number; MEDIUM: number; LOW: number }): string {
  const bullets: string[] = [];
  for (let i = 0; i < counts.HIGH; i++) bullets.push(`- [HIGH] High item ${i + 1}`);
  for (let i = 0; i < counts.MEDIUM; i++) bullets.push(`- [MEDIUM] Medium item ${i + 1}`);
  for (let i = 0; i < counts.LOW; i++) bullets.push(`- [LOW] Low item ${i + 1}`);

  return JSON.stringify({
    number: 703,
    title: "[📋 Standup] Daily standup 2026-04-17",
    body: `### Action Items\n${bullets.join("\n")}`,
    labels: [{ name: "standup" }],
    state: "OPEN",
  });
}

describe("shouldSkipStandupDispatch — batch splitting (issue #259)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns shouldSplit=false for standup with exactly 5 items", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(5));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.skip).toBe(false);
    expect(result.shouldSplit).toBeFalsy();
    expect(result.batches).toBeUndefined();
    expect(result.actionItemCount).toBe(5);
  });

  it("returns shouldSplit=false for standup with 3 items", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(3));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.skip).toBe(false);
    expect(result.shouldSplit).toBeFalsy();
  });

  it("returns shouldSplit=true for standup with 6 items — 2 batches", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(6));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.skip).toBe(false);
    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(2);
    expect(result.batches![0].items).toHaveLength(3);
    expect(result.batches![1].items).toHaveLength(3);
  });

  it("returns correct batch count for 9-item standup — 3 batches of 3", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(9));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(3);
    expect(result.batches!.every(b => b.items.length === 3)).toBe(true);
  });

  it("returns correct batch count for 7-item standup — 3 batches (3, 3, 1)", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(7));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(3);
    expect(result.batches![0].items).toHaveLength(3);
    expect(result.batches![1].items).toHaveLength(3);
    expect(result.batches![2].items).toHaveLength(1);
  });

  it("populates parentIssueRef on all batches from repo + issue number", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(6));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.shouldSplit).toBe(true);
    for (const batch of result.batches!) {
      expect(batch.parentIssueRef).toBe("rapartlu/agent-reviewer#703");
    }
  });

  it("sorts items HIGH → MEDIUM → LOW within batches for mixed priority standup", async () => {
    // 3 HIGH + 2 MEDIUM + 1 LOW = 6 items → 2 batches
    execSyncMock.mockImplementationOnce(() =>
      buildMixedPriorityStandupJson({ HIGH: 3, MEDIUM: 2, LOW: 1 }),
    );

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.shouldSplit).toBe(true);
    // First batch should be all 3 HIGH items
    expect(result.batches![0].items.every(i => i.priority === "HIGH")).toBe(true);
    // Second batch: 2 MEDIUM + 1 LOW
    expect(result.batches![1].items[0].priority).toBe("MEDIUM");
    expect(result.batches![1].items[1].priority).toBe("MEDIUM");
    expect(result.batches![1].items[2].priority).toBe("LOW");
  });

  it("reason string mentions split when shouldSplit is true", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(6));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.reason.toLowerCase()).toMatch(/split|batch/);
  });

  it("skip remains false even when shouldSplit is true", async () => {
    execSyncMock.mockImplementationOnce(() => buildLargeStandupIssueJson(9));

    const result = await shouldSkipStandupDispatch("rapartlu/agent-reviewer", 703);

    expect(result.skip).toBe(false);
    expect(result.shouldSplit).toBe(true);
  });
});
