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
export type VerificationStatus = "pending" | "approved" | "rejected" | "needs_revision" | "needs_operator_review" | null;
export type TaskType = "implementation" | "research" | "housekeeping";

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
  /**
   * Issue priority score (0.0–1.0), computed by the orchestrator dispatcher
   * from GitHub issue labels and signals at dispatch time.
   *
   * Used by the verifier's priority quality gate: when `issue_priority ≥ 0.80`
   * and `quality_score < 0.60`, the task is escalated to a human via Telegram
   * instead of auto-approved, and its status moves to "escalated".
   *
   * Null when priority was not set at dispatch time (gate does not fire).
   */
  issue_priority?: number | null;
  /**
   * Records why a sub-0.60 task was approved despite the quality floor.
   *
   * Well-known values:
   * - `'operator_override'` — Explicit human approval via `/approve` command
   * - `'floor_not_enforced'` — Historical approval that slipped through without
   *   the quality floor gate firing (audit gap, backfilled by issue #295)
   *
   * Null when the task was not a sub-0.60 approval or has not been classified.
   */
  bypass_reason?: string | null;
  /**
   * JSON-serialised `DispatchForkSpec` — set when this task was dispatched
   * with a `fork_from` session spec (agent-reviewer#454).
   *
   * Null when the task used a fresh session or resumed its own prior session.
   * Non-null when the proxy was asked to clone a warm parent session as the
   * starting context for this task.
   *
   * Parse with `parseForkFrom()` from `reviewer/fork-protocol.ts` to get the
   * typed `DispatchForkSpec` (which includes `conversation_id` and optional
   * `fork_label`).
   */
  fork_from?: string | null;
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

// ── Agent quality trend types ─────────────────────────────────────────────

/**
 * Colour band for a data point or series in the fleet health sparkline.
 *
 * - `"red"`    — avg_score < red_threshold (default 0.60): critical zone
 * - `"yellow"` — red_threshold ≤ avg_score < yellow_threshold (default 0.75):
 *                warning zone
 * - `"green"`  — avg_score ≥ yellow_threshold: healthy
 * - `null`     — no data on that day (avg_score is null)
 */
export type SparklineBand = "red" | "yellow" | "green" | null;

/**
 * One calendar day's average quality score for a single agent.
 * Used to build 7-day sparklines on the dashboard home page.
 */
export interface AgentQualityTrendPoint {
  /** "YYYY-MM-DD" calendar date. */
  date: string;
  /**
   * Mean quality_score across all scored tasks on this day,
   * or null when there were no scored tasks.
   */
  avg_score: number | null;
  /** Number of tasks with a quality_score recorded on this day. */
  scored_task_count: number;
  /**
   * Colour band for this data point based on the day's avg_score.
   * "red" < red_threshold ≤ "yellow" < yellow_threshold ≤ "green"; null when no data.
   * Provided so dashboards can colour individual points without re-implementing
   * the threshold logic.
   */
  band: SparklineBand;
  /**
   * URL to per-agent task history filtered to this calendar date.
   * Pattern: `<task_history_base_url>?agent=<name>&date=<YYYY-MM-DD>`.
   * Null when no `task_history_base_url` was provided to the payload builder.
   * Clicking a sparkline point should navigate here so operators can inspect
   * exactly which tasks drove a score on that day.
   */
  task_history_url: string | null;
}

/**
 * A 7-day (or N-day) quality score time series for one agent.
 * Drives a single sparkline on the dashboard home panel.
 */
export interface AgentQualityTrendSeries {
  agent_name: string;
  /**
   * Rolling average quality score across all scored tasks in the window.
   * Null when the agent has no scored tasks in the window.
   */
  rolling_avg: number | null;
  /**
   * True when `rolling_avg` is not null and falls below the
   * `warning_threshold` configured for the response. Operators should
   * render this agent's sparkline in warning/red colour.
   */
  below_threshold: boolean;
  /**
   * Colour band for the agent's rolling average.
   * Derived from `rolling_avg` against `red_threshold` and `yellow_threshold`.
   * null when the agent has no scored tasks in the window.
   */
  risk_tier: SparklineBand;
  /** Daily data points, one per calendar day in the window, oldest first. */
  days: AgentQualityTrendPoint[];
}

/**
 * Full response from `getAgentQualityTrend()`.
 * Intended to be served directly as `GET /agent-trends`.
 */
export interface AgentQualityTrend {
  /** Number of calendar days in the look-back window. */
  days: number;
  /**
   * 0-1 rolling-average threshold below which an agent's sparkline is
   * highlighted as a warning. Default: 0.75.
   */
  warning_threshold: number;
  /**
   * Score below which a data point or agent is considered critical (red band).
   * Default: 0.60.
   */
  red_threshold: number;
  /**
   * Score at or above which a data point or agent is considered healthy (green).
   * Scores in [red_threshold, yellow_threshold) are yellow (warning).
   * Default: 0.75 (same as warning_threshold for backward compatibility).
   */
  yellow_threshold: number;
  /** Per-agent series, one entry per agent that had any scored tasks in the window. */
  per_agent: AgentQualityTrendSeries[];
  /** ISO-8601 timestamp when the payload was generated. */
  generated_at: string;
}

// ── Fleet health sparkline types ──────────────────────────────────────────

/**
 * Summary counts of agents across risk tiers in the fleet health view.
 */
export interface FleetRiskSummary {
  /** Agents with rolling_avg < red_threshold (critical). */
  red: number;
  /** Agents with red_threshold ≤ rolling_avg < yellow_threshold (warning). */
  yellow: number;
  /** Agents with rolling_avg ≥ yellow_threshold (healthy). */
  green: number;
  /** Agents present in the window but with no scored tasks. */
  no_data: number;
  /** Total agents with at least one scored task in the window. */
  total_active: number;
}

/**
 * Fleet health view wrapping per-agent sparklines with a fleet-level risk
 * summary. Returned by `getFleetHealthSparklines()`.
 *
 * Mount in the orchestrator or dashboard server:
 *
 *   app.get('/fleet-health', (_req, res) => res.json(
 *     getFleetHealthSparklines(store, { task_history_base_url: '/tasks' })
 *   ));
 *
 * Per-agent sparkline points carry `band` and `task_history_url` so the
 * dashboard can apply colour bands and wire up click-through without any
 * additional logic.
 */
