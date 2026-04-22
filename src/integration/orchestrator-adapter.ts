/**
 * Orchestrator adapter — one-call wiring for the orchestrator daemon.
 *
 * Provides `createReviewerInstances()` so the daemon can bootstrap all reviewer
 * modules with a single call, passing its own StateStore and config.
 *
 * Usage:
 *
 *   import { createReviewerInstances } from 'claude-orchestrator-reviewer/integration';
 *
 *   const { reviewer, verifier, supervisor, detector, issueCreator } =
 *     createReviewerInstances(config, store, {
 *       onAgentRestart: (repo) => deployer.restartAgentsForRepo(repo),
 *     });
 */

import { PRReviewer } from "../reviewer/pr-reviewer.js";
import { Verifier } from "../reviewer/verifier.js";
import { Supervisor } from "../reviewer/supervisor.js";
import type { PRConfidenceProvider } from "../reviewer/supervisor.js";
import { ImprovementDetector } from "../reviewer/improvement-detector.js";
import { IssueCreator } from "../reviewer/issue-creator.js";
import { HealthIncidentRouter } from "../reviewer/health-incident-router.js";
import { RoutingAccuracyTracker } from "../reviewer/routing-accuracy.js";
import { CalibrationDriftMonitor } from "../reviewer/calibration-drift.js";
import { ConflictRecoveryAlertMonitor } from "../reviewer/reroute-conflict-recovery.js";
import { ScoreCalibrator } from "../reviewer/score-calibrator.js";
import { RoutingViolationDetector } from "../reviewer/routing-violations.js";
import { PreDispatchCapabilityEnforcer } from "../reviewer/pre-dispatch-capability-enforcer.js";
import { LowScoreApprovalAlerter } from "../reviewer/low-score-approval-alerter.js";
import { QualityFloorBypassDetector } from "../reviewer/quality-floor-bypass-detector.js";
import { ScoreZeroApprovalAlerter } from "../reviewer/score-zero-alert.js";
import { LowQualityPRLabeler } from "../reviewer/low-quality-pr-labeler.js";
import type { ReviewerConfig } from "../config.js";
import type { Notifier } from "../notify.js";
import type {
  IStateStore,
  IScoreOutcomeStore,
  IVerificationResultStore,
  ITelegramStateStore,
} from "../state/types.js";

