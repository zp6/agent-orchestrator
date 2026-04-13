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
export { PRReviewer, enforceChecklist, validateClosesReferences, isExampleOrTemplateFile, isPlaceholderCredential } from "./reviewer/pr-reviewer.js";
export type { PRInfo, PRReviewResult, RedispatchCategory, ConflictStats, CrossRepoCloseIssue } from "./reviewer/pr-reviewer.js";

// Schema-consumer impact detection
export {
  detectSchemaChanges,
  extractChangedFilesFromDiff,
  buildSchemaImpactNotice,
  SCHEMA_CONSUMER_MAP,
} from "./reviewer/schema-impact.js";
export type { SchemaConsumerEntry, SchemaImpactHit } from "./reviewer/schema-impact.js";

export { Verifier } from "./reviewer/verifier.js";
export type { VerificationResult } from "./reviewer/verifier.js";
export type { SubtaskRollupPolicy, SubtaskRollupResult, SubtaskChildSummary } from "./state/types.js";

export { Supervisor, extractIssueRefs, isDecisionAlreadyResolved, isConcreteDispatch, formatAgentHealthSection, formatTimeAgo, formatConflictStatsSection, formatPRConfidenceSection, formatRoutingAccuracySection, formatQualityByTaskTypeSection } from "./reviewer/supervisor.js";
export type { SupervisorDecision, ConflictStatsProvider, PRConfidenceProvider, RoutingAccuracyProvider } from "./reviewer/supervisor.js";

export { RoutingAccuracyTracker } from "./reviewer/routing-accuracy.js";

export {
  ScoreCalibrator,
  detectOverApproval,
  CALIBRATION_MIN_SAMPLE_SIZE,
  CALIBRATION_TARGET_MERGE_RATE,
  CALIBRATION_THRESHOLD_ACTION_DIFF,
} from "./reviewer/score-calibrator.js";
export type {
  PROutcome,
  ScoreCalibrationRow,
  AdjustedThreshold,
  RecordOutcomeOpts,
  CalibrationReport,
} from "./reviewer/score-calibrator.js";

export {
  classifyIssueAge,
  buildIssueAgeEntry,
  buildIssueAgeHeatmap,
  collectIssueAgeEscalations,
  formatIssueAgeHeatmap,
  hasRecentAgeNudge,
  hasRecentAgeDispatchDecision,
} from "./reviewer/issue-age.js";
export type {
  IssueAgeBucket,
  IssueAgeSeverity,
  IssueAgeEntry,
  IssueAgeBucketSummary,
  IssueAgeHeatmap,
  IssueAgeEscalationCandidate,
} from "./reviewer/issue-age.js";

export { ImprovementDetector } from "./reviewer/improvement-detector.js";
export type { DetectedImprovement } from "./reviewer/improvement-detector.js";

// PR iteration metrics (issue #110)
export { PRIterationMetrics, categoriseReviewComment, formatIterationReport } from "./reviewer/pr-iteration-metrics.js";
export type { PRIterationStorePort } from "./reviewer/pr-iteration-metrics.js";

export { IssueCreator } from "./reviewer/issue-creator.js";
export type { CreatedIssue } from "./reviewer/issue-creator.js";

// Telegram notifications
export { createNotifier } from "./notify.js";
export type { Notifier, NotifyUrgency } from "./notify.js";
export { HealthRecoveryTracker, formatDurationShort } from "./health-recovery.js";
export type { HealthRecoveryEvent, HealthRecoveryObservation } from "./health-recovery.js";

// Telegram command handler (two-way, wired to live state.db)
export { TelegramCommandHandler } from "./telegram/command-handler.js";

// Config types
export type { ReviewerConfig, AgentConfig } from "./config.js";

// State types and SQLite store
export { StateStore } from "./state/store.js";
export type {
  IStateStore,
  IScoreOutcomeStore,
  IPRIterationStore,
  IStandupHealthStore,
  IVerificationResultStore,
  ITelegramStateStore,
  Task,
  MergeQueueEntry,
  AgentStats,
  EfficiencyTrendPoint,
  EfficiencyTrendSeries,
  EfficiencyTrend,
  AgentHealth,
  SupervisorDecisionRecord,
  SupervisorDecisionQuery,
  SystemFlag,
  DispatchRequest,
  DispatchRationale,
  PRConfidenceRecord,
  RoutingAccuracyStats,
  AgentQualityByTaskType,
  AgentTaskTypeQuality,
  PROutcomeRecord,
  ReviewCategory,
  PRIterationStat,
  AgentIterationStat,
  ReviewCategoryCount,
  PRIterationReport,
  StandupSynthesisLabel,
  StandupSynthesisEvent,
  StandupHealthPoint,
  StandupHealthSummary,
  VerificationResultRecord,
  VerificationStats,
} from "./state/types.js";

// Supervisor decision log — queryable log for orch CLI and dashboard consumers
export { querySupervisorLog, formatSupervisorLogForCLI, formatRationaleSummary } from "./supervisor-log.js";

// LLM client
export { createLLMClient, resetLLMClient } from "./client/llm-client.js";

// Integration adapter (also available via 'claude-orchestrator-reviewer/integration')
export { createReviewerInstances } from "./integration/orchestrator-adapter.js";
export type { ReviewerInstances, CreateReviewerOptions } from "./integration/orchestrator-adapter.js";