export interface FleetHealthSparklines {
  /** Look-back window (number of calendar days). */
  days: number;
  /** Score below which a point/agent is critical (red). Default: 0.60. */
  red_threshold: number;
  /** Score at or above which a point/agent is healthy (green). Default: 0.75. */
  yellow_threshold: number;
  /** Fleet-level counts across risk tiers. */
  fleet_summary: FleetRiskSummary;
  /** Per-agent sparkline series with band annotations and click-through URLs. */
  agents: AgentQualityTrendSeries[];
  /** ISO-8601 timestamp when the payload was generated. */
  generated_at: string;
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
 * Per-agent live quality health summary over the most recent task window.
 * Used by the Telegram /quality command to show operators a fast snapshot of
 * current scoring health without opening the dashboard.
 */
export interface AgentQualityHealthRow {
  agent_name: string;
  /** Total tasks included in the window for this agent. */
  task_count: number;
  /** Tasks in the window that already have a quality_score. */
  scored_task_count: number;
  /** Tasks in the window that still have quality_score = null. */
  null_score_count: number;
  /** Fraction of window tasks with null quality_score (0-1). */
  null_score_rate: number;
  /** Tasks in the window with quality_score below the configured threshold. */
  below_threshold_count: number;
  /**
   * Fraction of scored tasks below the configured threshold (0-1), or null
   * when no scored tasks exist in the window.
   */
  below_threshold_rate: number | null;
  /** Mean quality score across scored tasks in the window, or null when none exist. */
  rolling_avg_score: number | null;
  /** Mean score across the newest half of the task window, or null when unavailable. */
  recent_avg_score: number | null;
  /** Mean score across the older half of the task window, or null when unavailable. */
  previous_avg_score: number | null;
  /** Signed delta: recent_avg_score - previous_avg_score, or null when unavailable. */
  trend_delta: number | null;
  /** True when the recent half is materially lower than the older half. */
  trending_downward: boolean;
}

/**
 * Full live quality health snapshot returned by `getQualityHealthReport()`.
 */
export interface QualityHealthReport {
  generated_at: string;
  /** Number of recent tasks included per agent. */
  window_tasks: number;
  /** Quality threshold used for the below-threshold percentage. */
  threshold: number;
  /** Total task count across all agents in the window. */
  total_task_count: number;
  /** Total scored task count across all agents in the window. */
  scored_task_count: number;
  /** Total null-score task count across all agents in the window. */
  null_score_count: number;
  /** Total scored tasks below the threshold across all agents in the window. */
  below_threshold_count: number;
  /** Mean quality score across all scored tasks in the window, or null when none exist. */
  system_avg_score: number | null;
  /** Per-agent rows, sorted by rolling average descending. */
  per_agent: AgentQualityHealthRow[];
}

/**
 * Per-agent rolling approval quality summary over the last 24h.
 * Used by the Telegram /quality-summary command and daily digest.
 */
export interface QualitySummaryAgentRow {
  agent_name: string;
  approved_count: number;
  below_threshold_count: number;
  below_threshold_rate: number;
  avg_quality_score: number | null;
}

/**
 * Rolling 24h approval-quality summary returned by `getQualitySummaryReport()`.
 */
export interface QualitySummaryReport {
  generated_at: string;
  window_hours: number;
  threshold: number;
  total_approved: number;
  below_threshold_count: number;
  below_threshold_rate: number | null;
  worst_agent: QualitySummaryAgentRow | null;
  per_agent: QualitySummaryAgentRow[];
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
 * Score coverage metric for the quality panel dashboard.
 *
 * Measures what fraction of 'done' tasks older than a minimum age (default 5 min)
 * have a non-null quality_score.  A coverage_pct of 1.0 (100%) means every
 * completed task has been scored — the target state after issue #250.
 *
 * Short-circuit exits (e.g. 'already-in-review') and pre-dispatch guard exits
 * contribute to `total_done` but used to contribute to `unscored_done` because
 * they bypassed the normal verify path.  After issue #250, these tasks receive
 * a canonical score of 1.0 ('no_action_needed') so they no longer inflate the
 * gap.
 */
export interface ScoreCoverageMetric {
  /** ISO-8601 timestamp when the metric was computed. */
  generated_at: string;
  /**
   * Fraction of done tasks that are scored (0.0–1.0).
   * 1.0 = full coverage, 0.0 = no tasks scored.
   * Null when total_done_tasks / total_done = 0 (no eligible tasks).
   */
  coverage_pct: number | null;
  // ── Fields returned by the newer getScoreCoverage (issue #250 revised) ──
  /** Minimum task age (minutes) used as the eligibility floor. Default: 5. */
  min_age_minutes?: number;
  /** Tasks in 'done' status older than min_age_minutes. */
  total_done?: number;
  /** Done tasks that have a non-null quality_score. */
  scored_done?: number;
  /** Done tasks that still have quality_score = null. */
  unscored_done?: number;
  // ── Fields returned by getScoreCoverageMetric (original implementation) ──
  /** @deprecated Use total_done. Total 'done' tasks older than the grace period. */
  total_done_tasks?: number;
  /** @deprecated Use scored_done. Done tasks with a non-null quality_score. */
  scored_tasks?: number;
  /** @deprecated Use unscored_done. Done tasks with null quality_score. */
  unscored_tasks?: number;
  /** Per-agent breakdown of score coverage (provided by getScoreCoverageMetric). */
  per_agent?: Array<{
    agent_name: string;
    total: number;
    scored: number;
    unscored: number;
    coverage_pct: number | null;
  }>;
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
  /**
   * Get approved tasks that have null quality_score.
   * Used by the /backfill-scores command to retroactively score approved tasks.
   */
  getApprovedTasksWithNullScores(limit?: number): Task[];
  /**
   * Get count of approved tasks with null quality_score.
   * Used to check if backfill is needed.
   */
  getApprovedTasksWithNullScoresCount(): number;
  /**
   * Get ALL verified tasks (approved OR rejected) that have null quality_score.
   * Used by ensureScoresPopulated() and /backfill-scores to close the score gap
   * for both approved and rejected tasks that were verified without a score being
   * written — e.g. tasks approved/rejected by the orchestrator outside the
   * verifier's normal flow.
   */
  getVerifiedTasksWithNullScores(limit?: number): Task[];
  /**
   * Count of ALL verified tasks (approved OR rejected) with null quality_score.
   */
  getVerifiedTasksWithNullScoresCount(): number;
  /**
   * Return done tasks with null quality_score that are older than minAgeMinutes.
   * Used by ensureScoresPopulated() and gap-fill mechanisms to prioritise
   * coverage gaps — short-circuit exits and pre-dispatch guards may skip the
   * normal verify path, leaving null scores on 'done' tasks indefinitely.
   *
   * @param minAgeMinutes - Minimum task age in minutes (default 5).
   * @param limit         - Maximum rows to return (default 100).
   */
  getDoneTasksWithNullScoreOlderThan(minAgeMinutes?: number, limit?: number): Task[];
  /**
   * Compute the score coverage metric: what fraction of 'done' tasks have a
   * non-null quality_score.  Used by the dashboard quality panel to surface a
   * 'score coverage %' badge.
   *
   * @param minAgeMinutes - Only count tasks older than this (default 5) to
   *                        exclude tasks still in the verify pipeline.
   */
  getScoreCoverage(minAgeMinutes?: number): ScoreCoverageMetric;
  getAgentStats(): AgentStats[];
  getEfficiencyTrend(
    days?: number,
    warningThreshold?: number,
    criticalThreshold?: number,
  ): EfficiencyTrend;

  /**
   * Return a per-agent 7-day (or N-day) quality score time series.
   * Each point is the mean `quality_score` of all scored tasks updated on
   * that calendar day. Agents whose rolling average falls below
   * `warningThreshold` (default 0.75) are flagged with `below_threshold: true`.
   *
   * Only agents that have at least one scored task in the window are included.
   */
  getAgentQualityTrend(
    days?: number,
    warningThreshold?: number,
    redThreshold?: number,
    yellowThreshold?: number,
    taskHistoryBaseUrl?: string | null,
  ): AgentQualityTrend;

