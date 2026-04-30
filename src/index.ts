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
export {
  PRReviewer,
  enforceChecklist,
  validateClosesReferences,
  isExampleOrTemplateFile,
  isPlaceholderCredential,
  normalizeAllowedBaseBranches,
} from "./reviewer/pr-reviewer.js";
export type { PRInfo, PRReviewResult, RedispatchCategory, ConflictStats, CrossRepoCloseIssue } from "./reviewer/pr-reviewer.js";

// PR scope pre-flight check (issue #358) — detects bundled / multi-issue PRs
// before the LLM review round is triggered.
export {
  checkPRScope,
  formatScopeViolationComment,
  extractClosesRefs,
  extractFilesFromDiff,
} from "./reviewer/pr-scope-checker.js";
export type {
  PRScopeCheckResult,
  PRScopeViolationType,
  FeatureGroup,
  PRScopeCheckerOptions,
} from "./reviewer/pr-scope-checker.js";

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

// Scope-contract preflight checks for hard dispatch limits
export {
  checkScopeContract,
  extractScopeContractConstraints,
  formatScopeContractViolationComment,
} from "./reviewer/scope-contract.js";
export type {
  ScopeContractCheckResult,
  ScopeContractConstraint,
  ScopeContractViolationType,
} from "./reviewer/scope-contract.js";

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
  PROPOSAL_OUTPUT_SCHEMA,
  PROPOSAL_REQUIRED_SECTIONS,
  PRIORITY_FLOOR_THRESHOLD,
  PRIORITY_QUALITY_FLOOR,
  // Bypass-reason gate (issue #379)
  BYPASS_REASON_FLOOR,
  checkBypassReasonGate,
  buildBypassRejectionFeedback,
} from "./reviewer/verifier.js";
export type {
  VerificationResult,
  QualityDimensions,
  // Bypass-reason gate (issue #379)
  BypassReasonGateResult,
  BypassReasonGateOutcome,
} from "./reviewer/verifier.js";

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
  validateOldRankInPriorityReordering,
  TRIAGE_COACHING_THRESHOLD,
  TRIAGE_COACHING_WINDOW,
} from "./reviewer/triage-coaching.js";
export type {
  TriageCoachingDirective,
  TriageCoachingProvider,
  AgentTriageStats,
  OldRankViolation,
  OldRankValidationResult,
} from "./reviewer/triage-coaching.js";

// Triage health report — /triage-health Telegram command + /api/triage-health payload (issue #409).
//
// Per-agent triage schema pass/fail rates, missing-field frequencies, revision counts,
// and 7-day trend so operators can see whether coaching is working.
//
// Issue #413 additions: first-pass approval rate and pre-submission validator call rate
// (calls to POST /api/validate-triage-schema per task submitted in the window).
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/triage-health', (req, res) => res.json(
//     getTriageHealthPayload(store, req.query.agent as string | undefined)
//   ));
export {
  getTriageHealthPayload,
  formatTriageHealthForTelegram,
  fetchConsecutiveFailureBlocks,
  TRIAGE_HEALTH_CURRENT_DAYS,
  TRIAGE_HEALTH_PRIOR_DAYS,
  TRIAGE_PASS_THRESHOLD,
} from "./reviewer/triage-health.js";
export type {
  TriageHealthReport,
  AgentTriageHealthEntry,
  AgentTriagePeriodStats,
  ValidatorCallStats,
  ITriageHealthStore,
} from "./reviewer/triage-health.js";

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
  CalibrationRecommendation,
  CalibrationRecommendationStatus,
} from "./reviewer/score-calibrator.js";

// Calibration recommendations REST feed — issue #477
export {
  getCalibrationRecommendationsFeed,
  resolveCalibrationRecommendationById,
} from "./reviewer/calibration-recommendations-feed.js";
export type {
  CalibrationRecommendationsFeedOptions,
  CalibrationRecommendationsSummary,
  CalibrationRecommendationsFeed,
  CalibrationResolveOk,
  CalibrationResolveError,
  CalibrationResolveResult,
} from "./reviewer/calibration-recommendations-feed.js";

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

export { ImprovementDetector, computeBatchHash } from "./reviewer/improvement-detector.js";
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
  IPRGuardCooldownStore,
} from "./reviewer/pr-existence-guard.js";

// PR guard cooldown feed — /api/pr-guard-cooldowns payload (issue #420).
// Lists all active (non-expired) cooldown entries so callers can pre-filter
// a full dispatch batch in one DB call.
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/pr-guard-cooldowns', (req, res) => res.json(
//     getPRGuardCooldownFeedPayload(store, req.query.repo as string | undefined)
//   ));
export { getPRGuardCooldownFeedPayload } from "./reviewer/pr-guard-cooldown-feed.js";
export type {
  PRGuardCooldownEntry,
  PRGuardCooldownFeedPayload,
  IPRGuardCooldownFeedStore,
} from "./reviewer/pr-guard-cooldown-feed.js";

