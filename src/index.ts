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
// Per-agent series includes rolling_avg, below_threshold flag for warning colour,
// band per data point ("red"/"yellow"/"green"), and optional task_history_url.
export { getAgentTrendsApiPayload } from "./reviewer/agent-trends.js";
export type { AgentTrendsOptions } from "./reviewer/agent-trends.js";

// Fleet health sparklines — `/fleet-health` API payload (issue #286).
//
// Wraps per-agent quality sparklines with dual-band coloring (red < 0.60,
// yellow 0.60–0.74, green ≥ 0.75), click-through task history URLs, and a
// fleet-level risk summary (count of agents per band).
//
// Mount in the orchestrator or dashboard server:
//   app.get('/fleet-health', (_req, res) => res.json(
//     getFleetHealthSparklines(store, { task_history_base_url: '/tasks' })
//   ));
export { getFleetHealthSparklines, FLEET_RED_THRESHOLD, FLEET_YELLOW_THRESHOLD, FLEET_DEFAULT_DAYS } from "./reviewer/fleet-health-sparklines.js";
export type { FleetHealthSparklineOptions } from "./reviewer/fleet-health-sparklines.js";
export type { FleetHealthSparklines, FleetRiskSummary, SparklineBand } from "./state/types.js";

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

// Meta-quality gate (issue #357) — elevated floor for quality-enforcement tasks.
export {
  isMetaQualityTask,
  matchedMetaQualityKeyword,
  applyMetaQualityGateToResult,
  buildMetaQualityAlertBody,
  META_QUALITY_FLOOR,
  META_QUALITY_KEYWORDS,
} from "./reviewer/meta-quality-gate.js";
export type {
  MetaQualityGateInput,
  MetaQualityGateOutput,
} from "./reviewer/meta-quality-gate.js";
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

export {
  RoutingViolationDetector,
  detectViolation,
  buildRepoOwnerMap,
  formatViolationsForDisplay,
} from "./reviewer/routing-violations.js";

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

// Cross-agent in-flight duplicate dispatch guard (issue #336) — blocks dispatch when
// another agent already has an active task for the same GitHub issue, preventing
// competing agents from implementing the same feature simultaneously.
export {
  CrossAgentInflightGuard,
  IN_FLIGHT_STATUSES,
  extractIssueNumberFromInflightRef,
} from "./reviewer/cross-agent-inflight-guard.js";
export type {
  InFlightCheckRequest,
  InFlightCheckResult,
  InFlightStatus,
} from "./reviewer/cross-agent-inflight-guard.js";

// Semantic duplicate guard (issue #275) — pre-dispatch token-overlap similarity
// check to detect when two open issues describe the same feature, preventing
// double-implementation cost and merge conflicts from competing PRs.
export {
  checkSemanticDuplicates,
  formatDedupCandidates,
  tokenize,
  jaccardSimilarity,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_WINDOW_HOURS,
} from "./reviewer/semantic-duplicate-guard.js";
export type {
  RecentDispatchedIssue,
  DedupCandidate,
  SemanticDuplicateCheckResult,
  SemanticDuplicateGuardOptions,
} from "./reviewer/semantic-duplicate-guard.js";

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

export { IssueCreator, DEFAULT_MAX_CROSS_REPO_ISSUES } from "./reviewer/issue-creator.js";
export type {
  CreatedIssue,
  DeferredFollowUp,
  CreateAcrossReposResult,
  CreateAcrossReposOptions,
} from "./reviewer/issue-creator.js";

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
// APPROVAL_SCORE_FLOOR is exported separately so callers can reference the
// hard floor constant without importing the full StateStore class (issue #266).
export { StateStore, APPROVAL_SCORE_FLOOR } from "./state/store.js";
export type { ILowScoreFeedStore } from "./state/types.js";
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

