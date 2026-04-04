import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { ulid } from "ulid";

export type TaskStatus = "pending" | "planning" | "dispatched" | "in_progress" | "done" | "failed";
export type TaskSource = "github" | "linear" | "slack" | "manual" | "pr-feedback";
export type TaskType = "implementation" | "research";

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
  outcome: SupervisorOutcome;
  task_id: string | null;
  created_at: string;
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
}

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

CREATE TABLE IF NOT EXISTS daemon_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_name);
CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_daemon_cycles_started ON daemon_cycles(started_at);
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
    source: TaskSource;
    source_ref?: string;
    agent_name?: string;
    task_type?: TaskType;
  }): Task {
    const now = new Date().toISOString();
    const id = ulid();
    const stmt = this.db.prepare(`
      INSERT INTO tasks (id, title, description, source, source_ref, status, agent_name, task_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);
    stmt.run(id, params.title, params.description ?? null, params.source, params.source_ref ?? null, params.agent_name ?? null, params.task_type ?? "implementation", now, now);
    return this.getTask(id)!;
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
    const now = new Date().toISOString();
    const id = ulid();
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, source, status, agent_name, parent_task_id, step_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(id, params.title, params.description, params.source, params.agent_name, params.parent_task_id, params.step_id, now, now);
    return this.getTask(id)!;
  }

  getSubTasks(parentTaskId: string): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC").all(parentTaskId) as Task[];
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

  updateTask(id: string, updates: Partial<Pick<Task, "status" | "agent_name" | "conversation_id" | "result" | "plan" | "verification_status" | "quality_score" | "verification_notes" | "retry_count" | "next_retry_at">>): Task | undefined {
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
    this.db.prepare(`
      INSERT OR IGNORE INTO processed_triggers (source, source_ref, task_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(source, sourceRef, taskId, new Date().toISOString());
  }

  getRecentActivity(limit = 50): TaskLog[] {
    return this.db.prepare(
      "SELECT * FROM task_logs ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as TaskLog[];
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
   * Return failed tasks that are eligible for retry: their `next_retry_at` has
   * elapsed and they haven't yet reached `maxRetries` attempts.
   * Results are ordered by `next_retry_at` ascending (oldest due first).
   */
  getRetryableTasks(maxRetries: number): Task[] {
    const now = new Date().toISOString();
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'failed'
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

  getAgentStats(): Array<{ agent_name: string; total: number; done: number; failed: number; avg_score: number | null }> {
    return this.db.prepare(`
      SELECT agent_name,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        AVG(quality_score) as avg_score
      FROM tasks
      WHERE agent_name IS NOT NULL AND parent_task_id IS NULL
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

  /** Mark a cycle as finished, recording duration. */
  recordCycleEnd(cycleId: number, startedAt: Date): void {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    this.db
      .prepare("UPDATE daemon_cycles SET finished_at = ?, duration_ms = ? WHERE id = ?")
      .run(finishedAt.toISOString(), durationMs, cycleId);
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
    `);
  }

  /**
   * Persist a supervisor decision with its execution outcome.
   * Called by the daemon after executing (or skipping) each supervisor decision.
   */
  addSupervisorDecision(params: {
    action: string;
    agent_name?: string;
    reason: string;
    message?: string;
    outcome: SupervisorOutcome;
    task_id?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_decisions (action, agent_name, reason, message, outcome, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.action,
        params.agent_name ?? null,
        params.reason,
        params.message ?? null,
        params.outcome,
        params.task_id ?? null,
        new Date().toISOString(),
      );
  }

  /**
   * Return the most recent supervisor decisions, newest first.
   * Used by the supervisor to build context across cycles.
   */
  getRecentSupervisorDecisions(limit = 10): SupervisorDecisionRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM supervisor_decisions ORDER BY created_at DESC LIMIT ?",
      )
      .all(limit) as SupervisorDecisionRecord[];
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

  close(): void {
    this.db.close();
  }
}
