/**
 * MeetingPriorityDispatcher — rule-based fast-path for auto-dispatching the
 * top-ranked issue from a completed meeting outcome.
 *
 * ## Why this exists
 *
 * After a coordination meeting completes (e.g. the dispatch-storm / guard-bounce
 * session, task 01KQ08FB), the supervisor has a `MeetingOutcome` with a ranked
 * list of issues to implement.  Without this module the supervisor must route
 * through the LLM to decide what to dispatch next — adding 2–5 s of latency
 * per daemon cycle.
 *
 * This module provides a **deterministic** pre-LLM evaluation layer:
 *
 *   1. All named rules are checked in order.
 *   2. The first blocking rule causes a "skip" or "defer-to-llm" result.
 *   3. When all rules pass, the top-ranked issue is returned as a "dispatch"
 *      decision — ready for the orchestrator daemon to act on immediately.
 *
 * The orchestrator calls `evaluateAutoDispatch()` after writing a
 * `meeting_priority_outcome` signal.  Only when the result is "defer-to-llm"
 * does the daemon fall through to the LLM supervisor path.
 *
 * ## Rule set (evaluated in order)
 *
 *   RULE_OUTCOME_COMPLETE       — outcome.status must be "complete"
 *   RULE_RANKING_NONEMPTY       — priority_ranking must have ≥ 1 entry
 *   RULE_MIN_VERIFIER_SCORE     — verifier_score must be ≥ minVerifierScore (default 0.70)
 *   RULE_NO_FOLLOW_UP           — follow_up_recommended must be false (or urgencyOverride set)
 *   RULE_NO_SEQUENCING_BLOCK    — no SequencingConstraint blocks the top issue (predecessor not yet merged)
 *   RULE_NO_OPEN_PR             — caller-supplied guard: no open PR exists for the top issue
 *   RULE_NO_INFLIGHT_TASK       — caller-supplied guard: no in-flight task exists for the top issue
 *
 * ## Example usage (in the orchestrator daemon)
 *
 *   const dispatcher = createMeetingPriorityDispatcher();
 *
 *   const decision = dispatcher.evaluate(outcome, {
 *     mergedIssues: alreadyMergedIssueRefs,          // for sequencing checks
 *     openPRIssues: issueRefsWithOpenPRs,             // for PR guard
 *     inflightTaskIssues: issueRefsWithInflightTasks, // for task guard
 *   });
 *
 *   if (decision.action === 'dispatch' && decision.issue) {
 *     await daemon.dispatch(decision.issue);
 *   } else if (decision.action === 'defer-to-llm') {
 *     await supervisor.decide(systemState); // fall through to LLM
 *   }
 *   // 'skip' means no action needed this cycle
 */

import { createLogger } from "../service/logger.js";
import type { IssueRef, MeetingOutcome, SequencingConstraint } from "./meeting-outcome-client.js";

const log = createLogger("meeting-priority-dispatcher");

// ---------------------------------------------------------------------------
// Rule identifiers
// ---------------------------------------------------------------------------

/**
 * Stable string IDs for each rule, used in `skipped_rules` so the
 * orchestrator can log exactly which check blocked auto-dispatch.
 */
export type DispatchRuleId =
  | "RULE_OUTCOME_COMPLETE"
  | "RULE_RANKING_NONEMPTY"
  | "RULE_MIN_VERIFIER_SCORE"
  | "RULE_NO_FOLLOW_UP"
  | "RULE_NO_SEQUENCING_BLOCK"
  | "RULE_NO_OPEN_PR"
  | "RULE_NO_INFLIGHT_TASK";

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

/**
 * The result of evaluating whether to auto-dispatch the top-ranked issue.
 *
 * - `"dispatch"` — all rules passed; `issue` is ready for immediate dispatch.
 * - `"skip"`     — the outcome is not actionable (e.g. not complete, empty
 *                  ranking); no action needed this daemon cycle.
 * - `"defer-to-llm"` — guards fired that require contextual judgment (e.g.
 *                      follow-up meeting recommended, sequencing constraints);
 *                      fall through to the LLM supervisor path.
 */
export type DispatchAction = "dispatch" | "skip" | "defer-to-llm";

/**
 * The structured result of `evaluateAutoDispatch()` / `MeetingPriorityDispatcher.evaluate()`.
 */
