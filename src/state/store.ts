/**
 * SQLite-backed StateStore implementation.
 *
 * Reads from and writes to the shared state.db that the orchestrator daemon
 * maintains. The schema here mirrors the orchestrator's schema exactly so both
 * processes can share a single database file.
 */

import Database from "better-sqlite3";
import type {
  ITelegramStateStore,
  Task,
  TaskStatus,
  MergeQueueEntry,
  AgentStats,
  EfficiencyTrend,
  EfficiencyTrendPoint,
  EfficiencyTrendSeries,
  AgentHealth,
  SupervisorDecisionRecord,
  SupervisorDecisionQuery,
  DispatchRequest,
  PRConfidenceRecord,
  RoutingAccuracyStats,
  AgentQualityByTaskType,
  AgentScoreDistribution,
  ScoreDistributionBucket,
  CalibrationDriftAlert,
  AgentSLAThreshold,
  LlmCallEvent,
  LlmTokenStats,
  PROutcomeRecord,
  ScoreCalibrationRow,
  AdjustedThreshold,
  ReviewCategory,
  PRIterationReport,
  PRIterationStat,
  AgentIterationStat,
  ReviewCategoryCount,
} from "./types.js";
import { ulid } from "../util/ulid.js";

export class StateStore implements ITelegramStateStore {
  private db: Database.Database;

  constructor(dbPath: string = process.env.STATE_DB_PATH ?? "state.db") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        agent_name TEXT,
        task_type TEXT NOT NULL DEFAULT 'implementation',
        source TEXT,
        source_ref TEXT,
        result TEXT,
        verification_status TEXT,
        quality_score REAL,
        verification_notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS pr_reviews (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        decision TEXT NOT NULL,
        confidence REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS merge_queue (
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        position INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (repo, pr_number)
      );

      CREATE TABLE IF NOT EXISTS supervisor_decisions (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        agent_name TEXT,
        task_id TEXT,
        reason TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        agent_name TEXT,
        task_id TEXT,
        reason TEXT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS system_flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS dispatch_requests (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS llm_call_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        call_type   TEXT NOT NULL,
        model       TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms   INTEGER,
        task_id     TEXT,
        pr_number   INTEGER
      );
    `);

    // Index on call_type + created_at for efficient per-type aggregation
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_llm_call_events_call_type_created_at
        ON llm_call_events (call_type, created_at DESC);
    `);

    // Create PR outcome records table for score calibration (idempotent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_outcome_records (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'implementation',
        quality_score REAL NOT NULL,
        score_bucket REAL NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pr_outcome_records_agent_type_bucket
        ON pr_outcome_records (agent_name, task_type, score_bucket);

      CREATE INDEX IF NOT EXISTS idx_pr_outcome_records_recorded_at
        ON pr_outcome_records (recorded_at DESC);
    `);

    // Add priority column to tasks if it doesn't exist yet (idempotent)
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists — ignore
    }

    // Add message column to supervisor_decisions (idempotent)
    try {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN message TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add issue_ref column to supervisor_decisions (idempotent)
    try {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN issue_ref TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add rationale column to supervisor_decisions (idempotent).
    // Stores a JSON-encoded DispatchRationale including borrow annotation.
    try {
      this.db.exec("ALTER TABLE supervisor_decisions ADD COLUMN rationale TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add message column to routing_decisions (idempotent).
    try {
      this.db.exec("ALTER TABLE routing_decisions ADD COLUMN message TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add issue_ref column to routing_decisions (idempotent).
    try {
      this.db.exec("ALTER TABLE routing_decisions ADD COLUMN issue_ref TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add rationale column to routing_decisions (idempotent).
    try {
      this.db.exec("ALTER TABLE routing_decisions ADD COLUMN rationale TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add confidence column to pr_reviews (idempotent — for existing databases)
    try {
      this.db.exec("ALTER TABLE pr_reviews ADD COLUMN confidence REAL");
    } catch {
      // Column already exists — ignore
    }

    // Add PR iteration tracking columns to pr_reviews (idempotent — issue #110)
    try {
      this.db.exec("ALTER TABLE pr_reviews ADD COLUMN review_number INTEGER NOT NULL DEFAULT 1");
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE pr_reviews ADD COLUMN agent_name TEXT");
    } catch {
      // Column already exists — ignore
    }
    try {
      // Stores a JSON array of ReviewCategory strings (e.g. '["logic","security"]')
      this.db.exec("ALTER TABLE pr_reviews ADD COLUMN review_categories TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Index for efficient per-PR iteration queries (idempotent)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pr_reviews_repo_pr_number
        ON pr_reviews (repo, pr_number, created_at ASC);
    `);