  // Routing accuracy feedback
  getRoutingAccuracyStats(days?: number): RoutingAccuracyStats[];
  getAgentQualityByTaskType(days?: number): AgentQualityByTaskType[];

  // Calibration drift monitoring
  getScoreDistributions(days?: number): AgentScoreDistribution[];
  getCalibrationDriftAlerts(recentDays?: number, baselineDays?: number): CalibrationDriftAlert[];

  // Live quality health snapshot for operator Telegram commands
  getQualityHealthReport(windowTasks?: number, threshold?: number): QualityHealthReport;

  /**
   * Return recent verified tasks with their quality_score for the per-task
   * quality view.  Includes both approved and rejected tasks that have been
   * through verification.  Ordered by updated_at DESC.
   */
  getRecentVerifiedTasks(limit?: number): Task[];

  /**
   * Return all in-flight tasks for a given source_ref (issue reference).
   *
   * "In-flight" means status ∈ { pending, planning, dispatched, in_progress }.
   * Used by the cross-agent in-flight guard (issue #336) to detect when another
   * agent is already working on the same issue before dispatching a new task.
   *
   * @param sourceRef - Exact source_ref string, e.g. "owner/repo#123".
   * @returns Tasks in an active (non-terminal) status for that issue ref.
   */
  getInFlightTasksForIssue(sourceRef: string): Task[];

  /**
   * Count the number of unique GitHub issues that have had active tasks
   * assigned to more than one different agent within the given time window.
   *
   * A non-zero count means the cross-agent dispatch guard would have (or did)
   * fire for those issues.  Used by the dashboard "multi-agent collision" metric
   * (issue #336).
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   * @returns Count of source_refs with tasks from multiple distinct agents.
   */
  getMultiAgentCollisionCount(windowHours?: number): number;

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

  // Score coverage metric for dashboard quality panel
  /**
   * Return a score-coverage metric showing what fraction of 'done' tasks
   * have a non-null quality_score.  Only considers tasks older than `graceMinutes`
   * (default 5) to give the verifier time to score newly-completed tasks.
   */
  getScoreCoverageMetric(graceMinutes?: number): ScoreCoverageMetric;

  /**
   * Return 'done' tasks older than `graceMinutes` that still have null quality_score.
   * Used by ensureScoresPopulated() Phase 3 to catch short-circuit exits and
   * orchestrator-routed tasks that bypassed the normal verification flow.
   *
   * @param graceMinutes - Minimum age in minutes (default 5).
   * @param limit - Maximum rows to return (default 50).
   */
  getDoneTasksWithNullScores(graceMinutes?: number, limit?: number): Task[];

  // Reconciliation event queries (reads from shared reconciliation_events table)
  /**
   * Return the most recent reconciliation event per repo.
   * Used by the /reconcile Telegram command to give a fleet-wide snapshot.
   * If the reconciliation_events table does not exist (pre-migration), returns [].
   */
  getLastReconciliationPerRepo(): ReconciliationLastPerRepo[];

  /**
   * Return recent reconciliation events in reverse chronological order.
   * @param limit - Max events to return (default 20)
   * @param sinceHours - Optional look-back window in hours
   */
  getRecentReconciliationEvents(limit?: number, sinceHours?: number): ReconciliationEventRecord[];

  // Operator override (issue #272)
  /**
   * Allow an operator to approve-with-override or reject a task held in
   * 'needs_operator_review' status (score < 0.60).
   *
   * @param taskId — task ID to override
   * @param decision — 'approve' to approve-with-override, 'reject' to reject
   * @param operatorNote — free-text reason for the override decision
   * @returns true if the override was applied, false if the task was not held
   */
  operatorOverride(taskId: string, decision: "approve" | "reject", operatorNote: string): boolean;

