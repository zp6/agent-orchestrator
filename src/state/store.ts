import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { ulid } from "ulid";

export type TaskStatus = "pending" | "planning" | "dispatched" | "in_progress" | "done" | "failed";
export type TaskSource = "github" | "linear" | "slack" | "manual";
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

  updateTask(id: string, updates: Partial<Pick<Task, "status" | "agent_name" | "conversation_id" | "result" | "plan" | "verification_status" | "quality_score" | "verification_notes">>): Task | undefined {
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

  getUnverified(limit = 10): Task[] {
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'done' AND verification_status IS NULL AND parent_task_id IS NULL ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Task[];
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

    return {
      total_tasks: global.total_tasks,
      done_tasks: global.done_tasks,
      failed_tasks: global.failed_tasks,
      avg_task_duration_ms: global.avg_task_duration_ms,
      verification_pass_rate: verify.verification_pass_rate,
      avg_quality_score: verify.avg_quality_score,
      per_agent,
      cycles: {
        total_cycles: cycleRow.total_cycles,
        avg_duration_ms: cycleRow.avg_duration_ms,
        last_cycle_at: cycleRow.last_cycle_at,
      },
    };
  }

  close(): void {
    this.db.close();
  }
}