// Per-issue PR guard cooldown check endpoint (issue #1112) — allows the orchestrator/proxy
// to query whether a (repo, issue) pair is under cooldown BEFORE dispatching, eliminating
// redundant task creation for issues already under review.
//
// Mount in the orchestrator or reviewer HTTP server:
//   app.get('/api/pr-guard-cooldown/check', (req, res) => {
//     const r = parseCooldownCheckParams(req.query);
//     if (!r.ok) return res.status(400).json(formatCooldownCheckError(r.error));
//     res.json(getCooldownCheckPayload(store, r.params.repo, r.params.issueNumber));
//   });
export {
  getCooldownCheckPayload,
  parseCooldownCheckParams,
  formatCooldownCheckError,
} from "./reviewer/pr-guard-cooldown-check.js";
export type {
  IPRGuardCooldownCheckStore,
  PRGuardCooldownCheckPayload,
  CooldownCheckParams,
} from "./reviewer/pr-guard-cooldown-check.js";

// Duplicate-dispatch surge detector (issue #262) — Telegram alert when >= 3 already-in-review
// blocks occur within a 30-minute window; 2-hour cooldown prevents alert fatigue.
export { DuplicateDispatchSurgeDetector } from "./reviewer/duplicate-dispatch-surge-detector.js";
export type {
  SurgeEvent,
  SurgeAlertConfig,
} from "./reviewer/duplicate-dispatch-surge-detector.js";

// PR guard surge detector (issues #442 / #1113, coordinated change 01KQ0HZ3D8YZ3SMKEW2N71AFX2)
// — Telegram alert when the same (repo, issue) pair triggers already-in-review ≥ 2 times
// within a 60-minute window (surge alert, deduped by 60-min cooldown).  When the same pair
// triggers ≥ 5 times within a 30-minute window, a 2-hour dispatch suppression entry is written
// via IPRGuardCooldownStore and a dedicated alert fires with "dispatch suppressed until HH:MM UTC
// — no action needed."  Leading indicator of cooldown-table failures or dispatcher polling loops.
// Issue #468: suppressions are now also persisted to the pr_guard_surge_suppressions SQLite
// table via IPRGuardSurgeSuppressionStore, giving cross-restart visibility.
export {
  PRGuardSurgeDetector,
  PR_GUARD_SURGE_THRESHOLD,
  PR_GUARD_SURGE_WINDOW_MS,
  PR_GUARD_SURGE_COOLDOWN_MS,
  PR_GUARD_SUPPRESSION_THRESHOLD,
  PR_GUARD_SUPPRESSION_WINDOW_MS,
  PR_GUARD_SUPPRESSION_TTL_MINUTES,
  PR_GUARD_PREFLIGHT_REQUIRED,
} from "./reviewer/pr-guard-surge-detector.js";
export type {
  PRGuardHit,
  PRGuardSurgeConfig,
  IPRGuardSurgeSuppressionStore,
} from "./reviewer/pr-guard-surge-detector.js";

// PR guard surge suppressions feed — /pr-guard-surge-suppressions endpoint (issue #468).
// Returns all active entries from the pr_guard_surge_suppressions table, giving operators
// dashboard visibility into which (repo, issue) pairs are in a 2-hour suppression window.
// Mount: app.get('/pr-guard-surge-suppressions', (req, res) => res.json(
//   getPRGuardSurgeSuppressionsFeedPayload(store, req.query.repo as string | undefined)
// ));
export { getPRGuardSurgeSuppressionsFeedPayload } from "./reviewer/pr-guard-surge-suppressions-feed.js";
export type {
  PRGuardSurgeSuppressionEntry,
  PRGuardSurgeSuppressionsFeedPayload,
  IPRGuardSurgeSuppressionsFeedStore,
} from "./reviewer/pr-guard-surge-suppressions-feed.js";

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
export {
  canonicalizeAgentVariantName,
  getAgentVariantFamily,
} from "./state/agent-variant.js";
export type { ILowScoreFeedStore, IBypassAuditStore, ICalibrationRecommendationStore } from "./state/types.js";
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