  // PR guard cooldown (issue #390)
  /** Write (or refresh) a per-issue cooldown keyed on (repo, issueNumber). */
  setPRGuardCooldown(repo: string, issueNumber: number, ttlMinutes?: number): void;
  /** Return true when an active (non-expired) cooldown exists for (repo, issueNumber). */
  isPRGuardCooldownActive(repo: string, issueNumber: number): boolean;
  /** Delete expired cooldown rows; returns row count pruned. */
  prunePRGuardCooldowns(): number;
}

// ── Low-score approved feed store interface (issue #278) ──────────────────────

/**
 * Minimal store interface required by the low-score approved feed module.
 *
 * Satisfied by `StateStore`. Extracted so the feed builder can be unit-tested
 * with a lightweight stub.
 */
export interface ILowScoreFeedStore {
  /**
   * Return approved tasks whose quality_score is non-null and strictly less
   * than `threshold`, ordered by quality_score ascending (riskiest first),
   * then by updated_at descending within each score tier.
   *
   * @param threshold - Score ceiling (exclusive). Default: 0.75.
   * @param limit     - Maximum rows to return. Default: 50.
   */
  getLowScoreApprovedTasks(threshold?: number, limit?: number): Task[];
}

/**
 * Store interface for the score-bypass violation report (issue #356).
 *
 * Satisfied by `StateStore`. Extracted so the report builder can be
 * unit-tested with a lightweight stub.
 */
export interface IScoreViolationsStore {
  /**
   * Return approved tasks whose quality_score is non-null and strictly less
   * than `threshold`, created within the last `days` days, ordered by
   * quality_score ascending (worst first).
   *
   * @param threshold - Score ceiling (exclusive). Default: 0.80.
   * @param days      - Lookback window in days. Default: 7.
   * @param limit     - Maximum rows to return. Default: 100.
   */
  getScoreViolationTasks(threshold?: number, days?: number, limit?: number): Task[];
}

// ── Bypass audit store (issue #398) ──────────────────────────────────────────

/**
 * Minimal store interface for the bypass-audit endpoint.
 *
 * Returns tasks approved below the hard quality floor (0.60) in a rolling
 * window, ordered by quality_score ascending (worst first).
 */
export interface IBypassAuditStore {
  /**
   * Return all tasks approved below 0.60 in the last `days` days, including
   * those with and without an explicit `bypass_reason`.
   *
   * @param days  - Lookback window in days. Default: 7.
   * @param limit - Maximum rows to return. Default: 200.
   */
  getBypassAuditTasks(days?: number, limit?: number): Task[];
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
  /**
   * Returns ALL (agent_name, task_type, score_bucket) cells from pr_outcome_records
   * with no minimum sample filter, so callers can distinguish insufficient-data cells
   * (n < 30) from well-calibrated ones (n ≥ 30) and flag them appropriately.
   */
  getCalibrationTable(): ScoreCalibrationRow[];
  getAdjustedThresholds(targetMergeRate?: number, currentMinScore?: number): AdjustedThreshold[];
}

// ── Verifier threshold auto-adjustment types (Phase 2 calibration) ──────────

/**
 * A persisted per-verifier quality threshold, stored in `verifier_thresholds`.
 *
 * Written by `ThresholdAdjuster.adjustThreshold()` when calibration data
 * supports a change; the delta is capped at ±0.05 per cycle (Phase 2 §4).
 */
export interface VerifierThreshold {
  verifier_id: string;
  task_type: TaskType;
  /** Current approval threshold (0–1). Default: 0.80 (APPROVAL_THRESHOLD). */
  threshold: number;
  /** ISO-8601 timestamp when this row was last updated. */
  last_adjusted_at: string;
  /**
   * Human-readable justification for the last adjustment.
   * Includes the score bucket, merge_rate, sample count, and raw vs clamped delta,
   * so every threshold change is fully auditable.
   */
  justification: string;
}

/**
 * Per-(verifier, task_type, score_bucket) alert state, stored in `verifier_alert_state`.
 *
 * Tracks how many consecutive adjustment cycles have seen merge_rate < 0.70,
 * enabling the "2+ consecutive bad cycles" Telegram alert from Phase 2 §5.
 */
export interface VerifierAlertState {
  verifier_id: string;
  task_type: TaskType;
  score_bucket: number;
  /** Number of consecutive adjustment cycles where merge_rate < 0.70. */
  consecutive_bad_cycles: number;
  /** ISO-8601 timestamp of the last check. */
  last_checked_at: string;
}

/**
 * Store interface for verifier threshold auto-adjustment (Phase 2 calibration).
 *
 * Implemented by `StateStore`. Consumed by `ThresholdAdjuster`.
 */
export interface IThresholdAdjustmentStore {
  /** Full calibration table (no minimum sample filter). */
  getCalibrationTable(): ScoreCalibrationRow[];
  /** Returns the persisted threshold for (verifier, taskType), or null if not yet set. */
  getVerifierThreshold(verifierId: string, taskType: TaskType): VerifierThreshold | null;
  /** Persist an updated threshold with its justification. */
  setVerifierThreshold(
    verifierId: string,
    taskType: TaskType,
    threshold: number,
    justification: string,
  ): void;
  /** Returns all alert states for a verifier across all task types and buckets. */
  getVerifierAlertStates(verifierId: string): VerifierAlertState[];
  /** Upsert the consecutive-bad-cycle count for one (verifier, task_type, bucket). */
  upsertVerifierAlertState(
    state: Omit<VerifierAlertState, "last_checked_at">,
  ): void;
}

// ── Calibration recommendation persistence types (issue #477) ────────────

/**
 * Lifecycle status of a calibration recommendation.
 *
 * - `pending`      — surfaced to the operator dashboard, awaiting review
 * - `applied`      — operator manually approved and the threshold was updated
 * - `dismissed`    — operator explicitly dismissed without applying
 * - `auto_applied` — auto-applied because confidence >= 0.95 (sample_count >= 28)
 */
export type CalibrationRecommendationStatus =
  | "pending"
  | "applied"
  | "dismissed"
  | "auto_applied";

/**
 * A persisted calibration threshold recommendation, stored in
 * `calibration_recommendations`.
 *
 * Created by `ScoreCalibrator.buildReport()` whenever `action_required` is true
 * on an `AdjustedThreshold` entry. Deduplication: only one `pending` row is
 * allowed per `(agent_name, task_type)` pair at a time.
 */
export interface CalibrationRecommendation {
  /** ULID primary key. */
  id: string;
  agent_name: string;
  task_type: TaskType;
  /** Current min_score at the time the recommendation was generated. */
  current_min_score: number;
  /** Recommended new min_score derived from calibration data. */
  recommended_min_score: number;
  /** Number of PR outcome records used to derive the recommendation. */
  sample_count: number;
  /**
   * Confidence score: min(1.0, sample_count / 30).
   * Recommendations with confidence >= 0.95 (sample_count >= 28) are auto-applied.
   */
  confidence: number;
  status: CalibrationRecommendationStatus;
  /** ISO-8601 timestamp when the recommendation was created. */
  created_at: string;
  /** ISO-8601 timestamp when the recommendation was resolved (applied/dismissed). */
  resolved_at: string | null;
  /** Human-readable note recorded at resolution time. */
  resolution_notes: string | null;
}

/**
 * Store interface for calibration recommendation persistence (issue #477).
 */
export interface ICalibrationRecommendationStore {
  /**
   * Insert a new calibration recommendation, or skip if a `pending` row
   * already exists for the same `(agent_name, task_type)` pair.
   *
   * @returns the inserted recommendation, or null if deduped.
   */
  upsertCalibrationRecommendation(
    rec: Omit<CalibrationRecommendation, "id" | "created_at" | "resolved_at" | "resolution_notes">,
  ): CalibrationRecommendation | null;

  /**
   * Return recommendations, optionally filtered by status.
   * Ordered by created_at descending (newest first).
   */
  getCalibrationRecommendations(
    status?: CalibrationRecommendationStatus,
  ): CalibrationRecommendation[];

