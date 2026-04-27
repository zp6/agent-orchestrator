/**
 * Tests for variant-pair deduplication report (issue #1270)
 *
 * Covers:
 *   - canonicalVariantSibling: Claude↔Codex name mapping
 *   - normalisedVariantPair: canonical ordering
 *   - extractRepo / extractIssue: source_ref parsing
 *   - getVariantDuplicatesPayload: end-to-end collision detection
 *   - formatVariantDuplicatesForTelegram: Telegram output
 */

import { describe, it, expect } from "vitest";
import {
  canonicalVariantSibling,
  normalisedVariantPair,
  extractRepo,
  extractIssue,
  getVariantDuplicatesPayload,
  formatVariantDuplicatesForTelegram,
  DISPATCH_WINDOW_MS,
  type VariantDuplicatesPayload,
} from "./variant-deduplication.js";
import type { StateStore } from "../state/store.js";

// ── Unit tests: pure helpers ───────────────────────────────────────────────────

describe("canonicalVariantSibling", () => {
  it("maps claude- prefix to codex-", () => {
    expect(canonicalVariantSibling("claude-proxy")).toBe("codex-proxy");
    expect(canonicalVariantSibling("claude-agent-orchestrator")).toBe("codex-agent-orchestrator");
  });

  it("maps codex- prefix to claude-", () => {
    expect(canonicalVariantSibling("codex-proxy")).toBe("claude-proxy");
    expect(canonicalVariantSibling("codex-agent-orchestrator")).toBe("claude-agent-orchestrator");
  });

  it("returns null for unrecognised prefixes", () => {
    expect(canonicalVariantSibling("research-agent")).toBeNull();
    expect(canonicalVariantSibling("meeting-facilitator")).toBeNull();
    expect(canonicalVariantSibling("")).toBeNull();
  });
});

describe("normalisedVariantPair", () => {
  it("puts the claude- variant first", () => {
    expect(normalisedVariantPair("claude-proxy", "codex-proxy")).toEqual(["claude-proxy", "codex-proxy"]);
    expect(normalisedVariantPair("codex-proxy", "claude-proxy")).toEqual(["claude-proxy", "codex-proxy"]);
  });
});

describe("extractRepo / extractIssue", () => {
  it("splits owner/repo#N correctly", () => {
    expect(extractRepo("rapartlu/agent-proxy#478")).toBe("rapartlu/agent-proxy");
    expect(extractIssue("rapartlu/agent-proxy#478")).toBe("478");
  });

  it("handles missing hash gracefully", () => {
    expect(extractRepo("rapartlu/agent-proxy")).toBe("rapartlu/agent-proxy");
    expect(extractIssue("rapartlu/agent-proxy")).toBe("");
  });
});

// ── Integration: getVariantDuplicatesPayload ───────────────────────────────────

/** Build a minimal StateStore mock with a typed db.prepare chain. */
function buildMockStore(rows: Array<{
  id?: string;
  title?: string;
  source_ref: string;
  agent_name: string;
  created_at: string;
}>): StateStore {
  return {
    db: {
      prepare: (_sql: string) => ({
        all: (_window: string) => rows,
      }),
    },
  } as unknown as StateStore;
}

