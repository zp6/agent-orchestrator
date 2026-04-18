/**
 * Semantic duplicate guard — issue #275
 *
 * Pre-dispatch filter that detects when a newly queued issue is semantically
 * identical to another open issue that was already dispatched within the last
 * 72 hours.  Uses lightweight token-overlap similarity (Jaccard on meaningful
 * tokens after stop-word removal) to flag potential duplicates.
 *
 * Matches above a configurable threshold (default 60%) are returned as
 * "dedup-candidates" for operator review before dispatch proceeds.
 *
 * Design principles (matching existing guards):
 *   - Fail-open: on any error, returns `{ candidates: [], error }` and lets
 *     dispatch proceed.
 *   - Never blocks dispatch autonomously — returns candidates for operator review.
 *   - Supports short-circuit scoring callback (same pattern as pr-existence-guard).
 *   - Stateless: operates on the issue list passed in (no internal cache).
 *
 * Usage:
 *
 *   const result = checkSemanticDuplicates({
 *     candidateTitle: "Fleet health: already-in-review saturation ratio panel",
 *     candidateIssueNumber: 352,
 *     recentIssues: [
 *       { issueNumber: 918, title: "Dashboard: expose already-in-review saturation ratio as a fleet health metric", repo: "rapartlu/agent-dashboard", dispatchedAt: new Date() },
 *     ],
 *   });
 *   // result.candidates → [{ issueNumber: 918, similarity: 0.71, ... }]
 */

import { createLogger } from "../service/logger.js";

const log = createLogger("semantic-duplicate-guard");

// ── Stop words ───────────────────────────────────────────────────────────────

/**
 * Common English stop words + orchestrator jargon that carry no semantic
 * weight for issue-title comparison.  Kept intentionally small — aggressive
 * removal hurts precision more than it helps recall.
 */
const STOP_WORDS = new Set([
  // articles / determiners
  "a", "an", "the", "this", "that", "these", "those",
  // prepositions
  "in", "on", "at", "to", "for", "of", "by", "from", "with", "as", "into",
  // conjunctions
  "and", "or", "but", "nor",
  // pronouns
  "it", "its",
  // verbs (low-signal)
  "is", "are", "was", "were", "be", "been", "being",
  "do", "does", "did", "has", "have", "had",
  // orchestrator noise — these appear in most auto-generated issue titles
  "orchestrator", "claude", "codex", "agent", "dashboard", "reviewer",
  "proxy", "research",
  // common prefixes in auto-generated titles
  "add", "implement", "create", "build", "make", "update",
]);

// ── Public types ─────────────────────────────────────────────────────────────

/** An open issue that was recently dispatched. */
export interface RecentDispatchedIssue {
  /** GitHub issue number. */
  issueNumber: number;
  /** Issue title text. */
  title: string;
  /** Repository slug, e.g. "rapartlu/agent-dashboard". */
  repo: string;
  /** When the issue was dispatched.  Used for 72-hour window filtering. */
  dispatchedAt: Date;
  /** Optional: the agent the issue was dispatched to. */
  assignedAgent?: string;
}

/** A candidate duplicate detected by the guard. */
export interface DedupCandidate {
  /** The existing issue that looks like a duplicate. */
  issueNumber: number;
  /** Repository of the existing issue. */
  repo: string;
  /** Title of the existing issue. */
  title: string;
  /** Jaccard similarity score (0–1). */
  similarity: number;
  /** When the existing issue was dispatched. */
  dispatchedAt: Date;
  /** Agent the existing issue was dispatched to, if known. */
  assignedAgent?: string;
}

/** Result of the semantic duplicate check. */
export interface SemanticDuplicateCheckResult {
  /** Potential duplicates above the similarity threshold, sorted descending. */
  candidates: DedupCandidate[];
  /** If true, at least one candidate was found — operator should review. */
  hasDuplicates: boolean;
  /** Human-readable summary suitable for logging or Telegram. */
  reason: string;
  /** Non-null if the guard encountered an error (fail-open). */
  error?: string;
}

