/**
 * Pre-dispatch failure prediction filter: query the antibody log for failure
 * patterns that match the incoming task and attach a 'known risk' warning to
 * the agent message context (issue #750).
 *
 * Similarity is intentionally lightweight — keyword-based Jaccard scoring
 * against the antibody entry's reason text, directories, and extensions.  This
 * avoids an LLM round-trip on the hot dispatch path while still surfacing
 * obvious repeats of known-bad patterns.
 */

import type { AntibodyLogEntry, DiffShape, StateStore } from "../state/store.js";

/** Minimum similarity score [0, 1] for an entry to be considered a match. */
export const ANTIBODY_SIMILARITY_THRESHOLD = 0.15;

/** Maximum number of matching entries to include in the warning block. */
const MAX_MATCHES_IN_WARNING = 3;

/** Risk signals — decisions / outcomes that indicate a hazardous pattern. */
const RISK_DECISIONS: AntibodyLogEntry["decision"][] = ["escalate", "request-changes"];

export interface AntibodyMatch {
  entry: AntibodyLogEntry;
  score: number;
}

/**
 * Tokenise a string into a normalised set of meaningful keywords.
 * Strips punctuation, lowercases, and removes common stop-words.
 */
function tokenise(text: string): Set<string> {
  const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
    "this", "that", "it", "its", "as", "if", "not", "no", "so", "do",
    "does", "did", "will", "would", "can", "could", "should", "may", "might",
    "has", "have", "had", "we", "i", "you", "they", "he", "she",
  ]);

  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

/**
 * Jaccard similarity between two token sets.  Returns a score in [0, 1].
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a composite feature-token set for an antibody log entry.
 * Combines: the reason text, directory names, and file extensions.
 */
function entryTokens(entry: AntibodyLogEntry): Set<string> {
  const tokens = new Set<string>();

  // Reason text contributes the richest signal
  if (entry.reason) {
    for (const t of tokenise(entry.reason)) tokens.add(t);
  }

  // Structural signals from the diff shape
  let shape: DiffShape | null = null;
  try {
    shape = JSON.parse(entry.diff_shape) as DiffShape;
  } catch {
    // ignore malformed
  }

  if (shape) {
    // Directory names (split on / to get individual path segments)
    for (const dir of shape.directories ?? []) {
      for (const t of tokenise(dir)) tokens.add(t);
    }
    // File extensions as bare tokens, e.g. ".ts" → "ts"
    for (const ext of shape.extensions ?? []) {
      tokens.add(ext.replace(/^\./, "").toLowerCase());
    }
    // Boolean shape signals as synthetic tokens
    if (shape.touches_schema) tokens.add("schema");
    if (shape.touches_tests) tokens.add("tests");
  }

  return tokens;
}

/**
 * Score how similar a task message is to a given antibody entry.
 * Returns a value in [0, 1].
 */
export function scoreTaskSimilarity(
  taskMessage: string,
  entry: AntibodyLogEntry,
): number {
  const taskTokens = tokenise(taskMessage);
  const featureTokens = entryTokens(entry);
  return jaccardSimilarity(taskTokens, featureTokens);
}

/**
 * Build the antibody-warning block to prepend to the agent's task message.
 * Formatted similarly to the learned-rules block for consistency.
 */
export function buildAntibodyWarningBlock(matches: AntibodyMatch[]): string {
  if (matches.length === 0) return "";

  const items = matches.map((m) => {
    const repo = m.entry.repo;
    const pr = `#${m.entry.pr_number}`;
    const decision = m.entry.decision;
    const outcome = m.entry.outcome ? ` → outcome: ${m.entry.outcome}` : "";
    const reason = m.entry.reason
      ? `\n  Pattern: "${m.entry.reason.slice(0, 150)}${m.entry.reason.length > 150 ? "…" : ""}"`
      : "";
    const score = Math.round(m.score * 100);
    return (
      `- [${decision.toUpperCase()}] ${repo} ${pr} (similarity: ${score}%)${outcome}${reason}`
    );
  });

  return (
    `\n\n## ⚠️  Antibody Warning — Known Risk Patterns\n` +
    `The following entries from the failure immunity log match this task.\n` +
    `These patterns were previously flagged as risky (escalated or requiring changes).\n` +
    `Proceed carefully and double-check affected areas:\n\n` +
    items.join("\n\n") +
    `\n`
  );
}

export interface AntibodyPreDispatchResult {
  /** Whether the task matched one or more risk entries above the threshold. */
  flagged: boolean;
  /** Matched entries (empty when not flagged). */
  matches: AntibodyMatch[];
  /** The warning block to inject into the dispatch message (empty when not flagged). */
  warningBlock: string;
}

/**
 * Run the antibody pre-dispatch check for a task.
 *
 * Queries the antibody log for entries with risk decisions (escalate,
 * request-changes) or regression outcomes, scores each against the task
 * message, and returns the matches that exceed {@link ANTIBODY_SIMILARITY_THRESHOLD}.
 *
 * @param store   - State store instance.
 * @param message - Raw task message / description to score against.
 * @param repo    - Optional repo slug to narrow the query (speeds up lookup).
 * @param limit   - Max antibody entries to consider (default 100).
 */
export function runAntibodyPreDispatchCheck(
  store: StateStore,
  message: string,
  repo?: string,
  limit = 100,
): AntibodyPreDispatchResult {
  const matches: AntibodyMatch[] = [];

  for (const decision of RISK_DECISIONS) {
    const entries = store.getAntibodyEntries({ repo, decision, limit: Math.ceil(limit / 2) });
    for (const entry of entries) {
      const score = scoreTaskSimilarity(message, entry);
      if (score >= ANTIBODY_SIMILARITY_THRESHOLD) {
        matches.push({ entry, score });
      }
    }
  }

  // Also check for regression outcomes regardless of decision type
  const allEntries = store.getAntibodyEntries({ repo, limit });
  for (const entry of allEntries) {
    if (entry.outcome !== "regression") continue;
    // Avoid double-counting entries already scored above
    if (matches.some((m) => m.entry.id === entry.id)) continue;
    const score = scoreTaskSimilarity(message, entry);
    if (score >= ANTIBODY_SIMILARITY_THRESHOLD) {
      matches.push({ entry, score });
    }
  }

  // Sort by score descending; take top N for the warning block
  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, MAX_MATCHES_IN_WARNING);

  const warningBlock = buildAntibodyWarningBlock(topMatches);
  return {
    flagged: topMatches.length > 0,
    matches: topMatches,
    warningBlock,
  };
}