  /**
   * Update the status of a recommendation.
   *
   * @returns true if the row was found and updated, false otherwise.
   */
  resolveCalibrationRecommendation(
    id: string,
    status: Exclude<CalibrationRecommendationStatus, "pending">,
    notes?: string,
  ): boolean;
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
  /**
   * Set to `'hard_block_sub50'` when the verifier's hard-block guard fires
   * (score < 0.50). Null otherwise. Enables the dashboard rejection log to
   * distinguish unconditional quality-gate blocks from ordinary sub-threshold
   * rejections. Added in issue #147.
   */
  blocked_reason: string | null;
  /**
   * Explains why a low-scoring task was approved, making the quality system
   * legible to operators. Null when the task was rejected or scored ≥ 0.75.
   *
   * Well-known values (issue #148):
   * - `'marginal_approval'`   — task scored 0.60–0.74 and was approved at the marginal bar
   * - `'second_pass_passed'`  — borderline task (0.70–0.79) cleared the second-pass review
   * - `'research_task_schema_pass'` — research task passed schema-compliance scoring
   *
   * Additional free-text detail (e.g. the LLM's marginal_reason) may be
   * appended after a colon: `"marginal_approval: Missing error handling …"`.
   */
  approval_rationale: string | null;
  /** The min_score threshold configured at the time of verification (e.g. 0.80). */
  threshold: number;
  /** The agent whose task was verified (agent_name from the task record). */
  agent_id: string;
  /** ISO-8601 UTC timestamp of the verification event. */
  timestamp: string;
  /**
   * Whether CLI smoke tests were run and passed for this task (issue #277).
   *
   * - `null` / `undefined` — task was not CLI-related; smoke tests were not run
   * - `1` — all applicable smoke tests passed
   * - `0` — one or more smoke tests failed (score penalty was applied)
   *
   * Stored as SQLite INTEGER (0/1/NULL) and mapped to boolean by the dashboard.
   */
  cli_smoke_test_passed?: number | null;
  /**
   * Records why a sub-0.60 task was approved despite the quality floor.
   *
   * Well-known values:
   * - `'operator_override'` — Explicit human approval via `/approve` command
   * - `'floor_not_enforced'` — Historical approval that slipped through without
   *   the quality floor gate firing (audit gap, backfilled by issue #295)
   *
   * Null when the task was not a sub-0.60 approval or has not been classified.
   */
  bypass_reason?: string | null;
  /**
   * Where the score originated (issue #483).
   *
   * - `'llm_parse'`        — score came from a successful JSON parse of an LLM response
   * - `'default_fallback'` — score defaulted to 0 because the LLM response was unparseable;
   *                          tasks with this source must not be auto-approved
   * - `'operator_override'`— score was set explicitly by a human operator
   *
   * Null for legacy records; defaults to `'llm_parse'` in the DB column default.
   */
  score_source?: string | null;
}

/**
 * A task whose score contradicts its verification outcome.
 *
 * - `low_score_approved`: score < 0.60 but verification_status = "approved"
 * - `high_score_rejected`: score > 0.85 but verification_status = "rejected"
 */
export type QualityAnomalyType = "low_score_approved" | "high_score_rejected";

/**
 * One quality anomaly row for the dashboard feed.
 */
export interface QualityAnomaly {
  task_id: string;
  title?: string;
  agent_name: string | null;
  task_type?: string;
  quality_score: number;
  verification_status: "approved" | "rejected";
  quality_explanation?: string | null;
  anomaly_type: QualityAnomalyType;
  created_at?: string;
  updated_at: string;
}

/**
 * Filter options for querying quality anomalies.
 */
export interface QualityAnomalyQuery {
  /**
   * Inclusive lower bound on `updated_at`.
   * Accepts an ISO date or timestamp string.
   */
  since?: string;
  /**
   * Inclusive upper bound on `updated_at`.
   * Accepts an ISO date or timestamp string.
   */
  until?: string;
  /**
   * Look-back window in days. Used when `since`/`until` are omitted.
   * Default: 7.
   */
  days?: number;
  /**
   * Maximum number of rows to return. Default: 50.
   */
  limit?: number;
  /**
   * Filter by anomaly type.
   */
  anomaly_type?: QualityAnomalyType;
  /**
   * Filter by agent name.
   */
  agent_name?: string;
}

/**
 * Full response for the /quality-anomalies dashboard feed.
 */
export interface QualityAnomalyFeed {
  generated_at: string;
  query: {
    since: string | null;
    until: string | null;
    days: number;
    limit: number;
  };
  anomalies: QualityAnomaly[];
  total: number;
  low_score_approved: number;
  high_score_rejected: number;
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
  /**
   * Return the most recent verification result record for a specific task.
   * Used by the Telegram /score command to retrieve blocked_reason and
   * per-verification metadata without going through agent-level aggregation.
   *
   * @param taskId - The task ID to look up.
   * @returns The most recent VerificationResultRecord for the task, or null.
   */
  getLatestVerificationRecord(taskId: string): VerificationResultRecord | null;
  /**
   * Audit query: return verification_results records where first_pass = 1
   * (approved) but score < minScore within the last `days` days.
   *
   * Used to validate the score threshold gate — the result set should always
   * be empty when the gate is enforced correctly (acceptance criterion for
   * issue #258). A non-empty result indicates a past write-path gap.
   *
   * @param minScore - Score threshold (exclusive lower bound). Default 0.60.
   * @param days     - Look-back window in calendar days. Default 30.
   */
  getApprovedBelowThreshold(minScore?: number, days?: number): VerificationResultRecord[];
}

/**
 * Store interface for dashboard-quality anomaly feeds.
 *
 * Implemented by the reviewer/orchestrator StateStore.  Consumers can use this
 * without taking a dependency on the rest of the verification interfaces.
 */
export interface IQualityAnomalyStore {
  getQualityAnomalies(opts?: QualityAnomalyQuery): QualityAnomaly[];
}

// ── First-pass rate widget types (issue #88) ──────────────────────────────

/**
 * One data point in the 30-day rolling first-pass rate trend.
 * Each point covers a 7-day window, aligned to Monday boundaries.
 */
export interface FirstPassTrendPoint {
  /** ISO-8601 date of the week start (Monday). */
  week_start: string;
  /** Total verification events in this week window. */
  total: number;
  /** Count approved on first pass. */
  first_pass_count: number;
  /** First-pass rate (0–1), or null when total is 0. */
  rate: number | null;
}

/**
 * Per-agent, per-task-type first-pass breakdown for the drill-down panel.
 * Identifies which agent + task type combination is pulling the fleet rate down.
 */
export interface FirstPassDrillDown {
  agent_id: string;
  /** "implementation" | "research" | unknown task_type values */
  task_type: string;
  total: number;
  first_pass_count: number;
  rate: number | null;
}

/**
 * The complete first-pass rate widget payload.
 * Returned by `IFirstPassRateStore.getFirstPassRateWidget()`.
 *
 * Surfaces: current-month rate vs. 80% goal, 30-day weekly trend,
 * and a per-(agent, task_type) drill-down to identify laggards.
 */
export interface FirstPassRateWidget {
  /** ISO-8601 start of the current calendar month (UTC). */
  month_start: string;
  /** Fleet-wide rate for the current calendar month (0–1), or null if no data. */
  current_month_rate: number | null;
  /** Total verifications this calendar month. */
  current_month_total: number;
  /** The goal threshold (0.80). */
  goal: number;
  /** Whether the current month rate meets or exceeds the 80% goal. */
  goal_met: boolean | null;
  /** Weekly trend over the past 4 weeks (oldest first). */
  weekly_trend: FirstPassTrendPoint[];
  /** Per-agent, per-task-type drill-down for the laggard panel. */
  drill_down: FirstPassDrillDown[];
}

/**
 * Store interface for the first-pass rate widget.
 *
 * Implemented by the reviewer's StateStore.  The orchestrator StateStore
 * is not required to implement this — callers should check at runtime.
 */
export interface IFirstPassRateStore {
  /**
   * Return the complete first-pass rate widget payload.
   *
   * @param weeksBack - How many past weeks to include in the trend (default: 4).
   * @returns Widget data, including month-to-date rate, weekly trend, and drill-down.
   */
  getFirstPassRateWidget(weeksBack?: number): FirstPassRateWidget;
}

// ── Secrets health types ─────────────────────────────────────────────────

/**
 * Coarse mount-status classification for a single secret.
 *
 * Mirrors the `SecretStatus` type in agent-proxy/src/routes/secrets.ts so
 * both systems share the same vocabulary when recording and querying events.
 *
 * - "present-and-valid"  Secret file (or env-var fallback) is readable and non-empty.
 * - "mounted-but-empty"  The Docker secret path exists on disk but the file is
 *                        empty or unreadable.  Compose config is correct; only the
 *                        host-side secret file needs to be populated.
 * - "not-mounted"        No file mount and no env-var fallback found.  Hard-block
 *                        state — the pre-dispatch validator must reject dispatch.
 */
export type SecretMountStatus = "present-and-valid" | "mounted-but-empty" | "not-mounted";

/**
 * A single secret's status as returned by the proxy `/health/secrets` endpoint.
 * One element of the `secrets` array in the API response.
 */
export interface SecretHealthEntry {
  name: string;
  env_fallback: string;
  mounted: boolean;
  readable: boolean;
  non_empty: boolean;
  source: "file" | "env" | null;
  status: SecretMountStatus;
  reason: string;
}

/**
 * One persisted secret-health check event, stored in `secrets_health_checks`.
 * Each row captures the health snapshot for a single secret on a single agent
 * at a given point in time.
 */
export interface SecretsHealthCheckRecord {
  id?: number;
  /** The agent name (matches `agent_name` in the tasks table). */
  agent_name: string;
  /** The Docker Compose secret name (e.g. "gh_token"). */
  secret_name: string;
  /** Mount status at the time of the check. */
  status: SecretMountStatus;
  /** True when the secret value could be read. */
  readable: boolean;
  /** True when the value is non-empty. */
  non_empty: boolean;
  /** ISO-8601 UTC timestamp of the health check. */
  checked_at: string;
}

/**
 * Aggregated secret-health summary for a single agent.
 * Returned by `ISecretsHealthStore.getAgentSecretsHealth()`.
 */
export interface AgentSecretsHealthSummary {
  agent_name: string;
  /** ISO-8601 timestamp of the most recent health check for this agent. */
  last_checked_at: string | null;
  /**
   * True when all required secrets (`oauth_token`, `gh_token`) were
   * present-and-valid at the last check.
   */
  healthy: boolean;
  /** Per-secret status from the most recent check. */
  secrets: Array<{ name: string; status: SecretMountStatus }>;
  /** Count of secrets currently in a degraded state (mounted-but-empty or not-mounted). */
  missing_count: number;
}

/**
 * Fleet-wide secrets health summary: one entry per known agent.
 * Returned by `ISecretsHealthStore.getSecretsFleetHealth()`.
 */
export interface SecretsFleetHealthSummary {
  /** Number of distinct agents for which at least one check is recorded. */
  agent_count: number;
  /** Count of agents with all required secrets healthy. */
  healthy_count: number;
  /** Count of agents with at least one required secret missing or degraded. */
  degraded_count: number;
  /** Per-agent summaries, ordered by agent_name. */
  agents: AgentSecretsHealthSummary[];
}

/**
 * Store interface for secrets health persistence.
 *
 * Implemented by the reviewer's own StateStore.  The orchestrator's StateStore
 * is not required to implement these methods — callers should check at runtime.
 */
export interface ISecretsHealthStore {
  /**
   * Persist one or more secret-health check results for a single agent.
   *
   * Called after querying the agent-proxy `/v1/agents/:name/secrets` endpoint.
   * Each element of `secrets` produces one row in `secrets_health_checks`.
   *
   * @param agentName - Agent name (e.g. "claude-proxy").
   * @param secrets   - Array of per-secret health entries from the proxy response.
   * @param checkedAt - ISO-8601 timestamp of the check (defaults to `new Date().toISOString()`).
   */
  recordSecretsHealthCheck(
    agentName: string,
    secrets: ReadonlyArray<Pick<SecretHealthEntry, "name" | "status" | "readable" | "non_empty">>,
    checkedAt?: string,
  ): void;

