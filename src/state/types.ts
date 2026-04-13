/**
 * Shared state types used by reviewer modules.
 * These mirror the orchestrator's StateStore schema so the reviewer
 * can read from the same shared state.db.
 */

export type TaskStatus =
  | "pending"
  | "planning"
  | "dispatched"
  | "in_progress"
  | "done"
  | "failed"
  | "escalated";
export type VerificationStatus = "pending" | "approved" | "rejected" | null;
export type TaskType = "implementation" | "research";

/**
 * Determines how a parent task's quality score is derived from its children's
 * individual verification scores.
 *
 * Set by the orchestrator dispatcher on the parent task record at dispatch time.
 * Read by the Verifier when scoring a parent task via `rollupChildScores()`.
 *
 * - `strict`:   parent score = min(child scores); any child below the approval
 *               threshold (0.80) fails the whole parent. Re-dispatch targets
 *               only the failing child.
 * - `majority`: parent score = mean(child scores); passes if ≥50% of children
 *               individually pass (score ≥ 0.80).
 * - `weighted`: parent score = weighted mean, where each child's weight comes
 *               from its `subtask_complexity_hint` (0–1). Falls back to
 *               `majority` (equal weights) when hints are absent.
 */
export type SubtaskRollupPolicy = "strict" | "majority" | "weighted";

/**
 * The outcome of rolling up child verification scores to a parent task score.
 * Returned by `Verifier.rollupChildScores()`.
 */
export interface SubtaskRollupResult {
  /** Rolled-up parent score (0–1), computed per the policy. */
  parentScore: number;
  /** True when the parent passes the 0.80 approval threshold. */
  approved: boolean;
  /** Policy that was applied. */
  policy: SubtaskRollupPolicy;
  /** Per-child summary — useful for targeted re-dispatch. */
  children: SubtaskChildSummary[];
  /**
   * IDs of children that failed (score < 0.80 or status = 'failed'/'escalated').
   * The orchestrator uses this list to re-dispatch only the failing subtasks
   * when policy = 'strict'.
   */
  failingChildIds: string[];
  /**
   * How many children had a terminal status (done | failed | escalated) vs.
   * still in-flight (pending | planning | dispatched | in_progress).
   */
  completedCount: number;
  pendingCount: number;
  /**
   * Present when some children have not yet completed. The parent cannot be
   * fully scored until all children finish. The orchestrator should wait or
   * apply a partial-score policy (see `approved`).
   */
  partialCompletion: boolean;
}

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  agent_name?: string | null;
  task_type: TaskType;
  source?: string | null;
  source_ref?: string | null;
  result?: string | null;
  verification_status?: VerificationStatus;
  quality_score?: number | null;
  verification_notes?: string | null;
  /**
   * Natural-language narrative explaining why the score fell below 0.80.
   * Populated only for sub-0.80 results; null otherwise.
   */
  quality_explanation?: string | null;
  /**
   * ID of the parent task when this task is a subtask in a parallel tree.
   * Null for top-level tasks. Set by the dispatcher at creation time.
   */
  parent_task_id?: string | null;
  /**
   * Rollup policy for scoring this task's children.
   * Only meaningful on parent tasks (those that have children via parent_task_id).
   * Null on leaf tasks and on parents that have not been given an explicit policy
   * (the verifier defaults to 'majority' in that case).
   */
  rollup_policy?: SubtaskRollupPolicy | null;
  /**
   * Relative complexity hint for this subtask (0.0–1.0).
   * Used as the weight in `weighted` rollup policy. Higher = more complex.
   * Null when not provided; treated as equal weight (1.0) during rollup.
   */
  subtask_complexity_hint?: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Per-child summary included in SubtaskRollupResult.
 */
export interface SubtaskChildSummary {
  id: string;
  agent_name: string | null;
  status: TaskStatus;
  /** null when the child has not yet been verified or is still in-flight. */
  quality_score: number | null;
  verification_status: VerificationStatus;
  /** Weight applied during rollup (from subtask_complexity_hint or 1.0 default). */
  weight: number;
  /** True when this child is considered failing for rollup purposes. */
  failing: boolean;
}

