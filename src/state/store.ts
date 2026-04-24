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
  AgentQualityHealthRow,
  QualityHealthReport,
  AgentSLAThreshold,
  LlmCallEvent,
  LlmTokenStats,
  PROutcomeRecord,
  ScoreCalibrationRow,
  AdjustedThreshold,
  QualityAnomaly,
  QualityAnomalyQuery,
  ReviewCategory,
  PRIterationReport,
  PRIterationStat,
  AgentIterationStat,
  ReviewCategoryCount,
  PRIterationTrend,
  PRIterationTrendPoint,
  AgentCoachingDirective,
  StandupSynthesisLabel,
  StandupHealthPoint,
  StandupHealthSummary,
  VerificationResultRecord,
  VerificationStats,
  QualityAnomalyType,
  IQualityAnomalyStore,
  SecretMountStatus,
  SecretHealthEntry,
  SecretsHealthCheckRecord,
  AgentSecretsHealthSummary,
  SecretsFleetHealthSummary,
  QualityAnomalySummary,
  ScoreCoverageMetric,
  ReconciliationStatus,
  ReconciliationEventRecord,
  ReconciliationLastPerRepo,
  TaskType,
  VerifierThreshold,
  VerifierAlertState,
  IThresholdAdjustmentStore,
  RoutingViolation,
  ILowScoreFeedStore,
  IScoreViolationsStore,
  IBypassAuditStore,
  ISemanticMemoryStore,
  MemoryEntry,
  TopQueriedTopic,
  RepeatedAttemptTopic,
  LowConfidenceTopic,
  IMeetingFacilitatorGoalStore,
  MeetingFacilitatorGoalWidget,
  MeetingFacilitatorGoalItem,
  IImprovementBatchDeduplicationStore,
  ImprovementAnalysisRun,
  IPatternRiskStore,
  PatternRiskSignal,
  AgentPatternRiskSummary,
} from "./types.js";
import { ulid } from "../util/ulid.js";

/**
 * Hard score floor for task approval (issue #266).
 *
 * No task with quality_score < APPROVAL_SCORE_FLOOR can reach
 * verification_status = 'approved'.  Enforced at the persisting layer in
 * StateStore.updateTask() so ALL callers are covered regardless of code path.
 *
 * Exported as a module-level constant so callers and tests can reference it
 * without magic numbers and without importing the full StateStore class.
 */
export const APPROVAL_SCORE_FLOOR = 0.60;

export class StateStore implements ITelegramStateStore, IQualityAnomalyStore, IThresholdAdjustmentStore, ILowScoreFeedStore, IScoreViolationsStore, IBypassAuditStore, ISemanticMemoryStore, IMeetingFacilitatorGoalStore, IImprovementBatchDeduplicationStore, IPatternRiskStore {
  private db: Database.Database;

  constructor(dbPath: string = process.env.STATE_DB_PATH ?? "state.db") {
    this.db = new Database(dbPath);
    // Enable WAL mode for concurrent read performance.
    this.db.pragma("journal_mode = WAL");
    // Enable FK enforcement so child-before-parent INSERTs throw immediately
    // instead of silently succeeding and leaving orphaned rows (issue #366).
    // MUST be set before migrate() runs any INSERT statements.
    this.db.pragma("foreign_keys = ON");
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

    // Create PR outcome records table for score calibration (idempotent).
    // Parent-before-child INSERT order required: tasks row must exist before
    // inserting a pr_outcome_records row referencing the same task_id.
    // The FOREIGN KEY constraint enforces this on new databases; existing
    // databases are validated at startup via runStartupIntegrityCheck() (issue #366).
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
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks (id)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_outcome_records_agent_type_bucket
        ON pr_outcome_records (agent_name, task_type, score_bucket);

      CREATE INDEX IF NOT EXISTS idx_pr_outcome_records_recorded_at
        ON pr_outcome_records (recorded_at DESC);
    `);

    // Phase 2 calibration: persisted per-verifier thresholds (idempotent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verifier_thresholds (
        verifier_id    TEXT NOT NULL,
        task_type      TEXT NOT NULL,
        threshold      REAL NOT NULL,
        last_adjusted_at TEXT NOT NULL DEFAULT (datetime('now')),
        justification  TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (verifier_id, task_type)
      );
    `);

    // Phase 2 calibration: consecutive-bad-cycle alert state per bucket (idempotent)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verifier_alert_state (
        verifier_id            TEXT NOT NULL,
        task_type              TEXT NOT NULL,
        score_bucket           REAL NOT NULL,
        consecutive_bad_cycles INTEGER NOT NULL DEFAULT 0,
        last_checked_at        TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (verifier_id, task_type, score_bucket)
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
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN issue_priority REAL");
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

    // Standup synthesis health table (idempotent — issue #118).
    // Tracks synthesis confidence labels and action-item counts per standup.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS standup_synthesis_events (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        label TEXT NOT NULL,
        action_item_count INTEGER NOT NULL DEFAULT 0,
        recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_standup_synthesis_events_recorded_at
        ON standup_synthesis_events (recorded_at DESC);