  /**
   * Return the most-recent health snapshot for a single agent.
   *
   * Reads the latest `checked_at` timestamp across all secrets for the agent,
   * then returns the status of each secret at that timestamp.
   *
   * @returns Summary, or null when no checks exist for the agent.
   */
  getAgentSecretsHealth(agentName: string): AgentSecretsHealthSummary | null;

  /**
   * Return the fleet-wide secrets health summary.
   *
   * Aggregates the most-recent check per agent across all agents in the
   * `secrets_health_checks` table.  The result is intended for the
   * `/secrets/fleet` dashboard panel and the Telegram `/s` status summary.
   */
  getSecretsFleetHealth(): SecretsFleetHealthSummary;
}

/**
 * Summary statistics for quality anomalies over a given window.
 */
export interface QualityAnomalySummary {
  /** Total anomalies in the window */
  total: number;
  /** Approved tasks with score < 0.60 */
  low_score_approved: number;
  /** Rejected tasks with score > 0.85 */
  high_score_rejected: number;
  /** Per-agent anomaly counts */
  per_agent: Array<{ agent_name: string; count: number }>;
  /** The anomaly records themselves */
  anomalies: QualityAnomaly[];
}

// ── Score coverage metric types ──────────────────────────────────────────

/**
 * Dimension label for tasks that received a canonical score without
 * LLM verification — e.g. short-circuit exits like 'already-in-review',
 * pre-dispatch guard blocks, or orchestrator-routed no-ops.
 *
 * The canonical score is 1.0 for tasks that required no action.
 */
export type ShortCircuitDimension =
  | "no_action_needed"      // already-in-review, zero-action standup, etc.
  | "pre_dispatch_blocked"  // pre-dispatch guard exit (issue closed, auth failure, etc.)
  | "orchestrator_routed";  // orchestrator handled routing without agent work

// ── Reconciliation event types ────────────────────────────────────────────

/**
 * Reconciliation outcome status — mirrors the dashboard's reconciliation_events table.
 * Read-only from the reviewer; written by the dashboard agent.
 */
export type ReconciliationStatus = "success" | "partial" | "failed" | "escalated";

/**
 * A single reconciliation event record from the shared reconciliation_events table.
 */
export interface ReconciliationEventRecord {
  id: number;
  status: ReconciliationStatus;
  /** JSON-encoded string[] of repo slugs patched in this run */
  repos_patched: string[];
  /** JSON-encoded string[] of column names fixed */
  columns_fixed: string[];
  error_message: string | null;
  triggered_by: string | null;
  details: string | null;
  created_at: string;
}

/**
 * The last reconciliation event per repo, used by the /reconcile Telegram command.
 */
export interface ReconciliationLastPerRepo {
  repo: string;
  event_id: number;
  status: ReconciliationStatus;
  created_at: string;
  columns_fixed: string[];
  triggered_by: string | null;
}

export interface ITelegramStateStore
  extends IStateStore,
    IScoreOutcomeStore,
    IPRIterationStore,
    IStandupHealthStore,
    IVerificationResultStore,
    ISecretsHealthStore,
    IFirstPassRateStore,
    ILowScoreFeedStore,
    IScoreViolationsStore,
    IMeetingFacilitatorGoalStore,
    IImprovementBatchDeduplicationStore,
    IMarginalApprovalsFeedStore {
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

  // Operator review queue (tasks held at sub-0.60 quality floor)
  /**
   * List all tasks currently in `needs_operator_review` verification status.
   * Used by `/review-queue` Telegram command.
   */
  getTasksInOperatorReview(): Task[];
  /**
   * Approve or reject a task held in `needs_operator_review` status.
   * Returns true if the override was applied, false if the task was not in
   * `needs_operator_review` status (or does not exist).
   */
  operatorOverride(taskId: string, decision: "approve" | "reject", operatorNote: string): boolean;

  // Routing violations (issue #293)
  /**
   * Record an agent-to-repo routing violation.
   * Called when a task is dispatched to an agent that does not own the target repo.
   */
  recordRoutingViolation(violation: Omit<RoutingViolation, "id">): void;
  /**
   * Return the most recent routing violations, newest first.
   * @param limit — max rows to return (default 20)
   */
  getRoutingViolations(limit?: number): RoutingViolation[];
}

// ── Routing violation types (issue #293) ─────────────────────────────────

/**
 * A routing violation: a task was dispatched to an agent that does not own
 * the target repo.  Persisted to `routing_violations` in state.db.
 */
export interface RoutingViolation {
  id?: number;
  /** Task ID that was mis-routed. */
  task_id: string;
  /** Agent that received the task. */
  agent_name: string;
  /** Target repo slug (owner/repo) extracted from source_ref. */
  target_repo: string;
  /** The agent that should have received the task (repo owner). */
  expected_agent: string | null;
  /** ISO-8601 timestamp of the dispatch. */
  dispatched_at: string;
  /** ISO-8601 timestamp when the violation was detected. */
  detected_at: string;
  /** Optional task title for display. */
  task_title?: string | null;
}

// ── Semantic Task Memory types (issue #369) ───────────────────────────────

/**
 * A single entry in the semantic task memory index.
 * Records the outcome (confidence/score) of a task under a normalised topic label.
 */
export interface MemoryEntry {
  /** Auto-increment row ID. */
  id: number;
  /** Normalised topic label (lower-cased, whitespace-trimmed). */
  topic: string;
  /** The task whose outcome is recorded. */
  task_id: string;
  /** Quality/confidence score for this attempt, 0–1. */
  confidence: number;
  /** Outcome classification derived from the score or verification_status. */
  outcome: "success" | "failure" | "partial";
  /** ISO-8601 timestamp of when this entry was recorded. */
  recorded_at: string;
}

/**
 * Aggregated row for "top queried topics" in the daily digest.
 * Derived by counting MemoryEntry rows per topic in a given time window.
 */
export interface TopQueriedTopic {
  topic: string;
  query_count: number;
  avg_confidence: number;
  /** Up to 5 representative task IDs. */
  example_task_ids: string[];
}

/**
 * Aggregated row for "topics with repeated attempts" in the daily digest.
 * Surfaced when the same topic has 2+ recorded entries, indicating the memory
 * did not prevent repeated work.
 */
export interface RepeatedAttemptTopic {
  topic: string;
  attempt_count: number;
  /** Best (highest) confidence score across all attempts. */
  best_score: number;
  task_ids: string[];
}

/**
 * Aggregated row for "persistent low-confidence areas" in the daily digest.
 * Surfaced when ALL recorded attempts for a topic scored below the threshold.
 */
export interface LowConfidenceTopic {
  topic: string;
  attempt_count: number;
  /** Highest score seen (all still below threshold). */
  max_score: number;
  task_ids: string[];
}

/**
 * The full report produced by the daily memory digest.
 */
export interface SemanticMemoryDigestReport {
  /** ISO-8601 timestamp when this report was generated. */
  generated_at: string;
  top_queried_topics: TopQueriedTopic[];
  repeated_attempt_topics: RepeatedAttemptTopic[];
  low_confidence_topics: LowConfidenceTopic[];
}

/**
 * State-store interface for semantic task memory operations.
 * Implemented by StateStore; consumed by MemoryDigestScheduler.
 */
export interface ISemanticMemoryStore {
  /**
   * Upsert a memory entry for a topic / task pair.
   * If an entry for (topic, task_id) already exists, the confidence and outcome
   * are overwritten with the new values.
   *
   * @param topic       Normalised topic label (will be lower-cased + trimmed).
   * @param taskId      Task ID contributing to this entry.
   * @param confidence  Quality/confidence score (0–1).
   * @param outcome     Coarse outcome classification.
   */
  recordMemoryEntry(
    topic: string,
    taskId: string,
    confidence: number,
    outcome: "success" | "failure" | "partial",
  ): void;