describe("getVariantDuplicatesPayload", () => {
  it("returns empty payload when no tasks exist", () => {
    const store = buildMockStore([]);
    const payload = getVariantDuplicatesPayload(store, 24);

    expect(payload.pairs).toHaveLength(0);
    expect(payload.total_pairs).toBe(0);
    expect(payload.total_redundant_tasks).toBe(0);
    expect(payload.window_hours).toBe(24);
    expect(payload.generated_at).toBeTruthy();
  });

  it("detects a single variant-pair collision within the dispatch window", () => {
    const now = new Date();
    const t1 = new Date(now.getTime() - 30 * 60 * 1000).toISOString(); // 30 min ago
    const t2 = new Date(now.getTime() - 25 * 60 * 1000).toISOString(); // 25 min ago

    const store = buildMockStore([
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "claude-proxy", created_at: t1 },
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "codex-proxy", created_at: t2 },
    ]);

    const payload = getVariantDuplicatesPayload(store, 24);

    expect(payload.total_pairs).toBe(1);
    const pair = payload.pairs[0]!;
    expect(pair.source_ref).toBe("rapartlu/agent-proxy#478");
    expect(pair.repo).toBe("rapartlu/agent-proxy");
    expect(pair.issue).toBe("478");
    expect(pair.variant_a).toBe("claude-proxy");
    expect(pair.variant_b).toBe("codex-proxy");
    expect(pair.event_count).toBe(1);
    expect(pair.redundant_tasks).toBe(2);
  });

  it("does NOT count hits that are more than DISPATCH_WINDOW_MS apart", () => {
    const now = new Date();
    const t1 = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString(); // 4h ago
    const t2 = new Date(now.getTime() - 30 * 60 * 1000).toISOString();      // 30 min ago

    const store = buildMockStore([
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "claude-proxy", created_at: t1 },
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "codex-proxy", created_at: t2 },
    ]);

    const payload = getVariantDuplicatesPayload(store, 24);

    // The gap is 3.5h which exceeds the 2h DISPATCH_WINDOW_MS — no collision
    expect(payload.total_pairs).toBe(0);
  });

  it("counts multiple distinct collision events on the same issue", () => {
    const now = new Date();
    // Two separate collision events: one 5h ago and one 1h ago
    const tA1 = new Date(now.getTime() - 5.0 * 3600_000).toISOString();
    const tB1 = new Date(now.getTime() - 4.8 * 3600_000).toISOString();
    const tA2 = new Date(now.getTime() - 1.0 * 3600_000).toISOString();
    const tB2 = new Date(now.getTime() - 0.8 * 3600_000).toISOString();

    const store = buildMockStore([
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "claude-proxy", created_at: tA1 },
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "codex-proxy",  created_at: tB1 },
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "claude-proxy", created_at: tA2 },
      { source_ref: "rapartlu/agent-proxy#478", agent_name: "codex-proxy",  created_at: tB2 },
    ]);

    const payload = getVariantDuplicatesPayload(store, 24);

    expect(payload.total_pairs).toBe(1);
    const pair = payload.pairs[0]!;
    expect(pair.event_count).toBe(2);
    expect(pair.redundant_tasks).toBe(4);
  });

  it("handles multiple different issues and returns pairs sorted by event_count desc", () => {
    const now = new Date();
    const t = (offsetMin: number) => new Date(now.getTime() - offsetMin * 60_000).toISOString();

    const store = buildMockStore([
      // issue #478: 2 collision events
      { source_ref: "owner/repo#478", agent_name: "claude-proxy", created_at: t(300) },
      { source_ref: "owner/repo#478", agent_name: "codex-proxy",  created_at: t(295) },
      { source_ref: "owner/repo#478", agent_name: "claude-proxy", created_at: t(60) },
      { source_ref: "owner/repo#478", agent_name: "codex-proxy",  created_at: t(55) },
      // issue #480: 1 collision event
      { source_ref: "owner/repo#480", agent_name: "claude-proxy", created_at: t(30) },
      { source_ref: "owner/repo#480", agent_name: "codex-proxy",  created_at: t(25) },
    ]);

    const payload = getVariantDuplicatesPayload(store, 24);

    expect(payload.total_pairs).toBe(2);
    expect(payload.total_redundant_tasks).toBe(6); // 4 + 2
    // Sorted by event_count desc
    expect(payload.pairs[0]!.source_ref).toBe("owner/repo#478");
    expect(payload.pairs[0]!.event_count).toBe(2);
    expect(payload.pairs[1]!.source_ref).toBe("owner/repo#480");
    expect(payload.pairs[1]!.event_count).toBe(1);
  });

  it("ignores single-variant guard hits with no sibling", () => {
    const now = new Date();
    const store = buildMockStore([
      { source_ref: "owner/repo#100", agent_name: "claude-proxy", created_at: now.toISOString() },
      // research-agent is not a variant pair
      { source_ref: "owner/repo#101", agent_name: "research-agent", created_at: now.toISOString() },
    ]);

    const payload = getVariantDuplicatesPayload(store, 24);
    expect(payload.total_pairs).toBe(0);
  });

  it("clamps window_hours to MAX_WINDOW_HOURS", () => {
    const store = buildMockStore([]);
    const payload = getVariantDuplicatesPayload(store, 99999);
    expect(payload.window_hours).toBe(720);
  });

  it("clamps window_hours minimum to 1", () => {
    const store = buildMockStore([]);
    const payload = getVariantDuplicatesPayload(store, 0);
    expect(payload.window_hours).toBe(1);
  });
});

// ── Unit: formatVariantDuplicatesForTelegram ──────────────────────────────────

describe("formatVariantDuplicatesForTelegram", () => {
  it("returns a 'no collisions' message for empty payload", () => {
    const payload: VariantDuplicatesPayload = {
      window_hours: 24,
      pairs: [],
      total_pairs: 0,
      total_redundant_tasks: 0,
      generated_at: new Date().toISOString(),
    };
    const msg = formatVariantDuplicatesForTelegram(payload);
    expect(msg).toContain("No variant-pair guard collisions");
    expect(msg).toContain("24h");
  });

  it("includes pair details for non-empty payloads", () => {
    const payload: VariantDuplicatesPayload = {
      window_hours: 48,
      pairs: [
        {
          repo: "rapartlu/agent-proxy",
          issue: "478",
          source_ref: "rapartlu/agent-proxy#478",
          variant_a: "claude-proxy",
          variant_b: "codex-proxy",
          event_count: 3,
          redundant_tasks: 6,
          last_seen: new Date().toISOString(),
        },
      ],
      total_pairs: 1,
      total_redundant_tasks: 6,
      generated_at: new Date().toISOString(),
    };
    const msg = formatVariantDuplicatesForTelegram(payload);
    expect(msg).toContain("rapartlu/agent-proxy#478");
    expect(msg).toContain("claude-proxy");
    expect(msg).toContain("codex-proxy");
    expect(msg).toContain("3 events");
    expect(msg).toContain("6 redundant tasks");
    expect(msg).toContain("48h");
  });

  it("shows truncation notice when more than 10 pairs", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({
      repo: "owner/repo",
      issue: String(i + 1),
      source_ref: `owner/repo#${i + 1}`,
      variant_a: "claude-proxy",
      variant_b: "codex-proxy",
      event_count: 1,
      redundant_tasks: 2,
      last_seen: new Date().toISOString(),
    }));
    const payload: VariantDuplicatesPayload = {
      window_hours: 24,
      pairs,
      total_pairs: 12,
      total_redundant_tasks: 24,
      generated_at: new Date().toISOString(),
    };
    const msg = formatVariantDuplicatesForTelegram(payload);
    expect(msg).toContain("2 more pairs");
  });
});
