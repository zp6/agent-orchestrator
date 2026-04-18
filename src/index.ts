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
  detectSchemaContractDrift,
  extractChangedFilesFromDiff,
  buildSchemaImpactNotice,
  buildDownstreamImpactSection,
  SCHEMA_CONSUMER_MAP,
} from "./reviewer/schema-impact.js";
export {
  loadSchemaContractRegistry,
  validateStoreSchemaAgainstContract,
  extractStoreColumnsFromSource,
} from "./reviewer/schema-contract.js";
export type {
  SchemaConsumerEntry,
  SchemaImpactHit,
} from "./reviewer/schema-impact.js";
export type {
  SchemaContractValidationWarning,
  SchemaContractValidationResult,
} from "./reviewer/schema-contract.js";

// Agent quality trend sparklines — `/agent-trends` API payload (issue #156).
//
// Mount in the orchestrator or dashboard server:
//   app.get('/agent-trends', (_req, res) => res.json(getAgentTrendsApiPayload(store)));
//
// Per-agent series includes rolling_avg and below_threshold flag for warning colour.
export { getAgentTrendsApiPayload } from "./reviewer/agent-trends.js";
export type { AgentTrendsOptions } from "./reviewer/agent-trends.js";

// Quality anomaly feed — `/quality-anomalies` API payload (issue #153).
//
// Mount in the orchestrator or dashboard server:
//   app.get('/quality-anomalies', (_req, res) => res.json(getQualityAnomaliesApiPayload(store)));
export { getQualityAnomaliesApiPayload } from "./reviewer/quality-anomalies.js";
export {
  QualityAnomalySpikeDetector,
  formatQualityAnomalySpikeAlert,
} from "./reviewer/quality-anomalies.js";
export type {
  QualityAnomaliesOptions,
  QualityAnomalySpikeDetectorOptions,
  QualityAnomalySpikeSummary,
} from "./reviewer/quality-anomalies.js";

// Schema-consumer auto-discovery registry (issue #99).
// Replaces the static SCHEMA_CONSUMER_MAP with a live map derived from
// state.db PRAGMA queries and StateStore method instrumentation.
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/schema-consumers', (_req, res) => res.json(getSchemaConsumersApiPayload()));
//
// Use in the reviewer at PR-review time:
//   const map = await fetchSchemaConsumerMap('http://localhost:3472');
//   const hits = detectSchemaChanges(diff, files, map);
export {
  SchemaConsumerRegistry,
  getSchemaConsumersApiPayload,
  fetchSchemaConsumerMap,
} from "./reviewer/schema-consumer-registry.js";
export type {
  TableAccessRecord,
  SchemaConsumerApiPayload,
} from "./reviewer/schema-consumer-registry.js";

export {
  Verifier,
  RESEARCH_OUTPUT_SCHEMA,
  RESEARCH_REQUIRED_SECTIONS,
  TRIAGE_OUTPUT_SCHEMA,
  TRIAGE_REQUIRED_FIELDS,
  PRIORITY_FLOOR_THRESHOLD,
  PRIORITY_QUALITY_FLOOR,
} from "./reviewer/verifier.js";
export type { VerificationResult, QualityDimensions } from "./reviewer/verifier.js";
export type { SubtaskRollupPolicy, SubtaskRollupResult, SubtaskChildSummary, ShortCircuitDimension, ScoreCoverageMetric } from "./state/types.js";

export { Supervisor, extractIssueRefs, isDecisionAlreadyResolved, isConcreteDispatch, formatAgentHealthSection, formatTimeAgo, formatConflictStatsSection, formatPRConfidenceSection, formatRoutingAccuracySection, formatQualityByTaskTypeSection } from "./reviewer/supervisor.js";
export type { SupervisorDecision, ConflictStatsProvider, PRConfidenceProvider, RoutingAccuracyProvider } from "./reviewer/supervisor.js";

// Per-agent triage coaching directives (issue #245).
// Injects agent-specific schema coaching into housekeeping dispatch prompts
// when the agent's rolling triage score drops below 0.80.
export {
  TriageCoachingAdvisor,
  buildTriageCoachingDirective,
  formatTriageCoachingSection,
  injectTriageCoachingIntoPrompt,
  TRIAGE_COACHING_THRESHOLD,
  TRIAGE_COACHING_WINDOW,
} from "./reviewer/triage-coaching.js";
export type {
  TriageCoachingDirective,
  TriageCoachingProvider,
  AgentTriageStats,
} from "./reviewer/triage-coaching.js";

export { RoutingAccuracyTracker } from "./reviewer/routing-accuracy.js";

export { RerouteQualityTracker } from "./reviewer/reroute-quality-tracker.js";
export type {
  RerouteDecision,
  RerouteQualityStats,
  RerouteQualityReport,
  RerouteQualityProvider,
} from "./reviewer/reroute-quality-tracker.js";

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

// Health incident routing (issue #104) — routes diagnostic incidents to Telegram
export { HealthIncidentRouter } from "./reviewer/health-incident-router.js";
export type { HealthIncident, HealthIncidentProvider } from "./reviewer/health-incident-router.js";