// Low-score approved task feed — `/api/low-score-approved` API payload (issue #278).
//
// Surfaces approved tasks with quality_score < 0.75 (configurable) so operators
// can audit marginal approvals before they cause downstream issues.
// Each entry includes score, per-dimension breakdown, agent, and PR link.
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/low-score-approved', (req, res) => {
//     res.json(getLowScoreApprovedFeed(store, {
//       threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
//       limit: req.query.limit ? Number(req.query.limit) : undefined,
//     }));
//   });
//
// Telegram `/low-score [threshold] [limit]` command uses formatLowScoreFeedForTelegram().
export {
  getLowScoreApprovedFeed,
  formatLowScoreFeedForTelegram,
  LOW_SCORE_FEED_THRESHOLD,
  LOW_SCORE_FEED_DEFAULT_LIMIT,
} from "./reviewer/low-score-feed.js";
export type {
  LowScoreFeed,
  LowScoreFeedEntry,
  LowScoreFeedOptions,
  LowScoreFeedAgentSummary,
} from "./reviewer/low-score-feed.js";

// Low-score approval real-time alerter — Telegram notifications (issue #331).
//
// Sends immediate Telegram push alerts when a task is approved with
// score < 0.70, including score, dimension breakdown, and approval rationale.
// Helps operators catch risky approvals before they're merged.
//
// Integration (via ReviewerInstances in orchestrator-adapter):
//   const { lowScoreApprovalAlerter } = createReviewerInstances(config, store, { notifier });
//   await lowScoreApprovalAlerter?.checkAndAlert(verificationResult, task);
//
// Direct usage:
//   import { LowScoreApprovalAlerter } from 'claude-orchestrator-reviewer';
//
//   const alerter = new LowScoreApprovalAlerter(notifier, { scoreThreshold: 0.70 });
//   await alerter.checkAndAlert(verificationResult, task);
export {
  LowScoreApprovalAlerter,
  LOW_SCORE_APPROVAL_ALERT_THRESHOLD,
} from "./reviewer/low-score-approval-alerter.js";
export type {
  LowScoreApprovalAlerterOptions,
} from "./reviewer/low-score-approval-alerter.js";

// Quality System Health — `/api/quality-system-health` API payload (issue #304).
//
// Surfaces bypass rate trending: how often the 0.60 quality floor is being
// circumvented. Includes per-cycle banner, 7-day sparkline, and breakdown of
// bypass reasons (operator_override vs marginal_auto).
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/quality-system-health', (_req, res) => {
//     res.json(getQualitySystemHealthPayload(store));
//   });
//
// Telegram `/quality-health` command uses formatQualitySystemHealthPage().
export {
  getQualitySystemHealthPayload,
  formatQualitySystemHealthPage,
  QualitySystemHealthMonitor,
  QUALITY_FLOOR,
  BYPASS_RATE_ALERT_THRESHOLD,
  DEFAULT_SPARKLINE_DAYS,
  DEFAULT_CYCLE_TASK_LIMIT,
} from "./reviewer/quality-system-health.js";
export type {
  QualitySystemHealthPayload,
  QualitySystemHealthOptions,
  QualitySystemHealthMonitorOptions,
  BypassedTask,
  SparklineDay,
  BypassReason,
  BypassBand,
} from "./reviewer/quality-system-health.js";

// CLI smoke test verifier (issue #274)
export {
  runCLISmokeTest,
  validateCLISmokeResult,
  formatSmokeTestReport,
  getFleetSmokeTestSpecs,
} from "./reviewer/cli-smoke-test.js";
export type {
  CLISmokeTestSpec,
  CLISmokeTestResult,
} from "./reviewer/cli-smoke-test.js";

// Capability check — `/capability-check` endpoint handler (issue #325).
//
// The reviewer agent is implementation-ineligible: it only accepts review,
// verification, supervision, improvement-detection, and own-repo tasks.
// Implementation tasks for foreign repos are rejected so the orchestrator
// reroutes them to the repo's home agent.
//
// Mount in the agent's HTTP server:
//   app.get('/capability-check', (req, res) => res.json(handleCapabilityCheck(req.query)));
//
// Or use evaluateCapability() directly for local enforcement.
export {
  evaluateCapability,
  handleCapabilityCheck,
  parseCapabilityCheckQuery,
  REVIEWER_REPO,
  ALLOWED_TASK_TYPES,
  ALLOWED_SOURCES,
} from "./reviewer/capability-check.js";
export type {
  CapabilityCheckRequest,
  CapabilityCheckResult,
} from "./reviewer/capability-check.js";

