import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { generateId } from "../utils/ulid.js";
import { extractIntendedAgent } from "../orchestrator/routing-mismatch-detector.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const storeLog = createLogger("store");

// ── Daemon lifecycle audit types ──────────────────────────────────────────────

/** The type of daemon lifecycle event recorded in the audit trail. */
export type DaemonLifecycleEvent = "start" | "stop" | "crash" | "self-update";

/** A single daemon lifecycle event as persisted in the `daemon_lifecycle` table. */
export interface DaemonLifecycleEntry {
  id: number;
  /** Event type: start | stop | crash | self-update */
  event: DaemonLifecycleEvent;
  /** PID of the daemon process at the time of the event. */
  pid: number | null;
  /** Human-readable reason (e.g. signal name, error message). */
  reason: string | null;
  /** Process exit code, if applicable (crash events). */
  exit_code: number | null;
  /** Wall-clock duration of the daemon run in milliseconds (stop/crash events). */
  duration_ms: number | null;
  /** Git commit hash the daemon is running from (start/self-update events). */
  commit_hash: string | null;
  /** ISO 8601 timestamp of the event. */
  timestamp: string;
}

// ── Config reload audit types ─────────────────────────────────────────────────

/** What triggered a config reload event. */
export type ConfigReloadTrigger = "startup" | "file-watcher" | "signal";

/** A single config reload event as persisted in the `config_reloads` table. */
export interface ConfigReloadRecord {
  id: number;
  /** ISO timestamp of the reload attempt. */
  timestamp: string;
  /** 1 = success, 0 = failure. */
  success: number;
  /** Number of config fields that changed (0 = reload was no-op). */
  change_count: number;
  /** JSON-encoded string[] of changed field paths, e.g. ["proxy.timeout_ms"]. */
  changes_json: string | null;
  /** JSON-encoded string[] of validation error messages on failure. */
  errors_json: string | null;
  /** What triggered this reload: startup | file-watcher | signal. */
  triggered_by: ConfigReloadTrigger;
}

// ── Approval Queue types ──────────────────────────────────────────────────────

/**
 * A task that failed automated verification but fell in the borderline score
 * range, queued for human operator review via Telegram /approve or /reject.
 */
export interface ApprovalQueueEntry {
  id: number;
  /** Full ULID of the task. */
  task_id: string;
  /** Human-readable task title. */
  title: string;
  /** Agent that produced the work. */
  agent_name: string | null;
  /** URL of the open PR associated with the task (if found). */
  pr_url: string | null;
  /** Verification score (0–1). */
  score: number;
  /** JSON-encoded Record<string, number> of per-dimension scores. */
  dimensions_json: string | null;
  /** One-sentence LLM-generated risk summary for the operator. */
  risk_summary: string | null;
  /** Queue status: pending (awaiting operator decision) | approved | rejected. */
  status: "pending" | "approved" | "rejected";
  created_at: string;
  resolved_at: string | null;
  /** Who resolved: 'operator' (Telegram command) | 'system' (auto-resolved). */
  resolved_by: string | null;
  /** Bypass reason provided by operator when approving a very low-score task (score < 0.40). */
  bypass_reason: string | null;
}

export interface InsertApprovalQueueEntryParams {
  task_id: string;
  title: string;
  agent_name?: string | null;
  pr_url?: string | null;
  score: number;
  dimensions_json?: string | null;
  risk_summary?: string | null;
}

/**
 * Thrown by `StateStore.createTask()` when the generated ULID already exists
 * in the tasks table.  Callers can catch this to fire Telegram alerts or
 * record the incident without relying on raw SQLite constraint error messages.
 */
export class DuplicateTaskIdError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly existingTitle: string,
    public readonly newTitle: string,
  ) {
    super(
      `Duplicate task ID "${taskId}": existing task "${existingTitle}" conflicts with new task "${newTitle}"`,
    );
    this.name = "DuplicateTaskIdError";
  }
}

export type TaskStatus = "pending" | "planning" | "dispatched" | "in_progress" | "done" | "failed" | "escalated" | "result_missing" | "superseded" | "paused";

// ── Operator Controls types ───────────────────────────────────────────────────

export type OperatorControlType = "pause" | "resume" | "redirect" | "inject" | "merge";
export type OperatorControlStatus = "pending" | "applied" | "failed";

export interface OperatorControlInput {
  task_id: string;
  control_type: OperatorControlType;
  value?: string;
  operator?: string;
}

export interface OperatorControl extends OperatorControlInput {
  id: string;
  status: OperatorControlStatus;
  applied_at: string | null;
  failure_reason: string | null;
  created_at: string;
}
// ── DAG Execution types (issue #1085) ─────────────────────────────────────────

/** Status of an entire DAG execution (one per complex multi-agent task). */
export type DagExecutionStatus = "running" | "done" | "failed";

/** An individual step/node within a DAG execution. */
export type DagNodeStatus = "pending" | "dispatching" | "dispatched" | "done" | "failed";

/** Persisted record of a multi-agent DAG execution plan. */
export interface DagExecution {
  id: string;
  parent_task_id: string;
  plan_json: string;
  status: DagExecutionStatus;
  created_at: string;
  updated_at: string;
}

/** Persisted state for a single node/step within a DAG execution. */
export interface DagNode {
  id: string;
  dag_id: string;
  step_id: string;
  /** Null until the node is dispatched and a task record is created. */
  task_id: string | null;
  agent_name: string | null;
  instruction: string;
  /** JSON-encoded string[] of step_ids that must complete before this node. */
  depends_on_json: string;
  status: DagNodeStatus;
  /** Populated from the associated task result when the node reaches "done". */
  result: string | null;
  created_at: string;
  updated_at: string;
}

// ── Failure Interception types (issue #1086) ──────────────────────────────────

/** A single failure interception event recorded at pre-dispatch time. */
export interface FailureInterceptionEntry {
  id: string;
  task_id: string;
  /** JSON array of matched failed task IDs. */
  similar_task_ids: string;
  /** Top Jaccard similarity score (0–1). */
  similarity_score: number;
  /** Number of failure lessons injected into the dispatch prompt. */
  lessons_injected: number;
  /** 1 if model tier upgrade was suggested, 0 otherwise. */
  model_upgraded: number;
  /** 'passed' | 'failed' | null (pending). */
  final_outcome: "passed" | "failed" | null;
  created_at: string;
}

/** Aggregate stats for the failure interception panel. */
export interface FailureInterceptionStats {
  total: number;
  avg_similarity: number;
  model_upgrades: number;
  prevention_rate: number;
}

export type TaskSource = "github" | "linear" | "slack" | "manual" | "pr-feedback" | "marginal-redispatch";
/**
 * Identifies the kind of work a task represents.
 * Built-in types: "implementation" | "research" | "facilitation".
 * Additional types can be introduced via the `task_types` map in agents.yaml
 * without modifying source code — the verifier loads their prompts dynamically.
 */
export type TaskType = string;

export type VerificationStatus = "pending" | "approved" | "rejected" | null;

export interface Task {
  id: string;
  title: string;
  description: string | null;
  source: TaskSource;
  source_ref: string | null;
  status: TaskStatus;
  agent_name: string | null;
  conversation_id: string | null;
  result: string | null;
  parent_task_id: string | null;
  step_id: string | null;
  plan: string | null;
  task_type: TaskType;
  verification_status: VerificationStatus;
  quality_score: number | null;
  verification_notes: string | null;
  /** Number of dispatch attempts that have failed. 0 for a fresh task. */
  retry_count: number;
  /** ISO timestamp after which the task is eligible for retry, or null if not scheduled. */
  next_retry_at: string | null;
  /** Number of revision attempts for this source_ref. Incremented each time a [revision] task is dispatched. */
  revision_count: number;
  /**
   * Groups tasks that belong to the same logical unit of work across repos.
   * Defaults to the task's own ID. Cross-repo follow-up tasks inherit the
   * originating task's lineage_group_id so operators can trace the full blast
   * radius of a change.
   */
  lineage_group_id: string | null;
  reported: number;
  created_at: string;
  updated_at: string;
}

export interface TaskLog {
  id: number;
  task_id: string;
  direction: "to_agent" | "from_agent" | "system";
  agent_name: string | null;
  content: string;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

export interface AgentMetrics {
  agent_name: string;
  total: number;
  done: number;
  failed: number;
  /** Average time from task creation to completion, in milliseconds */
  avg_duration_ms: number | null;
  /** Fraction of verified tasks that passed (approved / (approved + rejected)) */
  verification_pass_rate: number | null;
  /** Average quality score across verified tasks */
  avg_quality_score: number | null;
}

export interface CycleMetrics {
  total_cycles: number;
  avg_duration_ms: number | null;
  last_cycle_at: string | null;
}

export type SupervisorOutcome = "dispatched" | "skipped" | "failed" | "none" | "unhandled";

export interface SupervisorDecisionRecord {
  id: number;
  action: string;
  agent_name: string | null;
  reason: string;
  message: string | null;
  rationale: string | null;
  /** Concrete issue refs attached to this decision, e.g. ["owner/repo#523"] */
  issue_refs: string[];
  /** Hard gates that fired for this decision, e.g. ["issue already closed"] */
  hard_gates: string[];
  outcome: SupervisorOutcome;
  task_id: string | null;
  created_at: string;
}

/**
 * A single routing timeline event — a supervisor decision projected onto a
 * time axis.  Returned by `getRoutingTimelineData()` for the dashboard's
 * per-agent swimlane chart.
 */
export interface RoutingTimelineEvent {
  id: number;
  /** ISO timestamp of the decision — used for X-axis positioning. */
  created_at: string;
  /** Agent targeted by this decision, or null when the supervisor acted globally. */
  agent_name: string | null;
  /** Outcome colour-code: dispatched=green, skipped=yellow, failed=red, other=grey. */
  outcome: SupervisorOutcome;
  /** Human-readable reason shown in the hover tooltip. */
  reason: string;
  /** High-level action label (e.g. "dispatch", "skip", "escalate"). */
  action: string;
  /** Task ID for click-through navigation to the detail modal. */
  task_id: string | null;
}

export type DispatchValidationOutcome = "passed" | "blocked";
export type DispatchValidationCheckStatus = "passed" | "failed" | "info";

export interface DispatchValidationCheck {
  name: string;
  status: DispatchValidationCheckStatus;
  code: string;
  detail: string;
}

export interface DispatchValidationRecord {
  id: number;
  source: string;
  source_ref: string | null;
  agent_name: string | null;
  repo: string | null;
  issue_number: number | null;
  outcome: DispatchValidationOutcome;
  failure_check: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  checklist_json: string;
  created_at: string;
}

/**
 * Structured dispatch rationale attached to every supervisor dispatch decision.
 * Combines LLM-generated reasoning with system-collected metadata so operators
 * can audit *why* any dispatch was made.
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
  /** LLM-assigned confidence score (0–1), null if not provided */
  confidence_score: number | null;
  /** Summary of the authoritative pre-dispatch validation outcome, if any */
  pre_dispatch_validation?: {
    outcome: DispatchValidationOutcome;
    failure_check: string | null;
    failure_code: string | null;
    failure_reason: string | null;
  } | null;
}

function parseJsonStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Distribution of quality scores across verified tasks, bucketed by tier.
 * Counts are mutually exclusive and exhaustive over all verified top-level tasks.
 */
export interface ScoreDistribution {
  /** Tasks with quality_score >= 0.90 */
  excellent: number;
  /** Tasks with 0.70 <= quality_score < 0.90 */
  good: number;
  /** Tasks with 0.50 <= quality_score < 0.70 */
  fair: number;
  /** Tasks with quality_score < 0.50 */
  poor: number;
  /** Tasks with verification_status set but quality_score IS NULL */
  unscored: number;
  /** Total number of verified tasks (sum of all buckets) */
  total: number;
}

/**
 * Quality score trend for a single agent, comparing the most recent N tasks
 * to the prior N tasks.
 */
export interface ScoreTrend {
  /** Average quality score of the most recent `window_size` scored tasks */
  recent_avg: number | null;
  /** Average quality score of the N tasks before the recent window */
  prior_avg: number | null;
  /** Delta = recent_avg - prior_avg. Positive = improving. */
  delta: number | null;
  /** Human-readable direction */
  direction: "improving" | "stable" | "declining" | "insufficient_data";
  /** Number of scored tasks available (across both windows) */
  scored_count: number;
  /** Window size used for each half of the comparison */
  window_size: number;
}

/** Per-agent productivity metrics for a rolling time window */
/** Per-agent retry statistics for a given time window. */
export interface AgentRetryMetrics {
  agent_name: string;
  /** Number of distinct tasks that were retried at least once in the window. */
  retried_tasks: number;
  /** Sum of all retry attempts across those tasks. */
  total_retries: number;
  /** Tasks whose retry budget was exhausted (failed permanently after max retries). */
  exhausted_budget: number;
  /** Tasks currently waiting in backoff before their next retry attempt. */
  waiting_retry: number;
}

/** System-wide retry health snapshot. */
export interface RetryMetrics {
  per_agent: AgentRetryMetrics[];
  /** Total tasks currently waiting for a retry across all agents. */
  total_waiting: number;
  /** Total tasks that exhausted their retry budget in the window. */
  total_exhausted: number;
}

export interface WindowedAgentMetrics {
  agent_name: string;
  /** Total top-level tasks in the window */
  total: number;
  /** Tasks with status='done' in the window */
  done: number;
  /** Tasks with status='failed' in the window */
  failed: number;
  /** Percentage of tasks that failed: failed / total * 100, or null if no tasks */
  fail_pct: number | null;
  /** Rejection rate: rejected / (approved + rejected), or null if no verified tasks */
  rejection_pct: number | null;
  /** Average quality_score across verified tasks in the window, or null */
  avg_quality_score: number | null;
  /** Average milliseconds from task creation to done for completed tasks in window */
  avg_duration_ms: number | null;
  /** Quality score trend direction over the window */
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

/** Per-day task metrics for trend view */
export interface DailyTaskMetrics {
  /** ISO date string: 'YYYY-MM-DD' */
  date: string;
  tasks_completed: number;
  tasks_failed: number;
  /** Average ms from creation → done for tasks completed on this day */
  avg_duration_ms: number | null;
  /** Fraction of verified tasks that passed on this day */
  verification_pass_rate: number | null;
  /** Average quality score for verified tasks on this day */
  avg_quality_score: number | null;
}

/** Per-day daemon cycle metrics for trend view */
export interface DailyCycleMetrics {
  /** ISO date string: 'YYYY-MM-DD' */
  date: string;
  cycle_count: number;
  avg_duration_ms: number | null;
}

/**
 * Aggregated skip-reason pattern for the rolling 7-day window.
 * Used by the skip-pattern aggregator (issue #787) to surface systemic blockers.
 */
export interface SkipPatternRow {
  /** The normalized skip reason text. */
  reason: string;
  /** Number of skips matching this reason in the window. */
  skip_count: number;
  /** Distinct agent names that encountered this skip reason. */
  affected_agents: string[];
  /** Sample issue refs (GitHub #NNN) associated with these skips. */
  sample_issue_refs: string[];
  /** ISO timestamp of the earliest matching skip in the window. */
  first_seen: string;
  /** ISO timestamp of the most recent matching skip in the window. */
  last_seen: string;
}

/** Per-day dispatch efficiency metrics for the waste-rate widget (issue #517) */
export interface DispatchWasteDay {
  /** ISO date string: 'YYYY-MM-DD' */
  date: string;
  /** Dispatches blocked by the issue-state cache (stale/closed/already-PR'd) */
  stale_prevented: number;
  /** Total dispatch attempts = actual dispatches + stale_prevented */
  dispatches_total: number;
  /** Waste rate as a percentage (0–100), null if no attempts */
  waste_rate_pct: number | null;
}

/**
 * Aggregated dispatch efficiency over a rolling N-day window.
 * Surfaces how many wasted agent cycles the issue-state cache (issue #458)
 * is saving, so operators can verify the cache is working and trending down.
 */
export interface DispatchWasteMetrics {
  days: number;
  daily: DispatchWasteDay[];
  total_stale_prevented: number;
  total_dispatches: number;
  avg_waste_rate_pct: number | null;
}

/** Per-hour dispatch waste bucket for 24h rolling window view. */
export interface DispatchWasteHour {
  /** ISO hour string: 'YYYY-MM-DD HH:00' */
  hour: string;
  /** Dispatches blocked by the issue-state cache in this hour */
  stale_prevented: number;
  /** Total dispatch attempts = actual dispatches + stale_prevented */
  dispatches_total: number;
  /** Waste rate as a percentage (0–100), null if no attempts */
  waste_rate_pct: number | null;
}

/** Aggregated dispatch waste metrics over a rolling 24-hour window. */
export interface DispatchWasteMetrics24h {
  hourly: DispatchWasteHour[];
  total_stale_prevented: number;
  total_dispatches: number;
  avg_waste_rate_pct: number | null;
  /** Highest waste rate recorded in any single hour; null when no data. */
  peak_waste_rate_pct: number | null;
}

/** Per-day health check efficiency metrics (issue #749) */
export interface HealthCheckEfficiencyDay {
  /** ISO date string: 'YYYY-MM-DD' */
  date: string;
  /** Total health check dispatch tasks created (source_ref LIKE 'health-check-fail:%') */
  total_dispatches: number;
  /** Dispatches auto-resolved by daemon without agent intervention */
  false_positives: number;
  /** False positive rate as a percentage (0–100), null if no dispatches */
  false_positive_rate_pct: number | null;
}

/**
 * Aggregated health check efficiency metrics over a rolling N-day window.
 * Tracks false positive rate — health check failures that self-resolved
 * without requiring agent action — to verify grace-period and dedup fixes.
 */
export interface HealthCheckEfficiencyMetrics {
  days: number;
  daily: HealthCheckEfficiencyDay[];
  total_dispatches: number;
  total_false_positives: number;
  avg_false_positive_rate_pct: number | null;
}

// ── Health Check Storm Panel (issue #743) ──────────────────────────────────

/** Event kind recorded in health_check_events table. */
export type HealthCheckEventKind =
  | "dispatched"             // Escalation task created (grace period expired, gate open)
  | "grace_period_suppressed" // Agent self-recovered before grace period expired
  | "dedup_gate_suppressed";  // Escalation call was no-op (active incident already exists)

/** A single health check event recorded in the DB. */
export interface HealthCheckEvent {
  kind: HealthCheckEventKind;
  agent_name: string;
  detail?: string;
  recorded_at: string; // ISO timestamp
}

/** Per-hour bucket in the 24h rolling window view. */
export interface HealthCheckStormHour {
  /** ISO hour string: 'YYYY-MM-DD HH:00' */
  hour: string;
  dispatched: number;
  grace_period_suppressed: number;
  dedup_gate_suppressed: number;
  total_evaluated: number;
}

/** Aggregated health check storm metrics over a rolling 24h window. */
export interface HealthCheckStormMetrics {
  /** Window size in hours (always 24 in normal use, configurable for testing). */
  window_hours: number;
  hourly: HealthCheckStormHour[];
  total_dispatched: number;
  total_grace_period_suppressed: number;
  total_dedup_gate_suppressed: number;
  total_evaluated: number;
  /** Dispatch rate as % of total evaluated events; null when no events. */
  dispatch_rate_pct: number | null;
  /** Before-fix baseline: 45% of task capacity consumed by health check storms. */
  baseline_dispatch_rate_pct: number;
}

/**
 * Per-provider aggregated metrics for the Claude vs Codex fleet comparison panel.
 * Provider is inferred from agent_name prefix: "claude-" → "claude", "codex-" → "openai".
 */
export interface FleetProviderMetrics {
  /** Provider identifier: "claude" | "openai" | "other" */
  provider: string;
  /** Number of distinct agents that contributed tasks in this window */
  agent_count: number;
  /** Total top-level tasks assigned in the window */
  total_tasks: number;
  /** Tasks completed successfully (status = 'done') */
  done: number;
  /** Tasks that failed (status = 'failed') */
  failed: number;
  /** Success rate: done / total * 100, or null if no tasks */
  success_rate_pct: number | null;
  /** Average quality score from verified tasks, or null */
  avg_quality_score: number | null;
  /** Average ms from task creation → done for completed tasks, or null */
  avg_duration_ms: number | null;
  /** Total tokens consumed by this provider in the window (from token_usage table) */
  total_tokens: number;
}

/**
 * Time-series metrics over a rolling N-day window, plus Δ deltas
 * comparing that window to the equally-sized prior window.
 */
export interface MetricsTrend {
  /** Number of days in the window */
  days: number;
  task_days: DailyTaskMetrics[];
  cycle_days: DailyCycleMetrics[];
  /** Δ avg tasks-completed/day vs prior period. Positive = more throughput. */
  throughput_delta: number | null;
  /** Δ verification pass rate vs prior period */
  pass_rate_delta: number | null;
  /** Δ avg quality score vs prior period */
  score_delta: number | null;
  /** Δ avg cycle duration (ms) vs prior period. Negative = faster. */
  cycle_duration_delta: number | null;
}

export interface SystemMetrics {
  /** Aggregated across all agents / tasks */
  total_tasks: number;
  done_tasks: number;
  failed_tasks: number;
  /** Average ms from task creation → done across all completed top-level tasks */
  avg_task_duration_ms: number | null;
  /** Global verification pass rate */
  verification_pass_rate: number | null;
  /** Global average quality score */
  avg_quality_score: number | null;
  /** Distribution of quality scores across verified tasks */
  score_distribution: ScoreDistribution;
  /** Per-agent quality score distributions (keyed by agent_name) */
  per_agent_score_distribution: Record<string, ScoreDistribution>;
  /** Per-agent quality score trends (keyed by agent_name) */
  per_agent_score_trends: Record<string, ScoreTrend>;
  per_agent: AgentMetrics[];
  cycles: CycleMetrics;
  /** PR review metrics (cycle time and rejection rate) */
  pr_metrics: PRMetrics;
}

export type PRCreationAttemptStatus = "pending" | "succeeded" | "failed";

/**
 * A single entry in the PR creation retry queue.
 * Tracks failed orphan-branch → PR creation attempts with exponential backoff.
 */
export interface PRCreationAttempt {
  id: number;
  repo: string;
  branch: string;
  attempt_count: number;
  last_error: string | null;
  last_attempted_at: string | null;
  next_retry_at: string | null;
  status: PRCreationAttemptStatus;
  created_at: string;
  updated_at: string;
}

/**
 * Per-agent timeout rate metrics for a rolling time window.
 * Timeouts are identified by retry_count > 0 (tasks that triggered the
 * automatic retry-with-backoff mechanism, which fires on exit-code-143 / SIGTERM).
 */
export interface AgentTimeoutRate {
  agent_name: string;
  /** Total top-level tasks dispatched to this agent whose created_at falls in the window */
  total_tasks: number;
  /** Tasks that timed out at least once (retry_count > 0) in the window */
  timed_out_tasks: number;
  /** Percentage: timed_out_tasks / total_tasks * 100, or null if no tasks */
  timeout_rate_pct: number | null;
}

/**
 * Per-agent timeout analytics for a rolling time window.
 * Includes p95 duration and a recommended timeout setting.
 */
export interface AgentTimeoutAnalytics {
  agent_name: string;
  /** Total top-level tasks dispatched in the window */
  total_tasks: number;
  /** Tasks that timed out at least once (retry_count > 0) in the window */
  timed_out_tasks: number;
  /** Percentage: timed_out_tasks / total_tasks * 100, or null if no tasks */
  timeout_rate_pct: number | null;
  /** Average ms from task creation to done for completed tasks in window */
  avg_duration_ms: number | null;
  /** 95th-percentile ms from task creation to done for completed tasks */
  p95_duration_ms: number | null;
  /**
   * Recommended timeout_ms: p95 * 1.2 rounded up to the nearest minute,
   * minimum 5 minutes. null when there are no completed tasks to measure.
   */
  suggested_timeout_ms: number | null;
}

/** A single task record that experienced a timeout (retry_count > 0). */
export interface TimeoutTaskRecord {
  id: string;
  title: string;
  agent_name: string;
  retry_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  /** End-to-end duration from created_at to updated_at in ms */
  duration_ms: number | null;
}

/** Full timeout analytics for a rolling time window. */
export interface TimeoutAnalytics {
  days: number;
  per_agent: AgentTimeoutAnalytics[];
  /** Individual tasks that timed out, newest first (max 50) */
  timeout_tasks: TimeoutTaskRecord[];
  total_timed_out: number;
  total_tasks: number;
}

/** Aggregate telemetry across all PR creation attempts. */
export interface PRCreationTelemetry {
  total_branches: number;
  pending: number;
  succeeded: number;
  failed: number;
  total_attempts: number;
  success_rate: number | null;
  top_errors: Array<{ error: string; count: number }>;
}

export type MergeQueueStatus = "queued" | "merging" | "merged" | "failed" | "skipped";

/**
 * A single entry in the PR merge queue.
 */
export interface MergeQueueEntry {
  id: number;
  repo: string;
  pr_number: number;
  branch: string;
  position: number;
  status: MergeQueueStatus;
  enqueued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

/**
 * A single PR review decision recorded by the orchestrator.
 */
export interface PRReviewRecord {
  id: number;
  repo: string;
  pr_number: number;
  decision: "approve" | "request-changes" | "escalate";
  created_at: string;
}

/**
 * Per-agent reliability health summary for `orch agents --health`.
 * Derived entirely from existing task data — no new infrastructure.
 */
export interface AgentHealthSummary {
  agent_name: string;
  /** Success rate over last 30 top-level tasks (done / total), null if no tasks */
  success_rate: number | null;
  /** Total tasks in the last 30 */
  total: number;
  /** Done tasks in the last 30 */
  done: number;
  /** Failed tasks in the last 30 */
  failed: number;
  /** Number of consecutive failed tasks at the head of the task history */
  consecutive_failures: number;
  /** First 120 chars of the result field from the most recent failed task */
  last_failure_reason: string | null;
  /** Timestamp of the most recent done task */
  last_success_at: string | null;
  /**
   * Fraction of the last 30 tasks that were revision/rework tasks
   * (source=pr-feedback OR title starts with "[revision]").
   * null when there are no tasks.
   */
  revision_rate: number | null;
  /**
   * Success rate on first-attempt tasks only (excluding revision/rework tasks).
   * = done first-attempt tasks / total first-attempt tasks.
   * null when there are no first-attempt tasks.
   */
  first_attempt_success_rate: number | null;
}

export interface AgentTaskTypeSuccessRate {
  agent_name: string;
  task_type: TaskType;
  total: number;
  done: number;
  success_rate: number | null;
}

/**
 * A stored behavioral directive issued by the user.
 * Directives are injected into the system prompt of every agent dispatch
 * to ensure persistent behavioral corrections survive daemon restarts.
 */
export interface Directive {
  id: number;
  text: string;
  created_at: string;
}

/** Classification of a learned rule's domain. */
export type LearnedRuleCategory = "style" | "architecture" | "testing" | "security" | "convention" | "workflow";

/** A per-repo convention learned from PR review feedback. */
export interface LearnedRule {
  id: number;
  /** GitHub repo slug, e.g. "rapartlu/agent-orchestrator" */
  repo: string;
  /** The rule text injected into prompts */
  rule: string;
  /** Category for filtering/display */
  category: LearnedRuleCategory;
  /** Where this rule was learned from, e.g. "PR #489 review comment" */
  source: string;
  /** Task ID that triggered the rule extraction */
  source_task_id: string | null;
  /** Confidence score 0–1, decays over time */
  confidence: number;
  /** How many times this rule has been injected into dispatches */
  applied_count: number;
  /** How many times a dispatch with this rule succeeded verification */
  success_count: number;
  /** How many times a dispatch with this rule failed verification */
  failure_count: number;
  /** ISO timestamp of last injection */
  last_applied: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Aggregated PR review metrics — cycle time and rejection rate.
 */
export interface PRMetrics {
  /** Total review decisions recorded */
  total_reviews: number;
  /** PRs that were approved (and merged) */
  approved: number;
  /** Review rounds that requested changes */
  request_changes: number;
  /** PRs escalated to human reviewer */
  escalated: number;
  /**
   * Rejection rate = request-changes / (approved + request-changes).
   * null when no approve/request-changes decisions have been recorded yet.
   */
  rejection_rate: number | null;
  /**
   * Average time (ms) from first review decision on a PR to its approval.
   * Only counts PRs that were eventually approved.
   * null when no approved PRs have been recorded.
   */
  avg_cycle_time_ms: number | null;
  /** Per-repo breakdown */
  per_repo: Array<{
    repo: string;
    total_reviews: number;
    approved: number;
    request_changes: number;
    escalated: number;
    rejection_rate: number | null;
    avg_cycle_time_ms: number | null;
  }>;
}

/**
 * Per-agent token usage aggregate for a rolling time window.
 * Returned by StateStore.getAgentTokenUsage().
 */
/**
 * An issue that has gone through multiple revision cycles without resolution.
 * Surfaced when revision_count >= 2 for any source_ref.
 */
export interface StuckIssue {
  /** The source_ref (e.g. "owner/repo#42") identifying the issue */
  source_ref: string;
  /** Total number of revision attempts for this source_ref */
  revision_count: number;
  /** Agent currently assigned to the most recent task */
  agent_name: string | null;
  /** Quality scores from each attempt (chronological) */
  quality_scores: (number | null)[];
  /** Task IDs for all attempts (chronological) */
  task_ids: string[];
  /** Titles from all attempts (chronological) */
  titles: string[];
  /** Timestamp of the most recent attempt */
  last_attempt_at: string;
}

export interface AgentTokenUsage {
  agent_name: string;
  /** Sum of tokens_in for the window */
  input_tokens: number;
  /** Sum of tokens_out for the window */
  output_tokens: number;
  /** Total tokens (input + output) for the window */
  total_tokens: number;
}

export interface AgentTokenUsageDetail extends AgentTokenUsage {
  provider: string;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface AgentDailyTokenUsage {
  date: string;
  agent_name: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export type FleetComparisonProvider = "claude" | "codex";

export interface FleetComparisonEntry {
  provider: FleetComparisonProvider;
  label: string;
  tasks_completed: number;
  tasks_failed: number;
  tasks_attempted: number;
  success_rate: number | null;
  avg_quality_score: number | null;
  tokens_in: number;
  tokens_out: number;
  total_tokens: number;
  records: number;
}

export interface FleetComparisonMetrics {
  days: number;
  rows: FleetComparisonEntry[];
}

/**
 * An atomic claim record written before any dispatch to prevent two agents
 * being dispatched to the same issue simultaneously (issue #539).
 *
 * The claim is acquired via INSERT OR IGNORE inside a transaction so only
 * one writer can hold it.  Claims expire after `claim_ttl_ms` milliseconds
 * (default 2 hours) to handle hung or crashed agents.
 */
export interface IssueClaim {
  /** The trigger source: "github" | "linear" | "slack" */
  source: string;
  /** The source ref, e.g. "owner/repo#42" */
  source_ref: string;
  /** Agent that holds this claim */
  agent_name: string;
  /** Task ID created for this dispatch (may be null if dispatch failed before task creation) */
  task_id: string | null;
  /** ISO timestamp when the claim was acquired */
  claimed_at: string;
  /** ISO timestamp after which the claim is considered expired */
  expires_at: string;
}

/**
 * A per-issue dispatch lock record (issue #916).
 *
 * Written when an issue is dispatched; prevents rapid re-dispatch storms by
 * blocking subsequent dispatch attempts for the same sourceRef until the lock
 * expires (default 10 minutes) or is explicitly released when the PR is merged
 * or the issue is closed.
 */
export interface DispatchLock {
  /** The trigger source: "github" | "linear" | "slack" */
  source: string;
  /** The source ref, e.g. "owner/repo#42" */
  source_ref: string;
  /** Agent that triggered the dispatch */
  agent_name: string;
  /** ISO timestamp when the lock was acquired */
  locked_at: string;
  /** ISO timestamp after which the lock is considered expired */
  expires_at: string;
}

/**
 * An in-flight dispatch reservation record (issue #927).
 *
 * Written the moment an issue claim is acquired — before the agent starts
 * work. Covers the race window between claim acquisition and PR creation
 * (5–25 minutes) that the 10-minute dispatch_lock TTL does not fully cover.
 * A subsequent dispatch attempt for the same sourceRef will find this
 * reservation and abort before starting a duplicate implementation.
 */
export interface InFlightReservation {
  /** The trigger source: "github" | "linear" | "slack" */
  source: string;
  /** The source ref, e.g. "owner/repo#42" */
  source_ref: string;
  /** Agent that holds this reservation */
  agent_name: string;
  /** Task ID created for this dispatch (null until task record is written) */
  task_id: string | null;
  /** ISO timestamp when the reservation was created */
  reserved_at: string;
  /** ISO timestamp after which the reservation is considered expired */
  expires_at: string;
}

/**
 * Result shape for `getMarginalScoreTasks()`.
 * Exposed via `GET /marginal-score-tasks`.
 */
export interface MarginalScoreTasksResult {
  /** Total matching tasks (across all pages). */
  total: number;
  /** Average quality score across all matching tasks, or null if none. */
  avg_score: number | null;
  /** Task records for this page. */
  tasks: Array<{
    id: string;
    title: string;
    description: string | null;
    source: string;
    source_ref: string | null;
    status: string;
    agent_name: string | null;
    quality_score: number;
    verification_status: string | null;
    verification_notes: string | null;
    task_type: string;
    created_at: string;
    updated_at: string;
  }>;
  /** Daily marginal-score task counts (oldest first), suitable for trend sparkline. */
  trend: Array<{ day: string; count: number }>;
  /** Per-agent breakdown: how many marginal tasks each agent produced. */
  per_agent: Array<{ agent_name: string; count: number; avg_score: number }>;
}

/**
 * Per-agent standup quality trend computed over a rolling window.
 * Returned by `getStandupQualityTrend()` and exposed via `GET /standup-quality`.
 */
export interface StandupQualityAgentTrend {
  agent_name: string;
  /** Chronological quality scores (oldest first), suitable for sparkline rendering. */
  scores: number[];
  /** Matching YYYY-MM-DD standup dates (parallel with `scores`). */
  dates: string[];
  /** Rolling average score across the window, null when no data. */
  avg_score: number | null;
  /** Most recent standup score, null when no data. */
  latest_score: number | null;
  /** True when the last 3 standups all scored below 0.70 — operator coaching warranted. */
  low_streak: boolean;
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

/**
 * A single routing decision record.
 * Written at dispatch time; quality_score is filled when the task is verified.
 */
export interface RoutingOutcome {
  id: number;
  task_id: string;
  agent_chosen: string;
  task_type: string;
  route_method: "deterministic" | "llm" | "explicit" | "capability-enforcement";
  route_confidence: number | null;
  source_ref: string | null;
  routed_at: string;
  quality_score: number | null;
  outcome_updated_at: string | null;
  /** Non-null when this routing decision involved a capability-enforcement reroute. */
  redirect_reason: string | null;
}

/**
 * Per-agent routing accuracy aggregate for a rolling time window.
 * Used to surface 'which agent performs best on infrastructure tasks vs. dashboard tasks'.
 */
export interface RoutingAccuracyStat {
  agent_name: string;
  task_type: string;
  total_routed: number;
  scored: number;
  avg_quality_score: number | null;
}

/**
 * A single cell in the routing accuracy drill-down matrix.
 * One row per (task_type × agent_chosen) combination.
 */
export interface RoutingDrillDownRow {
  task_type: string;
  agent_name: string;
  total_routed: number;
  scored: number;
  avg_quality_score: number | null;
  /** Mean routing confidence for this cell (null when all were explicit). */
  avg_confidence: number | null;
  /** Number of decisions made by the deterministic (rules-based) router. */
  det_count: number;
  /** Number of decisions made by the LLM fallback router. */
  llm_count: number;
  /** Number of decisions made via explicit (--agent flag) override. */
  exp_count: number;
  /**
   * The agent with the highest avg_quality_score for this task_type
   * (across the same time window).  Null when there is only one agent.
   */
  best_agent_for_type: string | null;
  /** Average quality score of the best agent for this task_type. */
  best_agent_avg_score: number | null;
  /**
   * best_agent_avg_score − avg_quality_score.
   * Positive → another agent outperforms this one on this task type.
   * Null when avg_quality_score or best_agent_avg_score is null.
   */
  score_gap: number | null;
  /**
   * True when score_gap ≥ MISROUTING_GAP_THRESHOLD (0.10) AND this agent
   * is NOT the best agent for the type — i.e. the router keeps picking a
   * sub-optimal agent when a better one is available.
   */
  misrouted: boolean;
}

/**
 * Full drill-down report returned by getRoutingAccuracyDrillDown().
 */
export interface RoutingAccuracyDrillDown {
  /** Number of calendar days in the look-back window. */
  days: number;
  /**
   * All (task_type × agent) cells with at least one routed task in the
   * window, sorted by task_type then score ascending (worst first within
   * each type so the most misrouted rows appear at the top).
   */
  rows: RoutingDrillDownRow[];
  /**
   * Task types where at least one agent is misrouted.
   * Pre-computed for quick summary display.
   */
  misrouted_task_types: string[];
}

/**
 * Per-agent health record for pool failover routing.
 * Tracks consecutive dispatch failures so the dispatcher can route around
 * unhealthy pool instances without waiting for the supervisor to intervene.
 */
export type AgentAuthStatus = "ok" | "auth-degraded";

export interface AgentHealth {
  agent_name: string;
  consecutive_failures: number;
  last_error_at: string | null;
  last_error_message: string | null;
  last_success_at: string | null;
  is_healthy: boolean;
  /** Auth status: "ok" means fully functional, "auth-degraded" means GH_TOKEN missing/invalid. */
  auth_status: AgentAuthStatus;
  /** ISO timestamp when the agent entered auth-degraded state, or null. */
  auth_degraded_at: string | null;
}

/**
 * Unified agent reliability score (0–100) combining three key components:
 * - Crash frequency (consecutive failures)
 * - Iteration cost (avg PR revision rounds)
 * - Antibody hit rate (approval/rejection frequency)
 */
export interface AgentReliabilityScore {
  agent_name: string;
  /** Composite reliability score 0–100. Higher is better. */
  reliability_score: number;
  /** Number of consecutive failures (0 = healthy). */
  consecutive_failures: number;
  /** Average revision rounds per PR (1.0 = no revisions, 2.0+ = needs feedback). */
  avg_iteration_cost: number | null;
  /** Approval rate: approved/(approved+rejected). 0–1 scale (null = insufficient data). */
  antibody_hit_rate: number | null;
  /** Trend direction over the window: improving/stable/declining/insufficient_data. */
  trend: "improving" | "stable" | "declining" | "insufficient_data";
}

/**
 * Daily reliability score snapshot for trend charting (sparkline).
 */
export interface DailyReliabilityScore {
  /** ISO date string: 'YYYY-MM-DD'. */
  date: string;
  agent_name: string;
  /** Reliability score for that day (0–100). */
  reliability_score: number;
}

// ── Stigmergy signals ─────────────────────────────────────────────────────────

/**
 * A stigmergy signal written by an agent into the shared state store.
 * Signals enable lightweight, decentralized cross-agent coordination — inspired
 * by biological stigmergy (ant pheromone trails).
 *
 * Any agent can write signals; any agent can read them. The daemon prunes
 * expired signals each cycle.
 */
export interface Signal {
  id: number;
  /** Which agent wrote this signal. */
  agent: string;
  /** Semantic type, e.g. 'pattern_risk', 'decision_need', 'failure_pattern'. */
  signal_type: string;
  /** Discriminator key within the type, e.g. 'auth-schema-change'. */
  key: string;
  /** Optional JSON payload with additional details. */
  value: string | null;
  /** Which repo this signal applies to, or null for fleet-wide. */
  repo: string | null;
  /** Optional file glob this signal applies to, e.g. 'src/auth/**'. */
  file_glob: string | null;
  /** Confidence score 0–1. */
  confidence: number;
  /** Signals expire after this many hours (default 168 = 7 days). */
  ttl_hours: number;
  /** ISO timestamp when the signal was created. */
  created_at: string;
  /** ISO timestamp when the signal expires (generated column). */
  expires_at: string;
}

export interface WriteSignalParams {
  agent: string;
  signal_type: string;
  key: string;
  value?: unknown;
  repo?: string;
  file_glob?: string;
  confidence?: number;
  ttl_hours?: number;
}

// ── Learned Patterns (immune system / anti-pattern registry) ─────────────────

/**
 * A persistent anti-pattern record extracted from verification failures, PR
 * rejections, and manual seeds.  Unlike `learned_rules` (per-repo conventions
 * from PR feedback) and `signals` (ephemeral pheromones), `learned_patterns`
 * are long-lived, fleet-wide immune memories injected into LLM review prompts
 * to prevent known failures from recurring.
 */
export interface LearnedPattern {
  id: number;
  /** Semantic category. */
  pattern_type: "anti_pattern" | "bug" | "security" | "architecture" | "workflow";
  /** Short human-readable title. */
  title: string;
  /** Full description of the pattern and why it's harmful. */
  description: string;
  /** How this pattern was discovered. */
  source: "verification_failure" | "pr_rejection" | "manual" | "blue_sky_seed";
  /** Source task/issue/PR reference (optional). */
  source_ref: string | null;
  /** Agent that first encountered this pattern. */
  agent: string | null;
  /** JSON-encoded string array of repos this applies to, or null = all repos. */
  repos: string | null;
  /** Confidence 0–1; increases each time the pattern prevents a failure. */
  confidence: number;
  /** Number of times this pattern was injected into a review prompt. */
  hit_count: number;
  /** Times the review passed on the first try after this pattern was injected. */
  first_pass_saves: number;
  /** Whether this pattern is active (1) or retired (0). */
  active: number;
  created_at: string;
  updated_at: string;
  /** Set by dashboard when operator suppresses a pattern. */
  suppressed_at: string | null;
  /** Set by dashboard when operator promotes a pattern. */
  promoted_at: string | null;
}

export interface WriteLearnedPatternParams {
  pattern_type: LearnedPattern["pattern_type"];
  title: string;
  description: string;
  source: LearnedPattern["source"];
  source_ref?: string;
  agent?: string;
  repos?: string[];
  confidence?: number;
}

// ── Antibody Log ─────────────────────────────────────────────────────────────

/**
 * A structured summary of a PR diff's shape — file count, size, languages, and
 * which areas of the codebase were touched.  Stored as JSON in antibody_log so
 * that pattern-matching queries can group entries by similarity.
 */
export interface DiffShape {
  /** Total number of files changed. */
  files_changed: number;
  /** Raw diff size in bytes. */
  diff_size_bytes: number;
  /** File extensions present in the diff (e.g. [".ts", ".json"]). */
  extensions: string[];
  /** Top-level source directories touched (e.g. ["src/state", "src/orchestrator"]). */
  directories: string[];
  /** Whether the diff touches schema/migration files. */
  touches_schema: boolean;
  /** Whether the diff touches test files. */
  touches_tests: boolean;
}

/**
 * A single antibody log entry — one record per reviewer decision, capturing
 * the diff shape, the decision, and (later) the outcome after merge.
 */
export interface AntibodyLogEntry {
  id: number;
  /** GitHub repo slug, e.g. "rapartlu/agent-orchestrator". */
  repo: string;
  pr_number: number;
  /** JSON-serialised DiffShape. */
  diff_shape: string;
  /** Reviewer decision at time of review. */
  decision: "approve" | "request-changes" | "escalate";
  /**
   * Post-merge outcome filled in later.  null = pending.
   * "clean" = no regressions; "regression" = downstream failure detected.
   */
  outcome: "clean" | "regression" | null;
  /** Optional LLM reason / rationale for the decision. */
  reason: string | null;
  /** Agent that authored the PR (if known). */
  agent: string | null;
  /** ISO timestamp of the review decision. */
  timestamp: string;
  /** 1 = operator has marked this entry as a false positive, 0 = genuine signal. */
  false_positive: number;
}

/**
 * Accuracy metrics for the antibody pre-dispatch filter over a rolling window.
 */
export interface AntibodyFilterAccuracy {
  /** Number of days in the measurement window. */
  window_days: number;
  /** Total number of tasks that were flagged by the antibody filter. */
  total_flagged: number;
  /** Flagged tasks that later failed or were escalated (correctly predicted risky). */
  true_positives: number;
  /** Flagged tasks that completed successfully (filter over-fired). */
  false_positives: number;
  /** Antibody log entries explicitly marked as false positives by an operator. */
  operator_overrides: number;
  /** Precision = TP / (TP + FP), or null when no resolved tasks yet. */
  precision: number | null;
}

export interface WriteAntibodyLogParams {
  repo: string;
  pr_number: number;
  diff_shape: DiffShape;
  decision: AntibodyLogEntry["decision"];
  reason?: string;
  agent?: string;
}

// ── Semantic Memory Effectiveness (issue #1016) ─────────────────────────────

export interface SemanticMemoryCohortStats {
  total_tasks: number;
  first_pass_approved: number;
  first_pass_rate: number | null;
  avg_quality_score: number | null;
  avg_revision_count: number | null;
  revision_distribution: { zero: number; one: number; two_plus: number };
}

export interface SemanticMemoryWeeklyCohort {
  week_start: string;
  matched: SemanticMemoryCohortStats;
  unmatched: SemanticMemoryCohortStats;
}

export interface SemanticMemoryEffectivenessResult {
  window_start: string;
  generated_at: string;
  total_dispatches: number;
  memory_hit_count: number;
  memory_hit_rate: number | null;
  matched: SemanticMemoryCohortStats;
  unmatched: SemanticMemoryCohortStats;
  /** Improvement delta: matched.first_pass_rate - unmatched.first_pass_rate */
  improvement_delta: number | null;
  /** Whether the ≥15% improvement target from issue #1011 is met. */
  meets_target: boolean | null;
  weekly: SemanticMemoryWeeklyCohort[];
}

// ── Semantic Memory Auto-tuning (issue #1029) ─────────────────────────────────

/**
 * Recommendation produced by the auto-tune algorithm.
 * The daemon applies this every audit cycle when enough data is available.
 */
export interface SemanticMemoryAutoTuneResult {
  current_threshold: number;
  recommended_threshold: number;
  /** Direction of the recommended change. */
  action: "lower" | "raise" | "keep";
  reason: string;
  basis: {
    hit_rate: number | null;
    improvement_delta: number | null;
    matched_tasks: number;
    unmatched_tasks: number;
  };
}

/**
 * Aggregate statistics about FTS5 query quality over a time window.
 * Used to surface noisy query patterns that consistently produce zero matches.
 */
export interface SemanticMemoryQueryStats {
  window_start: string;
  generated_at: string;
  total_queries: number;
  zero_match_queries: number;
  zero_match_rate: number | null;
  avg_matches_returned: number | null;
  /** Most common FTS5 query term sets that returned zero results. */
  top_empty_patterns: Array<{ query_sample: string; count: number }>;
}

/**
 * Per-agent effectiveness breakdown.
 * Allows identifying which agents benefit most from semantic memory and
 * whether agent-specific threshold adjustments are warranted.
 */
export interface PerAgentSemanticMemoryStats {
  agent_name: string;
  total_dispatches: number;
  memory_hit_count: number;
  memory_hit_rate: number | null;
  matched: SemanticMemoryCohortStats;
  unmatched: SemanticMemoryCohortStats;
  improvement_delta: number | null;
  /** Tuning recommendation specific to this agent. */
  recommended_threshold_adjustment: "lower" | "raise" | "keep" | "insufficient_data";
}

export interface ReadSignalsFilter {
  signal_type?: string;
  repo?: string;
  file_glob?: string;
  limit?: number;
  /**
   * When set, each signal returned is recorded as a consumption event in
   * `signal_reads`, enabling the activity feed to show cross-agent influence.
   */
  reader_agent?: string;
  /** Optional context string to attach to the read event (e.g. task ID). */
  reader_context?: string;
}

/**
 * A record of an agent consuming (reading) a stigmergy signal.
 * Stored in `signal_reads` to power the activity feed timeline.
 */
export interface SignalRead {
  id: number;
  /** FK → signals.id */
  signal_id: number;
  /** Which agent read the signal. */
  reader: string;
  /** Optional context (e.g. task ID, issue ref). */
  context: string | null;
  /** ISO timestamp when the signal was read. */
  read_at: string;
}

/**
 * A unified event in the stigmergy activity feed, covering both writes and reads.
 * Used by `getSignalActivityFeed()` to produce a chronological timeline.
 */
export interface SignalActivityEvent {
  /** 'write' = signal was emitted; 'read' = signal was consumed. */
  event_type: "write" | "read";
  /** ISO timestamp of the event. */
  at: string;
  /** Agent that emitted or consumed the signal. */
  agent: string;
  /** FK to the signals table. */
  signal_id: number;
  signal_type: string;
  key: string;
  repo: string | null;
  confidence: number;
  /** Raw JSON value payload (if any). */
  value: string | null;
  /** Only present for read events: optional context string. */
  context: string | null;
}

// ── Dispatch Block tracking (issue #976) ─────────────────────────────────────

/**
 * A single dispatch block event — recorded each time the pre-dispatch guard
 * prevents a dispatch because an open or approved PR already exists for the issue.
 */
export interface DispatchBlock {
  id: number;
  /** Issue source ref, e.g. "rapartlu/agent-orchestrator#976" */
  source_ref: string;
  /** Agent the dispatch would have gone to */
  agent_name: string | null;
  /** Human-readable reason for the block */
  reason: string;
  /** Machine-readable block code, e.g. "open_pr_exists" | "approved_pr_waiting" */
  block_code: string;
  /** Number of the PR that caused the block */
  blocking_pr_number: number | null;
  /** ISO timestamp when the block was recorded */
  timestamp: string;
}

/** Per-day dispatch block rate metrics */
export interface DispatchBlockDay {
  /** ISO date string: 'YYYY-MM-DD' */
  date: string;
  /** Number of dispatches blocked due to already-in-review guard */
  blocked: number;
  /** Total dispatch attempts that day (blocked + actual) */
  total: number;
  /** Block rate as a percentage (0–100), null if no attempts */
  block_rate_pct: number | null;
}

/**
 * Aggregated dispatch block metrics over a rolling N-day window.
 * Surfaces how many dispatches were wasted because an open PR already existed.
 */
export interface DispatchBlockMetrics {
  /** Rolling window in days */
  days: number;
  /** Per-day breakdown */
  daily: DispatchBlockDay[];
  /** Total blocks in the window */
  total_blocked: number;
  /** Total dispatches (blocked + actual) in the window */
  total_dispatches: number;
  /** Average block rate (0–100), null if no data */
  avg_block_rate_pct: number | null;
  /** Linear trend: "improving" | "worsening" | "stable" | "insufficient_data" */
  trend: "improving" | "worsening" | "stable" | "insufficient_data";
}

/**
 * Breakdown of dispatch blocks by PR detection strategy (issue #1179).
 * Covers the rolling N-day window requested by the operator.
 */
export interface PRDetectionStrategyBreakdown {
  /** Rolling window in days */
  days: number;
  /** Blocks detected by GitHub's server-side search index */
  search_index: number;
  /** Blocks detected by branch-name pattern in the REST paginated fallback */
  branch_name: number;
  /** Blocks detected by closing keyword in PR body (cross-variant dedup, issue #1174) */
  body_keyword: number;
  /** Blocks recorded before strategy tracking was added (no strategy stored) */
  unknown: number;
  /** Total blocks across all strategies */
  total: number;
}

export interface VerificationCalibrationRecommendationRow {
  id: number;
  verifier_agent: string;
  current_threshold: number;
  suggested_threshold: number;
  confidence: number;
  task_count: number;
  merge_rate: number;
  changes_requested_count: number;
  reason: string;
  status: "pending" | "applied" | "skipped";
  generated_at: string;
  applied_at: string | null;
  review_notes: string | null;
}

// ── External-impact ratio types ───────────────────────────────────────────────

/**
 * One day's breakdown for the external-impact ratio metric.
 */
export interface ExternalImpactDay {
  /** UTC date string (YYYY-MM-DD). */
  date: string;
  /** Tasks with external-facing source_ref on this day. */
  external: number;
  /** Internal-only tasks on this day (fleet infra work). */
  internal: number;
  /** external / (external + internal) * 100, or null when total = 0. */
  ratio_pct: number | null;
}

/**
 * Result returned by `StateStore.getExternalImpactRatio()`.
 *
 * "External" tasks are tasks whose `source_ref` links to a repo outside the
 * fleet's own infrastructure repositories (i.e. repos NOT matching
 * `rapartlu/agent-*`).  Internal tasks have no source_ref, or link to the
 * fleet's own repos.
 *
 * The 7-day ratio falling below 30% is the trigger condition for a Telegram
 * alert (anti-navel-gazing layer 1, re-implemented from issue #1262).
 */
export interface ExternalImpactRatioResult {
  /** Rolling window in days. */
  days: number;
  /** Total root tasks created in the window. */
  total_tasks: number;
  /** Tasks classified as external-impact in the window. */
  external_tasks: number;
  /** Tasks classified as internal-only in the window. */
  internal_tasks: number;
  /**
   * external_tasks / total_tasks * 100, or null when total_tasks = 0.
   * Alert threshold: < 30 for 7-day window.
   */
  ratio_pct: number | null;
  /** True when ratio_pct < 30 and total_tasks > 0 (alert threshold crossed). */
  alert: boolean;
  /** Per-day breakdown for sparkline rendering, oldest-first. */
  daily: ExternalImpactDay[];
  /** ISO timestamp when this result was computed. */
  generated_at: string;
}

/**
 * SQL WHERE clauses that exclude infrastructure/transient failures from
 * retry-budget counts.  Centralised so all consumers stay in sync when
 * new patterns are discovered.  Each clause is prefixed with AND and
 * assumes `result` is in scope.
 */
const INFRA_ERROR_EXCLUSION_SQL = `
           AND (result IS NULL
             OR result NOT LIKE 'connection-error-exhausted%')
           AND (result IS NULL OR result != 'Connection error.')
           AND (result IS NULL OR result NOT LIKE 'Request timed out%')
           AND (result IS NULL OR result NOT LIKE 'Request was aborted%')
           AND (result IS NULL OR result NOT LIKE 'Timed out: dispatched%')
           AND (result IS NULL OR result NOT LIKE 'Escalated after%Connection error%')
           AND (result IS NULL OR result NOT LIKE 'Auto-cleaned:%')
           AND (result IS NULL OR result NOT LIKE 'Cleared:%')`;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  agent_name TEXT,
  conversation_id TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  direction TEXT NOT NULL,
  agent_name TEXT,
  content TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_triggers (
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  task_id TEXT REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, source_ref)
);

CREATE TABLE IF NOT EXISTS source_ref_controls (
  source TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  failure_history_cleared_at TEXT,
  failure_history_cleared_rowid INTEGER,
  priority_boosted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, source_ref)
);

CREATE TABLE IF NOT EXISTS daemon_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  agent_name TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_name);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_daemon_cycles_started ON daemon_cycles(started_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at);
CREATE INDEX IF NOT EXISTS idx_token_usage_agent_name ON token_usage(agent_name);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 1,
  participant_count INTEGER NOT NULL DEFAULT 0,
  synthesis TEXT,
  action_items_json TEXT,
  goal_adjustments_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  round_number INTEGER NOT NULL,
  prompt TEXT
);

CREATE TABLE IF NOT EXISTS meeting_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  round_number INTEGER NOT NULL,
  agent_name TEXT NOT NULL,
  provider TEXT,
  pool TEXT,
  response TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings(date DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_entries_meeting ON meeting_entries(meeting_id);
`;

export class StateStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? join(homedir(), ".claude-orchestrator", "state.db");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(MIGRATIONS);
    this.runPhase2Migration();
    this.runPhase5Migration();
    this.runPhase6Migration();
    this.runResearchMigration();
    this.runRetryMigration();
    this.runSupervisorMemoryMigration();
    this.runPRReviewsMigration();
    this.runMergeQueueMigration();
    this.runPriorityReviewQueueMigration();
    this.runDaemonStatsMigration();
    this.runPRCreationRetryMigration();
    this.runProcessedTriggersCompletedAtMigration();
    this.runSourceRefControlsMigration();
    this.runDirectivesMigration();
    this.runAgentHealthMigration();
    this.runRevisionCountMigration();
    this.runTokenUsageMigration();
    this.runTokenUsageCacheMigration();
    this.runDispatchWasteMigration();
    this.runDispatchValidationMigration();
    this.runIssueClaimsMigration();
    this.runDispatchLockMigration();
    this.runConfigReloadsMigration();
    this.runIssueCacheMigration();
    this.runLearnedRulesMigration();
    this.runConflictHeatMapMigration();
    this.runMergeConflictFileHistoryMigration();
    this.runRoutingOutcomesMigration();
    this.runStigmergySignalsMigration();
    this.runSignalReadsMigration();
    this.runLearnedPatternsMigration();
    this.runLineageMigration();
    this.runAntibodyLogMigration();
    this.runDaemonLifecycleMigration();
    this.runSecretMountStatusMigration();
    this.runSkipPatternMigration();
    this.runHealthCheckEventsMigration();
    this.runStagingValidationsMigration();
    this.runVerificationOutcomesMigration();
    this.runVerificationCalibrationMigration();
    this.runInFlightReservationsMigration();
    this.runDispatchBlocksMigration();
    this.runProactiveRebaseLogMigration();
    this.runSemanticMemoryMigration();
    this.runOperatorControlsMigration();
    this.runDagMigration();
    this.runFailureInterceptionMigration();
    this.runGuardHealthMetricsMigration();
    this.runGuardDuplicateSuppressionsMigration();
  }

  private runPhase2Migration(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("parent_task_id")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
        ALTER TABLE tasks ADD COLUMN step_id TEXT;
        ALTER TABLE tasks ADD COLUMN plan TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      `);
    }
  }

  private runPhase5Migration(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("verification_status")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN verification_status TEXT;
        ALTER TABLE tasks ADD COLUMN quality_score REAL;
        ALTER TABLE tasks ADD COLUMN verification_notes TEXT;
      `);
    }
  }

  private runPhase6Migration(): void {
    // daemon_cycles table is already created in MIGRATIONS; this is a no-op for existing DBs
    // that may have been created before the table was added to MIGRATIONS.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_cycles_started ON daemon_cycles(started_at);
    `);
  }

  private runResearchMigration(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("task_type")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'implementation';
      `);
    }
  }

  private runRetryMigration(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("retry_count")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE tasks ADD COLUMN next_retry_at TEXT;
        CREATE INDEX IF NOT EXISTS idx_tasks_retry ON tasks(next_retry_at) WHERE next_retry_at IS NOT NULL;
      `);
    }

    if (!colNames.has("reported")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN reported INTEGER NOT NULL DEFAULT 0");
    }
  }

  createTask(params: {
    title: string;
    description?: string;
    source?: TaskSource;
    source_ref?: string;
    agent_name?: string;
    task_type?: TaskType;
    parent_task_id?: string | null;
    step_id?: string | null;
    lineage_group_id?: string | null;
  }): Task {
    const now = new Date().toISOString();

    // Resolve lineage_group_id:
    // 1. Explicit value from caller (e.g. cross-repo follow-up inheriting lineage)
    // 2. Inherit from parent task (sub-tasks share parent's lineage)
    // 3. Check lineage_mappings table for pre-recorded cross-repo follow-up mappings
    // 4. Default to own id (new top-level task starts its own lineage group)
    const resolveLineageGroup = (id: string): string => {
      let lineageGroupId = params.lineage_group_id ?? null;
      if (!lineageGroupId && params.parent_task_id) {
        const parent = this.getTask(params.parent_task_id);
        lineageGroupId = parent?.lineage_group_id ?? params.parent_task_id;
      }
      if (!lineageGroupId && params.source_ref) {
        lineageGroupId = this.lookupLineageGroup(params.source_ref) ?? null;
      }
      return lineageGroupId ?? id;
    };

    // ── ULID collision detection and retry (issue #1133) ────────────────────
    // ULIDs are supposed to be globally unique, but a monotonic factory could
    // theoretically produce a duplicate if the random component wraps around
    // in a high-throughput burst. On pre-INSERT collision:
    //  1. Record to ulid_collision_log for operator audit
    //  2. Log at ERROR level
    //  3. Retry once with a fresh ULID (fixes the task silently)
    //  4. If the retry also collides, throw DuplicateTaskIdError so the caller
    //     (dispatcher) fires the Telegram alert and surfaces the incident.
    const MAX_ID_RETRIES = 1;
    let id = generateId();
    for (let attempt = 0; attempt <= MAX_ID_RETRIES; attempt++) {
      const existing = this.getTask(id);
      if (!existing) break; // ID is free — proceed

      // Record the collision
      storeLog.error("ULID collision detected at createTask", {
        event: "ulid-collision",
        task_id: id,
        existing_title: existing.title,
        new_title: params.title,
        attempt,
      });
      try {
        this.recordUlidCollision({ collidingId: id, existingTitle: existing.title, newTitle: params.title });
      } catch {
        // Non-fatal — don't let log persistence block task creation
      }

      if (attempt < MAX_ID_RETRIES) {
        // Retry with a freshly generated ID
        id = generateId();
        storeLog.warn("Retrying createTask with new ULID after collision", {
          original_id: existing.id,
          new_id: id,
        });
      } else {
        // All retries exhausted — throw so dispatcher fires Telegram alert
        throw new DuplicateTaskIdError(id, existing.title, params.title);
      }
    }

    const lineageGroupId = resolveLineageGroup(id);

    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, source, source_ref, status, agent_name, parent_task_id, step_id, task_type, lineage_group_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.run(
        id,
        params.title,
        params.description ?? null,
        params.source ?? "manual",
        params.source_ref ?? null,
        params.agent_name ?? null,
        params.parent_task_id ?? null,
        params.step_id ?? null,
        params.task_type ?? "implementation",
        lineageGroupId,
        now,
        now,
      );
    } catch (err) {
      // Catch SQLite PRIMARY KEY violations that can occur in a race between
      // the pre-check SELECT and the INSERT (extremely rare in single-process
      // daemon, but defensive).
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed: tasks.id")) {
        const conflict = this.getTask(id);
        storeLog.warn("ULID collision race-condition on INSERT", {
          event: "ulid-collision",
          task_id: id,
          existing_title: conflict?.title ?? "<unknown>",
          new_title: params.title,
        });
        try {
          this.recordUlidCollision({ collidingId: id, existingTitle: conflict?.title ?? "<unknown>", newTitle: params.title });
        } catch {
          // Non-fatal
        }
        throw new DuplicateTaskIdError(id, conflict?.title ?? "<unknown>", params.title);
      }
      throw err;
    }
    return this.getTask(id)!;
  }

  /**
   * Return task IDs that appear more than once in the tasks table.
   *
   * In a healthy database, the PRIMARY KEY constraint makes this impossible.
   * This method is exposed for dashboard and startup auditing purposes.
   *
   * @returns Array of duplicate task ID strings (empty if DB is healthy).
   */
  getDuplicateTaskIds(): string[] {
    const rows = this.db.prepare(`
      SELECT id, COUNT(*) AS cnt
      FROM tasks
      GROUP BY id
      HAVING cnt > 1
    `).all() as Array<{ id: string; cnt: number }>;
    return rows.map((r) => r.id);
  }

  getTask(id: string): Task | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
  }

  hasActiveTask(agentName: string): boolean {
    const dispatched = this.listTasks({ status: "dispatched", agent_name: agentName, limit: 1 });
    const inProgress = this.listTasks({ status: "in_progress", agent_name: agentName, limit: 1 });
    return dispatched.length > 0 || inProgress.length > 0;
  }

  /**
   * Return how long an agent has been idle in milliseconds, or null if
   * the agent has never completed a task.  "Idle" means the time elapsed
   * since the agent's most recent task reached a terminal state (done or
   * failed).
   */
  getAgentIdleSinceMs(agentName: string): number | null {
    const row = this.db
      .prepare(
        `SELECT updated_at FROM tasks
         WHERE agent_name = ? AND status IN ('done', 'failed')
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(agentName) as { updated_at: string } | undefined;
    if (!row) return null;
    return Date.now() - new Date(row.updated_at).getTime();
  }

  // ---------------------------------------------------------------------------
  // Agent-borrow tracking (issue #448)
  // A "borrowed" task is one where the assigned agent's own GitHub repo
  // (agent.github) differs from the source_ref's repo.
  // ---------------------------------------------------------------------------

  /**
   * Count active (in-flight) tasks assigned to `agentName` whose source_ref
   * belongs to a repo OTHER than `agentRepo` (the agent's own github repo).
   * Used to enforce `borrow.max_concurrent_borrowed` limits.
   */
  countActiveBorrowedTasks(agentName: string, agentRepo: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks
         WHERE agent_name = ?
           AND status IN ('pending', 'planning', 'dispatched', 'in_progress')
           AND parent_task_id IS NULL
           AND source_ref IS NOT NULL
           AND source_ref NOT LIKE ?`,
      )
      .get(agentName, `${agentRepo}#%`) as { cnt: number };
    return row.cnt;
  }

  /**
   * Return all active (in-flight) top-level tasks that are "borrowed" —
   * i.e. the assigned agent's github repo does not match the source_ref repo.
   *
   * @param agentRepoMap  A map from agent_name → agent's github repo string,
   *                      used to detect mismatches without loading config here.
   */
  getActiveBorrowedTasks(agentRepoMap: Map<string, string>): Task[] {
    const active = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('pending', 'planning', 'dispatched', 'in_progress')
           AND parent_task_id IS NULL
           AND source_ref IS NOT NULL
           AND agent_name IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all() as Task[];

    return active.filter((t) => {
      const agentRepo = t.agent_name ? agentRepoMap.get(t.agent_name) : undefined;
      if (!agentRepo) return false; // agent has no github repo — skip
      const taskRepo = t.source_ref!.split("#")[0];
      return taskRepo !== agentRepo;
    });
  }

  /**
   * Returns true if there is already a pending/dispatched/in-progress
   * "pr-feedback" task for the given repo + PR number.  Used to prevent
   * the daemon from queuing duplicate feedback dispatches for the same PR
   * within a single review cycle window.
   */
  hasActivePrFeedbackTask(repo: string, prNumber: number | string): boolean {
    const sourceRef = `${repo}#${prNumber}`;
    const row = this.db
      .prepare(
        `SELECT 1 FROM tasks
         WHERE source = 'pr-feedback'
           AND source_ref = ?
           AND status IN ('pending', 'dispatched', 'in_progress')
         LIMIT 1`,
      )
      .get(sourceRef);
    return !!row;
  }

  listTasks(filters?: { status?: TaskStatus; agent_name?: string; task_type?: TaskType; limit?: number }): Task[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.agent_name) {
      sql += " AND agent_name = ?";
      params.push(filters.agent_name);
    }
    if (filters?.task_type) {
      sql += " AND task_type = ?";
      params.push(filters.task_type);
    }

    sql += " ORDER BY created_at DESC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
    }

    return this.db.prepare(sql).all(...params) as Task[];
  }

  createSubTask(params: {
    parent_task_id: string;
    step_id: string;
    title: string;
    description: string;
    source: TaskSource;
    agent_name: string;
  }): Task {
    return this.createTask({
      title: params.title,
      description: params.description,
      source: params.source,
      agent_name: params.agent_name,
      parent_task_id: params.parent_task_id,
      step_id: params.step_id,
    });
  }

  getSubTasks(parentTaskId: string): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC").all(parentTaskId) as Task[];
  }

  /**
   * Check whether any pr-feedback task exists for the given source_ref that was
   * created after the specified ISO timestamp.  Used by the duplicate guard to
   * determine if new review feedback has arrived since the last verified-approved
   * task completed — if not, re-dispatching the same issue would be a no-op
   * (see issue #387).
   */
  hasPrFeedbackSince(sourceRef: string, sinceIso: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM tasks
         WHERE source = 'pr-feedback'
           AND source_ref = ?
           AND created_at > ?
         LIMIT 1`,
      )
      .get(sourceRef, sinceIso);
    return !!row;
  }

  /**
   * Return all pr-feedback tasks for a given source_ref (e.g. "owner/repo#42"),
   * ordered chronologically (oldest first).  Used by `orch status` to show the
   * full feedback-cycle history for a PR.
   */
  getPrFeedbackHistory(sourceRef: string): Task[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE source = 'pr-feedback' AND source_ref = ? ORDER BY created_at ASC",
      )
      .all(sourceRef) as Task[];
  }

  /**
   * Count the total number of pr-feedback tasks dispatched for a given repo + PR number,
   * regardless of their current status.  Used to enforce the feedback ceiling: after
   * PR_FEEDBACK_CEILING rounds the daemon stops dispatching and escalates to a human.
   *
   * Counts ALL statuses (pending, dispatched, in_progress, done, failed) so that even
   * in-flight feedback tasks are included in the ceiling calculation — we want to count
   * rounds dispatched, not rounds completed.
   */
  countPrFeedbackRounds(repo: string, prNumber: number | string): number {
    const sourceRef = `${repo}#${prNumber}`;
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM tasks WHERE source = 'pr-feedback' AND source_ref = ?")
      .get(sourceRef) as { cnt: number };
    return row?.cnt ?? 0;
  }

  /**
   * Mark all active pr-feedback tasks for a given repo + PR number as 'escalated'.
   * Called when the feedback ceiling is hit so that `orch status` shows a clear
   * 'escalated' status instead of leaving tasks in 'pending' or 'dispatched'.
   *
   * Only transitions tasks that are still in-flight (pending, dispatched,
   * in_progress) — tasks that have already finished (done, failed) are left
   * untouched to preserve the historical record.
   */
  markPrFeedbackTasksEscalated(repo: string, prNumber: number | string): number {
    const sourceRef = `${repo}#${prNumber}`;
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'escalated', updated_at = ?
         WHERE source = 'pr-feedback' AND source_ref = ?
         AND status IN ('pending', 'dispatched', 'in_progress')`,
      )
      .run(now, sourceRef);
    return result.changes;
  }

  /**
   * Return the most-recently-created top-level task whose source and
   * source_ref match exactly. Used by the duplicate-guard to detect
   * in-flight or recently-completed tasks that survive daemon restarts.
   */
  findTaskBySourceRef(source: string, sourceRef: string): Task | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE source = ? AND source_ref = ? AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT 1",
      )
      .get(source, sourceRef) as Task | undefined;
  }

  /**
   * Return the most recent top-level task for a source_ref, excluding attempts
   * that were explicitly cleared by an operator reroute.
   */
  findDispatchCandidateBySourceRef(source: string, sourceRef: string): Task | undefined {
    const clearedRowid = this.getFailureHistoryClearedRowid(source, sourceRef);
    if (clearedRowid === null) {
      return this.findTaskBySourceRef(source, sourceRef);
    }
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE source = ? AND source_ref = ? AND parent_task_id IS NULL AND rowid > ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(source, sourceRef, clearedRowid) as Task | undefined;
  }


  /**
   * Count all top-level tasks for (source, sourceRef) that are in a terminal
   * failure state ("failed" or "escalated").  Used by the dispatcher to decide
   * when a source_ref has exceeded the configured auto-escalation threshold.
   */
  countFailedTasksForSourceRef(source: string, sourceRef: string): number {
    const clearedRowid = this.getFailureHistoryClearedRowid(source, sourceRef);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM tasks
         WHERE source = ? AND source_ref = ?
           AND parent_task_id IS NULL
           AND status IN ('failed', 'escalated')
           AND (? IS NULL OR rowid > ?)`,
      )
      .get(source, sourceRef, clearedRowid, clearedRowid) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  updateTask(id: string, updates: Partial<Pick<Task, "status" | "agent_name" | "conversation_id" | "result" | "plan" | "verification_status" | "quality_score" | "verification_notes" | "retry_count" | "next_retry_at" | "revision_count">>): Task | undefined {
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (fields.length === 0) return this.getTask(id);

    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(id);

    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    return this.getTask(id);
  }

  /**
   * Convenience wrapper — update only the status of a task.
   * Equivalent to `updateTask(id, { status })`.
   */
  updateTaskStatus(id: string, status: Task["status"]): Task | undefined {
    return this.updateTask(id, { status });
  }

  addLog(params: {
    task_id: string;
    direction: TaskLog["direction"];
    agent_name?: string;
    content: string;
    tokens_in?: number;
    tokens_out?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO task_logs (task_id, direction, agent_name, content, tokens_in, tokens_out, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.task_id,
      params.direction,
      params.agent_name ?? null,
      params.content,
      params.tokens_in ?? null,
      params.tokens_out ?? null,
      new Date().toISOString(),
    );
  }

  getLogs(taskId: string): TaskLog[] {
    return this.db.prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as TaskLog[];
  }

  isProcessed(source: string, sourceRef: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM processed_triggers WHERE source = ? AND source_ref = ?").get(source, sourceRef);
    return !!row;
  }

  markProcessed(source: string, sourceRef: string, taskId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO processed_triggers (source, source_ref, task_id, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(source, sourceRef, taskId, now, now);
  }

  /**
   * Return the processed-trigger record for a given source + source_ref, or
   * undefined if no such record exists.  Used by `orch status --source-ref` to
   * surface dedup information alongside task history.
   */
  getProcessedTriggerInfo(source: string, sourceRef: string): {
    source: string;
    source_ref: string;
    task_id: string | null;
    created_at: string;
    completed_at: string | null;
  } | undefined {
    return this.db
      .prepare(
        "SELECT * FROM processed_triggers WHERE source = ? AND source_ref = ?",
      )
      .get(source, sourceRef) as
      | {
          source: string;
          source_ref: string;
          task_id: string | null;
          created_at: string;
          completed_at: string | null;
        }
      | undefined;
  }

  /**
   * Remove the processed-trigger record for a given source + source_ref.
   * Used by `orch deescalate` to allow the daemon to re-dispatch the trigger
   * on its next poll cycle.  Returns true if a record was actually deleted.
   */
  removeProcessedTrigger(source: string, sourceRef: string): boolean {
    const result = this.db
      .prepare("DELETE FROM processed_triggers WHERE source = ? AND source_ref = ?")
      .run(source, sourceRef);
    return result.changes > 0;
  }

  /**
   * Find the most-recent escalated top-level task for a given source_ref
   * (across all sources).  Used by `orch deescalate` to locate the task to
   * reset.
   */
  findEscalatedTask(sourceRef: string): Task | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE source_ref = ? AND parent_task_id IS NULL AND status = 'escalated'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceRef) as Task | undefined;
  }

  /**
   * Find an active (in-flight) incident task for a given source_ref.
   * Returns the most recent task that has not been completed or permanently failed.
   * "Active" means: status is one of pending, planning, dispatched, in_progress, or escalated.
   */
  findActiveIncidentTask(sourceRef: string): Task | undefined {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE source_ref = ? AND parent_task_id IS NULL
         AND status IN ('pending', 'planning', 'dispatched', 'in_progress', 'escalated')
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sourceRef) as Task | undefined;
  }

  /** Return all top-level tasks with a given status. */
  getTasksByStatus(status: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = ? AND parent_task_id IS NULL
         ORDER BY created_at DESC`,
      )
      .all(status) as Task[];
  }

  /**
   * Return all currently escalated top-level tasks, most recent first.
   * Used by `orch status` to surface escalated tasks with de-escalation hints.
   */
  findAllEscalatedTasks(): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'escalated' AND parent_task_id IS NULL
         ORDER BY updated_at DESC`,
      )
      .all() as Task[];
  }

  /**
   * Return all top-level tasks whose source_ref exactly matches the given
   * value, across all sources.  Used by `orch status --source-ref` to show
   * the full dispatch history for a GitHub issue or similar trigger.
   */
  findAllTasksBySourceRef(sourceRef: string): Task[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE source_ref = ? AND parent_task_id IS NULL ORDER BY rowid DESC",
      )
      .all(sourceRef) as Task[];
  }

  /**
   * Count the total number of failed dispatch attempts recorded for a given
   * source_ref across ALL top-level task records.
   *
   * Each task record tracks its own `retry_count` (number of retries that
   * were attempted after the initial dispatch).  Adding 1 per task converts
   * that into the number of actual attempts made for that record, so the sum
   * gives the grand total of failed attempts across the full lifetime of the
   * trigger, including across daemon restarts or re-dispatches.
   *
   * Statuses counted: 'failed' and 'escalated' (both represent unsuccessful
   * attempts).  Pending / dispatched / in-progress / done tasks are excluded
   * because they haven't definitively failed yet.
   *
   * Infrastructure failures are excluded because they represent proxy outages,
   * spawn failures, or network timeouts — not genuine task failures.  Counting
   * them toward the escalation limit caused premature blocking of viable tasks.
   *
   * Excluded patterns: connection-error-exhausted*, Connection error.,
   * Request timed out*, Request was aborted*, Timed out: dispatched*,
   * Escalated after*Connection error*, Auto-cleaned:*, Cleared:*
   */
  countFailuresForSourceRef(sourceRef: string): number {
    const clearedRowid = this.getFailureHistoryClearedRowid("github", sourceRef);
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(retry_count + 1), 0) AS total
         FROM tasks
         WHERE source_ref = ?
           AND parent_task_id IS NULL
           AND status IN ('failed', 'escalated')
           AND (? IS NULL OR rowid > ?)
           ${INFRA_ERROR_EXCLUSION_SQL}`,
      )
      .get(sourceRef, clearedRowid, clearedRowid) as { total: number };
    return row?.total ?? 0;
  }

  /**
   * Count failed attempts for a specific source_ref by a specific agent.
   *
   * Uses the same attempt semantics and infrastructure-error exclusion as
   * countFailuresForSourceRef(), but narrows the history to one agent so the
   * dispatcher can detect repeated issue-specific failures and reroute.
   */
  countFailuresForSourceRefByAgent(sourceRef: string, agentName: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(retry_count + 1), 0) AS total
         FROM tasks
         WHERE source_ref = ?
           AND agent_name = ?
           AND parent_task_id IS NULL
           AND status IN ('failed', 'escalated')
           ${INFRA_ERROR_EXCLUSION_SQL}`,
      )
      .get(sourceRef, agentName) as { total: number };
    return row?.total ?? 0;
  }

  /**
   * Return per-agent success rates for a specific task type.
   *
   * Only terminal top-level tasks count toward the sample: done, failed,
   * escalated. Agents with no terminal history for the task type return null.
   */
  getTaskTypeSuccessRates(taskType: TaskType, agentNames?: string[]): AgentTaskTypeSuccessRate[] {
    const names =
      agentNames ??
      (
        this.db
          .prepare(
            `SELECT DISTINCT agent_name
             FROM tasks
             WHERE agent_name IS NOT NULL AND parent_task_id IS NULL`,
          )
          .all() as Array<{ agent_name: string }>
      ).map((r) => r.agent_name);

    return names.map((agentName) => {
      const row = this.db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
           FROM tasks
           WHERE agent_name = ?
             AND task_type = ?
             AND parent_task_id IS NULL
             AND status IN ('done', 'failed', 'escalated')`,
        )
        .get(agentName, taskType) as { total: number; done: number };

      const total = row?.total ?? 0;
      const done = row?.done ?? 0;
      return {
        agent_name: agentName,
        task_type: taskType,
        total,
        done,
        success_rate: total > 0 ? done / total : null,
      };
    });
  }

  /**
   * Return prior task attempts for a given source_ref that have completed,
   * failed, or been rejected. Used to inject rejection history into retry
   * dispatch prompts so agents avoid repeating failed approaches.
   */
  getPriorAttempts(sourceRef: string): Array<{
    id: string;
    result: string | null;
    verification_status: string | null;
    quality_score: number | null;
    verification_notes: string | null;
    created_at: string;
  }> {
    const clearedRowid = this.getFailureHistoryClearedRowid("github", sourceRef);
    return this.db
      .prepare(
        `SELECT id, result, verification_status, quality_score, verification_notes, created_at
         FROM tasks
         WHERE source_ref = ?
           AND parent_task_id IS NULL
           AND (? IS NULL OR rowid > ?)
           AND (status IN ('done', 'failed', 'escalated') OR verification_status = 'rejected')
         ORDER BY created_at ASC`,
      )
      .all(sourceRef, clearedRowid, clearedRowid) as Array<{
      id: string;
      result: string | null;
      verification_status: string | null;
      quality_score: number | null;
      verification_notes: string | null;
      created_at: string;
    }>;
  }

  /**
   * Count the most recent consecutive verifier rejections for a source_ref by
   * the same agent. Stops at the first non-rejected attempt or agent switch.
   */
  countConsecutiveRejectionsForSourceRef(sourceRef: string, agentName: string): number {
    const clearedRowid = this.getFailureHistoryClearedRowid("github", sourceRef);
    const rows = this.db
      .prepare(
        `SELECT agent_name, verification_status
         FROM tasks
         WHERE source_ref = ?
           AND parent_task_id IS NULL
           AND (? IS NULL OR rowid > ?)
         ORDER BY rowid DESC`,
      )
      .all(sourceRef, clearedRowid, clearedRowid) as Array<{
      agent_name: string | null;
      verification_status: VerificationStatus;
    }>;

    let count = 0;
    for (const row of rows) {
      if (row.agent_name !== agentName || row.verification_status !== "rejected") {
        break;
      }
      count++;
    }
    return count;
  }

  getRecentActivity(limit = 50): TaskLog[] {
    return this.db.prepare(
      "SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as TaskLog[];
  }

  /**
   * Find the most recent task for a given GitHub issue, matched by source_ref
   * which is stored as "{repo}#{issueNumber}" for GitHub-sourced tasks.
   * Returns undefined when no matching task exists.
   */
  findTaskByIssueRef(repo: string, issueNumber: string): Task | undefined {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE source = 'github' AND source_ref = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(`${repo}#${issueNumber}`) as Task | undefined;
  }

  getRecentCompleted(limit = 20): Task[] {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'done' AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Task[];
  }

  /**
   * Return recently completed top-level tasks that are high-quality:
   * either explicitly approved by the verifier OR have a quality score
   * at or above `minScore`. Low-quality and rejected tasks are excluded
   * so they don't pollute improvement-detection signal.
   */
  getRecentVerified(limit = 20, minScore = 0.7): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'done'
        AND parent_task_id IS NULL
        AND (
          verification_status = 'approved'
          OR (quality_score IS NOT NULL AND quality_score >= ?)
        )
      ORDER BY created_at DESC
      LIMIT ?
    `).all(minScore, limit) as Task[];
  }

  /**
   * Return recent approved research tasks with their full results.
   * Used by the supervisor to include research findings in its decision context
   * (issue #428).
   *
   * Only returns tasks where:
   *   - task_type = 'research'
   *   - verification_status = 'approved'
   *   - quality_score >= minScore
   *   - result is not null (findings exist)
   */
  getApprovedResearchFindings(limit = 5, minScore = 0.8): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE task_type = 'research'
        AND verification_status = 'approved'
        AND quality_score IS NOT NULL
        AND quality_score >= ?
        AND result IS NOT NULL
        AND parent_task_id IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(minScore, limit) as Task[];
  }

  /**
   * Return recent health incident tasks (escalated research tasks from failed health checks).
   * Used by the health incident detector to extract root cause patterns and file improvement issues.
   *
   * Queries for tasks where:
   *   - status = 'done' (completed incidents)
   *   - task_type = 'research' (escalated for investigation)
   *   - source_ref LIKE 'health-check-fail:%' (from health check failure)
   *   - updated_at within the last N hours
   */
  getRecentHealthIncidents(hours = 24, limit = 50): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('done', 'escalated')
        AND task_type = 'research'
        AND source = 'manual'
        AND source_ref LIKE 'health-check-fail:%'
        AND updated_at >= datetime('now', ? || ' hours')
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(`-${hours}`, limit) as Task[];
  }

  /**
   * Check whether a research task has been analyzed by the research linker and
   * had implementation issues filed from it.
   *
   * Returns true if a task with source_ref = 'research-link:{researchTaskId}'
   * exists (the linker creates one as a bookkeeping record).
   */
  isResearchLinked(researchTaskId: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE source_ref = ? LIMIT 1",
      )
      .get(`research-link:${researchTaskId}`);
    return row !== undefined;
  }

  /**
   * Return a paginated feed of research investigation tasks for dashboard display.
   *
   * Excludes internal bookkeeping tasks created by the research linker
   * (source_ref LIKE 'research-link:%') and health-check incident tasks
   * (source_ref LIKE 'health-check-fail:%') so only user-visible investigations
   * appear in the feed.
   *
   * @param limit   Max rows to return (capped at 100).
   * @param offset  Pagination offset.
   * @param status  Optional status filter; omit to return all statuses.
   */
  getInvestigationFeed(
    limit = 20,
    offset = 0,
    status?: string,
  ): { total: number; items: Task[] } {
    const cap = Math.min(limit, 100);
    const statusClause = status ? "AND status = ?" : "";
    const params: (string | number)[] = [];
    if (status) params.push(status);
    params.push(cap, offset);

    const items = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE task_type = 'research'
           AND (source_ref IS NULL
                OR (source_ref NOT LIKE 'research-link:%'
                    AND source_ref NOT LIKE 'health-check-fail:%'))
           AND parent_task_id IS NULL
           ${statusClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params) as Task[];

    const countParams: string[] = [];
    if (status) countParams.push(status);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE task_type = 'research'
             AND (source_ref IS NULL
                  OR (source_ref NOT LIKE 'research-link:%'
                      AND source_ref NOT LIKE 'health-check-fail:%'))
             AND parent_task_id IS NULL
             ${statusClause}`,
        )
        .get(...countParams) as { n: number }
    ).n;

    return { total, items };
  }

  /**
   * Return failed tasks that are eligible for retry: their `next_retry_at` has
   * elapsed and they haven't yet reached `maxRetries` attempts.
   * Results are ordered by `next_retry_at` ascending (oldest due first).
   */
  getRetryableTasks(maxRetries: number): Task[] {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('failed', 'result_missing')
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= ?
        AND retry_count < ?
      ORDER BY next_retry_at ASC
    `).all(now, maxRetries) as Task[];
  }

  getUnverified(limit = 10): Task[] {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'done' AND verification_status IS NULL AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Task[];
  }

  /** Count all done top-level tasks with no verification result yet. */
  countUnverified(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as count FROM tasks WHERE status = 'done' AND verification_status IS NULL AND parent_task_id IS NULL",
    ).get() as { count: number };
    return row.count;
  }

  /**
   * Return top-level tasks that completed ('done') but wrote no result back to
   * the database and are older than `thresholdMs` milliseconds.  These are
   * silent-failure candidates: the agent finished without recording any output,
   * leaving the source issue in limbo.
   *
   * A task qualifies when ALL of the following hold:
   *   - status = 'done'
   *   - result IS NULL or empty string
   *   - quality_score IS NULL  (verification never ran — nothing to score)
   *   - verification_status IS NULL
   *   - parent_task_id IS NULL (top-level tasks only)
   *   - created_at is older than thresholdMs
   */
  getResultMissingCandidates(thresholdMs: number, limit = 20): Task[] {
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'done'
        AND (result IS NULL OR result = '')
        AND quality_score IS NULL
        AND verification_status IS NULL
        AND parent_task_id IS NULL
        AND created_at <= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(cutoff, limit) as Task[];
  }

  /**
   * Get routing mismatches: tasks where the executed agent doesn't match
   * the intended agent (extracted from task title [agent-name] prefix).
   *
   * Used by issue #861 to identify systematic routing errors.
   *
   * @param config OrchestratorConfig for agent validation
   * @param options Query options: days (default 30), intendedAgent, actualAgent, limit (default 100)
   * @returns Array of task data for mismatched tasks
   */
  getRoutingMismatches(
    config: OrchestratorConfig,
    options?: {
      days?: number;
      intendedAgent?: string;
      actualAgent?: string;
      limit?: number;
    },
  ): Array<{
    taskId: string;
    taskTitle: string;
    intendedAgent: string | null;
    actualAgent: string | null;
    qualityScore: number | null;
    taskStatus: string;
    createdAt: string;
    verificationStatus: string | null;
  }> {
    const { days = 30, limit = 100 } = options ?? {};

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const tasks = this.db.prepare(`
      SELECT id, title, agent_name, quality_score, status, created_at, verification_status
      FROM tasks
      WHERE parent_task_id IS NULL
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(cutoff, limit) as Task[];

    const mismatches = [];

    for (const task of tasks) {
      const intendedAgent = extractIntendedAgent(task.title, config);

      if (!intendedAgent || !task.agent_name || intendedAgent === task.agent_name) {
        continue;
      }

      // Apply optional filters
      if (
        options?.intendedAgent &&
        intendedAgent !== options.intendedAgent
      ) {
        continue;
      }
      if (
        options?.actualAgent &&
        task.agent_name !== options.actualAgent
      ) {
        continue;
      }

      mismatches.push({
        taskId: task.id,
        taskTitle: task.title,
        intendedAgent,
        actualAgent: task.agent_name,
        qualityScore: task.quality_score ?? null,
        taskStatus: task.status,
        createdAt: task.created_at,
        verificationStatus: task.verification_status ?? null,
      });
    }

    return mismatches;
  }

  /**
   * Get routing mismatch statistics grouped by agent pair.
   *
   * @param config OrchestratorConfig for agent validation
   * @param days Time window in days (default 30)
   * @returns Summary statistics with per-pair breakdown
   */
  getRoutingMismatchStats(
    config: OrchestratorConfig,
    days = 30,
  ): {
    totalTasksAnalyzed: number;
    mismatchCount: number;
    mismatchRate: number;
    byAgentPair: Array<{
      intendedAgent: string;
      actualAgent: string;
      count: number;
      avgQualityScore: number | null;
      mostRecentAt: string;
    }>;
  } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Count total tasks in window
    const totalRow = this.db.prepare(`
      SELECT COUNT(*) as count FROM tasks
      WHERE parent_task_id IS NULL AND created_at >= ?
    `).get(cutoff) as { count: number };
    const totalTasksAnalyzed = totalRow.count;

    // Get all mismatches
    const mismatches = this.getRoutingMismatches(config, { days, limit: 10000 });

    // Group by agent pair
    const byPair = new Map<
      string,
      {
        count: number;
        qualityScores: (number | null)[];
        mostRecentAt: string;
      }
    >();

    for (const m of mismatches) {
      const key = `${m.intendedAgent}|${m.actualAgent}`;
      const existing = byPair.get(key) ?? {
        count: 0,
        qualityScores: [],
        mostRecentAt: m.createdAt,
      };

      existing.count++;
      existing.qualityScores.push(m.qualityScore);
      if (m.createdAt > existing.mostRecentAt) {
        existing.mostRecentAt = m.createdAt;
      }

      byPair.set(key, existing);
    }

    const byAgentPair = Array.from(byPair.entries())
      .map(([key, data]) => {
        const [intendedAgent, actualAgent] = key.split("|");
        const validScores = data.qualityScores.filter((s) => s !== null) as number[];
        const avgQualityScore = validScores.length > 0
          ? validScores.reduce((a, b) => a + b, 0) / validScores.length
          : null;

        return {
          intendedAgent,
          actualAgent,
          count: data.count,
          avgQualityScore,
          mostRecentAt: data.mostRecentAt,
        };
      })
      .sort((a, b) => b.count - a.count);

    return {
      totalTasksAnalyzed,
      mismatchCount: mismatches.length,
      mismatchRate: totalTasksAnalyzed > 0 ? mismatches.length / totalTasksAnalyzed : 0,
      byAgentPair,
    };
  }

  /**
   * Get implementation tasks dispatched to the research agent (misroutes).
   *
   * Returns tasks where `agent_name = 'claude-research-agent'` and the task
   * type is "implementation" (or the title matches implementation patterns),
   * along with a quality score histogram. Used by the `/misrouting` metrics
   * endpoint and the daily Slack digest misrouting section.
   *
   * Issue #1077: Research agent implementation task misrouting detection.
   *
   * @param agentName  Agent to inspect (default: "claude-research-agent")
   * @param days       Look-back window in days (default 7)
   */
  getResearchAgentImplMisroutes(
    agentName = "claude-research-agent",
    days = 7,
  ): {
    agent: string;
    days: number;
    count: number;
    qualityHistogram: {
      excellent: number; // ≥ 0.90
      good: number;      // 0.70–0.89
      fair: number;      // 0.50–0.69
      poor: number;      // < 0.50
      unscored: number;  // null quality_score
    };
    tasks: Array<{
      id: string;
      title: string;
      taskType: string;
      qualityScore: number | null;
      status: string;
      createdAt: string;
    }>;
  } {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT id, title, task_type, quality_score, status, created_at
      FROM tasks
      WHERE agent_name = ?
        AND created_at >= ?
        AND (
          task_type = 'implementation'
          OR lower(title) LIKE '%implement%'
          OR lower(title) LIKE '%create pr%'
          OR lower(title) LIKE '%open pr%'
          OR lower(title) LIKE '%build%feature%'
          OR lower(title) LIKE '%build%api%'
          OR lower(title) LIKE '%build%endpoint%'
          OR lower(title) LIKE '%write%code%'
          OR lower(title) LIKE '%write%test%'
        )
      ORDER BY created_at DESC
      LIMIT 500
    `).all(agentName, cutoff) as Array<{
      id: string;
      title: string;
      task_type: string;
      quality_score: number | null;
      status: string;
      created_at: string;
    }>;

    const histogram = { excellent: 0, good: 0, fair: 0, poor: 0, unscored: 0 };

    for (const row of rows) {
      const s = row.quality_score;
      if (s === null || s === undefined) histogram.unscored++;
      else if (s >= 0.9) histogram.excellent++;
      else if (s >= 0.7) histogram.good++;
      else if (s >= 0.5) histogram.fair++;
      else histogram.poor++;
    }

    return {
      agent: agentName,
      days,
      count: rows.length,
      qualityHistogram: histogram,
      tasks: rows.map((r) => ({
        id: r.id,
        title: r.title,
        taskType: r.task_type,
        qualityScore: r.quality_score ?? null,
        status: r.status,
        createdAt: r.created_at,
      })),
    };
  }

  /**
   * Compute the quality score distribution across all verified top-level tasks.
   * Buckets: excellent (≥0.90), good (0.70–0.89), fair (0.50–0.69), poor (<0.50),
   * unscored (verified but no numeric score).
   */
  getScoreDistribution(): ScoreDistribution {
    const row = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN quality_score >= 0.90 THEN 1 ELSE 0 END), 0) AS excellent,
        COALESCE(SUM(CASE WHEN quality_score >= 0.70 AND quality_score < 0.90 THEN 1 ELSE 0 END), 0) AS good,
        COALESCE(SUM(CASE WHEN quality_score >= 0.50 AND quality_score < 0.70 THEN 1 ELSE 0 END), 0) AS fair,
        COALESCE(SUM(CASE WHEN quality_score IS NOT NULL AND quality_score < 0.50 THEN 1 ELSE 0 END), 0) AS poor,
        COALESCE(SUM(CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END), 0) AS unscored,
        COUNT(*) AS total
      FROM tasks
      WHERE parent_task_id IS NULL AND verification_status IS NOT NULL
    `).get() as ScoreDistribution;
    return row;
  }

  /**
   * Compute quality score distributions grouped by agent, over all verified top-level tasks.
   * Returns a record mapping agent_name → ScoreDistribution.
   */
  getScoreDistributionByAgent(): Record<string, ScoreDistribution> {
    const rows = this.db.prepare(`
      SELECT
        agent_name,
        COALESCE(SUM(CASE WHEN quality_score >= 0.90 THEN 1 ELSE 0 END), 0) AS excellent,
        COALESCE(SUM(CASE WHEN quality_score >= 0.70 AND quality_score < 0.90 THEN 1 ELSE 0 END), 0) AS good,
        COALESCE(SUM(CASE WHEN quality_score >= 0.50 AND quality_score < 0.70 THEN 1 ELSE 0 END), 0) AS fair,
        COALESCE(SUM(CASE WHEN quality_score IS NOT NULL AND quality_score < 0.50 THEN 1 ELSE 0 END), 0) AS poor,
        COALESCE(SUM(CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END), 0) AS unscored,
        COUNT(*) AS total
      FROM tasks
      WHERE agent_name IS NOT NULL AND parent_task_id IS NULL AND verification_status IS NOT NULL
      GROUP BY agent_name
    `).all() as Array<{ agent_name: string } & ScoreDistribution>;

    const result: Record<string, ScoreDistribution> = {};
    for (const { agent_name, ...dist } of rows) {
      result[agent_name] = dist;
    }
    return result;
  }

  /**
   * Check quality score data integrity: warn if >10% of recent approved tasks have null scores.
   *
   * Returns { totalApproved, nullScoreCount, nullScorePercentage, shouldWarn }.
   * Filters to approved tasks created in the last 30 days.
   *
   * Acceptance criteria (issue #965):
   * - Detects when quality_score IS NULL but verification_status = 'approved'
   * - Only counts tasks from the last 30 days (recent data)
   * - Returns shouldWarn=true when nullScorePercentage > 10%
   * - Used at startup to alert operators to data quality issues
   */
  checkRecentApprovedTasksForNullScores(
    daysSince: number = 30,
  ): { totalApproved: number; nullScoreCount: number; nullScorePercentage: number; shouldWarn: boolean } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total_approved,
        COALESCE(SUM(CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END), 0) AS null_score_count
      FROM tasks
      WHERE parent_task_id IS NULL
        AND verification_status = 'approved'
        AND created_at >= datetime('now', '-' || ? || ' days')
    `).get(daysSince) as { total_approved: number; null_score_count: number };

    const { total_approved: totalApproved, null_score_count: nullScoreCount } = row;
    const nullScorePercentage = totalApproved > 0 ? (nullScoreCount / totalApproved) * 100 : 0;
    const shouldWarn = nullScorePercentage > 10;

    return {
      totalApproved,
      nullScoreCount,
      nullScorePercentage,
      shouldWarn,
    };
  }

  /**
   * Compute a quality score trend for a single agent.
   *
   * Compares the average score of the most recent `windowSize` scored tasks
   * against the prior `windowSize` scored tasks (i.e., tasks ranked windowSize+1
   * through 2*windowSize by recency).
   *
   * Direction thresholds:
   * - improving: delta > +0.05
   * - declining: delta < -0.05
   * - stable:    |delta| <= 0.05
   * - insufficient_data: fewer than windowSize scored tasks exist
   */
  getAgentScoreTrend(agentName: string, windowSize = 10): ScoreTrend {
    // Count total scored tasks for this agent so we can report it and gate on it
    const countRow = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM tasks
      WHERE agent_name = ? AND parent_task_id IS NULL
        AND verification_status IS NOT NULL AND quality_score IS NOT NULL
    `).get(agentName) as { cnt: number };

    const scored_count = countRow.cnt;

    if (scored_count < windowSize) {
      return {
        recent_avg: null,
        prior_avg: null,
        delta: null,
        direction: "insufficient_data",
        scored_count,
        window_size: windowSize,
      };
    }

    // Use a window function (ROW_NUMBER) to rank tasks newest-first, then
    // split into two buckets: rows 1..windowSize (recent) and (windowSize+1)..(2*windowSize) (prior).
    // Only tasks with a numeric quality_score are included.
    const row = this.db.prepare(`
      SELECT
        AVG(CASE WHEN rn <= ? THEN quality_score END)                              AS recent_avg,
        AVG(CASE WHEN rn > ? AND rn <= ?        THEN quality_score END)            AS prior_avg
      FROM (
        SELECT quality_score,
               ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND verification_status IS NOT NULL
          AND quality_score IS NOT NULL
      )
      WHERE rn <= ?
    `).get(windowSize, windowSize, windowSize * 2, agentName, windowSize * 2) as {
      recent_avg: number | null;
      prior_avg: number | null;
    };

    const recent_avg = row.recent_avg;
    const prior_avg = row.prior_avg;

    let delta: number | null = null;
    let direction: ScoreTrend["direction"] = "insufficient_data";

    if (recent_avg !== null && prior_avg !== null) {
      delta = recent_avg - prior_avg;
      if (delta > 0.05) direction = "improving";
      else if (delta < -0.05) direction = "declining";
      else direction = "stable";
    } else if (recent_avg !== null) {
      // Only one window of data — stable by default
      direction = "stable";
    }

    return {
      recent_avg,
      prior_avg,
      delta,
      direction,
      scored_count,
      window_size: windowSize,
    };
  }

  getAgentStats(sinceHours?: number): Array<{ agent_name: string; total: number; done: number; failed: number; avg_score: number | null }> {
    const timeFilter = sinceHours
      ? `AND created_at >= datetime('now', '-${Math.round(sinceHours)} hours')`
      : "";
    return this.db.prepare(`
      SELECT agent_name,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(quality_score) as avg_score
      FROM tasks
      WHERE agent_name IS NOT NULL AND parent_task_id IS NULL ${timeFilter}
      GROUP BY agent_name
    `).all() as Array<{ agent_name: string; total: number; done: number; failed: number; avg_score: number | null }>;
  }

  // ── Daemon cycle tracking ────────────────────────────────────────────────

  /** Record the start of a daemon poll cycle. Returns the row id for later completion. */
  recordCycleStart(): number {
    const result = this.db
      .prepare("INSERT INTO daemon_cycles (started_at) VALUES (?)")
      .run(new Date().toISOString());
    return result.lastInsertRowid as number;
  }

  /**
   * Get the total number of daemon cycles ever recorded.
   * Used to resume cycleCount on daemon restart so modulo-based
   * scheduling (meetings, sync, improvements) doesn't reset.
   */
  getTotalCycleCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as count FROM daemon_cycles").get() as { count: number };
    return row?.count ?? 0;
  }

  // ── Meetings ──────────────────────────────────────────────────────────────

  saveMeeting(meeting: {
    type: string;
    date: string;
    rounds: Array<{
      roundNumber: number;
      prompt: string;
      entries: Array<{
        agentName: string;
        provider: string;
        pool: string | undefined;
        response: string | null;
        error: string | null;
      }>;
    }>;
    synthesis: string;
    actionItems: Array<{ description: string; owner: string; priority: string }>;
    goalAdjustments: string[];
  }): number {
    // Ensure tables exist with correct schema (guards against dashboard creating
    // them first with different column types — seen in production).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, date TEXT NOT NULL,
        rounds INTEGER NOT NULL DEFAULT 1,
        participant_count INTEGER NOT NULL DEFAULT 0,
        synthesis TEXT, action_items_json TEXT,
        goal_adjustments_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meeting_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL, round_number INTEGER NOT NULL, prompt TEXT
      );
      CREATE TABLE IF NOT EXISTS meeting_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id INTEGER NOT NULL, round_number INTEGER NOT NULL,
        agent_name TEXT NOT NULL, provider TEXT, pool TEXT,
        response TEXT, error TEXT
      );
    `);

    // Use a transaction so partial writes don't leave orphan rows
    const insert = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO meetings (type, date, rounds, participant_count, synthesis, action_items_json, goal_adjustments_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        meeting.type,
        meeting.date,
        meeting.rounds.length,
        meeting.rounds[0]?.entries.filter((e) => e.response).length ?? 0,
        meeting.synthesis,
        JSON.stringify(meeting.actionItems),
        JSON.stringify(meeting.goalAdjustments),
        new Date().toISOString(),
      );

      const meetingId = result.lastInsertRowid as number;

      for (const round of meeting.rounds) {
        this.db.prepare(
          "INSERT INTO meeting_rounds (meeting_id, round_number, prompt) VALUES (?, ?, ?)",
        ).run(meetingId, round.roundNumber, round.prompt);

        for (const entry of round.entries) {
          this.db.prepare(
            "INSERT INTO meeting_entries (meeting_id, round_number, agent_name, provider, pool, response, error) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(meetingId, round.roundNumber, entry.agentName, entry.provider, entry.pool ?? null, entry.response, entry.error);
        }
      }

      return meetingId;
    });

    return insert();
  }

  getMeetings(limit = 20): Array<{
    id: number;
    type: string;
    date: string;
    rounds: number;
    participant_count: number;
    synthesis: string | null;
    action_items_json: string | null;
    goal_adjustments_json: string | null;
    created_at: string;
  }> {
    return this.db.prepare(
      "SELECT * FROM meetings ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Array<{
      id: number; type: string; date: string; rounds: number;
      participant_count: number; synthesis: string | null;
      action_items_json: string | null; goal_adjustments_json: string | null;
      created_at: string;
    }>;
  }

  /**
   * Return the ISO timestamp of the most recent meeting of the given type,
   * or null if no meeting of that type has ever been recorded.
   */
  getLastMeetingTime(type: string): string | null {
    const row = this.db
      .prepare("SELECT created_at FROM meetings WHERE type = ? ORDER BY created_at DESC LIMIT 1")
      .get(type) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  getMeetingEntries(meetingId: number): Array<{
    round_number: number;
    agent_name: string;
    provider: string | null;
    pool: string | null;
    response: string | null;
    error: string | null;
  }> {
    return this.db.prepare(
      "SELECT round_number, agent_name, provider, pool, response, error FROM meeting_entries WHERE meeting_id = ? ORDER BY round_number, agent_name",
    ).all(meetingId) as Array<{
      round_number: number; agent_name: string; provider: string | null;
      pool: string | null; response: string | null; error: string | null;
    }>;
  }

  /**
   * Mark a cycle as finished, recording duration and dispatch waste delta.
   *
   * @param staleDispatchesPrevented Number of dispatches blocked by the issue-state
   *   cache during this cycle (delta, not cumulative). Defaults to 0.
   */
  recordCycleEnd(cycleId: number, startedAt: Date, staleDispatchesPrevented = 0): void {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    this.db
      .prepare(
        "UPDATE daemon_cycles SET finished_at = ?, duration_ms = ?, stale_dispatches_prevented = ? WHERE id = ?",
      )
      .run(finishedAt.toISOString(), durationMs, staleDispatchesPrevented, cycleId);
  }

  // ── Aggregated metrics ───────────────────────────────────────────────────

  /** Compute aggregated system metrics from existing task and cycle data. */
  getMetrics(): SystemMetrics {
    // --- Global task counts ---
    const global = this.db.prepare(`
      SELECT
        COUNT(*) AS total_tasks,
        COALESCE(SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END), 0) AS done_tasks,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_tasks,
        AVG(CASE
          WHEN status = 'done'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000.0
        END) AS avg_task_duration_ms
      FROM tasks
      WHERE parent_task_id IS NULL
    `).get() as {
      total_tasks: number;
      done_tasks: number;
      failed_tasks: number;
      avg_task_duration_ms: number | null;
    };

    // --- Global verification metrics ---
    const verify = this.db.prepare(`
      SELECT
        AVG(quality_score) AS avg_quality_score,
        1.0 * SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN verification_status IN ('approved','rejected') THEN 1 ELSE 0 END), 0)
          AS verification_pass_rate
      FROM tasks
      WHERE parent_task_id IS NULL AND verification_status IS NOT NULL
    `).get() as {
      avg_quality_score: number | null;
      verification_pass_rate: number | null;
    };

    // --- Per-agent metrics ---
    const perAgentRows = this.db.prepare(`
      SELECT
        agent_name,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        AVG(CASE
          WHEN status = 'done'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000.0
        END) AS avg_duration_ms,
        AVG(quality_score) AS avg_quality_score,
        1.0 * SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN verification_status IN ('approved','rejected') THEN 1 ELSE 0 END), 0)
          AS verification_pass_rate
      FROM tasks
      WHERE agent_name IS NOT NULL AND parent_task_id IS NULL
      GROUP BY agent_name
      ORDER BY total DESC
    `).all() as Array<{
      agent_name: string;
      total: number;
      done: number;
      failed: number;
      avg_duration_ms: number | null;
      avg_quality_score: number | null;
      verification_pass_rate: number | null;
    }>;

    const per_agent: AgentMetrics[] = perAgentRows.map((r) => ({
      agent_name: r.agent_name,
      total: r.total,
      done: r.done,
      failed: r.failed,
      avg_duration_ms: r.avg_duration_ms,
      avg_quality_score: r.avg_quality_score,
      verification_pass_rate: r.verification_pass_rate,
    }));

    // --- Cycle metrics ---
    const cycleRow = this.db.prepare(`
      SELECT
        COALESCE(COUNT(*), 0) AS total_cycles,
        AVG(duration_ms) AS avg_duration_ms,
        MAX(started_at) AS last_cycle_at
      FROM daemon_cycles
      WHERE finished_at IS NOT NULL
    `).get() as {
      total_cycles: number;
      avg_duration_ms: number | null;
      last_cycle_at: string | null;
    };

    const score_distribution = this.getScoreDistribution();
    const per_agent_score_distribution = this.getScoreDistributionByAgent();

    // Compute score trends for every agent that has at least some scored tasks
    const per_agent_score_trends: Record<string, ScoreTrend> = {};
    for (const agentName of Object.keys(per_agent_score_distribution)) {
      per_agent_score_trends[agentName] = this.getAgentScoreTrend(agentName);
    }

    const pr_metrics = this.getPRMetrics();

    return {
      total_tasks: global.total_tasks,
      done_tasks: global.done_tasks,
      failed_tasks: global.failed_tasks,
      avg_task_duration_ms: global.avg_task_duration_ms,
      verification_pass_rate: verify.verification_pass_rate,
      avg_quality_score: verify.avg_quality_score,
      score_distribution,
      per_agent_score_distribution,
      per_agent_score_trends,
      per_agent,
      cycles: {
        total_cycles: cycleRow.total_cycles,
        avg_duration_ms: cycleRow.avg_duration_ms,
        last_cycle_at: cycleRow.last_cycle_at,
      },
      pr_metrics,
    };
  }

  /**
   * Compute a time-series trend over the last `days` days, and compare
   * it to the equally-sized prior window to produce Δ deltas.
   *
   * Task rows are bucketed by the date part of `updated_at` (completion date)
   * so that "tasks_completed" counts tasks that finished on that day.
   * Cycle rows are bucketed by date part of `started_at`.
   *
   * Only top-level tasks (parent_task_id IS NULL) are counted.
   */
  getDailyTrend(days = 7): MetricsTrend {
    // We need 2× days to compute prior-period deltas
    const windowDays = days;

    // --- Task trend: bucket by completion date ---
    const taskRows = this.db.prepare(`
      SELECT
        date(updated_at)  AS date,
        COALESCE(SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END), 0) AS tasks_completed,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS tasks_failed,
        AVG(CASE
          WHEN status = 'done'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000.0
        END) AS avg_duration_ms,
        1.0 * SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN verification_status IN ('approved','rejected') THEN 1 ELSE 0 END), 0)
          AS verification_pass_rate,
        AVG(CASE WHEN verification_status IS NOT NULL THEN quality_score END) AS avg_quality_score
      FROM tasks
      WHERE parent_task_id IS NULL
        AND date(updated_at) >= date('now', ? || ' days')
      GROUP BY date(updated_at)
      ORDER BY date(updated_at) ASC
    `).all(`-${windowDays * 2}`) as Array<{
      date: string;
      tasks_completed: number;
      tasks_failed: number;
      avg_duration_ms: number | null;
      verification_pass_rate: number | null;
      avg_quality_score: number | null;
    }>;

    // --- Cycle trend: bucket by start date ---
    const cycleRows = this.db.prepare(`
      SELECT
        date(started_at) AS date,
        COUNT(*) AS cycle_count,
        AVG(duration_ms) AS avg_duration_ms
      FROM daemon_cycles
      WHERE finished_at IS NOT NULL
        AND date(started_at) >= date('now', ? || ' days')
      GROUP BY date(started_at)
      ORDER BY date(started_at) ASC
    `).all(`-${windowDays * 2}`) as Array<{
      date: string;
      cycle_count: number;
      avg_duration_ms: number | null;
    }>;

    // Split rows into recent window vs prior window using date comparison
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10); // 'YYYY-MM-DD'

    const recentTaskDays = taskRows.filter((r) => r.date >= cutoffStr);
    const priorTaskDays = taskRows.filter((r) => r.date < cutoffStr);

    const recentCycleDays = cycleRows.filter((r) => r.date >= cutoffStr);
    const priorCycleDays = cycleRows.filter((r) => r.date < cutoffStr);

    // Helper: average a nullable numeric field across rows
    const avgField = <T>(rows: T[], field: keyof T): number | null => {
      const vals = rows.map((r) => r[field] as number | null).filter((v): v is number => v !== null);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };

    const sum = <T>(rows: T[], field: keyof T): number =>
      rows.reduce((acc, r) => acc + ((r[field] as number) ?? 0), 0);

    // Throughput: avg tasks_completed per day.
    // Only compute if both windows have at least one day of data, so we're
    // comparing apples to apples rather than a real period vs an empty one.
    const recentThroughput =
      recentTaskDays.length > 0 && windowDays > 0
        ? sum(recentTaskDays, "tasks_completed") / windowDays
        : null;
    const priorThroughput =
      priorTaskDays.length > 0 && windowDays > 0
        ? sum(priorTaskDays, "tasks_completed") / windowDays
        : null;
    const throughput_delta =
      recentThroughput !== null && priorThroughput !== null ? recentThroughput - priorThroughput : null;

    const recentPassRate = avgField(recentTaskDays, "verification_pass_rate");
    const priorPassRate = avgField(priorTaskDays, "verification_pass_rate");
    const pass_rate_delta = recentPassRate !== null && priorPassRate !== null ? recentPassRate - priorPassRate : null;

    const recentScore = avgField(recentTaskDays, "avg_quality_score");
    const priorScore = avgField(priorTaskDays, "avg_quality_score");
    const score_delta = recentScore !== null && priorScore !== null ? recentScore - priorScore : null;

    const recentCycleDuration = avgField(recentCycleDays, "avg_duration_ms");
    const priorCycleDuration = avgField(priorCycleDays, "avg_duration_ms");
    const cycle_duration_delta =
      recentCycleDuration !== null && priorCycleDuration !== null
        ? recentCycleDuration - priorCycleDuration
        : null;

    return {
      days: windowDays,
      task_days: recentTaskDays.map((r) => ({
        date: r.date,
        tasks_completed: r.tasks_completed,
        tasks_failed: r.tasks_failed,
        avg_duration_ms: r.avg_duration_ms,
        verification_pass_rate: r.verification_pass_rate,
        avg_quality_score: r.avg_quality_score,
      })),
      cycle_days: recentCycleDays.map((r) => ({
        date: r.date,
        cycle_count: r.cycle_count,
        avg_duration_ms: r.avg_duration_ms,
      })),
      throughput_delta,
      pass_rate_delta,
      score_delta,
      cycle_duration_delta,
    };
  }

  markReported(taskId: string): void {
    this.db.prepare("UPDATE tasks SET reported = 1 WHERE id = ?").run(taskId);
  }

  recordTokenUsage(
    provider: string,
    agentName: string | null,
    tokensIn: number,
    tokensOut: number,
    cacheReadTokens = 0,
    cacheCreationTokens = 0,
  ): void {
    this.db.prepare(`
      INSERT INTO token_usage (provider, agent_name, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(provider, agentName, tokensIn, tokensOut, cacheReadTokens, cacheCreationTokens, new Date().toISOString());
  }

  /**
   * Count top-level tasks by status created within the last N hours.
   */
  getTaskStatusCountsLastHours(hours = 24): Record<string, number> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) as count
         FROM tasks
         WHERE created_at >= ? AND parent_task_id IS NULL
         GROUP BY status`,
      )
      .all(since) as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {
      pending: 0,
      planning: 0,
      dispatched: 0,
      in_progress: 0,
      done: 0,
      failed: 0,
      result_missing: 0,
    };
    for (const row of rows) {
      if (row.status in counts) counts[row.status] = row.count;
    }
    return counts;
  }

  /**
   * Return agents with more than `threshold` failed top-level tasks in the last N hours.
   */
  getAgentsWithRecentFailures(hours = 24, threshold = 1): Array<{ agent_name: string; failed: number }> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `SELECT agent_name, COUNT(*) as failed
         FROM tasks
         WHERE status = 'failed' AND created_at >= ? AND parent_task_id IS NULL AND agent_name IS NOT NULL
         GROUP BY agent_name
         HAVING COUNT(*) > ?
         ORDER BY failed DESC`,
      )
      .all(since, threshold) as Array<{ agent_name: string; failed: number }>;
  }

  /**
   * Return per-agent reliability health summary.
   *
   * For each agent computes over their last 30 top-level tasks:
   *  - success rate (done / total)
   *  - consecutive failure streak (most recent tasks first)
   *  - last failure reason (first 120 chars of result)
   *  - last success timestamp
   *
   * If `agentNames` is provided, only those agents are included (useful when the
   * config lists agents that may not yet have any tasks).
   */
  getAgentHealthSummary(agentNames?: string[]): AgentHealthSummary[] {
    // One query per agent is fine for the small fleet sizes we have.
    // If the fleet grows large, this can be batched.
    const names =
      agentNames ??
      (
        this.db
          .prepare(
            `SELECT DISTINCT agent_name FROM tasks
             WHERE agent_name IS NOT NULL AND parent_task_id IS NULL`,
          )
          .all() as Array<{ agent_name: string }>
      ).map((r) => r.agent_name);

    return names.map((agentName): AgentHealthSummary => {
      // Last 30 top-level tasks for this agent, newest first
      const recent = this.db
        .prepare(
          `SELECT id, title, source, status, result, updated_at
           FROM tasks
           WHERE agent_name = ? AND parent_task_id IS NULL
           ORDER BY rowid DESC
           LIMIT 30`,
        )
        .all(agentName) as Array<{
        id: string;
        title: string;
        source: string;
        status: string;
        result: string | null;
        updated_at: string;
      }>;

      /** A task is a revision/rework if it was dispatched as PR feedback or a verifier retry. */
      const isRevision = (t: { title: string; source: string }): boolean =>
        t.source === "pr-feedback" || t.title.startsWith("[revision]");

      if (recent.length === 0) {
        return {
          agent_name: agentName,
          success_rate: null,
          total: 0,
          done: 0,
          failed: 0,
          consecutive_failures: 0,
          last_failure_reason: null,
          last_success_at: null,
          revision_rate: null,
          first_attempt_success_rate: null,
        };
      }

      const total = recent.length;
      const done = recent.filter((t) => t.status === "done").length;
      const failed = recent.filter((t) => t.status === "failed").length;
      const success_rate = total > 0 ? done / total : null;

      // Consecutive failures: walk from newest until we hit a non-failed task
      let consecutive_failures = 0;
      for (const task of recent) {
        if (task.status === "failed") {
          consecutive_failures++;
        } else {
          break;
        }
      }

      // Most recent failed task result (first 120 chars, strip newlines)
      const lastFailed = recent.find((t) => t.status === "failed");
      const last_failure_reason = lastFailed?.result
        ? lastFailed.result.replace(/\n+/g, " ").slice(0, 120)
        : null;

      // Most recent done task
      const lastSuccess = recent.find((t) => t.status === "done");
      const last_success_at = lastSuccess?.updated_at ?? null;

      // Revision rate: fraction of the last 30 tasks that were rework
      const revisionCount = recent.filter(isRevision).length;
      const revision_rate = total > 0 ? revisionCount / total : null;

      // First-attempt success rate: done / total for non-revision tasks only
      const firstAttemptTasks = recent.filter((t) => !isRevision(t));
      const firstAttemptDone = firstAttemptTasks.filter((t) => t.status === "done").length;
      const first_attempt_success_rate =
        firstAttemptTasks.length > 0 ? firstAttemptDone / firstAttemptTasks.length : null;

      return {
        agent_name: agentName,
        success_rate,
        total,
        done,
        failed,
        consecutive_failures,
        last_failure_reason,
        last_success_at,
        revision_rate,
        first_attempt_success_rate,
      };
    });
  }

  /**
   * Return per-agent productivity stats for the last `days` days.
   * Only top-level tasks (parent_task_id IS NULL) are included.
   * Results are ordered by tasks completed (done DESC).
   */
  getWindowedAgentMetrics(days = 7): WindowedAgentMetrics[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT
        agent_name,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        AVG(CASE
          WHEN status = 'done'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000.0
        END) AS avg_duration_ms,
        AVG(CASE WHEN verification_status IS NOT NULL THEN quality_score END) AS avg_quality_score,
        1.0 * SUM(CASE WHEN verification_status = 'rejected' THEN 1 ELSE 0 END) /
          NULLIF(SUM(CASE WHEN verification_status IN ('approved','rejected') THEN 1 ELSE 0 END), 0)
          AS rejection_rate
      FROM tasks
      WHERE agent_name IS NOT NULL
        AND parent_task_id IS NULL
        AND created_at >= ?
      GROUP BY agent_name
      ORDER BY done DESC, total DESC
    `).all(since) as Array<{
      agent_name: string;
      total: number;
      done: number;
      failed: number;
      avg_duration_ms: number | null;
      avg_quality_score: number | null;
      rejection_rate: number | null;
    }>;

    return rows.map((r) => {
      // Get trend direction using existing getAgentScoreTrend
      const trend = this.getAgentScoreTrend(r.agent_name);
      return {
        agent_name: r.agent_name,
        total: r.total,
        done: r.done,
        failed: r.failed,
        fail_pct: r.total > 0 ? (r.failed / r.total) * 100 : null,
        rejection_pct: r.rejection_rate !== null ? r.rejection_rate * 100 : null,
        avg_quality_score: r.avg_quality_score,
        avg_duration_ms: r.avg_duration_ms,
        trend: trend.direction,
      };
    });
  }

  // ── Already-in-review saturation ─────────────────────────────────────────

  /**
   * Compute the "already-in-review" saturation ratio over a rolling window.
   *
   * Returns the fraction of completed tasks whose `result` begins with
   * `"already-in-review:"` — i.e. tasks that were skipped because an open PR
   * was already in flight.  A high ratio (>0.30 by convention) indicates that
   * dispatch deduplication is failing or that PR throughput is falling behind
   * the issue intake rate.
   *
   * @param windowHours - Rolling look-back window (default 1 hour).
   */
  getAlreadyInReviewSaturation(windowHours = 1): {
    windowHours: number;
    total: number;
    alreadyInReview: number;
    ratio: number;
    perAgent: Array<{ agent_name: string; total: number; alreadyInReview: number; ratio: number }>;
  } {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    const globalRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN result LIKE 'already-in-review:%' THEN 1 ELSE 0 END), 0) AS alreadyInReview
      FROM tasks
      WHERE status = 'done'
        AND created_at >= ?
    `).get(since) as { total: number; alreadyInReview: number };

    const perAgentRows = this.db.prepare(`
      SELECT
        agent_name,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN result LIKE 'already-in-review:%' THEN 1 ELSE 0 END), 0) AS alreadyInReview
      FROM tasks
      WHERE status = 'done'
        AND agent_name IS NOT NULL
        AND created_at >= ?
      GROUP BY agent_name
      ORDER BY alreadyInReview DESC, total DESC
    `).all(since) as Array<{ agent_name: string; total: number; alreadyInReview: number }>;

    const total = globalRow.total ?? 0;
    const alreadyInReview = globalRow.alreadyInReview ?? 0;
    const ratio = total > 0 ? alreadyInReview / total : 0;

    return {
      windowHours,
      total,
      alreadyInReview,
      ratio,
      perAgent: perAgentRows.map((r) => ({
        agent_name: r.agent_name,
        total: r.total,
        alreadyInReview: r.alreadyInReview,
        ratio: r.total > 0 ? r.alreadyInReview / r.total : 0,
      })),
    };
  }

  // ── Supervisor memory ────────────────────────────────────────────────────

  private runSupervisorMemoryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS supervisor_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        agent_name TEXT,
        reason TEXT NOT NULL,
        message TEXT,
        outcome TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_created ON supervisor_decisions(created_at);
      -- routing_decisions mirrors supervisor_decisions but is the canonical source
      -- for the dashboard timeline (includes capability-enforcement route metadata).
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        agent_name TEXT,
        reason TEXT NOT NULL,
        message TEXT,
        outcome TEXT NOT NULL,
        task_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_routing_decisions_created ON routing_decisions(created_at);
    `);

    // Migrations: add structured feed columns if they don't exist yet.
    const cols = this.db
      .prepare("PRAGMA table_info(supervisor_decisions)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "rationale")) {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN rationale TEXT");
    }
    if (!cols.some((c) => c.name === "issue_refs")) {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN issue_refs TEXT");
    }
    if (!cols.some((c) => c.name === "hard_gates")) {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN hard_gates TEXT");
    }

    // Add capability-enforcement columns to routing_decisions if absent.
    const routingCols = this.db
      .prepare("PRAGMA table_info(routing_decisions)")
      .all() as Array<{ name: string }>;
    if (!routingCols.some((c) => c.name === "route_method")) {
      this.db.exec("ALTER TABLE routing_decisions ADD COLUMN route_method TEXT");
    }
    if (!routingCols.some((c) => c.name === "redirect_reason")) {
      this.db.exec("ALTER TABLE routing_decisions ADD COLUMN redirect_reason TEXT");
    }
  }

  /**
   * Persist a supervisor decision with its execution outcome.
   * Called by the daemon after executing (or skipping) each supervisor decision.
   *
   * Writes to both `supervisor_decisions` (the rich audit log with rationale
   * and structured gate info) and `routing_decisions` (the leaner mirror read
   * by the dashboard timeline, #632).
   *
   * `route_method` and `redirect_reason` are optional fields for
   * capability-enforcement reroutes; they are only written to
   * `routing_decisions` since the supervisor table schema predates them.
   */
  addSupervisorDecision(params: {
    action: string;
    agent_name?: string;
    reason: string;
    message?: string;
    rationale?: string;
    issue_refs?: string[];
    hard_gates?: string[];
    outcome: SupervisorOutcome;
    task_id?: string;
    /** e.g. "capability-enforcement" */
    route_method?: string;
    /** Human-readable explanation of a capability-enforcement reroute. */
    redirect_reason?: string;
  }): void {
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO supervisor_decisions (action, agent_name, reason, message, rationale, issue_refs, hard_gates, outcome, task_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.action,
          params.agent_name ?? null,
          params.reason,
          params.message ?? null,
          params.rationale ?? null,
          JSON.stringify(params.issue_refs ?? []),
          JSON.stringify(params.hard_gates ?? []),
          params.outcome,
          params.task_id ?? null,
          createdAt,
        );

      // Mirror into routing_decisions so the dashboard timeline always has
      // a consistent, outcome-indexed view of every dispatch decision.
      this.db
        .prepare(
          `INSERT INTO routing_decisions
             (action, agent_name, reason, message, outcome, task_id, created_at, route_method, redirect_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.action,
          params.agent_name ?? null,
          params.reason,
          params.message ?? null,
          params.outcome,
          params.task_id ?? null,
          createdAt,
          params.route_method ?? null,
          params.redirect_reason ?? null,
        );
    })();
  }

  /**
   * Return the most recent supervisor decisions, newest first.
   * Used by the supervisor to build context across cycles.
   */
  getRecentSupervisorDecisions(limit = 10): SupervisorDecisionRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM supervisor_decisions ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as Array<Omit<SupervisorDecisionRecord, "issue_refs" | "hard_gates"> & {
        issue_refs?: string | null;
        hard_gates?: string | null;
      }>;
    return rows.map((row) => ({
      ...row,
      issue_refs: parseJsonStringArray(row.issue_refs),
      hard_gates: parseJsonStringArray(row.hard_gates),
    }));
  }

  /**
   * Return supervisor decisions with optional filtering by agent name and
   * rolling-window cutoff — designed for the metrics server feed (issue #1140).
   *
   * Results are ordered newest-first and capped at `limit`.
   *
   * @param limit  - Maximum number of records to return (default 100).
   * @param agent  - Optional agent name filter (null = all agents).
   * @param days   - Rolling look-back window in days (0 = no window filter).
   */
  getSupervisorDecisionsFeed(
    limit = 100,
    agent: string | null = null,
    days = 0,
  ): SupervisorDecisionRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (agent) {
      conditions.push("agent_name = ?");
      params.push(agent);
    }
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 3600_000).toISOString();
      conditions.push("created_at >= ?");
      params.push(cutoff);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT * FROM supervisor_decisions ${where} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params) as Array<Omit<SupervisorDecisionRecord, "issue_refs" | "hard_gates"> & {
        issue_refs?: string | null;
        hard_gates?: string | null;
      }>;
    return rows.map((row) => ({
      ...row,
      issue_refs: parseJsonStringArray(row.issue_refs),
      hard_gates: parseJsonStringArray(row.hard_gates),
    }));
  }

  /**
   * Return routing decisions from the last `hours` hours in ascending
   * chronological order, suitable for rendering a per-agent swimlane timeline.
   *
   * Each event carries the fields needed for the chart:
   *  - `created_at`  → X-axis position
   *  - `agent_name`  → which swimlane row
   *  - `outcome`     → dot colour (dispatched=green, skipped=yellow, failed=red)
   *  - `reason`      → hover tooltip text
   *  - `task_id`     → click-through to detail modal
   *
   * Reads from `routing_decisions` (the dashboard-friendly mirror of
   * `supervisor_decisions`) so that both the orchestrator and dashboard
   * writer paths are covered.
   *
   * @param hours - Look-back window in hours (default 24).
   */
  getRoutingTimelineData(hours = 24): RoutingTimelineEvent[] {
    const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
    return this.db
      .prepare(
        `SELECT id, created_at, agent_name, outcome, reason, action, task_id
           FROM routing_decisions
          WHERE created_at >= ?
          ORDER BY created_at ASC`,
      )
      .all(cutoff) as RoutingTimelineEvent[];
  }

  addDispatchValidation(params: {
    source: string;
    source_ref?: string;
    agent_name?: string;
    repo?: string;
    issue_number?: number;
    outcome: DispatchValidationOutcome;
    failure_check?: string | null;
    failure_code?: string | null;
    failure_reason?: string | null;
    checklist: DispatchValidationCheck[];
  }): DispatchValidationRecord {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO dispatch_validations
           (source, source_ref, agent_name, repo, issue_number, outcome, failure_check, failure_code, failure_reason, checklist_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.source,
        params.source_ref ?? null,
        params.agent_name ?? null,
        params.repo ?? null,
        params.issue_number ?? null,
        params.outcome,
        params.failure_check ?? null,
        params.failure_code ?? null,
        params.failure_reason ?? null,
        JSON.stringify(params.checklist),
        now,
      );

    return this.db
      .prepare("SELECT * FROM dispatch_validations WHERE id = ?")
      .get(result.lastInsertRowid as number) as DispatchValidationRecord;
  }

  getRecentDispatchValidationFailures(limit = 20): DispatchValidationRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_validations
         WHERE outcome = 'blocked'
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as DispatchValidationRecord[];
  }

  getDispatchValidationHistory(sourceRef: string, limit = 10): DispatchValidationRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM dispatch_validations
         WHERE source_ref = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(sourceRef, limit) as DispatchValidationRecord[];
  }

  /**
   * Return retry health metrics for the last `hours` hours.
   *
   * "Retried" tasks are those whose `retry_count > 0` and which were last
   * updated within the window (i.e. they timed out and a retry was scheduled
   * or executed during the window).
   *
   * "Exhausted" tasks are those that timed out and ran out of retry budget
   * (`retry_count > 0`, `next_retry_at IS NULL`, `status = 'failed'`).
   *
   * "Waiting" tasks are those currently parked in backoff
   * (`next_retry_at > now`, `status = 'failed'`).
   */
  getRetryMetrics(hours = 24): RetryMetrics {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    // Per-agent breakdown for tasks touched (retried) within the window.
    const rows = this.db.prepare(`
      SELECT
        agent_name,
        COUNT(*) AS retried_tasks,
        SUM(retry_count) AS total_retries,
        COALESCE(SUM(CASE WHEN status = 'failed' AND next_retry_at IS NULL THEN 1 ELSE 0 END), 0) AS exhausted_budget,
        COALESCE(SUM(CASE WHEN next_retry_at IS NOT NULL AND next_retry_at > ? THEN 1 ELSE 0 END), 0) AS waiting_retry
      FROM tasks
      WHERE updated_at >= ?
        AND parent_task_id IS NULL
        AND retry_count > 0
        AND agent_name IS NOT NULL
      GROUP BY agent_name
      ORDER BY total_retries DESC
    `).all(now, since) as Array<{
      agent_name: string;
      retried_tasks: number;
      total_retries: number;
      exhausted_budget: number;
      waiting_retry: number;
    }>;

    // System-wide count of tasks currently parked in backoff (may include
    // tasks whose first timeout happened before the window).
    const waitingRow = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM tasks
      WHERE status = 'failed' AND next_retry_at IS NOT NULL AND next_retry_at > ?
    `).get(now) as { cnt: number };

    const total_waiting = waitingRow.cnt;
    const total_exhausted = rows.reduce((sum, r) => sum + r.exhausted_budget, 0);

    return {
      per_agent: rows,
      total_waiting,
      total_exhausted,
    };
  }

  // ── PR review metrics ────────────────────────────────────────────────────

  private runPRReviewsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        decision TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_repo_pr ON pr_reviews(repo, pr_number);
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_created ON pr_reviews(created_at);
    `);
  }

  /**
   * Record a PR review decision made by the orchestrator.
   * Called by PRReviewer.executeDecision() after posting the review comment.
   */
  recordPRReview(repo: string, prNumber: number, decision: "approve" | "request-changes" | "escalate"): void {
    this.db
      .prepare(
        "INSERT INTO pr_reviews (repo, pr_number, decision, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(repo, prNumber, decision, new Date().toISOString());
  }

  countPRReviewsByDecision(repo: string, prNumber: number, decision: string): number {
    const row = this.db
      .prepare("SELECT count(*) as c FROM pr_reviews WHERE repo = ? AND pr_number = ? AND decision = ?")
      .get(repo, prNumber, decision) as { c: number };
    return row.c;
  }

  clearPRReviewsByDecision(repo: string, prNumber: number, decision: string): number {
    const result = this.db
      .prepare("DELETE FROM pr_reviews WHERE repo = ? AND pr_number = ? AND decision = ?")
      .run(repo, prNumber, decision);
    return result.changes;
  }

  clearPRReviewEscalation(repo: string, prNumber: number): number {
    const result = this.db
      .prepare("DELETE FROM pr_reviews WHERE repo = ? AND pr_number = ? AND decision = 'escalate'")
      .run(repo, prNumber);
    return result.changes;
  }

  clearAllEscalatedPRReviews(): number {
    const result = this.db
      .prepare("DELETE FROM pr_reviews WHERE decision = 'escalate'")
      .run();
    return result.changes;
  }

  getPRReviews(repo: string, prNumber: number): Array<{ decision: string; created_at: string }> {
    return this.db
      .prepare("SELECT decision, created_at FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC")
      .all(repo, prNumber) as Array<{ decision: string; created_at: string }>;
  }

  /**
   * Compute aggregated PR metrics: cycle time and rejection rate.
   *
   * Cycle time = time from first review decision on a PR to its approval.
   * Rejection rate = request-changes rounds / (approved + request-changes rounds).
   */
  getPRMetrics(): PRMetrics {
    // Global totals
    const globalRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total_reviews,
        COALESCE(SUM(CASE WHEN decision = 'approve'          THEN 1 ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN decision = 'request-changes'  THEN 1 ELSE 0 END), 0) AS request_changes,
        COALESCE(SUM(CASE WHEN decision = 'escalate'         THEN 1 ELSE 0 END), 0) AS escalated
      FROM pr_reviews
    `).get() as { total_reviews: number; approved: number; request_changes: number; escalated: number };

    const rejection_rate =
      globalRow.approved + globalRow.request_changes > 0
        ? globalRow.request_changes / (globalRow.approved + globalRow.request_changes)
        : null;

    // Average cycle time: for each PR that was eventually approved, compute
    // time from its first review record to its approval record.
    const cycleRows = this.db.prepare(`
      SELECT
        r.repo,
        r.pr_number,
        MIN(all_r.created_at) AS first_review_at,
        r.created_at          AS approved_at
      FROM pr_reviews r
      JOIN pr_reviews all_r ON all_r.repo = r.repo AND all_r.pr_number = r.pr_number
      WHERE r.decision = 'approve'
      GROUP BY r.repo, r.pr_number, r.created_at
    `).all() as Array<{ repo: string; pr_number: number; first_review_at: string; approved_at: string }>;

    const cycleTimes = cycleRows
      .map((row) => new Date(row.approved_at).getTime() - new Date(row.first_review_at).getTime())
      .filter((ms) => ms >= 0);

    const avg_cycle_time_ms =
      cycleTimes.length > 0
        ? cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length
        : null;

    // Per-repo breakdown
    const repoRows = this.db.prepare(`
      SELECT
        repo,
        COUNT(*) AS total_reviews,
        COALESCE(SUM(CASE WHEN decision = 'approve'         THEN 1 ELSE 0 END), 0) AS approved,
        COALESCE(SUM(CASE WHEN decision = 'request-changes' THEN 1 ELSE 0 END), 0) AS request_changes,
        COALESCE(SUM(CASE WHEN decision = 'escalate'        THEN 1 ELSE 0 END), 0) AS escalated
      FROM pr_reviews
      GROUP BY repo
      ORDER BY total_reviews DESC
    `).all() as Array<{ repo: string; total_reviews: number; approved: number; request_changes: number; escalated: number }>;

    // Per-repo cycle times
    const repoCycleMap = new Map<string, number[]>();
    for (const row of cycleRows) {
      const ms = new Date(row.approved_at).getTime() - new Date(row.first_review_at).getTime();
      if (ms >= 0) {
        const list = repoCycleMap.get(row.repo) ?? [];
        list.push(ms);
        repoCycleMap.set(row.repo, list);
      }
    }

    const per_repo = repoRows.map((r) => {
      const times = repoCycleMap.get(r.repo) ?? [];
      return {
        repo: r.repo,
        total_reviews: r.total_reviews,
        approved: r.approved,
        request_changes: r.request_changes,
        escalated: r.escalated,
        rejection_rate:
          r.approved + r.request_changes > 0
            ? r.request_changes / (r.approved + r.request_changes)
            : null,
        avg_cycle_time_ms:
          times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null,
      };
    });

    return {
      total_reviews: globalRow.total_reviews,
      approved: globalRow.approved,
      request_changes: globalRow.request_changes,
      escalated: globalRow.escalated,
      rejection_rate,
      avg_cycle_time_ms,
      per_repo,
    };
  }

  // ── PR merge queue ───────────────────────────────────────────────────────

  private runMergeQueueMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_merge_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        enqueued_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        UNIQUE(repo, pr_number)
      );
      CREATE INDEX IF NOT EXISTS idx_pr_merge_queue_status ON pr_merge_queue(status);
      CREATE INDEX IF NOT EXISTS idx_pr_merge_queue_repo_status ON pr_merge_queue(repo, status);
    `);
  }

  /** Add a PR to the merge queue. No-op (ignored) if it's already enqueued. */
  queuePRForMerge(repo: string, prNumber: number, branch: string): MergeQueueEntry {
    const now = new Date().toISOString();
    // Compute next position for this repo
    const posRow = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM pr_merge_queue WHERE repo = ? AND status = 'queued'")
      .get(repo) as { next_pos: number };
    const position = posRow.next_pos;
    this.db
      .prepare(
        `INSERT INTO pr_merge_queue (repo, pr_number, branch, position, status, enqueued_at)
         VALUES (?, ?, ?, ?, 'queued', ?)
         ON CONFLICT(repo, pr_number) DO NOTHING`,
      )
      .run(repo, prNumber, branch, position, now);
    return this.getMergeQueueEntry(repo, prNumber)!;
  }

  /** Get a single queue entry, or undefined if not present. */
  getMergeQueueEntry(repo: string, prNumber: number): MergeQueueEntry | undefined {
    return this.db
      .prepare("SELECT * FROM pr_merge_queue WHERE repo = ? AND pr_number = ?")
      .get(repo, prNumber) as MergeQueueEntry | undefined;
  }

  /** Return true if the given PR is currently in the queue (any non-terminal status). */
  isPRInMergeQueue(repo: string, prNumber: number): boolean {
    const entry = this.getMergeQueueEntry(repo, prNumber);
    return entry !== undefined && (entry.status === "queued" || entry.status === "merging");
  }

  /**
   * Get all queued/merging entries ordered by position.
   * Pass repo to restrict to a single repo, or omit for all repos.
   */
  getMergeQueue(repo?: string): MergeQueueEntry[] {
    if (repo) {
      return this.db
        .prepare("SELECT * FROM pr_merge_queue WHERE repo = ? AND status IN ('queued','merging') ORDER BY position ASC, enqueued_at ASC")
        .all(repo) as MergeQueueEntry[];
    }
    return this.db
      .prepare("SELECT * FROM pr_merge_queue WHERE status IN ('queued','merging') ORDER BY repo ASC, position ASC, enqueued_at ASC")
      .all() as MergeQueueEntry[];
  }

  /** Return the next entry eligible to be merged for a given repo (or globally). */
  getNextQueuedPR(repo?: string): MergeQueueEntry | undefined {
    if (repo) {
      return this.db
        .prepare("SELECT * FROM pr_merge_queue WHERE repo = ? AND status = 'queued' ORDER BY position ASC, enqueued_at ASC LIMIT 1")
        .get(repo) as MergeQueueEntry | undefined;
    }
    return this.db
      .prepare("SELECT * FROM pr_merge_queue WHERE status = 'queued' ORDER BY repo ASC, position ASC, enqueued_at ASC LIMIT 1")
      .get() as MergeQueueEntry | undefined;
  }

  /** Mark a queued PR as actively being merged. */
  markQueuedPRMerging(repo: string, prNumber: number): void {
    this.db
      .prepare("UPDATE pr_merge_queue SET status = 'merging', started_at = ? WHERE repo = ? AND pr_number = ?")
      .run(new Date().toISOString(), repo, prNumber);
  }

  /** Mark a queued PR as successfully merged. */
  markQueuedPRMerged(repo: string, prNumber: number): void {
    this.db
      .prepare("UPDATE pr_merge_queue SET status = 'merged', completed_at = ? WHERE repo = ? AND pr_number = ?")
      .run(new Date().toISOString(), repo, prNumber);
  }

  /** Mark a queued PR merge as failed. */
  markQueuedPRFailed(repo: string, prNumber: number, error: string): void {
    this.db
      .prepare("UPDATE pr_merge_queue SET status = 'failed', completed_at = ?, error = ? WHERE repo = ? AND pr_number = ?")
      .run(new Date().toISOString(), error, repo, prNumber);
  }

  /** Remove a PR from the queue entirely (e.g. if it was closed/merged externally). */
  removeFromMergeQueue(repo: string, prNumber: number): void {
    this.db
      .prepare("DELETE FROM pr_merge_queue WHERE repo = ? AND pr_number = ?")
      .run(repo, prNumber);
  }

  // ── Priority review queue (dispatch-blocking PRs) ───────────────────────

  private runPriorityReviewQueueMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS priority_review_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        blocked_issue_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        enqueued_at TEXT NOT NULL,
        reviewed_at TEXT,
        unblocked_dispatch INTEGER NOT NULL DEFAULT 0,
        UNIQUE(repo, pr_number)
      );
      CREATE INDEX IF NOT EXISTS idx_priority_review_queue_status ON priority_review_queue(status);
      CREATE INDEX IF NOT EXISTS idx_priority_review_queue_repo ON priority_review_queue(repo, status);
    `);
  }

  /** Add a dispatch-blocking PR to the priority review queue. No-op if already present. */
  addToPriorityReviewQueue(repo: string, prNumber: number, blockedIssueRef: string): void {
    this.db
      .prepare(
        `INSERT INTO priority_review_queue (repo, pr_number, blocked_issue_ref, status, enqueued_at)
         VALUES (?, ?, ?, 'pending', ?)
         ON CONFLICT(repo, pr_number) DO NOTHING`,
      )
      .run(repo, prNumber, blockedIssueRef, new Date().toISOString());
  }

  /** Return true if the PR is already in the priority review queue with pending status. */
  isPRInPriorityReviewQueue(repo: string, prNumber: number): boolean {
    const row = this.db
      .prepare("SELECT id FROM priority_review_queue WHERE repo = ? AND pr_number = ? AND status = 'pending'")
      .get(repo, prNumber);
    return row !== undefined;
  }

  /** Get all pending priority review entries, ordered by enqueue time (oldest first). */
  getPriorityReviewQueue(): Array<{ id: number; repo: string; pr_number: number; blocked_issue_ref: string; enqueued_at: string }> {
    return this.db
      .prepare("SELECT id, repo, pr_number, blocked_issue_ref, enqueued_at FROM priority_review_queue WHERE status = 'pending' ORDER BY enqueued_at ASC")
      .all() as Array<{ id: number; repo: string; pr_number: number; blocked_issue_ref: string; enqueued_at: string }>;
  }

  /** Mark a priority review entry as reviewed. Set unblockedDispatch=true if the review result unblocked a dispatch. */
  completePriorityReview(repo: string, prNumber: number, unblockedDispatch: boolean): void {
    this.db
      .prepare(
        "UPDATE priority_review_queue SET status = 'reviewed', reviewed_at = ?, unblocked_dispatch = ? WHERE repo = ? AND pr_number = ? AND status = 'pending'",
      )
      .run(new Date().toISOString(), unblockedDispatch ? 1 : 0, repo, prNumber);
  }

  /** Remove a PR from the priority review queue (e.g. if the PR was closed/merged externally). */
  removeFromPriorityReviewQueue(repo: string, prNumber: number): void {
    this.db
      .prepare("DELETE FROM priority_review_queue WHERE repo = ? AND pr_number = ?")
      .run(repo, prNumber);
  }

  /**
   * Get priority review metrics: total enqueued, reviewed, and how many actually
   * unblocked a dispatch vs were handled by general review.
   */
  getPriorityReviewMetrics(): { total_enqueued: number; total_reviewed: number; unblocked_by_priority: number; unblocked_by_general: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_enqueued,
           SUM(CASE WHEN status = 'reviewed' THEN 1 ELSE 0 END) as total_reviewed,
           SUM(CASE WHEN status = 'reviewed' AND unblocked_dispatch = 1 THEN 1 ELSE 0 END) as unblocked_by_priority,
           SUM(CASE WHEN status = 'reviewed' AND unblocked_dispatch = 0 THEN 1 ELSE 0 END) as unblocked_by_general
         FROM priority_review_queue`,
      )
      .get() as { total_enqueued: number; total_reviewed: number; unblocked_by_priority: number; unblocked_by_general: number };
    return {
      total_enqueued: row.total_enqueued ?? 0,
      total_reviewed: row.total_reviewed ?? 0,
      unblocked_by_priority: row.unblocked_by_priority ?? 0,
      unblocked_by_general: row.unblocked_by_general ?? 0,
    };
  }

  // ── Daemon stats (persistent counters) ──────────────────────────────────

  private runDaemonStatsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_stats (
        key TEXT PRIMARY KEY,
        value_int INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Atomically increment a named integer counter.
   * Creates the counter at zero if it doesn't exist yet.
   */
  incrementStat(key: string, delta = 1): void {
    this.db
      .prepare(
        `INSERT INTO daemon_stats (key, value_int, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_int = value_int + excluded.value_int, updated_at = excluded.updated_at`,
      )
      .run(key, delta, new Date().toISOString());
  }

  /**
   * Read the current value of a named counter (returns 0 if not set yet).
   */
  getStat(key: string): number {
    const row = this.db
      .prepare("SELECT value_int FROM daemon_stats WHERE key = ?")
      .get(key) as { value_int: number } | undefined;
    return row?.value_int ?? 0;
  }

  // ── PR Creation Retry Queue ───────────────────────────────────────────────

  private runPRCreationRetryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_creation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempted_at TEXT,
        next_retry_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo, branch)
      );
      CREATE INDEX IF NOT EXISTS idx_pr_creation_attempts_status ON pr_creation_attempts(status);
      CREATE INDEX IF NOT EXISTS idx_pr_creation_attempts_next_retry ON pr_creation_attempts(next_retry_at)
        WHERE next_retry_at IS NOT NULL;
    `);
  }

  /**
   * Add completed_at column to processed_triggers for TTL-aware dedup.
   * completed_at records when the task associated with the trigger actually
   * finished, allowing the recency window to be anchored to task completion
   * rather than the dispatch timestamp.
   */
  private runProcessedTriggersCompletedAtMigration(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(processed_triggers)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("completed_at")) {
      this.db.exec(
        "ALTER TABLE processed_triggers ADD COLUMN completed_at TEXT",
      );
    }
  }

  /** Create the operator override table used for manual reroutes and boosts. */
  private runSourceRefControlsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_ref_controls (
        source TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        failure_history_cleared_at TEXT,
        failure_history_cleared_rowid INTEGER,
        priority_boosted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (source, source_ref)
      );
    `);

    const columns = this.db
      .prepare("PRAGMA table_info(source_ref_controls)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));
    if (!colNames.has("failure_history_cleared_rowid")) {
      this.db.exec("ALTER TABLE source_ref_controls ADD COLUMN failure_history_cleared_rowid INTEGER");
    }
  }

  private upsertSourceRefControl(
    source: string,
    sourceRef: string,
    updates: {
      failure_history_cleared_at?: string | null;
      failure_history_cleared_rowid?: number | null;
      priority_boosted_at?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO source_ref_controls
         (source, source_ref, failure_history_cleared_at, failure_history_cleared_rowid, priority_boosted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, source_ref) DO UPDATE SET
         failure_history_cleared_at = COALESCE(excluded.failure_history_cleared_at, source_ref_controls.failure_history_cleared_at),
         failure_history_cleared_rowid = COALESCE(excluded.failure_history_cleared_rowid, source_ref_controls.failure_history_cleared_rowid),
         priority_boosted_at = CASE
           WHEN excluded.priority_boosted_at IS NULL THEN source_ref_controls.priority_boosted_at
           ELSE excluded.priority_boosted_at
         END,
         updated_at = excluded.updated_at`,
    ).run(
      source,
      sourceRef,
      updates.failure_history_cleared_at ?? null,
      updates.failure_history_cleared_rowid ?? null,
      updates.priority_boosted_at ?? null,
      now,
      now,
    );
  }

  private getFailureHistoryClearedRowid(source: string, sourceRef: string): number | null {
    const row = this.db
      .prepare(
        "SELECT failure_history_cleared_rowid FROM source_ref_controls WHERE source = ? AND source_ref = ?",
      )
      .get(source, sourceRef) as { failure_history_cleared_rowid: number | null } | undefined;
    return row?.failure_history_cleared_rowid ?? null;
  }

  getFailureHistoryClearedAt(source: string, sourceRef: string): string | null {
    const row = this.db
      .prepare(
        "SELECT failure_history_cleared_at FROM source_ref_controls WHERE source = ? AND source_ref = ?",
      )
      .get(source, sourceRef) as { failure_history_cleared_at: string | null } | undefined;
    return row?.failure_history_cleared_at ?? null;
  }

  clearFailureHistoryForSourceRef(source: string, sourceRef: string, clearedAt = new Date().toISOString()): void {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM tasks WHERE source = ? AND source_ref = ? AND parent_task_id IS NULL",
      )
      .get(source, sourceRef) as { max_rowid: number };
    this.upsertSourceRefControl(source, sourceRef, {
      failure_history_cleared_at: clearedAt,
      failure_history_cleared_rowid: row.max_rowid,
    });
  }

  /**
   * Return distinct source_refs whose ALL recent failures are infrastructure
   * errors (connection errors, timeouts, aborted requests).  Source_refs that
   * also have genuine (non-infrastructure) failures are excluded to avoid
   * accidentally resetting their retry budget.
   *
   * Used by the daemon to clear failure history after proxy recovery.
   */
  getInfrastructureFailedSourceRefs(withinHours = 48): string[] {
    // Find source_refs with at least one infra failure...
    const withInfra = this.db
      .prepare(
        `SELECT DISTINCT source_ref FROM tasks
         WHERE status = 'failed'
           AND source_ref IS NOT NULL
           AND created_at > datetime('now', '-' || ? || ' hours')
           AND (result = 'Connection error.'
             OR result LIKE 'Request timed out%'
             OR result LIKE 'Request was aborted%'
             OR result LIKE 'Timed out: dispatched%')`,
      )
      .all(withinHours) as { source_ref: string }[];

    // ...then exclude any that ALSO have non-infrastructure failures in the same window
    return withInfra
      .filter(({ source_ref }) => {
        const nonInfra = this.db
          .prepare(
            `SELECT 1 FROM tasks
             WHERE status = 'failed'
               AND source_ref = ?
               AND created_at > datetime('now', '-' || ? || ' hours')
               AND result IS NOT NULL
               AND result != 'Connection error.'
               AND result NOT LIKE 'Request timed out%'
               AND result NOT LIKE 'Request was aborted%'
               AND result NOT LIKE 'Timed out: dispatched%'
               AND result NOT LIKE 'connection-error-exhausted%'
               AND result NOT LIKE 'Escalated after%Connection error%'
               AND result NOT LIKE 'Resolved externally:%'
               AND result NOT LIKE 'Auto-cleaned:%'
               AND result NOT LIKE 'Cleared:%'
             LIMIT 1`,
          )
          .get(source_ref, withinHours);
        return !nonInfra;
      })
      .map((r) => r.source_ref);
  }

  boostSourceRefPriority(source: string, sourceRef: string, boostedAt = new Date().toISOString()): void {
    this.upsertSourceRefControl(source, sourceRef, { priority_boosted_at: boostedAt });
  }

  clearSourceRefPriority(source: string, sourceRef: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE source_ref_controls
       SET priority_boosted_at = NULL, updated_at = ?
       WHERE source = ? AND source_ref = ?`,
    ).run(now, source, sourceRef);
  }

  isSourceRefPriorityBoosted(source: string, sourceRef: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM source_ref_controls WHERE source = ? AND source_ref = ? AND priority_boosted_at IS NOT NULL",
      )
      .get(source, sourceRef);
    return !!row;
  }

  /** Insert a new PR creation attempt record. */
  insertPRCreationAttempt(params: {
    repo: string;
    branch: string;
    attempt_count: number;
    last_error: string | null;
    last_attempted_at: string | null;
    next_retry_at: string | null;
    status: PRCreationAttemptStatus;
  }): PRCreationAttempt {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_creation_attempts
           (repo, branch, attempt_count, last_error, last_attempted_at, next_retry_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, branch) DO NOTHING`,
      )
      .run(
        params.repo,
        params.branch,
        params.attempt_count,
        params.last_error,
        params.last_attempted_at,
        params.next_retry_at,
        params.status,
        now,
        now,
      );
    return this.getPRCreationAttempt(params.repo, params.branch)!;
  }

  /** Retrieve a single PR creation attempt by repo + branch. */
  getPRCreationAttempt(repo: string, branch: string): PRCreationAttempt | undefined {
    return this.db
      .prepare("SELECT * FROM pr_creation_attempts WHERE repo = ? AND branch = ?")
      .get(repo, branch) as PRCreationAttempt | undefined;
  }

  /** Update an existing PR creation attempt record. */
  updatePRCreationAttempt(
    repo: string,
    branch: string,
    updates: Partial<Pick<PRCreationAttempt, "attempt_count" | "last_error" | "last_attempted_at" | "next_retry_at" | "status">>,
  ): void {
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        params.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(repo);
    params.push(branch);

    this.db
      .prepare(`UPDATE pr_creation_attempts SET ${fields.join(", ")} WHERE repo = ? AND branch = ?`)
      .run(...params);
  }

  /**
   * Return all pending PR creation attempts whose `next_retry_at` has elapsed.
   * These are ready to be retried this cycle.
   */
  getDuePRCreationAttempts(): PRCreationAttempt[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM pr_creation_attempts
         WHERE status = 'pending'
           AND next_retry_at IS NOT NULL
           AND next_retry_at <= ?
         ORDER BY next_retry_at ASC`,
      )
      .all(now) as PRCreationAttempt[];
  }

  /**
   * Reset permanently-failed PR creation attempts whose last error indicates
   * a GH auth failure back to "pending" so they are retried when auth recovers.
   *
   * Returns the number of entries reset.
   */
  resetAuthFailedPRCreationAttempts(): number {
    const backoffMs = 60_000; // 1 minute — short, since auth just recovered
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE pr_creation_attempts
         SET status = 'pending',
             attempt_count = 0,
             next_retry_at = ?
         WHERE status = 'failed'
           AND last_error LIKE '%gh-auth-failed%'`,
      )
      .run(nextRetryAt);
    return result.changes;
  }

  /**
   * Aggregate telemetry across all tracked PR creation attempts.
   */
  getPRCreationTelemetry(): PRCreationTelemetry {
    const summary = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_branches,
           COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(attempt_count), 0) AS total_attempts
         FROM pr_creation_attempts`,
      )
      .get() as {
        total_branches: number;
        pending: number;
        succeeded: number;
        failed: number;
        total_attempts: number;
      };

    const successRate =
      summary.total_branches > 0 ? summary.succeeded / summary.total_branches : null;

    // Top error messages by frequency (non-null errors only)
    const errorRows = this.db
      .prepare(
        `SELECT last_error AS error, COUNT(*) AS count
         FROM pr_creation_attempts
         WHERE last_error IS NOT NULL
         GROUP BY last_error
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all() as Array<{ error: string; count: number }>;

    return {
      ...summary,
      success_rate: successRate,
      top_errors: errorRows,
    };
  }

  /**
   * Compute full timeout analytics for the last `days` days.
   *
   * Returns per-agent stats (timeout rate, avg/p95 duration, suggested timeout),
   * plus a list of individual tasks that timed out (retry_count > 0) in the window.
   *
   * The p95 duration is derived from completed (status='done') tasks using the
   * ROW_NUMBER window function to find the 95th percentile value.
   *
   * Suggested timeout = ceil(p95 * 1.2) rounded up to the nearest minute,
   * with a minimum of 5 minutes.
   */
  getTimeoutAnalytics(days: number): TimeoutAnalytics {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Per-agent stats joined with p95 duration from completed tasks
    const agentRows = this.db
      .prepare(
        `WITH base AS (
           SELECT
             agent_name,
             status,
             retry_count,
             (julianday(updated_at) - julianday(created_at)) * 86400000.0 AS duration_ms
           FROM tasks
           WHERE parent_task_id IS NULL
             AND agent_name IS NOT NULL
             AND created_at >= ?
         ),
         done_ranked AS (
           SELECT
             agent_name,
             duration_ms,
             ROW_NUMBER() OVER (PARTITION BY agent_name ORDER BY duration_ms ASC) AS rn,
             COUNT(*) OVER (PARTITION BY agent_name) AS n
           FROM base
           WHERE status = 'done'
         ),
         p95_vals AS (
           SELECT agent_name, duration_ms AS p95_duration_ms
           FROM done_ranked
           WHERE rn = CAST(CEIL(0.95 * CAST(n AS REAL)) AS INTEGER)
         ),
         agg AS (
           SELECT
             agent_name,
             COUNT(*) AS total_tasks,
             COALESCE(SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END), 0) AS timed_out_tasks,
             AVG(CASE WHEN status = 'done' THEN duration_ms END) AS avg_duration_ms
           FROM base
           GROUP BY agent_name
         )
         SELECT a.agent_name, a.total_tasks, a.timed_out_tasks, a.avg_duration_ms,
                p.p95_duration_ms
         FROM agg a
         LEFT JOIN p95_vals p ON a.agent_name = p.agent_name
         ORDER BY a.timed_out_tasks DESC, a.total_tasks DESC`,
      )
      .all(since) as Array<{
        agent_name: string;
        total_tasks: number;
        timed_out_tasks: number;
        avg_duration_ms: number | null;
        p95_duration_ms: number | null;
      }>;

    // Individual timed-out tasks in the window
    const timedOutTasks = this.db
      .prepare(
        `SELECT id, title, agent_name, retry_count, status, created_at, updated_at,
                (julianday(updated_at) - julianday(created_at)) * 86400000.0 AS duration_ms
         FROM tasks
         WHERE parent_task_id IS NULL
           AND retry_count > 0
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 50`,
      )
      .all(since) as Array<{
        id: string;
        title: string;
        agent_name: string;
        retry_count: number;
        status: string;
        created_at: string;
        updated_at: string;
        duration_ms: number | null;
      }>;

    const per_agent: AgentTimeoutAnalytics[] = agentRows.map((r) => {
      const suggested =
        r.p95_duration_ms !== null
          ? Math.max(
              Math.ceil((r.p95_duration_ms * 1.2) / 60000) * 60000,
              5 * 60 * 1000,
            )
          : null;
      return {
        agent_name: r.agent_name,
        total_tasks: r.total_tasks,
        timed_out_tasks: r.timed_out_tasks,
        timeout_rate_pct:
          r.total_tasks > 0 ? (r.timed_out_tasks / r.total_tasks) * 100 : null,
        avg_duration_ms: r.avg_duration_ms,
        p95_duration_ms: r.p95_duration_ms,
        suggested_timeout_ms: suggested,
      };
    });

    const timeout_tasks: TimeoutTaskRecord[] = timedOutTasks.map((r) => ({
      id: r.id,
      title: r.title,
      agent_name: r.agent_name,
      retry_count: r.retry_count,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      duration_ms: r.duration_ms,
    }));

    const total_timed_out = per_agent.reduce((s, a) => s + a.timed_out_tasks, 0);
    const total_tasks = per_agent.reduce((s, a) => s + a.total_tasks, 0);

    return { days, per_agent, timeout_tasks, total_timed_out, total_tasks };
  }

  /**
   * Return per-agent timeout rates for the last `hours` hours.
   *
   * A "timeout" is any task with retry_count > 0, which indicates the
   * dispatcher's automatic retry-with-backoff mechanism fired (triggered by
   * exit-code-143 / SIGTERM from the proxy).
   *
   * Only top-level tasks (parent_task_id IS NULL) with an assigned agent are
   * counted. The denominator is all tasks whose created_at falls within the
   * window so the rate reflects the actual dispatch period, not just retried tasks.
   *
   * Agents with zero tasks in the window are excluded from the result.
   */
  getTimeoutRates(hours: number): AgentTimeoutRate[] {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT
           agent_name,
           COUNT(*) AS total_tasks,
           COALESCE(SUM(CASE WHEN retry_count > 0 THEN 1 ELSE 0 END), 0) AS timed_out_tasks
         FROM tasks
         WHERE created_at >= ?
           AND parent_task_id IS NULL
           AND agent_name IS NOT NULL
         GROUP BY agent_name
         ORDER BY agent_name`,
      )
      .all(since) as Array<{
        agent_name: string;
        total_tasks: number;
        timed_out_tasks: number;
      }>;

    return rows.map((r) => ({
      agent_name: r.agent_name,
      total_tasks: r.total_tasks,
      timed_out_tasks: r.timed_out_tasks,
      timeout_rate_pct: r.total_tasks > 0 ? (r.timed_out_tasks / r.total_tasks) * 100 : null,
    }));
  }

  // ── Directives ────────────────────────────────────────────────────────────

  private runDirectivesMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS directives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_directives_created ON directives(created_at);
    `);
  }

  /**
   * Persist a new behavioral directive. Returns the stored record.
   */
  addDirective(text: string): Directive {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      "INSERT INTO directives (text, created_at) VALUES (?, ?)",
    );
    const result = stmt.run(text.trim(), now);
    return {
      id: result.lastInsertRowid as number,
      text: text.trim(),
      created_at: now,
    };
  }

  /**
   * Remove a directive by id. Silently succeeds if the id doesn't exist.
   */
  removeDirective(id: number): void {
    this.db.prepare("DELETE FROM directives WHERE id = ?").run(id);
  }

  /**
   * Return all stored directives, oldest first.
   */
  listDirectives(): Directive[] {
    return this.db
      .prepare("SELECT * FROM directives ORDER BY created_at ASC")
      .all() as Directive[];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Agent health tracking (pool failover routing — issue #385)
  // ────────────────────────────────────────────────────────────────────────

  private runAgentHealthMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_health (
        agent_name TEXT PRIMARY KEY,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_error_at TEXT,
        last_error_message TEXT,
        last_success_at TEXT
      );
    `);

    // Migration: add auth_status and auth_degraded_at columns (issue #418)
    const colCheck = this.db.prepare("PRAGMA table_info(agent_health)").all() as Array<{ name: string }>;
    const colNames = new Set(colCheck.map((c) => c.name));
    if (!colNames.has("auth_status")) {
      this.db.exec(`
        ALTER TABLE agent_health ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'ok';
        ALTER TABLE agent_health ADD COLUMN auth_degraded_at TEXT;
      `);
    }
  }

  /**
   * Record a successful dispatch for an agent, resetting its failure count.
   */
  recordAgentSuccess(agentName: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_health (agent_name, consecutive_failures, last_error_at, last_error_message, last_success_at)
      VALUES (?, 0, NULL, NULL, ?)
      ON CONFLICT(agent_name) DO UPDATE SET
        consecutive_failures = 0,
        last_success_at = ?
    `).run(agentName, now, now);
  }

  /**
   * Record a dispatch failure for an agent, incrementing its consecutive failure count.
   */
  recordAgentFailure(agentName: string, errorMessage: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_health (agent_name, consecutive_failures, last_error_at, last_error_message, last_success_at)
      VALUES (?, 1, ?, ?, NULL)
      ON CONFLICT(agent_name) DO UPDATE SET
        consecutive_failures = consecutive_failures + 1,
        last_error_at = ?,
        last_error_message = ?
    `).run(agentName, now, errorMessage, now, errorMessage);
  }

  /**
   * Get health status for a specific agent. Returns a default healthy record
   * if no health data exists (agent has never been dispatched to).
   */
  getAgentHealth(agentName: string): AgentHealth {
    const row = this.db.prepare(
      "SELECT * FROM agent_health WHERE agent_name = ?"
    ).get(agentName) as {
      agent_name: string;
      consecutive_failures: number;
      last_error_at: string | null;
      last_error_message: string | null;
      last_success_at: string | null;
      auth_status: string;
      auth_degraded_at: string | null;
    } | undefined;

    if (!row) {
      return {
        agent_name: agentName,
        consecutive_failures: 0,
        last_error_at: null,
        last_error_message: null,
        last_success_at: null,
        is_healthy: true,
        auth_status: "ok",
        auth_degraded_at: null,
      };
    }

    return {
      ...row,
      is_healthy: row.consecutive_failures < 3,
      auth_status: (row.auth_status as AgentAuthStatus) ?? "ok",
    };
  }

  /**
   * Get health status for multiple agents at once.
   */
  getAgentHealthBatch(agentNames: string[]): AgentHealth[] {
    return agentNames.map((name) => this.getAgentHealth(name));
  }

  // ────────────────────────────────────────────────────────────────────────
  // Agent auth quarantine (GH_TOKEN validation — issue #418)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Mark an agent as auth-degraded (GH_TOKEN missing/invalid).
   * Auth-degraded agents can only receive research/analysis tasks.
   */
  setAgentAuthDegraded(agentName: string, reason: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_health (agent_name, consecutive_failures, auth_status, auth_degraded_at, last_error_at, last_error_message)
      VALUES (?, 0, 'auth-degraded', ?, ?, ?)
      ON CONFLICT(agent_name) DO UPDATE SET
        auth_status = 'auth-degraded',
        auth_degraded_at = COALESCE(agent_health.auth_degraded_at, ?),
        last_error_at = ?,
        last_error_message = ?
    `).run(agentName, now, now, reason, now, now, reason);
  }

  /**
   * Clear auth-degraded status for an agent (auth has recovered).
   */
  clearAgentAuthDegraded(agentName: string): void {
    this.db.prepare(`
      UPDATE agent_health
      SET auth_status = 'ok', auth_degraded_at = NULL
      WHERE agent_name = ?
    `).run(agentName);
  }

  /**
   * Check if a specific agent is in auth-degraded state.
   */
  isAgentAuthDegraded(agentName: string): boolean {
    const health = this.getAgentHealth(agentName);
    return health.auth_status === "auth-degraded";
  }

  /**
   * Get all agents currently in auth-degraded state.
   */
  getAuthDegradedAgents(): AgentHealth[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_health WHERE auth_status = 'auth-degraded'"
    ).all() as Array<{
      agent_name: string;
      consecutive_failures: number;
      last_error_at: string | null;
      last_error_message: string | null;
      last_success_at: string | null;
      auth_status: string;
      auth_degraded_at: string | null;
    }>;
    return rows.map((row) => ({
      ...row,
      is_healthy: row.consecutive_failures < 3,
      auth_status: row.auth_status as AgentAuthStatus,
    }));
  }

  /**
   * Aggregate token usage per agent over a rolling time window.
   *
   * Sums tokens_in + tokens_out from token_usage for the given window, grouped
   * by agent_name. Only rows with a non-null agent_name are included. Returns
   * one row per agent, sorted by total_tokens descending (heaviest consumers first).
   *
   * @param windowHours Number of hours to look back from now (e.g. 24 for daily, 168 for weekly).
   */
  getAgentTokenUsage(windowHours: number): AgentTokenUsage[] {
    const rows = this.db.prepare(`
      SELECT
        agent_name,
        COALESCE(SUM(COALESCE(tokens_in,  0)), 0) AS input_tokens,
        COALESCE(SUM(COALESCE(tokens_out, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(tokens_in,  0) + COALESCE(tokens_out, 0)), 0) AS total_tokens
      FROM token_usage
      WHERE agent_name IS NOT NULL
        AND recorded_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY agent_name
      ORDER BY total_tokens DESC
    `).all(windowHours) as Array<{
      agent_name: string;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
    }>;
    return rows;
  }

  // ── Revision count migration ──────────────────────────────────────────────

  private runRevisionCountMigration(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));

    if (!colNames.has("revision_count")) {
      this.db.exec(`
        ALTER TABLE tasks ADD COLUMN revision_count INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX IF NOT EXISTS idx_tasks_revision_count ON tasks(revision_count) WHERE revision_count >= 2;
      `);
    }
  }

  // ── Token usage table (provider-level tracking) ────────────────────────

  private runTokenUsageMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        agent_name TEXT,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_recorded_at ON token_usage(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_token_usage_agent_name ON token_usage(agent_name);
      CREATE INDEX IF NOT EXISTS idx_token_usage_provider ON token_usage(provider, recorded_at);
    `);
  }

  private runTokenUsageCacheMigration(): void {
    const cols = this.db.prepare("PRAGMA table_info(token_usage)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("cache_read_tokens")) {
      this.db.exec(`
        ALTER TABLE token_usage ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE token_usage ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
      `);
    }
  }

  /**
   * Aggregate token usage per provider over a rolling time window.
   * Returns one row per provider, sorted by total descending.
   */
  getTokenUsageByProvider(windowHours: number): Array<{
    provider: string;
    total: number;
    request_count: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
  }> {
    return this.db.prepare(`
      SELECT
        provider,
        COALESCE(SUM(tokens_in + tokens_out), 0) AS total,
        COUNT(*) AS request_count,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens
      FROM token_usage
      WHERE recorded_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY provider
      ORDER BY total DESC
    `).all(windowHours) as Array<{
      provider: string;
      total: number;
      request_count: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
    }>;
  }

  /**
   * Aggregate token usage per agent over a rolling time window (from token_usage table).
   * Returns one row per agent, sorted by total descending.
   */
  getTokenUsageByAgent(windowHours: number): Array<{ agent_name: string; provider: string; total: number }> {
    return this.db.prepare(`
      SELECT
        agent_name,
        provider,
        COALESCE(SUM(tokens_in + tokens_out), 0) AS total
      FROM token_usage
      WHERE agent_name IS NOT NULL
        AND recorded_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY agent_name, provider
      ORDER BY total DESC
    `).all(windowHours) as Array<{ agent_name: string; provider: string; total: number }>;
  }

  /**
   * Aggregate token usage per agent/provider over a rolling time window.
   * Includes cache metrics so spend can be estimated more accurately.
   */
  getAgentTokenUsageDetail(windowHours: number): AgentTokenUsageDetail[] {
    return this.db.prepare(`
      SELECT
        agent_name,
        provider,
        COALESCE(SUM(COALESCE(tokens_in, 0)), 0) AS input_tokens,
        COALESCE(SUM(COALESCE(tokens_out, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS total_tokens,
        COALESCE(SUM(COALESCE(cache_read_tokens, 0)), 0) AS cache_read_tokens,
        COALESCE(SUM(COALESCE(cache_creation_tokens, 0)), 0) AS cache_creation_tokens
      FROM token_usage
      WHERE agent_name IS NOT NULL
        AND recorded_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY agent_name, provider
      ORDER BY total_tokens DESC
    `).all(windowHours) as AgentTokenUsageDetail[];
  }

  /**
   * Daily token totals per agent/provider for sparkline trend rendering.
   */
  getDailyTokenUsageByAgent(days: number): AgentDailyTokenUsage[] {
    return this.db.prepare(`
      SELECT
        date(recorded_at) AS date,
        agent_name,
        provider,
        COALESCE(SUM(COALESCE(tokens_in, 0)), 0) AS input_tokens,
        COALESCE(SUM(COALESCE(tokens_out, 0)), 0) AS output_tokens,
        COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS total_tokens
      FROM token_usage
      WHERE agent_name IS NOT NULL
        AND recorded_at >= datetime('now', '-' || ? || ' days')
      GROUP BY date(recorded_at), agent_name, provider
      ORDER BY date ASC, total_tokens DESC
    `).all(days) as AgentDailyTokenUsage[];
  }

  private static inferFleet(agentName: string | null, provider: string | null): FleetComparisonProvider | null {
    const lowerAgent = agentName?.toLowerCase() ?? "";
    if (lowerAgent.startsWith("claude")) return "claude";
    if (lowerAgent.startsWith("codex")) return "codex";

    const lowerProvider = provider?.toLowerCase() ?? "";
    if (lowerProvider === "anthropic" || lowerProvider === "claude") return "claude";
    if (lowerProvider === "codex" || lowerProvider === "openai") return "codex";
    return null;
  }

  /**
   * Compare Claude and Codex fleets over a rolling time window.
   *
   * Tasks are grouped by agent-name prefix, and token usage is grouped by
   * either agent-name prefix or provider label when agent names are absent.
   */
  getFleetComparison(days = 7): FleetComparisonMetrics {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const taskRows = this.db.prepare(`
      SELECT agent_name, status, quality_score, verification_status
      FROM tasks
      WHERE parent_task_id IS NULL
        AND agent_name IS NOT NULL
        AND created_at >= ?
    `).all(since) as Array<{
      agent_name: string;
      status: string;
      quality_score: number | null;
      verification_status: VerificationStatus;
    }>;

    const tokenRows = this.db.prepare(`
      SELECT provider, agent_name, tokens_in, tokens_out
      FROM token_usage
      WHERE recorded_at >= ?
    `).all(since) as Array<{
      provider: string;
      agent_name: string | null;
      tokens_in: number;
      tokens_out: number;
    }>;

    const tokenSourceRows: Array<{
      agent_name: string | null;
      provider?: string | null;
      tokens_in: number;
      tokens_out: number;
    }> =
      tokenRows.length > 0
        ? tokenRows.map((row) => ({
            agent_name: row.agent_name,
            provider: row.provider,
            tokens_in: row.tokens_in,
            tokens_out: row.tokens_out,
          }))
        : this.db.prepare(`
            SELECT agent_name, tokens_in, tokens_out
            FROM task_logs
            WHERE (tokens_in > 0 OR tokens_out > 0)
              AND created_at >= ?
          `).all(since) as Array<{
            agent_name: string | null;
            tokens_in: number;
            tokens_out: number;
          }>;

    type FleetComparisonAccumulator = FleetComparisonEntry & { quality_samples: number };
    const baseRow = (provider: FleetComparisonProvider, label: string): FleetComparisonAccumulator => ({
      provider,
      label,
      tasks_completed: 0,
      tasks_failed: 0,
      tasks_attempted: 0,
      success_rate: null,
      avg_quality_score: null,
      tokens_in: 0,
      tokens_out: 0,
      total_tokens: 0,
      records: 0,
      quality_samples: 0,
    });

    const rowsByProvider = new Map<FleetComparisonProvider, FleetComparisonAccumulator>([
      ["claude", baseRow("claude", "Claude")],
      ["codex", baseRow("codex", "Codex")],
    ]);

    for (const task of taskRows) {
      const provider = StateStore.inferFleet(task.agent_name, null);
      if (!provider) continue;
      const row = rowsByProvider.get(provider)!;
      if (task.status === "done") row.tasks_completed += 1;
      if (task.status === "failed") row.tasks_failed += 1;
      if (task.verification_status !== null && task.quality_score !== null) {
        row.quality_samples += 1;
        row.avg_quality_score =
          row.avg_quality_score === null
            ? task.quality_score
            : (row.avg_quality_score * (row.quality_samples - 1) + task.quality_score) / row.quality_samples;
      }
    }

    for (const token of tokenSourceRows) {
      const provider = StateStore.inferFleet(token.agent_name, token.provider ?? null);
      if (!provider) continue;
      const row = rowsByProvider.get(provider)!;
      row.tokens_in += token.tokens_in;
      row.tokens_out += token.tokens_out;
      row.total_tokens += token.tokens_in + token.tokens_out;
      row.records += 1;
    }

    return {
      days,
      rows: (["claude", "codex"] as const).map((provider) => {
        const row = rowsByProvider.get(provider)!;
        row.tasks_attempted = row.tasks_completed + row.tasks_failed;
        row.success_rate = row.tasks_attempted > 0 ? row.tasks_completed / row.tasks_attempted : null;
        const { quality_samples, ...rest } = row;
        return rest;
      }),
    };
  }

  // ── Stuck issues ─────────────────────────────────────────────────────────

  /**
   * Return issues that have gone through multiple revision cycles (revision_count >= threshold).
   * Groups tasks by source_ref and returns the aggregate revision history.
   *
   * Only considers tasks with a non-null source_ref and looks at the maximum
   * revision_count across all tasks sharing that source_ref.
   */
  getStuckIssues(threshold = 2): StuckIssue[] {
    // Find source_refs where any task has revision_count >= threshold
    const refs = this.db.prepare(`
      SELECT DISTINCT source_ref
      FROM tasks
      WHERE source_ref IS NOT NULL
        AND revision_count >= ?
        AND parent_task_id IS NULL
    `).all(threshold) as Array<{ source_ref: string }>;

    if (refs.length === 0) return [];

    const results: StuckIssue[] = [];

    for (const { source_ref } of refs) {
      // Get all tasks for this source_ref, chronologically
      const tasks = this.db.prepare(`
        SELECT id, title, agent_name, quality_score, revision_count, updated_at
        FROM tasks
        WHERE source_ref = ?
          AND parent_task_id IS NULL
        ORDER BY created_at ASC
      `).all(source_ref) as Array<{
        id: string;
        title: string;
        agent_name: string | null;
        quality_score: number | null;
        revision_count: number;
        updated_at: string;
      }>;

      if (tasks.length === 0) continue;

      const maxRevisionCount = Math.max(...tasks.map((t) => t.revision_count));
      if (maxRevisionCount < threshold) continue;

      const lastTask = tasks[tasks.length - 1];
      results.push({
        source_ref,
        revision_count: maxRevisionCount,
        agent_name: lastTask.agent_name,
        quality_scores: tasks.map((t) => t.quality_score),
        task_ids: tasks.map((t) => t.id),
        titles: tasks.map((t) => t.title),
        last_attempt_at: lastTask.updated_at,
      });
    }

    // Sort by revision_count descending (most stuck first)
    results.sort((a, b) => b.revision_count - a.revision_count);
    return results;
  }

  // ── Iteration cost metrics (issue #748) ──────────────────────────────────

  /**
   * Per-agent rolling average of revision_count across recent non-research tasks.
   *
   * Returns one row per agent that has >= minTasks completed/failed/escalated
   * implementation tasks, ordered by avg_revision_count descending.
   *
   * @param windowDays - How many calendar days of history to consider (default 30).
   * @param minTasks   - Minimum task count before the metric is meaningful (default 10).
   */
  getAgentIterationCostMetrics(
    windowDays = 30,
    minTasks = 10,
  ): Array<{
    agent_name: string;
    task_count: number;
    avg_revision_count: number;
    /** Up to 3 task IDs with the highest revision_count (sample evidence). */
    sample_task_ids: string[];
  }> {
    const rows = this.db.prepare(`
      SELECT
        agent_name,
        COUNT(*)                    AS task_count,
        AVG(revision_count)         AS avg_revision_count
      FROM tasks
      WHERE agent_name IS NOT NULL
        AND parent_task_id IS NULL
        AND task_type != 'research'
        AND status IN ('done', 'failed', 'escalated')
        AND created_at >= datetime('now', ? || ' days')
      GROUP BY agent_name
      HAVING COUNT(*) >= ?
      ORDER BY avg_revision_count DESC
    `).all(`-${windowDays}`, minTasks) as Array<{
      agent_name: string;
      task_count: number;
      avg_revision_count: number;
    }>;

    return rows.map((row) => {
      // Fetch up to 3 high-revision example tasks for evidence
      const sampleRows = this.db.prepare(`
        SELECT id
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND task_type != 'research'
          AND status IN ('done', 'failed', 'escalated')
          AND created_at >= datetime('now', ? || ' days')
        ORDER BY revision_count DESC, created_at DESC
        LIMIT 3
      `).all(row.agent_name, `-${windowDays}`) as Array<{ id: string }>;

      return {
        agent_name: row.agent_name,
        task_count: row.task_count,
        avg_revision_count: row.avg_revision_count,
        sample_task_ids: sampleRows.map((r) => r.id),
      };
    });
  }

  // ── Iteration cost leaderboard (issue #763) ─────────────────────────────

  /**
   * Return the top-N most expensive issues by cumulative revision count.
   *
   * Groups tasks by source_ref (GitHub issue / PR reference) and sums all
   * revision rounds across every task attempt for that issue.  Returns the
   * worst offenders first so they can be surfaced in the `orch cost` view
   * and used to trigger budget alerts when a ceiling is exceeded.
   *
   * @param limit     - Max rows to return (default 10).
   * @param windowDays - Look-back window in calendar days (default 30). Pass 0 for all-time.
   * @param agentName  - Optional filter to a single agent.
   */
  getIterationCostLeaderboard(
    limit = 10,
    windowDays = 30,
    agentName?: string,
  ): Array<{
    source_ref: string;
    total_revisions: number;
    task_count: number;
    agent_name: string | null;
    /** Labels attached to the source GitHub issue (parsed from title/source_ref). */
    labels: string[];
    avg_quality_score: number | null;
    last_updated_at: string;
  }> {
    // Build the query dynamically so we can conditionally add filters
    // while keeping all values as bound parameters (no string interpolation of user data).
    const conditions: string[] = [
      "t.source_ref IS NOT NULL",
      "t.parent_task_id IS NULL",
    ];
    const params: (string | number)[] = [];

    if (windowDays > 0) {
      conditions.push(`t.created_at >= datetime('now', '-' || ? || ' days')`);
      params.push(windowDays);
    }
    if (agentName) {
      conditions.push("t.agent_name = ?");
      params.push(agentName);
    }
    params.push(limit);

    const rows = this.db.prepare(`
      SELECT
        t.source_ref,
        SUM(t.revision_count)                             AS total_revisions,
        COUNT(*)                                          AS task_count,
        MAX(t.agent_name)                                 AS agent_name,
        AVG(CASE WHEN t.quality_score IS NOT NULL THEN t.quality_score END) AS avg_quality_score,
        MAX(t.updated_at)                                 AS last_updated_at
      FROM tasks t
      WHERE ${conditions.join(" AND ")}
      GROUP BY t.source_ref
      HAVING SUM(t.revision_count) >= 1
      ORDER BY total_revisions DESC, last_updated_at DESC
      LIMIT ?
    `).all(...params) as Array<{
      source_ref: string;
      total_revisions: number;
      task_count: number;
      agent_name: string | null;
      avg_quality_score: number | null;
      last_updated_at: string;
    }>;

    return rows.map((row) => ({
      ...row,
      // Labels can't be reliably parsed from SQLite so we return an empty
      // array here; callers may enrich this via the GitHub API if needed.
      labels: [],
    }));
  }

  /**
   * Return all issues whose total revision count exceeds `ceiling`.
   *
   * Used by the iteration budget alert to fire Telegram alerts when a
   * single issue accumulates too many revision rounds.
   *
   * @param ceiling   - Revision count above which an issue is "over budget" (default 3).
   * @param windowDays - Look-back window in calendar days (default 30).
   */
  getOverBudgetIssues(
    ceiling = 3,
    windowDays = 30,
  ): Array<{
    source_ref: string;
    total_revisions: number;
    agent_name: string | null;
    last_updated_at: string;
  }> {
    const conditions: string[] = [
      "source_ref IS NOT NULL",
      "parent_task_id IS NULL",
    ];
    const params: (string | number)[] = [];

    if (windowDays > 0) {
      conditions.push(`created_at >= datetime('now', '-' || ? || ' days')`);
      params.push(windowDays);
    }
    params.push(ceiling);

    return this.db.prepare(`
      SELECT
        source_ref,
        SUM(revision_count) AS total_revisions,
        MAX(agent_name)     AS agent_name,
        MAX(updated_at)     AS last_updated_at
      FROM tasks
      WHERE ${conditions.join(" AND ")}
      GROUP BY source_ref
      HAVING SUM(revision_count) > ?
      ORDER BY total_revisions DESC
    `).all(...params) as Array<{
      source_ref: string;
      total_revisions: number;
      agent_name: string | null;
      last_updated_at: string;
    }>;
  }

  // ── Unified reliability score (issue #758) ──────────────────────────────

  /**
   * Compute unified agent reliability scores (0–100) combining three components:
   * 1. Crash frequency (consecutive failures)
   * 2. Iteration cost (avg revision rounds per PR)
   * 3. Antibody hit rate (approval rate: approved/(approved+rejected))
   *
   * Formula (weighted):
   *   reliability_score = 100 - [
   *     crash_penalty(40%)  +
   *     iteration_penalty(30%) +
   *     antibody_penalty(30%)
   *   ]
   *
   * Clamped to [0, 100].
   *
   * @param windowDays - How many calendar days of history to consider (default 30).
   * @returns Array of AgentReliabilityScore, ordered by reliability_score DESC.
   */
  getAgentReliabilityScores(windowDays = 30): AgentReliabilityScore[] {
    // 1. Get all agents with recent tasks
    const agents = this.db.prepare(`
      SELECT DISTINCT agent_name
      FROM tasks
      WHERE agent_name IS NOT NULL
        AND parent_task_id IS NULL
        AND created_at >= datetime('now', ? || ' days')
      ORDER BY agent_name
    `).all(`-${windowDays}`) as Array<{ agent_name: string }>;

    const results: AgentReliabilityScore[] = [];

    for (const { agent_name } of agents) {
      // 2. Get crash frequency (consecutive failures)
      const health = this.getAgentHealth(agent_name);
      const crashPenalty = Math.min(health.consecutive_failures * 10, 40); // Max 40% penalty (4+ failures)

      // 3. Get iteration cost (avg revision_count in window)
      const iterationData = this.db.prepare(`
        SELECT
          AVG(revision_count) AS avg_revision_count,
          COUNT(*) AS task_count
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND task_type != 'research'
          AND status IN ('done', 'failed', 'escalated')
          AND created_at >= datetime('now', ? || ' days')
      `).get(agent_name, `-${windowDays}`) as { avg_revision_count: number | null; task_count: number } | undefined;

      const avgIterationCost = iterationData?.avg_revision_count ?? null;
      // Iteration cost: >2 rounds = max penalty, 1 round = no penalty
      const iterationPenalty = avgIterationCost ? Math.min(Math.max(avgIterationCost - 1, 0) * 15, 30) : 0;

      // 4. Get antibody hit rate (approval rate)
      const antibodyData = this.db.prepare(`
        SELECT
          COALESCE(
            SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) * 1.0 /
            NULLIF(SUM(CASE WHEN verification_status IN ('approved', 'rejected') THEN 1 ELSE 0 END), 0),
            1.0
          ) AS approval_rate
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND verification_status IS NOT NULL
          AND created_at >= datetime('now', ? || ' days')
      `).get(agent_name, `-${windowDays}`) as { approval_rate: number } | undefined;

      const approvalRate = antibodyData?.approval_rate ?? null;
      // Antibody penalty: if approval_rate is low (rejected a lot), penalize
      const antibodyPenalty = approvalRate !== null ? Math.max((1 - approvalRate) * 30, 0) : 0;

      // 5. Calculate composite score
      const totalPenalty = crashPenalty + iterationPenalty + antibodyPenalty;
      const reliabilityScore = Math.max(0, Math.min(100 - totalPenalty, 100));

      // 6. Get trend direction
      const trend = this.getAgentScoreTrend(agent_name);

      results.push({
        agent_name,
        reliability_score: reliabilityScore,
        consecutive_failures: health.consecutive_failures,
        avg_iteration_cost: avgIterationCost,
        antibody_hit_rate: approvalRate,
        trend: trend.direction,
      });
    }

    // Sort by reliability_score descending (healthiest first)
    results.sort((a, b) => b.reliability_score - a.reliability_score);
    return results;
  }

  /**
   * Get daily reliability scores for the last N days (for sparkline trending).
   *
   * This recomputes scores for each day in the window, giving a time-series
   * of how reliability has trended.
   *
   * @param agentName - Agent to fetch trend for.
   * @param windowDays - How many calendar days of history (default 7 for dashboard sparkline).
   * @returns Array of DailyReliabilityScore in chronological order.
   */
  getAgentReliabilityTrend(agentName: string, windowDays = 7): DailyReliabilityScore[] {
    // Generate date range for the window
    const dates: string[] = [];
    for (let i = windowDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      dates.push(d.toISOString().split("T")[0]);
    }

    const results: DailyReliabilityScore[] = [];

    for (const date of dates) {
      const dayStart = `${date}T00:00:00Z`;
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();

      // Get health on that day
      const health = this.db.prepare(`
        SELECT consecutive_failures FROM agent_health
        WHERE agent_name = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(agentName) as { consecutive_failures: number } | undefined;

      const crashPenalty = (health?.consecutive_failures ?? 0) * 10;

      // Get iteration cost on that day
      const iterationData = this.db.prepare(`
        SELECT AVG(revision_count) AS avg_revision_count
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND task_type != 'research'
          AND status IN ('done', 'failed', 'escalated')
          AND created_at >= ? AND created_at < ?
      `).get(agentName, dayStart, dayEnd) as { avg_revision_count: number | null } | undefined;

      const avgIterationCost = iterationData?.avg_revision_count ?? null;
      const iterationPenalty = avgIterationCost ? Math.min(Math.max(avgIterationCost - 1, 0) * 15, 30) : 0;

      // Get antibody rate on that day
      const antibodyData = this.db.prepare(`
        SELECT
          COALESCE(
            SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) * 1.0 /
            NULLIF(SUM(CASE WHEN verification_status IN ('approved', 'rejected') THEN 1 ELSE 0 END), 0),
            1.0
          ) AS approval_rate
        FROM tasks
        WHERE agent_name = ?
          AND parent_task_id IS NULL
          AND verification_status IS NOT NULL
          AND created_at >= ? AND created_at < ?
      `).get(agentName, dayStart, dayEnd) as { approval_rate: number } | undefined;

      const approvalRate = antibodyData?.approval_rate ?? null;
      const antibodyPenalty = approvalRate !== null ? Math.max((1 - approvalRate) * 30, 0) : 0;

      const totalPenalty = Math.min(crashPenalty, 40) + iterationPenalty + antibodyPenalty;
      const score = Math.max(0, Math.min(100 - totalPenalty, 100));

      results.push({
        date,
        agent_name: agentName,
        reliability_score: score,
      });
    }

    return results;
  }

  // ── Dispatch efficiency / waste-rate widget (issue #517) ────────────────

  private runDispatchWasteMigration(): void {
    const cols = this.db.prepare("PRAGMA table_info(daemon_cycles)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("stale_dispatches_prevented")) {
      this.db.exec(
        "ALTER TABLE daemon_cycles ADD COLUMN stale_dispatches_prevented INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  private runDispatchValidationMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_validations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        source_ref TEXT,
        agent_name TEXT,
        repo TEXT,
        issue_number INTEGER,
        outcome TEXT NOT NULL,
        failure_check TEXT,
        failure_code TEXT,
        failure_reason TEXT,
        checklist_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_validations_created ON dispatch_validations(created_at);
      CREATE INDEX IF NOT EXISTS idx_dispatch_validations_source_ref ON dispatch_validations(source_ref);
      CREATE INDEX IF NOT EXISTS idx_dispatch_validations_outcome ON dispatch_validations(outcome);
    `);
  }

  /**
   * Return per-day dispatch efficiency data over a rolling window.
   *
   * Waste rate = stale_prevented / (dispatched + stale_prevented).
   * "Dispatched" is approximated by counting top-level tasks created
   * each day; stale_prevented comes from daemon_cycles rows.
   *
   * @param days Rolling window in days (e.g. 7 or 30).
   */
  getDispatchWasteMetrics(days = 7): DispatchWasteMetrics {
    // Per-day stale-prevented counts from daemon_cycles
    const staleRows = this.db
      .prepare(
        `SELECT
          date(started_at)                   AS date,
          SUM(stale_dispatches_prevented)    AS stale_prevented
        FROM daemon_cycles
        WHERE finished_at IS NOT NULL
          AND date(started_at) >= date('now', ? || ' days')
        GROUP BY date(started_at)
        ORDER BY date(started_at) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; stale_prevented: number }>;

    // Per-day dispatched task counts (top-level tasks created in window)
    const dispatchRows = this.db
      .prepare(
        `SELECT
          date(created_at)  AS date,
          COUNT(*)          AS dispatched
        FROM tasks
        WHERE parent_task_id IS NULL
          AND date(created_at) >= date('now', ? || ' days')
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; dispatched: number }>;

    // Index dispatched counts by date for O(1) lookup
    const dispatchByDate = new Map<string, number>();
    for (const r of dispatchRows) {
      dispatchByDate.set(r.date, r.dispatched);
    }

    const daily: DispatchWasteDay[] = staleRows.map((r) => {
      const actual = dispatchByDate.get(r.date) ?? 0;
      const total = r.stale_prevented + actual;
      return {
        date: r.date,
        stale_prevented: r.stale_prevented,
        dispatches_total: total,
        waste_rate_pct: total > 0 ? (r.stale_prevented / total) * 100 : null,
      };
    });

    const totalStale = daily.reduce((s, d) => s + d.stale_prevented, 0);
    const totalDispatches = daily.reduce((s, d) => s + d.dispatches_total, 0);
    const rates = daily.map((d) => d.waste_rate_pct).filter((v): v is number => v !== null);

    return {
      days,
      daily,
      total_stale_prevented: totalStale,
      total_dispatches: totalDispatches,
      avg_waste_rate_pct: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    };
  }

  /**
   * Return per-hour dispatch waste data over a rolling 24-hour window.
   *
   * Waste rate = stale_prevented / (dispatched + stale_prevented).
   * "Dispatched" counts top-level tasks created in each hour bucket;
   * stale_prevented sums daemon_cycles rows for the same hour.
   */
  getDispatchWasteMetrics24h(): DispatchWasteMetrics24h {
    // Per-hour stale-prevented counts from daemon_cycles
    const staleRows = this.db
      .prepare(
        `SELECT
          strftime('%Y-%m-%d %H:00', started_at) AS hour,
          SUM(stale_dispatches_prevented)         AS stale_prevented
        FROM daemon_cycles
        WHERE finished_at IS NOT NULL
          AND started_at >= datetime('now', '-24 hours')
        GROUP BY strftime('%Y-%m-%d %H:00', started_at)
        ORDER BY hour ASC`,
      )
      .all() as Array<{ hour: string; stale_prevented: number }>;

    // Per-hour dispatched task counts (top-level tasks created in last 24h)
    const dispatchRows = this.db
      .prepare(
        `SELECT
          strftime('%Y-%m-%d %H:00', created_at) AS hour,
          COUNT(*)                               AS dispatched
        FROM tasks
        WHERE parent_task_id IS NULL
          AND created_at >= datetime('now', '-24 hours')
        GROUP BY strftime('%Y-%m-%d %H:00', created_at)
        ORDER BY hour ASC`,
      )
      .all() as Array<{ hour: string; dispatched: number }>;

    const dispatchByHour = new Map<string, number>();
    for (const r of dispatchRows) {
      dispatchByHour.set(r.hour, r.dispatched);
    }

    const hourly: DispatchWasteHour[] = staleRows.map((r) => {
      const actual = dispatchByHour.get(r.hour) ?? 0;
      const total = r.stale_prevented + actual;
      return {
        hour: r.hour,
        stale_prevented: r.stale_prevented,
        dispatches_total: total,
        waste_rate_pct: total > 0 ? (r.stale_prevented / total) * 100 : null,
      };
    });

    const totalStale = hourly.reduce((s, h) => s + h.stale_prevented, 0);
    const totalDispatches = hourly.reduce((s, h) => s + h.dispatches_total, 0);
    const rates = hourly.map((h) => h.waste_rate_pct).filter((v): v is number => v !== null);
    const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
    const peakRate = rates.length > 0 ? Math.max(...rates) : null;

    return {
      hourly,
      total_stale_prevented: totalStale,
      total_dispatches: totalDispatches,
      avg_waste_rate_pct: avgRate,
      peak_waste_rate_pct: peakRate,
    };
  }

  // ---------------------------------------------------------------------------
  // Health Check Efficiency Metrics (issue #749)
  // ---------------------------------------------------------------------------

  /**
   * Return per-day health check efficiency metrics for the last `days` days.
   *
   * "Total dispatches" = tasks created with source_ref LIKE 'health-check-fail:%'.
   * "False positives"  = dispatches auto-resolved by the daemon (result contains
   *                      'Auto-resolved by daemon') without any agent intervention.
   *
   * A falling false-positive rate confirms the grace-period fix (#739) and
   * dedup fix (#731) are reducing unnecessary health check escalations.
   */
  getHealthCheckEfficiencyMetrics(days = 7): HealthCheckEfficiencyMetrics {
    // All top-level health-check dispatch tasks per day
    const totalRows = this.db
      .prepare(
        `SELECT
          date(created_at)  AS date,
          COUNT(*)          AS total_dispatches
        FROM tasks
        WHERE parent_task_id IS NULL
          AND source_ref LIKE 'health-check-fail:%'
          AND date(created_at) >= date('now', ? || ' days')
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; total_dispatches: number }>;

    // False positives: done tasks auto-resolved by the daemon (agent did not act)
    const fpRows = this.db
      .prepare(
        `SELECT
          date(created_at)  AS date,
          COUNT(*)          AS false_positives
        FROM tasks
        WHERE parent_task_id IS NULL
          AND source_ref LIKE 'health-check-fail:%'
          AND status = 'done'
          AND result LIKE '%Auto-resolved by daemon%'
          AND date(created_at) >= date('now', ? || ' days')
        GROUP BY date(created_at)
        ORDER BY date(created_at) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; false_positives: number }>;

    // Index false-positive counts by date
    const fpByDate = new Map<string, number>();
    for (const r of fpRows) {
      fpByDate.set(r.date, r.false_positives);
    }

    const daily: HealthCheckEfficiencyDay[] = totalRows.map((r) => {
      const fp = fpByDate.get(r.date) ?? 0;
      return {
        date: r.date,
        total_dispatches: r.total_dispatches,
        false_positives: fp,
        false_positive_rate_pct: r.total_dispatches > 0 ? (fp / r.total_dispatches) * 100 : null,
      };
    });

    const totalDispatches = daily.reduce((s, d) => s + d.total_dispatches, 0);
    const totalFP = daily.reduce((s, d) => s + d.false_positives, 0);
    const rates = daily.map((d) => d.false_positive_rate_pct).filter((v): v is number => v !== null);

    return {
      days,
      daily,
      total_dispatches: totalDispatches,
      total_false_positives: totalFP,
      avg_false_positive_rate_pct: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Issue Claim Lock (issue #539)
  // ---------------------------------------------------------------------------

  private runIssueClaimsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_claims (
        source      TEXT NOT NULL,
        source_ref  TEXT NOT NULL,
        agent_name  TEXT NOT NULL,
        task_id     TEXT,
        claimed_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        PRIMARY KEY (source, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_issue_claims_expires ON issue_claims(expires_at);
    `);
  }

  /**
   * Atomically attempt to acquire a claim for (source, sourceRef).
   *
   * Before trying to INSERT, any expired claim for this source_ref is deleted
   * so a hung agent's claim never blocks the queue permanently.
   *
   * Returns `true` if the claim was successfully acquired by `agentName`,
   * `false` if another agent already holds a non-expired claim.
   *
   * @param ttlMs  How long the claim is valid in milliseconds.
   *               Defaults to 2 hours (7_200_000 ms).
   */
  tryClaimIssue(
    source: string,
    sourceRef: string,
    agentName: string,
    ttlMs = 7_200_000,
  ): boolean {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const claimedAt = now.toISOString();

    const acquireClaim = this.db.transaction(() => {
      // Evict any expired claim for this source_ref before attempting INSERT
      this.db
        .prepare(
          `DELETE FROM issue_claims
           WHERE source = ? AND source_ref = ? AND expires_at <= ?`,
        )
        .run(source, sourceRef, now.toISOString());

      // Attempt atomic insert — no-op if an active claim already exists
      this.db
        .prepare(
          `INSERT OR IGNORE INTO issue_claims (source, source_ref, agent_name, task_id, claimed_at, expires_at)
           VALUES (?, ?, ?, NULL, ?, ?)`,
        )
        .run(source, sourceRef, agentName, claimedAt, expiresAt);

      // Verify we own the claim (INSERT OR IGNORE may have been a no-op)
      const existing = this.db
        .prepare(
          `SELECT agent_name FROM issue_claims WHERE source = ? AND source_ref = ?`,
        )
        .get(source, sourceRef) as { agent_name: string } | undefined;

      return existing?.agent_name === agentName;
    });

    return acquireClaim() as boolean;
  }

  /**
   * Attach the task ID to an existing claim once the task record has been
   * created.  No-op if the claim no longer exists (e.g. already released or
   * expired and evicted).
   */
  updateClaimTaskId(source: string, sourceRef: string, taskId: string): void {
    this.db
      .prepare(
        `UPDATE issue_claims SET task_id = ? WHERE source = ? AND source_ref = ?`,
      )
      .run(taskId, source, sourceRef);
  }

  /**
   * Release a claim held by `agentName`.  Only the owning agent can release
   * its own claim — passing a different agentName is a no-op.
   */
  releaseIssueClaim(source: string, sourceRef: string, agentName: string): void {
    this.db
      .prepare(
        `DELETE FROM issue_claims WHERE source = ? AND source_ref = ? AND agent_name = ?`,
      )
      .run(source, sourceRef, agentName);
  }

  /**
   * Return the active (non-expired) claim for a source_ref, or undefined if
   * no claim exists or the claim has expired.
   */
  getActiveClaim(source: string, sourceRef: string): IssueClaim | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM issue_claims
         WHERE source = ? AND source_ref = ? AND expires_at > ?`,
      )
      .get(source, sourceRef, now) as IssueClaim | undefined;
  }

  /**
   * Return all active (non-expired) claims.  Used by the dashboard to display
   * which agent currently holds a claim on every in-flight issue.
   */
  listActiveClaims(): IssueClaim[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM issue_claims WHERE expires_at > ? ORDER BY claimed_at ASC`,
      )
      .all(now) as IssueClaim[];
  }

  /**
   * Delete all expired claims.  Called at the start of each daemon dispatch
   * cycle to keep the table tidy.
   */
  cleanExpiredClaims(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`DELETE FROM issue_claims WHERE expires_at <= ?`)
      .run(now);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // Duplicate-task cancellation (issue #557)
  // ---------------------------------------------------------------------------

  /**
   * When the claim lock for `(source, sourceRef)` is newly acquired by
   * `newAgentName`, cancel any older tasks that are still in-flight for the
   * same issue.  This prevents two agents from working on the same issue
   * simultaneously even when one started before the claim system existed or
   * before the old claim expired.
   *
   * Only top-level tasks (`parent_task_id IS NULL`) in an active state
   * (`dispatched` or `in_progress`) are cancelled.  Tasks that have already
   * reached a terminal state are left alone.
   *
   * Each cancelled task is:
   *   - Updated to status `"superseded"` with a descriptive result
   *   - Given `next_retry_at = NULL` to suppress automatic retries
   *   - Annotated with a system log entry explaining the cancellation
   *
   * @returns The number of tasks that were cancelled.
   */
  cancelSupersededTasks(
    source: string,
    sourceRef: string,
    newAgentName: string,
  ): number {
    const activeTasks = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE source = ?
           AND source_ref = ?
           AND parent_task_id IS NULL
           AND status IN ('dispatched', 'in_progress')
         ORDER BY created_at ASC`,
      )
      .all(source, sourceRef) as Task[];

    if (activeTasks.length === 0) return 0;

    let cancelled = 0;
    for (const task of activeTasks) {
      // Skip if the task is already owned by the new agent (same agent re-
      // dispatching after a retry or reclaim — don't cancel their own work).
      if (task.agent_name === newAgentName) continue;

      this.updateTask(task.id, {
        status: "superseded",
        result:
          `Task superseded: a newer dispatch by ${newAgentName} acquired the ` +
          `exclusive claim for ${sourceRef}. This task (${task.id}) was in ` +
          `status "${task.status}" and has been cancelled to avoid duplicate work.`,
        next_retry_at: null,
      });

      this.addLog({
        task_id: task.id,
        direction: "system",
        content:
          `[claim-lock] Task superseded by newer agent claim.\n` +
          `New agent: ${newAgentName}\n` +
          `Issue: ${sourceRef}\n` +
          `This task was in status "${task.status}" when it was cancelled.`,
      });

      cancelled++;
    }

    return cancelled;
  }

  // ---------------------------------------------------------------------------
  // Per-issue dispatch lock (issue #916)
  // ---------------------------------------------------------------------------

  /**
   * Default TTL for per-issue dispatch locks: 10 minutes.
   * Configurable via `triggers.dispatch_lock_ttl_ms` in agents.yaml.
   */
  static readonly DISPATCH_LOCK_TTL_MS = 600_000;

  private runDispatchLockMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_locks (
        source      TEXT NOT NULL,
        source_ref  TEXT NOT NULL,
        agent_name  TEXT NOT NULL,
        locked_at   TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        PRIMARY KEY (source, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_locks_expires ON dispatch_locks(expires_at);
    `);
  }

  /**
   * Acquire a per-issue dispatch lock for (source, sourceRef).
   *
   * Any expired lock for this sourceRef is evicted first so a crashed agent
   * never permanently blocks an issue. If an active (non-expired) lock already
   * exists, the INSERT is a no-op and the existing lock is preserved — only
   * one lock can be held per sourceRef at a time.
   *
   * @param ttlMs  How long the lock is valid. Defaults to 10 minutes.
   */
  acquireDispatchLock(
    source: string,
    sourceRef: string,
    agentName: string,
    ttlMs = StateStore.DISPATCH_LOCK_TTL_MS,
  ): void {
    const now = new Date();
    const lockedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();

    this.db.transaction(() => {
      // Evict expired lock before inserting so TTL is always enforced
      this.db
        .prepare(`DELETE FROM dispatch_locks WHERE source = ? AND source_ref = ? AND expires_at <= ?`)
        .run(source, sourceRef, now.toISOString());

      // Insert — no-op if an active lock already exists for this sourceRef
      this.db
        .prepare(
          `INSERT OR IGNORE INTO dispatch_locks (source, source_ref, agent_name, locked_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(source, sourceRef, agentName, lockedAt, expiresAt);
    })();
  }

  /**
   * Return the active (non-expired) dispatch lock for a sourceRef, or
   * undefined if no lock exists or the lock has expired.
   */
  getDispatchLock(source: string, sourceRef: string): DispatchLock | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM dispatch_locks WHERE source = ? AND source_ref = ? AND expires_at > ?`,
      )
      .get(source, sourceRef, now) as DispatchLock | undefined;
  }

  /**
   * Release the dispatch lock for (source, sourceRef).
   *
   * Called when the associated PR is merged or the issue is closed so the
   * lock is cleared immediately rather than waiting for the TTL to expire.
   */
  releaseDispatchLock(source: string, sourceRef: string): void {
    this.db
      .prepare(`DELETE FROM dispatch_locks WHERE source = ? AND source_ref = ?`)
      .run(source, sourceRef);
  }

  /**
   * Delete all expired dispatch locks. Called at the start of each daemon
   * dispatch cycle to keep the table tidy.
   *
   * @returns Number of locks that were evicted.
   */
  cleanExpiredDispatchLocks(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`DELETE FROM dispatch_locks WHERE expires_at <= ?`)
      .run(now);
    return result.changes;
  }

  // ---------------------------------------------------------------------------
  // In-Flight Dispatch Reservation (issue #927)
  //
  // A write-ahead reservation that is created the moment an issue claim is
  // acquired — BEFORE the agent even starts work. This covers the race window
  // between claim acquisition and PR creation (typically 5–25 minutes), which
  // the 10-minute dispatch_lock TTL does not fully cover.
  //
  // Unlike dispatch_locks (which prevent rapid re-dispatch storms), the
  // reservation represents "an agent is actively building this right now".
  // It is checked early in the dispatch loop so a second agent cannot start
  // a duplicate implementation even if the dispatch_lock has already expired.
  // ---------------------------------------------------------------------------

  /**
   * Default TTL for in-flight dispatch reservations: 20 minutes.
   * Configurable via `triggers.in_flight_reservation_ttl_ms` in agents.yaml.
   *
   * 20 minutes covers the typical time from claim acquisition to PR creation.
   * Reservations are also released explicitly when the task reaches a terminal
   * state (done / failed / superseded), so the TTL is a safety ceiling rather
   * than the expected lifetime.
   */
  static readonly IN_FLIGHT_RESERVATION_TTL_MS = 1_200_000; // 20 minutes

  private runInFlightReservationsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS in_flight_reservations (
        source       TEXT NOT NULL,
        source_ref   TEXT NOT NULL,
        agent_name   TEXT NOT NULL,
        task_id      TEXT,
        reserved_at  TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        PRIMARY KEY (source, source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_ifr_expires ON in_flight_reservations(expires_at);
    `);
  }

  /**
   * Write an in-flight reservation for (source, sourceRef) immediately after
   * acquiring the issue claim.
   *
   * Uses INSERT OR REPLACE so that if a reservation already exists for this
   * sourceRef (e.g., from a superseded dispatch that wasn't cleaned up), the
   * new dispatch refreshes it with an updated TTL.
   */
  addInFlightReservation(
    source: string,
    sourceRef: string,
    agentName: string,
    ttlMs = StateStore.IN_FLIGHT_RESERVATION_TTL_MS,
  ): void {
    const now = new Date();
    const reservedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO in_flight_reservations
           (source, source_ref, agent_name, task_id, reserved_at, expires_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(source, sourceRef, agentName, reservedAt, expiresAt);
  }

  /**
   * Return the active (non-expired) in-flight reservation for a sourceRef, or
   * undefined when no active reservation exists.
   */
  getInFlightReservation(
    source: string,
    sourceRef: string,
  ): InFlightReservation | undefined {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM in_flight_reservations
         WHERE source = ? AND source_ref = ? AND expires_at > ?`,
      )
      .get(source, sourceRef, now) as InFlightReservation | undefined;
  }

  /**
   * Update the task_id on an existing reservation once the task record has
   * been created. Used by the dashboard to correlate reservations with tasks.
   */
  updateInFlightReservationTaskId(
    source: string,
    sourceRef: string,
    taskId: string,
  ): void {
    this.db
      .prepare(
        `UPDATE in_flight_reservations SET task_id = ? WHERE source = ? AND source_ref = ?`,
      )
      .run(taskId, source, sourceRef);
  }

  /**
   * Remove the in-flight reservation for (source, sourceRef).
   *
   * Called when the task reaches a terminal state — done, failed, or
   * superseded — so the reservation does not unnecessarily block future
   * dispatches after the work is complete.
   */
  removeInFlightReservation(source: string, sourceRef: string): void {
    this.db
      .prepare(`DELETE FROM in_flight_reservations WHERE source = ? AND source_ref = ?`)
      .run(source, sourceRef);
  }

  /**
   * Delete all expired in-flight reservations. Called at the start of each
   * daemon dispatch cycle to keep the table tidy.
   *
   * @returns Number of reservations that were evicted.
   */
  cleanExpiredInFlightReservations(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`DELETE FROM in_flight_reservations WHERE expires_at <= ?`)
      .run(now);
    return result.changes;
  }

  /**
   * List all currently active (non-expired) in-flight reservations.
   * Used by the dashboard and CLI to give operators visibility into
   * what is actively being worked on right now.
   */
  listActiveInFlightReservations(): InFlightReservation[] {
    const now = new Date().toISOString();
    return this.db
      .prepare(
        `SELECT * FROM in_flight_reservations
         WHERE expires_at > ?
         ORDER BY reserved_at DESC`,
      )
      .all(now) as InFlightReservation[];
  }

  // ---------------------------------------------------------------------------
  // Config reload audit trail (issue #572)
  // ---------------------------------------------------------------------------

  private runConfigReloadsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config_reloads (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT    NOT NULL,
        success     INTEGER NOT NULL DEFAULT 1,
        change_count INTEGER NOT NULL DEFAULT 0,
        changes_json TEXT,
        errors_json  TEXT,
        triggered_by TEXT NOT NULL DEFAULT 'signal'
      );
      CREATE INDEX IF NOT EXISTS idx_config_reloads_timestamp
        ON config_reloads (timestamp DESC);
    `);
  }

  // ---------------------------------------------------------------------------
  // Issue-state cache persistence (issue #590)
  // ---------------------------------------------------------------------------

  /**
   * Create the issue_state_cache table if it doesn't exist.
   *
   * This table is written by the orchestrator each time it fetches issue state
   * from GitHub (via issue-state-bridge). The dashboard's getStuckIssues()
   * query reads from this table to filter out closed issues.
   */
  private runIssueCacheMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issue_state_cache (
        source_ref TEXT PRIMARY KEY,
        state      TEXT NOT NULL,
        cached_at  TEXT NOT NULL,
        ttl_ms     INTEGER NOT NULL DEFAULT 60000
      );
      CREATE INDEX IF NOT EXISTS idx_issue_state_cache_cached_at
        ON issue_state_cache (cached_at);
    `);
  }

  /**
   * Persist (or refresh) one entry in the issue-state cache table.
   *
   * Called by the orchestrator whenever it fetches or re-fetches an issue's
   * state from GitHub. The dashboard reads this table to filter closed issues
   * out of the stuck-issues panel.
   *
   * @param source_ref  The canonical source ref, e.g. "owner/repo#42".
   * @param state       "open" or "closed".
   * @param ttl_ms      Entry TTL in ms (default 60 000).
   */
  upsertIssueCacheEntry(params: {
    source_ref: string;
    state: string;
    ttl_ms?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO issue_state_cache (source_ref, state, cached_at, ttl_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source_ref) DO UPDATE SET
           state     = excluded.state,
           cached_at = excluded.cached_at,
           ttl_ms    = excluded.ttl_ms`,
      )
      .run(
        params.source_ref,
        params.state,
        new Date().toISOString(),
        params.ttl_ms ?? 60_000,
      );
  }

  /**
   * Persist a config reload event (success or failure) to the audit trail.
   *
   * @param timestamp   ISO timestamp of the reload attempt.
   * @param success     Whether the reload was applied successfully.
   * @param changes     List of changed field paths (empty for no-op reloads).
   * @param errors      Validation error messages (non-empty only on failure).
   * @param triggeredBy What initiated the reload.
   */
  recordConfigReload(params: {
    timestamp: string;
    success: boolean;
    changes: string[];
    errors: string[];
    triggeredBy: ConfigReloadTrigger;
  }): void {
    this.db
      .prepare(
        `INSERT INTO config_reloads
           (timestamp, success, change_count, changes_json, errors_json, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.timestamp,
        params.success ? 1 : 0,
        params.changes.length,
        params.changes.length > 0 ? JSON.stringify(params.changes) : null,
        params.errors.length > 0 ? JSON.stringify(params.errors) : null,
        params.triggeredBy,
      );
  }

  /**
   * Return the N most recent config reload events, newest first.
   */
  getRecentConfigReloads(limit = 20): ConfigReloadRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM config_reloads
         ORDER BY timestamp DESC
         LIMIT ?`,
      )
      .all(limit) as ConfigReloadRecord[];
  }

  /**
   * Return the most recent successful (non-startup) config reload, or null
   * if no reload has ever been applied.  Used by drift detection.
   */
  getLastSuccessfulConfigReload(): ConfigReloadRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM config_reloads
         WHERE success = 1 AND triggered_by != 'startup'
         ORDER BY timestamp DESC
         LIMIT 1`,
      )
      .get() as ConfigReloadRecord | undefined;
    return row ?? null;
  }

  // ── Fleet comparison (Claude vs Codex) ──────────────────────────────────

  /**
   * Aggregate per-provider task metrics for the fleet comparison panel.
   *
   * Provider is inferred from the agent_name column using a naming convention:
   *   - Names starting with "claude-"  → provider "claude"
   *   - Names starting with "codex-"   → provider "openai"
   *   - Everything else                → provider "other"
   *
   * Token data comes from the token_usage table which does record provider
   * explicitly, so we join on agent_name for the token totals.
   *
   * @param days  Rolling window in days (default: 7)
   */
  getFleetComparisonMetrics(days = 7): FleetProviderMetrics[] {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const sinceHours = days * 24;

    // Task metrics grouped by inferred provider
    const taskRows = this.db.prepare(`
      SELECT
        CASE
          WHEN agent_name LIKE 'claude-%' THEN 'claude'
          WHEN agent_name LIKE 'codex-%'  THEN 'openai'
          ELSE 'other'
        END AS provider,
        COUNT(DISTINCT agent_name) AS agent_count,
        COUNT(*) AS total_tasks,
        COALESCE(SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END), 0) AS done,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
        AVG(CASE
          WHEN status = 'done'
          THEN (julianday(updated_at) - julianday(created_at)) * 86400000.0
        END) AS avg_duration_ms,
        AVG(CASE WHEN verification_status IS NOT NULL THEN quality_score END) AS avg_quality_score
      FROM tasks
      WHERE agent_name IS NOT NULL
        AND parent_task_id IS NULL
        AND created_at >= ?
      GROUP BY 1
      ORDER BY done DESC
    `).all(since) as Array<{
      provider: string;
      agent_count: number;
      total_tasks: number;
      done: number;
      failed: number;
      avg_duration_ms: number | null;
      avg_quality_score: number | null;
    }>;

    // Token usage grouped by provider from the token_usage table
    const tokenRows = this.db.prepare(`
      SELECT
        provider,
        COALESCE(SUM(tokens_in + tokens_out), 0) AS total_tokens
      FROM token_usage
      WHERE recorded_at >= datetime('now', '-' || ? || ' hours')
      GROUP BY provider
    `).all(sinceHours) as Array<{ provider: string; total_tokens: number }>;

    const tokenByProvider = new Map<string, number>();
    for (const tr of tokenRows) {
      tokenByProvider.set(tr.provider, tr.total_tokens);
    }

    return taskRows.map((r) => ({
      provider: r.provider,
      agent_count: r.agent_count,
      total_tasks: r.total_tasks,
      done: r.done,
      failed: r.failed,
      success_rate_pct: r.total_tasks > 0 ? (r.done / r.total_tasks) * 100 : null,
      avg_quality_score: r.avg_quality_score,
      avg_duration_ms: r.avg_duration_ms,
      total_tokens: tokenByProvider.get(r.provider) ?? 0,
    }));
  }

  // ── Learned Rules (cross-task learning from PR feedback) ─────────────────

  private runLearnedRulesMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        rule TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'convention',
        source TEXT NOT NULL,
        source_task_id TEXT,
        confidence REAL NOT NULL DEFAULT 0.8,
        applied_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_applied TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_learned_rules_repo ON learned_rules(repo);
      CREATE INDEX IF NOT EXISTS idx_learned_rules_confidence ON learned_rules(confidence DESC);
    `);
  }

  /**
   * Add a new learned rule. Deduplicates by checking for similar rule text
   * in the same repo (exact match). Returns the stored record.
   */
  addLearnedRule(params: {
    repo: string;
    rule: string;
    category?: LearnedRuleCategory;
    source: string;
    source_task_id?: string;
    confidence?: number;
  }): LearnedRule {
    const now = new Date().toISOString();

    // Check for exact duplicate
    const existing = this.db
      .prepare("SELECT id FROM learned_rules WHERE repo = ? AND rule = ?")
      .get(params.repo, params.rule.trim()) as { id: number } | undefined;
    if (existing) {
      // Boost confidence of existing rule instead of duplicating
      this.db
        .prepare(
          "UPDATE learned_rules SET confidence = MIN(0.95, confidence + 0.05), updated_at = ? WHERE id = ?",
        )
        .run(now, existing.id);
      return this.db
        .prepare("SELECT * FROM learned_rules WHERE id = ?")
        .get(existing.id) as LearnedRule;
    }

    const stmt = this.db.prepare(`
      INSERT INTO learned_rules (repo, rule, category, source, source_task_id, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      params.repo,
      params.rule.trim(),
      params.category ?? "convention",
      params.source,
      params.source_task_id ?? null,
      params.confidence ?? 0.8,
      now,
      now,
    );
    return this.db
      .prepare("SELECT * FROM learned_rules WHERE id = ?")
      .get(result.lastInsertRowid) as LearnedRule;
  }

  /**
   * Get the top N learned rules for a given repo, ordered by confidence.
   */
  getLearnedRulesForRepo(repo: string, limit = 10): LearnedRule[] {
    return this.db
      .prepare(
        "SELECT * FROM learned_rules WHERE repo = ? AND confidence > 0.3 ORDER BY confidence DESC LIMIT ?",
      )
      .all(repo, limit) as LearnedRule[];
  }

  /**
   * Get all learned rules across all repos, ordered by confidence.
   */
  listLearnedRules(limit = 50): LearnedRule[] {
    return this.db
      .prepare("SELECT * FROM learned_rules ORDER BY confidence DESC LIMIT ?")
      .all(limit) as LearnedRule[];
  }

  /**
   * Record that a rule was applied (injected into a dispatch).
   */
  markRuleApplied(ruleId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_rules SET applied_count = applied_count + 1, last_applied = ?, updated_at = ? WHERE id = ?",
      )
      .run(now, now, ruleId);
  }

  /**
   * Boost confidence when the task that used a rule passes verification.
   */
  boostRuleConfidence(ruleId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_rules SET confidence = MIN(0.95, confidence * 1.05), success_count = success_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, ruleId);
  }

  /**
   * Decay confidence when the task that used a rule fails verification.
   */
  decayRuleConfidence(ruleId: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_rules SET confidence = MAX(0.1, confidence * 0.85), failure_count = failure_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, ruleId);
  }

  /**
   * Decay rules that haven't been applied in the given number of days.
   * Called periodically (e.g. daily) to let stale rules fade.
   */
  decayStaleRules(staleDays = 30): number {
    const cutoff = new Date(Date.now() - staleDays * 86400000).toISOString();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE learned_rules
         SET confidence = MAX(0.1, confidence * 0.9), updated_at = ?
         WHERE (last_applied IS NULL OR last_applied < ?) AND confidence > 0.3`,
      )
      .run(now, cutoff);
    return result.changes;
  }

  /**
   * Remove a learned rule by ID.
   */
  removeLearnedRule(id: number): void {
    this.db.prepare("DELETE FROM learned_rules WHERE id = ?").run(id);
  }

  close(): void {
    this.db.close();
  }

  // ── Conflict heat map ─────────────────────────────────────────────────────

  private runConflictHeatMapMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conflict_heat_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        file_path TEXT NOT NULL,
        open_pr_count INTEGER NOT NULL DEFAULT 0,
        pr_numbers_json TEXT NOT NULL DEFAULT '[]',
        assessed_at TEXT NOT NULL,
        UNIQUE(repo, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_conflict_heat_map_repo ON conflict_heat_map(repo);
      CREATE INDEX IF NOT EXISTS idx_conflict_heat_map_pr_count ON conflict_heat_map(repo, open_pr_count DESC);
    `);
  }

  /**
   * Upsert the conflict heat map for a repo.
   *
   * Replaces all existing entries for the repo with the new snapshot so the
   * table always reflects the current state of open PRs.
   */
  upsertConflictHeatMap(
    repo: string,
    entries: Array<{ filePath: string; openPrCount: number; prNumbers: number[]; assessedAt: string }>,
  ): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM conflict_heat_map WHERE repo = ?").run(repo);
      const insert = this.db.prepare(`
        INSERT INTO conflict_heat_map (repo, file_path, open_pr_count, pr_numbers_json, assessed_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const entry of entries) {
        insert.run(repo, entry.filePath, entry.openPrCount, JSON.stringify(entry.prNumbers), entry.assessedAt);
      }
    });
    tx();
  }

  /**
   * Return the conflict heat map for a repo, sorted by PR count descending.
   * Returns all repos when `repo` is omitted.
   */
  getConflictHeatMap(repo?: string): Array<{
    repo: string;
    filePath: string;
    openPrCount: number;
    prNumbers: number[];
    assessedAt: string;
  }> {
    const rows = repo
      ? (this.db
          .prepare(
            "SELECT repo, file_path, open_pr_count, pr_numbers_json, assessed_at FROM conflict_heat_map WHERE repo = ? ORDER BY open_pr_count DESC",
          )
          .all(repo) as Array<{ repo: string; file_path: string; open_pr_count: number; pr_numbers_json: string; assessed_at: string }>)
      : (this.db
          .prepare(
            "SELECT repo, file_path, open_pr_count, pr_numbers_json, assessed_at FROM conflict_heat_map ORDER BY open_pr_count DESC",
          )
          .all() as Array<{ repo: string; file_path: string; open_pr_count: number; pr_numbers_json: string; assessed_at: string }>);

    return rows.map((r) => ({
      repo: r.repo,
      filePath: r.file_path,
      openPrCount: r.open_pr_count,
      prNumbers: JSON.parse(r.pr_numbers_json) as number[],
      assessedAt: r.assessed_at,
    }));
  }

  // ── Merge conflict file history ───────────────────────────────────────────

  private runMergeConflictFileHistoryMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS merge_conflict_file_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        conflicted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mcfh_repo_file ON merge_conflict_file_history(repo, file_path);
      CREATE INDEX IF NOT EXISTS idx_mcfh_conflicted_at ON merge_conflict_file_history(repo, conflicted_at);
    `);
  }

  /**
   * Record that the given files caused (or were involved in) a merge conflict
   * for a specific PR.  Called each time the PR reviewer detects CONFLICTING
   * status so historical frequency can be queried by the reviewer agent.
   *
   * Deduplicates within the same (repo, pr_number, file_path) on the same
   * calendar day to avoid inflating counts when a daemon cycle repeatedly sees
   * the same un-resolved PR.
   */
  recordMergeConflictFiles(repo: string, prNumber: number, filePaths: string[]): void {
    if (filePaths.length === 0) return;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    const check = this.db.prepare(`
      SELECT 1 FROM merge_conflict_file_history
      WHERE repo = ? AND pr_number = ? AND file_path = ? AND conflicted_at >= ?
      LIMIT 1
    `);
    const insert = this.db.prepare(`
      INSERT INTO merge_conflict_file_history (repo, pr_number, file_path, conflicted_at)
      VALUES (?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      const ts = new Date().toISOString();
      for (const filePath of filePaths) {
        const exists = check.get(repo, prNumber, filePath, today);
        if (!exists) {
          insert.run(repo, prNumber, filePath, ts);
        }
      }
    });
    tx();
  }

  /**
   * Return per-file conflict counts for a repo over the given window.
   *
   * Default window is 30 days.  Only files with at least `minCount` events
   * (default: 1) are returned, sorted by count descending.
   *
   * This is consumed by the reviewer agent to annotate PR review comments
   * with conflict-hot file warnings.
   */
  getConflictFrequency(
    repo: string,
    windowDays = 30,
    minCount = 1,
  ): Array<{ filePath: string; count: number; lastConflictAt: string }> {
    const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT file_path, COUNT(*) AS cnt, MAX(conflicted_at) AS last_at
         FROM merge_conflict_file_history
         WHERE repo = ? AND conflicted_at >= ?
         GROUP BY file_path
         HAVING cnt >= ?
         ORDER BY cnt DESC`,
      )
      .all(repo, cutoff, minCount) as Array<{ file_path: string; cnt: number; last_at: string }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      count: r.cnt,
      lastConflictAt: r.last_at,
    }));
  }

  // ── Routing outcomes ──────────────────────────────────────────────────────

  private runRoutingOutcomesMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent_chosen TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'implementation',
        route_method TEXT NOT NULL DEFAULT 'deterministic',
        route_confidence REAL,
        source_ref TEXT,
        routed_at TEXT NOT NULL,
        quality_score REAL,
        outcome_updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_routing_outcomes_task ON routing_outcomes(task_id);
      CREATE INDEX IF NOT EXISTS idx_routing_outcomes_agent ON routing_outcomes(agent_chosen);
      CREATE INDEX IF NOT EXISTS idx_routing_outcomes_routed ON routing_outcomes(routed_at);
    `);
    // Add redirect_reason column if it doesn't exist (capability-enforcement reroutes).
    try {
      this.db.exec(
        "ALTER TABLE routing_outcomes ADD COLUMN redirect_reason TEXT",
      );
    } catch {
      // Column already exists — safe to ignore
    }
  }

  /**
   * Record a routing decision at dispatch time.
   * quality_score is null until the task is verified.
   */
  recordRoutingDecision(params: {
    taskId: string;
    agentChosen: string;
    taskType: string;
    routeMethod: "deterministic" | "llm" | "explicit" | "agent-scope-guard" | "capability-enforcement";
    routeConfidence: number | null;
    sourceRef?: string;
    /** Populated when a capability-enforcement or agent-scope-guard reroute overrode the initial agent selection. */
    redirectReason?: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO routing_outcomes
           (task_id, agent_chosen, task_type, route_method, route_confidence, source_ref, routed_at, redirect_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.taskId,
        params.agentChosen,
        params.taskType,
        params.routeMethod,
        params.routeConfidence ?? null,
        params.sourceRef ?? null,
        now,
        params.redirectReason ?? null,
      );
  }

  /**
   * Fill in the quality_score for a routing outcome when a task is verified.
   * Updates all routing_outcome rows for the given task_id (there should be one).
   */
  updateRoutingOutcomeScore(taskId: string, qualityScore: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE routing_outcomes
         SET quality_score = ?, outcome_updated_at = ?
         WHERE task_id = ? AND quality_score IS NULL`,
      )
      .run(qualityScore, now, taskId);
  }

  /**
   * Return per-agent routing accuracy stats for the last `days` days, grouped by task type.
   * Only routing decisions that have a resolved quality_score are included in the average.
   */
  getRoutingAccuracyStats(days = 30): RoutingAccuracyStat[] {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    return this.db
      .prepare(
        `SELECT
           agent_chosen AS agent_name,
           task_type,
           COUNT(*) AS total_routed,
           COUNT(quality_score) AS scored,
           AVG(quality_score) AS avg_quality_score
         FROM routing_outcomes
         WHERE routed_at >= ?
         GROUP BY agent_chosen, task_type
         ORDER BY agent_chosen, task_type`,
      )
      .all(cutoff) as RoutingAccuracyStat[];
  }

  /**
   * Return recent routing outcome rows for a given agent (for the dashboard /
   * routing-decisions page), most recent first.
   */
  getAgentRoutingOutcomes(agentName: string, limit = 50): RoutingOutcome[] {
    return this.db
      .prepare(
        `SELECT * FROM routing_outcomes
         WHERE agent_chosen = ?
         ORDER BY routed_at DESC
         LIMIT ?`,
      )
      .all(agentName, limit) as RoutingOutcome[];
  }

  // ── Routing accuracy drill-down ───────────────────────────────────────────

  // ── Stigmergy signals ─────────────────────────────────────────────────────

  /**
   * Minimum quality-score gap between the best and current agent for a task
   * type that counts as a "misrouting" signal.
   */
  static readonly MISROUTING_GAP_THRESHOLD = 0.10;

  /**
   * Return a per-(task_type × agent) drill-down matrix for the last `days` days.
   *
   * For each (task_type, agent_chosen) cell the method computes:
   *   - aggregate quality score and routing confidence
   *   - route-method breakdown (deterministic / llm / explicit)
   *   - the best-performing agent for the same task type in the window
   *   - the score gap vs that best agent, and a `misrouted` flag
   *
   * Only cells with a least one scored task contribute a non-null
   * avg_quality_score; unscored cells are included so callers can see
   * recently-dispatched task types even before verification finishes.
   */
  getRoutingAccuracyDrillDown(days = 30): RoutingAccuracyDrillDown {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();

    // Raw aggregates per (task_type, agent_chosen) cell.
    interface RawCell {
      task_type: string;
      agent_name: string;
      total_routed: number;
      scored: number;
      avg_quality_score: number | null;
      avg_confidence: number | null;
      det_count: number;
      llm_count: number;
      exp_count: number;
    }

    const rawRows = this.db
      .prepare(
        `SELECT
           task_type,
           agent_chosen                                              AS agent_name,
           COUNT(*)                                                  AS total_routed,
           COUNT(quality_score)                                      AS scored,
           AVG(quality_score)                                        AS avg_quality_score,
           AVG(route_confidence)                                     AS avg_confidence,
           SUM(CASE WHEN route_method = 'deterministic' THEN 1 ELSE 0 END) AS det_count,
           SUM(CASE WHEN route_method = 'llm'           THEN 1 ELSE 0 END) AS llm_count,
           SUM(CASE WHEN route_method = 'explicit'      THEN 1 ELSE 0 END) AS exp_count
         FROM routing_outcomes
         WHERE routed_at >= ?
         GROUP BY task_type, agent_chosen
         ORDER BY task_type, avg_quality_score DESC`,
      )
      .all(cutoff) as RawCell[];

    if (rawRows.length === 0) {
      return { days, rows: [], misrouted_task_types: [] };
    }

    // Build a map: task_type → best-scoring agent (name + score).
    // "Best" = highest avg_quality_score among cells that have scored tasks.
    const bestByType = new Map<string, { agent: string; score: number }>();
    for (const row of rawRows) {
      if (row.avg_quality_score === null) continue;
      const existing = bestByType.get(row.task_type);
      if (!existing || row.avg_quality_score > existing.score) {
        bestByType.set(row.task_type, { agent: row.agent_name, score: row.avg_quality_score });
      }
    }

    const threshold = StateStore.MISROUTING_GAP_THRESHOLD;

    const rows: RoutingDrillDownRow[] = rawRows.map((r) => {
      const best = bestByType.get(r.task_type) ?? null;
      const isBest = best?.agent === r.agent_name;
      const scoreGap =
        best !== null && r.avg_quality_score !== null && !isBest
          ? best.score - r.avg_quality_score
          : null;
      const misrouted = scoreGap !== null && scoreGap >= threshold;

      return {
        task_type:            r.task_type,
        agent_name:           r.agent_name,
        total_routed:         r.total_routed,
        scored:               r.scored,
        avg_quality_score:    r.avg_quality_score,
        avg_confidence:       r.avg_confidence,
        det_count:            r.det_count,
        llm_count:            r.llm_count,
        exp_count:            r.exp_count,
        best_agent_for_type:  isBest ? null : (best?.agent ?? null),
        best_agent_avg_score: isBest ? null : (best?.score ?? null),
        score_gap:            scoreGap,
        misrouted,
      };
    });

    const misrouted_task_types = [...new Set(
      rows.filter((r) => r.misrouted).map((r) => r.task_type),
    )];

    return { days, rows, misrouted_task_types };
  }

  // ── Stigmergy signals ─────────────────────────────────────────────────────

  private runStigmergySignalsMigration(): void {
    // SQLite does not support GENERATED ALWAYS AS with the datetime() expression
    // in all versions, so we store expires_at as a plain TEXT column and compute
    // it on insert via a trigger-style default expression.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent       TEXT    NOT NULL,
        signal_type TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        value       TEXT,
        repo        TEXT,
        file_glob   TEXT,
        confidence  REAL    NOT NULL DEFAULT 0.5,
        ttl_hours   INTEGER NOT NULL DEFAULT 168,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_signals_type    ON signals(signal_type);
      CREATE INDEX IF NOT EXISTS idx_signals_repo    ON signals(repo);
      CREATE INDEX IF NOT EXISTS idx_signals_expires ON signals(expires_at);
    `);
  }

  /**
   * Write a stigmergy signal into the shared state store.
   *
   * Any agent can call this; the signal will be visible to all other agents
   * via `readSignals()` until it expires.
   */
  writeSignal(params: WriteSignalParams): Signal {
    const ttlHours = params.ttl_hours ?? 168;
    const confidence = params.confidence ?? 0.5;
    const now = new Date().toISOString();
    // Compute expires_at as now + ttl_hours hours.
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
    const value =
      params.value !== undefined ? JSON.stringify(params.value) : null;

    const result = this.db
      .prepare(
        `INSERT INTO signals
           (agent, signal_type, key, value, repo, file_glob, confidence, ttl_hours, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agent,
        params.signal_type,
        params.key,
        value,
        params.repo ?? null,
        params.file_glob ?? null,
        confidence,
        ttlHours,
        now,
        expiresAt,
      );

    return this.db
      .prepare(`SELECT * FROM signals WHERE id = ?`)
      .get(result.lastInsertRowid) as Signal;
  }

  /**
   * Read active (non-expired) signals, optionally filtered by type, repo, and
   * file glob.  Expired signals are excluded automatically.
   *
   * When `file_glob` is provided the query also returns signals whose
   * `file_glob` is NULL (fleet-wide signals) so callers always see broad
   * signals in addition to file-specific ones.
   */
  readSignals(filter: ReadSignalsFilter = {}): Signal[] {
    const now = new Date().toISOString();
    const conditions: string[] = ["expires_at > ?"];
    const bindings: unknown[] = [now];

    if (filter.signal_type) {
      conditions.push("signal_type = ?");
      bindings.push(filter.signal_type);
    }

    if (filter.repo) {
      conditions.push("(repo IS NULL OR repo = ?)");
      bindings.push(filter.repo);
    }

    if (filter.file_glob) {
      conditions.push("(file_glob IS NULL OR file_glob = ?)");
      bindings.push(filter.file_glob);
    }

    const where = conditions.join(" AND ");
    const limit = filter.limit ?? 500;
    bindings.push(limit);

    const signals = this.db
      .prepare(
        `SELECT * FROM signals
         WHERE ${where}
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(...bindings) as Signal[];

    // Record consumption events when a reader_agent is provided so the
    // activity feed can show cross-agent influence.
    if (filter.reader_agent && signals.length > 0) {
      for (const sig of signals) {
        this.recordSignalRead(sig.id, filter.reader_agent, filter.reader_context);
      }
    }

    return signals;
  }

  /**
   * Delete all signals whose `expires_at` timestamp is in the past.
   * Called once per daemon poll cycle to keep the table small.
   *
   * @returns number of rows deleted.
   */
  /** Delete a specific signal by ID (e.g. after dispatching a meeting request). */
  deleteSignal(id: number): void {
    this.db.prepare("DELETE FROM signals WHERE id = ?").run(id);
  }

  pruneExpiredSignals(): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`DELETE FROM signals WHERE expires_at <= ?`)
      .run(now);
    return result.changes;
  }

  // ── Signal reads (consumption tracking) ──────────────────────────────────────

  private runSignalReadsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_reads (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        signal_id INTEGER NOT NULL,
        reader    TEXT    NOT NULL,
        context   TEXT,
        read_at   TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_signal_reads_signal ON signal_reads(signal_id);
      CREATE INDEX IF NOT EXISTS idx_signal_reads_reader ON signal_reads(reader);
      CREATE INDEX IF NOT EXISTS idx_signal_reads_time   ON signal_reads(read_at);
    `);
  }

  /**
   * Record that an agent consumed (read) a specific signal.
   * Called by `readSignals()` when `reader_agent` is set in the filter,
   * and can also be called explicitly for targeted reads.
   */
  recordSignalRead(signalId: number, reader: string, context?: string): SignalRead {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO signal_reads (signal_id, reader, context, read_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(signalId, reader, context ?? null, now);
    return this.db
      .prepare(`SELECT * FROM signal_reads WHERE id = ?`)
      .get(result.lastInsertRowid) as SignalRead;
  }

  /**
   * Return a chronological activity feed of stigmergy signal events — both
   * writes (emitted by agents) and reads (consumed by agents).
   *
   * The feed merges the `signals` and `signal_reads` tables using a UNION
   * ordered by timestamp DESC, so operators see the most recent coordination
   * activity first.  Only signals still present in the signals table are
   * included (expired/pruned signals are excluded from the read side too).
   *
   * @param limit  Max total events to return (default 100).
   * @param since  Optional ISO timestamp: only events at or after this time.
   */
  getSignalActivityFeed(limit = 100, since?: string): SignalActivityEvent[] {
    const sinceClause = since ? `AND s.created_at >= '${since.replace(/'/g, "''")}'` : "";
    const sinceReadClause = since ? `AND sr.read_at >= '${since.replace(/'/g, "''")}'` : "";

    const sql = `
      SELECT
        'write'         AS event_type,
        s.created_at    AS at,
        s.agent         AS agent,
        s.id            AS signal_id,
        s.signal_type   AS signal_type,
        s.key           AS key,
        s.repo          AS repo,
        s.confidence    AS confidence,
        s.value         AS value,
        NULL            AS context
      FROM signals s
      WHERE 1=1 ${sinceClause}

      UNION ALL

      SELECT
        'read'          AS event_type,
        sr.read_at      AS at,
        sr.reader       AS agent,
        sr.signal_id    AS signal_id,
        s.signal_type   AS signal_type,
        s.key           AS key,
        s.repo          AS repo,
        s.confidence    AS confidence,
        s.value         AS value,
        sr.context      AS context
      FROM signal_reads sr
      JOIN signals s ON s.id = sr.signal_id
      WHERE 1=1 ${sinceReadClause}

      ORDER BY at DESC
      LIMIT ?
    `;

    return this.db.prepare(sql).all(limit) as SignalActivityEvent[];
  }

  // ── Learned Patterns (immune system / anti-pattern registry) ─────────────

  private runLearnedPatternsMigration(): void {
    // Create base table without active column index — the column may not exist
    // yet on tables created by older versions. Indexes are created after
    // the column migration below.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS learned_patterns (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern_type     TEXT    NOT NULL DEFAULT 'anti_pattern',
        title            TEXT    NOT NULL,
        description      TEXT    NOT NULL,
        source           TEXT    NOT NULL DEFAULT 'manual',
        source_ref       TEXT,
        agent            TEXT,
        repos            TEXT,
        confidence       REAL    NOT NULL DEFAULT 0.8,
        hit_count        INTEGER NOT NULL DEFAULT 0,
        first_pass_saves INTEGER NOT NULL DEFAULT 0,
        active           INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_learned_patterns_type ON learned_patterns(pattern_type);
      CREATE INDEX IF NOT EXISTS idx_learned_patterns_conf ON learned_patterns(confidence DESC);
    `);

    // Column migrations — add missing columns for older tables
    const cols = this.db.prepare("PRAGMA table_info(learned_patterns)").all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("title")) {
      // Older schema used different column names (trigger_conditions, frequency_count, etc.)
      // and had no `title` column. Add it with an empty-string default so existing rows
      // don't violate NOT NULL, then operators can backfill titles manually.
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
    if (!colNames.has("description")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    }
    if (!colNames.has("source")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    }
    if (!colNames.has("source_ref")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN source_ref TEXT");
    }
    if (!colNames.has("agent")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN agent TEXT");
    }
    if (!colNames.has("repos")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN repos TEXT");
    }
    if (!colNames.has("confidence")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN confidence REAL NOT NULL DEFAULT 0.8");
    }
    if (!colNames.has("hit_count")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!colNames.has("first_pass_saves")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN first_pass_saves INTEGER NOT NULL DEFAULT 0");
    }
    if (!colNames.has("updated_at")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
    }
    if (!colNames.has("active")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    }
    if (!colNames.has("suppressed_at")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN suppressed_at TEXT");
    }
    if (!colNames.has("promoted_at")) {
      this.db.exec("ALTER TABLE learned_patterns ADD COLUMN promoted_at TEXT");
    }

    // Create indexes AFTER column migrations so all referenced columns exist
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_learned_patterns_active ON learned_patterns(active)");
  }

  /**
   * Add a new learned pattern.  Deduplicates by title (case-insensitive).
   * Returns the stored record.
   */
  addLearnedPattern(params: WriteLearnedPatternParams): LearnedPattern {
    const now = new Date().toISOString();

    // Deduplicate by title
    const existing = this.db
      .prepare("SELECT id FROM learned_patterns WHERE lower(title) = lower(?)")
      .get(params.title.trim()) as { id: number } | undefined;

    if (existing) {
      // Don't bump confidence on suppressed/retired patterns — respect operator decisions.
      this.db
        .prepare(
          `UPDATE learned_patterns
           SET confidence = CASE WHEN suppressed_at IS NULL AND active = 1
                                 THEN MIN(0.99, confidence + 0.02)
                                 ELSE confidence END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(now, existing.id);
      return this.db
        .prepare("SELECT * FROM learned_patterns WHERE id = ?")
        .get(existing.id) as LearnedPattern;
    }

    const reposJson = params.repos ? JSON.stringify(params.repos) : null;
    const result = this.db
      .prepare(
        `INSERT INTO learned_patterns
          (pattern_type, title, description, source, source_ref, agent, repos, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.pattern_type,
        params.title.trim(),
        params.description.trim(),
        params.source,
        params.source_ref ?? null,
        params.agent ?? null,
        reposJson,
        params.confidence ?? 0.8,
        now,
        now,
      );

    return this.db
      .prepare("SELECT * FROM learned_patterns WHERE id = ?")
      .get(result.lastInsertRowid) as LearnedPattern;
  }

  /**
   * List active learned patterns, optionally filtered by repo.
   * Patterns with `repos = null` apply to all repos.
   *
   * @param repo - If provided, return patterns that apply to this repo (or all-repo patterns).
   * @param limit - Max rows to return (default 20).
   */
  getLearnedPatterns(repo?: string, limit = 20): LearnedPattern[] {
    // Exclude suppressed patterns (suppressed_at IS NOT NULL) — the operator
    // has explicitly disabled these via the dashboard.
    // Promoted patterns sort first (promoted_at IS NOT NULL) so they always
    // make it into the prompt even when the limit is tight.
    if (repo) {
      return this.db
        .prepare(
          `SELECT * FROM learned_patterns
           WHERE active = 1
             AND suppressed_at IS NULL
             AND (repos IS NULL OR repos LIKE ?)
           ORDER BY (promoted_at IS NOT NULL) DESC, confidence DESC, hit_count DESC
           LIMIT ?`,
        )
        .all(`%${repo}%`, limit) as LearnedPattern[];
    }
    return this.db
      .prepare(
        `SELECT * FROM learned_patterns
         WHERE active = 1
           AND suppressed_at IS NULL
         ORDER BY (promoted_at IS NOT NULL) DESC, confidence DESC, hit_count DESC
         LIMIT ?`,
      )
      .all(limit) as LearnedPattern[];
  }

  /** List ALL patterns (active and inactive) for CLI/admin use. */
  listAllLearnedPatterns(limit = 100): LearnedPattern[] {
    return this.db
      .prepare(
        `SELECT * FROM learned_patterns ORDER BY active DESC, confidence DESC LIMIT ?`,
      )
      .all(limit) as LearnedPattern[];
  }

  /**
   * Increment `hit_count` each time a pattern is injected into a review prompt.
   */
  recordPatternHit(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
  }

  /**
   * Increment `first_pass_saves` when a PR passes review after pattern injection.
   * Also boosts confidence slightly.
   */
  recordPatternSave(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE learned_patterns
         SET first_pass_saves = first_pass_saves + 1,
             confidence = MIN(0.99, confidence + 0.01),
             updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
  }

  /** Retire a pattern (soft-delete). Sets suppressed_at for dashboard consistency. */
  retireLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE learned_patterns SET active = 0, suppressed_at = COALESCE(suppressed_at, ?), updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  /** Get a single pattern by ID. */
  getLearnedPattern(id: number): LearnedPattern | undefined {
    return this.db
      .prepare("SELECT * FROM learned_patterns WHERE id = ?")
      .get(id) as LearnedPattern | undefined;
  }

  /**
   * Suppress a pattern — marks it as a false positive so it is excluded from
   * injection (suppressed_at IS NOT NULL) but remains in the DB for audit.
   * Unlike `retireLearnedPattern`, active stays 1 so the pattern can be
   * unsuppressed later without losing its hit/save counters.
   */
  suppressLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET suppressed_at = COALESCE(suppressed_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  /**
   * Remove the operator suppression — re-enables injection for a previously
   * suppressed pattern.  Does not change `active` (if the pattern was also
   * retired, it stays retired).
   */
  unsuppressLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET suppressed_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
  }

  /**
   * Promote a pattern — sorts it to the top of the injection list and
   * increases its retrieval priority so it is always included when patterns
   * are injected into review prompts.
   */
  promoteLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET promoted_at = COALESCE(promoted_at, ?), updated_at = ? WHERE id = ?",
      )
      .run(now, now, id);
  }

  /**
   * Remove the operator promotion — returns the pattern to normal priority
   * ordering (confidence / hit_count).
   */
  demoteLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET promoted_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
  }

  /**
   * Reactivate a retired pattern — sets active = 1 and clears suppressed_at
   * so it is eligible for injection again.  Counterpart to `retireLearnedPattern`.
   */
  reactivateLearnedPattern(id: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE learned_patterns SET active = 1, suppressed_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, id);
  }

  // ---------------------------------------------------------------------------
  // Pattern learner — rejection signal queries
  // ---------------------------------------------------------------------------

  /**
   * Fetch tasks that were verification-rejected after the given cutoff.
   * Used by the pattern learner to gather rejection signals.
   */
  getRecentRejectedTasks(cutoff: string): Pick<Task, "id" | "source_ref" | "agent_name" | "verification_notes">[] {
    return this.db
      .prepare(
        `SELECT id, source_ref, agent_name, verification_notes
         FROM tasks
         WHERE verification_status = 'rejected'
           AND verification_notes IS NOT NULL
           AND updated_at > ?
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all(cutoff) as Pick<Task, "id" | "source_ref" | "agent_name" | "verification_notes">[];
  }

  /**
   * Fetch PR review rejections from the antibody log after the given cutoff.
   * Used by the pattern learner to gather rejection signals.
   */
  getRecentPRRejections(cutoff: string): { repo: string; reason: string; agent: string | null }[] {
    return this.db
      .prepare(
        `SELECT repo, reason, agent
         FROM antibody_log
         WHERE decision = 'request-changes'
           AND reason IS NOT NULL
           AND timestamp > ?
         ORDER BY timestamp DESC
         LIMIT 50`,
      )
      .all(cutoff) as { repo: string; reason: string; agent: string | null }[];
  }

  // ---------------------------------------------------------------------------
  // Cross-repo task lineage
  // ---------------------------------------------------------------------------

  private runLineageMigration(): void {
    // 1. Add lineage_group_id column to tasks
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));
    if (!colNames.has("lineage_group_id")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN lineage_group_id TEXT");
      // Back-fill: set lineage_group_id = id for all existing tasks that have
      // no parent (top-level tasks get their own lineage group)
      this.db.exec("UPDATE tasks SET lineage_group_id = id WHERE parent_task_id IS NULL AND lineage_group_id IS NULL");
      // Sub-tasks inherit from parent
      this.db.exec(`
        UPDATE tasks SET lineage_group_id = (
          SELECT COALESCE(p.lineage_group_id, p.id)
          FROM tasks p WHERE p.id = tasks.parent_task_id
        ) WHERE parent_task_id IS NOT NULL AND lineage_group_id IS NULL
      `);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_lineage_group ON tasks(lineage_group_id)");

    // 2. Create lineage_mappings table: maps future source_refs to a lineage
    //    group so that when trigger polling picks up a cross-repo follow-up
    //    issue, the new task inherits the correct lineage_group_id.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lineage_mappings (
        source_ref        TEXT PRIMARY KEY,
        lineage_group_id  TEXT NOT NULL,
        parent_source_ref TEXT,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lineage_mappings_group ON lineage_mappings(lineage_group_id);
    `);
  }

  /**
   * Record a lineage mapping so that when a cross-repo follow-up issue is
   * later picked up by trigger polling, the resulting task inherits the
   * originating task's lineage group.
   */
  recordLineageMapping(sourceRef: string, lineageGroupId: string, parentSourceRef?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO lineage_mappings (source_ref, lineage_group_id, parent_source_ref, created_at)
      VALUES (?, ?, ?, ?)
    `).run(sourceRef, lineageGroupId, parentSourceRef ?? null, new Date().toISOString());
  }

  /**
   * Look up a pre-recorded lineage group for a source_ref.
   * Returns the lineage_group_id if found, otherwise undefined.
   */
  lookupLineageGroup(sourceRef: string): string | undefined {
    const row = this.db
      .prepare("SELECT lineage_group_id FROM lineage_mappings WHERE source_ref = ?")
      .get(sourceRef) as { lineage_group_id: string } | undefined;
    return row?.lineage_group_id;
  }

  /**
   * Get all tasks belonging to the same lineage group, ordered by creation time.
   */
  getLineageGroup(lineageGroupId: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE lineage_group_id = ? ORDER BY created_at ASC")
      .all(lineageGroupId) as Task[];
  }

  /**
   * Get distinct lineage groups that contain more than one task (i.e. actual
   * cross-repo coordination). Returns summary info for each group.
   */
  getMultiTaskLineageGroups(limit = 50): Array<{
    lineage_group_id: string;
    task_count: number;
    repos: string;
    earliest: string;
    latest: string;
    root_title: string;
  }> {
    return this.db.prepare(`
      SELECT
        t.lineage_group_id,
        COUNT(*)                                        AS task_count,
        GROUP_CONCAT(DISTINCT SUBSTR(t.source_ref, 1, INSTR(t.source_ref || '#', '#') - 1)) AS repos,
        MIN(t.created_at)                               AS earliest,
        MAX(t.created_at)                               AS latest,
        (SELECT t2.title FROM tasks t2 WHERE t2.id = t.lineage_group_id) AS root_title
      FROM tasks t
      WHERE t.lineage_group_id IS NOT NULL
        AND t.parent_task_id IS NULL
      GROUP BY t.lineage_group_id
      HAVING COUNT(*) > 1
      ORDER BY MAX(t.created_at) DESC
      LIMIT ?
    `).all(limit) as Array<{
      lineage_group_id: string;
      task_count: number;
      repos: string;
      earliest: string;
      latest: string;
      root_title: string;
    }>;
  }

  // ── Antibody Log ─────────────────────────────────────────────────────────────

  private runAntibodyLogMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS antibody_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        repo           TEXT    NOT NULL,
        pr_number      INTEGER NOT NULL,
        diff_shape     TEXT    NOT NULL,
        decision       TEXT    NOT NULL,
        outcome        TEXT,
        reason         TEXT,
        agent          TEXT,
        timestamp      TEXT    NOT NULL,
        false_positive INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_antibody_log_repo_pr  ON antibody_log(repo, pr_number);
      CREATE INDEX IF NOT EXISTS idx_antibody_log_decision ON antibody_log(decision);
      CREATE INDEX IF NOT EXISTS idx_antibody_log_ts       ON antibody_log(timestamp);
    `);
  }

  /**
   * Record one antibody log entry — called once per PR review decision so that
   * every decision (approve / request-changes / escalate) contributes a
   * structured data point to the shared failure genome.
   */
  recordAntibodyEntry(params: WriteAntibodyLogParams): AntibodyLogEntry {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO antibody_log (repo, pr_number, diff_shape, decision, outcome, reason, agent, timestamp)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      params.repo,
      params.pr_number,
      JSON.stringify(params.diff_shape),
      params.decision,
      params.reason ?? null,
      params.agent ?? null,
      now,
    );
    return this.db
      .prepare("SELECT * FROM antibody_log WHERE id = ?")
      .get(result.lastInsertRowid) as AntibodyLogEntry;
  }

  /**
   * Update the outcome for a previously logged entry once post-merge signals
   * are available.  Outcome is "clean" (no issues) or "regression" (downstream
   * failure detected).
   */
  updateAntibodyOutcome(id: number, outcome: "clean" | "regression"): void {
    this.db.prepare("UPDATE antibody_log SET outcome = ? WHERE id = ?").run(outcome, id);
  }

  /**
   * Retrieve recent antibody log entries, optionally filtered by repo and/or
   * decision.  Returns entries newest-first.
   *
   * @param opts.repo                - Restrict to a single repo slug.
   * @param opts.decision            - Restrict to a specific decision type.
   * @param opts.limit               - Max rows to return (default 50).
   * @param opts.includeFalsePositives - When true, include operator-marked FP entries (default false).
   */
  getAntibodyEntries(opts: {
    repo?: string;
    decision?: AntibodyLogEntry["decision"];
    limit?: number;
    includeFalsePositives?: boolean;
  } = {}): AntibodyLogEntry[] {
    const { repo, decision, limit = 50, includeFalsePositives = false } = opts;
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (!includeFalsePositives) {
      conditions.push("false_positive = 0");
    }
    if (repo) {
      conditions.push("repo = ?");
      args.push(repo);
    }
    if (decision) {
      conditions.push("decision = ?");
      args.push(decision);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    args.push(limit);

    return this.db
      .prepare(`SELECT * FROM antibody_log ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...args) as AntibodyLogEntry[];
  }

  /**
   * Mark an antibody_log entry as a false positive.
   * Throws if the entry does not exist.
   */
  markAntibodyFalsePositive(id: number): void {
    const row = this.db
      .prepare("SELECT id FROM antibody_log WHERE id = ?")
      .get(id);
    if (!row) {
      throw new Error(`antibody_log entry ${id} not found`);
    }
    this.db
      .prepare("UPDATE antibody_log SET false_positive = 1 WHERE id = ?")
      .run(id);
  }

  /**
   * Return active tasks (pending / dispatched / in_progress) that have at
   * least one antibody-risk warning in their logs.
   */
  getAntibodyHeldTasks(): Array<Task & { antibody_log_entry: string }> {
    return this.db.prepare(`
      SELECT t.*, tl.content AS antibody_log_entry
      FROM tasks t
      JOIN task_logs tl ON tl.task_id = t.id
      WHERE tl.content LIKE '[antibody-flagged]%'
        AND tl.direction = 'system'
        AND t.status IN ('pending', 'dispatched', 'in_progress')
      GROUP BY t.id
      ORDER BY t.created_at DESC
    `).all() as Array<Task & { antibody_log_entry: string }>;
  }

  /**
   * Compute antibody filter accuracy metrics over a rolling window.
   *
   * True positives  = flagged tasks that later failed or were escalated.
   * False positives = flagged tasks that completed (done) + operator-marked
   *                   antibody_log entries.
   */
  getAntibodyFilterAccuracy(windowDays: number): AntibodyFilterAccuracy {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    const flaggedRows = this.db.prepare(`
      SELECT t.status
      FROM tasks t
      JOIN task_logs tl ON tl.task_id = t.id
      WHERE tl.content LIKE '[antibody-flagged]%'
        AND tl.direction = 'system'
        AND t.created_at >= ?
      GROUP BY t.id
    `).all(since) as Array<{ status: string }>;

    const totalFlagged = flaggedRows.length;
    const truePositives = flaggedRows.filter((t) => t.status === "failed" || t.status === "escalated").length;
    const taskFalsePositives = flaggedRows.filter((t) => t.status === "done").length;

    const { operatorOverrides } = this.db.prepare(`
      SELECT COUNT(*) AS operatorOverrides
      FROM antibody_log
      WHERE false_positive = 1
        AND timestamp >= ?
    `).get(since) as { operatorOverrides: number };

    const falsePositives = taskFalsePositives + operatorOverrides;

    const precision =
      truePositives + falsePositives > 0
        ? truePositives / (truePositives + falsePositives)
        : null;

    return {
      window_days: windowDays,
      total_flagged: totalFlagged,
      true_positives: truePositives,
      false_positives: falsePositives,
      operator_overrides: operatorOverrides,
      precision,
    };
  }

  /**
   * Count entries in the antibody log grouped by decision type.
   * Useful for dashboard metrics and pattern synthesis.
   */
  getAntibodyStats(): Array<{ decision: string; count: number; with_outcome: number }> {
    return this.db.prepare(`
      SELECT
        decision,
        COUNT(*)                              AS count,
        COUNT(CASE WHEN outcome IS NOT NULL THEN 1 END) AS with_outcome
      FROM antibody_log
      GROUP BY decision
      ORDER BY count DESC
    `).all() as Array<{ decision: string; count: number; with_outcome: number }>;
  }

  /**
   * Return tasks that were dispatched with at least one antibody-risk warning
   * (i.e. tasks whose logs contain an `[antibody-flagged]` system entry).
   *
   * Useful for operator dashboards to track whether flagged tasks still fail
   * at higher rates than unflagged ones.
   *
   * @param limit - Max tasks to return (default 50, newest first).
   */
  getAntibodyFlaggedTasks(limit = 50): Array<Task & { antibody_log_entry: string }> {
    return this.db.prepare(`
      SELECT t.*, tl.content AS antibody_log_entry
      FROM tasks t
      JOIN task_logs tl ON tl.task_id = t.id
      WHERE tl.content LIKE '[antibody-flagged]%'
        AND tl.direction = 'system'
      ORDER BY t.created_at DESC
      LIMIT ?
    `).all(limit) as Array<Task & { antibody_log_entry: string }>;
  }

  // ── Daemon Lifecycle Audit ────────────────────────────────────────────────────

  private runDaemonLifecycleMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_lifecycle (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        event       TEXT    NOT NULL,
        pid         INTEGER,
        reason      TEXT,
        exit_code   INTEGER,
        duration_ms INTEGER,
        timestamp   TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daemon_lifecycle_event ON daemon_lifecycle(event);
      CREATE INDEX IF NOT EXISTS idx_daemon_lifecycle_ts    ON daemon_lifecycle(timestamp);
    `);
    // Migration: add commit_hash column (issue #1337 — self-update auditing)
    try {
      this.db.exec(`ALTER TABLE daemon_lifecycle ADD COLUMN commit_hash TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }
  }

  /**
   * Record a daemon lifecycle event (start, stop, crash, or self-update) in the audit trail.
   *
   * @param params.event       - "start" | "stop" | "crash" | "self-update"
   * @param params.pid         - Process ID (defaults to current process.pid)
   * @param params.reason      - Human-readable description (e.g. "SIGTERM", error message)
   * @param params.exit_code   - Process exit code for crash events
   * @param params.duration_ms - Daemon uptime in ms for stop/crash events
   * @param params.commit_hash - Git commit hash the daemon is running from
   */
  recordDaemonLifecycleEvent(params: {
    event: DaemonLifecycleEvent;
    pid?: number;
    reason?: string;
    exit_code?: number;
    duration_ms?: number;
    commit_hash?: string;
  }): DaemonLifecycleEntry {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO daemon_lifecycle (event, pid, reason, exit_code, duration_ms, commit_hash, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.event,
      params.pid ?? process.pid,
      params.reason ?? null,
      params.exit_code ?? null,
      params.duration_ms ?? null,
      params.commit_hash ?? null,
      now,
    );
    return this.db
      .prepare("SELECT * FROM daemon_lifecycle WHERE id = ?")
      .get(result.lastInsertRowid) as DaemonLifecycleEntry;
  }

  /**
   * Retrieve the most recent daemon lifecycle events, newest-first.
   *
   * @param limit - Maximum number of entries to return (default 20).
   */
  getDaemonLifecycleHistory(limit = 20): DaemonLifecycleEntry[] {
    return this.db
      .prepare("SELECT * FROM daemon_lifecycle ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as DaemonLifecycleEntry[];
  }

  // ────────────────────────────────────────────────────────────────────────
  // Secret mount status tracking (issue #764)
  //
  // Persists per-agent, per-secret mount states so the pre-dispatch validator
  // can make synchronous gating decisions without needing to call the agent's
  // HTTP endpoint inline.  The data is written by the auto-recovery playbook
  // each time it probes /secrets/health.
  // ────────────────────────────────────────────────────────────────────────

  private runSecretMountStatusMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_secret_mount_status (
        agent_name TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL,
        checked_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_name, secret_name)
      );
    `);
  }

  /**
   * Upsert the three-state mount status for every secret belonging to an agent.
   * Called after each /secrets/health probe so the pre-dispatch validator has
   * fresh data without making its own HTTP call.
   */
  upsertSecretMountStatus(
    agentName: string,
    details: Array<{ name: string; status: string; reason: string }>,
  ): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO agent_secret_mount_status (agent_name, secret_name, status, reason, checked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_name, secret_name) DO UPDATE SET
        status = excluded.status,
        reason = excluded.reason,
        checked_at = excluded.checked_at
    `);
    for (const d of details) {
      stmt.run(agentName, d.name, d.status, d.reason, now);
    }
  }

  /**
   * Return the most recent mount status for every secret of an agent.
   * Returns an empty array if no probe has been recorded yet (fail-open).
   */
  getSecretMountStatus(agentName: string): Array<{ name: string; status: string; reason: string; checked_at: string }> {
    return this.db
      .prepare("SELECT secret_name AS name, status, reason, checked_at FROM agent_secret_mount_status WHERE agent_name = ?")
      .all(agentName) as Array<{ name: string; status: string; reason: string; checked_at: string }>;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Skip pattern tracking (issue #787)
  //
  // Aggregates skip reasons from supervisor_decisions over rolling windows
  // and records which blockers have already had auto-created GitHub issues,
  // preventing duplicate issue creation for the same active blocker.
  // ────────────────────────────────────────────────────────────────────────

  private runSkipPatternMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skip_pattern_issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason_key TEXT NOT NULL UNIQUE,
        issue_number INTEGER NOT NULL,
        issue_url TEXT NOT NULL,
        repo TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_skip_pattern_issues_reason ON skip_pattern_issues(reason_key);
    `);
  }

  /**
   * Aggregate skip reasons from supervisor_decisions over a rolling window.
   * Returns rows sorted by count descending.
   */
  getSkipPatterns(windowDays = 7): SkipPatternRow[] {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT
        reason,
        COUNT(*) AS skip_count,
        GROUP_CONCAT(DISTINCT agent_name) AS affected_agents_csv,
        GROUP_CONCAT(DISTINCT issue_refs) AS issue_refs_json_csv,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen
      FROM supervisor_decisions
      WHERE outcome = 'skipped'
        AND created_at >= ?
        AND reason IS NOT NULL
        AND reason != ''
        AND (hard_gates IS NULL OR hard_gates NOT LIKE '%skipped-empty-backlog%')
      GROUP BY reason
      ORDER BY skip_count DESC
    `).all(since) as Array<{
      reason: string;
      skip_count: number;
      affected_agents_csv: string | null;
      issue_refs_json_csv: string | null;
      first_seen: string;
      last_seen: string;
    }>;

    return rows.map((row) => {
      const agents = row.affected_agents_csv
        ? [...new Set(row.affected_agents_csv.split(",").map((a) => a.trim()).filter(Boolean))]
        : [];

      const issueRefs: string[] = [];
      if (row.issue_refs_json_csv) {
        for (const chunk of row.issue_refs_json_csv.split(",")) {
          try {
            const parsed = JSON.parse(chunk.trim());
            if (Array.isArray(parsed)) issueRefs.push(...parsed);
          } catch {
            // ignore malformed
          }
        }
      }

      return {
        reason: row.reason,
        skip_count: row.skip_count,
        affected_agents: agents,
        sample_issue_refs: [...new Set(issueRefs)].slice(0, 10),
        first_seen: row.first_seen,
        last_seen: row.last_seen,
      };
    });
  }

  /**
   * Record that a GitHub issue was created for a skip pattern blocker.
   * Uses INSERT OR IGNORE so re-runs are idempotent if the issue was already created.
   */
  recordSkipPatternIssue(params: {
    reason_key: string;
    issue_number: number;
    issue_url: string;
    repo: string;
  }): void {
    this.db.prepare(`
      INSERT INTO skip_pattern_issues (reason_key, issue_number, issue_url, repo, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(reason_key) DO NOTHING
    `).run(
      params.reason_key,
      params.issue_number,
      params.issue_url,
      params.repo,
      new Date().toISOString(),
    );
  }

  /**
   * Return the set of reason_key values that already have an open GitHub issue.
   * A blocker whose issue has been resolved (resolved_at set) is eligible for
   * re-creation if it recurs.
   */
  getActiveSkipPatternIssueKeys(): Set<string> {
    const rows = this.db.prepare(`
      SELECT reason_key FROM skip_pattern_issues WHERE resolved_at IS NULL
    `).all() as Array<{ reason_key: string }>;
    return new Set(rows.map((r) => r.reason_key));
  }

  /**
   * Mark a skip pattern issue as resolved (e.g. the GitHub issue was closed).
   */
  resolveSkipPatternIssue(reasonKey: string): void {
    this.db.prepare(`
      UPDATE skip_pattern_issues SET resolved_at = ? WHERE reason_key = ?
    `).run(new Date().toISOString(), reasonKey);
  }

  // ── Multi-repo coordination groups ─────────────────────────────────────────

  /**
   * Lazily create the coordination_groups table (called on first use so
   * existing deployments get the table without a manual migration step).
   */
  private ensureCoordinationGroupsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coordination_groups (
        id                    TEXT PRIMARY KEY,
        parent_task_id        TEXT NOT NULL,
        parent_source_ref     TEXT,
        change_sets_json      TEXT NOT NULL,
        child_task_ids_json   TEXT NOT NULL DEFAULT '{}',
        child_pr_numbers_json TEXT NOT NULL DEFAULT '{}',
        child_pr_urls_json    TEXT NOT NULL DEFAULT '{}',
        status                TEXT NOT NULL DEFAULT 'pending',
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_coordination_groups_parent_task
        ON coordination_groups(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_coordination_groups_status
        ON coordination_groups(status);
    `);
  }

  /**
   * Persist a new CoordinationGroup record.
   */
  createCoordinationGroup(group: {
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  }): void {
    this.ensureCoordinationGroupsTable();
    this.db.prepare(`
      INSERT INTO coordination_groups
        (id, parent_task_id, parent_source_ref, change_sets_json,
         child_task_ids_json, child_pr_numbers_json, child_pr_urls_json,
         status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      group.id,
      group.parentTaskId,
      group.parentSourceRef,
      JSON.stringify(group.changeSets),
      JSON.stringify(group.childTaskIds),
      JSON.stringify(group.childPRNumbers),
      JSON.stringify(group.childPRUrls),
      group.status,
      group.createdAt,
      group.updatedAt,
    );
  }

  /**
   * Retrieve a coordination group by its ID.
   */
  getCoordinationGroup(id: string): {
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    this.ensureCoordinationGroupsTable();
    const row = this.db.prepare(
      "SELECT * FROM coordination_groups WHERE id = ?",
    ).get(id) as {
      id: string;
      parent_task_id: string;
      parent_source_ref: string | null;
      change_sets_json: string;
      child_task_ids_json: string;
      child_pr_numbers_json: string;
      child_pr_urls_json: string;
      status: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;
    return this.deserializeCoordinationGroupRow(row);
  }

  /**
   * Find the coordination group that contains the given child task ID.
   * Returns null if this task is not part of any coordination group.
   */
  getCoordinationGroupByChildTaskId(childTaskId: string): {
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    this.ensureCoordinationGroupsTable();
    // child_task_ids_json is a JSON object; use LIKE for a cheap filter before
    // parsing in application code (avoids a full-table scan with JSON_EACH).
    const rows = this.db.prepare(`
      SELECT * FROM coordination_groups
      WHERE child_task_ids_json LIKE ?
    `).all(`%${childTaskId}%`) as Array<{
      id: string;
      parent_task_id: string;
      parent_source_ref: string | null;
      change_sets_json: string;
      child_task_ids_json: string;
      child_pr_numbers_json: string;
      child_pr_urls_json: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;

    for (const row of rows) {
      const group = this.deserializeCoordinationGroupRow(row);
      if (Object.values(group.childTaskIds).includes(childTaskId)) {
        return group;
      }
    }
    return null;
  }

  /**
   * Find the coordination group for a given parent task ID.
   */
  getCoordinationGroupByParentTaskId(parentTaskId: string): {
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  } | null {
    this.ensureCoordinationGroupsTable();
    const row = this.db.prepare(
      "SELECT * FROM coordination_groups WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parentTaskId) as {
      id: string;
      parent_task_id: string;
      parent_source_ref: string | null;
      change_sets_json: string;
      child_task_ids_json: string;
      child_pr_numbers_json: string;
      child_pr_urls_json: string;
      status: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!row) return null;
    return this.deserializeCoordinationGroupRow(row);
  }

  /**
   * Update fields on an existing coordination group.
   */
  updateCoordinationGroup(
    id: string,
    updates: {
      status?: string;
      childPRNumbers?: Record<string, number>;
      childPRUrls?: Record<string, string>;
    },
  ): void {
    this.ensureCoordinationGroupsTable();
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const params: unknown[] = [now];

    if (updates.status !== undefined) {
      sets.push("status = ?");
      params.push(updates.status);
    }
    if (updates.childPRNumbers !== undefined) {
      sets.push("child_pr_numbers_json = ?");
      params.push(JSON.stringify(updates.childPRNumbers));
    }
    if (updates.childPRUrls !== undefined) {
      sets.push("child_pr_urls_json = ?");
      params.push(JSON.stringify(updates.childPRUrls));
    }

    params.push(id);
    this.db.prepare(
      `UPDATE coordination_groups SET ${sets.join(", ")} WHERE id = ?`,
    ).run(...params);
  }

  /**
   * Return coordination groups in a given status (for daemon polling).
   */
  getCoordinationGroupsByStatus(status: string): Array<{
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  }> {
    this.ensureCoordinationGroupsTable();
    const rows = this.db.prepare(
      "SELECT * FROM coordination_groups WHERE status = ? ORDER BY created_at ASC",
    ).all(status) as Array<{
      id: string;
      parent_task_id: string;
      parent_source_ref: string | null;
      change_sets_json: string;
      child_task_ids_json: string;
      child_pr_numbers_json: string;
      child_pr_urls_json: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((r) => this.deserializeCoordinationGroupRow(r));
  }

  private deserializeCoordinationGroupRow(row: {
    id: string;
    parent_task_id: string;
    parent_source_ref: string | null;
    change_sets_json: string;
    child_task_ids_json: string;
    child_pr_numbers_json: string;
    child_pr_urls_json: string;
    status: string;
    created_at: string;
    updated_at: string;
  }): {
    id: string;
    parentTaskId: string;
    parentSourceRef: string | null;
    changeSets: unknown[];
    childTaskIds: Record<string, string>;
    childPRNumbers: Record<string, number>;
    childPRUrls: Record<string, string>;
    status: string;
    createdAt: string;
    updatedAt: string;
  } {
    return {
      id: row.id,
      parentTaskId: row.parent_task_id,
      parentSourceRef: row.parent_source_ref,
      changeSets: JSON.parse(row.change_sets_json),
      childTaskIds: JSON.parse(row.child_task_ids_json),
      childPRNumbers: JSON.parse(row.child_pr_numbers_json),
      childPRUrls: JSON.parse(row.child_pr_urls_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ── Follow-up Chain Tracker ───────────────────────────────────────────────

  /**
   * Return all `lineage_mappings` entries whose `parent_source_ref` matches
   * the given source ref.  These are direct follow-up issues spawned by
   * `parentSourceRef`.
   */
  getLineageChildren(parentSourceRef: string): Array<{
    source_ref: string;
    lineage_group_id: string;
    parent_source_ref: string | null;
    created_at: string;
  }> {
    return this.db
      .prepare(
        "SELECT source_ref, lineage_group_id, parent_source_ref, created_at FROM lineage_mappings WHERE parent_source_ref = ? ORDER BY created_at ASC",
      )
      .all(parentSourceRef) as Array<{
        source_ref: string;
        lineage_group_id: string;
        parent_source_ref: string | null;
        created_at: string;
      }>;
  }

  /**
   * Return aggregated token and quality stats for all tasks associated with
   * the given source refs (one or more).  Combines task_logs token columns
   * with verification quality scores.
   */
  getChainStats(sourceRefs: string[]): {
    task_count: number;
    agent_names: string[];
    avg_quality_score: number | null;
    total_tokens_in: number;
    total_tokens_out: number;
    pr_count: number;
  } {
    if (sourceRefs.length === 0) {
      return {
        task_count: 0,
        agent_names: [],
        avg_quality_score: null,
        total_tokens_in: 0,
        total_tokens_out: 0,
        pr_count: 0,
      };
    }

    const placeholders = sourceRefs.map(() => "?").join(", ");

    const taskRow = this.db
      .prepare(
        `SELECT
           COUNT(*)                                            AS task_count,
           GROUP_CONCAT(DISTINCT agent_name)                  AS agent_names,
           AVG(CASE WHEN quality_score IS NOT NULL THEN quality_score END) AS avg_quality_score
         FROM tasks
         WHERE source_ref IN (${placeholders})
           AND parent_task_id IS NULL`,
      )
      .get(...sourceRefs) as {
        task_count: number;
        agent_names: string | null;
        avg_quality_score: number | null;
      };

    // Sum tokens from task_logs for all tasks under these source_refs
    const tokenRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(tl.tokens_in),  0) AS total_in,
           COALESCE(SUM(tl.tokens_out), 0) AS total_out
         FROM task_logs tl
         JOIN tasks t ON t.id = tl.task_id
         WHERE t.source_ref IN (${placeholders})
           AND t.parent_task_id IS NULL`,
      )
      .get(...sourceRefs) as { total_in: number; total_out: number };

    // Count distinct PRs created from pr-feedback tasks or verifiable task results
    const prRow = this.db
      .prepare(
        `SELECT COUNT(DISTINCT t.source_ref) AS pr_count
         FROM tasks t
         WHERE t.source_ref IN (${placeholders})
           AND t.parent_task_id IS NULL
           AND t.verification_status = 'approved'`,
      )
      .get(...sourceRefs) as { pr_count: number };

    const agentNames = taskRow.agent_names
      ? taskRow.agent_names.split(",").filter(Boolean)
      : [];

    return {
      task_count: taskRow.task_count,
      agent_names: [...new Set(agentNames)],
      avg_quality_score: taskRow.avg_quality_score,
      total_tokens_in: tokenRow.total_in,
      total_tokens_out: tokenRow.total_out,
      pr_count: prRow.pr_count,
    };
  }

  // ── Health Check Storm Panel (issue #743) ──────────────────────────────────

  /**
   * Create the health_check_events table.  Idempotent — safe to call on
   * databases that were created before this migration shipped.
   */
  private runHealthCheckEventsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_check_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        agent_name  TEXT NOT NULL,
        detail      TEXT,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hce_recorded_at ON health_check_events(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_hce_kind        ON health_check_events(kind);
    `);
  }

  /**
   * Record a health check event (dispatched, grace_period_suppressed, or
   * dedup_gate_suppressed) so the /health-checks panel can show the
   * before/after impact of the three storm fixes.
   */
  recordHealthCheckEvent(params: {
    kind: HealthCheckEventKind;
    agent_name: string;
    detail?: string;
  }): void {
    this.db.prepare(`
      INSERT INTO health_check_events (kind, agent_name, detail, recorded_at)
      VALUES (?, ?, ?, ?)
    `).run(params.kind, params.agent_name, params.detail ?? null, new Date().toISOString());
  }

  /**
   * Return per-hour health check storm metrics over a rolling window.
   *
   * Each row counts three mutually exclusive outcomes for health check
   * evaluations in that hour:
   *   - dispatched             — an escalation task was created
   *   - grace_period_suppressed — agent recovered before grace period expired
   *   - dedup_gate_suppressed  — already had an active incident (no-op)
   *
   * The baseline_dispatch_rate_pct field encodes the pre-fix rate (45%) so
   * operators can compare current behaviour against the historical baseline.
   */
  getHealthCheckStormMetrics(windowHours = 24): HealthCheckStormMetrics {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    const rows = this.db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00', recorded_at) AS hour,
        SUM(CASE WHEN kind = 'dispatched'              THEN 1 ELSE 0 END) AS dispatched,
        SUM(CASE WHEN kind = 'grace_period_suppressed' THEN 1 ELSE 0 END) AS grace_period_suppressed,
        SUM(CASE WHEN kind = 'dedup_gate_suppressed'   THEN 1 ELSE 0 END) AS dedup_gate_suppressed,
        COUNT(*)                                                           AS total_evaluated
      FROM health_check_events
      WHERE recorded_at >= ?
      GROUP BY hour
      ORDER BY hour ASC
    `).all(since) as Array<{
      hour: string;
      dispatched: number;
      grace_period_suppressed: number;
      dedup_gate_suppressed: number;
      total_evaluated: number;
    }>;

    const hourly: HealthCheckStormHour[] = rows.map((r) => ({
      hour: r.hour,
      dispatched: r.dispatched,
      grace_period_suppressed: r.grace_period_suppressed,
      dedup_gate_suppressed: r.dedup_gate_suppressed,
      total_evaluated: r.total_evaluated,
    }));

    const totalDispatched = hourly.reduce((s, r) => s + r.dispatched, 0);
    const totalGrace = hourly.reduce((s, r) => s + r.grace_period_suppressed, 0);
    const totalDedup = hourly.reduce((s, r) => s + r.dedup_gate_suppressed, 0);
    const totalEvaluated = hourly.reduce((s, r) => s + r.total_evaluated, 0);

    return {
      window_hours: windowHours,
      hourly,
      total_dispatched: totalDispatched,
      total_grace_period_suppressed: totalGrace,
      total_dedup_gate_suppressed: totalDedup,
      total_evaluated: totalEvaluated,
      dispatch_rate_pct: totalEvaluated > 0 ? (totalDispatched / totalEvaluated) * 100 : null,
      baseline_dispatch_rate_pct: 45,
    };
  }

  // ── Staging Validations (issue #896) ──────────────────────────────────────

  /**
   * Create the staging_validations table.  Idempotent — safe to call on
   * databases that were created before this migration shipped.
   *
   * Intentionally has NO foreign key to tasks(id) because post-merge
   * validation events are not tied to a specific task.
   */
  private runStagingValidationsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS staging_validations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        repo       TEXT NOT NULL,
        pr_number  INTEGER NOT NULL,
        sha        TEXT NOT NULL,
        passed     INTEGER NOT NULL,
        output     TEXT,
        duration_ms INTEGER,
        validated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sv_repo_pr ON staging_validations(repo, pr_number);
      CREATE INDEX IF NOT EXISTS idx_sv_validated_at ON staging_validations(validated_at);
    `);
  }

  /**
   * Persist a post-merge staging validation result.
   *
   * Use this instead of addLog() — addLog() requires a valid task_id
   * (FK → tasks.id) but staging validation events are not tied to any
   * specific task, so using addLog() with task_id="" causes a FOREIGN KEY
   * constraint failure.
   */
  recordStagingValidation(params: {
    repo: string;
    prNumber: number;
    sha: string;
    passed: boolean;
    output?: string;
    duration_ms?: number;
  }): void {
    this.db.prepare(`
      INSERT INTO staging_validations (repo, pr_number, sha, passed, output, duration_ms, validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.repo,
      params.prNumber,
      params.sha,
      params.passed ? 1 : 0,
      params.output ?? null,
      params.duration_ms ?? null,
      new Date().toISOString(),
    );
  }

  // ── Verification Outcome Logs (calibration feedback loop) ─────────────────

  /**
   * Create the verification_outcome_logs table.
   *
   * Implements Phase 1 of the calibration strategy from
   * findings/verification-calibration.md: track each PR's merge outcome
   * against the original verification score so the calibration loop can
   * identify per-verifier score accuracy over time.
   *
   * The `pr_outcome` column is initially NULL; it is populated by the
   * GitHub PR events poller once the PR reaches a terminal state.
   */
  private runVerificationOutcomesMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_outcome_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id          TEXT NOT NULL,
        pr_url           TEXT,
        verifier_agent   TEXT NOT NULL,
        verification_score REAL NOT NULL,
        score_bucket     TEXT NOT NULL,
        task_type        TEXT NOT NULL,
        verified_at      TEXT NOT NULL,

        -- Outcome fields — populated post-merge/close by PR events poller
        pr_outcome       TEXT,           -- 'merged_clean' | 'merged_with_feedback' | 'rejected' | 'redispatched'
        review_comment_count INTEGER,
        days_to_resolution REAL,
        resolved_at      TEXT,

        -- Derived weight for calibration (1.0 | 0.5 | 0.0)
        merge_weight     REAL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_vol_task_id ON verification_outcome_logs(task_id);
      CREATE INDEX IF NOT EXISTS idx_vol_verifier ON verification_outcome_logs(verifier_agent, score_bucket, task_type);
      CREATE INDEX IF NOT EXISTS idx_vol_verified_at ON verification_outcome_logs(verified_at);
      CREATE INDEX IF NOT EXISTS idx_vol_pr_outcome ON verification_outcome_logs(pr_outcome);
    `);
  }

  /**
   * Create the persisted verification calibration recommendation ledger.
   *
   * Each build of the calibration report writes a new row so operators can
   * inspect recommendation history and the daemon can consume the latest
   * applied thresholds without relying on Telegram output alone.
   */
  private runVerificationCalibrationMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_calibration_recommendations (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        verifier_agent        TEXT NOT NULL,
        current_threshold     REAL NOT NULL,
        suggested_threshold   REAL NOT NULL,
        confidence            REAL NOT NULL,
        task_count            INTEGER NOT NULL,
        merge_rate            REAL NOT NULL,
        changes_requested_count INTEGER NOT NULL,
        reason                TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'pending',
        generated_at          TEXT NOT NULL,
        applied_at            TEXT,
        review_notes          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_vcr_status_generated
        ON verification_calibration_recommendations(status, generated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vcr_verifier_generated
        ON verification_calibration_recommendations(verifier_agent, generated_at DESC);
    `);
  }

  /**
   * Insert a new verification outcome log entry when a task is verified.
   * The `pr_outcome` and related fields are left NULL until the PR events
   * poller resolves the terminal state.
   */
  insertVerificationOutcome(params: {
    task_id: string;
    pr_url?: string | null;
    verifier_agent: string;
    verification_score: number;
    task_type: string;
    verified_at?: string;
  }): void {
    const score = params.verification_score;
    const bucket = this.scoreToCalibrationBucket(score);
    this.db.prepare(`
      INSERT OR IGNORE INTO verification_outcome_logs
        (task_id, pr_url, verifier_agent, verification_score, score_bucket, task_type, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.task_id,
      params.pr_url ?? null,
      params.verifier_agent,
      score,
      bucket,
      params.task_type ?? "implementation",
      params.verified_at ?? new Date().toISOString(),
    );
  }

  /**
   * Populate the outcome fields for a verification outcome log entry once
   * the associated PR reaches a terminal state (merged, rejected, etc.).
   * Called by the GitHub PR events poller.
   */
  updateVerificationOutcome(params: {
    task_id: string;
    pr_outcome: "merged_clean" | "merged_with_feedback" | "rejected" | "redispatched";
    review_comment_count: number;
    days_to_resolution: number;
    resolved_at: string;
  }): void {
    const merge_weight =
      params.pr_outcome === "merged_clean"
        ? 1.0
        : params.pr_outcome === "merged_with_feedback"
          ? 0.5
          : 0.0;

    this.db.prepare(`
      UPDATE verification_outcome_logs
      SET pr_outcome = ?, review_comment_count = ?, days_to_resolution = ?,
          resolved_at = ?, merge_weight = ?
      WHERE task_id = ?
    `).run(
      params.pr_outcome,
      params.review_comment_count,
      params.days_to_resolution,
      params.resolved_at,
      merge_weight,
      params.task_id,
    );
  }

  /**
   * Query the calibration lookup table: aggregate outcomes by
   * (verifier_agent, score_bucket, task_type) to compute empirical
   * merge rates per bucket.
   *
   * Only rows with a resolved pr_outcome are included; pending entries
   * (pr_outcome IS NULL) are excluded from rate calculations.
   */
  getCalibrationTable(): Array<{
    verifier_agent: string;
    score_bucket: string;
    task_type: string;
    n: number;
    merge_rate: number;
    stddev: number;
  }> {
    return this.db.prepare(`
      SELECT
        verifier_agent,
        score_bucket,
        task_type,
        COUNT(*) AS n,
        AVG(merge_weight) AS merge_rate,
        -- Population stddev approximation via variance
        SQRT(AVG(merge_weight * merge_weight) - AVG(merge_weight) * AVG(merge_weight)) AS stddev
      FROM verification_outcome_logs
      WHERE pr_outcome IS NOT NULL
      GROUP BY verifier_agent, score_bucket, task_type
      ORDER BY verifier_agent, score_bucket, task_type
    `).all() as Array<{
      verifier_agent: string;
      score_bucket: string;
      task_type: string;
      n: number;
      merge_rate: number;
      stddev: number;
    }>;
  }

  /**
   * Persist a batch of calibration recommendations for later review and
   * threshold application.
   *
   * Recommendations are written as history rows. High-confidence rows are
   * auto-applied by marking them "applied" immediately so daemon checks can
   * pick them up on the next cycle.
   */
  recordVerificationCalibrationRecommendations(
    recommendations: Array<{
      verifierAgent: string;
      currentThreshold: number;
      suggestedThreshold: number;
      confidence: number;
      taskCount: number;
      mergeRate: number;
      changesRequestedCount: number;
      reason: string;
    }>,
    generatedAt = new Date().toISOString(),
  ): {
    persisted: number;
    autoApplied: number;
  } {
    this.runVerificationCalibrationMigration();
    if (recommendations.length === 0) {
      return { persisted: 0, autoApplied: 0 };
    }

    const insert = this.db.prepare(`
      INSERT INTO verification_calibration_recommendations (
        verifier_agent,
        current_threshold,
        suggested_threshold,
        confidence,
        task_count,
        merge_rate,
        changes_requested_count,
        reason,
        status,
        generated_at,
        applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const shouldAutoApply = (confidence: number, taskCount: number): boolean =>
      confidence >= 0.85 && taskCount >= 10;

    let autoApplied = 0;
    const txn = this.db.transaction(() => {
      for (const rec of recommendations) {
        const status: VerificationCalibrationRecommendationRow["status"] =
          shouldAutoApply(rec.confidence, rec.taskCount) ? "applied" : "pending";
        const appliedAt = status === "applied" ? generatedAt : null;
        insert.run(
          rec.verifierAgent,
          rec.currentThreshold,
          rec.suggestedThreshold,
          rec.confidence,
          rec.taskCount,
          rec.mergeRate,
          rec.changesRequestedCount,
          rec.reason,
          status,
          generatedAt,
          appliedAt,
        );
        if (status === "applied") autoApplied++;
      }
    });

    txn();
    return { persisted: recommendations.length, autoApplied };
  }

  /**
   * Return the most recent calibration recommendations, newest first.
   */
  getVerificationCalibrationRecommendations(limit = 50): VerificationCalibrationRecommendationRow[] {
    this.runVerificationCalibrationMigration();
    return this.db.prepare(`
      SELECT *
      FROM verification_calibration_recommendations
      ORDER BY generated_at DESC, id DESC
      LIMIT ?
    `).all(limit) as VerificationCalibrationRecommendationRow[];
  }

  /**
   * Return the latest applied threshold override per verifier agent.
   * These values are merged over config thresholds by the daemon.
   */
  getAppliedVerificationCalibrationThresholds(): Record<string, number> {
    this.runVerificationCalibrationMigration();
    const rows = this.db.prepare(`
      SELECT r.verifier_agent, r.suggested_threshold
      FROM verification_calibration_recommendations r
      INNER JOIN (
        SELECT verifier_agent, MAX(id) AS id
        FROM verification_calibration_recommendations
        WHERE status = 'applied'
        GROUP BY verifier_agent
      ) latest
        ON latest.verifier_agent = r.verifier_agent
       AND latest.id = r.id
    `).all() as Array<{ verifier_agent: string; suggested_threshold: number }>;

    const thresholds: Record<string, number> = {};
    for (const row of rows) {
      thresholds[row.verifier_agent] = row.suggested_threshold;
    }
    return thresholds;
  }

  /**
   * Return all pending verification outcome log entries (where pr_outcome
   * is NULL and a pr_url is known), for the GitHub events poller to process.
   */
  getPendingVerificationOutcomes(): Array<{
    task_id: string;
    pr_url: string;
    verifier_agent: string;
    verified_at: string;
  }> {
    return this.db.prepare(`
      SELECT task_id, pr_url, verifier_agent, verified_at
      FROM verification_outcome_logs
      WHERE pr_outcome IS NULL AND pr_url IS NOT NULL
      ORDER BY verified_at ASC
    `).all() as Array<{
      task_id: string;
      pr_url: string;
      verifier_agent: string;
      verified_at: string;
    }>;
  }

  /** Map a verification score to its calibration bucket string. */
  private scoreToCalibrationBucket(score: number): string {
    if (score < 0.5) return "0.0-0.5";
    if (score < 0.6) return "0.5-0.6";
    if (score < 0.7) return "0.6-0.7";
    if (score < 0.8) return "0.7-0.8";
    if (score < 0.9) return "0.8-0.9";
    return "0.9-1.0";
  }

  // ── Duplicate ID incidents ─────────────────────────────────────────────────

  /**
   * Lazily create the duplicate_id_incidents table on first use.
   * Using lazy creation keeps existing DB snapshots compatible without a
   * full migration pass.
   */
  private ensureDuplicateIdIncidentsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS duplicate_id_incidents (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL,
        first_title  TEXT NOT NULL,
        second_title TEXT NOT NULL,
        detected_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dup_id_incidents_task_id
        ON duplicate_id_incidents(task_id);
    `);
  }

  /**
   * Persist a duplicate-task-ID incident so the CLI and dashboard can surface
   * a warning icon next to affected task IDs.
   */
  recordDuplicateIdIncident(params: {
    taskId: string;
    firstTitle: string;
    secondTitle: string;
  }): void {
    this.ensureDuplicateIdIncidentsTable();
    this.db.prepare(`
      INSERT INTO duplicate_id_incidents (task_id, first_title, second_title, detected_at)
      VALUES (?, ?, ?, ?)
    `).run(params.taskId, params.firstTitle, params.secondTitle, new Date().toISOString());
  }

  /**
   * Return all persisted duplicate-ID incidents, most recent first.
   * Capped at 200 rows so the result set stays bounded.
   */
  getDuplicateIdIncidents(): Array<{
    id: number;
    taskId: string;
    firstTitle: string;
    secondTitle: string;
    detectedAt: string;
  }> {
    this.ensureDuplicateIdIncidentsTable();
    const rows = this.db.prepare(`
      SELECT id, task_id, first_title, second_title, detected_at
      FROM duplicate_id_incidents
      ORDER BY detected_at DESC
      LIMIT 200
    `).all() as Array<{
      id: number;
      task_id: string;
      first_title: string;
      second_title: string;
      detected_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      firstTitle: r.first_title,
      secondTitle: r.second_title,
      detectedAt: r.detected_at,
    }));
  }

  /**
   * Return the set of task IDs that have had a duplicate-ID incident.
   * Used by the CLI and dashboard to render a ⚠ warning icon next to
   * affected tasks.
   */
  getFlaggedDuplicateTaskIds(): Set<string> {
    this.ensureDuplicateIdIncidentsTable();
    const rows = this.db.prepare(`
      SELECT DISTINCT task_id FROM duplicate_id_incidents
    `).all() as Array<{ task_id: string }>;
    return new Set(rows.map((r) => r.task_id));
  }

  // ── ULID Collision Log (issue #1133) ──────────────────────────────────────

  /**
   * Lazily create the ulid_collision_log table on first use.
   * Separate from duplicate_id_incidents so collision events have their own
   * dedicated feed at `/api/ulid-collisions` without mixing with cycle-level
   * duplicate detection incidents.
   */
  private ensureUlidCollisionLogTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ulid_collision_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        colliding_id   TEXT NOT NULL,
        existing_title TEXT NOT NULL,
        new_title      TEXT NOT NULL,
        detected_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ulid_collision_log_id
        ON ulid_collision_log(colliding_id);
      CREATE INDEX IF NOT EXISTS idx_ulid_collision_log_detected_at
        ON ulid_collision_log(detected_at);
    `);
  }

  /**
   * Persist a ULID collision event detected during createTask().
   * Called before the retry (or before throwing DuplicateTaskIdError if retries
   * are exhausted). Non-fatal — callers wrap in try/catch.
   */
  recordUlidCollision(params: {
    collidingId: string;
    existingTitle: string;
    newTitle: string;
  }): void {
    this.ensureUlidCollisionLogTable();
    this.db.prepare(`
      INSERT INTO ulid_collision_log (colliding_id, existing_title, new_title, detected_at)
      VALUES (?, ?, ?, ?)
    `).run(params.collidingId, params.existingTitle, params.newTitle, new Date().toISOString());
  }

  /**
   * Return all ULID collision events, most recent first.
   * Capped at 500 rows to keep the result set bounded.
   * Consumed by the `/api/ulid-collisions` metrics endpoint (issue #1133).
   */
  getUlidCollisions(limit = 500): Array<{
    id: number;
    collidingId: string;
    existingTitle: string;
    newTitle: string;
    detectedAt: string;
  }> {
    this.ensureUlidCollisionLogTable();
    const rows = this.db.prepare(`
      SELECT id, colliding_id, existing_title, new_title, detected_at
      FROM ulid_collision_log
      ORDER BY detected_at DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      colliding_id: string;
      existing_title: string;
      new_title: string;
      detected_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      collidingId: r.colliding_id,
      existingTitle: r.existing_title,
      newTitle: r.new_title,
      detectedAt: r.detected_at,
    }));
  }

  /**
   * Return the total number of ULID collision events ever recorded.
   * Used by the metrics endpoint to surface a summary count.
   */
  getUlidCollisionCount(): number {
    this.ensureUlidCollisionLogTable();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM ulid_collision_log
    `).get() as { cnt: number };
    return row.cnt;
  }

  // ── Persistent Anomalies ───────────────────────────────────────────────────

  /**
   * Lazily create the score_anomaly_observations table.
   * Populated by the verifier (parse-failure guard) and improvement detector.
   * Queried by /api/persistent-anomalies endpoint and `orch anomalies` CLI (issue #1207).
   */
  private ensureScoreAnomalyObservationsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS score_anomaly_observations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL,
        agent        TEXT NOT NULL,
        anomaly_type TEXT NOT NULL,
        cycle_count  INTEGER NOT NULL DEFAULT 1,
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL,
        UNIQUE(task_id, anomaly_type)
      );
      CREATE INDEX IF NOT EXISTS idx_sao_agent
        ON score_anomaly_observations(agent);
      CREATE INDEX IF NOT EXISTS idx_sao_anomaly_type
        ON score_anomaly_observations(anomaly_type);
      CREATE INDEX IF NOT EXISTS idx_sao_last_seen
        ON score_anomaly_observations(last_seen);
    `);
  }

  /**
   * Record or increment a score anomaly observation for a task.
   * If the (task_id, anomaly_type) pair already exists, increments cycle_count
   * and updates last_seen. Otherwise inserts a new row.
   * Safe to call idempotently — duplicate calls update in place.
   */
  recordScoreAnomalyObservation(params: {
    taskId: string;
    agent: string;
    anomalyType: string;
  }): void {
    this.ensureScoreAnomalyObservationsTable();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO score_anomaly_observations (task_id, agent, anomaly_type, cycle_count, first_seen, last_seen)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(task_id, anomaly_type) DO UPDATE SET
        cycle_count = cycle_count + 1,
        last_seen   = excluded.last_seen
    `).run(params.taskId, params.agent, params.anomalyType, now, now);
  }

  /**
   * Return persistent anomaly observations for the given rolling window.
   * Supports filtering by minimum cycle_count and by agent name.
   * Results ordered by last_seen DESC (most recent first).
   * Consumed by /api/persistent-anomalies and `orch anomalies` (issue #1207).
   */
  getPersistentAnomaliesPayload(
    days = 30,
    minCycles = 1,
    agent: string | null = null,
    limit = 200,
  ): Array<{
    task_id: string;
    agent: string;
    anomaly_type: string;
    cycle_count: number;
    first_seen: string;
    last_seen: string;
  }> {
    this.ensureScoreAnomalyObservationsTable();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const agentFilter = agent ? "AND agent = ?" : "";
    const params: (string | number)[] = [minCycles, cutoff];
    if (agent) params.push(agent);
    params.push(limit);

    return this.db.prepare(`
      SELECT task_id, agent, anomaly_type, cycle_count, first_seen, last_seen
      FROM score_anomaly_observations
      WHERE cycle_count >= ?
        AND last_seen >= ?
        ${agentFilter}
      ORDER BY last_seen DESC
      LIMIT ?
    `).all(...params) as Array<{
      task_id: string;
      agent: string;
      anomaly_type: string;
      cycle_count: number;
      first_seen: string;
      last_seen: string;
    }>;
  }

  /**
   * Return total count of persistent anomaly observations (cycle_count >= minCycles)
   * within the given rolling window. Used by the Telegram digest.
   */
  getPersistentAnomalyCount(days = 1, minCycles = 1): number {
    this.ensureScoreAnomalyObservationsTable();
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const row = this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM score_anomaly_observations
      WHERE cycle_count >= ?
        AND last_seen >= ?
    `).get(minCycles, cutoff) as { cnt: number };
    return row.cnt;
  }

  // ── Approval Queue ─────────────────────────────────────────────────────────

  /**
   * Lazily create the approval_queue table.
   * Called before every approval-queue read/write so older deployments get the
   * table without a manual migration step.
   */
  private runApprovalQueueMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approval_queue (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL UNIQUE,
        title        TEXT NOT NULL,
        agent_name   TEXT,
        pr_url       TEXT,
        score        REAL NOT NULL,
        dimensions_json TEXT,
        risk_summary TEXT,
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TEXT NOT NULL,
        resolved_at  TEXT,
        resolved_by  TEXT,
        bypass_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_aq_status     ON approval_queue(status);
      CREATE INDEX IF NOT EXISTS idx_aq_created_at ON approval_queue(created_at);
      CREATE INDEX IF NOT EXISTS idx_aq_task_id    ON approval_queue(task_id);
    `);
  }

  /**
   * Persist a new entry in the operator approval queue.
   * Silently ignores duplicate task_id (the entry already exists).
   */
  insertApprovalQueueEntry(params: InsertApprovalQueueEntryParams): void {
    this.runApprovalQueueMigration();
    this.db.prepare(`
      INSERT OR IGNORE INTO approval_queue
        (task_id, title, agent_name, pr_url, score, dimensions_json, risk_summary, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      params.task_id,
      params.title,
      params.agent_name ?? null,
      params.pr_url ?? null,
      params.score,
      params.dimensions_json ?? null,
      params.risk_summary ?? null,
      new Date().toISOString(),
    );
  }

  /**
   * Fetch the approval queue entry for a given full task_id.
   * Returns null if no entry exists.
   */
  getApprovalQueueEntry(taskId: string): ApprovalQueueEntry | null {
    this.runApprovalQueueMigration();
    return (
      this.db.prepare(`
        SELECT * FROM approval_queue WHERE task_id = ? LIMIT 1
      `).get(taskId) as ApprovalQueueEntry | undefined
    ) ?? null;
  }

  /**
   * Lookup an approval queue entry by 8-character task ID prefix.
   * Used by the Telegram /approve and /reject commands.
   */
  getApprovalQueueEntryByShortId(shortId: string): ApprovalQueueEntry | null {
    this.runApprovalQueueMigration();
    const rows = this.db.prepare(`
      SELECT * FROM approval_queue
      WHERE task_id LIKE ? || '%'
      ORDER BY created_at DESC
      LIMIT 1
    `).all(shortId) as ApprovalQueueEntry[];
    return rows[0] ?? null;
  }

  /**
   * Return all entries currently in 'pending' state, newest first.
   */
  getPendingApprovalQueue(limit = 20): ApprovalQueueEntry[] {
    this.runApprovalQueueMigration();
    return this.db.prepare(`
      SELECT * FROM approval_queue
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as ApprovalQueueEntry[];
  }

  /**
   * Mark an approval queue entry as resolved (approved or rejected).
   *
   * @param id       Primary key of the entry.
   * @param status   New status: 'approved' | 'rejected'.
   * @param resolvedBy  Who resolved it: 'operator' | 'system'.
   * @param bypassReason Optional reason provided by operator when force-approving a very low-score task.
   */
  resolveApprovalQueueEntry(id: number, status: "approved" | "rejected", resolvedBy: string, bypassReason?: string): void {
    this.runApprovalQueueMigration();
    this.db.prepare(`
      UPDATE approval_queue
      SET status = ?, resolved_at = ?, resolved_by = ?, bypass_reason = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), resolvedBy, bypassReason ?? null, id);
  }

  // ── Dispatch Block tracking (issue #976) ─────────────────────────────────────

  private runDispatchBlocksMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_blocks (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        source_ref          TEXT    NOT NULL,
        agent_name          TEXT,
        reason              TEXT    NOT NULL,
        block_code          TEXT    NOT NULL DEFAULT 'unknown',
        blocking_pr_number  INTEGER,
        timestamp           TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_blocks_timestamp  ON dispatch_blocks(timestamp);
      CREATE INDEX IF NOT EXISTS idx_dispatch_blocks_source_ref ON dispatch_blocks(source_ref);
      CREATE INDEX IF NOT EXISTS idx_dispatch_blocks_block_code ON dispatch_blocks(block_code);
    `);
    // Migration: add detection_strategy column if not present (issue #1179)
    const cols = this.db
      .prepare("PRAGMA table_info(dispatch_blocks)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "detection_strategy")) {
      this.db.exec(
        "ALTER TABLE dispatch_blocks ADD COLUMN detection_strategy TEXT",
      );
    }
  }

  /**
   * Persist a single dispatch-block event to state.db.
   *
   * Called by the pre-dispatch guard whenever a dispatch is blocked because an
   * open or approved PR already exists for the target issue.
   *
   * @param params.sourceRef            Issue ref, e.g. "rapartlu/agent-orchestrator#976"
   * @param params.agentName            Agent the dispatch would have gone to
   * @param params.reason               Human-readable block reason
   * @param params.blockCode            Machine code: "open_pr_exists" | "approved_pr_waiting"
   * @param params.blockingPRNumber     PR number that caused the block
   * @param params.detectionStrategy    Which strategy detected the blocking PR (issue #1179):
   *                                    "search_index" | "branch_name" | "body_keyword"
   */
  recordDispatchBlock(params: {
    sourceRef: string;
    agentName?: string;
    reason: string;
    blockCode: string;
    blockingPRNumber?: number;
    detectionStrategy?: string;
  }): void {
    this.runDispatchBlocksMigration();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO dispatch_blocks
          (source_ref, agent_name, reason, block_code, blocking_pr_number, detection_strategy, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.sourceRef,
        params.agentName ?? null,
        params.reason,
        params.blockCode,
        params.blockingPRNumber ?? null,
        params.detectionStrategy ?? null,
        now,
      );
  }

  /**
   * Check whether a PR-guard block (open_pr_exists | approved_pr_waiting) was
   * already recorded for this source_ref within the given window.
   *
   * Used by the dispatch flood gate (issue #1060) to suppress duplicate
   * "already-in-review" tasks: the second and subsequent guard fires within
   * the cooldown window are silently dropped — no task created, no block
   * event recorded, no Telegram notification sent.
   *
   * @param sourceRef  e.g. "rapartlu/agent-orchestrator#1060"
   * @param windowMs   Look-back window in milliseconds (default: 60 minutes)
   */
  hasRecentGuardBlock(sourceRef: string, windowMs = 3_600_000): boolean {
    this.runDispatchBlocksMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1
         FROM dispatch_blocks
         WHERE source_ref = ?
           AND block_code IN ('open_pr_exists', 'approved_pr_waiting')
           AND timestamp >= ?
         LIMIT 1`,
      )
      .get(sourceRef, cutoff);
    return row !== undefined;
  }

  // ── PR Guard Cooldown Locks (issue #1095) ────────────────────────────────────
  //
  // Atomic lock table for PR guard deduplication.  The existing dispatch_blocks
  // pattern (read hasRecentGuardBlock → create task → write recordDispatchBlock)
  // has a TOCTOU race: when the same issue appears in overlapping or consecutive
  // poll cycles both workers read a clean DB state before either writes the block
  // row, producing two "already-in-review" tasks for the same issue.
  //
  // Fix: INSERT OR IGNORE into pr_guard_cooldown_locks with UNIQUE(source_ref).
  // SQLite serialises the insert, so only one caller can succeed — the loser
  // sees changes() == 0 and drops the duplicate before any task is created.

  private runPRGuardCooldownLocksMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_guard_cooldown_locks (
        source_ref  TEXT    NOT NULL,
        locked_at   TEXT    NOT NULL,
        expires_at  TEXT    NOT NULL,
        UNIQUE (source_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_pr_guard_cooldown_locks_expires
        ON pr_guard_cooldown_locks(expires_at);

      CREATE TABLE IF NOT EXISTS pr_guard_duplicate_attempts (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        source_ref          TEXT    NOT NULL,
        blocking_pr_number  INTEGER,
        attempted_at        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pr_guard_duplicate_attempts_at
        ON pr_guard_duplicate_attempts(attempted_at);
    `);
  }

  /**
   * Atomically try to acquire a PR guard cooldown lock for the given source ref.
   *
   * Uses `INSERT OR IGNORE` with a `UNIQUE (source_ref)` constraint so the
   * check-and-lock is a single SQLite operation — no TOCTOU race between reading
   * the cooldown state and writing the lock, even when the same issue appears in
   * overlapping or consecutive poll cycles.
   *
   * Expired locks are evicted inside the same call (before the INSERT) so a
   * re-fire after the TTL succeeds cleanly without manual cleanup.
   *
   * @param sourceRef  Issue ref, e.g. "rapartlu/research-agent#133"
   * @param windowMs   Lock TTL in milliseconds (default: 60 min, matches GUARD_FLOOD_GATE_WINDOW_MS)
   * @returns `true`  — lock newly acquired; caller may create the guard-hit task.
   *          `false` — lock already held; caller must suppress the duplicate task.
   */
  tryAcquirePRGuardLock(sourceRef: string, windowMs = 3_600_000): boolean {
    this.runPRGuardCooldownLocksMigration();
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + windowMs).toISOString();

    // Evict expired locks so a legitimate re-fire after the TTL can succeed.
    this.db.prepare(`DELETE FROM pr_guard_cooldown_locks WHERE expires_at < ?`).run(nowIso);

    // Atomic try-insert: INSERT OR IGNORE silently skips if source_ref already
    // has a non-expired lock.  We detect success via the changes() count.
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO pr_guard_cooldown_locks (source_ref, locked_at, expires_at)
         VALUES (?, ?, ?)`,
      )
      .run(sourceRef, nowIso, expiresAt);

    return (result.changes as number) > 0;
  }

  /**
   * Record a suppressed duplicate PR guard attempt for operator observability.
   *
   * Called when `tryAcquirePRGuardLock()` returns `false` — i.e. a second task
   * creation was blocked because the atomic lock was already held.  These rows
   * are queried by `getRecentPRGuardDuplicates()` to produce the 24h Telegram
   * digest (issue #1095, AC #2).
   *
   * @param sourceRef          Issue ref, e.g. "rapartlu/research-agent#133"
   * @param blockingPRNumber   Blocking PR number (for context in the digest)
   */
  recordPRGuardDuplicateAttempt(sourceRef: string, blockingPRNumber?: number): void {
    this.runPRGuardCooldownLocksMigration();
    this.db
      .prepare(
        `INSERT INTO pr_guard_duplicate_attempts (source_ref, blocking_pr_number, attempted_at)
         VALUES (?, ?, ?)`,
      )
      .run(sourceRef, blockingPRNumber ?? null, new Date().toISOString());
  }

  /**
   * Return PR guard duplicate attempts aggregated by source_ref within the given
   * time window, sorted descending by count.
   *
   * Used by the post-dispatch-loop Telegram digest (issue #1095, AC #2) so
   * operators can verify that the atomic deduplication lock is preventing
   * duplicate guard-hit task creation.
   *
   * @param windowMs  Look-back window in milliseconds (default: 24 hours)
   */
  getRecentPRGuardDuplicates(windowMs = 86_400_000): Array<{ source_ref: string; count: number }> {
    this.runPRGuardCooldownLocksMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return this.db
      .prepare(
        `SELECT source_ref, COUNT(*) AS count
         FROM pr_guard_duplicate_attempts
         WHERE attempted_at >= ?
         GROUP BY source_ref
         ORDER BY count DESC`,
      )
      .all(cutoff) as Array<{ source_ref: string; count: number }>;
  }

  // ── Dispatch Surge Suppression (issue #1113) ──────────────────────────────

  private runDispatchSurgeSuppressionMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dispatch_surge_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        repo            TEXT    NOT NULL,
        issue_number    INTEGER NOT NULL,
        event_at        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_surge_events_repo_issue
        ON dispatch_surge_events(repo, issue_number);
      CREATE INDEX IF NOT EXISTS idx_dispatch_surge_events_at
        ON dispatch_surge_events(event_at);

      CREATE TABLE IF NOT EXISTS dispatch_surge_suppressions (
        repo            TEXT    NOT NULL,
        issue_number    INTEGER NOT NULL,
        suppressed_at   TEXT    NOT NULL,
        expires_at      TEXT    NOT NULL,
        event_count     INTEGER NOT NULL,
        PRIMARY KEY (repo, issue_number)
      );
      CREATE INDEX IF NOT EXISTS idx_dispatch_surge_suppressions_expires
        ON dispatch_surge_suppressions(expires_at);
    `);
  }

  /**
   * Record a dispatch surge event (when "already-in-review" task is created).
   *
   * Checks if this issue has ≥5 events in the rolling 30-minute window.
   * If yes, creates a 2-hour suppression entry that blocks further dispatch.
   *
   * @param repo            Repository slug, e.g. "rapartlu/agent-orchestrator"
   * @param issueNumber     GitHub issue number
   * @returns               `{ suppressed: true, expiresAt: <ISO> }` if suppression just triggered,
   *                        `{ suppressed: false }` otherwise
   */
  recordDispatchSurgeEvent(repo: string, issueNumber: number): { suppressed: boolean; expiresAt?: string } {
    this.runDispatchSurgeSuppressionMigration();
    const now = new Date();
    const nowIso = now.toISOString();

    // Record the event
    this.db
      .prepare(
        `INSERT INTO dispatch_surge_events (repo, issue_number, event_at)
         VALUES (?, ?, ?)`,
      )
      .run(repo, issueNumber, nowIso);

    // Clean up old events outside the 30-minute window
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();
    this.db
      .prepare(
        `DELETE FROM dispatch_surge_events
         WHERE repo = ? AND issue_number = ? AND event_at < ?`,
      )
      .run(repo, issueNumber, thirtyMinutesAgo);

    // Count events in the rolling 30-minute window
    const eventCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM dispatch_surge_events
           WHERE repo = ? AND issue_number = ? AND event_at >= ?`,
        )
        .get(repo, issueNumber, thirtyMinutesAgo) as { count: number }
    ).count;

    // Check if suppression should be triggered (≥5 events)
    const SURGE_THRESHOLD = 5;
    if (eventCount >= SURGE_THRESHOLD) {
      // Check if suppression is already active
      const existingSuppression = this.db
        .prepare(
          `SELECT expires_at FROM dispatch_surge_suppressions
           WHERE repo = ? AND issue_number = ? AND expires_at > ?`,
        )
        .get(repo, issueNumber, nowIso);

      if (!existingSuppression) {
        // Create new suppression (2-hour duration)
        const expiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
        this.db
          .prepare(
            `INSERT INTO dispatch_surge_suppressions
             (repo, issue_number, suppressed_at, expires_at, event_count)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(repo, issueNumber, nowIso, expiresAt, eventCount);

        return { suppressed: true, expiresAt };
      }
    }

    return { suppressed: false };
  }

  /**
   * Check whether any dispatch surge event was recorded for (repo, issueNumber)
   * within the last `windowMs` milliseconds.
   *
   * Used as a cross-agent inflight guard (issue #1168): if a recent
   * "already-in-review" event exists for this issue (even just one, below the
   * 5-event suppression threshold), the caller can skip dispatch rather than
   * waste a slot on a near-certain already-in-review result.
   *
   * @param repo         Repository slug, e.g. "rapartlu/agent-orchestrator"
   * @param issueNumber  GitHub issue number
   * @param windowMs     Look-back window in milliseconds (default: 60 min)
   * @returns            true if at least one surge event exists within the window
   */
  hasRecentSurgeEvent(repo: string, issueNumber: number, windowMs = 3_600_000): boolean {
    this.runDispatchSurgeSuppressionMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT 1 FROM dispatch_surge_events
         WHERE repo = ? AND issue_number = ? AND event_at >= ?
         LIMIT 1`,
      )
      .get(repo, issueNumber, cutoff);
    return row !== undefined;
  }

  /**
   * Return the ISO timestamp of the most recent dispatch surge event for
   * `(repo, issueNumber)` within `windowMs`, or `null` if no event exists.
   *
   * Used by the cross-agent inflight guard to compute the precise flood-gate
   * expiry time so the dashboard can show "dispatch-suppressed (PR in review)
   * until HH:MM" (issue #1158 AC #3).
   *
   * @param repo          Repository slug, e.g. "rapartlu/agent-orchestrator"
   * @param issueNumber   GitHub issue number
   * @param windowMs      Rolling window duration in milliseconds (default 60 min)
   */
  getMostRecentSurgeEventAt(
    repo: string,
    issueNumber: number,
    windowMs = 3_600_000,
  ): string | null {
    this.runDispatchSurgeSuppressionMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db
      .prepare(
        `SELECT event_at FROM dispatch_surge_events
         WHERE repo = ? AND issue_number = ? AND event_at >= ?
         ORDER BY event_at DESC
         LIMIT 1`,
      )
      .get(repo, issueNumber, cutoff) as { event_at: string } | undefined;
    return row?.event_at ?? null;
  }

  /**
   * Check if dispatch surge suppression is active for an issue.
   *
   * @param repo            Repository slug, e.g. "rapartlu/agent-orchestrator"
   * @param issueNumber     GitHub issue number
   * @returns               `{ active: true, expiresAt: <ISO> }` if suppression active,
   *                        `{ active: false }` otherwise
   */
  getDispatchSurgeStatus(repo: string, issueNumber: number): { active: boolean; expiresAt?: string } {
    this.runDispatchSurgeSuppressionMigration();
    const nowIso = new Date().toISOString();

    // Clean up expired suppressions
    this.db
      .prepare(
        `DELETE FROM dispatch_surge_suppressions WHERE expires_at < ?`,
      )
      .run(nowIso);

    // Check if suppression is active
    const suppression = this.db
      .prepare(
        `SELECT expires_at FROM dispatch_surge_suppressions
         WHERE repo = ? AND issue_number = ? AND expires_at > ?`,
      )
      .get(repo, issueNumber, nowIso) as { expires_at: string } | undefined;

    if (suppression) {
      return { active: true, expiresAt: suppression.expires_at };
    }

    return { active: false };
  }

  /**
   * Get all active dispatch surge suppressions for status/dashboard visibility.
   *
   * @returns Array of active suppressions with repo, issue, and expiry info
   */
  getActiveDispatchSuppressions(): Array<{
    repo: string;
    issue_number: number;
    suppressed_at: string;
    expires_at: string;
    event_count: number;
    minutes_remaining: number;
  }> {
    this.runDispatchSurgeSuppressionMigration();
    const nowIso = new Date().toISOString();
    const now = Date.now();

    // Clean up expired suppressions
    this.db
      .prepare(
        `DELETE FROM dispatch_surge_suppressions WHERE expires_at < ?`,
      )
      .run(nowIso);

    // Get active suppressions
    const suppressions = this.db
      .prepare(
        `SELECT repo, issue_number, suppressed_at, expires_at, event_count
         FROM dispatch_surge_suppressions
         WHERE expires_at > ?
         ORDER BY expires_at ASC`,
      )
      .all(nowIso) as Array<{
        repo: string;
        issue_number: number;
        suppressed_at: string;
        expires_at: string;
        event_count: number;
      }>;

    return suppressions.map((s) => ({
      ...s,
      minutes_remaining: Math.ceil((new Date(s.expires_at).getTime() - now) / (60 * 1000)),
    }));
  }

  /**
   * Return per-day dispatch block rate metrics over a rolling window.
   *
   * Block rate = blocked / (blocked + actual_dispatches).
   * Actual dispatches are approximated from top-level task counts.
   *
   * @param days Rolling window in days (e.g. 7 or 30).
   */
  getDispatchBlockMetrics(days = 7): DispatchBlockMetrics {
    // Per-day blocked counts from dispatch_blocks table
    const blockRows = this.db
      .prepare(
        `SELECT
           date(timestamp)  AS date,
           COUNT(*)         AS blocked
         FROM dispatch_blocks
         WHERE date(timestamp) >= date('now', ? || ' days')
         GROUP BY date(timestamp)
         ORDER BY date(timestamp) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; blocked: number }>;

    // Per-day dispatched task counts (top-level tasks created in window)
    const dispatchRows = this.db
      .prepare(
        `SELECT
           date(created_at)  AS date,
           COUNT(*)          AS dispatched
         FROM tasks
         WHERE parent_task_id IS NULL
           AND date(created_at) >= date('now', ? || ' days')
         GROUP BY date(created_at)
         ORDER BY date(created_at) ASC`,
      )
      .all(`-${days}`) as Array<{ date: string; dispatched: number }>;

    const dispatchByDate = new Map<string, number>();
    for (const r of dispatchRows) {
      dispatchByDate.set(r.date, r.dispatched);
    }

    const daily: DispatchBlockDay[] = blockRows.map((r) => {
      const actual = dispatchByDate.get(r.date) ?? 0;
      const total = r.blocked + actual;
      return {
        date: r.date,
        blocked: r.blocked,
        total,
        block_rate_pct: total > 0 ? (r.blocked / total) * 100 : null,
      };
    });

    const totalBlocked = daily.reduce((s, d) => s + d.blocked, 0);
    const totalDispatches = daily.reduce((s, d) => s + d.total, 0);
    const rates = daily.map((d) => d.block_rate_pct).filter((v): v is number => v !== null);
    const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;

    // Linear trend via least-squares slope
    let trend: DispatchBlockMetrics["trend"] = "insufficient_data";
    if (rates.length >= 3) {
      const n = rates.length;
      const sumX = (n * (n - 1)) / 2;
      const sumX2 = rates.reduce((s, _, i) => s + i * i, 0);
      const sumY = rates.reduce((a, b) => a + b, 0);
      const sumXY = rates.reduce((s, v, i) => s + i * v, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (denom !== 0) {
        const slope = (n * sumXY - sumX * sumY) / denom;
        if (Math.abs(slope) < 0.5) {
          trend = "stable";
        } else if (slope > 0) {
          trend = "worsening";
        } else {
          trend = "improving";
        }
      }
    }

    return {
      days,
      daily,
      total_blocked: totalBlocked,
      total_dispatches: totalDispatches,
      avg_block_rate_pct: avgRate,
      trend,
    };
  }

  /**
   * Count dispatch blocks grouped by PR detection strategy over a rolling window.
   *
   * Each blocked dispatch records which strategy detected the blocking PR
   * (search_index, branch_name, or body_keyword — issue #1179). This breakdown
   * lets operators verify whether the body-keyword fallback (added in issue #1174)
   * fires in practice, and whether the search-index lag is a real operational
   * problem or merely theoretical.
   *
   * @param days Rolling window in days (default: 7)
   */
  getPRDetectionStrategyBreakdown(days = 7): PRDetectionStrategyBreakdown {
    this.runDispatchBlocksMigration();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           COALESCE(detection_strategy, 'unknown') AS strategy,
           COUNT(*) AS cnt
         FROM dispatch_blocks
         WHERE timestamp >= ?
         GROUP BY COALESCE(detection_strategy, 'unknown')`,
      )
      .all(cutoff) as Array<{ strategy: string; cnt: number }>;

    let searchIndex = 0;
    let branchName = 0;
    let bodyKeyword = 0;
    let unknown = 0;

    for (const row of rows) {
      if (row.strategy === "search_index") searchIndex = row.cnt;
      else if (row.strategy === "branch_name") branchName = row.cnt;
      else if (row.strategy === "body_keyword") bodyKeyword = row.cnt;
      else unknown += row.cnt;
    }

    return {
      days,
      search_index: searchIndex,
      branch_name: branchName,
      body_keyword: bodyKeyword,
      unknown,
      total: searchIndex + branchName + bodyKeyword + unknown,
    };
  }

  // ── Proactive Rebase Log ──────────────────────────────────────────────────

  private runProactiveRebaseLogMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_rebase_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        repo           TEXT    NOT NULL,
        branch         TEXT    NOT NULL,
        source_ref     TEXT,
        commits_behind INTEGER NOT NULL,
        outcome        TEXT    NOT NULL,
        detail         TEXT    NOT NULL,
        timestamp      TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_proactive_rebase_log_repo      ON proactive_rebase_log(repo);
      CREATE INDEX IF NOT EXISTS idx_proactive_rebase_log_branch    ON proactive_rebase_log(branch);
      CREATE INDEX IF NOT EXISTS idx_proactive_rebase_log_outcome   ON proactive_rebase_log(outcome);
      CREATE INDEX IF NOT EXISTS idx_proactive_rebase_log_timestamp ON proactive_rebase_log(timestamp);
    `);
  }

  /**
   * Record a single proactive-rebase attempt.
   *
   * @param params.repo          GitHub repo slug (e.g. "owner/repo")
   * @param params.branch        Branch name
   * @param params.sourceRef     Source issue ref if triggered pre-dispatch (nullable)
   * @param params.commitsBehind How far behind origin/main the branch was
   * @param params.outcome       "rebased" | "conflict" | "skipped" | "error"
   * @param params.detail        Human-readable description
   */
  recordProactiveRebase(params: {
    repo: string;
    branch: string;
    sourceRef: string | null;
    commitsBehind: number;
    outcome: string;
    detail: string;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO proactive_rebase_log
        (repo, branch, source_ref, commits_behind, outcome, detail, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.repo,
      params.branch,
      params.sourceRef ?? null,
      params.commitsBehind,
      params.outcome,
      params.detail,
      now,
    );
  }

  /**
   * Return the most recent proactive-rebase log entries, newest-first.
   *
   * @param limit  Maximum number of rows to return (default 50).
   */
  getRecentProactiveRebases(limit = 50): Array<{
    id: number;
    repo: string;
    branch: string;
    source_ref: string | null;
    commits_behind: number;
    outcome: string;
    detail: string;
    timestamp: string;
  }> {
    return this.db
      .prepare("SELECT * FROM proactive_rebase_log ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Array<{
        id: number;
        repo: string;
        branch: string;
        source_ref: string | null;
        commits_behind: number;
        outcome: string;
        detail: string;
        timestamp: string;
      }>;
  }

  // ── Semantic Task Memory (issue #1011) ────────────────────────────────────

  /**
   * Create the FTS5 virtual table for semantic task memory.
   *
   * Uses a content-less (external content) FTS5 table that stores copies of
   * the indexed text fields.  Tasks are indexed when they reach
   * verification_status="approved" with a quality_score above threshold.
   *
   * The table is populated lazily by `indexApprovedTasksIntoMemory()`, which
   * is called once during migration and again whenever new tasks are verified.
   */
  private runSemanticMemoryMigration(): void {
    // FTS5 virtual table — stores indexed text for full-text search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memory USING fts5(
        task_id UNINDEXED,
        title,
        description,
        result_excerpt,
        verification_notes,
        agent_name UNINDEXED,
        source_ref UNINDEXED,
        quality_score UNINDEXED,
        task_type UNINDEXED,
        tokenize='porter unicode61'
      );
    `);

    // Tracking table: records which tasks have been indexed and when,
    // so we can incrementally index only new approved tasks.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_indexed (
        task_id TEXT PRIMARY KEY,
        indexed_at TEXT NOT NULL
      );
    `);

    // Settings table: persists auto-tuned configuration overrides (issue #1029).
    // Keyed by setting name; value is a JSON-encoded scalar.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Query log: records each FTS5 lookup for query quality analysis (issue #1029).
    // Tracks term count and match count so we can surface patterns that
    // consistently return zero results.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_memory_query_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        logged_at   TEXT    NOT NULL,
        task_id     TEXT,
        agent_name  TEXT,
        fts5_query  TEXT    NOT NULL,
        term_count  INTEGER NOT NULL,
        match_count INTEGER NOT NULL
      );
    `);

    // Backfill: index any approved tasks not yet in the FTS5 table.
    this.indexApprovedTasksIntoMemory();
  }

  /**
   * Scan for approved tasks with quality_score >= threshold that haven't yet
   * been indexed into semantic_memory, and insert them.
   *
   * Called once at startup (via migration) and may be called periodically
   * to pick up newly verified tasks.
   *
   * @param minScore  Minimum quality score to index (default 0.80).
   * @param excerptChars  Max chars to store from result field (default 400).
   */
  indexApprovedTasksIntoMemory(minScore = 0.80, excerptChars = 400): number {
    // Check that required columns exist (defensive: old DBs may lack them)
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colNames = new Set(columns.map((c) => c.name));
    if (!colNames.has("verification_status") || !colNames.has("quality_score")) {
      return 0;
    }

    const hasTaskType = colNames.has("task_type");
    const taskTypeCol = hasTaskType ? "task_type" : "'implementation' AS task_type";

    // Find approved tasks not yet indexed
    const rows = this.db.prepare(`
      SELECT t.id, t.title, t.description, t.result, t.verification_notes,
             t.agent_name, t.source_ref, t.quality_score, ${taskTypeCol}
      FROM tasks t
      LEFT JOIN semantic_memory_indexed smi ON smi.task_id = t.id
      WHERE t.verification_status = 'approved'
        AND t.quality_score >= ?
        AND t.result IS NOT NULL
        AND length(t.result) > 50
        AND smi.task_id IS NULL
      ORDER BY t.updated_at DESC
      LIMIT 500
    `).all(minScore) as Array<{
      id: string;
      title: string;
      description: string | null;
      result: string | null;
      verification_notes: string | null;
      agent_name: string | null;
      source_ref: string | null;
      quality_score: number;
      task_type: string;
    }>;

    if (rows.length === 0) return 0;

    const now = new Date().toISOString();

    const insertFts = this.db.prepare(`
      INSERT INTO semantic_memory
        (task_id, title, description, result_excerpt, verification_notes,
         agent_name, source_ref, quality_score, task_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertTracking = this.db.prepare(`
      INSERT OR IGNORE INTO semantic_memory_indexed (task_id, indexed_at) VALUES (?, ?)
    `);

    const txn = this.db.transaction(() => {
      for (const row of rows) {
        const excerpt = row.result
          ? row.result.slice(0, excerptChars)
          : null;

        insertFts.run(
          row.id,
          row.title,
          row.description ?? "",
          excerpt ?? "",
          row.verification_notes ?? "",
          row.agent_name ?? "",
          row.source_ref ?? "",
          row.quality_score,
          row.task_type,
        );
        insertTracking.run(row.id, now);
      }
    });

    txn();
    return rows.length;
  }

  /**
   * Query semantic memory for tasks most similar to the given text.
   *
   * Uses FTS5 BM25 ranking to find past approved tasks whose title,
   * description, result, or reviewer notes match keywords from the query.
   *
   * @param queryText     The dispatch message or task title to match against.
   * @param topK          Number of results to return (default 3).
   * @param excludeTaskId Task ID to exclude from results (the current task).
   * @returns Array of matching tasks, sorted by relevance (most similar first).
   */
  querySemanticMemory(
    queryText: string,
    topK = 3,
    excludeTaskId?: string,
    context?: { taskId?: string; agentName?: string },
  ): Array<{
    taskId: string;
    title: string;
    sourceRef: string | null;
    qualityScore: number;
    reviewerNotes: string | null;
    resultExcerpt: string | null;
  }> {
    // Build FTS5 query: extract significant keywords from the input text.
    // FTS5 uses implicit AND for space-separated terms, so we extract
    // meaningful words (>3 chars, not stopwords) and join with OR for
    // broader matching.
    const ftsQuery = buildFts5Query(queryText);
    if (!ftsQuery) {
      // Log zero-match query for quality analysis even when no terms extracted
      this.logSemanticMemoryQuery("", 0, 0, context);
      return [];
    }

    const termCount = (ftsQuery.match(/ OR /g)?.length ?? 0) + 1;

    try {
      const rows = this.db.prepare(`
        SELECT
          task_id,
          title,
          source_ref,
          CAST(quality_score AS REAL) AS quality_score,
          verification_notes,
          result_excerpt,
          rank
        FROM semantic_memory
        WHERE semantic_memory MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(ftsQuery, topK + (excludeTaskId ? 1 : 0)) as Array<{
        task_id: string;
        title: string;
        source_ref: string;
        quality_score: number;
        verification_notes: string;
        result_excerpt: string;
        rank: number;
      }>;

      const results = rows
        .filter((r) => r.task_id !== excludeTaskId)
        .slice(0, topK)
        .map((r) => ({
          taskId: r.task_id,
          title: r.title,
          sourceRef: r.source_ref || null,
          qualityScore: r.quality_score,
          reviewerNotes: r.verification_notes || null,
          resultExcerpt: r.result_excerpt || null,
        }));

      // Log query for quality analysis (issue #1029)
      this.logSemanticMemoryQuery(ftsQuery, termCount, results.length, context);

      return results;
    } catch {
      // FTS5 query syntax errors are non-fatal — return empty matches.
      this.logSemanticMemoryQuery(ftsQuery, termCount, 0, context);
      return [];
    }
  }

  /**
   * Return the count of tasks currently indexed in semantic memory.
   */
  getSemanticMemorySize(): number {
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM semantic_memory_indexed",
      ).get() as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  }

  // ── Semantic Memory Effectiveness (issue #1016) ─────────────────────────────

  /**
   * Classify dispatched tasks into "memory-assisted" vs "no-match" based on
   * [semantic-memory] log entries, then compare first-pass verification rates.
   *
   * A task is "memory-assisted" if it has at least one task_log entry whose
   * content starts with "[semantic-memory]".
   *
   * @param sinceISO  Only consider tasks created on or after this timestamp.
   * @returns Effectiveness metrics for matched vs unmatched tasks.
   */
  getSemanticMemoryEffectiveness(sinceISO?: string): SemanticMemoryEffectivenessResult {
    const cutoff = sinceISO ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Get all terminal tasks in the window (done, failed, escalated)
    // that went through verification.
    const tasks = this.db.prepare(`
      SELECT
        t.id,
        t.status,
        t.quality_score,
        t.verification_status,
        COALESCE(t.revision_count, 0) AS revision_count,
        t.created_at,
        EXISTS (
          SELECT 1 FROM task_logs tl
          WHERE tl.task_id = t.id
            AND tl.direction = 'system'
            AND tl.content LIKE '[semantic-memory]%'
        ) AS has_memory_match
      FROM tasks t
      WHERE t.created_at >= ?
        AND t.status IN ('done', 'failed', 'escalated')
      ORDER BY t.created_at ASC
    `).all(cutoff) as Array<{
      id: string;
      status: string;
      quality_score: number | null;
      verification_status: string | null;
      revision_count: number;
      created_at: string;
      has_memory_match: number;
    }>;

    // Separate into matched and unmatched cohorts
    const matched: typeof tasks = [];
    const unmatched: typeof tasks = [];
    for (const t of tasks) {
      if (t.has_memory_match) matched.push(t);
      else unmatched.push(t);
    }

    const computeCohort = (cohort: typeof tasks): SemanticMemoryCohortStats => {
      const total = cohort.length;
      if (total === 0) {
        return {
          total_tasks: 0,
          first_pass_approved: 0,
          first_pass_rate: null,
          avg_quality_score: null,
          avg_revision_count: null,
          revision_distribution: { zero: 0, one: 0, two_plus: 0 },
        };
      }

      const verified = cohort.filter((t) => t.verification_status !== null);
      const firstPassApproved = cohort.filter(
        (t) => t.verification_status === "approved" && t.revision_count === 0,
      ).length;

      const withScore = cohort.filter((t) => t.quality_score !== null);
      const avgScore = withScore.length > 0
        ? withScore.reduce((s, t) => s + (t.quality_score ?? 0), 0) / withScore.length
        : null;

      const avgRevisions = total > 0
        ? cohort.reduce((s, t) => s + t.revision_count, 0) / total
        : null;

      const revDist = {
        zero: cohort.filter((t) => t.revision_count === 0).length,
        one: cohort.filter((t) => t.revision_count === 1).length,
        two_plus: cohort.filter((t) => t.revision_count >= 2).length,
      };

      return {
        total_tasks: total,
        first_pass_approved: firstPassApproved,
        first_pass_rate: verified.length > 0 ? firstPassApproved / verified.length : null,
        avg_quality_score: avgScore,
        avg_revision_count: avgRevisions,
        revision_distribution: revDist,
      };
    };

    const matchedStats = computeCohort(matched);
    const unmatchedStats = computeCohort(unmatched);

    // Compute improvement delta
    const improvement =
      matchedStats.first_pass_rate !== null && unmatchedStats.first_pass_rate !== null
        ? matchedStats.first_pass_rate - unmatchedStats.first_pass_rate
        : null;

    // Build weekly cohorts for trending
    const weeklyMap = new Map<string, { matched: typeof tasks; unmatched: typeof tasks }>();
    for (const t of tasks) {
      const d = new Date(t.created_at);
      // ISO week start (Monday)
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const weekStart = new Date(d.setDate(diff));
      const weekKey = weekStart.toISOString().slice(0, 10);
      if (!weeklyMap.has(weekKey)) {
        weeklyMap.set(weekKey, { matched: [], unmatched: [] });
      }
      const bucket = weeklyMap.get(weekKey)!;
      if (t.has_memory_match) bucket.matched.push(t);
      else bucket.unmatched.push(t);
    }

    const weekly: SemanticMemoryWeeklyCohort[] = [];
    for (const [weekStart, { matched: wm, unmatched: wu }] of weeklyMap) {
      weekly.push({
        week_start: weekStart,
        matched: computeCohort(wm),
        unmatched: computeCohort(wu),
      });
    }
    weekly.sort((a, b) => a.week_start.localeCompare(b.week_start));

    // Total dispatch count and memory hit rate
    const totalDispatches = this.db.prepare(`
      SELECT COUNT(DISTINCT t.id) AS cnt
      FROM tasks t
      WHERE t.created_at >= ?
        AND t.status NOT IN ('pending', 'planning')
    `).get(cutoff) as { cnt: number } | undefined;

    const totalWithMemory = this.db.prepare(`
      SELECT COUNT(DISTINCT tl.task_id) AS cnt
      FROM task_logs tl
      JOIN tasks t ON t.id = tl.task_id
      WHERE t.created_at >= ?
        AND tl.direction = 'system'
        AND tl.content LIKE '[semantic-memory]%'
    `).get(cutoff) as { cnt: number } | undefined;

    const dispatchCount = totalDispatches?.cnt ?? 0;
    const memoryHitCount = totalWithMemory?.cnt ?? 0;
    const hitRate = dispatchCount > 0 ? memoryHitCount / dispatchCount : null;

    return {
      window_start: cutoff,
      generated_at: new Date().toISOString(),
      total_dispatches: dispatchCount,
      memory_hit_count: memoryHitCount,
      memory_hit_rate: hitRate,
      matched: matchedStats,
      unmatched: unmatchedStats,
      improvement_delta: improvement,
      meets_target: improvement !== null ? improvement >= 0.15 : null,
      weekly,
    };
  }

  // ── Semantic Memory Auto-tuning (issue #1029) ────────────────────────────────

  /**
   * Retrieve the persisted auto-tuned min_quality_score, or null if no
   * tuning has been applied yet (caller should fall back to config value).
   */
  getTunedMinQualityScore(): number | null {
    try {
      const row = this.db.prepare(
        "SELECT value FROM semantic_memory_settings WHERE key = 'min_quality_score'",
      ).get() as { value: string } | undefined;
      if (!row) return null;
      const v = parseFloat(row.value);
      return isNaN(v) ? null : v;
    } catch {
      return null;
    }
  }

  /**
   * Persist an auto-tuned min_quality_score override.
   * Pass null to clear the override and revert to the config default.
   */
  setTunedMinQualityScore(score: number | null): void {
    if (score === null) {
      this.db.prepare(
        "DELETE FROM semantic_memory_settings WHERE key = 'min_quality_score'",
      ).run();
      return;
    }
    const clamped = Math.min(0.95, Math.max(0.60, score));
    this.db.prepare(`
      INSERT INTO semantic_memory_settings (key, value, updated_at)
      VALUES ('min_quality_score', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(String(clamped), new Date().toISOString());
  }

  /**
   * Compute an auto-tune recommendation for min_quality_score.
   *
   * Decision rules (applied in priority order):
   *  1. Insufficient data (<20 dispatches total) → keep.
   *  2. Hit rate < 20%  → lower by 0.05 (floor 0.60) — too few matches, increase coverage.
   *  3. Hit rate ≥ 30% AND improvement_delta < 0 → raise by 0.05 (ceil 0.95) — matches are hurting.
   *  4. Hit rate ≥ 50% AND 0 ≤ improvement_delta < 0.10 → raise by 0.03 — marginal benefit, increase selectivity.
   *  5. Otherwise → keep current threshold.
   */
  computeAutoTuneRecommendation(currentThreshold: number): SemanticMemoryAutoTuneResult {
    const eff = this.getSemanticMemoryEffectiveness();
    const hitRate = eff.memory_hit_rate;
    const delta = eff.improvement_delta;
    const totalDispatches = eff.total_dispatches;

    const basis = {
      hit_rate: hitRate,
      improvement_delta: delta,
      matched_tasks: eff.matched.total_tasks,
      unmatched_tasks: eff.unmatched.total_tasks,
    };

    // Rule 1: insufficient data
    if (totalDispatches < 20) {
      return {
        current_threshold: currentThreshold,
        recommended_threshold: currentThreshold,
        action: "keep",
        reason: `Insufficient data (${totalDispatches} dispatches; need ≥20 for reliable signal).`,
        basis,
      };
    }

    // Rule 2: hit rate too low → lower threshold to increase coverage
    if (hitRate !== null && hitRate < 0.20) {
      const recommended = Math.max(0.60, Math.round((currentThreshold - 0.05) * 100) / 100);
      const action = recommended < currentThreshold ? "lower" : "keep";
      return {
        current_threshold: currentThreshold,
        recommended_threshold: recommended,
        action,
        reason: `Hit rate ${(hitRate * 100).toFixed(1)}% is below 20% threshold. ` +
          `Lowering min_quality_score from ${currentThreshold} to ${recommended} to index more tasks.`,
        basis,
      };
    }

    // Rule 3: matches are actively hurting quality → raise threshold
    if (hitRate !== null && hitRate >= 0.30 && delta !== null && delta < 0) {
      const recommended = Math.min(0.95, Math.round((currentThreshold + 0.05) * 100) / 100);
      const action = recommended > currentThreshold ? "raise" : "keep";
      return {
        current_threshold: currentThreshold,
        recommended_threshold: recommended,
        action,
        reason: `Improvement delta is ${(delta * 100).toFixed(1)}% (negative: memory matches reduce quality). ` +
          `Raising min_quality_score from ${currentThreshold} to ${recommended} for higher selectivity.`,
        basis,
      };
    }

    // Rule 4: high hit rate but marginal benefit → raise slightly for precision
    if (hitRate !== null && hitRate >= 0.50 && delta !== null && delta >= 0 && delta < 0.10) {
      const recommended = Math.min(0.95, Math.round((currentThreshold + 0.03) * 100) / 100);
      const action = recommended > currentThreshold ? "raise" : "keep";
      return {
        current_threshold: currentThreshold,
        recommended_threshold: recommended,
        action,
        reason: `Hit rate ${(hitRate * 100).toFixed(1)}% is high but improvement delta is only ` +
          `${(delta * 100).toFixed(1)}%. Raising min_quality_score from ${currentThreshold} ` +
          `to ${recommended} to improve match precision.`,
        basis,
      };
    }

    return {
      current_threshold: currentThreshold,
      recommended_threshold: currentThreshold,
      action: "keep",
      reason: `Current threshold ${currentThreshold} is performing well ` +
        `(hit rate ${hitRate !== null ? `${(hitRate * 100).toFixed(1)}%` : "N/A"}, ` +
        `delta ${delta !== null ? `${(delta * 100).toFixed(1)}%` : "N/A"}).`,
      basis,
    };
  }

  /**
   * Apply the auto-tune recommendation if the threshold would change.
   * Persists the new threshold and re-indexes with the updated score.
   *
   * @param currentThreshold  The threshold currently in use (from config or last tune).
   * @returns The auto-tune result (caller can log the action taken).
   */
  applyAutoTuneIfBeneficial(currentThreshold: number): SemanticMemoryAutoTuneResult {
    const rec = this.computeAutoTuneRecommendation(currentThreshold);
    if (rec.action !== "keep" && rec.recommended_threshold !== rec.current_threshold) {
      this.setTunedMinQualityScore(rec.recommended_threshold);
      // Re-index with the new threshold to bring the FTS5 table in sync
      this.indexApprovedTasksIntoMemory(rec.recommended_threshold);
    }
    return rec;
  }

  // ── FTS5 Query Quality Analysis (issue #1029) ────────────────────────────────

  /**
   * Log a single FTS5 query execution for quality analysis.
   * Called internally by querySemanticMemory() after each lookup.
   */
  private logSemanticMemoryQuery(
    fts5Query: string,
    termCount: number,
    matchCount: number,
    context?: { taskId?: string; agentName?: string },
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO semantic_memory_query_log
          (logged_at, task_id, agent_name, fts5_query, term_count, match_count)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        new Date().toISOString(),
        context?.taskId ?? null,
        context?.agentName ?? null,
        fts5Query,
        termCount,
        matchCount,
      );
    } catch {
      // Non-fatal: logging failures must never break dispatch
    }
  }

  /**
   * Aggregate FTS5 query quality statistics over a rolling window.
   *
   * Surfaces zero-match patterns so operators can identify noisy dispatch
   * messages that consistently fail to find relevant past experience.
   */
  getSemanticMemoryQueryStats(sinceISO?: string): SemanticMemoryQueryStats {
    const cutoff = sinceISO ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const totRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN match_count = 0 THEN 1 ELSE 0 END) AS zero_matches,
        AVG(CAST(match_count AS REAL)) AS avg_matches
      FROM semantic_memory_query_log
      WHERE logged_at >= ?
    `).get(cutoff) as { total: number; zero_matches: number; avg_matches: number | null } | undefined;

    const total = totRow?.total ?? 0;
    const zeroMatches = totRow?.zero_matches ?? 0;
    const avgMatches = totRow?.avg_matches ?? null;

    // Top zero-match query patterns (by frequency)
    const emptyRows = this.db.prepare(`
      SELECT fts5_query, COUNT(*) AS cnt
      FROM semantic_memory_query_log
      WHERE logged_at >= ?
        AND match_count = 0
        AND fts5_query != ''
      GROUP BY fts5_query
      ORDER BY cnt DESC
      LIMIT 10
    `).all(cutoff) as Array<{ fts5_query: string; cnt: number }>;

    return {
      window_start: cutoff,
      generated_at: new Date().toISOString(),
      total_queries: total,
      zero_match_queries: zeroMatches,
      zero_match_rate: total > 0 ? zeroMatches / total : null,
      avg_matches_returned: avgMatches,
      top_empty_patterns: emptyRows.map((r) => ({
        query_sample: r.fts5_query.slice(0, 120),
        count: r.cnt,
      })),
    };
  }

  // ── Per-Agent Effectiveness (issue #1029) ─────────────────────────────────────

  /**
   * Break down semantic memory effectiveness by agent.
   *
   * For each agent that dispatched tasks in the window, compute matched vs
   * unmatched cohort stats and a threshold adjustment recommendation.
   * Only agents with ≥5 total tasks are included (too few tasks → noisy signal).
   */
  getPerAgentSemanticMemoryEffectiveness(sinceISO?: string): PerAgentSemanticMemoryStats[] {
    const cutoff = sinceISO ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const tasks = this.db.prepare(`
      SELECT
        t.id,
        t.agent_name,
        t.status,
        t.quality_score,
        t.verification_status,
        COALESCE(t.revision_count, 0) AS revision_count,
        EXISTS (
          SELECT 1 FROM task_logs tl
          WHERE tl.task_id = t.id
            AND tl.direction = 'system'
            AND tl.content LIKE '[semantic-memory]%'
        ) AS has_memory_match
      FROM tasks t
      WHERE t.created_at >= ?
        AND t.status IN ('done', 'failed', 'escalated')
        AND t.agent_name IS NOT NULL
      ORDER BY t.created_at ASC
    `).all(cutoff) as Array<{
      id: string;
      agent_name: string;
      status: string;
      quality_score: number | null;
      verification_status: string | null;
      revision_count: number;
      has_memory_match: number;
    }>;

    // Group by agent
    const byAgent = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (!byAgent.has(t.agent_name)) byAgent.set(t.agent_name, []);
      byAgent.get(t.agent_name)!.push(t);
    }

    const computeCohort = (cohort: typeof tasks): SemanticMemoryCohortStats => {
      const total = cohort.length;
      if (total === 0) {
        return {
          total_tasks: 0,
          first_pass_approved: 0,
          first_pass_rate: null,
          avg_quality_score: null,
          avg_revision_count: null,
          revision_distribution: { zero: 0, one: 0, two_plus: 0 },
        };
      }
      const verified = cohort.filter((t) => t.verification_status !== null);
      const firstPassApproved = cohort.filter(
        (t) => t.verification_status === "approved" && t.revision_count === 0,
      ).length;
      const withScore = cohort.filter((t) => t.quality_score !== null);
      const avgScore = withScore.length > 0
        ? withScore.reduce((s, t) => s + (t.quality_score ?? 0), 0) / withScore.length
        : null;
      const avgRevisions = total > 0
        ? cohort.reduce((s, t) => s + t.revision_count, 0) / total
        : null;
      return {
        total_tasks: total,
        first_pass_approved: firstPassApproved,
        first_pass_rate: verified.length > 0 ? firstPassApproved / verified.length : null,
        avg_quality_score: avgScore,
        avg_revision_count: avgRevisions,
        revision_distribution: {
          zero: cohort.filter((t) => t.revision_count === 0).length,
          one: cohort.filter((t) => t.revision_count === 1).length,
          two_plus: cohort.filter((t) => t.revision_count >= 2).length,
        },
      };
    };

    const results: PerAgentSemanticMemoryStats[] = [];

    for (const [agentName, agentTasks] of byAgent) {
      if (agentTasks.length < 5) continue; // Too few tasks for reliable signal

      const matched = agentTasks.filter((t) => t.has_memory_match);
      const unmatched = agentTasks.filter((t) => !t.has_memory_match);

      const matchedStats = computeCohort(matched);
      const unmatchedStats = computeCohort(unmatched);
      const hitRate = agentTasks.length > 0 ? matched.length / agentTasks.length : null;
      const delta = matchedStats.first_pass_rate !== null && unmatchedStats.first_pass_rate !== null
        ? matchedStats.first_pass_rate - unmatchedStats.first_pass_rate
        : null;

      // Derive a per-agent recommendation using the same rules as global auto-tune
      let recommendation: PerAgentSemanticMemoryStats["recommended_threshold_adjustment"];
      if (agentTasks.length < 20) {
        recommendation = "insufficient_data";
      } else if (hitRate !== null && hitRate < 0.20) {
        recommendation = "lower";
      } else if (hitRate !== null && hitRate >= 0.30 && delta !== null && delta < 0) {
        recommendation = "raise";
      } else if (hitRate !== null && hitRate >= 0.50 && delta !== null && delta >= 0 && delta < 0.10) {
        recommendation = "raise";
      } else {
        recommendation = "keep";
      }

      results.push({
        agent_name: agentName,
        total_dispatches: agentTasks.length,
        memory_hit_count: matched.length,
        memory_hit_rate: hitRate,
        matched: matchedStats,
        unmatched: unmatchedStats,
        improvement_delta: delta,
        recommended_threshold_adjustment: recommendation,
      });
    }

    // Sort by total_dispatches descending (most active agents first)
    return results.sort((a, b) => b.total_dispatches - a.total_dispatches);
  }

  // ── Operator Controls ─────────────────────────────────────────────────────

  runOperatorControlsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operator_controls (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        control_type TEXT NOT NULL,
        value TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        applied_at TEXT,
        failure_reason TEXT,
        operator TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operator_controls_task_id ON operator_controls(task_id);
      CREATE INDEX IF NOT EXISTS idx_operator_controls_status ON operator_controls(status, created_at);
    `);
  }

  addOperatorControl(input: OperatorControlInput): string {
    this.runOperatorControlsMigration();
    const id = generateId();
    this.db.prepare(`
      INSERT INTO operator_controls (id, task_id, control_type, value, status, operator, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      id,
      input.task_id,
      input.control_type,
      input.value ?? null,
      input.operator ?? null,
      new Date().toISOString(),
    );
    return id;
  }

  getPendingOperatorControls(): OperatorControl[] {
    this.runOperatorControlsMigration();
    return this.db.prepare(`
      SELECT * FROM operator_controls WHERE status = 'pending' ORDER BY created_at ASC
    `).all() as OperatorControl[];
  }

  getOperatorControls(limit = 20): OperatorControl[] {
    this.runOperatorControlsMigration();
    return this.db.prepare(`
      SELECT * FROM operator_controls ORDER BY created_at DESC LIMIT ?
    `).all(limit) as OperatorControl[];
  }

  markOperatorControlApplied(id: string): void {
    this.db.prepare(`
      UPDATE operator_controls SET status = 'applied', applied_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markOperatorControlFailed(id: string, reason: string): void {
    this.db.prepare(`
      UPDATE operator_controls SET status = 'failed', failure_reason = ? WHERE id = ?
    `).run(reason, id);
  }

  pauseTask(taskId: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ?
    `).run(new Date().toISOString(), taskId);
  }

  resumeTask(taskId: string): void {
    this.db.prepare(`
      UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'paused'
    `).run(new Date().toISOString(), taskId);
  }

  redirectTask(taskId: string, newAgent: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const newStatus = task.status === "in_progress" ? "pending" : task.status;
    this.db.prepare(`
      UPDATE tasks SET agent_name = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(newAgent, newStatus, new Date().toISOString(), taskId);
  }

  injectTaskDirective(taskId: string, directive: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const existing = task.description ?? "";
    const separator = existing ? "\n\n---\n[Operator Directive]\n" : "[Operator Directive]\n";
    const updated = existing + separator + directive;
    this.db.prepare(`
      UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?
    `).run(updated, new Date().toISOString(), taskId);
  }

  // ── DAG Execution (issue #1085) ───────────────────────────────────────────

  runDagMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dag_executions (
        id          TEXT PRIMARY KEY,
        parent_task_id TEXT NOT NULL REFERENCES tasks(id),
        plan_json   TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'running',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dag_executions_parent ON dag_executions(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_dag_executions_status ON dag_executions(status);

      CREATE TABLE IF NOT EXISTS dag_nodes (
        id              TEXT PRIMARY KEY,
        dag_id          TEXT NOT NULL REFERENCES dag_executions(id),
        step_id         TEXT NOT NULL,
        task_id         TEXT REFERENCES tasks(id),
        agent_name      TEXT,
        instruction     TEXT NOT NULL,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'pending',
        result          TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dag_nodes_dag_id ON dag_nodes(dag_id);
      CREATE INDEX IF NOT EXISTS idx_dag_nodes_task_id ON dag_nodes(task_id);
    `);
  }

  createDagExecution(params: {
    id: string;
    parent_task_id: string;
    plan_json: string;
    status: DagExecutionStatus;
  }): DagExecution {
    this.runDagMigration();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO dag_executions (id, parent_task_id, plan_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.id, params.parent_task_id, params.plan_json, params.status, now, now);
    return this.getDagExecution(params.id)!;
  }

  createDagNode(params: {
    id: string;
    dag_id: string;
    step_id: string;
    task_id: string | null;
    agent_name: string | null;
    instruction: string;
    depends_on_json: string;
    status: DagNodeStatus;
    result: string | null;
  }): DagNode {
    this.runDagMigration();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO dag_nodes
        (id, dag_id, step_id, task_id, agent_name, instruction, depends_on_json, status, result, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.id, params.dag_id, params.step_id, params.task_id, params.agent_name,
      params.instruction, params.depends_on_json, params.status, params.result, now, now,
    );
    return this.getDagNode(params.id)!;
  }

  getDagExecution(id: string): DagExecution | undefined {
    this.runDagMigration();
    return this.db.prepare("SELECT * FROM dag_executions WHERE id = ?").get(id) as DagExecution | undefined;
  }

  getDagExecutionByParentTask(parentTaskId: string): DagExecution | undefined {
    this.runDagMigration();
    return this.db.prepare(
      "SELECT * FROM dag_executions WHERE parent_task_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parentTaskId) as DagExecution | undefined;
  }

  getPendingDagExecutions(): DagExecution[] {
    this.runDagMigration();
    return this.db.prepare(
      "SELECT * FROM dag_executions WHERE status = 'running' ORDER BY created_at ASC",
    ).all() as DagExecution[];
  }

  getDagNodes(dagId: string): DagNode[] {
    this.runDagMigration();
    return this.db.prepare(
      "SELECT * FROM dag_nodes WHERE dag_id = ? ORDER BY created_at ASC",
    ).all(dagId) as DagNode[];
  }

  getDagNode(id: string): DagNode | undefined {
    this.runDagMigration();
    return this.db.prepare("SELECT * FROM dag_nodes WHERE id = ?").get(id) as DagNode | undefined;
  }

  updateDagNode(id: string, updates: Partial<Pick<DagNode, "status" | "task_id" | "agent_name" | "result">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.task_id !== undefined) { fields.push("task_id = ?"); values.push(updates.task_id); }
    if (updates.agent_name !== undefined) { fields.push("agent_name = ?"); values.push(updates.agent_name); }
    if (updates.result !== undefined) { fields.push("result = ?"); values.push(updates.result); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE dag_nodes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  updateDagExecution(id: string, updates: Partial<Pick<DagExecution, "status">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    this.db.prepare(`UPDATE dag_executions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  /** Return all DAG executions (for CLI display). */
  listDagExecutions(limit = 20): Array<DagExecution & { node_count: number; done_count: number }> {
    this.runDagMigration();
    return this.db.prepare(`
      SELECT e.*,
        COUNT(n.id) AS node_count,
        SUM(CASE WHEN n.status = 'done' THEN 1 ELSE 0 END) AS done_count
      FROM dag_executions e
      LEFT JOIN dag_nodes n ON n.dag_id = e.id
      GROUP BY e.id
      ORDER BY e.created_at DESC
      LIMIT ?
    `).all(limit) as Array<DagExecution & { node_count: number; done_count: number }>;
  }

  // ── Failure Interception (issue #1086) ────────────────────────────────────────

  /**
   * Create the failure_interceptions table for pre-dispatch similarity tracking.
   * Called once at startup via the constructor migration chain.
   */
  runFailureInterceptionMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS failure_interceptions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        similar_task_ids TEXT NOT NULL,
        similarity_score REAL NOT NULL,
        lessons_injected INTEGER NOT NULL DEFAULT 0,
        model_upgraded INTEGER NOT NULL DEFAULT 0,
        final_outcome TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_failure_interceptions_task_id ON failure_interceptions(task_id);
      CREATE INDEX IF NOT EXISTS idx_failure_interceptions_created_at ON failure_interceptions(created_at);
    `);
  }

  /** Record a new failure interception event. */
  recordFailureInterception(entry: Omit<FailureInterceptionEntry, "id" | "created_at">): void {
    this.runFailureInterceptionMigration();
    const id = generateId();
    this.db.prepare(`
      INSERT INTO failure_interceptions
        (id, task_id, similar_task_ids, similarity_score, lessons_injected, model_upgraded, final_outcome, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      entry.task_id,
      entry.similar_task_ids,
      entry.similarity_score,
      entry.lessons_injected,
      entry.model_upgraded,
      entry.final_outcome ?? null,
      new Date().toISOString(),
    );
  }

  /** Fetch recent failure interceptions, newest first. */
  getFailureInterceptions(limit = 50, daysBack = 7): FailureInterceptionEntry[] {
    this.runFailureInterceptionMigration();
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT * FROM failure_interceptions
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(cutoff, limit) as FailureInterceptionEntry[];
  }

  /** Compute aggregate stats for the failure interception panel. */
  getFailureInterceptionStats(daysBack = 7): FailureInterceptionStats {
    this.runFailureInterceptionMigration();
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        AVG(similarity_score) AS avg_similarity,
        SUM(model_upgraded) AS model_upgrades,
        SUM(CASE WHEN final_outcome = 'passed' THEN 1 ELSE 0 END) AS passed,
        SUM(CASE WHEN final_outcome IS NOT NULL THEN 1 ELSE 0 END) AS resolved
      FROM failure_interceptions
      WHERE created_at >= ?
    `).get(cutoff) as {
      total: number;
      avg_similarity: number | null;
      model_upgrades: number;
      passed: number;
      resolved: number;
    };

    const total = row.total ?? 0;
    const resolved = row.resolved ?? 0;
    const passed = row.passed ?? 0;
    return {
      total,
      avg_similarity: row.avg_similarity ?? 0,
      model_upgrades: row.model_upgrades ?? 0,
      prevention_rate: resolved > 0 ? passed / resolved : 0,
    };
  }

  /** Update the final outcome of an interception record once the task completes verification. */
  updateFailureInterceptionOutcome(taskId: string, outcome: "passed" | "failed"): void {
    this.runFailureInterceptionMigration();
    this.db.prepare(`
      UPDATE failure_interceptions SET final_outcome = ? WHERE task_id = ? AND final_outcome IS NULL
    `).run(outcome, taskId);
  }

  // ── Guard Health Metrics (issue #1163) ────────────────────────────────────

  private runGuardHealthMetricsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guard_surge_hits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        hit_at TEXT NOT NULL,
        suppression_active INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_guard_surge_hits_repo_issue ON guard_surge_hits(repo, issue_number);
      CREATE INDEX IF NOT EXISTS idx_guard_surge_hits_at ON guard_surge_hits(hit_at);
      CREATE INDEX IF NOT EXISTS idx_guard_surge_hits_suppressed ON guard_surge_hits(suppression_active);

      CREATE TABLE IF NOT EXISTS guard_surge_leaks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        suppression_recorded_at TEXT NOT NULL,
        leak_hit_at TEXT NOT NULL,
        UNIQUE(repo, issue_number, leak_hit_at)
      );
      CREATE INDEX IF NOT EXISTS idx_guard_surge_leaks_at ON guard_surge_leaks(leak_hit_at);
    `);
  }

  recordGuardHit(repo: string, issueNumber: number, suppressionActive: boolean): void {
    this.runGuardHealthMetricsMigration();
    this.db.prepare(`
      INSERT INTO guard_surge_hits (repo, issue_number, hit_at, suppression_active)
      VALUES (?, ?, ?, ?)
    `).run(repo, issueNumber, new Date().toISOString(), suppressionActive ? 1 : 0);
  }

  checkForLeakedHits(repo: string, issueNumber: number, suppressionRecordedAt: string): number {
    this.runGuardHealthMetricsMigration();
    const result = this.db.prepare(`
      SELECT COUNT(*) AS count FROM guard_surge_hits
      WHERE repo = ? AND issue_number = ? AND hit_at > ? AND suppression_active = 0
    `).get(repo, issueNumber, suppressionRecordedAt) as { count: number };
    return result.count ?? 0;
  }

  recordLeakedHits(repo: string, issueNumber: number, suppressionRecordedAt: string): void {
    this.runGuardHealthMetricsMigration();
    const leakedCount = this.checkForLeakedHits(repo, issueNumber, suppressionRecordedAt);
    if (leakedCount > 0) {
      this.db.prepare(`
        INSERT OR IGNORE INTO guard_surge_leaks (repo, issue_number, suppression_recorded_at, leak_hit_at)
        SELECT ?, ?, ?, hit_at FROM guard_surge_hits
        WHERE repo = ? AND issue_number = ? AND hit_at > ? AND suppression_active = 0
      `).run(
        repo, issueNumber, suppressionRecordedAt,
        repo, issueNumber, suppressionRecordedAt
      );
    }
  }

  getGuardHealthMetrics(windowMs: number): {
    total_hits: number;
    leaked_hits: number;
    duplicate_suppressed_hits: number;
    active_suppressions: number;
    suppressions: Array<{ repo: string; issue_number: number; expires_at: string; minutes_remaining: number }>;
  } {
    this.runGuardHealthMetricsMigration();
    this.runGuardDuplicateSuppressionsMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const now = Date.now();

    // Count total hits
    const hitRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM guard_surge_hits WHERE hit_at >= ?
    `).get(cutoff) as { count: number };
    const total_hits = hitRow.count ?? 0;

    // Count leaked hits
    const leakRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM guard_surge_leaks WHERE leak_hit_at >= ?
    `).get(cutoff) as { count: number };
    const leaked_hits = leakRow.count ?? 0;

    // Count duplicate-suppressed hits
    const cutoffDate = cutoff.split('T')[0];
    const dupRow = this.db.prepare(`
      SELECT COALESCE(SUM(suppression_count), 0) AS total FROM guard_duplicate_suppressions WHERE suppressed_date >= ?
    `).get(cutoffDate) as { total: number };
    const duplicate_suppressed_hits = dupRow.total ?? 0;

    // Get active suppressions with minutes remaining
    const rawSuppressions = this.db.prepare(`
      SELECT repo, issue_number, expires_at FROM dispatch_surge_suppressions
      WHERE expires_at > datetime('now')
      ORDER BY expires_at ASC
    `).all() as Array<{ repo: string; issue_number: number; expires_at: string }>;

    const suppressions = rawSuppressions.map((s) => ({
      ...s,
      minutes_remaining: Math.ceil((new Date(s.expires_at).getTime() - now) / (60 * 1000)),
    }));

    return {
      total_hits,
      leaked_hits,
      duplicate_suppressed_hits,
      active_suppressions: suppressions.length,
      suppressions,
    };
  }

  // ── Guard Duplicate Suppressions (issue #1164) ────────────────────────────

  private runGuardDuplicateSuppressionsMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guard_duplicate_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        suppressed_date TEXT NOT NULL,
        suppression_count INTEGER DEFAULT 1,
        UNIQUE(repo, issue_number, suppressed_date)
      );
      CREATE INDEX IF NOT EXISTS idx_guard_dup_supp_repo_issue ON guard_duplicate_suppressions(repo, issue_number);
      CREATE INDEX IF NOT EXISTS idx_guard_dup_supp_date ON guard_duplicate_suppressions(suppressed_date);
    `);
  }

  hasRecentAlreadyInReviewTask(repo: string, issueNumber: number, windowMs: number = 6 * 60 * 60 * 1000): boolean {
    const sourceRef = `${repo}#${issueNumber}`;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const row = this.db.prepare(`
      SELECT 1 FROM tasks
      WHERE source = 'github'
        AND source_ref = ?
        AND status = 'done'
        AND verification_status = 'approved'
        AND created_at > ?
      LIMIT 1
    `).get(sourceRef, cutoff);
    return !!row;
  }

  recordGuardDuplicateSuppression(repo: string, issueNumber: number): void {
    this.runGuardDuplicateSuppressionsMigration();
    const today = new Date().toISOString().split('T')[0];
    this.db.prepare(`
      INSERT INTO guard_duplicate_suppressions (repo, issue_number, suppressed_date, suppression_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(repo, issue_number, suppressed_date) DO UPDATE SET
        suppression_count = suppression_count + 1
    `).run(repo, issueNumber, today);
  }

  getGuardDuplicateSuppressions(windowMs: number): Array<{ repo: string; issueNumber: number; count: number }> {
    this.runGuardDuplicateSuppressionsMigration();
    const cutoff = new Date(Date.now() - windowMs).toISOString().split('T')[0];
    return this.db.prepare(`
      SELECT repo, issue_number AS issueNumber, SUM(suppression_count) AS count
      FROM guard_duplicate_suppressions
      WHERE suppressed_date >= ?
      GROUP BY repo, issue_number
      ORDER BY count DESC
    `).all(cutoff) as Array<{ repo: string; issueNumber: number; count: number }>;
  }

  // ── Standup Quality History (issue #591) ──────────────────────────────────

  private runStandupQualityMigration(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS standup_quality_history (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name        TEXT    NOT NULL,
        standup_date      TEXT    NOT NULL,
        quality_score     REAL    NOT NULL,
        action_item_count INTEGER NOT NULL DEFAULT 0,
        task_id           TEXT,
        recorded_at       TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sqh_agent_date
        ON standup_quality_history(agent_name, standup_date DESC);
      CREATE INDEX IF NOT EXISTS idx_sqh_date
        ON standup_quality_history(standup_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sqh_task_id
        ON standup_quality_history(task_id) WHERE task_id IS NOT NULL;
    `);
  }

  /**
   * Record a standup quality event for a single agent.
   *
   * Called from the verification loop when a standup task is approved or
   * rejected, so operators can track per-agent scoring trends over time
   * via `/standup-quality` (Telegram) or `GET /standup-quality` (metrics).
   *
   * INSERT OR IGNORE on task_id prevents double-counting if verification
   * runs more than once for the same task.
   */
  recordStandupQualityEvent(params: {
    agentName: string;
    standupDate: string;
    qualityScore: number;
    actionItemCount: number;
    taskId?: string;
  }): void {
    this.runStandupQualityMigration();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO standup_quality_history
         (agent_name, standup_date, quality_score, action_item_count, task_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.agentName,
        params.standupDate,
        params.qualityScore,
        params.actionItemCount,
        params.taskId ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Compute per-agent standup quality trends over a rolling window.
   *
   * Returns one entry per agent with chronological score arrays suitable
   * for sparkline rendering, an average, the latest score, a low-streak
   * flag (last 3 standups all below 0.70), and trend direction.
   *
   * @param agentName  Filter to a single agent (null = all agents)
   * @param days       Rolling window in days (0 = no cutoff)
   */
  getStandupQualityTrend(agentName: string | null, days: number): StandupQualityAgentTrend[] {
    this.runStandupQualityMigration();
    const cutoff =
      days > 0
        ? new Date(Date.now() - days * 86_400_000).toISOString().split("T")[0]
        : "0000-00-00";

    const agentFilter = agentName ? "AND agent_name = ?" : "";
    const agentParam = agentName ? [agentName] : [];

    const agents = this.db
      .prepare(
        `SELECT DISTINCT agent_name FROM standup_quality_history
         WHERE standup_date >= ? ${agentFilter}
         ORDER BY agent_name`,
      )
      .all(cutoff!, ...agentParam) as Array<{ agent_name: string }>;

    return agents.map(({ agent_name }) => {
      const rows = this.db
        .prepare(
          `SELECT standup_date, quality_score FROM standup_quality_history
           WHERE agent_name = ? AND standup_date >= ?
           ORDER BY standup_date ASC`,
        )
        .all(agent_name, cutoff!) as Array<{ standup_date: string; quality_score: number }>;

      const scores = rows.map((r) => r.quality_score);
      const dates = rows.map((r) => r.standup_date);
      const n = scores.length;

      const avg_score =
        n > 0 ? Math.round((scores.reduce((s, v) => s + v, 0) / n) * 100) / 100 : null;
      const latest_score = n > 0 ? (scores[n - 1] ?? null) : null;
      const low_streak = n >= 3 && scores.slice(-3).every((s) => s < 0.7);

      let trend: StandupQualityAgentTrend["trend"] = "insufficient_data";
      if (n >= 4) {
        const half = Math.floor(n / 2);
        const recentAvg =
          scores.slice(-half).reduce((s, v) => s + v, 0) / half;
        const priorAvg =
          scores.slice(0, half).reduce((s, v) => s + v, 0) / half;
        const delta = recentAvg - priorAvg;
        trend = delta > 0.05 ? "improving" : delta < -0.05 ? "declining" : "stable";
      } else if (n >= 2) {
        trend = "stable";
      }

      return { agent_name, scores, dates, avg_score, latest_score, low_streak, trend };
    });
  }

  /**
   * One-time backfill of `standup_quality_history` from historical tasks.
   *
   * Queries `tasks` for rows where:
   *   - title LIKE '%standup%' (case-insensitive)
   *   - quality_score IS NOT NULL
   *   - task_id not already in standup_quality_history (idempotent via LEFT JOIN)
   *
   * Extracts the ISO date from `created_at` as `standup_date` and inserts
   * via INSERT OR IGNORE, so running this multiple times is safe.
   *
   * Returns the number of rows inserted.
   */
  backfillStandupQualityHistory(): number {
    this.runStandupQualityMigration();

    // Find historical standup tasks not yet recorded.
    const candidates = this.db
      .prepare(
        `SELECT t.id, t.agent_name, t.quality_score, t.created_at
         FROM tasks t
         LEFT JOIN standup_quality_history sqh ON sqh.task_id = t.id
         WHERE sqh.id IS NULL
           AND t.quality_score IS NOT NULL
           AND t.agent_name IS NOT NULL
           AND LOWER(t.title) LIKE '%standup%'
         ORDER BY t.created_at ASC`,
      )
      .all() as Array<{
        id: string;
        agent_name: string;
        quality_score: number;
        created_at: string;
      }>;

    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO standup_quality_history
       (agent_name, standup_date, quality_score, action_item_count, task_id, recorded_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    );

    const now = new Date().toISOString();
    let inserted = 0;

    const runInserts = this.db.transaction(() => {
      for (const row of candidates) {
        // Extract date portion from ISO timestamp (e.g. "2026-04-20T14:35:00Z" → "2026-04-20")
        const standupDate = (row.created_at ?? "").slice(0, 10) || now.slice(0, 10);
        const result = insert.run(row.agent_name, standupDate, row.quality_score, row.id, now);
        inserted += result.changes;
      }
    });

    runInserts();
    return inserted;
  }

  /**
   * Fetch recent failed tasks suitable for similarity matching.
   * Returns tasks with status='failed' OR quality_score < 0.5 (rejected).
   * Limited to last N days and up to `limit` rows.
   */
  getRecentFailedTasksForSimilarity(daysBack = 14, limit = 50): Array<{
    id: string;
    title: string;
    result: string | null;
    agent: string;
  }> {
    const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    // Check columns defensively (old DBs may not have quality_score)
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    const colSet = new Set(cols.map((c) => c.name));
    const qualityClause = colSet.has("quality_score")
      ? "OR (quality_score IS NOT NULL AND quality_score < 0.5)"
      : "";
    return this.db.prepare(`
      SELECT id, title, result, agent_name AS agent
      FROM tasks
      WHERE created_at >= ?
        AND (status = 'failed' ${qualityClause})
        AND title IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(cutoff, limit) as Array<{ id: string; title: string; result: string | null; agent: string }>;
  }

  /**
   * Return tasks with quality scores in the marginal range (minScore ≤ score < maxScore).
   * Includes per-day trend data and per-agent breakdown for dashboard panels.
   *
   * @param days      Rolling window in days (0 = no cutoff)
   * @param minScore  Lower bound of marginal range (inclusive, default 0.5)
   * @param maxScore  Upper bound of marginal range (exclusive, default 0.75)
   * @param agent     Optional agent name filter
   * @param limit     Max tasks to return (default 50, max 200)
   * @param offset    Pagination offset (default 0)
   */
  getMarginalScoreTasks(
    days = 30,
    minScore = 0.5,
    maxScore = 0.75,
    agent: string | null = null,
    limit = 50,
    offset = 0,
  ): MarginalScoreTasksResult {
    const cap = Math.min(limit, 200);
    const cutoff =
      days > 0
        ? new Date(Date.now() - days * 86_400_000).toISOString()
        : "0000-00-00T00:00:00.000Z";

    const agentFilter = agent ? "AND agent_name = ?" : "";
    const baseParams: (string | number)[] = [minScore, maxScore, cutoff];
    if (agent) baseParams.push(agent);

    const tasks = this.db
      .prepare(
        `SELECT id, title, description, source, source_ref, status, agent_name,
                quality_score, verification_status, verification_notes,
                task_type, created_at, updated_at
         FROM tasks
         WHERE quality_score >= ? AND quality_score < ?
           AND created_at >= ?
           AND parent_task_id IS NULL
           ${agentFilter}
         ORDER BY quality_score ASC, created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...baseParams, cap, offset) as Array<{
        id: string;
        title: string;
        description: string | null;
        source: string;
        source_ref: string | null;
        status: string;
        agent_name: string | null;
        quality_score: number;
        verification_status: string | null;
        verification_notes: string | null;
        task_type: string;
        created_at: string;
        updated_at: string;
      }>;

    const countParams: (string | number)[] = [minScore, maxScore, cutoff];
    if (agent) countParams.push(agent);
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks
           WHERE quality_score >= ? AND quality_score < ?
             AND created_at >= ?
             AND parent_task_id IS NULL
             ${agentFilter}`,
        )
        .get(...countParams) as { n: number }
    ).n;

    const avgRow = (
      this.db
        .prepare(
          `SELECT AVG(quality_score) AS avg FROM tasks
           WHERE quality_score >= ? AND quality_score < ?
             AND created_at >= ?
             AND parent_task_id IS NULL
             ${agentFilter}`,
        )
        .get(...countParams) as { avg: number | null }
    );

    // Daily trend: count of marginal tasks per UTC date
    const trendParams: (string | number)[] = [minScore, maxScore, cutoff];
    if (agent) trendParams.push(agent);
    const trendRows = this.db
      .prepare(
        `SELECT DATE(created_at) AS day, COUNT(*) AS count
         FROM tasks
         WHERE quality_score >= ? AND quality_score < ?
           AND created_at >= ?
           AND parent_task_id IS NULL
           ${agentFilter}
         GROUP BY day
         ORDER BY day ASC`,
      )
      .all(...trendParams) as Array<{ day: string; count: number }>;

    // Per-agent breakdown
    const agentParams: (string | number)[] = [minScore, maxScore, cutoff];
    if (agent) agentParams.push(agent);
    const agentRows = this.db
      .prepare(
        `SELECT agent_name, COUNT(*) AS count, AVG(quality_score) AS avg_score
         FROM tasks
         WHERE quality_score >= ? AND quality_score < ?
           AND created_at >= ?
           AND parent_task_id IS NULL
           ${agentFilter}
         GROUP BY agent_name
         ORDER BY count DESC`,
      )
      .all(...agentParams) as Array<{ agent_name: string | null; count: number; avg_score: number }>;

    return {
      total,
      avg_score: avgRow.avg !== null ? Math.round(avgRow.avg * 1000) / 1000 : null,
      tasks,
      trend: trendRows,
      per_agent: agentRows.map((r) => ({
        agent_name: r.agent_name ?? "(unknown)",
        count: r.count,
        avg_score: Math.round(r.avg_score * 1000) / 1000,
      })),
    };
  }

  /**
   * Compute the external-impact ratio for the given rolling window.
   *
   * A task is classified as **external** when its `source_ref` points to a
   * GitHub repo that is NOT a fleet-internal infrastructure repository.
   * Fleet-internal repos match the pattern `rapartlu/agent-*` (e.g.
   * `rapartlu/agent-orchestrator`, `rapartlu/agent-reviewer`).
   *
   * Tasks with no `source_ref`, or with a source_ref from a fleet-internal
   * repo, are classified as **internal**.
   *
   * The alert threshold is 30%: when fewer than 30% of tasks in the 7-day
   * window are external-impact, the Telegram alert fires.
   *
   * @param days  Rolling window in calendar days (default 7).
   */
  getExternalImpactRatio(days = 7): ExternalImpactRatioResult {
    const cutoff = `datetime('now', '-' || ${days} || ' days')`;

    // Fleet-internal repos: any source_ref whose repo segment matches agent-*.
    // We use a SQLite GLOB pattern: source_ref LIKE 'rapartlu/agent-%#%'
    const INTERNAL_PATTERN = "rapartlu/agent-%#%";

    // Total root tasks in window
    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM tasks
         WHERE parent_task_id IS NULL
           AND created_at >= ${cutoff}`,
      )
      .get() as { n: number };
    const total_tasks = totalRow.n;

    // External tasks: have a source_ref AND repo is NOT fleet-internal
    const externalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM tasks
         WHERE parent_task_id IS NULL
           AND created_at >= ${cutoff}
           AND source_ref IS NOT NULL
           AND source_ref NOT LIKE ?`,
      )
      .get(INTERNAL_PATTERN) as { n: number };
    const external_tasks = externalRow.n;

    const internal_tasks = total_tasks - external_tasks;
    const ratio_pct = total_tasks > 0
      ? Math.round((external_tasks / total_tasks) * 10000) / 100
      : null;
    const alert = total_tasks > 0 && ratio_pct !== null && ratio_pct < 30;

    // Per-day breakdown for sparkline
    const dailyRows = this.db
      .prepare(
        `SELECT
           DATE(created_at) AS date,
           COUNT(*) AS total,
           SUM(CASE
             WHEN source_ref IS NOT NULL AND source_ref NOT LIKE ?
             THEN 1 ELSE 0
           END) AS external_count
         FROM tasks
         WHERE parent_task_id IS NULL
           AND created_at >= ${cutoff}
         GROUP BY DATE(created_at)
         ORDER BY DATE(created_at) ASC`,
      )
      .all(INTERNAL_PATTERN) as Array<{
        date: string;
        total: number;
        external_count: number;
      }>;

    const daily: ExternalImpactDay[] = dailyRows.map((r) => {
      const ext = r.external_count;
      const tot = r.total;
      return {
        date: r.date,
        external: ext,
        internal: tot - ext,
        ratio_pct: tot > 0 ? Math.round((ext / tot) * 10000) / 100 : null,
      };
    });

    return {
      days,
      total_tasks,
      external_tasks,
      internal_tasks,
      ratio_pct,
      alert,
      daily,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Create a re-dispatch task for a marginal-score task.
   * Copies the original task description and title with a `[redispatch]` prefix,
   * targeting the same agent and source_ref. The original task's ID is stored
   * as `parent_task_id` for lineage tracking.
   *
   * Returns the newly created task or null if the original task is not found
   * or does not have a marginal quality score.
   */
  createMarginalRedispatchTask(
    originalTaskId: string,
    minScore = 0.5,
    maxScore = 0.75,
  ): Task | null {
    const original = this.getTask(originalTaskId);
    if (!original) return null;
    if (
      original.quality_score === null ||
      original.quality_score < minScore ||
      original.quality_score >= maxScore
    ) {
      return null;
    }

    const scoreStr = original.quality_score.toFixed(2);
    const newTitle = `[redispatch] ${original.title} (marginal score: ${scoreStr})`;

    return this.createTask({
      title: newTitle,
      description: original.description
        ? `Re-dispatched from marginal-score task ${originalTaskId} (score: ${scoreStr}).\n\n${original.description}`
        : `Re-dispatched from marginal-score task ${originalTaskId} (score: ${scoreStr}).`,
      source: "marginal-redispatch",
      source_ref: original.source_ref ?? undefined,
      agent_name: original.agent_name ?? undefined,
      task_type: original.task_type as TaskType,
      parent_task_id: originalTaskId,
    });
  }
}

// ── FTS5 query builder ────────────────────────────────────────────────────────

/**
 * Common English stopwords to exclude from FTS5 queries.
 * Keeps the query focused on semantically meaningful terms.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "are", "was", "were",
  "been", "being", "have", "has", "had", "having", "does", "did", "doing",
  "will", "would", "could", "should", "may", "might", "shall", "can",
  "not", "but", "its", "you", "your", "they", "them", "their", "what",
  "which", "when", "where", "how", "all", "each", "every", "both",
  "into", "over", "after", "before", "between", "under", "again",
  "then", "than", "also", "just", "about", "only", "very", "too",
  "here", "there", "some", "any", "such", "more", "most", "other",
  "one", "two", "three", "use", "using", "used",
]);

/**
 * Build a FTS5 MATCH query from free-form text.
 *
 * Strategy:
 * 1. Strip markdown/code/URLs
 * 2. Extract words >3 chars, excluding stopwords
 * 3. Deduplicate and limit to 12 terms (FTS5 performance guardrail)
 * 4. Join with OR for broad matching (BM25 handles ranking)
 *
 * Returns null if no usable terms remain.
 */
function buildFts5Query(text: string): string | null {
  // Strip markdown formatting, URLs, code blocks
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")       // code blocks
    .replace(/`[^`]+`/g, " ")              // inline code
    .replace(/https?:\/\/\S+/g, " ")       // URLs
    .replace(/[#*_\[\](){}|>~]/g, " ")     // markdown chars
    .replace(/[^a-zA-Z0-9\s-]/g, " ")      // non-alphanumeric
    .toLowerCase();

  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w))
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 3);

  // Deduplicate
  const unique = [...new Set(words)];
  if (unique.length === 0) return null;

  // Limit to 12 terms for performance; pick from the start (title/description
  // tend to appear first in dispatch messages and carry the most meaning).
  const terms = unique.slice(0, 12);

  // FTS5 query: terms joined with OR for broad matching
  // Wrap each term in quotes to prevent FTS5 syntax interpretation
  return terms.map((t) => `"${t}"`).join(" OR ");
}
