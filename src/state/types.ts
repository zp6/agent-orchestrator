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

export interface SupervisorDecisionRecord {
  id: number | string;
  action: string;
  agent_name?: string | null;
  task_id?: string | null;
  issue_ref?: string | null;
  reason: string;
  message?: string | null;
  outcome: string;
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

/** A dispatch request inserted by the Telegram /dispatch command. */
export interface DispatchRequest {
  id: string;
  agent_name: string;
  message: string;
  status: "pending" | "dispatched" | "failed";
  created_at: string;
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

  // Agent health (reads from orchestrator's agent_health table)
  getAgentHealthBatch(agentNames: string[]): AgentHealth[];

  // Supervisor memory
  getRecentSupervisorDecisions(limit: number): SupervisorDecisionRecord[];
  querySupervisorDecisions(opts: SupervisorDecisionQuery): SupervisorDecisionRecord[];
  pruneOldSupervisorDecisions(daysOld?: number): number;

  // PR merge queue
  queuePRForMerge(repo: string, prNumber: number, branch: string): MergeQueueEntry;
  getMergeQueue(repo?: string): MergeQueueEntry[];
  isPRInMergeQueue(repo: string, prNumber: number): boolean;
  markQueuedPRMerging(repo: string, prNumber: number): void;
  markQueuedPRMerged(repo: string, prNumber: number): void;
  markQueuedPRFailed(repo: string, prNumber: number, error: string): void;
  removeFromMergeQueue(repo: string, prNumber: number): void;

  // PR review history
  recordPRReview(repo: string, prNumber: number, decision: string): void;
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
}
