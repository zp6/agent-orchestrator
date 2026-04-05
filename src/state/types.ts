/**
 * Shared state types used by reviewer modules.
 * These mirror the orchestrator's StateStore schema so the reviewer
 * can read from the same shared state.db.
 */

export type TaskStatus = "pending" | "dispatched" | "done" | "failed";
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
  id: string;
  action: string;
  agent_name?: string | null;
  task_id?: string | null;
  reason: string;
  outcome: string;
  created_at: string;
}

export interface MergeQueueEntry {
  repo: string;
  pr_number: number;
  branch: string;
  status: "queued" | "merging" | "merged" | "failed";
  position: number;
  error?: string | null;
  created_at: string;
}

export interface AgentStats {
  agent_name: string;
  total: number;
  done: number;
  failed: number;
}

/**
 * Minimal StateStore interface consumed by reviewer modules.
 * The orchestrator daemon injects its full StateStore — this interface
 * ensures reviewers only depend on what they actually use.
 */
export interface IStateStore {
  // Task operations
  getTask(id: string): Task | null;
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
