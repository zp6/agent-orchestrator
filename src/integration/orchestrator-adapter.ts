/**
 * Orchestrator adapter — one-call wiring for the orchestrator daemon.
 *
 * Provides `createReviewerInstances()` so the daemon can bootstrap all five
 * reviewer modules with a single call, passing its own StateStore and config.
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
import { RoutingAccuracyTracker } from "../reviewer/routing-accuracy.js";
import { CalibrationDriftMonitor } from "../reviewer/calibration-drift.js";
import type { ReviewerConfig } from "../config.js";
import type { IStateStore } from "../state/types.js";

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
}

export interface CreateReviewerOptions {
  /**
   * Called by PRReviewer when an agent needs a restart (e.g. after a bad
   * merge or repeated failures).  Map this to `Deployer.restartAgentsForRepo`
   * in the orchestrator daemon.
   */
  onAgentRestart?: (repo: string) => Promise<void>;
}

/**
 * Construct all five reviewer modules in one call.
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
  const calibrationDriftMonitor = new CalibrationDriftMonitor(store);

  return {
    reviewer,
    verifier: new Verifier(store),
    supervisor: new Supervisor(config, store, {
      conflictStatsProvider: reviewer,
      prConfidenceProvider,
      routingAccuracyProvider,
      calibrationDriftProvider: calibrationDriftMonitor,
    }),
    detector: new ImprovementDetector(config, store),
    issueCreator: new IssueCreator(config),
    calibrationDriftMonitor,
  };
}
