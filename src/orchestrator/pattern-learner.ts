/**
 * Auto-Learn Patterns — Immune System Evolution
 *
 * Automatically discovers new anti-patterns from verification rejections and
 * PR review rejections.  Runs periodically (called by daemon) to aggregate
 * recent failures, extract generalizable patterns via LLM, deduplicate
 * against existing patterns, and register new ones at low initial confidence.
 *
 * Also auto-retires patterns with poor effectiveness (high hit_count but
 * low save rate) after a burn-in period.
 */

import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, LearnedPattern } from "../state/store.js";
import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import { extractJSON } from "../utils/json-extract.js";

const log = createLogger("pattern-learner");

// ── Constants ────────────────────────────────────────────────────────────────

/** Minimum rejections in the lookback window to trigger learning. */
const MIN_REJECTIONS_TO_LEARN = 3;

/** How far back to look for rejection signals (hours). */
const LOOKBACK_HOURS = 72;

/** New auto-learned patterns start at this confidence. */
const INITIAL_CONFIDENCE = 0.5;

const VALID_PATTERN_TYPES = new Set(["anti_pattern", "bug", "security", "architecture", "workflow"]);

/** Patterns below this save rate after enough injections get auto-retired. */
const RETIRE_SAVE_RATE_THRESHOLD = 0.05;

/** Minimum injections before we judge a pattern's effectiveness. */
const RETIRE_MIN_HITS = 50;

/** LLM timeout for pattern extraction. */
const LLM_TIMEOUT_MS = 60_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface RejectionSignal {
  source: "verification" | "pr_review";
  repo: string;
  reason: string;
  agent?: string;
  sourceRef?: string;
}

interface ExtractedPattern {
  title: string;
  description: string;
  pattern_type: "anti_pattern" | "bug" | "security" | "architecture" | "workflow";
}

// ── State: track last-processed timestamp to avoid re-sending same signals ───

let lastProcessedAt: string | null = null;

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run one cycle of the pattern learner:
 * 1. Gather recent rejection signals (verification + PR review)
 * 2. Filter to only NEW signals since last run (avoids re-processing)
 * 3. If enough new signals, ask the LLM to extract generalizable patterns
 * 4. Deduplicate against existing patterns (via store.addLearnedPattern)
 * 5. Auto-retire ineffective patterns
 *
 * @returns Number of new patterns learned.
 */