/** Options for the semantic duplicate check. */
export interface SemanticDuplicateGuardOptions {
  /** Issue title to check for duplicates. */
  candidateTitle: string;
  /** Issue number of the candidate (excluded from comparison). */
  candidateIssueNumber: number;
  /** Repository of the candidate issue. */
  candidateRepo?: string;
  /**
   * List of recently dispatched open issues to compare against.
   * Caller is responsible for fetching this (typically from the state store).
   */
  recentIssues: RecentDispatchedIssue[];
  /**
   * Minimum Jaccard similarity (0–1) to flag as a potential duplicate.
   * Default: 0.60 (60% shared meaningful tokens).
   */
  similarityThreshold?: number;
  /**
   * Maximum age in hours for dispatched issues to be considered.
   * Default: 72 (3 days).
   */
  windowHours?: number;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_SIMILARITY_THRESHOLD = 0.60;
export const DEFAULT_WINDOW_HOURS = 72;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether the candidate issue title is semantically similar to any
 * recently dispatched open issue.
 *
 * Call this BEFORE dispatching any GitHub-sourced task (after the PR existence
 * guard).  If candidates are returned, the operator should review them before
 * dispatch proceeds.
 *
 * This function never throws — errors are captured in the result.
 */
export function checkSemanticDuplicates(
  opts: SemanticDuplicateGuardOptions,
): SemanticDuplicateCheckResult {
  try {
    const threshold = opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
    const windowMs = windowHours * 60 * 60 * 1000;
    const now = Date.now();

    // Tokenize the candidate title once.
    const candidateTokens = tokenize(opts.candidateTitle);

    if (candidateTokens.size === 0) {
      return {
        candidates: [],
        hasDuplicates: false,
        reason: `Candidate issue #${opts.candidateIssueNumber} has no meaningful tokens after stop-word removal — skipping duplicate check`,
      };
    }

    const candidates: DedupCandidate[] = [];

    for (const issue of opts.recentIssues) {
      // Skip self-comparison.
      if (issue.issueNumber === opts.candidateIssueNumber &&
          (!opts.candidateRepo || issue.repo === opts.candidateRepo)) {
        continue;
      }

      // Skip issues outside the time window.
      if (now - issue.dispatchedAt.getTime() > windowMs) {
        continue;
      }

      const issueTokens = tokenize(issue.title);
      if (issueTokens.size === 0) continue;

      const similarity = jaccardSimilarity(candidateTokens, issueTokens);

      if (similarity >= threshold) {
        candidates.push({
          issueNumber: issue.issueNumber,
          repo: issue.repo,
          title: issue.title,
          similarity: Math.round(similarity * 100) / 100, // 2 decimal places
          dispatchedAt: issue.dispatchedAt,
          assignedAgent: issue.assignedAgent,
        });
      }
    }

    // Sort by similarity descending.
    candidates.sort((a, b) => b.similarity - a.similarity);

    const hasDuplicates = candidates.length > 0;

    let reason: string;
    if (hasDuplicates) {
      const topMatch = candidates[0];
      reason =
        `Issue #${opts.candidateIssueNumber} has ${candidates.length} potential duplicate(s) — ` +
        `top match: #${topMatch.issueNumber} in ${topMatch.repo} ` +
        `(${Math.round(topMatch.similarity * 100)}% token overlap)`;
      log.info("Semantic duplicates detected", {
        candidateIssue: opts.candidateIssueNumber,
        candidateTitle: opts.candidateTitle,
        matchCount: candidates.length,
        topMatch: topMatch.issueNumber,
        topSimilarity: topMatch.similarity,
      });
    } else {
      reason = `No semantic duplicates found for issue #${opts.candidateIssueNumber} (threshold: ${Math.round(threshold * 100)}%)`;
    }

    return { candidates, hasDuplicates, reason };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error("Semantic duplicate guard failed — proceeding with dispatch", {
      candidateIssue: opts.candidateIssueNumber,
      error: errorMsg,
    });
    return {
      candidates: [],
      hasDuplicates: false,
      reason: `Guard error: ${errorMsg} — proceeding with dispatch`,
      error: errorMsg,
    };
  }
}

/**
 * Format a `SemanticDuplicateCheckResult` as a compact multi-line string
 * suitable for Telegram alerts or operator review queues.
 */
export function formatDedupCandidates(
  result: SemanticDuplicateCheckResult,
  candidateIssueNumber: number,
): string {
  if (!result.hasDuplicates) {
    return `No semantic duplicates for #${candidateIssueNumber}`;
  }

  const lines = [
    `⚠️ Potential duplicate issues for #${candidateIssueNumber}:`,
  ];

  for (const c of result.candidates) {
    const pct = Math.round(c.similarity * 100);
    const agent = c.assignedAgent ? ` → ${c.assignedAgent}` : "";
    lines.push(`  • #${c.issueNumber} (${c.repo}${agent}) — ${pct}% overlap: "${c.title}"`);
  }

  lines.push("Action: review before dispatch to avoid double-implementation");
  return lines.join("\n");
}

// ── Token similarity ─────────────────────────────────────────────────────────

/**
 * Tokenize a title string into a set of meaningful lowercase tokens.
 *
 * Steps:
 *   1. Replace common separators (-, _, :, /, [, ]) with spaces
 *   2. Lowercase
 *   3. Split on whitespace
 *   4. Remove stop words
 *   5. Remove tokens shorter than 2 characters
 *   6. Return as a Set (deduplicated)
 */
export function tokenize(title: string): Set<string> {
  const normalized = title
    .replace(/[-_:\/\[\]()]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));

  return new Set(normalized);
}

/**
 * Jaccard similarity coefficient: |A ∩ B| / |A ∪ B|.
 *
 * Returns 0 if both sets are empty, 1 if identical.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  // Iterate over the smaller set for efficiency.
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) {
      intersection++;
    }
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