    // Add quality_explanation column to tasks (idempotent).
    // Stores the natural-language narrative for sub-0.80 quality scores.
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN quality_explanation TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add subtask tree columns (idempotent — issue #95).
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT");
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN rollup_policy TEXT");
    } catch {
      // Column already exists — ignore
    }
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN subtask_complexity_hint REAL");
    } catch {
      // Column already exists — ignore
    }

    // Index for parent → children lookups (idempotent)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id
        ON tasks (parent_task_id)
        WHERE parent_task_id IS NOT NULL;
    `);

    // Create index for efficient time-ordered lookups (idempotent)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_created_at
        ON supervisor_decisions (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_routing_decisions_created_at
        ON routing_decisions (created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_routing_decisions_agent_outcome_created_at
        ON routing_decisions (agent_name, outcome, created_at DESC);
    `);

    // Backfill existing supervisor decision rows into the routing audit table.
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO routing_decisions
          (id, action, agent_name, task_id, reason, outcome, created_at, message, issue_ref, rationale)
        SELECT id, action, agent_name, task_id, reason, outcome, created_at, message, issue_ref, rationale
        FROM supervisor_decisions;
      `);
    } catch {
      // Older databases may not have all columns yet; leave them untouched.
    }
  }

  // ── Task operations ──────────────────────────────────────────────────────

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
    return row ?? null;
  }

  updateTask(id: string, updates: Partial<Task>): void {
    const fields = Object.keys(updates)
      .filter((k) => k !== "id")
      .map((k) => `${k} = @${k}`)
      .join(", ");
    if (!fields) return;
    this.db
      .prepare(`UPDATE tasks SET ${fields}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...updates, id });
  }

  hasActiveTask(agentName: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM tasks WHERE agent_name = ? AND status = 'dispatched' LIMIT 1")
      .get(agentName);
    return row !== undefined;
  }

  listTasks(opts: { status?: TaskStatus; agent_name?: string; limit?: number }): Task[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.status) { conditions.push("status = @status"); params.status = opts.status; }
    if (opts.agent_name) { conditions.push("agent_name = @agent_name"); params.agent_name = opts.agent_name; }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    return this.db
      .prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(params) as Task[];
  }

  getChildTasks(parentTaskId: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC")
      .all(parentTaskId) as Task[];
  }

  getRecentCompleted(limit: number): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = 'done' ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Task[];
  }

  getUnverified(limit: number): Task[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE status = 'done' AND verification_status IS NULL ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit) as Task[];
  }

  getAgentStats(): AgentStats[] {
    return this.db
      .prepare(`
        SELECT
          agent_name,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
        FROM tasks
        WHERE agent_name IS NOT NULL
        GROUP BY agent_name
      `)
      .all() as AgentStats[];
  }

  /**
   * Return per-agent routing accuracy stats for the given look-back window.
   *
   * Accuracy is derived from the `tasks` table: for each agent we report
   * - total_routed:   tasks dispatched to that agent in the window
   * - verified_count: tasks that completed LLM verification (approved or rejected)
   * - avg_quality_score: mean quality_score across verified tasks
   * - approval_rate:  fraction of verified tasks that were approved
   *
   * Only agents with at least one task in the window are included.
   */
  getRoutingAccuracyStats(days: number = 30): RoutingAccuracyStats[] {
    const lookback = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
    return this.db
      .prepare(
        `SELECT
           agent_name,
           COUNT(*) AS total_routed,
           SUM(CASE WHEN verification_status IN ('approved', 'rejected') THEN 1 ELSE 0 END) AS verified_count,
           AVG(CASE WHEN quality_score IS NOT NULL THEN quality_score END) AS avg_quality_score,
           AVG(CASE WHEN verification_status = 'approved' THEN 1.0
                    WHEN verification_status = 'rejected' THEN 0.0
                    ELSE NULL END) AS approval_rate
         FROM tasks
         WHERE agent_name IS NOT NULL
           AND updated_at >= datetime('now', ?)
         GROUP BY agent_name
         ORDER BY avg_quality_score DESC`,
      )
      .all(`-${lookback} days`) as RoutingAccuracyStats[];
  }

  /**
   * Return per-agent quality breakdown grouped by task type for the given
   * look-back window (default: 30 days).
   *
   * Enables the supervisor to answer "which agent scores highest on
   * implementation tasks vs. research tasks?" and route accordingly.
   */
  getAgentQualityByTaskType(days: number = 30): AgentQualityByTaskType[] {
    const lookback = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
    const rows = this.db
      .prepare(
        `SELECT
           agent_name,
           task_type,
           COUNT(*) AS task_count,
           AVG(CASE WHEN quality_score IS NOT NULL THEN quality_score END) AS avg_quality_score,
           AVG(CASE WHEN verification_status = 'approved' THEN 1.0
                    WHEN verification_status = 'rejected' THEN 0.0
                    ELSE NULL END) AS approval_rate
         FROM tasks
         WHERE agent_name IS NOT NULL
           AND updated_at >= datetime('now', ?)
         GROUP BY agent_name, task_type
         ORDER BY agent_name, task_type`,
      )
      .all(`-${lookback} days`) as Array<{
        agent_name: string;
        task_type: string;
        task_count: number;
        avg_quality_score: number | null;
        approval_rate: number | null;
      }>;

    // Group by agent_name
    const byAgent = new Map<string, AgentQualityByTaskType>();
    for (const row of rows) {
      if (!byAgent.has(row.agent_name)) {
        byAgent.set(row.agent_name, { agent_name: row.agent_name, by_task_type: [] });
      }
      byAgent.get(row.agent_name)!.by_task_type.push({
        task_type: row.task_type,
        task_count: row.task_count,
        avg_quality_score: row.avg_quality_score,
        approval_rate: row.approval_rate,
      });
    }
    return [...byAgent.values()];
  }

  /**
   * Return per-agent score distribution histograms for the given look-back window.
   *
   * Each agent gets:
   * - mean_score: average quality_score across scored tasks
   * - low_confidence_approval_rate: fraction of approved tasks with score < 0.8
   *   (a proxy for false-positive risk)
   * - buckets: count of tasks per 0.1-wide score bucket (0.0–0.1, 0.1–0.2, …, 0.9–1.0)
   */
  getScoreDistributions(days: number = 30): AgentScoreDistribution[] {
    const lookback = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;

    // One row per (agent_name, bucket) for tasks in the window
    const bucketRows = this.db
      .prepare(
        `SELECT
           agent_name,
           CASE
             WHEN quality_score < 0.1 THEN 0.0
             WHEN quality_score < 0.2 THEN 0.1
             WHEN quality_score < 0.3 THEN 0.2
             WHEN quality_score < 0.4 THEN 0.3
             WHEN quality_score < 0.5 THEN 0.4
             WHEN quality_score < 0.6 THEN 0.5
             WHEN quality_score < 0.7 THEN 0.6
             WHEN quality_score < 0.8 THEN 0.7
             WHEN quality_score < 0.9 THEN 0.8
             ELSE 0.9
           END AS bucket_min,
           COUNT(*) AS count
         FROM tasks
         WHERE quality_score IS NOT NULL
           AND updated_at >= datetime('now', ?)
         GROUP BY agent_name, bucket_min
         ORDER BY agent_name, bucket_min`,
      )
      .all(`-${lookback} days`) as Array<{
        agent_name: string;
        bucket_min: number;
        count: number;
      }>;

    // Per-agent summary stats
    const summaryRows = this.db
      .prepare(
        `SELECT
           agent_name,
           COUNT(*) AS task_count,
           AVG(quality_score) AS mean_score,
           SUM(CASE WHEN verification_status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
           SUM(CASE WHEN verification_status = 'approved' AND quality_score < 0.8 THEN 1 ELSE 0 END) AS low_conf_approved_count
         FROM tasks
         WHERE quality_score IS NOT NULL
           AND updated_at >= datetime('now', ?)
         GROUP BY agent_name`,
      )
      .all(`-${lookback} days`) as Array<{
        agent_name: string;
        task_count: number;
        mean_score: number | null;
        approved_count: number;
        low_conf_approved_count: number;
      }>;

    // Index buckets by agent
    const bucketsByAgent = new Map<string, ScoreDistributionBucket[]>();
    for (const row of bucketRows) {
      const list = bucketsByAgent.get(row.agent_name) ?? [];
      list.push({ bucket_min: row.bucket_min, count: row.count });
      bucketsByAgent.set(row.agent_name, list);
    }

    return summaryRows.map((s) => ({
      agent_name: s.agent_name,
      task_count: s.task_count,
      mean_score: s.mean_score,
      low_confidence_approval_rate:
        s.approved_count > 0
          ? s.low_conf_approved_count / s.approved_count
          : null,
      buckets: bucketsByAgent.get(s.agent_name) ?? [],
    }));
  }

  /**
   * Compute calibration drift alerts by comparing per-agent mean quality scores
   * between a recent window and a baseline window.
   *
   * @param recentDays   - Size of the recent window (default: 30 days).
   * @param baselineDays - Size of the baseline window immediately before the
   *                       recent window (default: 60 days, i.e. 31–90 days ago).
   *
   * Only agents with data in BOTH windows are returned.
   * `alerted` is true when |drift| > 0.1.
   */
  getCalibrationDriftAlerts(
    recentDays: number = 30,
    baselineDays: number = 60,
  ): CalibrationDriftAlert[] {
    const recent = Number.isFinite(recentDays) && recentDays >= 1 ? Math.floor(recentDays) : 30;
    const baseline =
      Number.isFinite(baselineDays) && baselineDays >= 1 ? Math.floor(baselineDays) : 60;

    const recentRows = this.db
      .prepare(
        `SELECT agent_name, AVG(quality_score) AS mean, COUNT(*) AS task_count
         FROM tasks
         WHERE quality_score IS NOT NULL
           AND updated_at >= datetime('now', ?)
         GROUP BY agent_name`,
      )
      .all(`-${recent} days`) as Array<{
        agent_name: string;
        mean: number;
        task_count: number;
      }>;

    const baselineRows = this.db
      .prepare(
        `SELECT agent_name, AVG(quality_score) AS mean, COUNT(*) AS task_count
         FROM tasks
         WHERE quality_score IS NOT NULL
           AND updated_at >= datetime('now', ?)
           AND updated_at < datetime('now', ?)
         GROUP BY agent_name`,
      )
      .all(`-${recent + baseline} days`, `-${recent} days`) as Array<{
        agent_name: string;
        mean: number;
        task_count: number;
      }>;

    const baselineMap = new Map(baselineRows.map((r) => [r.agent_name, r]));

    const alerts: CalibrationDriftAlert[] = [];
    for (const r of recentRows) {
      const b = baselineMap.get(r.agent_name);
      if (!b) continue; // no baseline data — skip

      const drift = r.mean - b.mean;
      alerts.push({
        agent_name: r.agent_name,
        baseline_mean: b.mean,
        baseline_task_count: b.task_count,
        recent_mean: r.mean,
        recent_task_count: r.task_count,
        drift,
        alerted: Math.abs(drift) > 0.1,
      });
    }

    // Sort by |drift| descending so the most significant appear first
    return alerts.sort((a, b) => Math.abs(b.drift) - Math.abs(a.drift));
  }

  /**
   * Return day-by-day dispatch efficiency for the past `days` calendar days.
   *
   * "Efficiency" is defined as `done / (done + failed)` over terminal tasks.
   * Days with no terminal activity get `efficiency_rate = null`.
   *
   * The query generates all dates in the window via a recursive CTE so that
   * days with no work still appear in the series (filled with zeros).
   */
  getEfficiencyTrend(
    days = 7,
    warningThreshold = 0.75,
    criticalThreshold = 0.50,
  ): EfficiencyTrend {
    const lookbackDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7;
    const offsetArg = `-${lookbackDays - 1} days`;
    const dateCte = `
      WITH RECURSIVE dates(d) AS (
        SELECT DATE('now', ?)
        UNION ALL
        SELECT DATE(d, '+1 day') FROM dates WHERE d < DATE('now')
      )
    `;

    const systemRows = this.db
      .prepare(
        `${dateCte}
         SELECT
           d.d                                          AS date,
           COALESCE(t.done, 0)                          AS done,
           COALESCE(t.failed, 0)                        AS failed,
           COALESCE(t.done, 0) + COALESCE(t.failed, 0) AS total
         FROM dates d
         LEFT JOIN (
           SELECT
             DATE(updated_at) AS day,
             SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END) AS done,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
           FROM tasks
           WHERE status IN ('done', 'failed')
             AND DATE(updated_at) >= DATE('now', ?)
           GROUP BY DATE(updated_at)
         ) t ON t.day = d.d
         ORDER BY d.d ASC`,
      )
      .all(offsetArg, offsetArg) as Array<{
        date: string;
        done: number;
        failed: number;
        total: number;
      }>;

    const systemPoints: EfficiencyTrendPoint[] = systemRows.map((r) => ({
      date: r.date,
      done: r.done,
      failed: r.failed,
      total: r.total,
      efficiency_rate: r.total > 0 ? r.done / r.total : null,
    }));

    const activeAgents = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(agent_name, 'unassigned') AS agent_name
         FROM tasks
         WHERE status IN ('done', 'failed')
           AND DATE(updated_at) >= DATE('now', ?)
         ORDER BY agent_name ASC`,
      )
      .all(offsetArg) as Array<{ agent_name: string }>;

    const perAgent: EfficiencyTrendSeries[] = activeAgents.map(({ agent_name }) => {
      const agentRows = this.db
        .prepare(
          `${dateCte}
           SELECT
             d.d                                          AS date,
             COALESCE(t.done, 0)                          AS done,
             COALESCE(t.failed, 0)                        AS failed,
             COALESCE(t.done, 0) + COALESCE(t.failed, 0) AS total
           FROM dates d
           LEFT JOIN (
             SELECT
               DATE(updated_at) AS day,
               SUM(CASE WHEN status = 'done'   THEN 1 ELSE 0 END) AS done,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
             FROM tasks
             WHERE status IN ('done', 'failed')
               AND COALESCE(agent_name, 'unassigned') = ?
               AND DATE(updated_at) >= DATE('now', ?)
             GROUP BY DATE(updated_at)
           ) t ON t.day = d.d
           ORDER BY d.d ASC`,
        )
        .all(offsetArg, agent_name, offsetArg) as Array<{
          date: string;
          done: number;
          failed: number;
          total: number;
        }>;

      return {
        agent_name,
        days: agentRows.map((r) => ({
          date: r.date,
          done: r.done,
          failed: r.failed,
          total: r.total,
          efficiency_rate: r.total > 0 ? r.done / r.total : null,
        })),
      };
    });

    return {
      days: lookbackDays,
      warning_threshold: warningThreshold,
      critical_threshold: criticalThreshold,
      system: systemPoints,
      per_agent: perAgent,
    };
  }

  // ── Agent health (reads from orchestrator's agent_health table) ───────────

  getAgentHealthBatch(agentNames: string[]): AgentHealth[] {
    if (agentNames.length === 0) return [];
    try {
      const placeholders = agentNames.map(() => "?").join(", ");
      return this.db
        .prepare(
          `SELECT agent_name, consecutive_failures, last_error_at, last_error_message, last_success_at, updated_at
           FROM agent_health
           WHERE agent_name IN (${placeholders})`,
        )
        .all(...agentNames) as AgentHealth[];
    } catch {
      // Table may not exist if orchestrator hasn't created it yet — graceful fallback
      return [];
    }
  }

  // ── Supervisor memory ─────────────────────────────────────────────────────

  getRecentSupervisorDecisions(limit: number): SupervisorDecisionRecord[] {
    return this.queryDecisions("routing_decisions", { limit });
  }

  querySupervisorDecisions(opts: SupervisorDecisionQuery): SupervisorDecisionRecord[] {
    return this.queryDecisions("routing_decisions", opts);
  }

  private queryDecisions(
    tableName: "routing_decisions" | "supervisor_decisions",
    opts: SupervisorDecisionQuery,
  ): SupervisorDecisionRecord[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts.action) {
      conditions.push("action = @action");
      params.action = opts.action;
    }
    if (opts.agentName) {
      conditions.push("agent_name = @agentName");
      params.agentName = opts.agentName;
    }
    if (opts.outcome) {
      conditions.push("outcome = @outcome");
      params.outcome = opts.outcome;
    }
    if (opts.since) {
      conditions.push("created_at > @since");
      params.since = opts.since;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 20, 100);

    try {
      return this.db
        .prepare(`SELECT * FROM ${tableName} ${where} ORDER BY created_at DESC LIMIT ${limit}`)
        .all(params) as SupervisorDecisionRecord[];
    } catch {
      if (tableName === "supervisor_decisions") {
        return [];
      }
      return this.queryDecisions("supervisor_decisions", opts);
    }
  }

  pruneOldSupervisorDecisions(daysOld: number = 7): number {
    const statements = [
      "DELETE FROM routing_decisions WHERE created_at < datetime('now', ?)",
      "DELETE FROM supervisor_decisions WHERE created_at < datetime('now', ?)",
    ];

    let total = 0;
    for (const statement of statements) {
      try {
        const result = this.db.prepare(statement).run(`-${daysOld} days`);
        total += result.changes;
      } catch {
        // Ignore missing legacy tables on older databases.
      }
    }
    return total;
  }

  recordSupervisorDecision(
    action: string,
    reason: string,
    opts: {
      agentName?: string;
      taskId?: string;
      outcome?: string;
      message?: string;
      issueRef?: string;
      /** JSON-encoded DispatchRationale (e.g. '{"borrow":true,...}'). */
      rationale?: string;
    } = {},
  ): void {
    const params = [
      ulid(),
      action,
      opts.agentName ?? null,
      opts.taskId ?? null,
      reason,
      opts.outcome ?? "pending",
      opts.message ?? null,
      opts.issueRef ?? null,
      opts.rationale ?? null,
    ] as const;

    const insert = this.db.prepare(
      `INSERT INTO supervisor_decisions
         (id, action, agent_name, task_id, reason, outcome, message, issue_ref, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const routingInsert = this.db.prepare(
      `INSERT INTO routing_decisions
         (id, action, agent_name, task_id, reason, outcome, message, issue_ref, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const tx = this.db.transaction(() => {
      insert.run(...params);
      routingInsert.run(...params);
    });

    try {
      tx();
    } catch {
      // Fall back to the legacy table if the routing table is unavailable.
      insert.run(...params);
    }
  }

  // ── PR merge queue ────────────────────────────────────────────────────────

  queuePRForMerge(repo: string, prNumber: number, branch: string): MergeQueueEntry {
    const existing = this.getMergeQueue(repo);
    const position = existing.length;
    this.db
      .prepare(
        "INSERT OR IGNORE INTO merge_queue (repo, pr_number, branch, status, position) VALUES (?, ?, ?, 'queued', ?)",
      )
      .run(repo, prNumber, branch, position);
    return { repo, pr_number: prNumber, branch, status: "queued", position, created_at: new Date().toISOString() };
  }

  getMergeQueue(repo?: string): MergeQueueEntry[] {
    if (repo) {
      return this.db
        .prepare("SELECT * FROM merge_queue WHERE repo = ? ORDER BY position ASC")
        .all(repo) as MergeQueueEntry[];
    }
    return this.db
      .prepare("SELECT * FROM merge_queue ORDER BY repo, position ASC")
      .all() as MergeQueueEntry[];
  }

  isPRInMergeQueue(repo: string, prNumber: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM merge_queue WHERE repo = ? AND pr_number = ? AND status IN ('queued', 'merging')")
      .get(repo, prNumber);
    return row !== undefined;
  }

  markQueuedPRMerging(repo: string, prNumber: number): void {
    this.db
      .prepare("UPDATE merge_queue SET status = 'merging' WHERE repo = ? AND pr_number = ?")
      .run(repo, prNumber);
  }

  markQueuedPRMerged(repo: string, prNumber: number): void {
    this.db
      .prepare("DELETE FROM merge_queue WHERE repo = ? AND pr_number = ?")
      .run(repo, prNumber);
  }

  markQueuedPRFailed(repo: string, prNumber: number, error: string): void {
    this.db
      .prepare("UPDATE merge_queue SET status = 'failed', error = ? WHERE repo = ? AND pr_number = ?")
      .run(error, repo, prNumber);
  }

  removeFromMergeQueue(repo: string, prNumber: number): void {
    this.db
      .prepare("DELETE FROM merge_queue WHERE repo = ? AND pr_number = ?")
      .run(repo, prNumber);
  }

  // ── PR review history ─────────────────────────────────────────────────────

  recordPRReview(repo: string, prNumber: number, decision: string, confidence?: number | null): void {
    this.db
      .prepare(
        "INSERT INTO pr_reviews (id, repo, pr_number, decision, confidence) VALUES (?, ?, ?, ?, ?)",
      )
      .run(ulid(), repo, prNumber, decision, confidence ?? null);
  }

  /**
   * Persist extended PR review metadata for iteration tracking.
   *
   * Stores review_number (auto-computed from existing rows), agent_name, and
   * review_categories alongside the standard review fields.  Also inserts the
   * standard `recordPRReview` data so callers can call this method alone.
   */
  recordPRReviewDetails(
    repo: string,
    prNumber: number,
    decision: string,
    opts?: {
      confidence?: number | null;
      agentName?: string | null;
      reviewCategories?: ReviewCategory[];
    },
  ): void {
    // Auto-compute review_number as count of existing reviews + 1
    const existing = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM pr_reviews WHERE repo = ? AND pr_number = ?")
      .get(repo, prNumber) as { cnt: number };
    const reviewNumber = (existing?.cnt ?? 0) + 1;

    const categories = opts?.reviewCategories?.length
      ? JSON.stringify(opts.reviewCategories)
      : null;

    this.db
      .prepare(
        `INSERT INTO pr_reviews
           (id, repo, pr_number, decision, confidence, review_number, agent_name, review_categories)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        repo,
        prNumber,
        decision,
        opts?.confidence ?? null,
        reviewNumber,
        opts?.agentName ?? null,
        categories,
      );
  }

  /**
   * Return a PR iteration report for the given look-back window.
   *
   * Aggregates:
   * - multi_round_prs: PRs with > 1 review round
   * - agent_stats:     per-agent avg / max iteration counts
   * - top_categories:  most frequent review feedback categories
   */
  getPRIterationReport(days: number = 30): PRIterationReport {
    const lookback = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 30;
    const since = `-${lookback} days`;

    // 1. Per-PR aggregates (only rows that have review_number populated)
    const prRows = this.db
      .prepare(
        `SELECT
           repo,
           pr_number,
           MAX(agent_name)    AS agent_name,
           COUNT(*)           AS review_count,
           MAX(decision)      AS final_decision,
           MIN(created_at)    AS first_review_at,
           MAX(created_at)    AS last_review_at
         FROM pr_reviews
         WHERE created_at >= datetime('now', ?)
         GROUP BY repo, pr_number
         HAVING COUNT(*) > 1
         ORDER BY review_count DESC`,
      )
      .all(since) as PRIterationStat[];

    // 2. Per-agent aggregates (only rows that have agent_name populated)
    const agentRows = this.db
      .prepare(
        `SELECT
           agent_name,
           COUNT(DISTINCT repo || '#' || pr_number) AS total_prs,
           SUM(CASE WHEN review_count > 1 THEN 1 ELSE 0 END) AS multi_round_prs,
           AVG(review_count) AS avg_rounds,
           MAX(review_count) AS max_rounds
         FROM (
           SELECT
             agent_name,
             repo,
             pr_number,
             COUNT(*) AS review_count
           FROM pr_reviews
           WHERE created_at >= datetime('now', ?)
             AND agent_name IS NOT NULL
           GROUP BY agent_name, repo, pr_number
         )
         GROUP BY agent_name
         ORDER BY avg_rounds DESC`,
      )
      .all(since) as AgentIterationStat[];

    // 3. Review category frequency (unpack JSON arrays)
    // SQLite doesn't have native JSON_EACH support in all builds, so we pull
    // raw rows and aggregate in TypeScript.
    const categoryRows = this.db
      .prepare(
        `SELECT review_categories
         FROM pr_reviews
         WHERE created_at >= datetime('now', ?)
           AND review_categories IS NOT NULL`,
      )
      .all(since) as Array<{ review_categories: string }>;

    const categoryCounts: Record<string, number> = {};
    for (const row of categoryRows) {
      try {
        const cats: string[] = JSON.parse(row.review_categories);
        for (const cat of cats) {
          categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
        }
      } catch {
        // Malformed JSON — skip
      }
    }

    const topCategories: ReviewCategoryCount[] = Object.entries(categoryCounts)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    return {
      generated_at: new Date().toISOString(),
      window_days: lookback,
      multi_round_prs: prRows,
      agent_stats: agentRows,
      top_categories: topCategories,
    };
  }

  /**
   * Return the most recent PR review records, ordered newest first.
   * Used by the supervisor to surface recent confidence scores in its context.
   */
  getRecentPRReviewConfidences(limit: number = 10): PRConfidenceRecord[] {
    return this.db
      .prepare(
        `SELECT repo, pr_number, decision, confidence, created_at
           FROM pr_reviews
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(limit) as PRConfidenceRecord[];
  }

  // ── LLM token instrumentation ─────────────────────────────────────────────

  /**
   * Persist one per-call token usage record to `llm_call_events`.
   *
   * Called by every reviewer subsystem (pr-reviewer, verifier, supervisor,
   * improvement-detector) immediately after a successful Anthropic SDK call.
   * Errors are swallowed — instrumentation must never interrupt the main flow.
   */
  recordLlmCallEvent(event: LlmCallEvent): void {
    try {
      this.db
        .prepare(
          `INSERT INTO llm_call_events
             (call_type, model, input_tokens, output_tokens, cache_read_tokens,
              cache_write_tokens, duration_ms, task_id, pr_number)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.call_type,
          event.model,
          event.input_tokens,
          event.output_tokens,
          event.cache_read_tokens ?? 0,
          event.cache_write_tokens ?? 0,
          event.duration_ms ?? null,
          event.task_id ?? null,
          event.pr_number ?? null,
        );
    } catch {
      // Instrumentation failures must never surface to callers.
    }
  }

  /**
   * Return aggregate per-call-type token usage over the given look-back window.
   *
   * @param sinceHours - Look-back window in hours (default: 720 = 30 days).
   */
  getTokenStats(sinceHours = 720): LlmTokenStats[] {
    const lookback = Number.isFinite(sinceHours) && sinceHours >= 1 ? Math.round(sinceHours) : 720;
    return this.db
      .prepare(
        `SELECT
           call_type,
           COUNT(*)                        AS call_count,
           SUM(input_tokens)               AS total_input_tokens,
           SUM(output_tokens)              AS total_output_tokens,
           SUM(cache_read_tokens)          AS total_cache_read_tokens,
           SUM(cache_write_tokens)         AS total_cache_write_tokens,
           AVG(duration_ms)               AS avg_duration_ms
         FROM llm_call_events
         WHERE created_at >= datetime('now', ?)
         GROUP BY call_type
         ORDER BY total_input_tokens DESC`,
      )
      .all(`-${lookback} hours`) as LlmTokenStats[];
  }

  // ── Score calibration ─────────────────────────────────────────────────────

  /**
   * Record the eventual PR outcome for a previously verified task.
   *
   * Called by the daemon when a PR is merged, receives change-requests,
   * is closed without merge, or its task is re-dispatched for revision.
   * The outcome record links the task's quality_score to the actual PR result
   * so the calibration model can quantify each verifier's accuracy.
   */
  recordPROutcome(record: Omit<PROutcomeRecord, "id" | "recorded_at">): void {
    // score_bucket = floor(quality_score * 10) / 10, clamped to [0.0, 0.9]
    const bucket = Math.min(0.9, Math.floor(record.quality_score * 10) / 10);
    this.db
      .prepare(
        `INSERT INTO pr_outcome_records
           (id, task_id, agent_name, task_type, quality_score, score_bucket, repo, pr_number, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        record.task_id,
        record.agent_name,
        record.task_type,
        record.quality_score,
        bucket,
        record.repo,
        record.pr_number,
        record.outcome,
      );
  }

  /**
   * Return the full calibration table: per-`(agent, task_type, score_bucket)` cell,
   * the actual PR merge rate derived from recorded outcome events.
   *
   * Only cells with at least 3 outcome records are returned to avoid noise
   * from very small samples.
   *
   * Example row:
   *   agent_name=claude-reviewer  task_type=implementation  score_bucket=0.7
   *   total_count=12  merge_count=10  actual_merge_rate=0.833
   */
  getCalibrationData(): ScoreCalibrationRow[] {
    return this.db
      .prepare(
        `SELECT
           agent_name,
           task_type,
           score_bucket,
           COUNT(*) AS total_count,
           SUM(CASE WHEN outcome = 'merged' THEN 1 ELSE 0 END) AS merge_count,
           CAST(SUM(CASE WHEN outcome = 'merged' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) AS actual_merge_rate
         FROM pr_outcome_records
         GROUP BY agent_name, task_type, score_bucket
         HAVING COUNT(*) >= 3
         ORDER BY agent_name, task_type, score_bucket ASC`,
      )
      .all() as ScoreCalibrationRow[];
  }

  /**
   * Derive per-`(agent, task_type)` recommended minimum verification scores
   * from the calibration table.
   *
   * For each `(agent, task_type)` pair the recommended threshold is the
   * lowest score_bucket where `actual_merge_rate >= targetMergeRate`.
   * If no bucket meets the target, `recommended_min_score` is null (insufficient data
   * or the verifier's scores never correlate well with merge success).
   *
   * @param targetMergeRate  - Desired PR merge rate (default: 0.80).
   * @param currentMinScore  - Baseline min_score to compare against (default: 0.70).
   */
  getAdjustedThresholds(targetMergeRate = 0.80, currentMinScore = 0.70): AdjustedThreshold[] {
    const rows = this.getCalibrationData();

    // Group by (agent, task_type)
    type Key = string;
    const cells = new Map<Key, ScoreCalibrationRow[]>();
    for (const row of rows) {
      const key: Key = `${row.agent_name}|${row.task_type}`;
      const list = cells.get(key) ?? [];
      list.push(row);
      cells.set(key, list);
    }

    const thresholds: AdjustedThreshold[] = [];
    for (const [key, rowGroup] of cells) {
      const [agentName, taskType] = key.split("|") as [string, string];
      const totalSamples = rowGroup.reduce((s, r) => s + r.total_count, 0);

      // Find the lowest bucket where actual_merge_rate >= target, scanning ascending
      const sorted = [...rowGroup].sort((a, b) => a.score_bucket - b.score_bucket);
      let recommended: number | null = null;
      for (const row of sorted) {
        if (row.actual_merge_rate >= targetMergeRate) {
          recommended = row.score_bucket;
          break;
        }
      }

      const actionRequired =
        recommended !== null &&
        totalSamples >= 5 &&
        Math.abs(recommended - currentMinScore) > 0.05;

      thresholds.push({
        agent_name: agentName,
        task_type: taskType as "implementation" | "research",
        current_min_score: currentMinScore,
        recommended_min_score: recommended,
        sample_count: totalSamples,
        action_required: actionRequired,
      });
    }

    return thresholds.sort((a, b) =>
      a.agent_name.localeCompare(b.agent_name) ||
      a.task_type.localeCompare(b.task_type),
    );
  }

  // ── System flags (pause / resume / operator overrides) ───────────────────

  getSystemFlag(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM system_flags WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSystemFlag(key: string, value: string): void {
    this.db
      .prepare(`
        INSERT INTO system_flags (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value);
  }

  // ── Dispatch requests ─────────────────────────────────────────────────────

  createDispatchRequest(agentName: string, message: string): DispatchRequest {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO dispatch_requests (id, agent_name, message, status) VALUES (?, ?, ?, 'pending')",
      )
      .run(id, agentName, message);
    return {
      id,
      agent_name: agentName,
      message,
      status: "pending",
      created_at: new Date().toISOString(),
    };
  }

  getPendingDispatchRequests(): DispatchRequest[] {
    return this.db
      .prepare("SELECT * FROM dispatch_requests WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as DispatchRequest[];
  }

  // ── Task prioritization ───────────────────────────────────────────────────

  prioritizeTask(titleOrId: string): boolean {
    // Try exact id prefix match first, then title substring
    const byId = this.db
      .prepare("UPDATE tasks SET priority = 100, updated_at = datetime('now') WHERE id LIKE ?")
      .run(`${titleOrId}%`);
    if (byId.changes > 0) return true;
    const byTitle = this.db
      .prepare("UPDATE tasks SET priority = 100, updated_at = datetime('now') WHERE title LIKE ?")
      .run(`%${titleOrId}%`);
    return byTitle.changes > 0;
  }

  // ── Quality SLA Thresholds ────────────────────────────────────────────────

  getSLAThresholds(): AgentSLAThreshold[] {
    const json = this.getSystemFlag("quality_sla_thresholds");
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  setSLAThreshold(agentName: string, minAvgScore: number, windowTasks: number): void {
    const thresholds = this.getSLAThresholds();
    // Remove any existing threshold for this agent, then add the new one
    const filtered = thresholds.filter((t) => t.agent_name !== agentName);
    const updated = [...filtered, { agent_name: agentName, min_avg_score: minAvgScore, window_tasks: windowTasks }];
    this.setSystemFlag("quality_sla_thresholds", JSON.stringify(updated));
  }

  /**
   * Get recent verified quality scores for an agent (for SLA breach detection).
   * Internal helper — not exposed on ITelegramStateStore interface.
   */
  private getRecentAgentQualityScores(agentName: string, limit: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT quality_score FROM tasks
         WHERE agent_name = ? AND quality_score IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(agentName, limit) as { quality_score: number }[];
    // Return newest-first (from query) but we may want reverse for avg calculation
    return rows.map((r) => r.quality_score);
  }

  /**
   * Check if an agent's rolling average quality score is below its SLA threshold.
   * Returns true if breached, false if healthy or no threshold configured.
   * Internal helper — not exposed on interface.
   */
  private checkAgentSLABreach(threshold: AgentSLAThreshold): boolean {
    const scores = this.getRecentAgentQualityScores(threshold.agent_name, threshold.window_tasks);
    if (scores.length === 0) return false; // No data, no breach
    const avg = scores.reduce((sum, s) => sum + s, 0) / scores.length;
    return avg < threshold.min_avg_score;
  }

  /**
   * Get all agents currently in SLA breach (below their configured threshold).
   * Used by supervisor and Telegram commands for alerting/context.
   * Internal helper — not exposed on interface.
   */
  getAgentSLABreaches(): Array<{ agent_name: string; avg_score: number; threshold_min: number }> {
    const thresholds = this.getSLAThresholds();
    return thresholds
      .filter((t) => this.checkAgentSLABreach(t))
      .map((t) => {
        const scores = this.getRecentAgentQualityScores(t.agent_name, t.window_tasks);
        const avg = scores.length > 0 ? scores.reduce((sum, s) => sum + s, 0) / scores.length : 0;
        return { agent_name: t.agent_name, avg_score: avg, threshold_min: t.min_avg_score };
      });
  }
}