/**
 * Structured rationale for a supervisor dispatch decision.
 *
 * Stored as JSON in the `rationale` column of `supervisor_decisions`.
 * The orchestrator builds this when dispatching; the reviewer reads it
 * for display in `orch supervisor-log` / `orch decisions` CLI output.
 */
export interface DispatchRationale {
  /** Free-text explanation from the supervisor LLM */
  llm_reasoning: string | null;
  /** Issue state at the moment of dispatch (e.g. "open", "closed") */
  issue_state_at_dispatch: string | null;
  /** Result of the existing-PR check (e.g. "none", "open PR", "merged PR") */
  existing_pr_check_result: string | null;
  /** How long the target agent had been idle before this dispatch (ms), null if unknown */
  agent_idle_duration_ms: number | null;
  /** LLM-assigned confidence score (0-1), null if not provided */
  confidence_score: number | null;
  /**
   * True when this dispatch is a borrow — an agent working on an issue outside
   * its normal domain.  Annotated here so `orch decisions --search borrow` and
   * the improvement detector can surface borrow-heavy patterns.
   */
  borrow?: boolean;
  /** Summary of the authoritative pre-dispatch validation outcome, if any */
  pre_dispatch_validation?: {
    outcome: "passed" | "blocked";
    failure_check: string | null;
    failure_code: string | null;
    failure_reason: string | null;
  } | null;
}

export interface SupervisorDecisionRecord {
  id: number | string;
  action: string;
  agent_name?: string | null;
  task_id?: string | null;
  issue_ref?: string | null;
  reason: string;
  message?: string | null;
  outcome: string;
  /**
   * JSON-encoded `DispatchRationale`.  Present on dispatch and borrow-blocked
   * events; null for verify/redeploy/none actions.
   */
  rationale?: string | null;
  created_at: string;
}

/** Filter options for querying supervisor decisions. */
export interface SupervisorDecisionQuery {
  /** Return at most this many decisions (default 20, max 100). */
  limit?: number;
  /** Filter to a specific action type (e.g. "dispatch", "none"). */
  action?: string;
  /** Filter to decisions for a specific agent. */
  agentName?: string;
  /** Filter to decisions with a specific outcome (e.g. "dispatched", "escalated"). */
  outcome?: string;
  /** Return only decisions created after this ISO-8601 timestamp. */
  since?: string;
}

