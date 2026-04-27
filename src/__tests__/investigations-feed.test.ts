/**
 * Tests for investigations-feed.ts (issue #134).
 *
 * Covers:
 *  - getInvestigationsFeedPayload: empty list, counts, ordering, field mapping
 *  - formatInvestigationsForTelegram: empty, active only, pending only, complete,
 *    mixed, finding summary truncation, score display, result issue URL, Markdown escaping
 */

import { describe, it, expect } from "vitest";
import {
  getInvestigationsFeedPayload,
  formatInvestigationsForTelegram,
  MAX_COMPLETE_IN_TELEGRAM,
  MAX_RECENT_COMPLETE,
} from "../reviewer/investigations-feed.js";
import type { Investigation } from "../reviewer/research-investigation-client.js";

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeInv(overrides: Partial<Investigation> = {}): Investigation {
  return {
    id: "01INV0001",
    title: "Evaluate caching strategies",
    research_question: "What caching options reduce token spend the most?",
    status: "pending",
    created_at: "2026-04-22T10:00:00.000Z",
    updated_at: "2026-04-22T10:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getInvestigationsFeedPayload
// ---------------------------------------------------------------------------

describe("getInvestigationsFeedPayload", () => {
  it("returns zero counts for empty list", () => {
    const payload = getInvestigationsFeedPayload([]);
    expect(payload.counts).toEqual({
      pending: 0,
      active: 0,
      complete: 0,
      cancelled: 0,
      total: 0,
    });
    expect(payload.active).toHaveLength(0);
    expect(payload.pending).toHaveLength(0);
    expect(payload.recent_complete).toHaveLength(0);
    expect(payload.generated_at).toBeTruthy();
  });

  it("counts by status correctly", () => {
    const list: Investigation[] = [
      makeInv({ id: "a1", status: "pending" }),
      makeInv({ id: "a2", status: "pending" }),
      makeInv({ id: "a3", status: "active" }),
      makeInv({ id: "a4", status: "complete" }),
      makeInv({ id: "a5", status: "cancelled" }),
    ];
    const payload = getInvestigationsFeedPayload(list);
    expect(payload.counts).toEqual({
      pending: 2,
      active: 1,
      complete: 1,
      cancelled: 1,
      total: 5,
    });
  });

  it("maps investigation fields into summaries", () => {
    const inv = makeInv({
      id: "b1",
      status: "complete",
      finding_summary: "Caching reduces spend by 70%.",
      score: 91,
      result_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/99",
      source_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/50",
    });
    const payload = getInvestigationsFeedPayload([inv]);
    const summary = payload.recent_complete[0];
    expect(summary).toBeDefined();
    expect(summary!.id).toBe("b1");
    expect(summary!.status).toBe("complete");
    expect(summary!.finding_summary).toBe("Caching reduces spend by 70%.");
    expect(summary!.score).toBe(91);
    expect(summary!.result_issue_url).toBe("https://github.com/rapartlu/agent-orchestrator/issues/99");
    expect(summary!.source_issue_url).toBe("https://github.com/rapartlu/agent-orchestrator/issues/50");
  });

  it("omits optional fields when absent", () => {
    const inv = makeInv({ id: "c1", status: "active" });
    const payload = getInvestigationsFeedPayload([inv]);
    const summary = payload.active[0];
    expect(summary).toBeDefined();
    expect(summary!.finding_summary).toBeUndefined();
    expect(summary!.score).toBeUndefined();
    expect(summary!.result_issue_url).toBeUndefined();
    expect(summary!.source_issue_url).toBeUndefined();
  });

  it("caps recent_complete at MAX_RECENT_COMPLETE", () => {
    const list: Investigation[] = Array.from({ length: MAX_RECENT_COMPLETE + 5 }, (_, i) =>
      makeInv({
        id: `d${i}`,
        status: "complete",
        updated_at: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    const payload = getInvestigationsFeedPayload(list);
    expect(payload.recent_complete).toHaveLength(MAX_RECENT_COMPLETE);
  });

  it("sorts active and pending by updated_at descending", () => {
    const list: Investigation[] = [
      makeInv({ id: "e1", status: "active", updated_at: "2026-04-22T08:00:00.000Z" }),
      makeInv({ id: "e2", status: "active", updated_at: "2026-04-22T10:00:00.000Z" }),
      makeInv({ id: "e3", status: "active", updated_at: "2026-04-22T09:00:00.000Z" }),
    ];
    const payload = getInvestigationsFeedPayload(list);
    expect(payload.active.map((s) => s.id)).toEqual(["e2", "e3", "e1"]);
  });

  it("includes generated_at timestamp", () => {
    const before = new Date();
    const payload = getInvestigationsFeedPayload([]);
    const after = new Date();
    const ts = new Date(payload.generated_at);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 100);
  });
});

// ---------------------------------------------------------------------------
// formatInvestigationsForTelegram
// ---------------------------------------------------------------------------

describe("formatInvestigationsForTelegram", () => {
  it("returns no-investigations message for empty list", () => {
    const msg = formatInvestigationsForTelegram([]);
    expect(msg).toContain("No active investigations");
    expect(msg).toContain("🔬");
  });

  it("returns no-investigations message when all are cancelled", () => {
    const list = [makeInv({ status: "cancelled" }), makeInv({ status: "cancelled" })];
    const msg = formatInvestigationsForTelegram(list);
    expect(msg).toContain("No active investigations");
  });

  it("shows active investigations with title and start time", () => {
    const inv = makeInv({
      status: "active",
      title: "Rate limiting patterns",
      updated_at: "2026-04-22T14:35:00.000Z",
    });
    const msg = formatInvestigationsForTelegram([inv]);
    expect(msg).toContain("Active");
    expect(msg).toContain("Rate limiting patterns");
    expect(msg).toContain("2026-04-22 14:35 UTC");
  });

  it("shows pending investigations with title and queue time", () => {
    const inv = makeInv({
      status: "pending",
      title: "Evaluate LLM caching",
      created_at: "2026-04-22T09:00:00.000Z",
    });
    const msg = formatInvestigationsForTelegram([inv]);
    expect(msg).toContain("Pending");
    expect(msg).toContain("Evaluate LLM caching");
    expect(msg).toContain("2026-04-22 09:00 UTC");
  });

  it("shows completed investigations with finding summary and result URL", () => {
    const inv = makeInv({
      status: "complete",
      title: "Caching research",
      finding_summary: "Caching saves 70% on long prompts.",
      result_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/99",
      score: 91,
      updated_at: "2026-04-22T16:00:00.000Z",
    });
    const msg = formatInvestigationsForTelegram([inv]);
    expect(msg).toContain("Completed");
    expect(msg).toContain("Caching research");
    expect(msg).toContain("Caching saves 70% on long prompts.");
    expect(msg).toContain("https://github.com/rapartlu/agent-orchestrator/issues/99");
    expect(msg).toContain("91/100");
  });

  it("truncates long finding summaries to 120 characters", () => {
    const longSummary = "A".repeat(150);
    const inv = makeInv({ status: "complete", finding_summary: longSummary });
    const msg = formatInvestigationsForTelegram([inv]);
    expect(msg).toContain("…");
    // The truncated summary + ellipsis should appear
    expect(msg).toContain("A".repeat(117));
  });

  it("shows source_issue_url for active and pending investigations", () => {
    const active = makeInv({
      status: "active",
      source_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/55",
    });
    const pending = makeInv({
      status: "pending",
      source_issue_url: "https://github.com/rapartlu/agent-orchestrator/issues/56",
    });
    const msg = formatInvestigationsForTelegram([active, pending]);
    expect(msg).toContain("https://github.com/rapartlu/agent-orchestrator/issues/55");
    expect(msg).toContain("https://github.com/rapartlu/agent-orchestrator/issues/56");
  });

  it("caps completed section at MAX_COMPLETE_IN_TELEGRAM", () => {
    const list: Investigation[] = Array.from({ length: MAX_COMPLETE_IN_TELEGRAM + 3 }, (_, i) =>
      makeInv({
        id: `f${i}`,
        status: "complete",
        title: `Investigation ${i}`,
        updated_at: new Date(Date.now() - i * 1000).toISOString(),
      }),
    );
    const msg = formatInvestigationsForTelegram(list);
    // Should mention the total count
    const total = MAX_COMPLETE_IN_TELEGRAM + 3;
    expect(msg).toContain(`showing ${MAX_COMPLETE_IN_TELEGRAM} of ${total}`);
  });

  it("does not show 'showing N of M' suffix when all fit", () => {
    const list: Investigation[] = Array.from({ length: MAX_COMPLETE_IN_TELEGRAM }, (_, i) =>
      makeInv({ id: `g${i}`, status: "complete" }),
    );
    const msg = formatInvestigationsForTelegram(list);
    expect(msg).not.toContain("showing");
  });

  it("handles mixed statuses correctly (active + pending + complete)", () => {
    const list: Investigation[] = [
      makeInv({ id: "h1", status: "active", title: "Active work" }),
      makeInv({ id: "h2", status: "pending", title: "Queued work" }),
      makeInv({ id: "h3", status: "complete", title: "Done work", finding_summary: "Found it." }),
      makeInv({ id: "h4", status: "cancelled", title: "Dropped" }),
    ];
    const msg = formatInvestigationsForTelegram(list);
    expect(msg).toContain("Active");
    expect(msg).toContain("Active work");
    expect(msg).toContain("Pending");
    expect(msg).toContain("Queued work");
    expect(msg).toContain("Completed");
    expect(msg).toContain("Done work");
    // Cancelled should not appear
    expect(msg).not.toContain("Dropped");
  });

  it("includes optional agentLabel in header", () => {
    const msg = formatInvestigationsForTelegram(
      [makeInv({ status: "active" })],
      "http://localhost:3478",
    );
    expect(msg).toContain("http://localhost:3478");
  });

  it("escapes Markdown special characters in titles", () => {
    const inv = makeInv({
      status: "active",
      title: "Rate *limiting* & [patterns]",
    });
    const msg = formatInvestigationsForTelegram([inv]);
    // Asterisks should be escaped so they don't break Markdown
    expect(msg).toContain("\\*limiting\\*");
  });
});
