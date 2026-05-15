/**
 * Phase A/B promotion gate — checks whether a go-live dispatch references an
 * adapter that is still in Phase A before allowing dispatch to proceed.
 *
 * See `docs/adapter-discipline.md` for the full ritual specification.
 *
 * Design contract:
 *   - Pure function over the filesystem. No network calls, no state reads.
 *   - Fail-safe: missing file or unparseable content → treated as Phase A.
 *   - Caller supplies the adapters directory path; the gate reads from there.
 *
 * Issue: #1645
 */

import { readFileSync } from "fs";
import { join } from "path";

// ── Go-live detection patterns ────────────────────────────────────────────────

/**
 * Patterns that indicate a task is a go-live / promotion action.
 * Matched case-insensitively against the combined issue title + body.
 *
 * Patterns use `[\s\S]*` for non-greedy any-character spans so that
 * adapter names or qualifiers between key terms do not defeat the match.
 * The `s` flag enables `.` to match newlines (single-line mode).
 */
export const GO_LIVE_PATTERNS: RegExp[] = [
  /\bprovision\b.*\btoken\b/is,
  /\benable\b.*\bproduction\b/is,
  /\bgo[\s_-]+live\b/i,
  /\blaunch\b.*\bproduction\b/is,
  /\bdeploy\b.*\bproduction\b/is,
  /\bpromot\w*\b.*\bphase[\s_-]*b\b/is,
  /\bphase[\s_-]*b\b.*\bpromo/is,
];

/**
 * Adapter names the gate knows about. Matched case-insensitively against the
 * combined issue title + body.
 *
 * Add new names here when a new submission adapter is introduced.
 */