export interface MergeQueueEntry {
  id?: number;
  repo: string;
  pr_number: number;
  branch: string;
  status: "queued" | "merging" | "merged" | "failed" | "skipped";
  position: number;
  error?: string | null;
  /** Alias for created_at; the orchestrator uses enqueued_at */
  enqueued_at?: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface AgentStats {
  agent_name: string;
  total: number;
  done: number;
  failed: number;
  avg_score?: number | null;
}

/** One calendar day's task-completion efficiency for a given scope. */
export interface EfficiencyTrendPoint {
  /** "YYYY-MM-DD" calendar date. */
  date: string;
  /** Tasks that reached "done" on this day. */
  done: number;
  /** Tasks that reached "failed" on this day. */
  failed: number;
  /** done + failed */
  total: number;
  /**
   * done / (done + failed) as a 0-1 fraction, or null when there were no
   * completed or failed tasks on this day.
   */
  efficiency_rate: number | null;
}

/** A 7-day (or N-day) efficiency time series for one agent. */
export interface EfficiencyTrendSeries {
  agent_name: string;
  days: EfficiencyTrendPoint[];
}

/** Full response from `getEfficiencyTrend()`. */
export interface EfficiencyTrend {
  /** Number of days in the look-back window. */
  days: number;
  /** 0-1 rate below which a day is highlighted as a warning. */
  warning_threshold: number;
  /** 0-1 rate below which a day is highlighted as critical. */
  critical_threshold: number;
  /** System-wide daily points (all agents combined). */
  system: EfficiencyTrendPoint[];
  /** Per-agent series, one entry per agent that had any activity in the window. */
  per_agent: EfficiencyTrendSeries[];
}

/**
 * Per-agent health record from the `agent_health` table.
 * Written by the orchestrator's dispatcher on dispatch success/failure;
 * read here by the supervisor for context-building.
 */
export interface AgentHealth {
  agent_name: string;
  consecutive_failures: number;
  last_error_at: string | null;
  last_error_message: string | null;
  last_success_at: string | null;
  updated_at: string;
}

/** A key-value system flag persisted to state.db (e.g. paused=true). */
export interface SystemFlag {
  key: string;
  value: string;
  updated_at: string;
}

/**
 * A recent PR review record with its confidence score.
 * Returned by `getRecentPRReviewConfidences()` for the supervisor context.
 */
export interface PRConfidenceRecord {
  repo: string;
  pr_number: number;
  decision: string;
  /** Reviewer confidence in the decision (0.0–1.0), or null if not recorded. */
  confidence: number | null;
  created_at: string;
}

/** A dispatch request inserted by the Telegram /dispatch command. */
export interface DispatchRequest {
  id: string;
  agent_name: string;
  message: string;
  status: "pending" | "dispatched" | "failed";
  created_at: string;
}

// ── Calibration drift types ───────────────────────────────────────────────

/**
 * A single bucket of the score histogram for one agent.
 * bucket_min is 0.0, 0.1, 0.2, ..., 0.9 (lower inclusive bound of a 0.1-wide range).
 */
export interface ScoreDistributionBucket {
  bucket_min: number;
  count: number;
}

/**
 * Score distribution for a single agent over a time window.
 * Used for the /verification-calibration dashboard page.
 */
export interface AgentScoreDistribution {
  agent_name: string;
  /** Total tasks with a quality_score in the window. */
  task_count: number;
  /** Mean quality score across all scored tasks (null if none). */
  mean_score: number | null;
  /**
   * Low-confidence approval rate: fraction of approved tasks whose
   * quality_score was below 0.8 (a proxy for false-positive risk).
   * Null when no approvals exist in the window.
   */
  low_confidence_approval_rate: number | null;
  /** Score histogram, one entry per 0.1-wide bucket that has at least one task. */
  buckets: ScoreDistributionBucket[];
}

/**
 * Drift alert for a single agent.
 * Compares the recent window mean score to a baseline window mean.
 */
export interface CalibrationDriftAlert {
  agent_name: string;
  /** Mean quality score in the baseline window (31-90 days ago by default). */
  baseline_mean: number;
  /** Number of tasks in the baseline window. */
  baseline_task_count: number;
  /** Mean quality score in the recent window (last 30 days by default). */
  recent_mean: number;
  /** Number of tasks in the recent window. */
  recent_task_count: number;
  /** Signed drift: recent_mean − baseline_mean. */
  drift: number;
  /** True when |drift| > 0.1 (alert threshold). */
  alerted: boolean;
}

/**
 * Full calibration drift report, returned by CalibrationDriftMonitor.buildReport().
 */
export interface CalibrationDriftReport {
  generated_at: string;
  /** Look-back window for score distributions (days). */
  window_days: number;
  /** Per-agent score distributions for the window. */
  distributions: AgentScoreDistribution[];
  /** Drift alerts — one per agent that has data in both windows. */
  drift_alerts: CalibrationDriftAlert[];
}

/**
 * Per-agent routing accuracy statistics computed from verified tasks.
 * Surfaces avg quality scores and approval rates to drive smarter routing.
 */
export interface RoutingAccuracyStats {
  agent_name: string;
  /** Total tasks routed to this agent in the window. */
  total_routed: number;
  /** Tasks that completed verification (approved or rejected). */
  verified_count: number;
  /** Average quality_score across verified tasks (0-1), or null if none. */
  avg_quality_score: number | null;
  /**
   * Fraction of verified tasks that were approved (0-1), or null if none
   * have completed verification.
   */
  approval_rate: number | null;
}

/** Quality breakdown for one task type within an agent's history. */
export interface AgentTaskTypeQuality {
  task_type: string;
  task_count: number;
  avg_quality_score: number | null;
  approval_rate: number | null;
}

/**
 * Per-agent quality breakdown grouped by task type.
 * Lets the supervisor answer "which agent is best at implementation vs. research?"
 */
export interface AgentQualityByTaskType {
  agent_name: string;
  by_task_type: AgentTaskTypeQuality[];
}

/** Operator-configured quality SLA threshold for one agent. */
export interface AgentSLAThreshold {
  /** Agent identifier (e.g., "claude-orchestrator-reviewer") */
  agent_name: string;
  /** Minimum average quality score (0–1) for rolling window. Breach alert fires when avg drops below this. */
  min_avg_score: number;
  /** Number of most-recent verified tasks to include in rolling window. */
  window_tasks: number;
}

/**
 * Core StateStore interface consumed by reviewer modules.
 *
 * This is intentionally scoped to the methods the orchestrator's StateStore
 * actually implements. Reviewer modules (verifier, supervisor, pr-reviewer)
 * depend only on this interface so the orchestrator can inject its own
 * StateStore without needing to add reviewer-only methods.
 *
 * DO NOT add methods here unless the orchestrator's StateStore implements them.
 * Telegram-specific helpers live in ITelegramStateStore below.
 */
/**
 * Discriminates which reviewer subsystem made an LLM call.
 */
export type LlmCallType = "pr_review" | "task_verify" | "supervisor" | "improvement" | "pr_review_issue_match";

/**
 * One record per Anthropic SDK call emitted by the reviewer.
 * Written to `llm_call_events` in state.db after each call completes.
 */
export interface LlmCallEvent {
  call_type: LlmCallType;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from the prompt cache (cache_read_input_tokens). */
  cache_read_tokens?: number;
  /** Tokens written into the prompt cache (cache_creation_input_tokens). */
  cache_write_tokens?: number;
  /** Wall-clock duration in ms from call start to response. */
  duration_ms?: number;
  /** Links to the tasks table when the call is for a specific task. */
  task_id?: string;
  /** Links to the PR being reviewed (pr_reviews table). */
  pr_number?: number;
}

/**
 * Per-call-type token usage summary returned by `getTokenStats()`.
 */
export interface LlmTokenStats {
  call_type: LlmCallType;
  call_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  avg_duration_ms: number | null;
}

export interface IStateStore {
  // Task operations
  getTask(id: string): Task | null | undefined;
  updateTask(id: string, updates: Partial<Task>): void;
  hasActiveTask(agentName: string): boolean;
  listTasks(opts: { status?: TaskStatus; agent_name?: string; limit?: number }): Task[];
  /**
   * Return all direct children of a parent task, ordered by created_at ASC.
   * Returns an empty array when the parent has no children or does not exist.
   * Required for SubtaskRollupPolicy scoring in the Verifier.
   */
  getChildTasks(parentTaskId: string): Task[];

