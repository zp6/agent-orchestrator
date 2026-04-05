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
  SupervisorDecisionRecord,
  SupervisorDecisionQuery,
  DispatchRequest,
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

    // Create index for efficient time-ordered lookups (idempotent)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_created_at
        ON supervisor_decisions (created_at DESC);
    `);
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

  // ── Supervisor memory ─────────────────────────────────────────────────────

  getRecentSupervisorDecisions(limit: number): SupervisorDecisionRecord[] {
    return this.db
      .prepare("SELECT * FROM supervisor_decisions ORDER BY created_at DESC LIMIT ?")
      .all(limit) as SupervisorDecisionRecord[];
  }

  querySupervisorDecisions(opts: SupervisorDecisionQuery): SupervisorDecisionRecord[] {
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
    if (opts.since) {
      conditions.push("created_at > @since");
      params.since = opts.since;
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(opts.limit ?? 20, 100);

    return this.db
      .prepare(`SELECT * FROM supervisor_decisions ${where} ORDER BY created_at DESC LIMIT ${limit}`)
      .all(params) as SupervisorDecisionRecord[];
  }

  pruneOldSupervisorDecisions(daysOld: number = 7): number {
    const result = this.db
      .prepare("DELETE FROM supervisor_decisions WHERE created_at < datetime('now', ?)")
      .run(`-${daysOld} days`);
    return result.changes;
  }

  recordSupervisorDecision(
    action: string,
    reason: string,
    opts: { agentName?: string; taskId?: string; outcome?: string; message?: string; issueRef?: string } = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO supervisor_decisions
           (id, action, agent_name, task_id, reason, outcome, message, issue_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ulid(),
        action,
        opts.agentName ?? null,
        opts.taskId ?? null,
        reason,
        opts.outcome ?? "pending",
        opts.message ?? null,
        opts.issueRef ?? null,
      );
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

  recordPRReview(repo: string, prNumber: number, decision: string): void {
    this.db
      .prepare("INSERT INTO pr_reviews (id, repo, pr_number, decision) VALUES (?, ?, ?, ?)")
      .run(ulid(), repo, prNumber, decision);
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
}