// Score-bypass violation report — `/api/score-violations` API payload (issue #356).
//
// Lists all tasks approved below a configurable threshold (default 0.80) in a
// rolling window, grouped by agent, with score, dimension breakdown,
// marginal_reason badge, and score bucket classification.
//
// Mount in the orchestrator or dashboard server:
//   import { getScoreViolationsPayload } from 'claude-orchestrator-reviewer';
//
//   app.get('/api/score-violations', (req, res) => {
//     res.json(getScoreViolationsPayload(store, {
//       threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
//       days: req.query.days ? Number(req.query.days) : undefined,
//       agent: req.query.agent as string | undefined,
//     }));
//   });
//
// Telegram command uses formatScoreViolationsForTelegram().
export {
  getScoreViolationsPayload,
  formatScoreViolationsForTelegram,
  renderScoreViolationsHtml,
  SCORE_VIOLATIONS_DEFAULT_THRESHOLD,
  SCORE_VIOLATIONS_DEFAULT_DAYS,
  SCORE_VIOLATIONS_DEFAULT_LIMIT,
  SCORE_BUCKETS as VIOLATION_SCORE_BUCKETS,
  BYPASS_GATE_FLOOR,
} from "./reviewer/score-violations.js";
export type {
  ScoreViolationsPayload,
  ScoreViolationEntry,
  ScoreViolationAgentSummary,
  ScoreViolationsOptions,
  ScoreBucketSummary,
  ScoreBucket,
  BypassGateSummary,
} from "./reviewer/score-violations.js";

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

// Quality floor bypass detector — Telegram alerts for soft-bypass approvals (issue #367).
//
// Fires a high-urgency Telegram alert whenever a task is approved with
// quality_score < 0.80 but WITHOUT an explicit bypass_reason='operator_override'
// in the audit trail.  Catches "soft bypass" approvals where the system didn't
// hard-block (0.60 floor not triggered) but the score is still below the target floor.
//
// Integration (via ReviewerInstances in orchestrator-adapter):
//   const { bypassDetector } = createReviewerInstances(config, store, { notifier });
//   await bypassDetector?.checkAndAlert(verificationResult, task);
//
// Direct usage:
//   import { QualityFloorBypassDetector } from 'claude-orchestrator-reviewer';
//
//   const detector = new QualityFloorBypassDetector(notifier, {
//     threshold: 0.80,
//     dashboardBaseUrl: 'https://dashboard.example.com',
//   });
//   await detector.checkAndAlert(verificationResult, task);
export {
  QualityFloorBypassDetector,
  QUALITY_FLOOR_THRESHOLD,
} from "./reviewer/quality-floor-bypass-detector.js";
export type {
  BypassDetectorConfig,
} from "./reviewer/quality-floor-bypass-detector.js";

// Score-zero approval alerter — real-time Telegram alert for score ≤ 0.05 approvals (issue #375).
//
// Fires an urgent Telegram notification whenever a task is approved with a score at or
// near zero — indicating catastrophic quality failure regardless of the bypass path.
// Complements the general LowScoreApprovalAlerter (threshold 0.70) and the
// QualityFloorBypassDetector (threshold 0.80, filters on bypass_reason).
//
// Suppressed for short-circuit exits (already-in-review, pre-dispatch blocks) that
// legitimately receive score 1.0 through a different path.
//
// Integration (via ReviewerInstances in orchestrator-adapter):
//   const { scoreZeroAlerter } = createReviewerInstances(config, store, { notifier });
//   await scoreZeroAlerter?.checkAndAlert(verificationResult, task);
//
// Direct usage:
//   import { ScoreZeroApprovalAlerter } from 'claude-orchestrator-reviewer';
//
//   const alerter = new ScoreZeroApprovalAlerter(notifier);
//   await alerter.checkAndAlert(verificationResult, task);
export {
  ScoreZeroApprovalAlerter,
  SCORE_ZERO_ALERT_THRESHOLD,
} from "./reviewer/score-zero-alert.js";
export type {
  ScoreZeroAlertOptions,
} from "./reviewer/score-zero-alert.js";

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

// Quality Summary — daily Telegram digest + `/quality-summary` command.
//
// Reports rolling 24h approval quality: total approvals, count below the
// 0.80 floor, marginal rate percentage, and the worst-scoring agent.
export {
  QualitySummaryScheduler,
  buildQualitySummaryReport,
  formatQualitySummaryForTelegram,
  QUALITY_SUMMARY_THRESHOLD,
  QUALITY_SUMMARY_LOOKBACK_HOURS,
  FLAG_LAST_QUALITY_SUMMARY_SENT,
} from "./reviewer/quality-summary.js";
export type {
  QualitySummaryDigestStore,
  QualitySummaryDigestOptions,
  QualitySummarySchedulerOptions,
  IQualitySummaryStore,
} from "./reviewer/quality-summary.js";