  // Query helpers
  getRecentCompleted(limit: number): Task[];
  getUnverified(limit: number): Task[];
  getAgentStats(): AgentStats[];
  getEfficiencyTrend(
    days?: number,
    warningThreshold?: number,
    criticalThreshold?: number,
  ): EfficiencyTrend;

  // Routing accuracy feedback
  getRoutingAccuracyStats(days?: number): RoutingAccuracyStats[];
  getAgentQualityByTaskType(days?: number): AgentQualityByTaskType[];

  // Calibration drift monitoring
  getScoreDistributions(days?: number): AgentScoreDistribution[];
  getCalibrationDriftAlerts(recentDays?: number, baselineDays?: number): CalibrationDriftAlert[];

  // Agent health (reads from orchestrator's agent_health table)
  getAgentHealthBatch(agentNames: string[]): AgentHealth[];

  // Supervisor memory
  getRecentSupervisorDecisions(limit: number): SupervisorDecisionRecord[];
  querySupervisorDecisions(opts: SupervisorDecisionQuery): SupervisorDecisionRecord[];
  pruneOldSupervisorDecisions(daysOld?: number): number;
  /**
   * Persist a supervisor decision.  Called by both the reviewer (for
   * dispatch/verify/none actions) and the orchestrator (for borrow-blocked
   * and other policy events) to keep a unified audit log.
   */
  recordSupervisorDecision(
    action: string,
    reason: string,
    opts?: {
      agentName?: string;
      taskId?: string;
      outcome?: string;
      message?: string;
      issueRef?: string;
      /** JSON-encoded DispatchRationale, e.g. '{"borrow":true,...}' */
      rationale?: string;
    },
  ): void;

