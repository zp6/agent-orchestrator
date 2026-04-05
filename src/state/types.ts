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
  reason: string;
  message?: string | null;
  outcome: string;
  created_at: string;
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
 * Minimal StateStore interface consumed by reviewer modules.
 * The orchestrator daemon injects its full StateStore — this interface
 * ensures reviewers only depend on what they actually use.
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

  // Supervisor memory
  getRecentSupervisorDecisions(limit: number): SupervisorDecisionRecord[];

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