export async function learnPatterns(
  config: OrchestratorConfig,
  store: StateStore,
): Promise<number> {
  // Use the later of: last-processed timestamp or the lookback window
  const windowCutoff = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
  const effectiveCutoff = lastProcessedAt && lastProcessedAt > windowCutoff
    ? lastProcessedAt
    : windowCutoff;

  const allSignals = gatherRejectionSignals(store, effectiveCutoff);

  // Dedup signals by reason (first 100 chars) to avoid counting
  // the same rejection reason as multiple signals
  const seen = new Set<string>();
  const signals = allSignals.filter((s) => {
    const key = `${s.source}:${s.reason.slice(0, 100)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (signals.length < MIN_REJECTIONS_TO_LEARN) {
    log.debug("Not enough new rejection signals to learn", {
      signals: signals.length,
      threshold: MIN_REJECTIONS_TO_LEARN,
    });
    // Still run auto-retirement even without new signals
    const existing = store.listAllLearnedPatterns(100);
    const retired = autoRetireIneffectivePatterns(store, existing);
    if (retired > 0) log.info("Pattern learner: auto-retired patterns", { retired });
    return 0;
  }

  // Mark the current time so next cycle only processes new signals
  const cycleTimestamp = new Date().toISOString();

  // Get existing patterns to avoid duplicates
  const existing = store.listAllLearnedPatterns(100);

  let learned = 0;
  try {
    const extracted = await extractPatternsFromSignals(config, signals, existing);

    for (const pattern of extracted) {
      // Validate pattern_type against allowed enum values
      const patternType = VALID_PATTERN_TYPES.has(pattern.pattern_type)
        ? pattern.pattern_type
        : "anti_pattern";

      const result = store.addLearnedPattern({
        pattern_type: patternType,
        title: pattern.title,
        description: pattern.description,
        source: "verification_failure",
        confidence: INITIAL_CONFIDENCE,
      });

      // addLearnedPattern deduplicates by title — if hit_count is 0, it's new
      if (result.hit_count === 0 && result.first_pass_saves === 0) {
        learned++;
        log.info("New pattern learned", {
          id: result.id,
          title: result.title,
          type: result.pattern_type,
        });
      }
    }

    // Only advance the cursor if extraction succeeded — on failure,
    // we'll retry with the same signals next cycle.
    lastProcessedAt = cycleTimestamp;
  } catch (err) {
    log.warn("Pattern extraction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Auto-retire ineffective patterns (uses pre-learning snapshot, which is
  // intentional — new patterns haven't had enough hits to judge yet).
  const retired = autoRetireIneffectivePatterns(store, existing);

  if (learned > 0 || retired > 0) {
    log.info("Pattern learner cycle complete", { learned, retired });
  }

  return learned;
}

// ── Signal gathering ─────────────────────────────────────────────────────────

/**
 * Collect recent rejection signals from two sources:
 * 1. Verification rejections (tasks with verification_status = 'rejected')
 * 2. PR review rejections (antibody_log entries with decision = 'request-changes')
 */
function gatherRejectionSignals(store: StateStore, cutoff: string): RejectionSignal[] {
  const signals: RejectionSignal[] = [];

  // Source 1: Verification rejections
  try {
    const rejected = store.getRecentRejectedTasks(cutoff);
    for (const task of rejected) {
      if (!task.verification_notes) continue;
      const repo = task.source_ref?.split("#")[0] ?? "";
      signals.push({
        source: "verification",
        repo,
        reason: task.verification_notes,
        agent: task.agent_name ?? undefined,
        sourceRef: task.source_ref ?? undefined,
      });
    }
  } catch (err) {
    log.warn("Failed to gather verification rejections", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Source 2: PR review rejections from antibody log
  try {
    const rejections = store.getRecentPRRejections(cutoff);
    for (const entry of rejections) {
      if (!entry.reason) continue;
      signals.push({
        source: "pr_review",
        repo: entry.repo,
        reason: entry.reason,
        agent: entry.agent ?? undefined,
      });
    }
  } catch (err) {
    log.warn("Failed to gather PR rejections", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return signals;
}

// ── LLM pattern extraction ──────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `You are an engineering quality analyst. You will be given a list of recent code review rejections and verification failures from an AI agent fleet.

Your job is to identify **generalizable patterns** — recurring failure modes that could be prevented if reviewers knew about them in advance.

Rules:
- Only extract patterns that appear in 2+ rejections (not one-off issues)
- Focus on patterns agents can actually check for (not subjective quality issues)
- Each pattern should be actionable: describe WHAT to look for and WHY it's harmful
- Do NOT extract patterns about infrastructure errors (timeouts, connection failures)
- Do NOT extract patterns that are already in the existing patterns list
- Return 0-3 patterns maximum per cycle (quality over quantity)

Respond with a JSON array:
\`\`\`json
[
  {
    "title": "Short descriptive title (under 80 chars)",
    "description": "Full description: what the pattern looks like, why it's harmful, and what the reviewer should check for. 2-3 sentences.",
    "pattern_type": "anti_pattern|bug|security|architecture|workflow"
  }
]
\`\`\`

Return an empty array [] if no generalizable patterns are found.`;

async function extractPatternsFromSignals(
  config: OrchestratorConfig,
  signals: RejectionSignal[],
  existing: LearnedPattern[],
): Promise<ExtractedPattern[]> {
  const { client, model } = createLLMClient(config, "verifier");

  const existingBlock = existing.length > 0
    ? `\n\n## Existing patterns (DO NOT duplicate these):\n${existing.map((p) => `- ${p.title}`).join("\n")}`
    : "";

  const signalBlock = signals
    .map((s, i) => `${i + 1}. [${s.source}] ${s.repo}: ${s.reason.slice(0, 300)}`)
    .join("\n");

  const userPrompt = `## Recent rejections (${signals.length} total):\n${signalBlock}${existingBlock}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 1024,
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";

    const parsed = extractJSON(text);
    if (!Array.isArray(parsed)) return [];

    // Validate shape — pattern_type is checked but not rejected here;
    // invalid types get defaulted to "anti_pattern" by the caller.
    return parsed.filter(
      (p: unknown): p is ExtractedPattern =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as ExtractedPattern).title === "string" &&
        typeof (p as ExtractedPattern).description === "string" &&
        typeof (p as ExtractedPattern).pattern_type === "string" &&
        (p as ExtractedPattern).title.length > 0 &&
        (p as ExtractedPattern).title.length <= 120 &&
        (p as ExtractedPattern).description.length > 0,
    );
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Auto-retirement ─────────────────────────────────────────────────────────

/**
 * Retire patterns that have been injected many times but almost never
 * correlate with a first-pass approval.  This prevents the review prompt
 * from being cluttered with noise.
 *
 * Seeds (source = "blue_sky_seed") and manually-added patterns are exempt.
 */
function autoRetireIneffectivePatterns(
  store: StateStore,
  patterns: LearnedPattern[],
): number {
  let retired = 0;

  for (const p of patterns) {
    if (p.active !== 1) continue;
    if (p.source === "blue_sky_seed" || p.source === "manual") continue;
    if (p.promoted_at) continue; // operator promoted — exempt from auto-retirement
    if (p.hit_count < RETIRE_MIN_HITS) continue;

    const saveRate = p.first_pass_saves / p.hit_count;
    if (saveRate < RETIRE_SAVE_RATE_THRESHOLD) {
      store.retireLearnedPattern(p.id);
      retired++;
      log.info("Auto-retired ineffective pattern", {
        id: p.id,
        title: p.title,
        hitCount: p.hit_count,
        saveRate: `${(saveRate * 100).toFixed(1)}%`,
      });
    }
  }

  return retired;
}