  // PR merge queue
  queuePRForMerge(repo: string, prNumber: number, branch: string): MergeQueueEntry;
  getMergeQueue(repo?: string): MergeQueueEntry[];
  isPRInMergeQueue(repo: string, prNumber: number): boolean;
  markQueuedPRMerging(repo: string, prNumber: number): void;
  markQueuedPRMerged(repo: string, prNumber: number): void;
  markQueuedPRFailed(repo: string, prNumber: number, error: string): void;
  removeFromMergeQueue(repo: string, prNumber: number): void;

  // PR review history
  recordPRReview(repo: string, prNumber: number, decision: string, confidence?: number | null): void;

  // LLM token instrumentation
  /**
   * Persist a per-call token usage record after every Anthropic SDK call completes.
   * Fire-and-forget — callers should not await errors from this method.
   */
  recordLlmCallEvent(event: LlmCallEvent): void;
  /**
   * Return aggregate token usage grouped by call_type.
   *
   * @param sinceHours - Look-back window in hours (default: 720 = 30 days).
   */
  getTokenStats(sinceHours?: number): LlmTokenStats[];
}

// ── Score calibration types ───────────────────────────────────────────────

/**
 * The eventual outcome of a PR that was submitted after a task was verified.
 *
 * - merged:              PR merged without changes — score was accurate or conservative.
 * - changes_requested:  PR got review feedback   — score was too generous.
 * - rejected:           PR closed without merge  — score was way off.
 * - redispatched:       Task re-dispatched after verification — verification missed something.
 */
export type PROutcome = "merged" | "changes_requested" | "rejected" | "redispatched";

/**
 * A recorded PR outcome event, linking a task's verification score to
 * the actual result of the PR that was submitted for that task.
 *
 * Stored in the `pr_outcome_records` table.
 */
export interface PROutcomeRecord {
  id: string;
  task_id: string;
  agent_name: string;
  task_type: TaskType;
  /** The quality_score assigned by the Verifier (0.0–1.0). */
  quality_score: number;
  /**
   * The lower bound of the 0.1-wide score bucket containing quality_score.
   * E.g. quality_score=0.82 → score_bucket=0.8.
   * Pre-computed and stored so calibration queries avoid expensive CASE expressions.
   */
  score_bucket: number;
  repo: string;
  pr_number: number;
  outcome: PROutcome;
  recorded_at: string;
}

/**
 * Aggregated calibration data for one `(agent, score_bucket, task_type)` cell.
 *
 * The calibration table maps verification scores to actual PR merge rates so
 * the system can detect when a verifier's scores are miscalibrated.
 *
 * Example:
 *   agent=claude-reviewer  bucket=0.7  type=implementation  → merge_rate=0.85
 *   agent=codex-reviewer   bucket=0.7  type=implementation  → merge_rate=0.40
 */
export interface ScoreCalibrationRow {
  agent_name: string;
  task_type: TaskType;
  score_bucket: number;
  total_count: number;
  merge_count: number;
  /** Fraction of PRs in this cell that were merged (0-1). */
  actual_merge_rate: number;
}

/**
 * A per-agent recommended min_score threshold, derived from calibration data.
 *
 * The recommended_min_score is the lowest score bucket where
 * `actual_merge_rate >= target_merge_rate` (default 0.80).
 * If no bucket meets the target, `recommended_min_score` is null.
 */
export interface AdjustedThreshold {
  agent_name: string;
  task_type: TaskType;
  /** Current min_score used by the verifier for this agent (0-1). */
  current_min_score: number;
  /**
   * Recommended min_score based on calibration data (0-1), or null if
   * there is insufficient data to make a recommendation.
   */
  recommended_min_score: number | null;
  /** Number of outcome records used to compute this recommendation. */
  sample_count: number;
  /**
   * True when the recommended threshold differs from the current one by
   * more than 0.05 and there is sufficient data (sample_count ≥ 5).
   */
  action_required: boolean;
}

/**
 * Store interface for score calibration persistence.
 *
 * These methods are implemented by the reviewer's own StateStore.
 * The orchestrator's StateStore may not implement them — callers should
 * check at runtime (e.g. via `typeof store.recordPROutcome === 'function'`).
 */
export interface IScoreOutcomeStore {
  recordPROutcome(record: Omit<PROutcomeRecord, "id" | "recorded_at">): void;
  getCalibrationData(): ScoreCalibrationRow[];
  getAdjustedThresholds(targetMergeRate?: number, currentMinScore?: number): AdjustedThreshold[];
}

// ── PR iteration tracking types ───────────────────────────────────────────

/**
 * Well-known categories of review feedback that can be extracted from
 * review comments to surface systemic patterns across PRs and agents.
 *
 * - `logic`             — Incorrect behaviour, wrong algorithm, off-by-one errors
 * - `security`          — Credential exposure, injection risk, unsafe practices
 * - `missing-closes-ref`— PR body is missing a valid `Closes #N` reference
 * - `merge-conflict`    — PR has unresolved merge conflicts
 * - `test-coverage`     — Missing or insufficient test coverage
 * - `schema-breaking`   — Breaking schema change not flagged in the diff
 * - `feedback-ceiling`  — PR hit the max revision round cap
 * - `diff-too-large`    — Diff exceeds safe automated review size
 * - `stale-branch`      — Branch is significantly behind `origin/main`
 * - `code-quality`      — General code style, structure, or readability issues
 * - `other`             — Any feedback not matching a specific category above
 */
export type ReviewCategory =
  | "logic"
  | "security"
  | "missing-closes-ref"
  | "merge-conflict"
  | "test-coverage"
  | "schema-breaking"
  | "feedback-ceiling"
  | "diff-too-large"
  | "stale-branch"
  | "code-quality"
  | "other";

/**
 * Iteration history for a single PR (one row per repo+pr_number combination
 * in the `pr_reviews` table).
 */
export interface PRIterationStat {
  repo: string;
  pr_number: number;
  /** Agent that authored the PR, if known (from the pr_reviews record). */
  agent_name: string | null;
  /** Total number of review rounds recorded for this PR. */
  review_count: number;
  /** Most recent review decision (approve / request-changes / escalate). */
  final_decision: string | null;
  /** ISO-8601 timestamp of the first review for this PR. */
  first_review_at: string;
  /** ISO-8601 timestamp of the most recent review for this PR. */
  last_review_at: string;
}

/**
 * Per-agent PR iteration statistics — which agents generate PRs that
 * require the most feedback rounds before merging or escalating.
 */
export interface AgentIterationStat {
  agent_name: string;
  /** Total distinct PRs where this agent is recorded as the author. */
  total_prs: number;
  /** PRs that went through more than one revision round. */
  multi_round_prs: number;
  /** Average number of review rounds across all PRs for this agent. */
  avg_rounds: number;
  /** Maximum revision rounds seen for any single PR from this agent. */
  max_rounds: number;
}

/** Frequency of a single review category across all recorded reviews. */
export interface ReviewCategoryCount {
  category: string;
  count: number;
}

/**
 * Full PR iteration report returned by `IPRIterationStore.getPRIterationReport()`.
 */
export interface PRIterationReport {
  generated_at: string;
  /** Look-back window in days used for the report. */
  window_days: number;
  /** PRs that required two or more review rounds in the window. */
  multi_round_prs: PRIterationStat[];
  /** Per-agent iteration statistics, sorted by avg_rounds descending. */
  agent_stats: AgentIterationStat[];
  /** Most frequently recurring review categories, sorted by count descending. */
  top_categories: ReviewCategoryCount[];
}

/** One weekly bucket in the revision-rate trend. */
export interface PRIterationTrendPoint {
  /** ISO date of the week start (Monday). */
  week_start: string;
  total_prs: number;
  prs_with_revisions: number;
  revision_rate: number | null;
  avg_rounds_to_merge: number | null;
}

/** Weekly revision-rate trend series. */
export interface PRIterationTrend {
  window_days: number;
  points: PRIterationTrendPoint[];
  /** Direction of the most recent 2-week comparison: "improving" | "worsening" | "stable" | "insufficient_data" */
  direction: "improving" | "worsening" | "stable" | "insufficient_data";
  /** Absolute change in revision_rate between last 2 weeks (positive = worse). */
  delta: number | null;
}

/** Coaching directive for an agent whose revision rate exceeds the threshold. */
export interface AgentCoachingDirective {
  agent_name: string;
  revision_pct: number;
  feedback_tasks: number;
  /** Top patterns that are driving revisions for this agent */
  top_patterns: Array<{ pattern: string; count: number }>;
  /** Top redispatch categories attributed to this agent's PRs */
  top_categories: Array<{ category: string; count: number }>;
  /** Short actionable summary for the agent */
  directive: string;
}

/**
 * Store interface for PR iteration tracking persistence.
 *
 * Implemented by the reviewer's own StateStore.  The orchestrator's StateStore
 * may not implement these methods — callers should guard with a runtime check
 * (e.g. `typeof store.recordPRReviewDetails === 'function'`).
 */
export interface IPRIterationStore {
  /**
   * Persist extended PR review metadata (iteration number, author, categories).
   *
   * Callers should invoke this *in addition to* the base `recordPRReview` when
   * the extra fields are available.  The method auto-computes `review_number`
   * by counting prior rows for the same (repo, pr_number) pair.
   */
  recordPRReviewDetails(
    repo: string,
    prNumber: number,
    decision: string,
    opts?: {
      confidence?: number | null;
      agentName?: string | null;
      /** Categorised reasons for a `request-changes` decision. */
      reviewCategories?: ReviewCategory[];
    },
  ): void;