// Bypass-audit endpoint + daily Telegram digest (issue #398).
// Lists all tasks approved below the 0.60 quality floor in the last 7 days with
// their bypass_reason (or 'none').  Mount as /api/bypass-audit in the orchestrator;
// the BypassAuditScheduler sends a daily Telegram summary with count and worst offender.
//
//   app.get('/api/bypass-audit', (req, res) => {
//     res.json(getBypassAuditPayload(store, {
//       days: req.query.days ? Number(req.query.days) : undefined,
//     }));
//   });
//
//   const scheduler = new BypassAuditScheduler(store, notifier);
//   await scheduler.checkAndSend(); // call from daily maintenance cycle
export {
  getBypassAuditPayload,
  formatBypassAuditForTelegram,
  BypassAuditScheduler,
  BYPASS_AUDIT_FLOOR,
  BYPASS_AUDIT_DEFAULT_DAYS,
  BYPASS_AUDIT_DEFAULT_LIMIT,
} from "./reviewer/bypass-audit.js";
export type {
  BypassAuditEntry,
  BypassAuditPayload,
  BypassAuditOptions,
  BypassAuditSchedulerOptions,
} from "./reviewer/bypass-audit.js";

// Pre-submission triage schema validator — POST /api/validate-triage-schema (issue #406).
// Agents call this before opening a PR to self-check their JSON block against the same
// logic used by Verifier.checkTriageSchemaCompliance().  Eliminates revision cycles caused
// by schema errors only caught during post-submission verification.
//
//   app.post('/api/validate-triage-schema', express.json(), createTriageSchemaValidationHandler());
//
//   curl -s -X POST .../api/validate-triage-schema \
//     -H 'Content-Type: application/json' \
//     -d '{"body": "```json\n{\"duplicates_checked\":true,...}\n```"}'
export {
  validateTriageSchema,
  createTriageSchemaValidationHandler,
  TRIAGE_VALIDATION_PASS_THRESHOLD,
  TRIAGE_FIELD_SCORE_WEIGHTS,
} from "./reviewer/triage-schema-validator.js";
export type {
  TriageSchemaValidationResult,
  TriageFieldError,
  ITriageValidatorCallStore,
} from "./reviewer/triage-schema-validator.js";

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

// Fleet-wide capability check endpoint (research-agent#178 cross-repo) —
// any agent in the fleet calls GET /api/fleet-capability-check before starting
// a task to confirm they are the correct handler. Prevents misrouted tasks
// (e.g. implementation tasks dispatched to the research agent) from doing
// partial work before discovering the mismatch.
//
// Mount on the reviewer HTTP server:
//   app.get('/api/fleet-capability-check', (req, res) => {
//     res.json(handleFleetCapabilityCheck(req.query as Record<string, string>));
//   });
export {
  FLEET_CAPABILITY_MAP,
  evaluateFleetCapability,
  handleFleetCapabilityCheck,
  parseFleetCapabilityCheckQuery,
  findCapableAgents,
  extractRepoFromSourceRef as extractRepoFromSourceRefFleet,
} from "./reviewer/fleet-capability-check.js";
export type {
  AgentCapabilityEntry,
  FleetCapabilityCheckRequest,
  FleetCapabilityCheckResponse,
} from "./reviewer/fleet-capability-check.js";

// Semantic Task Memory — daily digest + /memory Telegram command (issue #369).
//
// The MemoryDigestScheduler fires a Telegram summary once per day at 09:00 UTC
// (configurable) covering:
//   1. Top 5 most-queried topics in the memory index over the past 7 days.
//   2. Top 3 topics re-attempted 2+ times (memory not preventing repeated work).
//   3. Topics where all attempts scored below 0.70 (persistent low-confidence areas).
//
// Operators can expand any topic via `/memory expand <topic>`.
//
// Wire into the daemon poll cycle:
//   const scheduler = new MemoryDigestScheduler(store, notifier);
//   // In each poll cycle:
//   await scheduler.maybeFireDigest();
//
// Record task outcomes into the memory index:
//   store.recordMemoryEntry("authentication", taskId, 0.82, "success");
export {
  MemoryDigestScheduler,
  buildMemoryDigest,
  formatMemoryDigest,
  LOW_CONFIDENCE_THRESHOLD,
  DIGEST_LOOKBACK_DAYS,
  DIGEST_TOP_QUERIED_LIMIT,
  DIGEST_REPEATED_LIMIT,
  DIGEST_LOW_CONFIDENCE_LIMIT,
} from "./reviewer/memory-digest.js";
export type {
  ISemanticMemoryStore,
  MemoryEntry,
  TopQueriedTopic,
  RepeatedAttemptTopic,
  LowConfidenceTopic,
  SemanticMemoryDigestReport,
} from "./state/types.js";