// Standup dispatch guard (issue #98) — skip dispatch for zero-action standups
export {
  shouldSkipStandupDispatch,
  looksLikeStandupTask,
  extractStandupIssueNumber,
} from "./reviewer/standup-dispatch-guard.js";
export type {
  StandupDispatchDecision,
  StandupDispatchGuardOptions,
} from "./reviewer/standup-dispatch-guard.js";

// Standup batch splitter (issue #259) — split large standups into sequential child task batches
export {
  parseActionItems,
  splitIntoBatches,
  formatBatchAsTask,
  BATCH_SIZE,
  SPLIT_THRESHOLD,
} from "./reviewer/standup-batch-splitter.js";
export type {
  ActionItem,
  StandupBatch,
  BatchSplitResult,
} from "./reviewer/standup-batch-splitter.js";

// Score integrity audit (issue #263) — bucket breakdown, violation list, and gate status
export {
  getScoreIntegrityReport,
  isEnforcementActive,
  SCORE_BUCKETS,
  DEFAULT_MIN_SCORE,
} from "./reviewer/score-integrity.js";
export type {
  ScoreBucketCount,
  ViolationEntry,
  ScoreIntegrityReport,
} from "./reviewer/score-integrity.js";

// PR existence guard (issue #178) — skip re-dispatch when open PR already exists
export {
  checkPRExistenceBeforeDispatch,
  looksLikeGitHubIssueTask,
  extractIssueNumberFromSourceRef,
  extractRepoFromSourceRef,
  formatPRCheckResult,
  fetchOpenPRs,
  findMatchingPR,
} from "./reviewer/pr-existence-guard.js";
export type {
  PRExistenceCheckResult,
  PRExistenceResolution,
  OpenPRSummary,
  ShortCircuitCallback,
  PRExistenceGuardOptions,
} from "./reviewer/pr-existence-guard.js";

// Duplicate-dispatch surge detector (issue #262) — Telegram alert when >= 3 already-in-review
// blocks occur within a 30-minute window; 2-hour cooldown prevents alert fatigue.
export { DuplicateDispatchSurgeDetector } from "./reviewer/duplicate-dispatch-surge-detector.js";
export type {
  SurgeEvent,
  SurgeAlertConfig,
} from "./reviewer/duplicate-dispatch-surge-detector.js";

// Standup handler utilities (used by guard and PR reviewer)
export {
  isStandupIssue,
  extractActionItemCount,
  handleZeroActionStandup,
  isSynthesisFailed,
  detectSynthesisLabel,
  buildStandupAcknowledgmentComment,
  applyGitHubSynthesisLabel,
  checkAndEscalateFallbackThreshold,
  postFallbackActionItems,
  generateFallbackActionItems,
} from "./reviewer/standup-handler.js";
export type { GitHubIssue } from "./reviewer/standup-handler.js";

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
  ISecretsHealthStore,
  ITelegramStateStore,
  IQualityAnomalyStore,
  Task,
  MergeQueueEntry,
  AgentStats,
  EfficiencyTrendPoint,
  EfficiencyTrendSeries,
  EfficiencyTrend,
  AgentQualityTrendPoint,
  AgentQualityTrendSeries,
  AgentQualityTrend,
  QualityAnomalyType,
  QualityAnomaly,
  QualityAnomalyQuery,
  QualityAnomalyFeed,
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
  SecretMountStatus,
  SecretHealthEntry,
  SecretsHealthCheckRecord,
  AgentSecretsHealthSummary,
  SecretsFleetHealthSummary,
  QualityAnomalySummary,
  ReconciliationStatus,
  ReconciliationEventRecord,
  ReconciliationLastPerRepo,
} from "./state/types.js";

// Supervisor decision log — queryable log for orch CLI and dashboard consumers
export {
  querySupervisorLog,
  formatSupervisorLogForCLI,
  formatRationaleSummary,
  buildRoutingDecisions,
  classifyRoutingDecisionCategory,
  formatDecisionsForTelegram,
  formatDecisionsForCLI,
} from "./supervisor-log.js";
export type { RoutingDecisionEntry, RoutingDecisionCategory } from "./supervisor-log.js";

export {
  getReroutesApiPayload,
  formatConflictRecoveryAlert,
  ConflictRecoveryAlertMonitor,
  CONFLICT_RECOVERY_RATE_THRESHOLD,
  DEFAULT_REROUTE_WINDOW_HOURS,
} from "./reviewer/reroute-conflict-recovery.js";
export type {
  ReroutesApiOptions,
  ReroutesApiPayload,
  AgentConflictRecoveryRate,
  RepoConflictRecoveryRate,
  ConflictRecoveryAlertPayload,
  ConflictRecoveryAlertRow,
} from "./reviewer/reroute-conflict-recovery.js";

// LLM client
export { createLLMClient, resetLLMClient } from "./client/llm-client.js";

// Integration adapter (also available via 'claude-orchestrator-reviewer/integration')
export { createReviewerInstances } from "./integration/orchestrator-adapter.js";
export type { ReviewerInstances, CreateReviewerOptions } from "./integration/orchestrator-adapter.js";