export interface PriorityDispatchDecision {
  /** What the orchestrator daemon should do next. */
  action: DispatchAction;
  /**
   * The top-ranked `IssueRef` that triggered this decision.
   * `null` when `action` is `"skip"` and no ranking was present.
   */
  issue: IssueRef | null;
  /** Human-readable explanation for logs / supervisor audit trail. */
  reason: string;
  /**
   * IDs of the rules that blocked dispatch when `action` is "skip" or
   * "defer-to-llm".  Empty when `action` is "dispatch".
   */
  skipped_rules: DispatchRuleId[];
  /**
   * The full priority ranking from the outcome, preserved for the LLM
   * supervisor path so it doesn't need to re-fetch the outcome.
   *
   * Ordered by rank ascending (rank 1 = first).
   */
  full_ranking: IssueRef[];
}

// ---------------------------------------------------------------------------
// Evaluation context
// ---------------------------------------------------------------------------

/**
 * Caller-supplied runtime context for the rule checks that require
 * knowledge of the live fleet state (open PRs, in-flight tasks, etc.).
 *
 * The reviewer itself doesn't query GitHub or the state store — those
 * checks are the orchestrator daemon's responsibility.  The daemon performs
 * the lookups and passes the results here so the rule evaluation stays
 * pure and testable.
 */