// Reviewer Misrouting Digest — daily Telegram summary (issue #382).
//
// The MisroutingDigestScheduler fires a Telegram summary once per day at
// 09:00 UTC listing every implementation task dispatched to the reviewer
// in the last 24 hours. Each entry shows task title, dispatched agent,
// suggested correct agent (inferred from repo ownership), and issue link.
//
// Wire into the daemon poll cycle:
//   const scheduler = new MisroutingDigestScheduler(store, notifier, config);
//   // In each poll cycle:
//   await scheduler.maybeFireDigest();
export {
  MisroutingDigestScheduler,
  buildMisroutingDigest,
  formatMisroutingDigest,
  classifyMisroutedTask,
  FLAG_LAST_MISROUTING_DIGEST_SENT,
  MISROUTING_LOOKBACK_HOURS,
  REVIEWER_AGENT_NAMES,
  IMPLEMENTATION_TASK_TYPES,
  CROSS_REPO_FOLLOWUP_PATTERNS,
} from "./reviewer/misrouting-digest.js";
export type {
  MisroutingDigestEntry,
  MisroutingDigestReport,
  IMisroutingDigestStore,
} from "./reviewer/misrouting-digest.js";

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

// Universal Quality Gate — cross-path 0.80 quality floor (issue #405).
//
// Catches sub-0.80 approvals across ALL task types and ALL approval paths:
// normal verify() callback, orchestrator short-circuit, operator Telegram
// /approve commands, and cross-repo follow-up task completions.
//
// Unlike QualityFloorBypassDetector (verify() callback only), this gate can be
// called after ANY approval event.  No task-type exemptions.
//
// Pure-function form (one-off checks from any approval path):
//   import { checkApprovalQualityGate } from 'claude-orchestrator-reviewer';
//   const fired = await checkApprovalQualityGate(task, notifier);
//
// Daemon-style (per-task dedup across many approvals):
//   import { UniversalQualityGateMonitor } from 'claude-orchestrator-reviewer';
//   const monitor = new UniversalQualityGateMonitor(notifier, { floor: 0.80 });
//   await monitor.checkAndAlert(task);
//
//   // Batch processing (daemon integration):
//   const { alerted, skipped } = await monitor.checkBatch(recentlyApprovedTasks);
export {
  checkApprovalQualityGate,
  formatUniversalQualityGateAlert,
  UniversalQualityGateMonitor,
  UNIVERSAL_QUALITY_FLOOR,
} from "./reviewer/universal-quality-gate.js";
export type {
  UniversalQualityGateConfig,
} from "./reviewer/universal-quality-gate.js";

// Research Investigation Client — HTTP client for the research agent's investigation feed API
// (coordinated change rapartlu/research-agent#128).
//
// The improvement detector uses this client to register research investigations,
// activate them when the research agent starts, and complete them with findings
// + the resulting GitHub issue URL after `analyzeResearchFindings()` runs.
//
//   const client = createResearchInvestigationClient();
//
//   // Register when dispatching a research task:
//   const inv = await client.register({ title: '...', research_question: '...' });
//
//   // Complete after findings are analysed and an issue is filed:
//   await client.complete(inv.id, { finding_summary: '...', score: 91, result_issue_url: '...' });
export {
  ResearchInvestigationClient,
  createResearchInvestigationClient,
} from "./reviewer/research-investigation-client.js";
export type {
  Investigation,
  InvestigationStatus,
  InvestigationsSummary,
  RegisterInvestigationRequest,
  CompleteInvestigationRequest,
  ResearchInvestigationClientOptions,
  ResearchMisroutingRecord,
  ResearchMisroutingReport,
  RecordMisroutingRequest,
} from "./reviewer/research-investigation-client.js";

// Investigations feed — formatter for the /investigations Telegram command and
// /api/investigations dashboard REST endpoint (coordinated change research-agent#134).
//
// `getInvestigationsFeedPayload(investigations)` — converts a raw Investigation[]
// into a typed payload for REST consumers.
//
// `formatInvestigationsForTelegram(investigations)` — renders as Telegram Markdown.
export {
  getInvestigationsFeedPayload,
  formatInvestigationsForTelegram,
  MAX_RECENT_COMPLETE,
  MAX_COMPLETE_IN_TELEGRAM,
} from "./reviewer/investigations-feed.js";
export type {
  InvestigationSummary,
  InvestigationsFeedPayload,
} from "./reviewer/investigations-feed.js";

// Meeting-facilitator monthly goal widget — `/meeting-facilitator-goal` API payload (issue #411).
//
// Tracks two monthly goals for the meeting-facilitator-agent:
//  1. core_logic_shipped   — at least one approved implementation task
//  2. meetings_facilitated — five or more done tasks in the current calendar month
//
// Mount in the orchestrator or dashboard server:
//   app.get('/meeting-facilitator-goal', (_req, res) =>
//     res.json(getMeetingFacilitatorGoalPayload(store)));
export { getMeetingFacilitatorGoalPayload } from "./reviewer/meeting-facilitator-goal.js";
export type {
  MeetingFacilitatorGoalOptions,
} from "./reviewer/meeting-facilitator-goal.js";
export type {
  MeetingFacilitatorGoalWidget,
  MeetingFacilitatorGoalItem,
  IMeetingFacilitatorGoalStore,
} from "./state/types.js";

