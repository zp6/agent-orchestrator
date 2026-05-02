/**
 * Antibody Auto-Harvester — Phase 2 of fleet adaptive immunity (issue #1394).
 *
 * Automatically extracts structured failure_antibody signals from the fleet's
 * failure→fix PR sequences stored in the antibody log.  When the verifier
 * detects a task that failed on first attempt and then succeeded on retry (or
 * a fix PR merged for the same issue), this module:
 *
 *   1. Normalises the error signature from the failure reason.
 *   2. Classifies the error into the fleet genome taxonomy.
 *   3. Writes a `failure_antibody` signal with confidence=0.5 into the
 *      signals table so the dispatcher can inject it on future similar tasks.
 *
 * Fitness scoring is updated after each dispatch where a failure_antibody
 * signal was injected:
 *   - Dispatch succeeds → confidence += 0.05 (reward correct warning)
 *   - Dispatch fails with same error class → confidence -= 0.10 (antibody
 *     was injected but did not prevent the failure)
 *
 * Auto-cull: antibodies with confidence < 0.2 AND injection_count >= 10
 * are removed.  This creates natural selection on remediation strategies.
 */

import type { AntibodyLogEntry, StateStore } from "../state/store.js";

// ── Error genome taxonomy ─────────────────────────────────────────────────────

/**
 * Fleet genome error classes — mirrors the taxonomy from the research agent
 * genome taxonomy (issue #279 cross-reference).  The classifier maps raw
 * failure reason text to one of these canonical classes.
 */
export type ErrorClass =
  | "schema_violation"    // Schema change missing migration or backwards-compat break
  | "test_missing"        // Changed code with no accompanying test
  | "type_error"          // TypeScript compile-time or runtime type mismatch
  | "merge_conflict"      // Merge conflict markers left in code
  | "auth_bypass"         // Security: missing auth / permission check
  | "missing_teardown"    // Resource leak: no close/cleanup in finally block
  | "import_error"        // Wrong import path or missing dependency
  | "regression"          // Behaviour regression from a prior working state
  | "build_failure"       // Build / compile step failed
  | "config_error"        // Configuration key missing or wrong format
  | "rate_limit"          // External API rate-limit hit
  | "unknown";            // Fallback for unclassifiable failures

// ── Keyword rules for classification ─────────────────────────────────────────

type ClassRule = { keywords: string[]; errorClass: ErrorClass };

const CLASS_RULES: ClassRule[] = [
  {
    keywords: ["migration", "schema change", "breaking schema", "alter table", "missing column", "column not found"],
    errorClass: "schema_violation",
  },
  {
    keywords: ["no test", "missing test", "untested", "without tests", "test coverage", "add test"],
    errorClass: "test_missing",
  },
  {
    keywords: ["type error", "typescript error", "cannot read", "is not assignable", "property does not exist", "type mismatch", "ts error"],
    errorClass: "type_error",
  },
  {
    keywords: ["<<<<<<", "conflict marker", "merge conflict", ">>>>>>> ", "======= "],
    errorClass: "merge_conflict",
  },
  {
    keywords: ["auth bypass", "missing auth", "no authentication", "unauthenticated", "permission check", "security"],
    errorClass: "auth_bypass",
  },
  {
    keywords: ["resource leak", "missing close", "teardown", "cleanup", "finally", "not closed", "connection leak"],
    errorClass: "missing_teardown",
  },
  {
    keywords: ["import error", "cannot find module", "module not found", "wrong import", "missing import", "esm"],
    errorClass: "import_error",
  },
  {
    keywords: ["regression", "broke", "broken", "broke existing", "broke tests", "previously working", "side effect"],
    errorClass: "regression",
  },
  {
    keywords: ["build fail", "compile error", "build error", "tsc error", "compilation fail"],
    errorClass: "build_failure",
  },
  {
    keywords: ["config", "missing key", "env var", "environment variable", "configuration error"],
    errorClass: "config_error",
  },
  {
    keywords: ["rate limit", "429", "too many requests", "quota exceeded", "api limit"],
    errorClass: "rate_limit",
  },
];

