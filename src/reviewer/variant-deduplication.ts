/**
 * Variant-Pair Deduplication Report — issue #1270
 *
 * Detects cases where both members of a Claude/Codex variant pair independently
 * hit the "already-in-review" guard for the same issue within a single dispatch
 * window, producing redundant guard tasks.
 *
 * Example: `claude-proxy` and `codex-proxy` both hitting the guard for
 * `agent-proxy#478` within two hours — four of these clustered events in a
 * batch triggered this improvement.
 *
 * The report answers: "which (repo, issue) combinations routinely trigger dual-
 * variant dispatch?" so operators can tune routing rules upstream to suppress
 * the redundant dispatches before they reach the guard.
 *
 * Exported API:
 *   getVariantDuplicatesPayload(store, windowHours) → VariantDuplicatesPayload
 *   formatVariantDuplicatesForTelegram(payload)     → Telegram Markdown string
 *
 * REST surface (mounted by caller):
 *   GET /api/variant-duplicate-dispatch?hours=N
 */

import type { StateStore } from "../state/store.js";
import type { Task } from "../state/types.js";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Default look-back window: 24 hours. */
export const DEFAULT_WINDOW_HOURS = 24;

/** Maximum look-back window: 720 hours (30 days). */
export const MAX_WINDOW_HOURS = 720;

/**
 * Maximum time gap (ms) between two variant guard hits on the same issue for
 * them to be counted as a single collision event.  2 hours reflects a single
 * daemon poll-cycle window.
 */
export const DISPATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────────

/** A single variant-pair collision: both pool siblings hit the guard on one issue. */
export interface VariantDuplicatePair {
  /** "owner/repo" extracted from source_ref. */
  repo: string;
  /** Issue number (numeric string). */
  issue: string;
  /** Full source_ref, e.g. "rapartlu/agent-proxy#478". */
  source_ref: string;
  /** Claude-family variant agent name, e.g. "claude-proxy". */
  variant_a: string;
  /** Codex-family variant agent name, e.g. "codex-proxy". */
  variant_b: string;
  /**
   * Number of distinct collision events in the window (each event = both
   * siblings hitting the guard within DISPATCH_WINDOW_MS of each other).
   */
  event_count: number;
  /**
   * Total redundant guard tasks: 2 × event_count (one per variant per event).
   */
  redundant_tasks: number;
  /** ISO timestamp of the most recent collision. */
  last_seen: string;
}