// Improvement-detector batch deduplication (issue #458)
export type {
  ImprovementAnalysisRun,
  IImprovementBatchDeduplicationStore,
} from "./state/types.js";

// Low-quality PR labeler (issue #428)
export {
  LowQualityPRLabeler,
  parsePrRef,
  ensureLowQualityLabel,
  addLowQualityLabel,
  removeLowQualityLabel,
  LOW_QUALITY_LABEL_THRESHOLD,
  LOW_QUALITY_LABEL_NAME,
  LOW_QUALITY_LABEL_COLOR,
  LOW_QUALITY_LABEL_DESCRIPTION,
} from "./reviewer/low-quality-pr-labeler.js";
export type { LowQualityPRLabelerOptions, PrRef } from "./reviewer/low-quality-pr-labeler.js";

// LLM client
export { createLLMClient, resetLLMClient } from "./client/llm-client.js";

// Fork-from dispatch payload protocol — canonical spec (issue #454)
export {
  parseForkFrom,
  serialiseForkFrom,
  isValidForkConversationId,
  buildForkSpec,
  isExploratoryFork,
  KNOWN_FORK_LABELS,
  FORK_FROM_MIGRATION_SQL,
  FORK_FROM_COLUMN,
} from "./reviewer/fork-protocol.js";
export type {
  DispatchForkSpec,
  DispatchOptionsWithFork,
  ForkDispatchOutcome,
  TaskForkFrom,
  KnownForkLabel,
} from "./reviewer/fork-protocol.js";

// Meeting outcome client — HTTP client for meeting-facilitator agent outcome API (issue #460)
export {
  MeetingOutcomeClient,
  createMeetingOutcomeClient,
} from "./reviewer/meeting-outcome-client.js";
export type {
  MeetingOutcomeStatus,
  IssueRef,
  PriorityRankingEntry,
  SequencingConstraint,
  MeetingOutcome,
  MeetingOutcomeSummary,
  MeetingOutcomeClientOptions,
} from "./reviewer/meeting-outcome-client.js";

// Meeting priority dispatcher — rule-based fast-path for auto-dispatch from outcome signals (issue #463)
export {
  MeetingPriorityDispatcher,
  createMeetingPriorityDispatcher,
  evaluateAutoDispatch,
} from "./reviewer/meeting-priority-dispatcher.js";
export type {
  DispatchRuleId,
  DispatchAction,
  PriorityDispatchDecision,
  DispatchEvaluationContext,
  MeetingPriorityDispatcherOptions,
} from "./reviewer/meeting-priority-dispatcher.js";

// Pattern risk signal consumer — reads daemon-written pattern_risk signals and
// surfaces them as additional LLM context in the improvement detector (issue #1149).
export { PatternRiskConsumer } from "./reviewer/pattern-risk-consumer.js";
export type {
  PatternRiskSignal,
  AgentPatternRiskSummary,
  IPatternRiskStore,
} from "./state/types.js";

// Score provenance — /api/score-provenance/:task_id endpoint + default-fallback guard (issue #483)
export {
  getScoreProvenancePayload,
  parseScoreProvenanceParams,
  formatScoreProvenanceForTelegram,
  deriveScoreSource,
  shouldBlockDefaultFallbackApproval,
  SCORE_PROVENANCE_MIGRATION_SQL,
  PARSE_FAILURE_NOTES_SENTINEL,
} from "./reviewer/score-provenance.js";
export type {
  ScoreSource,
  ScoreProvenancePayload,
  ScoreProvenanceRecord,
  IScoreProvenanceStore,
} from "./reviewer/score-provenance.js";

// Persistent anomaly tracker — surface quality anomalies recurring across ≥2 cycles (issue #483)
// Scheduler added in issue #546 so orchestrator can wire via a single import.
export {
  recordAnomalyObservation,
  getPersistentAnomaliesPayload,
  formatPersistentAnomaliesForTelegram,
  generateCycleId,
  PERSISTENT_ANOMALIES_MIGRATION_SQL,
  DEFAULT_MIN_CYCLES,
  DEFAULT_ANOMALY_LOOKBACK_DAYS,
  PersistentAnomaliesDigestScheduler,
} from "./reviewer/persistent-anomalies.js";
export type {
  AnomalyObservation,
  PersistentAnomaly,
  PersistentAnomaliesPayload,
  PersistentAnomaliesOptions,
  IPersistentAnomalyStore,
  PersistentAnomaliesDigestSchedulerOptions,
} from "./reviewer/persistent-anomalies.js";