export const KNOWN_ADAPTERS: string[] = [
  "immunefi",
  "sherlock",
  "code4rena",
  "cantina",
  "hats-finance",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PhasePromotionResult {
  /** Whether go-live dispatch is allowed. */
  allowed: boolean;
  /** The adapter name matched from the issue, or null if no match. */
  adapterName: string | null;
  /** Phase declared in the assumptions file, or 'unknown' if unreadable. */
  phase: "A" | "B" | "unknown";
  /** Assumptions still marked ❌ in the file. Empty when allowed. */
  unverifiedAssumptions: string[];
  /** Human-readable reason for the decision. */
  reason: string;
}

export interface ParsedAssumptions {
  phase: "A" | "B" | "unknown";
  unverifiedAssumptions: string[];
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse the phase and unverified assumptions from assumptions.md content.
 *
 * Phase detection: looks for `**Current:** A` or `**Current:** B` patterns.
 * Defaults to `unknown` if the line is absent.
 *
 * Unverified assumption detection: any table row containing `❌` in the
 * Verified? column. The first pipe-delimited cell is taken as the assumption
 * label.
 */
export function parseAssumptionsFile(content: string): ParsedAssumptions {
  // Phase detection — look for "**Current:** A" or "Current: A" variants
  const phaseMatch =
    content.match(/\*\*Current:\*\*\s+([AB])\b/i) ??
    content.match(/Current:\s+([AB])\b/i);

  const phase: "A" | "B" | "unknown" = phaseMatch
    ? (phaseMatch[1].toUpperCase() as "A" | "B")
    : "unknown";

  // Unverified assumptions — table rows containing ❌
  const unverified: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.includes("❌")) continue;
    // Table row format: | assumption text | ❌ no | — |
    const cells = line
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length >= 1) {
      // Skip header separators (--- cells)
      const label = cells[0];
      if (!label.startsWith("-") && label.length > 0) {
        unverified.push(label);
      }
    }
  }

  return { phase, unverifiedAssumptions: unverified };
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * Check whether a dispatch should be blocked by the Phase A/B gate.
 *
 * Rules (applied in order):
 * 1. If the issue is not a go-live task, allow immediately.
 * 2. If no known adapter is referenced, allow (gate only applies to adapters).
 * 3. If the adapter has no assumptions.md, block (no discipline = Phase A).
 * 4. If Phase A or unknown: block, name the unverified assumptions.
 * 5. If Phase B but has ❌ rows: block (discipline violation — claims B, isn't).
 * 6. If Phase B with no ❌ rows: allow.
 */
export function checkPhasePromotionGate(params: {
  issueTitle: string;
  issueBody: string;
  /** Absolute path to the directory containing `<adapter>.assumptions.md` files. */
  adaptersDir: string;
}): PhasePromotionResult {
  const { issueTitle, issueBody, adaptersDir } = params;
  const combined = `${issueTitle}\n${issueBody}`;

  // ── 1. Is this a go-live task? ────────────────────────────────────────────
  const isGoLive = GO_LIVE_PATTERNS.some((p) => p.test(combined));
  if (!isGoLive) {
    return {
      allowed: true,
      adapterName: null,
      phase: "unknown",
      unverifiedAssumptions: [],
      reason: "not a go-live task — phase gate not applicable",
    };
  }

  // ── 2. Does the issue reference a known adapter? ──────────────────────────
  const lc = combined.toLowerCase();
  const matchedAdapter = KNOWN_ADAPTERS.find((a) => lc.includes(a.toLowerCase()));
  if (!matchedAdapter) {
    return {
      allowed: true,
      adapterName: null,
      phase: "unknown",
      unverifiedAssumptions: [],
      reason: "go-live task but no known adapter referenced — phase gate not applicable",
    };
  }

  // ── 3. Read assumptions file ──────────────────────────────────────────────
  const assumptionsPath = join(adaptersDir, `${matchedAdapter}.assumptions.md`);
  let content: string;
  try {
    content = readFileSync(assumptionsPath, "utf-8");
  } catch {
    return {
      allowed: false,
      adapterName: matchedAdapter,
      phase: "unknown",
      unverifiedAssumptions: [],
      reason:
        `phase_promotion_gate: no assumptions.md found for ${matchedAdapter} adapter ` +
        `(expected: ${assumptionsPath}). ` +
        `Create the file and verify all assumptions before dispatching a go-live task.`,
    };
  }

  const { phase, unverifiedAssumptions } = parseAssumptionsFile(content);

  // ── 4. Phase A or unknown: block ──────────────────────────────────────────
  if (phase === "A" || phase === "unknown") {
    const listing =
      unverifiedAssumptions.length > 0
        ? `\n  - ${unverifiedAssumptions.slice(0, 5).join("\n  - ")}`
        : " (no assumption table found)";
    return {
      allowed: false,
      adapterName: matchedAdapter,
      phase: phase === "unknown" ? "unknown" : "A",
      unverifiedAssumptions,
      reason:
        `phase_promotion_gate: ${matchedAdapter} adapter is Phase A — ` +
        `${unverifiedAssumptions.length} unverified assumption(s):${listing}\n` +
        `Verify these before dispatching a go-live task.`,
    };
  }

  // ── 5. Claims Phase B but has ❌ rows: discipline violation ───────────────
  if (unverifiedAssumptions.length > 0) {
    const listing = `\n  - ${unverifiedAssumptions.slice(0, 5).join("\n  - ")}`;
    return {
      allowed: false,
      adapterName: matchedAdapter,
      phase: "B",
      unverifiedAssumptions,
      reason:
        `phase_promotion_gate: ${matchedAdapter} adapter claims Phase B but has ` +
        `${unverifiedAssumptions.length} unverified assumption(s) — discipline violation:${listing}\n` +
        `Fix the assumptions.md before dispatching.`,
    };
  }

  // ── 6. Phase B, all verified: allow ──────────────────────────────────────
  return {
    allowed: true,
    adapterName: matchedAdapter,
    phase: "B",
    unverifiedAssumptions: [],
    reason: `phase_promotion_gate: ${matchedAdapter} adapter is Phase B with all assumptions verified`,
  };
}