/** Full response payload. */
export interface VariantDuplicatesPayload {
  window_hours: number;
  pairs: VariantDuplicatePair[];
  total_pairs: number;
  total_redundant_tasks: number;
  generated_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Given an agent name, return its canonical pool-sibling name.
 *
 * Pool siblings share the same suffix after the first segment:
 *   claude-proxy          ↔  codex-proxy
 *   claude-agent-foo      ↔  codex-agent-foo
 *   codex-orchestrator-x  ↔  claude-orchestrator-x
 *
 * Returns null if the name doesn't start with "claude-" or "codex-".
 */
export function canonicalVariantSibling(agentName: string): string | null {
  if (agentName.startsWith("claude-")) {
    return "codex-" + agentName.slice("claude-".length);
  }
  if (agentName.startsWith("codex-")) {
    return "claude-" + agentName.slice("codex-".length);
  }
  return null;
}

/**
 * Normalise an agent-name pair so (claude-X, codex-X) and (codex-X, claude-X)
 * both produce the same canonical form: [claude-X, codex-X].
 */
export function normalisedVariantPair(a: string, b: string): [string, string] {
  if (a.startsWith("claude-")) return [a, b];
  return [b, a];
}

/** Extract "owner/repo" from "owner/repo#N". */
export function extractRepo(sourceRef: string): string {
  const idx = sourceRef.indexOf("#");
  return idx >= 0 ? sourceRef.slice(0, idx) : sourceRef;
}

/** Extract issue number string from "owner/repo#N". */
export function extractIssue(sourceRef: string): string {
  const idx = sourceRef.indexOf("#");
  return idx >= 0 ? sourceRef.slice(idx + 1) : "";
}

// ── Core query ─────────────────────────────────────────────────────────────────

/**
 * Scan the tasks table for "already-in-review" guard tasks and identify
 * (source_ref, agent_name) pairs where both Claude and Codex variants of the
 * same pool hit the guard within DISPATCH_WINDOW_MS of each other.
 *
 * @param store       - StateStore instance (caller-owned, not closed here).
 * @param windowHours - Look-back window in hours.
 */
export function getVariantDuplicatesPayload(
  store: StateStore,
  windowHours: number = DEFAULT_WINDOW_HOURS,
): VariantDuplicatesPayload {
  const safeHours = Math.min(
    Math.max(Number.isFinite(windowHours) ? Math.floor(windowHours) : DEFAULT_WINDOW_HOURS, 1),
    MAX_WINDOW_HOURS,
  );

  const generatedAt = new Date().toISOString();

  // ── Fetch already-in-review tasks in the window ─────────────────────────────
  let rawTasks: Task[];
  try {
    rawTasks = (store as unknown as {
      db: { prepare(s: string): { all(...args: unknown[]): Task[] } }
    }).db
      .prepare(
        `SELECT id, title, source_ref, agent_name, created_at
         FROM tasks
         WHERE agent_name IS NOT NULL
           AND source_ref IS NOT NULL
           AND (
             title LIKE '%Already in review%'
             OR result LIKE 'already-in-review:%'
           )
           AND created_at >= datetime('now', ? || ' hours')
         ORDER BY source_ref, created_at ASC`,
      )
      .all(`-${safeHours}`) as Task[];
  } catch {
    // If the query fails (e.g. test env without `result` column) fall back to
    // title-only match.
    try {
      rawTasks = (store as unknown as {
        db: { prepare(s: string): { all(...args: unknown[]): Task[] } }
      }).db
        .prepare(
          `SELECT id, title, source_ref, agent_name, created_at
           FROM tasks
           WHERE agent_name IS NOT NULL
             AND source_ref IS NOT NULL
             AND title LIKE '%Already in review%'
             AND created_at >= datetime('now', ? || ' hours')
           ORDER BY source_ref, created_at ASC`,
        )
        .all(`-${safeHours}`) as Task[];
    } catch {
      rawTasks = [];
    }
  }

  if (rawTasks.length === 0) {
    return {
      window_hours: safeHours,
      pairs: [],
      total_pairs: 0,
      total_redundant_tasks: 0,
      generated_at: generatedAt,
    };
  }

  // ── Group by source_ref → { agentName → timestamps[] } ───────────────────
  const byIssue = new Map<string, Map<string, string[]>>();

  for (const task of rawTasks) {
    const ref = task.source_ref ?? "";
    const agent = task.agent_name ?? "";
    if (!ref || !agent) continue;

    let agentMap = byIssue.get(ref);
    if (!agentMap) {
      agentMap = new Map();
      byIssue.set(ref, agentMap);
    }
    const times = agentMap.get(agent) ?? [];
    times.push(task.created_at);
    agentMap.set(agent, times);
  }

  // ── For each issue, detect variant collisions within DISPATCH_WINDOW_MS ────
  const pairMap = new Map<
    string,
    { variant_a: string; variant_b: string; source_ref: string; events: string[] }
  >();

  for (const [sourceRef, agentMap] of byIssue) {
    const agents = [...agentMap.keys()];

    for (const agentA of agents) {
      const sibling = canonicalVariantSibling(agentA);
      if (!sibling) continue;

      const agentB = agents.find((a) => a === sibling);
      if (!agentB) continue;

      // Only process each pair once (iterate lexicographically smaller first)
      if (agentA >= agentB) continue;

      const timesA = agentMap.get(agentA)!.map((t) => new Date(t).getTime());
      const timesB = agentMap.get(agentB)!.map((t) => new Date(t).getTime());

      // Find all collision events: a hit from A within DISPATCH_WINDOW_MS of a hit from B
      const collisionTimestamps: string[] = [];
      for (const tA of timesA) {
        for (const tB of timesB) {
          if (Math.abs(tA - tB) <= DISPATCH_WINDOW_MS) {
            // Record the later of the two timestamps
            const ts = new Date(Math.max(tA, tB)).toISOString();
            if (!collisionTimestamps.includes(ts)) {
              collisionTimestamps.push(ts);
            }
            break; // count each A-hit at most once
          }
        }
      }

      if (collisionTimestamps.length === 0) continue;

      const [va, vb] = normalisedVariantPair(agentA, agentB);
      const pairKey = `${sourceRef}::${va}::${vb}`;

      const existing = pairMap.get(pairKey);
      if (existing) {
        existing.events.push(...collisionTimestamps);
      } else {
        pairMap.set(pairKey, { variant_a: va, variant_b: vb, source_ref: sourceRef, events: collisionTimestamps });
      }
    }
  }

  // ── Build output pairs sorted by event_count desc ─────────────────────────
  const pairs: VariantDuplicatePair[] = [];
  for (const { variant_a, variant_b, source_ref, events } of pairMap.values()) {
    const lastSeen = [...events].sort().reverse()[0] ?? generatedAt;
    pairs.push({
      repo: extractRepo(source_ref),
      issue: extractIssue(source_ref),
      source_ref,
      variant_a,
      variant_b,
      event_count: events.length,
      redundant_tasks: events.length * 2,
      last_seen: lastSeen,
    });
  }

  pairs.sort((a, b) => b.event_count - a.event_count || a.source_ref.localeCompare(b.source_ref));

  const totalRedundant = pairs.reduce((s, p) => s + p.redundant_tasks, 0);

  return {
    window_hours: safeHours,
    pairs,
    total_pairs: pairs.length,
    total_redundant_tasks: totalRedundant,
    generated_at: generatedAt,
  };
}

// ── Telegram formatter ────────────────────────────────────────────────────────

/**
 * Format a VariantDuplicatesPayload as a Telegram Markdown string for the
 * `/variant-duplicates` command.
 */
export function formatVariantDuplicatesForTelegram(
  payload: VariantDuplicatesPayload,
): string {
  const lines: string[] = [
    `🔁 *Variant-Pair Dispatch Duplicates* — last ${payload.window_hours}h`,
    ``,
  ];

  if (payload.total_pairs === 0) {
    lines.push(`✅ No variant-pair guard collisions in the window.`);
    lines.push(``);
    lines.push(
      `Both Claude/Codex siblings of every agent pool hit the "already-in-review" ` +
      `guard independently zero times — no routing tuning needed.`,
    );
    return lines.join("\n");
  }

  lines.push(
    `Found *${payload.total_pairs}* issue(s) where both pool siblings hit the ` +
    `already-in-review guard within the same dispatch window, wasting ` +
    `*${payload.total_redundant_tasks}* guard tasks.`,
  );
  lines.push(``);

  const top = payload.pairs.slice(0, 10);
  for (const pair of top) {
    const evtLabel = pair.event_count === 1 ? "1 event" : `${pair.event_count} events`;
    lines.push(`📌 \`${pair.source_ref}\``);
    lines.push(`   • ${pair.variant_a} + ${pair.variant_b}  (${evtLabel}, ${pair.redundant_tasks} redundant tasks)`);
    lines.push(`   • Last seen: ${pair.last_seen.slice(0, 16).replace("T", " ")} UTC`);
    lines.push(``);
  }

  if (payload.pairs.length > 10) {
    lines.push(`_…and ${payload.pairs.length - 10} more pairs. Use \`/api/variant-duplicate-dispatch\` for full JSON._`);
    lines.push(``);
  }

  lines.push(
    `💡 Tune dispatch routing rules to canonicalize agent names before the guard ` +
    `fires, or add pool-level deduplication upstream.`,
  );

  return lines.join("\n");
}