// Proactive dispatch rationale log — /supervisor-dispatches Telegram command (dashboard#570)
export {
  getProactiveDispatches,
  formatProactiveDispatchesForTelegram,
} from "./reviewer/proactive-dispatch-log.js";
export type { ProactiveDispatch } from "./reviewer/proactive-dispatch-log.js";

// Standup quality trend — standup_quality_history persistence + /standup-quality Telegram command (issue #498)
// Backfill support added in coordinated change 01KQ2ZHKAK9RR15HKV04CP4M48
export {
  recordStandupQualityScore,
  getStandupQualityTrend,
  parseStandupQualityParams,
  formatStandupQualityForTelegram,
  STANDUP_QUALITY_MIGRATION_SQL,
  STANDUP_QUALITY_DEFAULT_DAYS,
  STANDUP_QUALITY_MAX_DAYS,
  STANDUP_LOW_SCORE_THRESHOLD,
  STANDUP_DEGRADATION_STREAK,
} from "./reviewer/standup-quality-trend.js";
// Survival plan helpers for the 30-day fleet self-funding window.
export {
  checkDay7Checkpoint,
  checkAndEscalateDay7,
  getSurvivalStatusPayload,
  formatSurvivalStatusForTelegram,
  renderRevenueLandingPage,
  getRevenuePath,
  setRevenuePath,
  markPathInMotion,
  recordEarnings,
  getTotalEarnedUsd,
  getFirstDollarAt,
  countActiveRevenuePaths,
  getWalletAddress,
  getGitHubSponsorsUrl,
  getPolarUrl,
  getAlgoraUrl,
  getGitcoinUrl,
  APPROVED_REVENUE_PATH_IDS,
  SURVIVAL_DEADLINE_ISO,
  DAY7_CHECKPOINT_ISO,
  SURVIVAL_TARGET_USD,
  SURVIVAL_STRETCH_USD,
} from "./service/survival-plan.js";
export type {
  StandupQualityRecord,
  StandupQualityTrendPayload,
  StandupQualityParams,
  IStandupQualityStore,
} from "./reviewer/standup-quality-trend.js";

// Synthesis watchdog — alert + re-attempt intake when synthesis missing after 24h (issue #553).
//
// Provides a reliability layer for meeting/standup synthesis: if the meeting-facilitator
// is unavailable when synthesis should be written, the result can be silently lost.
// The watchdog persists the intake moment and alerts operators + re-posts after 24h.
//
// Usage:
//   registerSynthesisIntake(store, repo, issueNumber)  // call on intake received
//   recordSynthesisComplete(store, repo, issueNumber)  // call when synthesis written
//   new SynthesisWatchdog(store, notifier).checkAndAlert()  // call from daemon loop
export {
  SynthesisWatchdog,
  registerSynthesisIntake,
  recordSynthesisComplete,
  formatMissingSynthesisAlert,
  SYNTHESIS_MISSING_THRESHOLD_HOURS,
  SYNTHESIS_ALERT_COOLDOWN_HOURS,
  SYNTHESIS_WATCHDOG_MIGRATION_SQL,
} from "./reviewer/synthesis-watchdog.js";
export type {
  SynthesisWatchEntry,
  SynthesisWatchdogCheckResult,
  ISynthesisWatchdogStore,
} from "./reviewer/synthesis-watchdog.js";

// Marginal approvals feed — `/api/marginal-approvals` API payload + `/marginal-approvals` Telegram command (issue #502).
//
// Surfaces all tasks approved in the 0.60–0.79 "marginal" band so operators can
// review them together, compare per-agent trends, and trigger targeted re-dispatch
// with coaching when the marginal_reason reveals a fixable gap.
//
// Mount in the orchestrator or dashboard server:
//   app.get('/api/marginal-approvals', (req, res) => {
//     res.json(getMarginalApprovalsFeed(store, {
//       days:  req.query.days  ? Number(req.query.days)  : undefined,
//       limit: req.query.limit ? Number(req.query.limit) : undefined,
//     }));
//   });
//
// Telegram `/marginal-approvals [days] [limit]` command uses formatMarginalApprovalsForTelegram().
export {
  getMarginalApprovalsFeed,
  getMarginalApprovalsTrend,
  formatMarginalApprovalsForTelegram,
  MARGINAL_APPROVALS_FLOOR,
  MARGINAL_APPROVALS_CEILING,
  MARGINAL_APPROVALS_DEFAULT_DAYS,
  MARGINAL_APPROVALS_DEFAULT_LIMIT,
  MARGINAL_APPROVALS_TREND_DEFAULT_DAYS,
} from "./reviewer/marginal-approvals-feed.js";
export type {
  MarginalApprovalEntry,
  MarginalApprovalsOptions,
  MarginalApprovalAgentSummary,
  MarginalApprovalsFeed,
  MarginalApprovalsTrendOptions,
  MarginalApprovalsTrend,
} from "./reviewer/marginal-approvals-feed.js";
export type {
  IMarginalApprovalsFeedStore,
  IMarginalApprovalsTrendStore,
  MarginalApprovalDayBucket,
} from "./state/types.js";