// Pre-dispatch capability enforcer — routing boundary gate (issue #330).
//
// Intercepts tasks before they are sent to claude-orchestrator-reviewer and
// blocks any task that contains authorship keywords (implement, create PR,
// write, build) targeting a foreign repo.  Returns the correct reroute target
// and fires a Telegram alert with the original vs. corrected routing so
// operators can track boundary violations.
//
// Usage (in the orchestrator dispatcher, before sending to the reviewer):
//
//   const enforcer = new PreDispatchCapabilityEnforcer(config, notifier);
//   const result = await enforcer.check({
//     task_title: task.title,
//     task_type: task.task_type ?? "implementation",
//     source_ref: task.source_ref,
//     target_agent: resolvedAgent,
//   });
//   if (!result.allowed) {
//     const corrected = result.reroute_to ?? fallbackAgent;
//     // dispatch to corrected instead
//   }
export {
  PreDispatchCapabilityEnforcer,
  shouldBlock,
  findAuthorshipKeyword,
  extractRepoFromRef,
  REVIEWER_AGENT_NAME,
  AUTHORSHIP_KEYWORDS,
} from "./reviewer/pre-dispatch-capability-enforcer.js";
export type {
  PreDispatchCheckRequest,
  PreDispatchCheckResult,
} from "./reviewer/pre-dispatch-capability-enforcer.js";

// Dispatch cascade analyzer
export {
  DispatchCascadeAnalyzer,
  MAX_CASCADE_DEPTH,
  DEFAULT_MAX_CROSS_REPO_FOLLOWUP_DEPTH,
} from "./reviewer/dispatch-cascade-analyzer.js";
export type {
  DispatchCascadeAnalyzerOptions,
  CascadeNode,
  CascadeSummary,
  FollowUpDispatchResult,
} from "./reviewer/dispatch-cascade-analyzer.js";

// Proactive rebase scheduler — issue #335.
//
// Detects open PRs where HEAD has diverged from main by ≥ N commits (default: 3)
// AND the PR has been open > 24h. For each stale PR, emits a `StalePRRebaseTask`
// for the orchestrator to dispatch as a rebase task — no operator input required.
//
// The `classifyRebaseTask()` helper lets the conflict-recovery reroute monitor
// distinguish proactive (scheduled before conflict) from reactive (after conflict)
// rebases, fulfilling the "count separately" acceptance criterion.
//
// Integration (in the orchestrator daemon loop):
//   const scheduler = new ProactiveRebaseScheduler(notifier, { divergeThreshold: 3 });
//   const { stalePRs } = await scheduler.run("owner/repo");
//   for (const task of stalePRs) {
//     await dispatcher.dispatch({ title: task.taskTitle, description: task.taskDescription });
//   }
//   // Record reactive rebases from the conflict-recovery path:
//   scheduler.recordReactiveRebase();
//   // Surface combined stats in the dashboard:
//   const stats = scheduler.getStats(); // { proactiveScheduled, reactiveRecorded, ... }
export {
  ProactiveRebaseScheduler,
  classifyRebaseTask,
  formatProactiveRebaseAlert,
  fetchOpenPRRecords,
  countCommitsBehind,
  hoursAgo,
  DEFAULT_DIVERGE_THRESHOLD,
  DEFAULT_MIN_PR_AGE_HOURS,
  DEFAULT_SCHEDULE_COOLDOWN_MS,
  MAX_STALE_PRS_PER_RUN,
} from "./reviewer/proactive-rebase-scheduler.js";
export type {
  OpenPRRecord,
  StalePRRebaseTask,
  RebaseStats,
  RebaseSchedulerRunResult,
  ProactiveRebaseSchedulerOptions,
  RebaseClassification,
} from "./reviewer/proactive-rebase-scheduler.js";

// LLM client
export { createLLMClient, resetLLMClient } from "./client/llm-client.js";

// Integration adapter (also available via 'claude-orchestrator-reviewer/integration')
export { createReviewerInstances } from "./integration/orchestrator-adapter.js";
export type { ReviewerInstances, CreateReviewerOptions } from "./integration/orchestrator-adapter.js";
