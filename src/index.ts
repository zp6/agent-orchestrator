/**
 * claude-orchestrator-reviewer
 *
 * Quality and oversight layer for the Claude Agent Orchestrator.
 * Provides PR review, task verification, supervision, and improvement detection.
 *
 * Usage (from the orchestrator daemon):
 *
 *   import { PRReviewer, Verifier, Supervisor, ImprovementDetector, IssueCreator, createNotifier } from 'claude-orchestrator-reviewer';
 *   // or use the one-call factory:
 *   import { createReviewerInstances } from 'claude-orchestrator-reviewer/integration';
 *
 *   const { reviewer, verifier, supervisor, detector, issueCreator } =
 *     createReviewerInstances(config, store, { onAgentRestart: (repo) => deployer.restartAgentsForRepo(repo) });
 *   const notify = createNotifier();
 */

// Core reviewer modules
export { PRReviewer, enforceChecklist } from "./reviewer/pr-reviewer.js";
export type { PRInfo, PRReviewResult } from "./reviewer/pr-reviewer.js";

export { Verifier } from "./reviewer/verifier.js";
export type { VerificationResult } from "./reviewer/verifier.js";

export { Supervisor, extractIssueRefs, isDecisionAlreadyResolved, isConcreteDispatch } from "./reviewer/supervisor.js";
export type { SupervisorDecision } from "./reviewer/supervisor.js";

export { ImprovementDetector } from "./reviewer/improvement-detector.js";
export type { DetectedImprovement } from "./reviewer/improvement-detector.js";

export { IssueCreator } from "./reviewer/issue-creator.js";
export type { CreatedIssue } from "./reviewer/issue-creator.js";

// Telegram notifications
export { createNotifier } from "./notify.js";
export type { Notifier, NotifyUrgency } from "./notify.js";

// Telegram command handler (two-way, wired to live state.db)
export { TelegramCommandHandler } from "./telegram/command-handler.js";

// Config types
export type { ReviewerConfig, AgentConfig } from "./config.js";

// State types and SQLite store
export { StateStore } from "./state/store.js";
export type {
  IStateStore,
  ITelegramStateStore,
  Task,
  MergeQueueEntry,
  AgentStats,
  SupervisorDecisionRecord,
  SystemFlag,
  DispatchRequest,
} from "./state/types.js";

// LLM client
export { createLLMClient, resetLLMClient } from "./client/llm-client.js";

// Integration adapter (also available via 'claude-orchestrator-reviewer/integration')
export { createReviewerInstances } from "./integration/orchestrator-adapter.js";
export type { ReviewerInstances, CreateReviewerOptions } from "./integration/orchestrator-adapter.js";