// Pre-existing staging failure tracker — consolidated Telegram alert when the
// same pre-existing test failure is skipped across ≥3 distinct PRs (issue #453).
export {
  PreexistingFailureTracker,
  PREEXISTING_SKIP_THRESHOLD,
  PREEXISTING_SKIP_WINDOW_MS,
  PREEXISTING_ALERT_COOLDOWN_MS,
} from "./reviewer/preexisting-failure-tracker.js";
export type {
  PreexistingSkip,
  PreexistingSkipRow,
  IPreexistingFailureStore,
  PreexistingFailureTrackerConfig,
} from "./reviewer/preexisting-failure-tracker.js";

// Multi-provider LLM client — supports Anthropic (default), Deepseek, and Grok.
// Used by reviewer pool members. REVIEWER_PROVIDER / REVIEWER_MODEL env vars
// select the active provider/model (issue: rapartlu/agent-orchestrator#1211).
export {
  createPoolAwareLLMClient,
  resetPoolClient,
  getReviewerProvider,
  getReviewerModel,
} from "./client/multi-provider-client.js";
export type {
  ReviewerProvider,
  IReviewerLLMClient,
  LLMCreateParams,
  LLMMessageResponse,
  LLMMessageContent,
  LLMUsage,
} from "./client/multi-provider-client.js";

// Reviewer pool integration — pool membership, consensus, and display helpers
// (issue: rapartlu/agent-orchestrator#1211).
export {
  REVIEWER_POOL_NAME,
  KNOWN_POOL_MEMBERS,
  getPoolMembership,
  isSecondaryPoolMember,
  formatPoolMemberBadge,
  formatPoolConsensus,
  evaluatePoolConsensus,
} from "./reviewer/reviewer-pool.js";
export type {
  KnownPoolMemberId,
  ReviewerPoolMember,
  PoolConsensusResult,
} from "./reviewer/reviewer-pool.js";

// Pool member config type (re-exported from config for orchestrator consumers)
export type { ReviewerPoolMemberConfig } from "./config.js";

// Fleet configuration — canonical wallet address and revenue config (issue #594).
//
// Single source of truth for FLEET_WALLET_ADDRESS (baked-in Base address with
// env-var override), PR Review API pricing, and platform URLs.
//
// Usage:
//   import { FLEET_WALLET_ADDRESS, buildFundingConfig, getPRReviewApiInfo } from 'claude-orchestrator-reviewer';
export {
  FLEET_WALLET_ADDRESS,
  FLEET_WALLET_NETWORK,
  FLEET_WALLET_TOKENS,
  FLEET_GITHUB_SPONSORS_URL,
  FLEET_POLAR_URL,
  FLEET_ALGORA_URL,
  FLEET_GITCOIN_URL,
  PR_REVIEW_API_PRICING,
  REVIEWER_PORT,
  buildFundingConfig,
} from "./config/fleet-config.js";

// Public PR Review API — paid external service (revenue path #5, issue #1302).
//
// Exposes the fleet's LLM PR review capability to external callers.
// Pricing: basic $0.10/PR, deep $0.50/PR. Payment via USDC/DAI on Base network.
//
// Mount in the reviewer HTTP server:
//   app.get('/api/pr-review/info', (_req, res) => res.json(getPRReviewApiInfo()));
//
// See: docs/pr-review-api.md for full endpoint documentation.
export {
  getPRReviewApiInfo,
  validatePRReviewRequest,
  formatPRReviewApiSummaryMarkdown,
  formatPRReviewApiForTelegram,
} from "./reviewer/pr-review-api.js";
export type {
  PRReviewTier,
  ExternalPRReviewRequest,
  ExternalPRReviewResponse,
  PRReviewApiInfo,
} from "./reviewer/pr-review-api.js";

// Integration adapter (also available via 'claude-orchestrator-reviewer/integration')
export { createReviewerInstances } from "./integration/orchestrator-adapter.js";
export type { ReviewerInstances, CreateReviewerOptions } from "./integration/orchestrator-adapter.js";

// Fleet wallet config — resolves FLEET_WALLET_ADDRESS from config or env vars;
// provides GET /api/fleet-config payload builder (issue #594 / orchestrator#1331).
export {
  resolveWalletAddress,
  resolveWalletNetwork,
  getFleetWalletConfig,
  getFleetConfigPayload,
  getFleetWalletConfigPayload,
} from "./reviewer/fleet-wallet-config.js";
export type {
  FleetWalletConfig,
  FleetConfigPayload,
} from "./reviewer/fleet-wallet-config.js";
