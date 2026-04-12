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
  created_at: string;
  updated_at: string;
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
export interface IStateStore {
  // Task operations
  getTask(id: string): Task | null | undefined;
  updateTask(id: string, updates: Partial<Task>): void;
  hasActiveTask(agentName: string): boolean;
  listTasks(opts: { status?: TaskStatus; agent_name?: string; limit?: number }): Task[];

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
export interface ITelegramStateStore extends IStateStore {
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
