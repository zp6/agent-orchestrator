/**
 * Immune System — Learned Pattern Registry
 *
 * Implements the cross-agent "anti-pattern immune system" proposed in the
 * 2026-04-12 blue-sky meeting (#693).  Each pattern represents a recurring
 * failure mode extracted from verification failures or PR rejections.  Patterns
 * are injected into LLM review prompts so the reviewer "knows" about known
 * anti-patterns before evaluating code.
 *
 * Measurement: track `first_pass_saves` (PRs that passed review on the first
 * attempt after a pattern was injected) vs. `hit_count` (total injections) to
 * calculate the immune-system save rate over time.
 */

import type { LearnedPattern, StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("learned-patterns");

// ── Default seed patterns (from known failures) ───────────────────────────────

/**
 * The canonical three seed patterns agreed on in the blue-sky meeting.
 * Each maps to a recurring failure observed in the agent fleet.
 */
const SEED_PATTERNS = [
  {
    pattern_type: "workflow" as const,
    title: 'PR body missing "Closes #N" issue reference',
    description:
      'Every PR MUST include "Closes #N" (where N is the issue number) in the PR body so the ' +
      "linked GitHub issue auto-closes on merge.  PRs that omit this reference leave stale open " +
      "issues cluttering the backlog and require manual cleanup.  The reviewer should reject any " +
      'PR whose body does not contain a "Closes #" reference.',
    source: "blue_sky_seed" as const,
    source_ref: "issue-693",
    agent: "claude-agent-orchestrator",
    confidence: 0.95,
  },
  {
    pattern_type: "workflow" as const,
    title: "Direct commit to main branch",
    description:
      "Changes MUST never be committed directly to the main branch.  All work must go through a " +
      "feature branch and a PR.  Direct commits to main bypass code review, break the merge " +
      "queue, and can corrupt the deploy pipeline.  The reviewer should escalate any PR that " +
      "appears to have been force-pushed to main or that lacks a feature-branch lineage.",
    source: "blue_sky_seed" as const,
    source_ref: "issue-693",
    agent: "claude-agent-orchestrator",
    confidence: 0.92,
  },
  {
    pattern_type: "architecture" as const,
    title: "Bundled PR touches more than 5 unrelated files",
    description:
      "Each PR must address exactly ONE issue.  PRs that touch more than 5 files are typically " +
      "bundling unrelated changes (e.g. fixing a bug + adding a feature + refactoring).  " +
      "Bundled PRs are hard to review, risky to merge, and make git bisect unreliable.  " +
      "The reviewer should flag PRs with >5 changed files and no clear single concern.",
    source: "blue_sky_seed" as const,
    source_ref: "issue-693",
    agent: "claude-agent-orchestrator",
    confidence: 0.80,
  },
] as const;

// ── Seeding ───────────────────────────────────────────────────────────────────

/**
 * Ensure the three canonical seed patterns exist in the database.
 * Safe to call multiple times — deduplicates by title.
 *
 * @returns number of patterns actually inserted (0 if already seeded).
 */
export function seedDefaultPatterns(store: StateStore): number {
  let inserted = 0;
  for (const seed of SEED_PATTERNS) {
    const pattern = store.addLearnedPattern(seed);
    if (pattern.hit_count === 0 && pattern.first_pass_saves === 0) {
      // Heuristic: if both counters are zero it was freshly inserted
      inserted++;
    }
  }
  if (inserted > 0) {
    log.info("Seeded default learned patterns", { inserted });
  }
  return inserted;
}

// ── Retrieval & injection ─────────────────────────────────────────────────────

/** How many of the injection slots are reserved for unproven patterns. */
const UNPROVEN_SLOTS = 2;

/**
 * Fetch active patterns relevant to the given repo and record a `hit` for
 * each one returned (since they are about to be injected into a prompt).
 *
 * Mixes proven patterns (high confidence, high hits) with unproven ones
 * (low hit count) so new patterns get exposure and a chance to prove
 * themselves. Without rotation, high-confidence seeds permanently occupy
 * all slots and new patterns never get injected.
 *
 * @param store  - State store.
 * @param repo   - GitHub repo slug (e.g. "rapartlu/agent-orchestrator").
 * @param limit  - Max patterns to inject (default 7 to keep prompts lean).
 * @returns      - Array of relevant patterns; empty if none.
 */
export function getAndRecordPatterns(
  store: StateStore,
  repo: string,
  limit = 7,
): LearnedPattern[] {
  // Fetch more than needed so we can split into proven/unproven
  const all = store.getLearnedPatterns(repo, 50);
  if (all.length === 0) return [];

  // Split: unproven = fewer than 10 hits (haven't had a real chance yet)
  const proven = all.filter((p) => p.hit_count >= 10);
  const unproven = all.filter((p) => p.hit_count < 10);

  // Fill proven slots first, then unproven
  const provenSlots = Math.min(proven.length, limit - Math.min(UNPROVEN_SLOTS, unproven.length));
  const unprovenSlots = Math.min(unproven.length, limit - provenSlots);

  const selected = [
    ...proven.slice(0, provenSlots),
    ...unproven.slice(0, unprovenSlots),
  ];

  for (const p of selected) {
    store.recordPatternHit(p.id);
  }
  return selected;
}

/**
 * Build the "## Known Anti-Patterns" markdown block to inject into a review
 * prompt.  Returns an empty string when there are no patterns (so callers can
 * safely concatenate without adding whitespace).
 */
export function buildPatternsBlock(patterns: LearnedPattern[]): string {
  if (patterns.length === 0) return "";

  const lines: string[] = [
    "",
    "### ⚠️ Known Anti-Patterns (Immune System)",
    "The following recurring failure modes have been observed in this fleet.",
    "Check whether this PR exhibits any of them BEFORE reviewing the diff:",
    "",
  ];

  for (const p of patterns) {
    const conf = Math.round(p.confidence * 100);
    lines.push(`**${p.id}. ${p.title}** *(${p.pattern_type}, confidence ${conf}%)*`);
    lines.push(p.description);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Record a first-pass save for all patterns that were injected into the prompt
 * when a PR is approved on the first review attempt.
 *
 * Call this after the reviewer returns "approve" and the PR had no prior
 * review rounds (priorReviews === 0).
 */
export function recordFirstPassSaves(
  store: StateStore,
  patternIds: number[],
): void {
  for (const id of patternIds) {
    store.recordPatternSave(id);
  }
  if (patternIds.length > 0) {
    log.debug("Recorded first-pass saves for patterns", { patternIds });
  }
}