  /**
   * Return the top N most-queried topics since `sinceIso` (ISO-8601 date string).
   * "Queried" is approximated as "has the most memory entries recorded".
   */
  getTopMemoryTopics(limit: number, sinceIso: string): TopQueriedTopic[];

  /**
   * Return the top N topics that have 2+ distinct task entries recorded,
   * ordered by attempt_count descending.
   */
  getRepeatedAttemptTopics(limit: number): RepeatedAttemptTopic[];

  /**
   * Return topics where every recorded attempt had a confidence score below
   * `threshold`, ordered by max_score ascending (worst first).
   *
   * @param threshold  e.g. 0.70
   * @param limit      max rows to return
   */
  getLowConfidenceTopics(threshold: number, limit: number): LowConfidenceTopic[];

  /**
   * Return all memory entries for a given topic (FTS match or exact match),
   * ordered by recorded_at descending.  Used by `/memory expand <topic>`.
   *
   * @param topic  Topic string (will be lower-cased + trimmed).
   * @param limit  max rows to return (default 20)
   */
  expandMemoryTopic(topic: string, limit?: number): MemoryEntry[];
}

// ── Meeting-facilitator monthly goal types (issue #411) ───────────────────

/**
 * Progress toward one of the meeting-facilitator-agent's monthly goals.
 */
export interface MeetingFacilitatorGoalItem {
  /** Short machine key for the goal. */
  key: string;
  /** Human-readable description of what the goal measures. */
  description: string;
  /** Numeric target (e.g. 5 for meetings, 1 for shipping). */
  target: number;
  /** Current count this calendar month. */
  current: number;
  /** Progress as a fraction 0–1, capped at 1. */
  progress: number;
  /** Whether this individual goal is met. */
  met: boolean;
}

/**
 * Complete monthly goal widget payload for the meeting-facilitator-agent.
 *
 * Returned by `IMeetingFacilitatorGoalStore.getMeetingFacilitatorGoalWidget()`.
 *
 * Tracks two goals for the current calendar month:
 *  1. `meetings_facilitated` — count of done tasks dispatched to the agent, target 5.
 *  2. `core_logic_shipped`   — at least one approved implementation task, target 1.
 */
export interface MeetingFacilitatorGoalWidget {
  /** ISO-8601 start of the current calendar month (UTC). */
  month_start: string;
  /** ISO-8601 timestamp of when this payload was generated. */
  generated_at: string;
  /**
   * Overall progress 0–1: average of the individual goal progress fractions.
   * Useful for a single progress bar.
   */
  overall_progress: number;
  /** True only when every goal is met. */
  all_goals_met: boolean;
  /** Per-goal breakdown, ordered by key. */
  goals: MeetingFacilitatorGoalItem[];
}

/**
 * Store interface for the meeting-facilitator monthly goal widget.
 *
 * Implemented by the reviewer's StateStore.
 */
export interface IMeetingFacilitatorGoalStore {
  /**
   * Return the complete monthly goal widget for the meeting-facilitator-agent.
   *
   * @param agentNamePattern - SQL LIKE pattern to match the agent name.
   *   Defaults to `'%meeting-facilitator%'`.
   */
  getMeetingFacilitatorGoalWidget(agentNamePattern?: string): MeetingFacilitatorGoalWidget;
}

// ── Improvement detector batch deduplication types (issue #458) ───────────

/**
 * A single record of an improvement-detector analysis run, persisted to
 * `improvement_analysis_runs` in state.db.
 */
export interface ImprovementAnalysisRun {
  /** Auto-incremented row id. */
  id: number;
  /**
   * SHA-256 hex digest of sorted `<taskId>:<status>` entries for the batch.
   * Used as the deduplication key.
   */
  batch_hash: string;
  /** Number of tasks in the batch. */
  task_count: number;
  /**
   * `true`  — analysis was skipped because an identical batch was already
   *           analysed within the deduplication window.
   * `false` — analysis ran normally and results were returned.
   */
  skipped: boolean;
  /** ISO-8601 UTC timestamp of this record. */
  created_at: string;
}

/**
 * Store interface for the improvement-detector batch deduplication guard.
 *
 * Implemented by the reviewer's StateStore.
 */
export interface IImprovementBatchDeduplicationStore {
  /**
   * Persist a record of an analysis run (or skip) for a given batch hash.
   *
   * @param batchHash  - SHA-256 hex of the sorted `<id>:<status>` list.
   * @param taskCount  - Number of tasks in the batch.
   * @param skipped    - `true` if the run was skipped due to deduplication.
   */
  recordImprovementAnalysisRun(batchHash: string, taskCount: number, skipped: boolean): void;