export interface DispatchEvaluationContext {
  /**
   * Issue refs whose PRs are already merged (used for sequencing checks).
   *
   * An issue is considered "merged" when its associated PR has been squash-
   * merged into the target branch.  Pass an empty array when the caller
   * cannot determine merged state — the sequencing rule will then conservatively
   * pass (assume predecessors are met).
   */
  mergedIssues?: IssueRef[];
  /**
   * Issue refs that currently have an open (non-merged, non-closed) PR.
   * When the top-ranked issue appears here, dispatch is blocked (PR guard).
   */
  openPRIssues?: IssueRef[];
  /**
   * Issue refs that have an in-flight orchestrator task (dispatched but not
   * yet verified).  When the top-ranked issue appears here, dispatch is
   * blocked to prevent duplicate tasks.
   */
  inflightTaskIssues?: IssueRef[];
  /**
   * When `true`, override the `RULE_NO_FOLLOW_UP` block and allow dispatch
   * even when `follow_up_recommended` is set on the outcome.
   *
   * Use this for high-urgency situations where the operator has explicitly
   * decided to proceed without a follow-up meeting.
   */
  urgencyOverride?: boolean;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for `MeetingPriorityDispatcher`. */
export interface MeetingPriorityDispatcherOptions {
  /**
   * Minimum `verifier_score` (0–1) required for the outcome to qualify for
   * auto-dispatch.  Outcomes with scores below this threshold are deferred
   * to LLM judgment.
   *
   * Defaults to 0.70.  Set to 0 to disable the check.
   */
  minVerifierScore?: number;
  /**
   * When `true`, log every rule evaluation at INFO level (useful for
   * debugging dispatch decisions in staging).  Defaults to `false`.
   */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSameIssue(a: IssueRef, b: IssueRef): boolean {
  return a.repo === b.repo && a.number === b.number;
}

function issueLabel(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/**
 * Check whether `target` is blocked by any sequencing constraint — i.e.
 * whether a constraint lists `target` as the `successor` AND the
 * corresponding `predecessor` has NOT yet been merged.
 *
 * Returns the blocking constraint if one is found, or `null` if the issue
 * is free to proceed.
 */
function findBlockingConstraint(
  target: IssueRef,
  constraints: SequencingConstraint[],
  mergedIssues: IssueRef[],
): SequencingConstraint | null {
  for (const c of constraints) {
    if (!isSameIssue(c.successor, target)) continue;
    const predecessorMerged = mergedIssues.some((m) =>
      isSameIssue(m, c.predecessor),
    );
    if (!predecessorMerged) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core evaluation function (pure)
// ---------------------------------------------------------------------------

/**
 * Evaluate whether the top-ranked issue in `outcome` should be auto-dispatched.
 *
 * This is the pure-function entry point — it has no side effects and makes
 * no network calls.  The `MeetingPriorityDispatcher` class wraps this with
 * configurable defaults and logging.
 *
 * @param outcome   The completed `MeetingOutcome` from the meeting-facilitator.
 * @param ctx       Live fleet state provided by the orchestrator daemon.
 * @param opts      Rule thresholds (optional).
 *
 * @example
 *   const decision = evaluateAutoDispatch(outcome, {
 *     openPRIssues: openPrs,
 *     inflightTaskIssues: inflightTasks,
 *     mergedIssues: mergedPrs,
 *   });
 *   if (decision.action === 'dispatch') {
 *     await daemon.dispatch(decision.issue!);
 *   }
 */
export function evaluateAutoDispatch(
  outcome: MeetingOutcome,
  ctx: DispatchEvaluationContext = {},
  opts: MeetingPriorityDispatcherOptions = {},
): PriorityDispatchDecision {
  const minScore = opts.minVerifierScore ?? 0.70;
  const mergedIssues = ctx.mergedIssues ?? [];
  const openPRIssues = ctx.openPRIssues ?? [];
  const inflightTaskIssues = ctx.inflightTaskIssues ?? [];

  // Build ordered issue list (rank ascending)
  const ranked = [...outcome.priority_ranking].sort((a, b) => a.rank - b.rank);
  const full_ranking = ranked.map((e) => e.issue);

  // ── RULE_OUTCOME_COMPLETE ────────────────────────────────────────────────
  if (outcome.status !== "complete") {
    return {
      action: "skip",
      issue: full_ranking[0] ?? null,
      reason: `Meeting outcome ${outcome.meeting_id} is not yet complete (status: ${outcome.status}); skipping auto-dispatch this cycle.`,
      skipped_rules: ["RULE_OUTCOME_COMPLETE"],
      full_ranking,
    };
  }

  // ── RULE_RANKING_NONEMPTY ────────────────────────────────────────────────
  if (ranked.length === 0) {
    return {
      action: "skip",
      issue: null,
      reason: `Meeting outcome ${outcome.meeting_id} has no priority ranking; nothing to dispatch.`,
      skipped_rules: ["RULE_RANKING_NONEMPTY"],
      full_ranking: [],
    };
  }

  const topEntry = ranked[0]!;
  const topIssue = topEntry.issue;

  // ── RULE_MIN_VERIFIER_SCORE ──────────────────────────────────────────────
  if (
    minScore > 0 &&
    outcome.verifier_score !== null &&
    outcome.verifier_score < minScore
  ) {
    return {
      action: "defer-to-llm",
      issue: topIssue,
      reason: `Meeting outcome ${outcome.meeting_id} verifier score ${outcome.verifier_score.toFixed(2)} is below threshold ${minScore.toFixed(2)}; deferring to LLM for judgment.`,
      skipped_rules: ["RULE_MIN_VERIFIER_SCORE"],
      full_ranking,
    };
  }

  // ── RULE_NO_FOLLOW_UP ────────────────────────────────────────────────────
  if (outcome.follow_up_recommended && !ctx.urgencyOverride) {
    return {
      action: "defer-to-llm",
      issue: topIssue,
      reason: `Meeting outcome ${outcome.meeting_id} recommends a follow-up meeting before implementation (${outcome.follow_up_rationale ?? "no rationale given"}); deferring to LLM.`,
      skipped_rules: ["RULE_NO_FOLLOW_UP"],
      full_ranking,
    };
  }

  // ── RULE_NO_SEQUENCING_BLOCK ─────────────────────────────────────────────
  const blockingConstraint = findBlockingConstraint(
    topIssue,
    outcome.sequencing_constraints,
    mergedIssues,
  );
  if (blockingConstraint) {
    return {
      action: "defer-to-llm",
      issue: topIssue,
      reason: `${issueLabel(topIssue)} is blocked by sequencing constraint: ${issueLabel(blockingConstraint.predecessor)} must merge first (${blockingConstraint.reason}); deferring to LLM.`,
      skipped_rules: ["RULE_NO_SEQUENCING_BLOCK"],
      full_ranking,
    };
  }

  // ── RULE_NO_OPEN_PR ──────────────────────────────────────────────────────
  if (openPRIssues.some((ref) => isSameIssue(ref, topIssue))) {
    return {
      action: "skip",
      issue: topIssue,
      reason: `${issueLabel(topIssue)} already has an open PR; skipping to avoid re-implementation.`,
      skipped_rules: ["RULE_NO_OPEN_PR"],
      full_ranking,
    };
  }

  // ── RULE_NO_INFLIGHT_TASK ────────────────────────────────────────────────
  if (inflightTaskIssues.some((ref) => isSameIssue(ref, topIssue))) {
    return {
      action: "skip",
      issue: topIssue,
      reason: `${issueLabel(topIssue)} already has an in-flight task; skipping to avoid duplicate dispatch.`,
      skipped_rules: ["RULE_NO_INFLIGHT_TASK"],
      full_ranking,
    };
  }

  // ── All rules passed → DISPATCH ──────────────────────────────────────────
  return {
    action: "dispatch",
    issue: topIssue,
    reason: `All rules passed for meeting ${outcome.meeting_id}; auto-dispatching rank-1 issue ${issueLabel(topIssue)} (${topEntry.rationale}).`,
    skipped_rules: [],
    full_ranking,
  };
}

// ---------------------------------------------------------------------------
// Class wrapper
// ---------------------------------------------------------------------------

/**
 * `MeetingPriorityDispatcher` wraps `evaluateAutoDispatch()` with configurable
 * thresholds and structured logging.
 *
 * Instantiate once (e.g. in the orchestrator adapter) and reuse across daemon
 * cycles — it is stateless.
 *
 * @example
 *   const dispatcher = new MeetingPriorityDispatcher({ minVerifierScore: 0.75 });
 *
 *   for (const outcome of completedOutcomes) {
 *     const decision = dispatcher.evaluate(outcome, fleetCtx);
 *     log.info('priority dispatch decision', decision);
 *     if (decision.action === 'dispatch') { ... }
 *   }
 */
export class MeetingPriorityDispatcher {
  private readonly opts: Required<MeetingPriorityDispatcherOptions>;

  constructor(opts: MeetingPriorityDispatcherOptions = {}) {
    this.opts = {
      minVerifierScore: opts.minVerifierScore ?? 0.70,
      verbose: opts.verbose ?? false,
    };
  }

  /**
   * Evaluate whether the top-ranked issue in `outcome` qualifies for
   * immediate auto-dispatch.
   *
   * Logs the decision at INFO level when `verbose` is enabled, or at WARN
   * level when the decision is "defer-to-llm" (always, regardless of
   * verbosity).
   */
  evaluate(
    outcome: MeetingOutcome,
    ctx: DispatchEvaluationContext = {},
  ): PriorityDispatchDecision {
    const decision = evaluateAutoDispatch(outcome, ctx, this.opts);

    if (decision.action === "defer-to-llm") {
      log.warn("Meeting priority dispatch deferred to LLM", {
        meeting_id: outcome.meeting_id,
        action: decision.action,
        skipped_rules: decision.skipped_rules,
        reason: decision.reason,
        top_issue: decision.issue ? issueLabel(decision.issue) : null,
      });
    } else if (this.opts.verbose || decision.action === "dispatch") {
      log.info("Meeting priority dispatch decision", {
        meeting_id: outcome.meeting_id,
        action: decision.action,
        skipped_rules: decision.skipped_rules,
        reason: decision.reason,
        top_issue: decision.issue ? issueLabel(decision.issue) : null,
      });
    }

    return decision;
  }

  /**
   * Batch-evaluate a list of completed outcomes and return only those that
   * produced a "dispatch" decision.
   *
   * Useful when the daemon accumulates multiple `meeting_priority_outcome`
   * signals in a single poll cycle.
   *
   * @example
   *   const ready = dispatcher.filterDispatchable(outcomes, fleetCtx);
   *   for (const { outcome, decision } of ready) {
   *     await daemon.dispatch(decision.issue!);
   *   }
   */
  filterDispatchable(
    outcomes: MeetingOutcome[],
    ctx: DispatchEvaluationContext = {},
  ): Array<{ outcome: MeetingOutcome; decision: PriorityDispatchDecision }> {
    const results: Array<{ outcome: MeetingOutcome; decision: PriorityDispatchDecision }> = [];

    for (const outcome of outcomes) {
      const decision = this.evaluate(outcome, ctx);
      if (decision.action === "dispatch") {
        results.push({ outcome, decision });
      }
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create a `MeetingPriorityDispatcher` with sensible defaults.
 *
 * @example
 *   const dispatcher = createMeetingPriorityDispatcher();
 *   const decision = dispatcher.evaluate(outcome, ctx);
 */
export function createMeetingPriorityDispatcher(
  opts?: MeetingPriorityDispatcherOptions,
): MeetingPriorityDispatcher {
  return new MeetingPriorityDispatcher(opts);
}

// ---------------------------------------------------------------------------
// Re-export IssueRef for convenience (consumers of this module often need it)
// ---------------------------------------------------------------------------
export type { IssueRef, MeetingOutcome, SequencingConstraint };