export interface ReviewerInstances {
  /** Reviews open PRs, manages the merge queue, and auto-rebases stale branches. */
  reviewer: PRReviewer;
  /** Scores completed tasks and dispatches revisions when quality is insufficient. */
  verifier: Verifier;
  /** Strategic oversight — decides what needs attention across all agents. */
  supervisor: Supervisor;
  /** Analyses task patterns and surfaces improvement suggestions. */
  detector: ImprovementDetector;
  /** Creates GitHub issues on agent repos. */
  issueCreator: IssueCreator;
  /** Detects calibration drift and surfaces score distribution histograms. */
  calibrationDriftMonitor: CalibrationDriftMonitor;
  /** Detects conflict-recovery spikes and alerts Telegram. */
  conflictRecoveryMonitor: ConflictRecoveryAlertMonitor;
  /**
   * Records PR outcomes (merged/rejected/changes_requested/redispatched) and
   * derives per-agent min_score threshold recommendations from the accumulated
   * outcome history.  Undefined when the store does not implement IScoreOutcomeStore.
   */
  scoreCalibrator: ScoreCalibrator | undefined;
  /**
   * Routes health check incident reports to Telegram instead of creating PRs.
   * Detects pure-diagnostic health check tasks and prevents PR queue pollution.
   * Undefined when no notifier is provided.
   */
  healthIncidentRouter: HealthIncidentRouter;
  /**
   * Scans recent tasks for agent-to-repo routing violations and fires Telegram
   * alerts when a task is dispatched to an agent that does not own the target
   * repository.  Call `routingViolationDetector.scan()` once per daemon cycle,
   * after task dispatch and before verification.
   * Undefined when the store does not implement ITelegramStateStore
   * (i.e. lacks `recordRoutingViolation` / `getRoutingViolations`).
   */
  routingViolationDetector: RoutingViolationDetector | undefined;
  /**
   * Pre-dispatch capability enforcer for the reviewer agent (issue #330).
   * Intercepts tasks BEFORE they are sent to `claude-orchestrator-reviewer`
   * and blocks any task that contains authorship keywords (implement, create PR,
   * write, build) targeting a foreign repo.  When a task is blocked, returns
   * the correct reroute target and fires a Telegram alert.
   *
   * Call `preDispatchEnforcer.check()` in the dispatcher, just before sending
   * a task to the reviewer agent:
   *
   *   const r = await instances.preDispatchEnforcer.check({
   *     task_title: task.title,
   *     task_type: task.task_type ?? "implementation",
   *     source_ref: task.source_ref,
   *     target_agent: resolvedAgent,
   *   });
   *   if (!r.allowed) resolvedAgent = r.reroute_to ?? fallback;
   */
  preDispatchEnforcer: PreDispatchCapabilityEnforcer;
  /**
   * Real-time alerter for low-score approvals (issue #331, #346).
   * Sends Telegram notifications when a task is approved with score < 0.60 (the quality floor).
   * Call `lowScoreApprovalAlerter.checkAndAlert(result, task)` after verification
   * completes and the result is approved.
   * Undefined when no notifier is provided.
   */
  lowScoreApprovalAlerter: LowScoreApprovalAlerter | undefined;
  /**
   * Hard quality floor bypass detector (issue #367).
   * Fires a Telegram alert whenever a task with quality_score < 0.80 is approved
   * without an explicit bypass_reason === 'operator_override' in the audit trail.
   * The 0.80 threshold is deliberately higher than the hard floor (0.60) to catch
   * "soft bypass" approvals.
   *
   * Call `bypassDetector.checkAndAlert(result, task)` after each verification
   * that results in approval — it deduplicates per task and no-ops when the
   * notifier is unconfigured.
   * Undefined when no notifier is provided.
   */
  bypassDetector: QualityFloorBypassDetector | undefined;
  /**
   * Score-zero approval alerter (issue #375).
   * Fires an urgent Telegram notification whenever a task is approved with
   * quality_score ≤ 0.05, regardless of the bypass path.  Score-zero approvals
   * represent catastrophic quality failure and require immediate operator attention.
   *
   * Suppressed for short-circuit exits (already-in-review, pre-dispatch blocks)
   * that legitimately receive score 1.0 through a separate verification path.
   *
   * Call `scoreZeroAlerter.checkAndAlert(result, task)` after each approved
   * verification result — it deduplicates per task ID and no-ops when the
   * notifier is unconfigured.
   * Undefined when no notifier is provided.
   */
  scoreZeroAlerter: ScoreZeroApprovalAlerter | undefined;
  /**
   * Low-quality PR labeler (issue #428).
   * Applies the `low-quality` GitHub label to the PR associated with a task
   * whenever that task is approved with quality_score < 0.70.  The label is
   * automatically removed when a revision brings the score at or above threshold.
   *
   * The label provides a persistent visual signal on the PR diff page so
   * reviewers and merge-queue operators can see quality risk before merging —
   * unlike Telegram alerts, which are transient.
   *
   * Call `lowQualityPRLabeler.applyLabel(result, task)` after each approved
   * verification result.  The labeler is a no-op when the task has no PR
   * `source_ref`, or when the `gh` CLI is unavailable.
   */
  lowQualityPRLabeler: LowQualityPRLabeler;
}

export interface CreateReviewerOptions {
  /**
   * Called by PRReviewer when an agent needs a restart (e.g. after a bad
   * merge or repeated failures).  Map this to `Deployer.restartAgentsForRepo`
   * in the orchestrator daemon.
   */
  onAgentRestart?: (repo: string) => Promise<void>;
  /**
   * Telegram notifier instance for health incident routing.
   * When provided, the HealthIncidentRouter will send structured incident
   * messages to Telegram instead of creating diagnostic PRs.
   */
  notifier?: Notifier;
}

/**
 * Construct all reviewer modules in one call.
 *
 * @param config  - Reviewer config (a subset of OrchestratorConfig).
 * @param store   - The orchestrator's StateStore instance (satisfies IStateStore).
 * @param opts    - Optional callbacks (see CreateReviewerOptions).
 */