  /**
   * Return `true` if an *unskipped* analysis for `batchHash` was recorded
   * within the last `windowHours` hours (default 6).
   *
   * Only unskipped (i.e. actually-executed) runs count as "seen" — a previous
   * skip does not prevent the next real run from executing.
   */
  hasRecentImprovementAnalysisRun(batchHash: string, windowHours?: number): boolean;

  /**
   * Return recent analysis run records, newest first.
   *
   * @param limit - Maximum rows to return (default 50).
   */
  getRecentImprovementAnalysisRuns(limit?: number): ImprovementAnalysisRun[];
}

// ── Pattern risk signal types (issue #1149) ───────────────────────────────

/**
 * A single `pattern_risk` signal written by the daemon on verification failure.
 *
 * The daemon writes these to `state.db` whenever a task fails verification and
 * a recurring risk pattern is detected (e.g. repeated low scores, same failure
 * dimension multiple cycles in a row).  They were previously orphaned — no code
 * consumed them.  The pattern-risk consumer in the reviewer now reads these and
 * surfaces them as additional context for the improvement detector.
 */
export interface PatternRiskSignal {
  /** Auto-incremented row id. */
  id: number;
  /** Task that triggered this signal. */
  task_id: string;
  /** Agent that produced the failing task. */
  agent_id: string;
  /**
   * Category of the detected pattern, e.g.:
   * - `"repeated_failure"` — same agent failed ≥3 consecutive tasks
   * - `"low_score_streak"` — rolling average below 0.70 for ≥5 tasks
   * - `"dimension_gap"` — a specific quality dimension (correctness,
   *   completeness, test_coverage, code_quality) is consistently low
   */
  pattern_type: string;
  /**
   * Severity of the risk on a 0–1 scale.
   * Computed by the daemon from the depth/recency of the pattern.
   */
  risk_score: number;
  /** Human-readable description of the detected pattern. */
  detail: string;
  /** ISO-8601 UTC timestamp when the signal was recorded. */
  recorded_at: string;
}

/**
 * Aggregated view of pattern_risk signals for a single agent.
 *
 * Built by the `PatternRiskConsumer` from the raw `pattern_risk` table rows.
 * Passed to the improvement detector as additional context so the LLM can
 * generate more targeted suggestions.
 */
export interface AgentPatternRiskSummary {
  /** Agent name. */
  agent_id: string;
  /** Most recent risk score recorded for this agent. */
  latest_risk_score: number;
  /** Mean risk score across all signals in the look-back window. */
  mean_risk_score: number;
  /** All distinct pattern types seen in the window. */
  pattern_types: string[];
  /** Most recent detail text (from the highest-risk signal). */
  top_detail: string;
  /** Number of signals in the window. */
  signal_count: number;
}

/**
 * Store interface for reading pattern_risk signals.
 *
 * Implemented by the reviewer's StateStore.  The daemon (in agent-orchestrator)
 * writes the rows; this interface provides read-only access for the reviewer's
 * pattern-risk consumer.
 */
export interface IPatternRiskStore {
  /**
   * Return raw pattern_risk signals recorded within the last `windowHours`
   * hours, ordered by `recorded_at DESC`.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   * @param limit       - Maximum rows to return.  Default: 200.
   */
  getRecentPatternRiskSignals(windowHours?: number, limit?: number): PatternRiskSignal[];

  /**
   * Return pattern_risk signals aggregated per agent for the look-back window.
   *
   * Agents with no signals in the window are omitted.  Results are sorted by
   * `mean_risk_score DESC` so the most at-risk agents appear first.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   */
  getAgentPatternRiskSummaries(windowHours?: number): AgentPatternRiskSummary[];
}

// ── Score provenance store (issue #483) ──────────────────────────────────────

/**
 * Minimal store interface for the score provenance endpoint.
 *
 * Implemented by `StateStore`.  Extracted so the endpoint can be unit-tested
 * with a lightweight stub without pulling in the full StateStore.
 *
 * Note: `getLatestVerificationRecord` is already declared on
 * `IVerificationResultStore` (see above).  Consumers that hold a
 * `StateStore` reference automatically satisfy this interface.
 */
export interface IScoreProvenanceStore {
  getLatestVerificationRecord(taskId: string): VerificationResultRecord | null;
}

// ── Persistent anomaly store (issue #483) ────────────────────────────────────

/**
 * Store interface for the persistent anomaly tracker.
 *
 * Implemented by `StateStore` once `PERSISTENT_ANOMALIES_MIGRATION_SQL`
 * has been applied to `state.db`.
 */
export interface IPersistentAnomalyStore {
  /**
   * Insert one anomaly observation into `score_anomaly_observations`.
   */
  insertAnomalyObservation(obs: {
    task_id: string;
    cycle_id: string;
    agent_name?: string | null;
    score?: number;
    anomaly_type?: string;
  }): void;

  /**
   * Return tasks that have been observed as anomalous in ≥ `minCycles` distinct
   * analysis cycles within the last `days` days.
   *
   * @param minCycles - Minimum distinct cycles to qualify. Default: 2.
   * @param days      - Lookback window in days. Default: 7.
   * @param limit     - Maximum rows to return. Default: 50.
   */
  getPersistentAnomalies(
    minCycles?: number,
    days?: number,
    limit?: number,
  ): Array<{
    task_id: string;
    agent_name: string | null;
    latest_score: number;
    cycle_count: number;
    anomaly_type: string;
    first_observed_at: string;
    last_observed_at: string;
  }>;
}

// ── Marginal approvals feed store (issue #502) ────────────────────────────────

/**
 * Minimal store interface for the marginal approvals feed.
 *
 * Satisfied by `StateStore`. Extracted so the feed builder can be
 * unit-tested with a lightweight stub.
 */
export interface IMarginalApprovalsFeedStore {
  /**
   * Return approved tasks with quality_score in [0.60, 0.79] (the marginal
   * approval band), updated within the last `days` days, ordered by
   * quality_score ascending (riskiest first).
   *
   * @param days  - Lookback window in days. 0 = all-time. Default: 14.
   * @param limit - Maximum rows to return. Default: 50.
   */
  getMarginalApprovedTasks(days?: number, limit?: number): Task[];
}