/**
 * Classify a failure reason string into a genome error class.
 * Uses keyword matching — intentionally lightweight to avoid LLM round-trips
 * on the hot verification path.
 */
export function classifyErrorReason(reason: string): ErrorClass {
  const lower = reason.toLowerCase();
  for (const rule of CLASS_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.errorClass;
    }
  }
  return "unknown";
}

// ── Error signature normalisation ─────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "this", "that", "it", "its", "as", "if", "not", "no", "so", "do",
  "does", "did", "will", "would", "can", "could", "should", "may", "might",
  "has", "have", "had", "we", "i", "you", "they", "he", "she",
]);

/**
 * Produce a normalised, stable key from a failure reason string.
 * Used as the signal key so duplicate extraction produces idempotent writes.
 *
 * Algorithm: tokenise, remove stop-words and short tokens, sort, take top-6,
 * join with underscores.  This makes similar reasons map to the same key so
 * signals accumulate confidence rather than fragmenting.
 */
export function normaliseErrorSignature(reason: string, errorClass: ErrorClass): string {
  const tokens = reason
    .toLowerCase()
    .replace(/[^\w\s/-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOP_WORDS.has(t))
    .slice(0, 6)
    .sort();

  const base = tokens.join("_") || "generic";
  return `${errorClass}:${base}`;
}

// ── Harvested signal payload ──────────────────────────────────────────────────

export interface FailureAntibodyPayload {
  fix_hint: string;
  error_class: ErrorClass;
  source_pr: string;
  failure_pr: string;
}

export interface HarvestedAntibody {
  key: string;
  error_class: ErrorClass;
  payload: FailureAntibodyPayload;
  /** Whether this was a new signal (true) or an existing one was reinforced (false). */
  is_new: boolean;
  signal_id?: number;
}

// ── Harvest options ───────────────────────────────────────────────────────────

export interface HarvestOptions {
  /**
   * Only look at failure entries created after this ISO timestamp.
   * Defaults to 30 days ago when not provided.
   */
  since?: string;
  /** Maximum number of failure entries to scan (default 200). */
  limit?: number;
  /** Repo to narrow the scan.  When omitted, all repos are scanned. */
  repo?: string;
  /**
   * Agent name to attribute the emitted signals.
   * Defaults to "antibody-harvester".
   */
  agent?: string;
  /**
   * TTL in hours for emitted signals (default 720 = 30 days).
   * Signals that no longer prove useful will be culled before expiry by
   * `cullStaleAntibodies()`, but TTL is the hard backstop.
   */
  ttl_hours?: number;
}

// ── Fitness scoring options ───────────────────────────────────────────────────

export interface FitnessScoreOptions {
  /** The signal key to update (must be a failure_antibody signal). */
  signalKey: string;
  /** Outcome of the dispatch where this antibody was injected. */
  outcome: "success" | "failure";
  /**
   * The error class of the failure, if outcome is "failure".
   * Used to determine whether the failure is the same class as the antibody
   * (same class → stronger decay; different class → weaker decay).
   */
  failureErrorClass?: ErrorClass;
}

// ── Cull options ──────────────────────────────────────────────────────────────

export interface CullOptions {
  /** Confidence threshold below which a signal is eligible for culling (default 0.2). */
  min_confidence?: number;
  /**
   * Minimum injection count (signal_reads) before culling is eligible (default 10).
   * Prevents culling signals that haven't had enough exposure to prove themselves.
   */
  min_injections?: number;
}

// ── AntibodyHarvester ─────────────────────────────────────────────────────────

/** Agent name stamped on emitted signals. */
const DEFAULT_AGENT = "antibody-harvester";

/** TTL for newly harvested signals: 30 days.  Fitness scoring may extend this. */
const DEFAULT_TTL_HOURS = 720;

/** Initial confidence for auto-harvested antibodies. */
const INITIAL_CONFIDENCE = 0.5;

/** Confidence delta on successful dispatch. */
export const CONFIDENCE_BOOST = 0.05;

/** Confidence delta on failed dispatch with matching error class. */
export const CONFIDENCE_DECAY = 0.10;

/** Minimum confidence for auto-cull eligibility. */
export const CULL_CONFIDENCE_THRESHOLD = 0.2;

/** Minimum injection count for auto-cull eligibility. */
export const CULL_MIN_INJECTIONS = 10;

/**
 * AntibodyHarvester: extracts failure_antibody signals from the antibody log
 * and maintains their fitness over time.
 *
 * Usage:
 * ```ts
 * const harvester = new AntibodyHarvester(store);
 * const results = harvester.extractFailureAntibodies({ since: cutoff, limit: 100 });
 * // After dispatch outcome is known:
 * harvester.scoreDispatchOutcome({ signalKey: key, outcome: "success" });
 * // Periodically:
 * const culled = harvester.cullStaleAntibodies();
 * ```
 */
export class AntibodyHarvester {
  constructor(private readonly store: StateStore) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Scan the antibody log for failure→fix sequences and emit
   * `failure_antibody` signals for any new patterns found.
   *
   * A failure→fix sequence is:
   *   1. An antibody log entry with decision "request-changes" or "escalate"
   *      (the failure).
   *   2. A later entry for the same repo with decision "approve"
   *      (the fix — same PR or a follow-up PR on the same repo).
   *
   * Returns the list of signals that were harvested (new or reinforced).
   */
  extractFailureAntibodies(opts: HarvestOptions = {}): HarvestedAntibody[] {
    const since = opts.since ?? new Date(Date.now() - 30 * 86400_000).toISOString();
    const limit = opts.limit ?? 200;
    const agent = opts.agent ?? DEFAULT_AGENT;
    const ttlHours = opts.ttl_hours ?? DEFAULT_TTL_HOURS;

    // 1. Load failure entries (request-changes + escalate)
    const failures = this._getFailureEntries(opts.repo, limit, since);
    if (failures.length === 0) return [];

    // 2. Load approve entries for the same repos as a lookup table
    const approveByRepo = this._buildApproveIndex(opts.repo, since);

    const harvested: HarvestedAntibody[] = [];

    for (const failure of failures) {
      if (!failure.reason) continue; // no signal without a reason

      const approves = approveByRepo.get(failure.repo) ?? [];
      const fixEntry = this._findFixEntry(failure, approves);
      if (!fixEntry) continue; // no corresponding fix found yet

      const errorClass = classifyErrorReason(failure.reason);
      const key = normaliseErrorSignature(failure.reason, errorClass);

      const fixHint = this._extractFixHint(fixEntry);
      const payload: FailureAntibodyPayload = {
        fix_hint: fixHint,
        error_class: errorClass,
        source_pr: `${fixEntry.repo}#${fixEntry.pr_number}`,
        failure_pr: `${failure.repo}#${failure.pr_number}`,
      };

      // Check if a signal with this key already exists — if so, boost its
      // confidence rather than creating a duplicate.
      const existing = this._findExistingSignal(key);
      if (existing) {
        this.store.updateSignalConfidence(existing.id, CONFIDENCE_BOOST);
        harvested.push({
          key,
          error_class: errorClass,
          payload,
          is_new: false,
          signal_id: existing.id,
        });
        continue;
      }

      // Emit a new signal
      const signal = this.store.writeSignal({
        agent,
        signal_type: "failure_antibody",
        key,
        value: payload,
        repo: failure.repo,
        confidence: INITIAL_CONFIDENCE,
        ttl_hours: ttlHours,
      });

      harvested.push({
        key,
        error_class: errorClass,
        payload,
        is_new: true,
        signal_id: signal.id,
      });
    }

    return harvested;
  }

  /**
   * Update the confidence of a failure_antibody signal after a dispatch where
   * it was injected.
   *
   * Rules:
   *   - outcome = "success"  → confidence += CONFIDENCE_BOOST (+0.05)
   *   - outcome = "failure"  → confidence -= CONFIDENCE_DECAY  (-0.10)
   *
   * Confidence is clamped to [0.0, 1.0] by the store.
   *
   * @returns true if the signal was found and updated, false otherwise.
   */
  scoreDispatchOutcome(opts: FitnessScoreOptions): boolean {
    const existing = this._findExistingSignal(opts.signalKey);
    if (!existing) return false;

    const delta =
      opts.outcome === "success" ? CONFIDENCE_BOOST : -CONFIDENCE_DECAY;

    this.store.updateSignalConfidence(existing.id, delta);
    return true;
  }

  /**
   * Remove failure_antibody signals that have:
   *   1. confidence < min_confidence (default 0.2)
   *   2. injection_count >= min_injections (default 10)
   *
   * This implements natural selection: antibodies that have been tried at least
   * 10 times but still have low confidence are culled.
   *
   * @returns number of signals deleted.
   */
  cullStaleAntibodies(opts: CullOptions = {}): number {
    const minConfidence = opts.min_confidence ?? CULL_CONFIDENCE_THRESHOLD;
    const minInjections = opts.min_injections ?? CULL_MIN_INJECTIONS;
    return this.store.cullFailureAntibodies(minConfidence, minInjections);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Fetch failure-class antibody log entries created after `since`.
   */
  private _getFailureEntries(
    repo: string | undefined,
    limit: number,
    since: string,
  ): AntibodyLogEntry[] {
    const requestChanges = this.store.getAntibodyEntries({
      repo,
      decision: "request-changes",
      limit: Math.ceil(limit / 2),
      since,
    });
    const escalated = this.store.getAntibodyEntries({
      repo,
      decision: "escalate",
      limit: Math.ceil(limit / 2),
      since,
    });
    return [...requestChanges, ...escalated];
  }

  /**
   * Build a Map<repo, AntibodyLogEntry[]> of approved entries for fast lookup.
   */
  private _buildApproveIndex(
    repo: string | undefined,
    since: string,
  ): Map<string, AntibodyLogEntry[]> {
    const approves = this.store.getAntibodyEntries({
      repo,
      decision: "approve",
      limit: 500,
      since,
    });
    const index = new Map<string, AntibodyLogEntry[]>();
    for (const entry of approves) {
      const list = index.get(entry.repo) ?? [];
      list.push(entry);
      index.set(entry.repo, list);
    }
    return index;
  }

  /**
   * Find the fix entry for a failure entry.
   *
   * A fix is an "approve" entry on the same repo where:
   *   - The approval timestamp is after the failure timestamp.
   *   - The approved PR either has the same PR number (revision cycle) or a
   *     higher PR number (a fresh PR fixing the same issue).
   */
  private _findFixEntry(
    failure: AntibodyLogEntry,
    approves: AntibodyLogEntry[],
  ): AntibodyLogEntry | null {
    // Sort approves chronologically so we pick the *earliest* fix
    const sorted = approves
      .filter((a) => a.timestamp > failure.timestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Prefer same-PR approval first (revision cycle fixed it)
    const samePR = sorted.find((a) => a.pr_number === failure.pr_number);
    if (samePR) return samePR;

    // Otherwise take the next approval on the same repo (follow-up fix PR)
    return sorted[0] ?? null;
  }

  /**
   * Extract a human-readable fix hint from an approved entry.
   * Falls back to generic text when no reason is available.
   */
  private _extractFixHint(fix: AntibodyLogEntry): string {
    if (!fix.reason) return `PR ${fix.repo}#${fix.pr_number} was approved without a reason.`;
    const hint = fix.reason.slice(0, 200);
    return hint.length < fix.reason.length ? `${hint}…` : hint;
  }

  /**
   * Look up an existing (non-expired) failure_antibody signal by key.
   */
  private _findExistingSignal(key: string): { id: number; confidence: number } | null {
    const signals = this.store.readSignals({ signal_type: "failure_antibody" });
    const found = signals.find((s) => s.key === key);
    return found ? { id: found.id, confidence: found.confidence } : null;
  }
}

// ── Convenience exports ───────────────────────────────────────────────────────

export {
  CONFIDENCE_BOOST as ANTIBODY_CONFIDENCE_BOOST,
  CONFIDENCE_DECAY as ANTIBODY_CONFIDENCE_DECAY,
  CULL_CONFIDENCE_THRESHOLD as ANTIBODY_CULL_THRESHOLD,
  CULL_MIN_INJECTIONS as ANTIBODY_CULL_MIN_INJECTIONS,
};