  /**
   * Return a summary report of PR iteration patterns within the given window.
   *
   * @param days - Look-back window (default: 30 days).
   */
  getPRIterationReport(days?: number): PRIterationReport;
}

/**
 * Extended interface for the reviewer's own StateStore, which adds
 * Telegram-specific operations (system flags, dispatch requests,
 * task prioritization).
 *
 * These methods are NOT required from the orchestrator's StateStore.
 * The TelegramCommandHandler and the reviewer's local StateStore use
 * this interface; reviewer modules wired into the orchestrator use
 * the narrower IStateStore above.
 */
// ── Standup synthesis health types ───────────────────────────────────────

/**
 * Synthesis confidence label stamped on every standup PR and issue.
 *
 * - `synthesized`:        Action items were successfully synthesized from standup content.
 * - `synthesis-fallback`: Synthesis produced 0 action items; fallback/retry logic ran.
 * - `empty-retry`:        A retry was attempted after an initial empty synthesis; still 0 items.
 */
export type StandupSynthesisLabel = "synthesized" | "synthesis-fallback" | "empty-retry";

/**
 * A single standup synthesis event recorded each time a standup is processed.
 * Stored in the `standup_synthesis_events` table.
 */
export interface StandupSynthesisEvent {
  id: string;
  repo: string;
  issue_number: number;
  label: StandupSynthesisLabel;
  action_item_count: number;
  recorded_at: string;
}

/**
 * One calendar day's standup synthesis health metrics.
 * Used to build the 7-day sparkline on the dashboard.
 */
export interface StandupHealthPoint {
  /** "YYYY-MM-DD" calendar date. */
  date: string;
  /** Total standup synthesis events on this day. */
  total: number;
  /** Events with label "synthesized" (successful). */
  synthesized: number;
  /** Events with label "synthesis-fallback" or "empty-retry". */
  fallback: number;
  /**
   * synthesized / total as a 0-1 fraction, or null when there were no
   * standup events on this day.
   */
  success_rate: number | null;
}

/**
 * Full standup health summary returned by `IStandupHealthStore.getStandupHealth()`.
 */
export interface StandupHealthSummary {
  /** Number of days in the look-back window (default: 7). */
  window_days: number;
  /** Daily health points for the sparkline. */
  points: StandupHealthPoint[];
  /** Number of fallback events in the rolling 24h window. */
  fallback_count_24h: number;
  /**
   * True when fallback_count_24h > 2 — signals that auto-escalation
   * to Telegram should fire.
   */
  should_escalate: boolean;
}

/**
 * Store interface for standup synthesis health persistence.
 *
 * Implemented by the reviewer's own StateStore.
 */
export interface IStandupHealthStore {
  /**
   * Record a standup synthesis event.
   * Called each time a standup issue is processed.
   */
  recordStandupSynthesisEvent(
    repo: string,
    issueNumber: number,
    label: StandupSynthesisLabel,
    actionItemCount: number,
  ): void;