export function createReviewerInstances(
  config: ReviewerConfig,
  store: IStateStore,
  opts: CreateReviewerOptions = {},
): ReviewerInstances {
  // Create reviewer first so it can be wired as the conflict-stats provider
  // for the supervisor (issue #44).
  const reviewer = new PRReviewer(config, store, { onAgentRestart: opts.onAgentRestart });

  // Wire the store as a PRConfidenceProvider if it implements the method
  // (the reviewer's own StateStore does; the orchestrator's StateStore may not).
  const prConfidenceProvider: PRConfidenceProvider | undefined =
    typeof (store as unknown as PRConfidenceProvider).getRecentPRReviewConfidences === "function"
      ? (store as unknown as PRConfidenceProvider)
      : undefined;

  // Wire the store as a RoutingAccuracyProvider if it implements the required methods.
  const routingAccuracyProvider =
    typeof (store as unknown as IStateStore).getRoutingAccuracyStats === "function" &&
    typeof (store as unknown as IStateStore).getAgentQualityByTaskType === "function"
      ? new RoutingAccuracyTracker(store)
      : undefined;

  // Always constructed — getScoreDistributions / getCalibrationDriftAlerts are on IStateStore.
  // Pass dashboardUrl when configured so Telegram alerts include a calibration view link.
  const calibrationDriftMonitor = new CalibrationDriftMonitor(store, {
    dashboardUrl: config.dashboard_url
      ? `${config.dashboard_url.replace(/\/$/, "")}/calibration`
      : undefined,
  });

  const conflictRecoveryMonitor = new ConflictRecoveryAlertMonitor(store, opts.notifier, {
    hours: 24,
    threshold: 0.2,
  });

  // Wire ScoreCalibrator if the store implements IScoreOutcomeStore.
  // The reviewer's own StateStore does; the orchestrator's StateStore may not (yet).
  const scoreCalibrator =
    typeof (store as unknown as IScoreOutcomeStore).recordPROutcome === "function" &&
    typeof (store as unknown as IScoreOutcomeStore).getCalibrationData === "function" &&
    typeof (store as unknown as IScoreOutcomeStore).getAdjustedThresholds === "function"
      ? new ScoreCalibrator(store as unknown as IScoreOutcomeStore)
      : undefined;

  // Wire IVerificationResultStore if the store implements it.
  // The reviewer's own StateStore does; the orchestrator's StateStore may not (yet).
  const verificationResultStore =
    typeof (store as unknown as IVerificationResultStore).insertVerificationResult === "function" &&
    typeof (store as unknown as IVerificationResultStore).getVerificationStats === "function"
      ? (store as unknown as IVerificationResultStore)
      : undefined;

  // Wire RoutingViolationDetector if the store implements ITelegramStateStore
  // (has recordRoutingViolation + getRoutingViolations).  The reviewer's own
  // StateStore always satisfies this; the orchestrator's StateStore may not yet.
  const routingViolationDetector =
    typeof (store as unknown as ITelegramStateStore).recordRoutingViolation === "function" &&
    typeof (store as unknown as ITelegramStateStore).getRoutingViolations === "function"
      ? new RoutingViolationDetector(
          store as unknown as ITelegramStateStore,
          config,
          opts.notifier,
        )
      : undefined;

  // Create LowScoreApprovalAlerter if notifier is provided.
  // The alerter sends real-time Telegram notifications for low-score approvals
  // below the quality floor (0.60).
  const lowScoreApprovalAlerter = opts.notifier
    ? new LowScoreApprovalAlerter(opts.notifier, { scoreThreshold: 0.60 })
    : undefined;

  // Create QualityFloorBypassDetector if notifier is provided (issue #367).
  // Fires a Telegram alert when a task is approved with score < 0.80 without an
  // explicit operator_override bypass_reason.  Caller should invoke
  // bypassDetector.checkAndAlert(result, task) after each approved verification.
  const bypassDetector = opts.notifier
    ? new QualityFloorBypassDetector(opts.notifier, {
        dashboardBaseUrl: config.dashboard_url
          ? config.dashboard_url.replace(/\/$/, "")
          : undefined,
      })
    : undefined;

  // Create ScoreZeroApprovalAlerter if notifier is provided (issue #375).
  // Fires an urgent Telegram notification for any approved task with score ≤ 0.05.
  // Suppressed for short-circuit exits that legitimately bypass LLM scoring.
  const scoreZeroAlerter = opts.notifier
    ? new ScoreZeroApprovalAlerter(opts.notifier)
    : undefined;

  // Create LowQualityPRLabeler (issue #428).
  // Applies/removes the `low-quality` GitHub label on PRs approved below 0.70.
  // Always constructed — it is a no-op when the task has no PR source_ref.
  const lowQualityPRLabeler = new LowQualityPRLabeler();

  return {
    reviewer,
    verifier: new Verifier(store, undefined, verificationResultStore),
    supervisor: new Supervisor(config, store, {
      conflictStatsProvider: reviewer,
      prConfidenceProvider,
      routingAccuracyProvider,
      calibrationDriftProvider: calibrationDriftMonitor,
    }),
    detector: new ImprovementDetector(config, store),
    issueCreator: new IssueCreator(config),
    calibrationDriftMonitor,
    conflictRecoveryMonitor,
    scoreCalibrator,
    healthIncidentRouter: new HealthIncidentRouter(opts.notifier),
    routingViolationDetector,
    preDispatchEnforcer: new PreDispatchCapabilityEnforcer(config, opts.notifier),
    lowScoreApprovalAlerter,
    bypassDetector,
    scoreZeroAlerter,
    lowQualityPRLabeler,
  };
}