      CREATE INDEX IF NOT EXISTS idx_standup_synthesis_events_label_recorded_at
        ON standup_synthesis_events (label, recorded_at DESC);
    `);

    // Verification results table (idempotent — issue #120).
    // Records every scoring decision for calibration drift and first-pass rate monitoring.
    // Parent-before-child INSERT order required: tasks row must exist before
    // inserting a verification_results row referencing the same task_id (issue #366).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS verification_results (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id          TEXT NOT NULL,
        score            REAL NOT NULL,
        first_pass       INTEGER NOT NULL,
        rejection_reason TEXT,
        threshold        REAL NOT NULL,
        agent_id         TEXT NOT NULL,
        timestamp        TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks (id)
      );

      CREATE INDEX IF NOT EXISTS idx_verification_results_agent_id_timestamp
        ON verification_results (agent_id, timestamp DESC);

      CREATE INDEX IF NOT EXISTS idx_verification_results_task_id
        ON verification_results (task_id);
    `);

    // Add blocked_reason column to verification_results (idempotent — issue #147).
    // Records 'hard_block_sub50' when the sub-0.50 hard-block guard fires.
    try {
      this.db.exec("ALTER TABLE verification_results ADD COLUMN blocked_reason TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add approval_rationale column to verification_results (idempotent — issue #148).
    // Records why a low-scoring task was approved so operators can audit approvals.
    try {
      this.db.exec("ALTER TABLE verification_results ADD COLUMN approval_rationale TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add cli_smoke_test_passed column to verification_results (idempotent — issue #277).
    // Records whether CLI smoke tests were run and passed for CLI-related tasks.
    // NULL = smoke tests were not applicable (non-CLI task).
    // 1    = smoke tests ran and all confirmed tests passed.
    // 0    = one or more smoke tests failed (score penalty applied).
    try {
      this.db.exec("ALTER TABLE verification_results ADD COLUMN cli_smoke_test_passed INTEGER");
    } catch {
      // Column already exists — ignore
    }

    // Routing violations table (idempotent — issue #293).
    // Records agent-to-repo routing violations for operator visibility.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_violations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id         TEXT NOT NULL,
        agent_name      TEXT NOT NULL,
        target_repo     TEXT NOT NULL,
        expected_agent  TEXT,
        task_title      TEXT,
        dispatched_at   TEXT NOT NULL,
        detected_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_routing_violations_detected_at
        ON routing_violations (detected_at DESC);

      CREATE INDEX IF NOT EXISTS idx_routing_violations_task_id
        ON routing_violations (task_id);
    `);

    // Secrets health checks table (idempotent — issue #125).
    // Records per-agent, per-secret mount status snapshots for fleet health monitoring.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS secrets_health_checks (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name  TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        status      TEXT NOT NULL,
        readable    INTEGER NOT NULL DEFAULT 0,
        non_empty   INTEGER NOT NULL DEFAULT 0,
        checked_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_secrets_health_checks_agent_checked_at
        ON secrets_health_checks (agent_name, checked_at DESC);

      CREATE INDEX IF NOT EXISTS idx_secrets_health_checks_checked_at
        ON secrets_health_checks (checked_at DESC);
    `);

    // Schema table access instrumentation (issue #99).
    // Records which StateStore call_types have touched which tables so the
    // schema-consumer registry can build a live consumer map without manual
    // maintenance of the static SCHEMA_CONSUMER_MAP.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_table_access (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name    TEXT NOT NULL,
        call_type     TEXT NOT NULL,
        access_count  INTEGER NOT NULL DEFAULT 1,
        last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(table_name, call_type)
      );

      CREATE INDEX IF NOT EXISTS idx_schema_table_access_table_name
        ON schema_table_access (table_name);

      CREATE INDEX IF NOT EXISTS idx_schema_table_access_last_seen_at
        ON schema_table_access (last_seen_at DESC);
    `);

    // Reconciliation events table (issue #214).
    // Mirrors the dashboard agent's reconciliation_events schema so the reviewer
    // can query the last run per repo for the /reconcile Telegram command.
    // If the table was already created by the dashboard, this is a no-op.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        status        TEXT NOT NULL DEFAULT 'success',
        repos_patched TEXT NOT NULL DEFAULT '[]',
        columns_fixed TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        triggered_by  TEXT,
        details       TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_reconciliation_events_created
        ON reconciliation_events(created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_reconciliation_events_status
        ON reconciliation_events(status);
    `);

    // Add bypass_reason column to tasks table (idempotent — issue #295).
    // Records why a sub-0.60 task was approved despite the quality floor.
    // Well-known values: 'operator_override', 'floor_not_enforced'.
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN bypass_reason TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add bypass_reason column to verification_results table (idempotent — issue #295).
    try {
      this.db.exec("ALTER TABLE verification_results ADD COLUMN bypass_reason TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Add fork_from column to tasks table (idempotent — issue #454).
    // Stores the JSON-serialised DispatchForkSpec when a task was dispatched
    // with a fork_from session spec. Null for fresh/resumed sessions.
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN fork_from TEXT");
    } catch {
      // Column already exists — ignore
    }

    // Semantic task memory table (idempotent — issue #369).
    // Stores knowledge entries indexed by normalised topic label.
    // Parent-before-child INSERT order required: tasks row must exist before
    // inserting a semantic_task_memory row referencing the same task_id (issue #366).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS semantic_task_memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        topic       TEXT NOT NULL,
        task_id     TEXT NOT NULL,
        confidence  REAL NOT NULL,
        outcome     TEXT NOT NULL DEFAULT 'partial',
        recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (topic, task_id),
        FOREIGN KEY (task_id) REFERENCES tasks (id)
      );

      CREATE INDEX IF NOT EXISTS idx_semantic_task_memory_topic
        ON semantic_task_memory (topic);

      CREATE INDEX IF NOT EXISTS idx_semantic_task_memory_recorded_at
        ON semantic_task_memory (recorded_at DESC);

      CREATE INDEX IF NOT EXISTS idx_semantic_task_memory_confidence
        ON semantic_task_memory (confidence);
    `);

    // FTS5 virtual table for full-text search on topic names (idempotent — issue #369).
    // content='semantic_task_memory' keeps the FTS index in sync with the base table
    // via the triggers below.
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS semantic_task_memory_fts
        USING fts5(
          topic,
          content='semantic_task_memory',
          content_rowid='id'
        );

      CREATE TRIGGER IF NOT EXISTS semantic_task_memory_ai
        AFTER INSERT ON semantic_task_memory BEGIN
          INSERT INTO semantic_task_memory_fts (rowid, topic)
            VALUES (new.id, new.topic);
        END;

      CREATE TRIGGER IF NOT EXISTS semantic_task_memory_au
        AFTER UPDATE ON semantic_task_memory BEGIN
          INSERT INTO semantic_task_memory_fts (semantic_task_memory_fts, rowid, topic)
            VALUES ('delete', old.id, old.topic);
          INSERT INTO semantic_task_memory_fts (rowid, topic)
            VALUES (new.id, new.topic);
        END;

      CREATE TRIGGER IF NOT EXISTS semantic_task_memory_ad
        AFTER DELETE ON semantic_task_memory BEGIN
          INSERT INTO semantic_task_memory_fts (semantic_task_memory_fts, rowid, topic)
            VALUES ('delete', old.id, old.topic);
        END;
    `);

    // PR guard cooldown table (idempotent — issue #390).
    // Prevents re-queuing after the PR existence guard fires by persisting a
    // per-(repo, issue_number) TTL entry.  Rows expire when expires_at < now.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pr_guard_cooldown (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        repo         TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        expires_at   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (repo, issue_number)
      );

      CREATE INDEX IF NOT EXISTS idx_pr_guard_cooldown_expires
        ON pr_guard_cooldown (expires_at);
    `);

    // Triage pre-submission validator call log (issue #413).
    // Records each call to POST /api/validate-triage-schema so that
    // getTriageHealthPayload() can compute the validator call rate vs.
    // tasks submitted.  agent_name is optional — agents may not always
    // pass identifying information in the request body.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triage_validator_calls (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name  TEXT,
        passed      INTEGER NOT NULL,
        score       REAL NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_triage_validator_calls_created_at
        ON triage_validator_calls (created_at DESC);
    `);

    // Improvement-detector batch deduplication log (issue #458).
    // Stores a SHA-256 content hash for each task-batch submitted to the
    // improvement detector.  Before running analysis, the detector checks
    // whether an identical (unskipped) run exists within the last 6 hours
    // and skips if so, preventing redundant LLM calls and duplicate issues.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS improvement_analysis_runs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_hash  TEXT    NOT NULL,
        task_count  INTEGER NOT NULL,
        skipped     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_improvement_analysis_runs_hash_created
        ON improvement_analysis_runs (batch_hash, created_at DESC);
    `);

    // Pattern risk signal table (issue #1149).
    // Written by the daemon on verification failure when a recurring risk pattern
    // is detected.  The reviewer's PatternRiskConsumer reads these signals and
    // surfaces them as additional context for the improvement detector.
    // The CREATE TABLE is idempotent; the daemon may have already created it
    // before the reviewer starts (shared state.db).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_risk (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT    NOT NULL,
        agent_id     TEXT    NOT NULL,
        pattern_type TEXT    NOT NULL,
        risk_score   REAL    NOT NULL,
        detail       TEXT    NOT NULL DEFAULT '',
        recorded_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_pattern_risk_agent_recorded
        ON pattern_risk (agent_id, recorded_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pattern_risk_recorded
        ON pattern_risk (recorded_at DESC);
    `);
  }

  // ── PR guard cooldown (issue #390) ───────────────────────────────────────

  /**
   * Write (or refresh) a cooldown entry for `(repo, issueNumber)`.
   *
   * If an entry already exists it is updated so the TTL resets from now.
   * The dispatcher must call `isPRGuardCooldownActive()` before queuing.
   *
   * @param repo         - Repository in "owner/repo" format
   * @param issueNumber  - GitHub issue number
   * @param ttlMinutes   - How long (in minutes) to suppress re-queuing (default 60)
   */
  setPRGuardCooldown(repo: string, issueNumber: number, ttlMinutes = 60): void {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_guard_cooldown (repo, issue_number, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (repo, issue_number)
         DO UPDATE SET expires_at = excluded.expires_at,
                       created_at = datetime('now')`,
      )
      .run(repo, issueNumber, expiresAt);
  }

  /**
   * Return true when an active (non-expired) cooldown exists for
   * `(repo, issueNumber)`.
   *
   * The dispatcher calls this before queuing a task for a GitHub issue. If
   * true, the issue should be skipped for the remainder of the cooldown window.
   *
   * @param repo         - Repository in "owner/repo" format
   * @param issueNumber  - GitHub issue number
   */
  isPRGuardCooldownActive(repo: string, issueNumber: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM pr_guard_cooldown
         WHERE repo = ? AND issue_number = ? AND expires_at > datetime('now')
         LIMIT 1`,
      )
      .get(repo, issueNumber);
    return row !== undefined;
  }

  /**
   * Return the ISO-8601 `expires_at` timestamp for the active PR guard cooldown
   * entry for `(repo, issueNumber)`, or `null` when no active entry exists.
   *
   * Used by `getCooldownCheckPayload()` to build the per-issue check endpoint
   * response (`GET /api/pr-guard-cooldown/check`), which the orchestrator calls
   * *before* dispatching — blocking redundant tasks at the source rather than
   * reactively inside the reviewer.
   *
   * @param repo         - Repository in "owner/repo" format
   * @param issueNumber  - GitHub issue number
   * @returns ISO-8601 expires_at string when active, null otherwise
   */
  getActivePRGuardCooldown(repo: string, issueNumber: number): string | null {
    const row = this.db
      .prepare(
        `SELECT expires_at FROM pr_guard_cooldown
         WHERE repo = ? AND issue_number = ? AND expires_at > datetime('now')
         LIMIT 1`,
      )
      .get(repo, issueNumber) as { expires_at: string } | undefined;
    return row?.expires_at ?? null;
  }

  /**
   * Delete expired cooldown rows.
   *
   * Call this periodically (e.g. alongside other prune tasks in the daemon
   * batch cycle) to keep the table small.
   *
   * @returns Number of rows deleted.
   */
  prunePRGuardCooldowns(): number {
    const result = this.db
      .prepare(`DELETE FROM pr_guard_cooldown WHERE expires_at <= datetime('now')`)
      .run();
    return result.changes;
  }

  /**
   * Return all currently active (non-expired) PR guard cooldowns.
   *
   * Allows the orchestrator dispatcher to pre-filter an entire dispatch batch
   * in one DB call instead of calling isPRGuardCooldownActive() per issue.
   *
   * @param repo  Optional "owner/repo" filter.  When omitted, all repos are returned.
   * @returns Array of active cooldown entries ordered by expires_at ascending.
   */
  listActivePRGuardCooldowns(repo?: string): Array<{ repo: string; issueNumber: number; expiresAt: string }> {
    // Build query dynamically based on whether repo filter is provided
    const rows = repo
      ? this.db.prepare(
          `SELECT repo, issue_number, expires_at
           FROM pr_guard_cooldown
           WHERE expires_at > datetime('now')
             AND repo = ?
           ORDER BY expires_at ASC`,
        ).all(repo) as Array<{ repo: string; issue_number: number; expires_at: string }>
      : this.db.prepare(
          `SELECT repo, issue_number, expires_at
           FROM pr_guard_cooldown
           WHERE expires_at > datetime('now')
           ORDER BY expires_at ASC`,
        ).all() as Array<{ repo: string; issue_number: number; expires_at: string }>;

    return rows.map((r) => ({
      repo: r.repo,
      issueNumber: r.issue_number,
      expiresAt: r.expires_at,
    }));
  }

  // ── Schema access instrumentation ────────────────────────────────────────

  /**
   * Record that a given `callType` has accessed `tableName`.
   *
   * Uses an UPSERT so repeated calls are cheap: only `access_count` and
   * `last_seen_at` are updated after the first insert.
   *
   * Call this at the top of any StateStore method that queries a specific table
   * to build a live call_type → table_name map for schema-consumer discovery.
   *
   * Example:
   *   this.recordTableAccess("tasks", "pr-review");
   *
   * @param tableName  SQLite table being accessed (e.g. "tasks", "pr_reviews")
   * @param callType   StateStore method category (e.g. "pr-review", "verification")
   */
  recordTableAccess(tableName: string, callType: string): void {
    this.db
      .prepare(
        `INSERT INTO schema_table_access (table_name, call_type, access_count, last_seen_at)
         VALUES (?, ?, 1, datetime('now'))
         ON CONFLICT(table_name, call_type) DO UPDATE SET
           access_count = access_count + 1,
           last_seen_at = datetime('now')`,
      )
      .run(tableName, callType);
  }

  /**
   * Return recent table-access records written by `recordTableAccess()`.
   *
   * Consumed by `SchemaConsumerRegistry.getAccessLog()` which is included in
   * the `GET /api/schema-consumers` response so operators can see which
   * StateStore methods touch which tables without reading source code.
   *
   * @param limit  Maximum rows to return (default: 500)
   */
  getTableAccessLog(limit = 500): Array<{
    table_name: string;
    call_type: string;
    access_count: number;
    last_seen_at: string;
  }> {
    return this.db
      .prepare(
        `SELECT table_name, call_type, access_count, last_seen_at
         FROM schema_table_access
         ORDER BY last_seen_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      table_name: string;
      call_type: string;
      access_count: number;
      last_seen_at: string;
    }>;
  }

  // ── Task operations ──────────────────────────────────────────────────────

  getTask(id: string): Task | null {
    this.recordTableAccess("tasks", "task-lookup");
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | undefined;
    return row ?? null;
  }

  /**
   * Default quality_score written when a caller sets verification_status to
   * 'approved' without providing an explicit score.  Chosen to be a
   * recognisable "marginal-pass" sentinel so analytics never see null, while
   * still being below the ideal 0.80 threshold — operators can identify
   * tasks that need score refinement via ensureScoresPopulated().
   *
   * Exported for tests and callers that need to distinguish a sentinel from a
   * real score.
   */
  static readonly NULL_SCORE_APPROVED_SENTINEL = 0.75;

  /**
   * Default quality_score written when a caller sets verification_status to
   * 'rejected' without providing an explicit score.  Chosen to sit at the
   * hard-block boundary (0.50) — clearly below the approval threshold and
   * distinguishable from real scores while remaining valid for analytics.
   */
  static readonly NULL_SCORE_REJECTED_SENTINEL = 0.50;

  updateTask(id: string, updates: Partial<Task>): void {
    // ── Score-approval invariant enforcement (issue #203, #258, #266, #272) ──
    // Defence-in-depth: prevent any caller from writing an approved task
    // with a quality_score below the acceptance floor (0.60).
    // This catches bugs, race conditions, and external callers that bypass
    // the verifier's own guards.  The floor covers two sub-ranges:
    //   < 0.50 (hard_block_sub50) — fundamentally incomplete work
    //   [0.50, 0.60) (low_score_sub60) — partial work still below acceptance bar
    //
    // Issue #272: downgrade to 'needs_operator_review' (not 'needs_revision')
    // so the task is held for explicit operator override rather than silently
    // re-dispatched. The operator must approve-with-override or reject via
    // /resolve in Telegram or the dashboard.
    const normalizedUpdates = { ...updates };
    if (
      normalizedUpdates.verification_status === "approved" &&
      normalizedUpdates.quality_score != null &&
      normalizedUpdates.quality_score < StateStore.SUB_THRESHOLD_REJECTION_LIMIT
    ) {
      const scoreStr = normalizedUpdates.quality_score.toFixed(2);
      normalizedUpdates.verification_status = "needs_operator_review";
      // Prepend a floor-downgrade note so operators can see the downgrade in
      // audit logs and the dashboard task list.
      const floorNote = `[operator-review-required: score ${scoreStr} < ${StateStore.SUB_THRESHOLD_REJECTION_LIMIT.toFixed(2)}]`;
      if (normalizedUpdates.verification_notes != null) {
        normalizedUpdates.verification_notes = `${floorNote} ${normalizedUpdates.verification_notes}`;
      } else {
        normalizedUpdates.verification_notes = floorNote;
      }
    }

    // Also handle the case where only quality_score is being updated:
    // if the new score is below the acceptance floor, check the current
    // verification_status in the DB and downgrade if currently approved.
    if (
      normalizedUpdates.verification_status === undefined &&
      normalizedUpdates.quality_score != null &&
      normalizedUpdates.quality_score < StateStore.SUB_THRESHOLD_REJECTION_LIMIT
    ) {
      const existing = this.db
        .prepare("SELECT verification_status, verification_notes FROM tasks WHERE id = ?")
        .get(id) as { verification_status: string | null; verification_notes: string | null } | undefined;
      if (existing?.verification_status === "approved") {
        const scoreStr = normalizedUpdates.quality_score.toFixed(2);
        normalizedUpdates.verification_status = "needs_operator_review";
        const floorNote = `[operator-review-required: score ${scoreStr} < ${StateStore.SUB_THRESHOLD_REJECTION_LIMIT.toFixed(2)}]`;
        normalizedUpdates.verification_notes = existing.verification_notes
          ? `${floorNote} ${existing.verification_notes}`
          : floorNote;
      }
    }

    // ── Null-score approved guard (issue #266, #272) ───────────────────────
    // If a caller sets verification_status to 'approved' but supplies no
    // quality_score AND the task currently has quality_score = NULL, we
    // cannot verify the floor is met — hold for operator review so the
    // task requires explicit approval rather than silently passing.
    if (
      normalizedUpdates.verification_status === "approved" &&
      normalizedUpdates.quality_score == null
    ) {
      const existing = this.db
        .prepare("SELECT quality_score FROM tasks WHERE id = ?")
        .get(id) as { quality_score: number | null } | undefined;
      if (existing?.quality_score == null) {
        normalizedUpdates.verification_status = "needs_operator_review";
        const floorNote = `[operator-review-required: null score cannot verify floor ${StateStore.SUB_THRESHOLD_REJECTION_LIMIT}]`;
        if (normalizedUpdates.verification_notes != null) {
          normalizedUpdates.verification_notes = `${floorNote} ${normalizedUpdates.verification_notes}`;
        } else {
          normalizedUpdates.verification_notes = floorNote;
        }
        console.warn(
          `[StateStore] updateTask(${id}): 'approved' with no quality_score and ` +
          `task has null score — holding for operator review. ` +
          `Run repairNullScoresForApprovedTasks() to LLM-infer real scores.`,
        );
      }
    }

    // ── Null-score guard (issue #244) ─────────────────────────────────────
    // Prevent creating verified tasks with null quality_score.
    //
    // If a caller sets verification_status to 'approved' or 'rejected' but
    // does NOT supply quality_score in the same call, AND the task currently
    // has quality_score = NULL, write a conservative default sentinel so that:
    //   (a) quality trend charts, calibration drift, and SLA checks always
    //       have a non-null value to aggregate over,
    //   (b) dashboard task lists show a score for every verified task,
    //   (c) the score-approval invariant above remains consistent.
    //
    // Callers that supply an explicit quality_score are unaffected.
    // The sentinel values (0.75 approved, 0.50 rejected) are exported as
    // StateStore.NULL_SCORE_APPROVED_SENTINEL / NULL_SCORE_REJECTED_SENTINEL
    // so tests can distinguish defaults from real verifier scores.
    //
    // Note: the 'approved' + null-score case is already handled above
    // (issue #266/#272 guard) and normalizedUpdates.verification_status will have
    // been changed to 'needs_operator_review' by this point, so the sentinel branch
    // for 'approved' below only fires when the task already has a score >= 0.60.
    //
    // ensureScoresPopulated() will NOT refine these defaults (they are no longer
    // null), but repairNullScoresForApprovedTasks() / the /backfill-scores
    // Telegram command can be run manually to LLM-infer actual scores.
    if (
      (normalizedUpdates.verification_status === "approved" ||
       normalizedUpdates.verification_status === "rejected") &&
      normalizedUpdates.quality_score == null
    ) {
      const existing = this.db
        .prepare("SELECT quality_score FROM tasks WHERE id = ?")
        .get(id) as { quality_score: number | null } | undefined;
      if (existing?.quality_score == null) {
        const sentinel =
          normalizedUpdates.verification_status === "approved"
            ? StateStore.NULL_SCORE_APPROVED_SENTINEL
            : StateStore.NULL_SCORE_REJECTED_SENTINEL;
        normalizedUpdates.quality_score = sentinel;
        console.warn(
          `[StateStore] updateTask(${id}): no quality_score supplied for ` +
          `verification_status='${normalizedUpdates.verification_status}' — ` +
          `writing default sentinel ${sentinel}. ` +
          `Run repairNullScoresForApprovedTasks() to LLM-infer real scores.`,
        );
      }
    }

    const fields = Object.keys(normalizedUpdates)
      .filter((k) => k !== "id")
      .map((k) => `${k} = @${k}`)
      .join(", ");
    if (!fields) return;
    this.db
      .prepare(`UPDATE tasks SET ${fields}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...normalizedUpdates, id });
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

  /**
   * Get approved tasks that have null quality_score (need backfill).
   * Used by the /backfill-scores command to retroactively score approved tasks.
   */
  getApprovedTasksWithNullScores(limit: number = 100): Task[] {
    return this.db
      .prepare(
        "SELECT * FROM tasks WHERE verification_status = 'approved' AND quality_score IS NULL ORDER BY updated_at DESC LIMIT ?",
      )
      .all(limit) as Task[];
  }

  /**
   * Get count of approved tasks with null quality_score.
   * Used to check if backfill is needed.
   */
  getApprovedTasksWithNullScoresCount(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE verification_status = 'approved' AND quality_score IS NULL",
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Return ALL verified tasks (approved OR rejected) whose quality_score is null.
   *
   * Approved tasks with null scores arise when the orchestrator marks a task
   * approved without running the verifier's LLM pass (e.g. via a direct DB
   * write or a fast-path approval).  Rejected tasks with null scores arise when
   * a rejection happens before a score can be computed (e.g. hard-block by
   * content filter before the scorer runs).
   *
   * Both categories are eligible for score inference via inferMissingScore()
   * so that quality_score is always non-null after a task has been verified.
   */
  getVerifiedTasksWithNullScores(limit: number = 100): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status IN ('approved', 'rejected')
           AND quality_score IS NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Task[];
  }

  /** Count of verified tasks (approved OR rejected) with null quality_score. */
  getVerifiedTasksWithNullScoresCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE verification_status IN ('approved', 'rejected')
           AND quality_score IS NULL`,
      )
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /**
   * Return 'done' tasks older than `graceMinutes` that still have null quality_score.
   *
   * Catches tasks that bypassed the normal verification flow entirely:
   *   - Short-circuit exits (already-in-review, zero-action standup)
   *   - Pre-dispatch guard blocks (issue closed, auth failure)
   *   - Orchestrator-routed tasks that completed without agent work
   *
   * These tasks are in terminal 'done' state but were never scored.
   * Phase 3 of ensureScoresPopulated() uses this to assign canonical scores.
   *
   * @param graceMinutes - Minimum task age in minutes (default 5).
   * @param limit - Maximum rows to return (default 50).
   */
  getDoneTasksWithNullScores(graceMinutes: number = 5, limit: number = 50): Task[] {
    const grace = Number.isFinite(graceMinutes) && graceMinutes >= 0 ? graceMinutes : 5;
    const maxRows = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50;
    // Include verification_status IS NULL (never touched) and 'pending' (verify()
    // started but failed before completing — the task is stuck with status='done'
    // and verification_status='pending' because the LLM call errored out).
    //
    // Uses created_at (not updated_at) for the grace period because updateTask()
    // refreshes updated_at on every call — a failed Phase 2 verify() attempt
    // would otherwise push the task outside the grace window indefinitely.
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'done'
           AND quality_score IS NULL
           AND (verification_status IS NULL OR verification_status = 'pending')
           AND created_at <= datetime('now', ? || ' minutes')
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(`-${grace}`, maxRows) as Task[];
  }

  /**
   * Return a score-coverage metric showing what fraction of 'done' tasks
   * have a non-null quality_score.
   *
   * Only considers tasks older than `graceMinutes` (default 5) so that
   * tasks still in the verification pipeline are excluded.
   *
   * Used by the dashboard quality panel to show a 'score coverage %' widget.
   */
  getScoreCoverageMetric(graceMinutes: number = 5): ScoreCoverageMetric {
    const grace = Number.isFinite(graceMinutes) && graceMinutes >= 0 ? graceMinutes : 5;

    type CoverageRow = {
      agent_name: string | null;
      total: number;
      scored: number;
    };

    const rows = this.db
      .prepare(
        `SELECT
           agent_name,
           COUNT(*) as total,
           COUNT(quality_score) as scored
         FROM tasks
         WHERE status = 'done'
           AND updated_at <= datetime('now', ? || ' minutes')
         GROUP BY agent_name
         ORDER BY agent_name ASC`,
      )
      .all(`-${grace}`) as CoverageRow[];

    let totalDone = 0;
    let totalScored = 0;
    const perAgent: NonNullable<ScoreCoverageMetric["per_agent"]> = [];

    for (const row of rows) {
      const agentName = row.agent_name ?? "(unassigned)";
      const unscored = row.total - row.scored;
      perAgent.push({
        agent_name: agentName,
        total: row.total,
        scored: row.scored,
        unscored,
        coverage_pct: row.total > 0 ? row.scored / row.total : null,
      });
      totalDone += row.total;
      totalScored += row.scored;
    }

    return {
      generated_at: new Date().toISOString(),
      total_done_tasks: totalDone,
      scored_tasks: totalScored,
      unscored_tasks: totalDone - totalScored,
      coverage_pct: totalDone > 0 ? totalScored / totalDone : null,
      per_agent: perAgent,
    };
  }

  getRecentVerifiedTasks(limit: number = 20): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status IN ('approved', 'rejected')
           AND quality_score IS NOT NULL
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as Task[];
  }

  /**
   * Return all in-flight tasks for a given source_ref (issue #336).
   *
   * "In-flight" = status ∈ { pending, planning, dispatched, in_progress }.
   * Used by CrossAgentInflightGuard to detect cross-agent dispatch conflicts.
   *
   * @param sourceRef - Exact match on source_ref column.
   */
  getInFlightTasksForIssue(sourceRef: string): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE source_ref = ?
           AND status IN ('pending', 'planning', 'dispatched', 'in_progress')
         ORDER BY created_at DESC`,
      )
      .all(sourceRef) as Task[];
  }

  /**
   * Count unique source_refs that have tasks from multiple distinct agents
   * within the given look-back window (issue #336).
   *
   * A non-zero result means multiple agents were or are working on the same
   * GitHub issue simultaneously — exactly the condition the cross-agent guard
   * prevents when firing prospectively.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   */
  getMultiAgentCollisionCount(windowHours: number = 48): number {
    const safeHours = Number.isFinite(windowHours) && windowHours > 0 ? Math.floor(windowHours) : 48;

    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT source_ref
           FROM tasks
           WHERE source_ref IS NOT NULL
             AND source_ref != ''
             AND updated_at >= datetime('now', ? || ' hours')
           GROUP BY source_ref
           HAVING COUNT(DISTINCT COALESCE(agent_name, '')) > 1
             AND COUNT(DISTINCT CASE WHEN agent_name IS NOT NULL THEN agent_name END) > 1
         )`,
      )
      .get(`-${safeHours}`) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
  }

  /**
   * Return approved tasks whose quality_score is non-null and strictly less
   * than `threshold`, ordered by quality_score ascending (lowest / riskiest
   * first), then by updated_at descending within each score tier.
   *
   * Issue #278: feeds the low-score approved dashboard panel and the
   * `/low-score` Telegram command so operators can audit marginal approvals.
   *
   * @param threshold - Score ceiling (exclusive). Default: 0.75.
   * @param limit     - Maximum rows to return. Default: 50.
   */
  getLowScoreApprovedTasks(threshold: number = 0.75, limit: number = 50): Task[] {
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 0.75;
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 50;

    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status = 'approved'
           AND quality_score IS NOT NULL
           AND quality_score < ?
         ORDER BY quality_score ASC, updated_at DESC
         LIMIT ?`,
      )
      .all(safeThreshold, safeLimit) as Task[];
  }

  /**
   * Return approved tasks below a quality threshold within a rolling time window.
   *
   * Issue #356: feeds the score-bypass violation report page, which lists all
   * tasks approved below min_score in a rolling window, grouped by agent.
   *
   * @param threshold - Score ceiling (exclusive). Default: 0.80.
   * @param days      - Lookback window in days. Default: 7.
   * @param limit     - Maximum rows to return. Default: 100.
   */
  getScoreViolationTasks(threshold: number = 0.80, days: number = 7, limit: number = 100): Task[] {
    const safeThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 0.80;
    const safeDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7;
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 100;

    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status = 'approved'
           AND quality_score IS NOT NULL
           AND quality_score < ?
           AND updated_at >= datetime('now', ? || ' days')
         ORDER BY quality_score ASC, updated_at DESC
         LIMIT ?`,
      )
      .all(safeThreshold, `-${safeDays}`, safeLimit) as Task[];
  }

  /**
   * Return all tasks approved below the hard quality floor (0.60) in the last
   * `days` days, ordered by quality_score ascending (worst first).
   *
   * Issue #398: feeds the `/api/bypass-audit` endpoint so operators can query
   * exactly which tasks bypassed the floor and why, without digging through logs.
   *
   * @param days  - Lookback window in days. Default: 7.
   * @param limit - Maximum rows to return. Default: 200.
   */
  getBypassAuditTasks(days: number = 7, limit: number = 200): Task[] {
    const safeDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7;
    const safeLimit = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 200;

    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status = 'approved'
           AND quality_score IS NOT NULL
           AND quality_score < 0.60
           AND updated_at >= datetime('now', ? || ' days')
         ORDER BY quality_score ASC, updated_at DESC
         LIMIT ?`,
      )
      .all(`-${safeDays}`, safeLimit) as Task[];
  }

  /**
   * Return done tasks with null quality_score that are older than minAgeMinutes.
   *
   * Issue #250: 'done' tasks that went through short-circuit paths (already-in-review,
   * pre-dispatch guard exits, orchestrator-routed tasks) may bypass the normal
   * verify path and end up with quality_score = null indefinitely. This method
   * feeds ensureScoresPopulated() and the short-circuit score recorder so those
   * gaps are closed.
   *
   * @param minAgeMinutes - Minimum task age in minutes. Default: 5.
   * @param limit         - Maximum rows to return. Default: 100.
   */
  getDoneTasksWithNullScoreOlderThan(minAgeMinutes: number = 5, limit: number = 100): Task[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE status = 'done'
           AND quality_score IS NULL
           AND updated_at <= datetime('now', ? || ' minutes')
         ORDER BY updated_at ASC
         LIMIT ?`,
      )
      .all(`-${minAgeMinutes}`, limit) as Task[];
  }

  /**
   * Compute the score coverage metric for the dashboard quality panel.
   *
   * Issue #250 acceptance criterion: dashboard shows 'score coverage %'.
   * A coverage_pct of 1.0 means every eligible done task has a quality_score.
   *
   * @param minAgeMinutes - Only count tasks older than this (default 5) to
   *                        exclude tasks still in the verify pipeline.
   */
  getScoreCoverage(minAgeMinutes: number = 5): import("./types.js").ScoreCoverageMetric {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_done,
           SUM(CASE WHEN quality_score IS NOT NULL THEN 1 ELSE 0 END) as scored_done,
           SUM(CASE WHEN quality_score IS NULL THEN 1 ELSE 0 END) as unscored_done
         FROM tasks
         WHERE status = 'done'
           AND updated_at <= datetime('now', ? || ' minutes')`,
      )
      .get(`-${minAgeMinutes}`) as {
        total_done: number;
        scored_done: number;
        unscored_done: number;
      } | undefined;

    const total_done = row?.total_done ?? 0;
    const scored_done = row?.scored_done ?? 0;
    const unscored_done = row?.unscored_done ?? 0;

    return {
      generated_at: new Date().toISOString(),
      min_age_minutes: minAgeMinutes,
      total_done,
      scored_done,
      unscored_done,
      coverage_pct: total_done > 0 ? scored_done / total_done : null,
    };
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
   * Return a live per-agent quality health snapshot over the most recent
   * `windowTasks` tasks for each agent.
   *
   * This powers the Telegram /quality command, which gives operators a quick
   * view of current scoring health without needing the dashboard.
   */
  getQualityHealthReport(
    windowTasks: number = 20,
    threshold: number = 0.75,
  ): QualityHealthReport {
    const lookbackTasks = Number.isFinite(windowTasks) && windowTasks >= 1 ? Math.floor(windowTasks) : 20;
    const qualityThreshold =
      Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : 0.75;

    type QualityTaskRow = {
      agent_name: string;
      quality_score: number | null;
    };

    const rows = this.db
      .prepare(
        `SELECT agent_name, quality_score
         FROM tasks
         WHERE agent_name IS NOT NULL
         ORDER BY agent_name ASC, updated_at DESC, id DESC`,
      )
      .all() as QualityTaskRow[];

    const byAgent = new Map<string, QualityTaskRow[]>();
    for (const row of rows) {
      const list = byAgent.get(row.agent_name) ?? [];
      if (list.length < lookbackTasks) list.push(row);
      byAgent.set(row.agent_name, list);
    }

    const perAgent: AgentQualityHealthRow[] = [];
    let totalTaskCount = 0;
    let totalScoredTaskCount = 0;
    let totalNullScoreCount = 0;
    let totalBelowThresholdCount = 0;
    const allScores: number[] = [];

    for (const [agentName, agentRows] of byAgent) {
      const taskCount = agentRows.length;
      const scoredScores = agentRows
        .map((row) => row.quality_score)
        .filter((score): score is number => typeof score === "number");
      const nullScoreCount = taskCount - scoredScores.length;
      const belowThresholdCount = scoredScores.filter((score) => score < qualityThreshold).length;
      const rollingAvgScore =
        scoredScores.length > 0
          ? scoredScores.reduce((sum, score) => sum + score, 0) / scoredScores.length
          : null;
      const nullScoreRate = taskCount > 0 ? nullScoreCount / taskCount : 0;
      const belowThresholdRate =
        scoredScores.length > 0 ? belowThresholdCount / scoredScores.length : null;

      const halfWindow = Math.max(1, Math.ceil(lookbackTasks / 2));
      const recentScores = agentRows
        .slice(0, halfWindow)
        .map((row) => row.quality_score)
        .filter((score): score is number => typeof score === "number");
      const previousScores = agentRows
        .slice(halfWindow, lookbackTasks)
        .map((row) => row.quality_score)
        .filter((score): score is number => typeof score === "number");
      const recentAvgScore =
        recentScores.length > 0
          ? recentScores.reduce((sum, score) => sum + score, 0) / recentScores.length
          : null;
      const previousAvgScore =
        previousScores.length > 0
          ? previousScores.reduce((sum, score) => sum + score, 0) / previousScores.length
          : null;
      const trendDelta =
        recentAvgScore !== null && previousAvgScore !== null
          ? recentAvgScore - previousAvgScore
          : null;

      perAgent.push({
        agent_name: agentName,
        task_count: taskCount,
        scored_task_count: scoredScores.length,
        null_score_count: nullScoreCount,
        null_score_rate: nullScoreRate,
        below_threshold_count: belowThresholdCount,
        below_threshold_rate: belowThresholdRate,
        rolling_avg_score: rollingAvgScore,
        recent_avg_score: recentAvgScore,
        previous_avg_score: previousAvgScore,
        trend_delta: trendDelta,
        trending_downward: trendDelta !== null && trendDelta <= -0.05,
      });

      totalTaskCount += taskCount;
      totalScoredTaskCount += scoredScores.length;
      totalNullScoreCount += nullScoreCount;
      totalBelowThresholdCount += belowThresholdCount;
      allScores.push(...scoredScores);
    }

    perAgent.sort((a, b) => {
      const aScore = a.rolling_avg_score ?? -Infinity;
      const bScore = b.rolling_avg_score ?? -Infinity;
      if (bScore !== aScore) return bScore - aScore;
      return a.agent_name.localeCompare(b.agent_name);
    });

    return {
      generated_at: new Date().toISOString(),
      window_tasks: lookbackTasks,
      threshold: qualityThreshold,
      total_task_count: totalTaskCount,
      scored_task_count: totalScoredTaskCount,
      null_score_count: totalNullScoreCount,
      below_threshold_count: totalBelowThresholdCount,
      system_avg_score:
        allScores.length > 0
          ? allScores.reduce((sum, score) => sum + score, 0) / allScores.length
          : null,
      per_agent: perAgent,
    };
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

  /**
   * Return a per-agent N-day quality score time series for dashboard sparklines.
   *
   * Each per_agent series contains one point per calendar day in the window.
   * A point's avg_score is the mean quality_score for all scored tasks updated
   * on that day, or null when no tasks had a score on that day.
   *
   * rolling_avg is the mean across all scored tasks in the full window (not a
   * rolling window per se — it spans the full look-back period).
   *
   * Agents with no scored tasks in the window are excluded from per_agent.
   *
   * @param days - Look-back window (default: 7).
   * @param warningThreshold - Agents whose rolling_avg falls below this value
   *   have below_threshold: true (default: 0.75).
   * @param redThreshold - Score below which a point/agent is critical (red band).
   *   Default: 0.60.
   * @param yellowThreshold - Score at or above which a point/agent is healthy
   *   (green band); scores in [redThreshold, yellowThreshold) are yellow.
   *   Default: 0.75.
   * @param taskHistoryBaseUrl - Base URL for per-agent task history click-through.
   *   When provided, each `AgentQualityTrendPoint` includes a `task_history_url`
   *   of the form `<base>?agent=<name>&date=<YYYY-MM-DD>`.  Pass null to omit.
   */
  getAgentQualityTrend(
    days = 7,
    warningThreshold = 0.75,
    redThreshold = 0.60,
    yellowThreshold = 0.75,
    taskHistoryBaseUrl: string | null = null,
  ): import("./types.js").AgentQualityTrend {
    const lookbackDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7;
    const threshold =
      Number.isFinite(warningThreshold) && warningThreshold >= 0 && warningThreshold <= 1
        ? warningThreshold
        : 0.75;
    const redThr =
      Number.isFinite(redThreshold) && redThreshold >= 0 && redThreshold <= 1
        ? redThreshold
        : 0.60;
    const yellowThr =
      Number.isFinite(yellowThreshold) && yellowThreshold >= 0 && yellowThreshold <= 1
        ? yellowThreshold
        : 0.75;
    const offsetArg = `-${lookbackDays - 1} days`;

    /** Derive the colour band for a given avg_score value. */
    const bandForScore = (
      score: number | null,
    ): import("./types.js").SparklineBand => {
      if (score === null) return null;
      if (score < redThr) return "red";
      if (score < yellowThr) return "yellow";
      return "green";
    };

    const dateCte = `
      WITH RECURSIVE dates(d) AS (
        SELECT DATE('now', ?)
        UNION ALL
        SELECT DATE(d, '+1 day') FROM dates WHERE d < DATE('now')
      )
    `;

    // Agents that have at least one scored task in the window
    const activeAgents = this.db
      .prepare(
        `SELECT DISTINCT agent_name
         FROM tasks
         WHERE quality_score IS NOT NULL
           AND agent_name IS NOT NULL
           AND DATE(updated_at) >= DATE('now', ?)
         ORDER BY agent_name ASC`,
      )
      .all(offsetArg) as Array<{ agent_name: string }>;

    const perAgent: import("./types.js").AgentQualityTrendSeries[] = activeAgents.map(
      ({ agent_name }) => {
        // Per-day avg_score for this agent
        const dayRows = this.db
          .prepare(
            `${dateCte}
             SELECT
               d.d AS date,
               COALESCE(s.avg_score, NULL)      AS avg_score,
               COALESCE(s.scored_task_count, 0) AS scored_task_count
             FROM dates d
             LEFT JOIN (
               SELECT
                 DATE(updated_at)      AS day,
                 AVG(quality_score)    AS avg_score,
                 COUNT(*)              AS scored_task_count
               FROM tasks
               WHERE quality_score IS NOT NULL
                 AND agent_name = ?
                 AND DATE(updated_at) >= DATE('now', ?)
               GROUP BY DATE(updated_at)
             ) s ON s.day = d.d
             ORDER BY d.d ASC`,
          )
          .all(offsetArg, agent_name, offsetArg) as Array<{
          date: string;
          avg_score: number | null;
          scored_task_count: number;
        }>;

        // Rolling average across the whole window
        const rollingRow = this.db
          .prepare(
            `SELECT AVG(quality_score) AS rolling_avg
             FROM tasks
             WHERE quality_score IS NOT NULL
               AND agent_name = ?
               AND DATE(updated_at) >= DATE('now', ?)`,
          )
          .get(agent_name, offsetArg) as { rolling_avg: number | null };

        const rollingAvg = rollingRow?.rolling_avg ?? null;

        return {
          agent_name,
          rolling_avg: rollingAvg,
          below_threshold: rollingAvg !== null && rollingAvg < threshold,
          risk_tier: bandForScore(rollingAvg),
          days: dayRows.map((r) => {
            const taskHistoryUrl = taskHistoryBaseUrl
              ? `${taskHistoryBaseUrl}?agent=${encodeURIComponent(agent_name)}&date=${r.date}`
              : null;
            return {
              date: r.date,
              avg_score: r.avg_score,
              scored_task_count: r.scored_task_count,
              band: bandForScore(r.avg_score),
              task_history_url: taskHistoryUrl,
            };
          }),
        };
      },
    );

    return {
      days: lookbackDays,
      warning_threshold: threshold,
      red_threshold: redThr,
      yellow_threshold: yellowThr,
      per_agent: perAgent,
      generated_at: new Date().toISOString(),
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
    this.recordTableAccess("merge_queue", "pr-review");
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
    this.recordTableAccess("merge_queue", "pr-review");
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
    this.recordTableAccess("pr_reviews", "pr-review");
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
   * Returns ALL (agent_name, task_type, score_bucket) cells from pr_outcome_records
   * without any minimum sample filter.  Callers should treat cells with
   * total_count < 30 as having insufficient data.
   */
  getCalibrationTable(): ScoreCalibrationRow[] {
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

  // ── Phase 2 calibration: verifier threshold auto-adjustment ──────────────

  /**
   * Return the persisted threshold for (verifierId, taskType), or null if
   * the threshold has never been explicitly set (caller should use the
   * default APPROVAL_THRESHOLD = 0.80 in that case).
   */
  getVerifierThreshold(verifierId: string, taskType: TaskType): VerifierThreshold | null {
    const row = this.db
      .prepare(
        `SELECT verifier_id, task_type, threshold, last_adjusted_at, justification
         FROM verifier_thresholds
         WHERE verifier_id = ? AND task_type = ?`,
      )
      .get(verifierId, taskType) as VerifierThreshold | undefined;
    return row ?? null;
  }

  /**
   * Persist an updated threshold for (verifierId, taskType) with an auditable
   * justification string. Uses UPSERT so repeated calls are idempotent.
   */
  setVerifierThreshold(
    verifierId: string,
    taskType: TaskType,
    threshold: number,
    justification: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO verifier_thresholds (verifier_id, task_type, threshold, last_adjusted_at, justification)
         VALUES (?, ?, ?, datetime('now'), ?)
         ON CONFLICT(verifier_id, task_type)
         DO UPDATE SET
           threshold        = excluded.threshold,
           last_adjusted_at = excluded.last_adjusted_at,
           justification    = excluded.justification`,
      )
      .run(verifierId, taskType, threshold, justification);
  }

  /**
   * Return all alert states for a verifier (across all task types and score buckets).
   * Returns an empty array when no state has been recorded yet.
   */
  getVerifierAlertStates(verifierId: string): VerifierAlertState[] {
    return this.db
      .prepare(
        `SELECT verifier_id, task_type, score_bucket, consecutive_bad_cycles, last_checked_at
         FROM verifier_alert_state
         WHERE verifier_id = ?
         ORDER BY task_type, score_bucket`,
      )
      .all(verifierId) as VerifierAlertState[];
  }

  /**
   * Upsert the consecutive-bad-cycle counter for one (verifier, task_type, bucket) triplet.
   * Sets `last_checked_at` to the current UTC timestamp on every write.
   */
  upsertVerifierAlertState(state: Omit<VerifierAlertState, "last_checked_at">): void {
    this.db
      .prepare(
        `INSERT INTO verifier_alert_state
           (verifier_id, task_type, score_bucket, consecutive_bad_cycles, last_checked_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(verifier_id, task_type, score_bucket)
         DO UPDATE SET
           consecutive_bad_cycles = excluded.consecutive_bad_cycles,
           last_checked_at        = excluded.last_checked_at`,
      )
      .run(state.verifier_id, state.task_type, state.score_bucket, state.consecutive_bad_cycles);
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

  // ── Operator review queue ─────────────────────────────────────────────────

  /**
   * List all tasks currently in `needs_operator_review` verification status,
   * ordered by updated_at DESC (most recently held first).
   */
  getTasksInOperatorReview(): Task[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE verification_status = 'needs_operator_review'
         ORDER BY updated_at DESC
         LIMIT 50`,
      )
      .all() as Task[];
    return rows;
  }

  // ── Routing violations (issue #293) ─────────────────────────────────────

  /**
   * Record an agent-to-repo routing violation.
   */
  recordRoutingViolation(violation: Omit<RoutingViolation, "id">): void {
    this.db
      .prepare(
        `INSERT INTO routing_violations
           (task_id, agent_name, target_repo, expected_agent, task_title, dispatched_at, detected_at)
         VALUES
           (@task_id, @agent_name, @target_repo, @expected_agent, @task_title, @dispatched_at, @detected_at)`,
      )
      .run({
        task_id: violation.task_id,
        agent_name: violation.agent_name,
        target_repo: violation.target_repo,
        expected_agent: violation.expected_agent ?? null,
        task_title: violation.task_title ?? null,
        dispatched_at: violation.dispatched_at,
        detected_at: violation.detected_at,
      });
  }

  /**
   * Return the most recent routing violations, newest first.
   */
  getRoutingViolations(limit: number = 20): RoutingViolation[] {
    const safeLimit = Math.max(1, Math.min(limit, 100));
    return this.db
      .prepare(
        `SELECT * FROM routing_violations
         ORDER BY detected_at DESC
         LIMIT ?`,
      )
      .all(safeLimit) as RoutingViolation[];
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

  // ── PR iteration trend and coaching ─────────────────────────────────────

  /**
   * Generate weekly revision-rate trend data, comparing PRs needing revisions
   * to total PRs reviewed in each week.
   *
   * Uses `weekday 0` (Sunday) with -6 days offset to correctly map every
   * weekday to its Monday (week start).
   *
   * Part of the improvement-detector integration for issue #159.
   */
  getPRIterationTrend(windowDays = 90): PRIterationTrend {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // Aggregate per (repo, pr_number, week).  We use strftime('%Y-%W', …)
    // as a compact week key and derive the Monday date for display.
    const rawRows = this.db.prepare(`
      SELECT
        strftime('%Y-%W', created_at) AS week_key,
        date(created_at, 'weekday 0', '-6 days') AS week_start,
        repo,
        pr_number,
        MAX(CASE WHEN decision = 'approve'         THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN decision = 'request-changes' THEN 1 ELSE 0 END) AS change_requests
      FROM pr_reviews
      WHERE created_at >= ?
      GROUP BY week_key, week_start, repo, pr_number
      ORDER BY week_key ASC
    `).all(since) as Array<{
      week_key: string;
      week_start: string;
      repo: string;
      pr_number: number;
      approved: number;
      change_requests: number;
    }>;

    // Roll up to one point per week
    const weekMap = new Map<string, {
      week_start: string;
      total: number;
      with_revisions: number;
      total_rounds: number;
      approved: number;
    }>();

    for (const row of rawRows) {
      const entry = weekMap.get(row.week_key) ?? {
        week_start: row.week_start,
        total: 0,
        with_revisions: 0,
        total_rounds: 0,
        approved: 0,
      };
      entry.total++;
      if (row.change_requests > 0) entry.with_revisions++;
      if (row.approved) {
        entry.approved++;
        entry.total_rounds += row.change_requests + 1;
      }
      weekMap.set(row.week_key, entry);
    }

    const points: PRIterationTrendPoint[] = [];
    for (const [, w] of weekMap) {
      points.push({
        week_start: w.week_start,
        total_prs: w.total,
        prs_with_revisions: w.with_revisions,
        revision_rate: w.total > 0 ? w.with_revisions / w.total : null,
        avg_rounds_to_merge: w.approved > 0 ? w.total_rounds / w.approved : null,
      });
    }

    // Direction: compare the last two complete weeks
    let direction: PRIterationTrend["direction"] = "insufficient_data";
    let delta: number | null = null;

    if (points.length >= 2) {
      const prev = points[points.length - 2].revision_rate;
      const last = points[points.length - 1].revision_rate;
      if (prev !== null && last !== null) {
        delta = last - prev;
        const THRESHOLD = 0.03; // 3pp change = meaningful
        if (delta < -THRESHOLD) direction = "improving";
        else if (delta > THRESHOLD) direction = "worsening";
        else direction = "stable";
      }
    }

    return { window_days: windowDays, points, direction, delta };
  }

  /**
   * Generate coaching directives for agents whose revision rate exceeds
   * `thresholdPct` (default 40 %).  For each such agent, surface the top
   * feedback patterns and redispatch categories driving the high rate.
   *
   * Part of the improvement-detector integration for issue #159.
   */
  getAgentCoachingDirectives(
    windowDays = 30,
    thresholdPct = 40,
  ): AgentCoachingDirective[] {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

    // Per-agent feedback task stats
    const agentFeedbackRows = this.db.prepare(`
      SELECT
        t.agent_name,
        COUNT(DISTINCT t.source_ref) AS unique_prs,
        COUNT(*) AS feedback_tasks,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done
      FROM tasks t
      WHERE t.source = 'pr-feedback'
        AND t.created_at >= ?
        AND t.agent_name IS NOT NULL
      GROUP BY t.agent_name
    `).all(since) as Array<{
      agent_name: string;
      unique_prs: number;
      feedback_tasks: number;
      done: number;
    }>;

    // First-pass task counts for computing revision %
    const firstPassRows = this.db.prepare(`
      SELECT agent_name, COUNT(*) AS total_tasks
      FROM tasks
      WHERE parent_task_id IS NULL
        AND created_at >= ?
        AND agent_name IS NOT NULL
        AND source != 'pr-feedback'
        AND title NOT LIKE '[revision]%'
      GROUP BY agent_name
    `).all(since) as Array<{ agent_name: string; total_tasks: number }>;

    const firstPassMap = new Map(firstPassRows.map(r => [r.agent_name, r.total_tasks]));

    const directives: AgentCoachingDirective[] = [];

    for (const row of agentFeedbackRows) {
      const firstPass = firstPassMap.get(row.agent_name) ?? 0;
      const totalWork = firstPass + row.feedback_tasks;
      const revPct = totalWork > 0 ? (row.feedback_tasks / totalWork) * 100 : 0;

      if (revPct < thresholdPct) continue;

      // Top feedback patterns for this specific agent
      const agentPatterns = this.db.prepare(`
        SELECT title, COUNT(*) AS count
        FROM tasks
        WHERE source = 'pr-feedback'
          AND created_at >= ?
          AND agent_name = ?
        GROUP BY title
        ORDER BY count DESC
        LIMIT 5
      `).all(since, row.agent_name) as Array<{ title: string; count: number }>;

      // Top redispatch categories linked to this agent's PRs (via source_ref match)
      const agentCategories = this.db.prepare(`
        SELECT r.redispatch_category AS category, COUNT(*) AS count
        FROM pr_reviews r
        INNER JOIN tasks t
          ON t.source_ref = (r.repo || '#' || r.pr_number)
          OR t.source_ref = CAST(r.pr_number AS TEXT)
        WHERE r.created_at >= ?
          AND r.redispatch_category IS NOT NULL
          AND t.agent_name = ?
          AND t.source = 'pr-feedback'
        GROUP BY r.redispatch_category
        ORDER BY count DESC
        LIMIT 5
      `).all(since, row.agent_name) as Array<{ category: string; count: number }>;

      // Build directive text
      const topPatternSummary = agentPatterns.slice(0, 3)
        .map(p => `"${p.title.slice(0, 60)}"`)
        .join(", ");
      const topCatSummary = agentCategories.slice(0, 3)
        .map(c => c.category)
        .join(", ");

      let directive = `Revision rate is ${Math.round(revPct)}% (${row.feedback_tasks} feedback tasks / ${totalWork} total). `;
      if (topPatternSummary) directive += `Top recurring issues: ${topPatternSummary}. `;
      if (topCatSummary) directive += `Review categories: ${topCatSummary}. `;
      directive += "Consider adding pre-dispatch checklists or self-review steps for these patterns.";

      directives.push({
        agent_name: row.agent_name,
        revision_pct: Math.round(revPct * 10) / 10,
        feedback_tasks: row.feedback_tasks,
        top_patterns: agentPatterns.map(p => ({ pattern: p.title.slice(0, 120), count: p.count })),
        top_categories: agentCategories,
        directive,
      });
    }

    // Sort by revision_pct descending (worst first)
    directives.sort((a, b) => b.revision_pct - a.revision_pct);
    return directives;
  }

  // ── Standup synthesis health ──────────────────────────────────────────────

  /**
   * Record a standup synthesis event.
   *
   * Called each time a standup issue is processed by the reviewer.
   * `label` indicates whether synthesis succeeded ('synthesized') or fell back
   * ('synthesis-fallback', 'empty-retry').
   */
  recordStandupSynthesisEvent(
    repo: string,
    issueNumber: number,
    label: StandupSynthesisLabel,
    actionItemCount: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO standup_synthesis_events (id, repo, issue_number, label, action_item_count)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ulid(), repo, issueNumber, label, actionItemCount);
  }

  /**
   * Return standup synthesis health metrics for the given look-back window.
   *
   * Returns a per-day breakdown (sparkline data) and a rolling 24h fallback
   * count for escalation decisions.
   *
   * @param days - Look-back window (default: 7 days).
   */
  getStandupHealth(days = 7): StandupHealthSummary {
    // Use datetime('now', ?) with relative-offset strings so the comparison
    // value uses the same 'YYYY-MM-DD HH:MM:SS' format as the stored
    // recorded_at column (which comes from DEFAULT (datetime('now'))).
    // Using toISOString() produces 'YYYY-MM-DDTHH:MM:SS.mmmZ' where the 'T'
    // separator (ASCII 84) sorts after the space separator (ASCII 32) used by
    // SQLite, causing rows on the boundary day to be incorrectly excluded.
    const sinceOffset = `-${days} days`;
    const since24hOffset = "-1 days";

    // Per-day aggregation
    const dailyRows = this.db
      .prepare(
        `SELECT
          date(recorded_at) AS date,
          COUNT(*) AS total,
          SUM(CASE WHEN label = 'synthesized' THEN 1 ELSE 0 END) AS synthesized,
          SUM(CASE WHEN label != 'synthesized' THEN 1 ELSE 0 END) AS fallback
        FROM standup_synthesis_events
        WHERE recorded_at >= datetime('now', ?)
        GROUP BY date(recorded_at)
        ORDER BY date ASC`,
      )
      .all(sinceOffset) as Array<{
        date: string;
        total: number;
        synthesized: number;
        fallback: number;
      }>;

    const points: StandupHealthPoint[] = dailyRows.map((row) => ({
      date: row.date,
      total: row.total,
      synthesized: row.synthesized,
      fallback: row.fallback,
      success_rate: row.total > 0 ? row.synthesized / row.total : null,
    }));

    // Rolling 24h fallback count for escalation check
    const fallbackRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM standup_synthesis_events
         WHERE recorded_at >= datetime('now', ?)
           AND label != 'synthesized'`,
      )
      .get(since24hOffset) as { cnt: number };

    const fallback_count_24h = fallbackRow?.cnt ?? 0;

    return {
      window_days: days,
      points,
      fallback_count_24h,
      should_escalate: fallback_count_24h > 2,
    };
  }

  // ── Verification results ──────────────────────────────────────────────────

  private static readonly HARD_BLOCK_THRESHOLD = 0.50;

  /**
   * Acceptance floor: scores strictly below this value are unconditionally
   * rejected.  Covers both sub-ranges:
   *   < 0.50                    → hard_block_sub50 (fundamentally incomplete)
   *   [0.50, 0.60)              → low_score_sub60  (partial, below acceptance bar)
   *
   * Any `insertVerificationResult` call with score < 0.60 and first_pass = 1
   * is normalised to first_pass = 0 so the verification_results table never
   * contains an 'approved' record whose score would contradict the quality gate.
   * This is the storage-layer equivalent of the verifier's applySubThresholdRejectionGuard().
   */
  private static readonly SUB_THRESHOLD_REJECTION_LIMIT = APPROVAL_SCORE_FLOOR;

  /**
   * Persist a verification result record after each LLM scoring decision.
   *
   * Enforces two score-gate invariants at the write path (belt-and-suspenders):
   *   1. score < 0.50 → first_pass forced to 0, blocked_reason = 'hard_block_sub50'
   *   2. score in [0.50, 0.60) → first_pass forced to 0, blocked_reason = 'low_score_sub60'
   *
   * This means the verification_results table can never contain an 'approved'
   * record (first_pass = 1) with quality_score < 0.60, regardless of how the
   * record was constructed. Callers that already set blockedReason correctly are
   * unaffected — normalisation is a no-op when first_pass is already 0.
   */
  insertVerificationResult(record: Omit<VerificationResultRecord, "id">): void {
    const isHardBlocked = record.score < StateStore.HARD_BLOCK_THRESHOLD;
    const isSubThreshold =
      !isHardBlocked && record.score < StateStore.SUB_THRESHOLD_REJECTION_LIMIT;

    const normalizedRecord = {
      ...record,
      first_pass: isHardBlocked || isSubThreshold ? 0 : record.first_pass,
      blocked_reason: isHardBlocked
        ? "hard_block_sub50"
        : isSubThreshold
          ? "low_score_sub60"
          : record.blocked_reason,
      approval_rationale:
        isHardBlocked || isSubThreshold ? null : record.approval_rationale,
    };

    this.db
      .prepare(
        `INSERT INTO verification_results
           (task_id, score, first_pass, rejection_reason, blocked_reason, approval_rationale, threshold, agent_id, timestamp, cli_smoke_test_passed, bypass_reason)
         VALUES
           (@task_id, @score, @first_pass, @rejection_reason, @blocked_reason, @approval_rationale, @threshold, @agent_id, @timestamp, @cli_smoke_test_passed, @bypass_reason)`,
      )
      .run({
        ...normalizedRecord,
        cli_smoke_test_passed: normalizedRecord.cli_smoke_test_passed ?? null,
        bypass_reason: normalizedRecord.bypass_reason ?? null,
      });
  }

  /**
   * Audit query: return verification_results records where first_pass = 1
   * (approved) but score < minScore within the last `days` days.
   *
   * Use this to validate the score threshold gate — the result set should be
   * empty when the gate is enforced correctly. A non-empty result set indicates
   * either a past write-path gap or a race condition that needs investigation.
   *
   * Acceptance criteria for issue #258:
   *   `getApprovedBelowThreshold(0.60, 30)` must return an empty array.
   *
   * @param minScore - Score threshold (exclusive lower bound). Default 0.60.
   * @param days     - Look-back window in calendar days. Default 30.
   */
  getApprovedBelowThreshold(
    minScore: number = StateStore.SUB_THRESHOLD_REJECTION_LIMIT,
    days: number = 30,
  ): VerificationResultRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM verification_results
         WHERE first_pass = 1
           AND score < ?
           AND timestamp >= datetime('now', ? || ' days')
         ORDER BY timestamp DESC`,
      )
      .all(minScore, `-${days}`) as VerificationResultRecord[];
  }

  /**
   * Return aggregated verification statistics for a single agent.
   *
   * @param agentId - Agent name to filter by (matches the `agent_id` column).
   * @param since   - Optional ISO-8601 lower bound on `timestamp`.
   *                  When omitted, all records for the agent are included.
   * @returns Aggregated stats, or null when no records exist for this agent.
   */
  getVerificationStats(agentId: string, since?: string): VerificationStats | null {
    const row = since
      ? (this.db
          .prepare(
            `SELECT
               agent_id,
               COUNT(*)                          AS total_verifications,
               SUM(first_pass)                   AS first_pass_count,
               SUM(1 - first_pass)               AS rejection_count,
               AVG(score)                        AS avg_score
             FROM verification_results
             WHERE agent_id = ?
               AND timestamp >= ?`,
          )
          .get(agentId, since) as {
          agent_id: string;
          total_verifications: number;
          first_pass_count: number;
          rejection_count: number;
          avg_score: number | null;
        } | undefined)
      : (this.db
          .prepare(
            `SELECT
               agent_id,
               COUNT(*)                          AS total_verifications,
               SUM(first_pass)                   AS first_pass_count,
               SUM(1 - first_pass)               AS rejection_count,
               AVG(score)                        AS avg_score
             FROM verification_results
             WHERE agent_id = ?`,
          )
          .get(agentId) as {
          agent_id: string;
          total_verifications: number;
          first_pass_count: number;
          rejection_count: number;
          avg_score: number | null;
        } | undefined);

    if (!row || row.total_verifications === 0) return null;

    return {
      agent_id: row.agent_id,
      total_verifications: row.total_verifications,
      first_pass_count: row.first_pass_count,
      first_pass_rate:
        row.total_verifications > 0 ? row.first_pass_count / row.total_verifications : null,
      avg_score: row.avg_score,
      rejection_count: row.rejection_count,
    };
  }

  /**
   * Return the most recent verification result record for a specific task.
   * Used by the Telegram /score command to retrieve blocked_reason and
   * per-verification metadata without agent-level aggregation.
   */
  getLatestVerificationRecord(
    taskId: string,
  ): import("./types.js").VerificationResultRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, score, first_pass, rejection_reason, blocked_reason,
                approval_rationale, threshold, agent_id, timestamp
         FROM verification_results
         WHERE task_id = ?
         ORDER BY timestamp DESC, id DESC
         LIMIT 1`,
      )
      .get(taskId) as import("./types.js").VerificationResultRecord | undefined;
    return row ?? null;
  }

  // ── Operator override (issue #272) ───────────────────────────────────────

  /**
   * Allow an operator to approve-with-override or reject a task that was held
   * for operator review (verification_status = 'needs_operator_review').
   *
   * Records the override decision in the verification_notes audit trail and
   * updates the task's verification_status accordingly.
   *
   * @param taskId — task ID to override
   * @param decision — 'approve' to approve-with-override, 'reject' to reject
   * @param operatorNote — free-text reason for the override decision
   * @returns true if the override was applied, false if the task was not in
   *          'needs_operator_review' status
   */
  operatorOverride(
    taskId: string,
    decision: "approve" | "reject",
    operatorNote: string,
  ): boolean {
    const existing = this.db
      .prepare("SELECT verification_status, verification_notes, quality_score FROM tasks WHERE id = ?")
      .get(taskId) as {
        verification_status: string | null;
        verification_notes: string | null;
        quality_score: number | null;
      } | undefined;

    if (!existing || existing.verification_status !== "needs_operator_review") {
      return false;
    }

    const timestamp = new Date().toISOString();
    const overrideNote = decision === "approve"
      ? `[operator-override: APPROVED at ${timestamp}] ${operatorNote}`
      : `[operator-override: REJECTED at ${timestamp}] ${operatorNote}`;

    const newStatus = decision === "approve" ? "approved" : "rejected";
    const newNotes = existing.verification_notes
      ? `${overrideNote}\n\n${existing.verification_notes}`
      : overrideNote;

    // Bypass the normal floor guard for approved overrides — the operator
    // is explicitly approving below-floor work with their rationale logged.
    // Check if approval_rationale column exists (may not in older schemas).
    const cols = this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
    const hasApprovalRationale = cols.some((c) => c.name === "approval_rationale");

    // Set bypass_reason when operator approves a sub-0.60 task
    const bypassReason = decision === "approve" ? `operator_override` : null;

    if (hasApprovalRationale) {
      this.db
        .prepare(
          `UPDATE tasks
           SET verification_status = ?,
               verification_notes = ?,
               approval_rationale = ?,
               bypass_reason = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          newStatus,
          newNotes,
          decision === "approve" ? `operator_override: ${operatorNote}` : null,
          bypassReason,
          timestamp,
          taskId,
        );
    } else {
      this.db
        .prepare(
          `UPDATE tasks
           SET verification_status = ?,
               verification_notes = ?,
               bypass_reason = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(newStatus, newNotes, bypassReason, timestamp, taskId);
    }

    return true;
  }

  // ── Bypass reason backfill (issue #295) ──────────────────────────────────

  /**
   * Backfill `bypass_reason` for historical sub-0.60 approved tasks.
   *
   * Logic:
   * 1. Query tasks where quality_score < 0.60, verification_status = 'approved',
   *    and bypass_reason IS NULL.
   * 2. If verification_notes contains `[operator-override: APPROVED ...]`,
   *    set bypass_reason = 'operator_override'.
   * 3. Otherwise set bypass_reason = 'floor_not_enforced'.
   * 4. Similarly backfill verification_results by joining on task_id.
   *
   * Idempotent: only touches rows where bypass_reason IS NULL.
   *
   * @returns Summary of rows updated.
   */
  backfillBypassReasons(): { tasks_updated: number; verification_results_updated: number } {
    // Step 1: Backfill tasks with operator-override pattern
    const operatorOverrideTaskResult = this.db
      .prepare(
        `UPDATE tasks
         SET bypass_reason = 'operator_override',
             updated_at = datetime('now')
         WHERE quality_score < 0.60
           AND verification_status = 'approved'
           AND bypass_reason IS NULL
           AND (
             verification_notes LIKE '%[operator-override:%'
             OR verification_notes LIKE '%operator_override%'
           )`,
      )
      .run();

    // Step 2: Backfill remaining tasks (no operator-override marker) as floor_not_enforced
    const floorNotEnforcedTaskResult = this.db
      .prepare(
        `UPDATE tasks
         SET bypass_reason = 'floor_not_enforced',
             updated_at = datetime('now')
         WHERE quality_score < 0.60
           AND verification_status = 'approved'
           AND bypass_reason IS NULL`,
      )
      .run();

    const tasksUpdated = operatorOverrideTaskResult.changes + floorNotEnforcedTaskResult.changes;

    // Step 3: Backfill verification_results where the matching task has operator-override notes
    const operatorOverrideVrResult = this.db
      .prepare(
        `UPDATE verification_results
         SET bypass_reason = 'operator_override'
         WHERE score < 0.60
           AND first_pass = 1
           AND bypass_reason IS NULL
           AND task_id IN (
             SELECT id FROM tasks
             WHERE verification_notes LIKE '%[operator-override:%'
                OR verification_notes LIKE '%operator_override%'
           )`,
      )
      .run();

    // Step 4: Backfill remaining verification_results as floor_not_enforced
    const floorNotEnforcedVrResult = this.db
      .prepare(
        `UPDATE verification_results
         SET bypass_reason = 'floor_not_enforced'
         WHERE score < 0.60
           AND first_pass = 1
           AND bypass_reason IS NULL
           AND task_id IN (
             SELECT id FROM tasks
             WHERE quality_score < 0.60
               AND verification_status = 'approved'
           )`,
      )
      .run();

    const vrUpdated = operatorOverrideVrResult.changes + floorNotEnforcedVrResult.changes;

    return { tasks_updated: tasksUpdated, verification_results_updated: vrUpdated };
  }

  // ── First-pass rate widget (issue #88) ───────────────────────────────────

  /**
   * Build the complete first-pass rate widget payload.
   *
   * Returns:
   * - Current calendar-month fleet-wide first-pass rate vs. 80% goal
   * - A goal_met boolean for the progress-bar indicator
   * - Weekly trend over the past `weeksBack` weeks (oldest first)
   * - Per-(agent_id, task_type) drill-down identifying which agent + task
   *   combination is pulling the fleet rate below the 80% goal
   *
   * The drill-down joins `verification_results` → `tasks` on task_id so
   * that the task_type dimension is available.  Rows in `verification_results`
   * with no matching task row default task_type to "unknown".
   *
   * @param weeksBack - How many weeks of trend history to return (default: 4).
   */
  getFirstPassRateWidget(weeksBack = 4): import("./types.js").FirstPassRateWidget {
    const GOAL = 0.80;
    const now = new Date();

    // ── Current calendar month (UTC) ────────────────────────────────────
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthStartIso = monthStart.toISOString();

    const monthRow = this.db
      .prepare(
        `SELECT
           COUNT(*)        AS total,
           SUM(first_pass) AS first_pass_count
         FROM verification_results
         WHERE timestamp >= ?`,
      )
      .get(monthStartIso) as { total: number; first_pass_count: number } | undefined;

    const monthTotal = monthRow?.total ?? 0;
    const monthFirstPass = monthRow?.first_pass_count ?? 0;
    const currentMonthRate = monthTotal > 0 ? monthFirstPass / monthTotal : null;

    // ── Weekly trend ─────────────────────────────────────────────────────
    // Compute Monday-aligned week boundaries for the past `weeksBack` weeks.
    const weeklyTrend: import("./types.js").FirstPassTrendPoint[] = [];

    // Align to the Monday of the current week
    const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon, ...6=Sat
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const thisMonday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysToMonday),
    );

    for (let w = weeksBack - 1; w >= 0; w--) {
      const weekStart = new Date(thisMonday.getTime() - w * 7 * 24 * 60 * 60 * 1000);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

      const row = this.db
        .prepare(
          `SELECT
             COUNT(*)        AS total,
             SUM(first_pass) AS first_pass_count
           FROM verification_results
           WHERE timestamp >= ? AND timestamp < ?`,
        )
        .get(weekStart.toISOString(), weekEnd.toISOString()) as
        | { total: number; first_pass_count: number }
        | undefined;

      const total = row?.total ?? 0;
      const fpCount = row?.first_pass_count ?? 0;
      weeklyTrend.push({
        week_start: weekStart.toISOString().slice(0, 10),
        total,
        first_pass_count: fpCount,
        rate: total > 0 ? fpCount / total : null,
      });
    }

    // ── Per-agent, per-task-type drill-down ──────────────────────────────
    // Join verification_results → tasks to get task_type dimension.
    // Tasks with no match default to "unknown".
    const drillRows = this.db
      .prepare(
        `SELECT
           vr.agent_id,
           COALESCE(t.task_type, 'unknown') AS task_type,
           COUNT(*)                         AS total,
           SUM(vr.first_pass)               AS first_pass_count
         FROM verification_results vr
         LEFT JOIN tasks t ON t.id = vr.task_id
         WHERE vr.timestamp >= ?
         GROUP BY vr.agent_id, task_type
         ORDER BY vr.agent_id, task_type`,
      )
      .all(monthStartIso) as Array<{
      agent_id: string;
      task_type: string;
      total: number;
      first_pass_count: number;
    }>;

    const drillDown: import("./types.js").FirstPassDrillDown[] = drillRows.map((r) => ({
      agent_id: r.agent_id,
      task_type: r.task_type,
      total: r.total,
      first_pass_count: r.first_pass_count,
      rate: r.total > 0 ? r.first_pass_count / r.total : null,
    }));

    return {
      month_start: monthStartIso,
      current_month_rate: currentMonthRate,
      current_month_total: monthTotal,
      goal: GOAL,
      goal_met: currentMonthRate !== null ? currentMonthRate >= GOAL : null,
      weekly_trend: weeklyTrend,
      drill_down: drillDown,
    };
  }

  // ── Secrets health checks ────────────────────────────────────────────────

  /**
   * Persist one or more secret-health check results for a single agent.
   *
   * Called after querying the agent-proxy `/v1/agents/:name/secrets` endpoint.
   * Each element of `secrets` produces one row in `secrets_health_checks`.
   *
   * @param agentName - Agent name (e.g. "claude-proxy").
   * @param secrets   - Array of per-secret health entries from the proxy response.
   * @param checkedAt - ISO-8601 timestamp of the check (defaults to UTC now).
   */
  recordSecretsHealthCheck(
    agentName: string,
    secrets: ReadonlyArray<Pick<SecretHealthEntry, "name" | "status" | "readable" | "non_empty">>,
    checkedAt: string = new Date().toISOString(),
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO secrets_health_checks
         (agent_name, secret_name, status, readable, non_empty, checked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction(
      (rows: ReadonlyArray<Pick<SecretHealthEntry, "name" | "status" | "readable" | "non_empty">>) => {
        for (const s of rows) {
          insert.run(agentName, s.name, s.status, s.readable ? 1 : 0, s.non_empty ? 1 : 0, checkedAt);
        }
      },
    );
    insertMany(secrets);
  }

  /**
   * Return the most-recent health snapshot for a single agent.
   *
   * Finds the latest `checked_at` timestamp for the agent, then reads all
   * secret rows recorded at that exact timestamp.
   *
   * @returns Summary, or null when no checks exist for the agent.
   */
  getAgentSecretsHealth(agentName: string): AgentSecretsHealthSummary | null {
    // Required secrets whose absence marks an agent as unhealthy.
    const REQUIRED = new Set(["oauth_token", "gh_token"]);

    // Find the most recent check timestamp for this agent.
    const latestRow = this.db
      .prepare(
        `SELECT checked_at FROM secrets_health_checks
         WHERE agent_name = ?
         ORDER BY checked_at DESC
         LIMIT 1`,
      )
      .get(agentName) as { checked_at: string } | undefined;

    if (!latestRow) return null;

    const rows = this.db
      .prepare(
        `SELECT secret_name, status, readable, non_empty
         FROM secrets_health_checks
         WHERE agent_name = ? AND checked_at = ?`,
      )
      .all(agentName, latestRow.checked_at) as Array<{
        secret_name: string;
        status: SecretMountStatus;
        readable: number;
        non_empty: number;
      }>;

    const secretsSummary = rows.map((r) => ({ name: r.secret_name, status: r.status }));
    const requiredRows = rows.filter((r) => REQUIRED.has(r.secret_name));
    const healthy =
      requiredRows.length > 0 && requiredRows.every((r) => r.status === "present-and-valid");
    const missing_count = rows.filter((r) => r.status !== "present-and-valid").length;

    return {
      agent_name: agentName,
      last_checked_at: latestRow.checked_at,
      healthy,
      secrets: secretsSummary,
      missing_count,
    };
  }

  /**
   * Return the fleet-wide secrets health summary.
   *
   * Aggregates the most-recent check per agent across all agents in the
   * `secrets_health_checks` table.
   */
  getSecretsFleetHealth(): SecretsFleetHealthSummary {
    // Get the distinct list of agents with check records.
    const agentRows = this.db
      .prepare(
        `SELECT DISTINCT agent_name FROM secrets_health_checks ORDER BY agent_name ASC`,
      )
      .all() as Array<{ agent_name: string }>;

    const agents: AgentSecretsHealthSummary[] = [];
    for (const { agent_name } of agentRows) {
      const summary = this.getAgentSecretsHealth(agent_name);
      if (summary) agents.push(summary);
    }

    const healthy_count = agents.filter((a) => a.healthy).length;
    const degraded_count = agents.length - healthy_count;

    return {
      agent_count: agents.length,
      healthy_count,
      degraded_count,
      agents,
    };
  }

  // ── Quality anomaly feed (issue #153) ───────────────────────────────────

  /**
   * Return tasks where the verifier's quality_score contradicts its
   * verification_status:
   *   (a) score < 0.60 AND status = 'approved'  → low_score_approved
   *   (b) score > 0.85 AND status = 'rejected'  → high_score_rejected
   *
   * Supports either an explicit date range (`since` / `until`) or a rolling
   * look-back window (`days`), plus optional `agent_name`, `anomaly_type`, and
   * `limit` filters.
   */
  getQualityAnomalies(opts: QualityAnomalyQuery = {}): QualityAnomaly[] {
    const days = Number.isFinite(opts.days) && (opts.days ?? 0) >= 1 ? Math.floor(opts.days ?? 7) : 7;
    const limit = Number.isFinite(opts.limit) && (opts.limit ?? 0) >= 1 ? Math.floor(opts.limit ?? 50) : 50;
    const since = opts.since ?? null;
    const until = opts.until ?? null;
    const useExplicitRange = since !== null || until !== null;
    const sinceBound = since ?? `-${days - 1} days`;
    const untilBound = until ?? "now";

    const conditions: string[] = [
      "quality_score IS NOT NULL",
      "verification_status IN ('approved', 'rejected')",
      `(
        (quality_score < 0.60 AND verification_status = 'approved')
        OR
        (quality_score > 0.85 AND verification_status = 'rejected')
      )`,
    ];

    if (opts.agent_name) {
      conditions.push(`agent_name = '${opts.agent_name.replace(/'/g, "''")}'`);
    }

    if (opts.anomaly_type === "low_score_approved") {
      conditions.push("quality_score < 0.60 AND verification_status = 'approved'");
    } else if (opts.anomaly_type === "high_score_rejected") {
      conditions.push("quality_score > 0.85 AND verification_status = 'rejected'");
    }

    if (useExplicitRange) {
      conditions.push("DATE(updated_at) >= DATE(?)");
      conditions.push("DATE(updated_at) <= DATE(?)");
    } else {
      conditions.push("DATE(updated_at) >= DATE('now', ?)");
      conditions.push("DATE(updated_at) <= DATE('now')");
    }

    const where = conditions.join(" AND ");
    const sql = `
      SELECT
        id AS task_id,
        title,
        COALESCE(agent_name, 'unassigned') AS agent_name,
        task_type,
        quality_score,
        verification_status,
        quality_explanation,
        CASE
          WHEN quality_score < 0.60 AND verification_status = 'approved' THEN 'low_score_approved'
          WHEN quality_score > 0.85 AND verification_status = 'rejected' THEN 'high_score_rejected'
        END AS anomaly_type,
        created_at,
        updated_at
      FROM tasks
      WHERE ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `;

    const rows = useExplicitRange
      ? this.db.prepare(sql).all(sinceBound, untilBound, limit) as Array<{
          task_id: string;
          title: string;
          agent_name: string;
          task_type: string;
          quality_score: number;
          verification_status: "approved" | "rejected";
          quality_explanation: string | null;
          anomaly_type: QualityAnomalyType;
          created_at: string;
          updated_at: string;
        }>
      : this.db.prepare(sql).all(sinceBound, limit) as Array<{
          task_id: string;
          title: string;
          agent_name: string;
          task_type: string;
          quality_score: number;
          verification_status: "approved" | "rejected";
          quality_explanation: string | null;
          anomaly_type: QualityAnomalyType;
          created_at: string;
          updated_at: string;
        }>;

    return rows.map((row) => ({
      task_id: row.task_id,
      title: row.title,
      agent_name: row.agent_name,
      task_type: row.task_type,
      quality_score: row.quality_score,
      verification_status: row.verification_status,
      quality_explanation: row.quality_explanation,
      anomaly_type: row.anomaly_type,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  /**
   * Return a summary of quality anomalies: totals, per-type breakdown,
   * per-agent counts, and the anomaly records themselves.
   */
  getQualityAnomalySummary(opts: QualityAnomalyQuery = {}): QualityAnomalySummary {
    const anomalies = this.getQualityAnomalies(opts);

    let low_score_approved = 0;
    let high_score_rejected = 0;
    const agentCounts = new Map<string, number>();

    for (const a of anomalies) {
      if (a.anomaly_type === "low_score_approved") low_score_approved++;
      if (a.anomaly_type === "high_score_rejected") high_score_rejected++;
      const name = a.agent_name ?? "unknown";
      agentCounts.set(name, (agentCounts.get(name) ?? 0) + 1);
    }

    const per_agent = Array.from(agentCounts.entries())
      .map(([agent_name, count]) => ({ agent_name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      total: anomalies.length,
      low_score_approved,
      high_score_rejected,
      per_agent,
      anomalies,
    };
  }

  // ── Reconciliation event queries ──────────────────────────────────────────

  /**
   * Return the most recent reconciliation event per repo.
   *
   * Queries the `reconciliation_events` table (created on migrate or by the
   * dashboard agent). For each repo that appears in `repos_patched`, picks the
   * event with the latest `created_at`. Returns [] when no events exist.
   */
  getLastReconciliationPerRepo(): ReconciliationLastPerRepo[] {
    // Fetch recent events and fan-out by repos_patched in JS to avoid
    // JSON_EACH (not available in all SQLite builds shipped with Node.js).
    const rows = this.db
      .prepare(
        `SELECT id, status, repos_patched, columns_fixed, triggered_by, created_at
         FROM reconciliation_events
         ORDER BY created_at DESC
         LIMIT 500`,
      )
      .all() as Array<{
      id: number;
      status: string;
      repos_patched: string;
      columns_fixed: string;
      triggered_by: string | null;
      created_at: string;
    }>;

    // Build a map of repo → latest event
    const latestByRepo = new Map<string, ReconciliationLastPerRepo>();

    for (const row of rows) {
      let repos: string[] = [];
      let cols: string[] = [];
      try {
        repos = JSON.parse(row.repos_patched) as string[];
      } catch {
        // unparseable — treat as empty
      }
      try {
        cols = JSON.parse(row.columns_fixed) as string[];
      } catch {
        // unparseable — treat as empty
      }

      // If repos_patched is empty, record the event under a synthetic key
      const repoList = repos.length > 0 ? repos : ["(unknown)"];
      for (const repo of repoList) {
        if (!latestByRepo.has(repo)) {
          latestByRepo.set(repo, {
            repo,
            event_id: row.id,
            status: row.status as ReconciliationStatus,
            created_at: row.created_at,
            columns_fixed: cols,
            triggered_by: row.triggered_by,
          });
        }
      }
    }

    // Sort: failed/escalated first, then by recency
    return Array.from(latestByRepo.values()).sort((a, b) => {
      const statusOrder: Record<ReconciliationStatus, number> = {
        failed: 0,
        escalated: 1,
        partial: 2,
        success: 3,
      };
      const ao = statusOrder[a.status] ?? 99;
      const bo = statusOrder[b.status] ?? 99;
      if (ao !== bo) return ao - bo;
      return b.created_at.localeCompare(a.created_at);
    });
  }

  // ── Semantic Task Memory (issue #369) ──────────────────────────────────────

  /**
   * Upsert a memory entry for a (topic, task_id) pair.
   * If a row already exists for the pair, confidence and outcome are overwritten.
   */
  recordMemoryEntry(
    topic: string,
    taskId: string,
    confidence: number,
    outcome: "success" | "failure" | "partial",
  ): void {
    const normalisedTopic = topic.trim().toLowerCase();
    this.db
      .prepare(
        `INSERT INTO semantic_task_memory (topic, task_id, confidence, outcome)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(topic, task_id) DO UPDATE SET
           confidence  = excluded.confidence,
           outcome     = excluded.outcome,
           recorded_at = datetime('now')`,
      )
      .run(normalisedTopic, taskId, confidence, outcome);
  }

  /**
   * Return the top N topics with the most recorded entries since `sinceIso`.
   * Each row includes average confidence and up to 5 example task IDs.
   */
  getTopMemoryTopics(limit: number, sinceIso: string): TopQueriedTopic[] {
    const rows = this.db
      .prepare(
        `SELECT topic,
                COUNT(*)          AS query_count,
                AVG(confidence)   AS avg_confidence,
                GROUP_CONCAT(task_id, '|') AS task_ids_concat
         FROM   semantic_task_memory
         WHERE  datetime(recorded_at) >= datetime(?)
         GROUP  BY topic
         ORDER  BY query_count DESC
         LIMIT  ?`,
      )
      .all(sinceIso, limit) as Array<{
      topic: string;
      query_count: number;
      avg_confidence: number;
      task_ids_concat: string | null;
    }>;

    return rows.map((r) => ({
      topic: r.topic,
      query_count: r.query_count,
      avg_confidence: r.avg_confidence ?? 0,
      example_task_ids: r.task_ids_concat
        ? r.task_ids_concat.split("|").slice(0, 5)
        : [],
    }));
  }

  /**
   * Return the top N topics that have 2+ distinct task entries, ordered by
   * attempt_count descending.
   */
  getRepeatedAttemptTopics(limit: number): RepeatedAttemptTopic[] {
    const rows = this.db
      .prepare(
        `SELECT topic,
                COUNT(*)      AS attempt_count,
                MAX(confidence) AS best_score,
                GROUP_CONCAT(task_id, '|') AS task_ids_concat
         FROM   semantic_task_memory
         GROUP  BY topic
         HAVING COUNT(*) >= 2
         ORDER  BY attempt_count DESC
         LIMIT  ?`,
      )
      .all(limit) as Array<{
      topic: string;
      attempt_count: number;
      best_score: number;
      task_ids_concat: string | null;
    }>;

    return rows.map((r) => ({
      topic: r.topic,
      attempt_count: r.attempt_count,
      best_score: r.best_score ?? 0,
      task_ids: r.task_ids_concat ? r.task_ids_concat.split("|") : [],
    }));
  }

  /**
   * Return topics where every attempt scored below `threshold`, ordered by
   * max_score ascending (worst first).
   */
  getLowConfidenceTopics(threshold: number, limit: number): LowConfidenceTopic[] {
    const rows = this.db
      .prepare(
        `SELECT topic,
                COUNT(*)      AS attempt_count,
                MAX(confidence) AS max_score,
                GROUP_CONCAT(task_id, '|') AS task_ids_concat
         FROM   semantic_task_memory
         GROUP  BY topic
         HAVING MAX(confidence) < ?
         ORDER  BY max_score ASC
         LIMIT  ?`,
      )
      .all(threshold, limit) as Array<{
      topic: string;
      attempt_count: number;
      max_score: number;
      task_ids_concat: string | null;
    }>;

    return rows.map((r) => ({
      topic: r.topic,
      attempt_count: r.attempt_count,
      max_score: r.max_score ?? 0,
      task_ids: r.task_ids_concat ? r.task_ids_concat.split("|") : [],
    }));
  }

  /**
   * Return all memory entries for a given topic, ordered by recorded_at DESC.
   * Uses the FTS5 index for fuzzy matching when an exact match returns 0 rows.
   */
  expandMemoryTopic(topic: string, limit = 20): MemoryEntry[] {
    const normalisedTopic = topic.trim().toLowerCase();

    // Try exact match first
    const exactRows = this.db
      .prepare(
        `SELECT id, topic, task_id, confidence, outcome, recorded_at
         FROM   semantic_task_memory
         WHERE  topic = ?
         ORDER  BY recorded_at DESC
         LIMIT  ?`,
      )
      .all(normalisedTopic, limit) as MemoryEntry[];

    if (exactRows.length > 0) return exactRows;

    // Fall back to FTS5 match (prefix search with wildcard)
    const ftsQuery = normalisedTopic
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `${w}*`)
      .join(" ");

    if (!ftsQuery) return [];

    try {
      const ftsRows = this.db
        .prepare(
          `SELECT m.id, m.topic, m.task_id, m.confidence, m.outcome, m.recorded_at
           FROM   semantic_task_memory m
           JOIN   semantic_task_memory_fts f ON f.rowid = m.id
           WHERE  semantic_task_memory_fts MATCH ?
           ORDER  BY m.recorded_at DESC
           LIMIT  ?`,
        )
        .all(ftsQuery, limit) as MemoryEntry[];

      return ftsRows;
    } catch {
      // FTS match error (e.g. invalid query) — return empty
      return [];
    }
  }

  /**
   * Return recent reconciliation events in reverse chronological order.
   */
  getRecentReconciliationEvents(limit = 20, sinceHours?: number): ReconciliationEventRecord[] {
    let sql = `SELECT id, status, repos_patched, columns_fixed, error_message, triggered_by, details, created_at
               FROM reconciliation_events`;
    const params: (number | string)[] = [];

    if (sinceHours != null) {
      const cutoff = new Date(Date.now() - sinceHours * 3600_000).toISOString();
      sql += ` WHERE created_at >= ?`;
      params.push(cutoff);
    }

    sql += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      status: string;
      repos_patched: string;
      columns_fixed: string;
      error_message: string | null;
      triggered_by: string | null;
      details: string | null;
      created_at: string;
    }>;

    return rows.map((r) => {
      let repos: string[] = [];
      let cols: string[] = [];
      try { repos = JSON.parse(r.repos_patched) as string[]; } catch { /* empty */ }
      try { cols = JSON.parse(r.columns_fixed) as string[]; } catch { /* empty */ }
      return {
        id: r.id,
        status: r.status as ReconciliationStatus,
        repos_patched: repos,
        columns_fixed: cols,
        error_message: r.error_message,
        triggered_by: r.triggered_by,
        details: r.details,
        created_at: r.created_at,
      };
    });
  }

  // ── Triage pre-submission validator calls (issue #413) ──────────────────

  /**
   * Record one call to the triage pre-submission validator endpoint.
   *
   * Call this inside `createTriageSchemaValidationHandler()` after computing
   * the validation result so that `/triage-health` can report the validator
   * call rate alongside the triage submission rate.
   *
   * @param agentName  Agent that made the call (may be null if not supplied).
   * @param passed     Whether the submitted schema passed validation.
   * @param score      Validation score returned to the caller (0–1).
   */
  recordTriageValidatorCall(
    agentName: string | null,
    passed: boolean,
    score: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO triage_validator_calls (agent_name, passed, score)
         VALUES (?, ?, ?)`,
      )
      .run(agentName ?? null, passed ? 1 : 0, score);
  }

  /**
   * Return all validator call records on or after `sinceIso`.
   *
   * @param sinceIso  ISO timestamp lower bound (inclusive).
   */
  listTriageValidatorCalls(sinceIso: string): Array<{
    id: number;
    agent_name: string | null;
    passed: boolean;
    score: number;
    created_at: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT id, agent_name, passed, score, created_at
         FROM triage_validator_calls
         WHERE created_at >= ?
         ORDER BY created_at DESC`,
      )
      .all(sinceIso) as Array<{
        id: number;
        agent_name: string | null;
        passed: 0 | 1;
        score: number;
        created_at: string;
      }>;

    return rows.map((r) => ({ ...r, passed: r.passed === 1 }));
  }

  // ── Startup integrity check (issue #366) ────────────────────────────────

  /**
   * Run PRAGMA integrity_check and PRAGMA foreign_key_check against the open
   * database.  Call this once at container start after constructing StateStore.
   *
   * Results are logged to console; if a `notifier` is provided (e.g. the
   * Telegram notifier), any failures are also sent as an alert message.
   *
   * @param notifier  Optional object with a `send(msg: string): void` method
   *                  (e.g. TelegramNotifier) for out-of-band alerting.
   */
  runStartupIntegrityCheck(notifier?: { send(msg: string): void }): void {
    // PRAGMA integrity_check returns one row per problem found, or a single
    // row with value 'ok' when the database is healthy.
    const integrityRows = this.db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrityFailed = integrityRows.some((r) => r.integrity_check !== "ok");
    if (integrityFailed) {
      const msg =
        `[state.db] integrity_check FAILED:\n` +
        integrityRows.map((r) => r.integrity_check).join("\n");
      console.error(msg);
      notifier?.send(msg);
    }

    // PRAGMA foreign_key_check returns one row per orphaned child row.
    // An empty result means all FK relationships are satisfied.
    const fkRows = this.db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
    if (fkRows.length > 0) {
      const msg =
        `[state.db] foreign_key_check found ${fkRows.length} violation(s):\n` +
        JSON.stringify(fkRows, null, 2);
      console.error(msg);
      notifier?.send(msg);
    }

    if (!integrityFailed && fkRows.length === 0) {
      console.log("[state.db] startup integrity check: OK");
    }
  }

  // ── Meeting-facilitator monthly goals (issue #411) ──────────────────────

  /**
   * Return the monthly goal widget for the meeting-facilitator-agent.
   *
   * Tracks two goals for the current calendar month:
   *  1. `meetings_facilitated` — done tasks dispatched to the agent; target 5.
   *  2. `core_logic_shipped`   — approved implementation task for the agent; target 1.
   *
   * @param agentNamePattern SQL LIKE pattern to match agent names.
   *   Defaults to `'%meeting-facilitator%'`.
   */
  getMeetingFacilitatorGoalWidget(
    agentNamePattern = "%meeting-facilitator%",
  ): MeetingFacilitatorGoalWidget {
    const MEETINGS_TARGET = 5;
    const CORE_LOGIC_TARGET = 1;

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const monthStartIso = monthStart.toISOString();

    // Goal 1: meetings facilitated — count of 'done' tasks this month.
    const facilitatedRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tasks
         WHERE agent_name LIKE ?
           AND status = 'done'
           AND created_at >= ?`,
      )
      .get(agentNamePattern, monthStartIso) as { cnt: number } | undefined;

    const meetingsCurrent = facilitatedRow?.cnt ?? 0;
    const meetingsMet = meetingsCurrent >= MEETINGS_TARGET;
    const meetingsProgress = Math.min(meetingsCurrent / MEETINGS_TARGET, 1);

    // Goal 2: core logic shipped — at least one approved implementation task.
    const coreRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt
         FROM tasks
         WHERE agent_name LIKE ?
           AND task_type = 'implementation'
           AND status = 'done'
           AND verification_status = 'approved'`,
      )
      .get(agentNamePattern) as { cnt: number } | undefined;

    const coreCurrent = Math.min(coreRow?.cnt ?? 0, CORE_LOGIC_TARGET);
    const coreMet = coreCurrent >= CORE_LOGIC_TARGET;
    const coreProgress = Math.min(coreCurrent / CORE_LOGIC_TARGET, 1);

    const goals: MeetingFacilitatorGoalItem[] = [
      {
        key: "core_logic_shipped",
        description: "At least one implementation task approved for the agent",
        target: CORE_LOGIC_TARGET,
        current: coreCurrent,
        progress: coreProgress,
        met: coreMet,
      },
      {
        key: "meetings_facilitated",
        description: "Five or more meetings facilitated end-to-end this month",
        target: MEETINGS_TARGET,
        current: meetingsCurrent,
        progress: meetingsProgress,
        met: meetingsMet,
      },
    ];

    const overallProgress =
      goals.reduce((sum, g) => sum + g.progress, 0) / goals.length;
    const allGoalsMet = goals.every((g) => g.met);

    return {
      month_start: monthStartIso,
      generated_at: now.toISOString(),
      overall_progress: overallProgress,
      all_goals_met: allGoalsMet,
      goals,
    };
  }

  // ── Improvement-detector batch deduplication (issue #458) ─────────────────

  /**
   * Persist a record of an improvement-analysis run (or skip).
   *
   * Callers pass `skipped = true` when the batch hash was already seen within
   * the deduplication window and the LLM call was omitted.
   */
  recordImprovementAnalysisRun(batchHash: string, taskCount: number, skipped: boolean): void {
    this.db
      .prepare(
        `INSERT INTO improvement_analysis_runs (batch_hash, task_count, skipped)
         VALUES (?, ?, ?)`,
      )
      .run(batchHash, taskCount, skipped ? 1 : 0);
  }

  /**
   * Return `true` if an *unskipped* analysis for `batchHash` was recorded
   * within the last `windowHours` hours (default 6).
   *
   * Only runs where `skipped = 0` count — a previous skip does not prevent
   * the next genuine analysis from executing.
   */
  hasRecentImprovementAnalysisRun(batchHash: string, windowHours = 6): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM improvement_analysis_runs
         WHERE batch_hash = ?
           AND skipped    = 0
           AND created_at >= datetime('now', ?)
         LIMIT 1`,
      )
      .get(batchHash, `-${windowHours} hours`) as { 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Return recent improvement-analysis run records, newest first.
   *
   * @param limit - Maximum rows to return (default 50).
   */
  getRecentImprovementAnalysisRuns(limit = 50): ImprovementAnalysisRun[] {
    const rows = this.db
      .prepare(
        `SELECT id, batch_hash, task_count, skipped, created_at
         FROM improvement_analysis_runs
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: number;
      batch_hash: string;
      task_count: number;
      skipped: number;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      batch_hash: r.batch_hash,
      task_count: r.task_count,
      skipped: r.skipped === 1,
      created_at: r.created_at,
    }));
  }

  // ── Pattern risk signals (issue #1149) ──────────────────────────────────

  /**
   * Return raw `pattern_risk` signals recorded within the last `windowHours`
   * hours, ordered by `recorded_at DESC`.
   *
   * The daemon writes these rows on verification failure when it detects a
   * recurring risk pattern (e.g. repeated low scores, consecutive failures).
   * Previously these signals were written but never consumed — this method
   * wires them into the reviewer's improvement-detector pipeline.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   * @param limit       - Maximum rows to return.  Default: 200.
   */
  getRecentPatternRiskSignals(windowHours = 48, limit = 200): PatternRiskSignal[] {
    const rows = this.db
      .prepare(
        `SELECT id, task_id, agent_id, pattern_type, risk_score, detail, recorded_at
         FROM pattern_risk
         WHERE recorded_at >= datetime('now', ?)
         ORDER BY recorded_at DESC
         LIMIT ?`,
      )
      .all(`-${windowHours} hours`, limit) as Array<{
      id: number;
      task_id: string;
      agent_id: string;
      pattern_type: string;
      risk_score: number;
      detail: string;
      recorded_at: string;
    }>;
    return rows;
  }

  /**
   * Return `pattern_risk` signals aggregated per agent for the look-back window.
   *
   * Each returned entry summarises all signals for one agent: mean risk score,
   * distinct pattern types, top detail, and signal count.  Agents with no
   * signals in the window are omitted.  Results are sorted by `mean_risk_score
   * DESC` so the most at-risk agents appear first.
   *
   * @param windowHours - Look-back window in hours.  Default: 48.
   */
  getAgentPatternRiskSummaries(windowHours = 48): AgentPatternRiskSummary[] {
    // Fetch raw signals and aggregate in TypeScript to avoid complex
    // GROUP_CONCAT portability concerns with SQLite versions.
    const signals = this.getRecentPatternRiskSignals(windowHours, 1000);
    if (signals.length === 0) return [];

    const byAgent = new Map<string, PatternRiskSignal[]>();
    for (const s of signals) {
      const bucket = byAgent.get(s.agent_id) ?? [];
      bucket.push(s);
      byAgent.set(s.agent_id, bucket);
    }

    const summaries: AgentPatternRiskSummary[] = [];
    for (const [agentId, agentSignals] of byAgent) {
      const scores = agentSignals.map((s) => s.risk_score);
      const meanScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      const latestScore = agentSignals[0]?.risk_score ?? 0; // already sorted DESC
      const topSignal = agentSignals.reduce((best, s) =>
        s.risk_score > best.risk_score ? s : best,
      );
      const patternTypes = [...new Set(agentSignals.map((s) => s.pattern_type))];

      summaries.push({
        agent_id: agentId,
        latest_risk_score: latestScore,
        mean_risk_score: Math.round(meanScore * 1000) / 1000,
        pattern_types: patternTypes,
        top_detail: topSignal.detail,
        signal_count: agentSignals.length,
      });
    }

    summaries.sort((a, b) => b.mean_risk_score - a.mean_risk_score);
    return summaries;
  }

  /**
   * Close the underlying SQLite connection.
   *
   * Call this at the end of tests or CLI commands to release file handles.
   */
  close(): void {
    this.db.close();
  }
}