  /**
   * Return standup health metrics for the given look-back window.
   *
   * @param days - Look-back window (default: 7 days).
   */
  getStandupHealth(days?: number): StandupHealthSummary;
}

// ── Verification result types ─────────────────────────────────────────────

/**
 * A single verification event recorded after each task scoring decision.
 * Stored in the `verification_results` table for calibration and monitoring.
 *
 * Schema agreed in rapartlu/agent-orchestrator#768.
 */
export interface VerificationResultRecord {
  id?: number;
  task_id: string;
  score: number;
  /** 1 = approved on first try, 0 = revision dispatched. */
  first_pass: number;
  /** LLM explanation when the task was rejected; null when approved. */
  rejection_reason: string | null;
  /** The min_score threshold configured at the time of verification (e.g. 0.80). */
  threshold: number;
  /** The agent whose task was verified (agent_name from the task record). */
  agent_id: string;
  /** ISO-8601 UTC timestamp of the verification event. */
  timestamp: string;
}

/**
 * Aggregated verification statistics for one agent over an optional time window.
 * Returned by `IVerificationResultStore.getVerificationStats()`.
 *
 * Used by calibration drift monitors and the score distribution dashboard.
 * Data source for agent-dashboard first-pass rate widget (issue #88) — now available
 * via `IVerificationResultStore.getVerificationStats()`. Surfaced in the Telegram
 * `/s` summary and `/agents` command as of issue #122.
 */
export interface VerificationStats {
  agent_id: string;
  total_verifications: number;
  /** Count of tasks approved on the first pass. */
  first_pass_count: number;
  /** Fraction of tasks approved on first pass (0–1), or null if no verifications. */
  first_pass_rate: number | null;
  /** Mean verification score across all tasks in the window. */
  avg_score: number | null;
  /** Count of tasks that were rejected (first_pass = 0). */
  rejection_count: number;
}

/**
 * Store interface for verification result persistence.
 *
 * Implemented by the reviewer's own StateStore.
 * The orchestrator's StateStore may not implement these methods — callers should
 * check at runtime (e.g. via `typeof store.insertVerificationResult === 'function'`).
 */
export interface IVerificationResultStore {
  /**
   * Persist a verification result record after each scoring decision.
   * Fire-and-forget — callers should swallow errors from this method.
   */
  insertVerificationResult(record: Omit<VerificationResultRecord, "id">): void;
  /**
   * Return aggregated verification statistics for a single agent.
   *
   * @param agentId - Agent name to filter by (matches `agent_id` column).
   * @param since   - Optional ISO-8601 lower bound on the `timestamp` column.
   *                  When omitted, all historical records are included.
   * @returns Stats object, or null when no records exist for the agent.
   */
  getVerificationStats(agentId: string, since?: string): VerificationStats | null;
}

export interface ITelegramStateStore
  extends IStateStore,
    IScoreOutcomeStore,
    IPRIterationStore,
    IStandupHealthStore,
    IVerificationResultStore {
  // System flags (pause/resume, operator overrides)
  getSystemFlag(key: string): string | null;
  setSystemFlag(key: string, value: string): void;

  // Dispatch requests from Telegram /dispatch command
  createDispatchRequest(agentName: string, message: string): DispatchRequest;
  getPendingDispatchRequests(): DispatchRequest[];

  // Task prioritization from Telegram /prioritize command
  /** Bump priority of the first task whose id starts with or title contains `titleOrId`. Returns true if a row was updated. */
  prioritizeTask(titleOrId: string): boolean;

  // Quality SLA thresholds (operator-configured, for monitoring quality regression)
  /** Retrieve all configured SLA thresholds for all agents. */
  getSLAThresholds(): AgentSLAThreshold[];
  /** Set or update an SLA threshold for one agent. */
  setSLAThreshold(agentName: string, minAvgScore: number, windowTasks: number): void;
}
