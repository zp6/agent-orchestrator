import { loadConfig, type OrchestratorConfig, getAgentBaseUrl } from "../config/schema.js";
import { validateConfig } from "../config/validator.js";
import { ConfigWatcher, type ConfigChange } from "../config/watcher.js";
import { StateStore, type DispatchRationale, type ConfigReloadTrigger, type DaemonLifecycleEvent } from "../state/store.js";
import { setLLMUsageRecorder } from "../client/llm-client.js";
import { ReviewerClient, type SupervisorDecision } from "../client/reviewer-client.js";
import { Dispatcher, MAX_RETRIES, TIMEOUT_RETRY_MAX, TIMEOUT_RETRY_BACKOFF_MS, extractRepoFromSourceRef } from "../orchestrator/dispatcher.js";
import { ResearchLinker } from "../orchestrator/research-linker.js";
import { IssueCreator, type DeferredFollowUp } from "../orchestrator/issue-creator.js";
import { SchemaRegistrySyncDetector } from "../orchestrator/schema-registry-sync.js";
import { Deployer } from "../orchestrator/deployer.js";
import { PRReviewer } from "../orchestrator/pr-reviewer.js";
import { findOrphanBranches, createPRForBranch, deleteStaleOrphanBranches, STALE_BRANCH_BEHIND_THRESHOLD } from "../orchestrator/pr-creator.js";
import { PRCreationRetryQueue } from "../orchestrator/pr-creation-retry-queue.js";
import { validateGhAuth, countOpenIssues, countOpenPRs } from "../triggers/github.js";
import { cachedIsIssueOpen, cachedGetIssueState, logCacheMetrics, initIssueCachePersistence } from "../triggers/issue-state-bridge.js";
import {
  dispatchGitHubIssues,
  dispatchIdleAgentBacklog,
  dispatchLinearChecks,
  dispatchRevenueExecutor,
  dispatchRevenueWatcher,
  dispatchSlackChecks,
  type TriggerResult,
} from "../triggers/trigger-dispatcher.js";
import { writePid, readPid, removePid } from "./pid.js";
import { createLogger } from "./logger.js";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ManagementClient } from "../client/management-client.js";
import { planSync, executeSync } from "../orchestrator/sync.js";
import { notifyOperator, clearNotifyRateLimit, setTelegramRateLimitMs } from "./notify.js";
import { buildHealthPostmortem, renderPostmortemBlock } from "./health-postmortem.js";
import { setRecencyWindowHours } from "../triggers/duplicate-guard.js";
import {
  setMergeStallThresholdHours,
  scanFleetMergeStalls,
  autoMergeFleetPRs,
  selectMergeCandidates,
} from "../triggers/merge-stall-guard.js";
import { DuplicateIdDetector, checkDbForDuplicateIds } from "../state/duplicate-id-detector.js";
import { startTelegramPolling, stopTelegramPolling, pollTelegram, maybePostDailyGuardDigest, maybePostDailyAnomaliesDigest } from "./telegram.js";
import { pingPendingSubmissions } from "./submission-pinger.js";
import { OperatorControlProcessor } from "./operator-controls.js";
import { maybePostDailyDigest, type DigestSchedulerState } from "./slack-digest.js";
import { maybeRunDailySecurityScan, type SecurityScanState } from "../orchestrator/security-scanner.js";
import { runTeamMeeting } from "../orchestrator/team-meeting.js";
import { StandupActionClient } from "../orchestrator/standup-action-client.js";
import { MeetingIntakeClient } from "../client/meeting-intake-client.js";
import { seedFromClaudeMd } from "../orchestrator/learned-rules.js";
import { checkAgedIssues } from "../orchestrator/issue-age-monitor.js";
import { runProactiveScan } from "../orchestrator/proactive-scanner.js";
import { validateMergedPR } from "../orchestrator/staging-validator.js";
import { proposeAndFileRoadmapItems } from "../orchestrator/roadmap-proposer.js";
import { detectCoverageGaps, suggestNewAgent } from "../orchestrator/coverage-gap-detector.js";
import { autoMarkCompletedKeyResults, maybeRefreshGoals } from "../orchestrator/goals.js";
import { detectHighIterationAgents } from "../orchestrator/iteration-cost-detector.js";
import { detectHealthIncidentIssues } from "../orchestrator/health-incident-detector.js";
import { runIterationBudgetAlerts } from "../orchestrator/iteration-budget-alert.js";
import { runSkipPatternCheck } from "../orchestrator/skip-pattern-aggregator.js";
import { learnPatterns } from "../orchestrator/pattern-learner.js";
import { runScheduledRebases } from "../orchestrator/proactive-rebase-scheduler.js";
import { buildConflictRedispatchMessage } from "../orchestrator/conflict-redispatch.js";
import {
  assessTaskDisciplineAlignment,
  captureDisciplineContext,
  readTaskDisciplineSnapshot,
} from "../orchestrator/discipline-context.js";
import {
  type GateResult,
  detectImprovements,
  extractIssueRefs,
  gateResolvedIssues,
  reviewSupervisorState,
  verifyAndReviseTask,
} from "./reviewer-ops.js";
import { queueForApproval } from "./telegram-approval-queue.js";
import { executeCoordinatedMerge, checkAndAdvanceCoordination, NO_CODE_CHANGES_FALLBACK } from "../orchestrator/multi-repo-coordinator.js";
import { DagRuntime } from "../orchestrator/dag-runtime.js";
import { Planner } from "../orchestrator/planner.js";
import { pollVerificationOutcomes } from "../orchestrator/verification-outcome-poller.js";
import { startMetricsServer, DEFAULT_METRICS_PORT } from "./metrics-server.js";
import { reapStaleComposeProcesses } from "../utils/compose-reaper.js";
import { sweepStalePendingTasks } from "../triggers/stale-task-sweeper.js";
import type { Server } from "node:http";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const QUALITY_SLA_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const IMPROVEMENT_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const AUTO_MERGE_SWEEP_EVERY_N_CYCLES = 3;  // ~15min — same cadence as PR review
const FLEET_ACTIONS_DISPATCH_EVERY_N_CYCLES = 5;  // ~5min — producer/critic loop cadence (hustle + auditor)
const SUPERVISOR_CHECK_EVERY_N_CYCLES = 3; // ~15min at default interval
const RESEARCH_LINK_EVERY_N_CYCLES = 6; // ~30min — same cadence as improvement detection
const BACKLOG_TRIAGE_EVERY_N_CYCLES = 60; // ~5h at default interval
const CONTAINER_RESTART_EVERY_N_CYCLES = 100; // ~50min at 30s interval — prevents Docker stalls
const AGENT_SYNC_EVERY_N_CYCLES = 10; // ~5min at default interval — recover from proxy restarts
const SELF_UPDATE_EVERY_N_CYCLES = 10; // ~5min — pull + rebuild if behind origin/main, then re-exec

/**
 * Per-cycle cap on how many repos get the general PR-review sweep.
 *
 * Each repo sweep calls prReviewer.reviewOpenPRs(repo), which runs an LLM
 * review on every open PR in that repo. With ~11 active fleet repos and
 * 1–3 open PRs each, the uncapped sweep was running 10+ sequential LLM
 * calls per pollCycle — ~30s each, blowing out pollCycle past the 1200s
 * deadlock threshold (#1667). Capping to MAX_REPOS_PER_REVIEW_SWEEP per
 * cycle and rotating across repos based on `cycleCount` gives each repo
 * coverage every ~ceil(N_repos / cap) cycles. The priority review fast-
 * lane still fires on every cycle for dispatch-blocking PRs.
 */
const MAX_REPOS_PER_REVIEW_SWEEP = 3;

const CLOSED_ISSUE_CHECK_EVERY_N_CYCLES = 3; // ~15min at default — cancel in-flight tasks for closed issues
const STALE_ISSUE_AGE_DAYS = 7;
/** Minimum interval between standups (ms). Time-based so restarts don't skip meetings. */
const STANDUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
/** Minimum interval between blue-sky sessions (ms). */
const BLUESKY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Only check meeting schedule every N cycles to avoid querying the DB every cycle. */
const MEETING_SCHEDULE_CHECK_EVERY_N_CYCLES = 6; // ~30 min
const ROADMAP_PROPOSAL_EVERY_N_CYCLES = 288; // ~24h at 5min interval
const SKIP_PATTERN_CHECK_EVERY_N_CYCLES = 288; // ~24h at 5min interval
const ALREADY_IN_REVIEW_SATURATION_THRESHOLD = 0.30; // Alert when >30% of completed tasks are duplicates
/** Alert when >15% of dispatches in the 1h window are blocked by the already-in-review guard. */
const DISPATCH_WASTE_RATE_THRESHOLD = 0.15;
/** Alert when the 7-day rolling dispatch block rate exceeds this fraction (issue #976). */
const DISPATCH_BLOCK_RATE_THRESHOLD = 0.10; // 10% default
const PROXY_HEALTH_CHECK_EVERY_N_CYCLES = 3;   // ~15min — check proxy server is reachable
const CLOSED_ISSUE_FAILURE_CLEANUP_EVERY_N_CYCLES = 60; // ~5h — clear stale failures for closed issues
const PROACTIVE_REBASE_EVERY_N_CYCLES = 3; // ~15min — proactively rebase stale branches
const SEMANTIC_MEMORY_AUDIT_EVERY_N_CYCLES = 288; // ~24h — check semantic memory effectiveness (issue #1016)
const STALE_TASK_SWEEP_EVERY_N_CYCLES = 288; // ~24h at 5min interval — sweep stale pending/paused tasks (issue #1646)

/**
 * Get the current git HEAD commit hash (short form) for audit logging.
 * Returns "unknown" if git is unavailable.
 */
function getCurrentCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: "pipe" }).toString().trim();
  } catch {
    return "unknown";
  }
}

/**
 * Returns true if the working tree at `repoDir` has any modifications,
 * untracked files, or staged changes — anything that would block a
 * `git pull --ff-only`. Issue #1540.
 */
export function isWorkingTreeDirty(repoDir: string): boolean {
  try {
    const out = execSync("git status --porcelain", {
      cwd: repoDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
    return out.length > 0;
  } catch {
    // If git status itself fails, treat as not-dirty: we'll let the
    // pull attempt itself produce the actionable error.
    return false;
  }
}

/**
 * Stashes any working-tree modifications at `repoDir` so a clean
 * `git pull --ff-only` can succeed. Returns true iff a stash was actually
 * created. Issue #1540.
 */
export function stashWorkingTree(repoDir: string): boolean {
  if (!isWorkingTreeDirty(repoDir)) return false;
  execSync("git stash push --include-untracked --message 'selfUpdate auto-stash'", {
    cwd: repoDir,
    stdio: "pipe",
  });
  return true;
}

/**
 * Pops the most recent stash at `repoDir`. Returns the conflict-file list
 * (empty on clean pop) plus an optional error message describing why pop
 * failed. selfUpdate uses this to surface stash-pop conflicts to the operator
 * instead of letting them silently jam the working tree. Issue #1540.
 */
export function popStash(repoDir: string): { conflicted: string[]; error?: string } {
  try {
    execSync("git stash pop", { cwd: repoDir, stdio: "pipe" });
    return { conflicted: [] };
  } catch (err) {
    let conflicted: string[] = [];
    try {
      const out = execSync("git diff --name-only --diff-filter=U", {
        cwd: repoDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim();
      conflicted = out ? out.split("\n") : [];
    } catch {
      // Best-effort: leave conflicted as []
    }
    return { conflicted, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Maximum time a single poll cycle is allowed to run before the watchdog
 * kills it and moves on to the next cycle. Prevents a hung LLM call or
 * Docker operation from deadlocking the entire daemon for hours.
 */
/** Soft alert threshold: notify operator when a cycle exceeds this. */
const CYCLE_SLOW_ALERT_MS = 10 * 60 * 1000; // 10 minutes

/** Hard deadlock timeout: if a cycle exceeds this, abandon it and move on.
 *  Set high enough that it only fires for true deadlocks (infinite hangs),
 *  not for slow-but-completing cycles. At 20 min, normal cycles (4-8 min)
 *  and deploy-heavy cycles (10-15 min) all complete without triggering. */
const CYCLE_HARD_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Watchdog pressure threshold: 75% of the hard timeout.  An alert fires at
 * this point to give operators a heads-up *before* the soft-alert (10 min)
 * and hard-timeout (20 min) kick in — matching the acceptance criteria from
 * issue #811.  The alert deduplicates for PRESSURE_DEDUP_MS to prevent spam
 * across back-to-back slow cycles.
 */
const CYCLE_PRESSURE_ALERT_MS = CYCLE_HARD_TIMEOUT_MS * 0.75; // 15 minutes

/**
 * How long to suppress repeated watchdog-pressure alerts.  Set to 10 minutes
 * so that a sustained slow-cycle streak produces at most one alert per 10 min
 * rather than one per cycle.
 */
const PRESSURE_ALERT_DEDUP_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Default quality-score floor for reviewer-pool approvals.  Any completed
 * task from a reviewer-pool agent that is approved but scores below this
 * value triggers a Telegram alert and a supervisor follow-up dispatch.
 * Configurable via `verification.reviewer_low_score_threshold` in agents.yaml.
 */
const DEFAULT_REVIEWER_LOW_SCORE_THRESHOLD = 0.80;

/**
 * Default number of recent scored tasks used to compute an agent's rolling
 * average for quality SLA checks.  Configurable via
 * `verification.quality_sla_window_tasks` in agents.yaml.
 */
const DEFAULT_QUALITY_SLA_WINDOW_TASKS = 5;

/**
 * Tasks in 'done' state with no recorded result older than this threshold are
 * considered silent failures and will be flagged as 'result_missing'.
 */
const RESULT_MISSING_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * How often (in poll cycles) to run the orphan-branch → PR creation check.
 * Set to 1 so the check runs every cycle, ensuring that within a single poll
 * interval of a branch being pushed the orchestrator creates the PR.
 *
 * Previously this ran every SUPERVISOR_CHECK_EVERY_N_CYCLES (~15 min at the
 * default interval), causing a recurring failure mode where branches sat
 * unnoticed until the supervisor manually intervened.  Running every cycle
 * satisfies the acceptance criterion of "within 2 daemon cycles of a branch
 * push with no PR, an automated PR creation task is dispatched."
 */
export const ORPHAN_PR_CHECK_EVERY_N_CYCLES = 1; // every cycle

/**
 * How often (in poll cycles) to log the PR creation failure telemetry summary.
 * At the default 5-minute interval this is roughly every 50 minutes.
 */
export const PR_TELEMETRY_LOG_EVERY_N_CYCLES = 10;

/**
 * After this many consecutive idle poll cycles with no dispatch for an agent
 * that has open GitHub issues, switch to force-reclaim mode: bypass the
 * duplicate-guard recency window so the oldest open issue is re-dispatched
 * even if it was recently attempted.  This prevents agents from staying idle
 * indefinitely when all their open issues sit just inside the recency window.
 */
export const IDLE_RECLAIM_THRESHOLD_CYCLES = 2;

/**
 * Default maximum number of pr-feedback dispatch rounds before the daemon stops
 * dispatching and automatically escalates the PR to a human reviewer.  This is
 * the last-resort ceiling: the reviewer itself also escalates after N "Changes
 * Requested" comments (configurable via pr_review.feedback_ceiling), but that
 * check can fail if the gh API is unavailable.  The state-store counter here is
 * the reliable backstop that prevents infinite feedback loops.
 *
 * Override via agents.yaml: `pr_review: { feedback_ceiling: N }`.
 */
export const PR_FEEDBACK_CEILING = 3;

/**
 * Maximum number of automatic retries for tasks that time out (exit code 143 /
 * SIGTERM from container timeout).  Kept intentionally lower than MAX_RETRIES
 * so that hard timeouts don't exhaust the full retry budget.
 */
export const TIMEOUT_MAX_RETRIES = 2;

/**
 * Fixed backoff delay (ms) between timeout-retry attempts.
 * 2 minutes gives the agent container time to recover before re-dispatch.
 */
export const TIMEOUT_RETRY_DELAY_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Number of consecutive passing health checks required before a previously
 * failing agent is considered recovered.
 */
export const HEALTH_RECOVERY_CONFIRM_CYCLES = 3;

/**
 * Grace period (ms) after the first health check failure during which no
 * incident task is dispatched.  Agents that self-recover within this window
 * (e.g. normal container restart + initialisation) produce zero incident
 * tasks.  Only when the agent remains unhealthy past this threshold is an
 * escalation task created and a Telegram alert sent.
 *
 * Set to 5 minutes — long enough to cover the typical ~111 s Docker
 * container startup window observed in production incidents.
 */
export const HEALTH_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Maximum number of auto-recovery attempts the orchestrator makes before
 * escalating to a human.  Each attempt: checks secrets health, restarts
 * the agent, and re-runs the health check.  Health check failures that
 * self-resolve within this many retries produce no human notification.
 */
export const HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS = 2;

/**
 * Health check delays used during auto-recovery restarts.  Shorter than the
 * default (168 s) to keep the total recovery window within the daemon cycle
 * watchdog.  Two attempts at this schedule ≈ 70 s total.
 */
const RECOVERY_HEALTH_CHECK_DELAYS_MS = [5_000, 10_000, 20_000]; // max ~35 s per attempt

/**
 * Format a health-failure duration for console and Telegram output.
 * Seconds are used below a minute, minutes below an hour, and `h m` beyond.
 */
export function formatHealthDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export class Daemon {
  private running = false;
  private config: OrchestratorConfig;
  private store: StateStore;
  private dispatcher: Dispatcher;
  private reviewerClient: ReviewerClient;
  private researchLinker: ResearchLinker;
  private issueCreator: IssueCreator;
  private deployer: Deployer;
  private prReviewer: PRReviewer;
  private prRetryQueue: PRCreationRetryQueue;
  private dagRuntime: DagRuntime;
  private pollInterval: number;
  private cycleCount = 0;
  private log = createLogger("daemon");

  /**
   * Timestamp (ms) of the last watchdog-pressure Telegram alert sent.
   * Used to deduplicate alerts across consecutive slow cycles so operators
   * receive at most one pressure warning per PRESSURE_ALERT_DEDUP_MS window.
   */
  private lastPressureAlertMs = 0;

  /**
   * Tracks how many consecutive poll cycles each agent has been idle
   * (no active task AND no dispatch occurred).  Reset to 0 when a dispatch
   * succeeds.  Used to trigger force-reclaim when the duplicate-guard recency
   * window is blocking all available issues.
   */
  private idleCyclesSinceDispatch = new Map<string, number>();

  /**
   * Tracks agents currently in a health-check-failing state (in-memory; does
   * not persist across daemon restarts).  Used to:
   *   1. Deduplicate failure alerts — only fire once per failure streak.
   *   2. Fire a recovery notification when the agent passes a health check
   *      after having been in this set and passing the confirmation window.
   *   3. Auto-resolve dashboard health-check escalation entries on recovery.
   */
  private healthFailingAgents = new Set<string>();
  /** Records when the current health-failure incident started for each agent. */
  private healthFailureStartTimes = new Map<string, number>();
  /** Tracks consecutive passing health checks for recovery debounce. */
  private healthRecoveryConfirmCycles = new Map<string, number>();
  /**
   * Tracks agents for which the grace period has expired and an escalation
   * task + Telegram alert have been created.  Used to distinguish a silent
   * self-recovery (no task was ever created) from a post-escalation recovery
   * (task exists and should be auto-resolved).
   */
  private healthEscalatedAgents = new Set<string>();

  /**
   * Per-agent log of auto-recovery steps attempted before escalation.
   * Populated by `runAutoRecoveryPlaybook`; included in the escalation task
   * description so operators see exactly what was tried and why it failed.
   * Cleared when escalation fires or the agent recovers.
   */
  private healthAutoRecoveryHistory = new Map<string, string[]>();

  /** Tracks when the daily Slack digest was last sent (re-arms on new calendar day). */
  private digestState: DigestSchedulerState = { lastDigestDate: null };
  /** Tracks when the daily guard health digest was last sent (re-arms on new calendar day, issue #1163). */
  private guardDigestState: DigestSchedulerState = { lastDigestDate: null };
  /** Tracks when the daily persistent-anomalies digest was last sent (issue #1207). */
  private anomaliesDigestState: DigestSchedulerState = { lastDigestDate: null };
  private securityScanState: SecurityScanState = { lastScanDate: null };

  /** Resolved path to agents.yaml — stored for hot-reload. */
  private configPath: string | undefined;
  /** Watches agents.yaml for changes and triggers hot-reload. */
  private configWatcher: ConfigWatcher | null = null;

  /** Metrics HTTP server started on daemon startup (issue #976). */
  private metricsServer: Server | null = null;

  /** Wall-clock timestamp (ms) when the daemon was last started — used to compute uptime. */
  private startedAt = 0;

  /** Reason the daemon is stopping — populated before cleanup() so crash handlers can read it. */
  private stopReason: string | undefined = undefined;

  /**
   * Tracks task IDs seen in each daemon cycle to detect and alert on duplicates.
   * See issue #935.
   */
  private duplicateIdDetector = new DuplicateIdDetector();

  /**
   * Tracks agents currently being deployed by redeployStale.
   * Guards against overlapping deploy calls when a cycle times out and the next
   * cycle starts before the prior redeployStale completes — without this, both
   * cycles would trigger `docker compose up --build` for the same agent,
   * producing orphan compose processes that hold the working-tree open and block
   * concurrent git operations. Issue #1517.
   */
  private inFlightDeploys = new Set<string>();

  /**
   * Telemetry: total count of individual agent deploys skipped because a prior
   * deploy for the same agent was still in progress. Surfaced in logs for
   * observability. Issue #1517.
   */
  private deploySkippedCount = 0;

  /**
   * Telemetry: cumulative count of orphan `docker compose` processes the
   * daemon has SIGKILLed since startup. Surfaced in logs every cycle the
   * reaper kills anything (silent when no orphans are present). Issue #1558.
   */
  private composeOrphansReaped = 0;

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.configPath = configPath;
    this.config = loadConfig(configPath);

    // Validate config at startup — abort on errors
    const validationErrors = validateConfig(this.config);
    if (validationErrors.length > 0) {
      const details = validationErrors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
      throw new Error(`Config validation failed:\n${details}`);
    }

    this.store = new StateStore();
    // Resume cycle count from DB so modulo-based scheduling (meetings,
    // improvements, sync) survives daemon restarts.
    this.cycleCount = this.store.getTotalCycleCount();
    setLLMUsageRecorder(this.store.recordTokenUsage.bind(this.store));

    // Attach state store so duplicate-ID incidents are persisted across restarts.
    this.duplicateIdDetector.attachStore(this.store);

    // Wire up SQLite persistence for the issue-state cache (issue #590).
    // This ensures every fresh GitHub fetch is also written to the
    // issue_state_cache table so the dashboard can filter closed issues
    // out of the stuck-issues panel.
    initIssueCachePersistence(this.store);

    // Apply config overrides to modules that use module-level state
    setRecencyWindowHours(this.config.triggers?.recency_window_hours);
    setMergeStallThresholdHours(this.config.triggers?.merge_stall_threshold_hours);
    setTelegramRateLimitMs(this.config.notifications?.telegram_rate_limit_ms);
    this.dispatcher = new Dispatcher(this.config, this.store);
    // Wire duplicate-ID detector into dispatcher so it can record IDs and
    // handle collisions with Telegram alerts (issue #935).
    this.dispatcher.attachDuplicateIdDetector(this.duplicateIdDetector);

    this.reviewerClient = new ReviewerClient(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.researchLinker = new ResearchLinker(this.config, this.store, this.issueCreator);
    this.deployer = new Deployer(this.config);
    this.prReviewer = new PRReviewer(this.config, this.store, this.reviewerClient);
    this.prRetryQueue = new PRCreationRetryQueue(this.store);
    this.dagRuntime = new DagRuntime(this.store, this.dispatcher, new Planner(this.config, this.store));
    this.pollInterval = pollIntervalMs ?? this.config.daemon?.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = Date.now();
    writePid();

    // Record daemon start in the lifecycle audit trail (issue #1337 — include commit hash).
    const startCommit = getCurrentCommitHash();
    try {
      this.store.recordDaemonLifecycleEvent({
        event: "start",
        pid: process.pid,
        commit_hash: startCommit,
        reason: `started from commit ${startCommit}`,
      });
      this.log.info("Daemon started", { commit: startCommit, pid: process.pid });
    } catch (err) {
      this.log.warn("Failed to record daemon start lifecycle event", { error: String(err) });
    }

    const handleSignal = (signal: string) => {
      console.log(`\nShutting down (${signal})...`);
      this.stopReason = signal;
      this.stop();
    };
    process.on("SIGINT", () => handleSignal("SIGINT"));
    process.on("SIGTERM", () => handleSignal("SIGTERM"));

    // Capture unhandled errors and record them as crash events before exiting.
    const handleCrash = (err: unknown, origin: string) => {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = this.startedAt > 0 ? Date.now() - this.startedAt : undefined;
      const reason = `${origin}: ${message}`;
      console.error(`[daemon] FATAL — ${reason}`);
      try {
        this.store.recordDaemonLifecycleEvent({
          event: "crash",
          pid: process.pid,
          reason,
          exit_code: 1,
          duration_ms: durationMs,
        });
      } catch {
        // Best-effort — don't let recording failure mask the original error.
      }
      try {
        this.cleanup("crash");
      } catch {
        // Ignore cleanup errors during crash path.
      }
      process.exit(1);
    };
    process.on("uncaughtException", (err, origin) => handleCrash(err, origin));
    process.on("unhandledRejection", (reason) => handleCrash(reason, "unhandledRejection"));

    // SIGUSR1 triggers a config reload (used by `orch config reload`)
    process.on("SIGUSR1", () => {
      this.log.info("Received SIGUSR1 — reloading config");
      console.log("[config] SIGUSR1 received — reloading agents.yaml...");
      if (this.configWatcher) {
        const result = this.configWatcher.reload();
        if (result.success) {
          console.log(`[config] Reload successful: ${result.changes.length} change(s) applied`);
        } else {
          console.log(`[config] Reload rejected: ${result.errors.length} validation error(s)`);
        }
        this.recordConfigReload(result, "signal");
      }
    });

    // Start config file watcher for hot-reload
    this.startConfigWatcher();

    // Record the startup config snapshot in the audit trail so the /config
    // Telegram command and orch audit can show when the daemon last (re)started.
    this.store.recordConfigReload({
      timestamp: new Date().toISOString(),
      success: true,
      changes: [],
      errors: [],
      triggeredBy: "startup",
    });

    // Drift detection: warn if agents.yaml was edited after the last reload.
    this.checkConfigDrift();

    const githubRepos = Object.entries(this.config.agents)
      .filter(([, a]) => a.github)
      .map(([name, a]) => `${name} (${a.github})`);
    const linearTeams = Object.entries(this.config.agents)
      .filter(([, a]) => a.linear)
      .map(([name]) => name);
    const slackChannels = Object.entries(this.config.agents)
      .filter(([, a]) => a.slack)
      .map(([name]) => name);

    this.log.info("Daemon started", { pid: process.pid, pollInterval: this.pollInterval });
    console.log(`Daemon started (PID ${process.pid})`);
    console.log(`Poll interval: ${this.pollInterval / 1000}s`);
    console.log(`Verification: ${this.config.verification?.enabled ? "on" : "off"}`);
    if (githubRepos.length) console.log(`GitHub: ${githubRepos.join(", ")}`);
    if (linearTeams.length) console.log(`Linear: ${linearTeams.join(", ")}`);
    if (slackChannels.length) console.log(`Slack: ${slackChannels.join(", ")}`);
    console.log();

    // Start the metrics HTTP server so the dashboard can poll dispatch
    // efficiency data (issue #976).  Best-effort: failure must not block
    // the daemon loop.
    try {
      const metricsPort = DEFAULT_METRICS_PORT;
      this.metricsServer = startMetricsServer(this.store, metricsPort);
      console.log(`Metrics server: http://127.0.0.1:${metricsPort}/dispatch-efficiency`);
    } catch (err) {
      this.log.warn("Failed to start metrics server", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Ensure all agents from agents.yaml are registered with the proxy.
    // Force token refresh on startup — proxy loses credentials on restart.
    await this.syncAgents({ forceTokenRefresh: true });

    // Check that agents have GH_TOKEN configured — without it, `gh pr create` will fail
    // inside agent containers, causing tasks to require human escalation.
    await this.checkAgentGhAuth();

    // Immediately attempt recovery: syncAgents above pushes ghToken to the
    // management API, but checkAgentGhAuth may see stale registrations and
    // quarantine agents prematurely.  Running recovery here clears quarantine
    // for agents whose tokens have already propagated, instead of waiting 10
    // cycles (~5 min) for the periodic check.
    await this.checkAuthRecovery();

    // Scan state.db for any pre-existing duplicate task IDs at startup (issue #935).
    // Fires a Telegram alert if any are found so operators can investigate
    // before the first cycle begins.
    try {
      await checkDbForDuplicateIds(this.store);
    } catch (err) {
      this.log.warn("Startup duplicate-ID scan failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Check for data integrity issue: warn if >10% of recent approved tasks have null quality scores (issue #965).
    // This catches regressions where verification was completed but quality_score wasn't recorded.
    try {
      const scoreCheck = this.store.checkRecentApprovedTasksForNullScores(30); // last 30 days
      if (scoreCheck.shouldWarn) {
        const msg =
          `⚠️ Data quality warning: ${scoreCheck.nullScoreCount}/${scoreCheck.totalApproved} ` +
          `(${scoreCheck.nullScorePercentage.toFixed(1)}%) recent approved tasks have null quality_score. ` +
          `This indicates verification completed but quality scoring failed. ` +
          `Run 'orch tasks backfill-scores' to repair, or investigate why the verifier is not recording scores.`;
        this.log.warn("Null quality score threshold exceeded", scoreCheck);
        await notifyOperator(msg, "", "warning");
        console.warn("\n" + msg + "\n");
      }
    } catch (err) {
      this.log.warn("Startup null-score check failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Seed learned rules from CLAUDE.md files (idempotent — skips existing rules)
    try {
      const { seeded, repos } = await seedFromClaudeMd(this.config, this.store);
      if (seeded > 0) console.log(`Seeded ${seeded} learned rules from ${repos.length} repo(s)`);
    } catch (err) {
      this.log.warn("Failed to seed learned rules from CLAUDE.md", { error: err instanceof Error ? err.message : String(err) });
    }

    // Startup stale-dist check: rebuild immediately if dist/ is older than HEAD.
    // This catches the case where source was updated (PR merge, git pull) but
    // `npm run build` was never run — the daemon would otherwise silently execute
    // stale compiled code for up to SELF_UPDATE_EVERY_N_CYCLES cycles (~50 min).
    {
      // This module compiles to dist/service/daemon.js. To reach the repo root
      // we walk two segments up: service/ → dist/ → repo/. Previous code used
      // "../../.." which walked one segment too far (to the parent of the repo)
      // and silently broke every self-update path — fixed in the daemon-repo-path PR.
      const repoDir = resolve(new URL("../..", import.meta.url).pathname);
      const rebuilt = this.rebuildIfDistStale(repoDir);
      if (rebuilt) {
        // Re-exec so the current process loads the fresh dist immediately.
        this.log.info("Startup stale-dist rebuild complete — re-execing daemon");
        await notifyOperator("Daemon restarted: stale dist/ rebuilt on startup", "", "info");
        const { spawn } = await import("node:child_process");
        const nodeArgs = process.argv.slice(1);
        const child = spawn(process.execPath, nodeArgs, {
          detached: true,
          stdio: "ignore",
          env: process.env,
          cwd: repoDir,
        });
        child.unref();
        writePid(child.pid!);
        process.exit(0);
      }
    }

    // Start independent Telegram polling (3s interval, doesn't block cycles)
    startTelegramPolling({ config: this.config, store: this.store, dispatcher: this.dispatcher });

    while (this.running) {
      // Three-tier cycle protection (issue #811):
      //   1. Soft alert at 10 min   — first warning, keep waiting
      //   2. Pressure alert at 15 min — 75% of hard timeout; escalating warning
      //      with dedup so at most one alert fires per 10-minute window
      //   3. Hard timeout at 20 min — abandon the cycle (true deadlock only)
      //
      // The old 5-min watchdog created zombie cycles that caused cascading
      // slowdowns (366s → 695s → 984s). This three-tier approach lets normal
      // cycles (4-8 min) and deploy-heavy cycles (10-15 min) complete
      // naturally, while still giving operators advance warning before the
      // hard-timeout fires and recovering from true infinite hangs.

      const cyclePromise = this.pollCycle();
      const cycleStartMs = Date.now();

      // Pressure alert: fires at 75% of hard timeout (15 min) — gives operators
      // a heads-up *before* the slow-cycle alert (10 min already passed) and
      // well before the hard deadlock timeout (20 min).  Deduplicates across
      // consecutive slow cycles via lastPressureAlertMs so only one alert fires
      // per 10-minute window.  See issue #811.
      const pressureAlert = setTimeout(() => {
        const elapsedMs = Date.now() - cycleStartMs;
        const elapsedS = Math.round(elapsedMs / 1000);
        const pct = Math.round((elapsedMs / CYCLE_HARD_TIMEOUT_MS) * 100);
        const now = Date.now();

        if (now - this.lastPressureAlertMs < PRESSURE_ALERT_DEDUP_MS) return;
        this.lastPressureAlertMs = now;

        this.log.warn("Watchdog pressure: cycle at 75% of hard timeout", {
          elapsedMs,
          thresholdMs: CYCLE_PRESSURE_ALERT_MS,
          hardTimeoutMs: CYCLE_HARD_TIMEOUT_MS,
          cycle: this.cycleCount,
        });
        console.warn(
          `[WATCHDOG PRESSURE] Cycle #${this.cycleCount} has been running for ${elapsedS}s ` +
          `(${pct}% of ${CYCLE_HARD_TIMEOUT_MS / 1000}s hard limit) — investigate before next cycle`,
        );
        notifyOperator(
          "Watchdog pressure — cycle near timeout",
          `Daemon cycle #${this.cycleCount} has been running for ${elapsedS}s ` +
          `(${pct}% of the ${CYCLE_HARD_TIMEOUT_MS / 1000}s hard limit).\n\n` +
          `Timestamp: ${new Date().toISOString()}\n` +
          `Soft-alert threshold: ${CYCLE_SLOW_ALERT_MS / 1000}s (already passed)\n` +
          `Hard-timeout threshold: ${CYCLE_HARD_TIMEOUT_MS / 1000}s\n\n` +
          `Investigate before the next cycle starts. Check daemon logs: ` +
          `journalctl -u claude-orchestrator --since "15 minutes ago" | tail -100`,
          "warning",
          `watchdog-pressure:${Math.floor(now / PRESSURE_ALERT_DEDUP_MS)}`,
        ).catch(() => {});
      }, CYCLE_PRESSURE_ALERT_MS);

      // Soft alert: warn but don't interrupt
      const softAlert = setTimeout(() => {
        this.log.warn("Slow cycle: exceeding expected duration", {
          thresholdMs: CYCLE_SLOW_ALERT_MS,
          cycle: this.cycleCount,
        });
        console.warn(`[SLOW CYCLE] Cycle #${this.cycleCount} running for ${CYCLE_SLOW_ALERT_MS / 1000}s — still waiting`);
        notifyOperator(
          "Slow cycle detected",
          `Cycle #${this.cycleCount} has been running for ${CYCLE_SLOW_ALERT_MS / 1000}s. ` +
          `Waiting for completion (hard timeout at ${CYCLE_HARD_TIMEOUT_MS / 1000}s).`,
          "warning",
          `slow-cycle:${this.cycleCount}`,
        ).catch(() => {});
      }, CYCLE_SLOW_ALERT_MS);

      // Hard timeout: abandon cycle only for true deadlocks
      const hardTimeout = new Promise<"deadlock">((resolve) =>
        setTimeout(() => resolve("deadlock"), CYCLE_HARD_TIMEOUT_MS),
      );

      const result = await Promise.race([cyclePromise.then(() => "done" as const), hardTimeout]);
      clearTimeout(pressureAlert);
      clearTimeout(softAlert);

      if (result === "deadlock") {
        this.log.error("DEADLOCK: Cycle exceeded hard timeout — abandoning", {
          timeoutMs: CYCLE_HARD_TIMEOUT_MS,
          cycle: this.cycleCount,
        });
        console.error(`[DEADLOCK] Cycle #${this.cycleCount} exceeded ${CYCLE_HARD_TIMEOUT_MS / 1000}s — abandoning (zombie may persist)`);
        notifyOperator(
          "Cycle deadlocked — hard timeout",
          `Cycle #${this.cycleCount} exceeded the ${CYCLE_HARD_TIMEOUT_MS / 1000}s hard timeout. ` +
          `This indicates a true deadlock. The daemon will start a new cycle but the stuck ` +
          `cycle may continue in the background.`,
          "critical",
          `deadlock:${this.cycleCount}`,
        ).catch(() => {});
      }

      if (!this.running) break;
      await this.sleep(this.pollInterval);
    }

    this.cleanup();
  }

  stop(): void {
    this.running = false;
  }

  /** Run a batch of steps in parallel, logging any that reject. */
  private async runBatch(name: string, promises: Promise<unknown>[]): Promise<void> {
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === "rejected") {
        this.log.error(`Batch "${name}" step failed`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }

  private async pollCycle(): Promise<void> {
    const cycleStartedAt = new Date();
    const time = cycleStartedAt.toLocaleTimeString();
    this.cycleCount++;

    // Reset per-cycle duplicate-ID tracking (issue #935).
    this.duplicateIdDetector.startCycle();

    const cycleId = this.store.recordCycleStart();
    let registeredAgents: Set<string> = new Set();

    try {
      // ── Operator controls: apply before any dispatch/verify ─────────────
      try {
        const processor = new OperatorControlProcessor(this.store);
        const applied = await processor.applyPendingControls();
        if (applied > 0) {
          this.log.info(`Applied ${applied} operator control(s)`);
        }
      } catch (ctrlErr) {
        this.log.warn("Operator control processor failed", {
          error: ctrlErr instanceof Error ? ctrlErr.message : String(ctrlErr),
        });
      }

      // ── Sequential: must be first ──────────────────────────────────────
      registeredAgents = await this.deployer.getRegisteredAgents();

      // Self-update: pull + rebuild if behind origin/main, then re-exec.
      if (this.cycleCount % SELF_UPDATE_EVERY_N_CYCLES === 0) {
        this.log.info("Self-update: check starting", { cycle: this.cycleCount });
        await this.selfUpdate();
      }

      // Agent sync (every 10 cycles): recover from proxy restarts.
      if (this.cycleCount % AGENT_SYNC_EVERY_N_CYCLES === 0) {
        await this.syncAgents();
        registeredAgents = await this.deployer.getRegisteredAgents();
        await this.checkAgentGhAuth();
        await this.checkAuthRecovery();
      }

      // ── Parallel Batch 1: Housekeeping (no LLM, fast) ─────────────────
      const batch1: Promise<unknown>[] = [
        pollTelegram({ config: this.config, store: this.store, dispatcher: this.dispatcher }),
        this.checkHealthRecoveries(),
        this.checkResultMissingTasks(time),
        this.processRetries(time),
        this.pauseDisciplineDriftTasks(time),
        // #1608: page operator once per fresh awaiting-approval submission
        // (signal class: irreversible commitments). Internally dedupes via
        // pending_submissions.operator_pinged_at; cheap when the queue is
        // empty (a single index-backed SELECT).
        pingPendingSubmissions(this.store).catch((err) => {
          this.log.warn("submission-pinger failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      ];
      if (this.cycleCount % PROXY_HEALTH_CHECK_EVERY_N_CYCLES === 0) {
        batch1.push(this.checkProxyHealth(time));
      }
      // Sync tasks are wrapped as resolved promises
      this.checkStaleTasks(time);
      if (this.cycleCount % CLOSED_ISSUE_CHECK_EVERY_N_CYCLES === 0) {
        this.cancelClosedIssueTasks(time);
      }
      if (this.cycleCount % CLOSED_ISSUE_FAILURE_CLEANUP_EVERY_N_CYCLES === 0) {
        this.cleanupFailedTasksForClosedIssues(time);
      }
      await this.runBatch("housekeeping", batch1);

      // ── Parallel Batch 2: Dispatch + Verify (LLM heavy) ──────────────
      await this.runBatch("dispatch+verify", [
        this.dispatchTriggers(time, registeredAgents),
        this.verifyCompleted(time),
        this.dispatchPendingCoordinationGroups(time),
        this.advancePendingDags(time),
      ]);

      // ── Sequential: depends on dispatch/verify results ────────────────
      await this.pickupIdleAgents(time, registeredAgents);

      // ── Parallel Batch 3: PR Review/Merge + Supervisor + Deploy ───────
      // Note: preventiveRestart is NOT in this batch — it conflicts with
      // redeployStale when both target the same agents. It runs sequentially
      // after this batch instead.
      const batch3: Promise<unknown>[] = [
        this.redeployStale(time, registeredAgents),
      ];
      if (this.cycleCount % SUPERVISOR_CHECK_EVERY_N_CYCLES === 0) {
        batch3.push(this.reviewAndMerge(time));
        batch3.push(this.runSupervisor(time));
      } else {
        batch3.push(this.processMergeQueue(time));
      }
      // Auto-merge sweep (issue #1587): catches CLEAN/MERGEABLE PRs that
      // bypassed the reviewer (typically blocked by self-approval).
      if (this.cycleCount % AUTO_MERGE_SWEEP_EVERY_N_CYCLES === 0) {
        batch3.push(this.sweepStaleCleanPRs(time));
      }
      // Fleet-actions cycle: continuous producer/critic loop dispatch.
      // Hustle + auditor each get a bounded task every ~5min instead of
      // waiting on the 5h housekeeping cadence.
      if (this.cycleCount % FLEET_ACTIONS_DISPATCH_EVERY_N_CYCLES === 0) {
        batch3.push(this.dispatchFleetActionsCycle(time, registeredAgents));
      }
      await this.runBatch("pr-lifecycle+deploy", batch3);

      // Preventive restart — runs AFTER deploy to avoid double-restarting
      // agents that redeployStale already handled this cycle.
      if (this.cycleCount % CONTAINER_RESTART_EVERY_N_CYCLES === 0) {
        await this.preventiveRestart(time, registeredAgents);
      }

      // ── Parallel Batch 4: Periodic tasks (only when cycle matches) ────
      const batch4: Promise<unknown>[] = [];

      if (this.cycleCount % ORPHAN_PR_CHECK_EVERY_N_CYCLES === 0) {
        batch4.push(this.createOrphanPRs(time));
      }
      if (
        process.env.PROACTIVE_REBASE_DISABLED !== "true" &&
        this.cycleCount % PROACTIVE_REBASE_EVERY_N_CYCLES === 0
      ) {
        batch4.push(this.runProactiveRebases(time));
      }
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        batch4.push(this.detectImprovements(time));
        this.detectIterationCostImprovements(time);
        this.detectHealthIncidentIssues(time);
        batch4.push(this.checkIterationBudgetAlerts(time));
        batch4.push(this.checkMeetingRequests(time));
        batch4.push(this.checkPriorityOutcomeSignals(time));
        batch4.push(
          learnPatterns(this.config, this.store)
            .then((learned) => { if (learned > 0) console.log(`[${time}] Pattern learner: discovered ${learned} new pattern(s)`); })
            .catch((err) => { this.log.warn("Pattern learner failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );
      }
      // Time-based meeting schedule: check elapsed time since last meeting
      // rather than cycle modulo, so daemon restarts don't skip meetings.
      if (this.cycleCount % MEETING_SCHEDULE_CHECK_EVERY_N_CYCLES === 0) {
        const now = Date.now();
        const lastStandup = this.store.getLastMeetingTime("standup");
        const lastBluesky = this.store.getLastMeetingTime("bluesky");
        const standupElapsed = lastStandup ? now - new Date(lastStandup).getTime() : Infinity;
        const blueskyElapsed = lastBluesky ? now - new Date(lastBluesky).getTime() : Infinity;

        if (standupElapsed >= STANDUP_INTERVAL_MS) {
          batch4.push(this.runMeeting(time, "standup"));
          try {
            const { nudged, boosted } = checkAgedIssues(this.config, this.store);
            if (nudged.length + boosted.length > 0) {
              console.log(`[${time}] Aged issues: ${nudged.length} nudged, ${boosted.length} boosted`);
            }
          } catch (err) {
            this.log.warn("Aged issue check failed", { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (blueskyElapsed >= BLUESKY_INTERVAL_MS) {
          batch4.push(this.runMeeting(time, "bluesky"));
        }
      }
      if (this.cycleCount % ROADMAP_PROPOSAL_EVERY_N_CYCLES === 0) {
        batch4.push(
          proposeAndFileRoadmapItems(this.config, this.store)
            .then((filed) => { if (filed > 0) console.log(`[${time}] Roadmap proposer: filed ${filed} proposal(s)`); })
            .catch((err) => { this.log.warn("Roadmap proposal failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );

        // Auto-mark completed key results based on metrics
        try {
          const marked = autoMarkCompletedKeyResults(this.store, this.config.orchestrator_dir);
          if (marked > 0) console.log(`[${time}] Goals: auto-marked ${marked} key result(s) as done`);
        } catch (err) {
          this.log.warn("Goal auto-mark failed", { error: err instanceof Error ? err.message : String(err) });
        }

        // Check if goals need refreshing (most KRs done or month rolled over)
        batch4.push(
          maybeRefreshGoals(this.config, this.store)
            .then((refreshed) => { if (refreshed) console.log(`[${time}] Goals: refreshed goals.yaml with new targets`); })
            .catch((err) => { this.log.warn("Goal refresh failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );

        // Coverage gap analysis: propose new agents when topics are unowned
        try {
          const gaps = detectCoverageGaps(this.config, this.store);
          const proposal = suggestNewAgent(gaps, this.config);
          if (proposal) {
            const issueCreator = new IssueCreator(this.config);
            const body = `## New Agent Proposal (auto-generated)\n\n` +
              `**Suggested name:** \`${proposal.suggestedName}\`\n` +
              `**Capabilities:** ${proposal.capabilities.join(", ")}\n` +
              `**Owns topics:** ${proposal.owns_topics.join(", ")}\n\n` +
              `${proposal.reason}\n\n` +
              `### Detected gaps\n${proposal.gaps.map((g) => `- "${g.topic}" (${g.frequency} tasks): ${g.details}`).join("\n")}\n\n` +
              `---\n*Generated by the coverage gap detector.*`;
            try {
              issueCreator.createIssue("rapartlu/agent-orchestrator", `[Proposal] New agent: ${proposal.suggestedName}`, body, ["agent-proposal"]);
              console.log(`[${time}] Coverage gap: proposed new agent "${proposal.suggestedName}"`);
            } catch (err) {
              this.log.warn("Failed to file agent proposal", { error: err instanceof Error ? err.message : String(err) });
            }
          }
        } catch (err) {
          this.log.warn("Coverage gap agent proposal failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (this.cycleCount % RESEARCH_LINK_EVERY_N_CYCLES === 0) {
        batch4.push(this.linkResearchToImplementation(time));
      }
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        this.cleanupStaleIssues(time);
        this.reapStaleOrchestratorIssues(time);
      }
      // triageBacklogs is called every cycle; internally it filters to only the
      // agents whose housekeeping_offset_cycles is due this cycle, so at most one
      // agent fires per cycle and the overall load is evenly spread across the
      // BACKLOG_TRIAGE_EVERY_N_CYCLES window.  See AgentConfig.housekeeping_offset_cycles.
      batch4.push(this.triageBacklogs(time));
      if (this.cycleCount % BACKLOG_TRIAGE_EVERY_N_CYCLES === 0) {
        // Proactive scan remains tied to cycle 0 of each window — it's cheap and
        // covers repo-wide signals rather than per-agent housekeeping.
        try {
          const filed = runProactiveScan(this.config, this.store);
          if (filed > 0) console.log(`[${time}] Proactive scan: filed ${filed} issue(s)`);
        } catch (err) {
          this.log.warn("Proactive scan failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      batch4.push(maybePostDailyDigest(this.digestState, this.store, this.config));
      batch4.push(maybePostDailyGuardDigest(this.guardDigestState, this.store, "09:00"));
      batch4.push(maybePostDailyAnomaliesDigest(this.anomaliesDigestState, this.store, "09:00"));
      batch4.push(maybeRunDailySecurityScan(this.securityScanState, this.config, new Date(), this.store));
      if (this.cycleCount % QUALITY_SLA_CHECK_EVERY_N_CYCLES === 0) {
        batch4.push(this.checkQualitySlaBreaches(time));
      }
      // Daily skip-pattern aggregation — auto-create GitHub issues for systemic
      // dispatch blockers when any reason exceeds the 5-skip-in-7-days threshold
      // (issue #787).  Fires a Telegram alert for each new blocker so operators
      // are notified in real-time rather than waiting for the next standup
      // (issue #795).
      if (this.cycleCount % SKIP_PATTERN_CHECK_EVERY_N_CYCLES === 0) {
        batch4.push(
          runSkipPatternCheck(this.config, this.store)
            .then((created) => { if (created > 0) console.log(`[${time}] Skip-pattern aggregator: created ${created} blocker issue(s)`); })
            .catch((err) => { this.log.warn("Skip-pattern check failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );
      }

      // Semantic memory effectiveness audit — daily check that measures
      // whether memory-assisted tasks achieve ≥15% higher first-pass
      // verification rates vs unmatched tasks (issue #1016).
      if (this.cycleCount % SEMANTIC_MEMORY_AUDIT_EVERY_N_CYCLES === 0) {
        try {
          const eff = this.store.getSemanticMemoryEffectiveness();
          const hitPct = eff.memory_hit_rate !== null ? Math.round(eff.memory_hit_rate * 100) : 0;
          const delta = eff.improvement_delta;
          console.log(
            `[${time}] Semantic memory: hit rate ${hitPct}%, ` +
            `improvement delta ${delta !== null ? `${(delta * 100).toFixed(1)}%` : "N/A"}, ` +
            `target met: ${eff.meets_target ?? "insufficient data"}`,
          );

          // Auto-tune: adjust min_quality_score based on effectiveness data (issue #1029)
          const configThreshold = this.config.semantic_memory?.min_quality_score ?? 0.80;
          const currentThreshold = this.store.getTunedMinQualityScore() ?? configThreshold;
          const tuneResult = this.store.applyAutoTuneIfBeneficial(currentThreshold);
          if (tuneResult.action !== "keep") {
            console.log(
              `[${time}] Semantic memory auto-tune: ${tuneResult.action} threshold ` +
              `${tuneResult.current_threshold} → ${tuneResult.recommended_threshold}. ` +
              `Reason: ${tuneResult.reason}`,
            );
            notifyOperator(
              `Semantic Memory Threshold Auto-tuned`,
              `min_quality_score adjusted: ${tuneResult.current_threshold} → ${tuneResult.recommended_threshold}. ` +
              tuneResult.reason,
              "info",
              "semantic-memory-autotune",
            );
          }

          // Alert if we have enough data and the target is not met
          if (
            eff.matched.total_tasks >= 10 &&
            eff.unmatched.total_tasks >= 10 &&
            eff.meets_target === false
          ) {
            const deltaPct = delta !== null ? `${(delta * 100).toFixed(1)}%` : "N/A";
            notifyOperator(
              "Semantic Memory Below Target",
              `After ${eff.matched.total_tasks + eff.unmatched.total_tasks} tasks, ` +
              `memory-assisted first-pass rate improvement is ${deltaPct} (target: ≥15%). ` +
              `Matched FPR: ${eff.matched.first_pass_rate !== null ? `${(eff.matched.first_pass_rate * 100).toFixed(1)}%` : "N/A"}, ` +
              `Unmatched FPR: ${eff.unmatched.first_pass_rate !== null ? `${(eff.unmatched.first_pass_rate * 100).toFixed(1)}%` : "N/A"}. ` +
              `Auto-tune applied (new threshold: ${this.store.getTunedMinQualityScore() ?? configThreshold}).`,
              "warning",
              "semantic-memory-effectiveness",
            );
          }
        } catch (err) {
          this.log.warn("Semantic memory effectiveness check failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Already-in-review saturation check — runs every cycle.
      // Alerts operators when duplicate-detection responses dominate the
      // 1-hour window (>30%), indicating dispatch dedup is failing or PR
      // throughput has fallen behind issue intake (issue #918).
      try {
        const sat = this.store.getAlreadyInReviewSaturation(1);
        if (sat.total >= 5 && sat.ratio > ALREADY_IN_REVIEW_SATURATION_THRESHOLD) {
          const pct = Math.round(sat.ratio * 100);
          this.log.warn("High already-in-review saturation", {
            ratio: sat.ratio,
            alreadyInReview: sat.alreadyInReview,
            total: sat.total,
          });
          console.warn(
            `[${time}] ⚠  Already-in-review saturation: ${pct}% (${sat.alreadyInReview}/${sat.total} dispatch attempts in last hour)`,
          );
          await notifyOperator(
            "⚠️ High Already-in-Review Saturation",
            `${pct}% of dispatch attempts in the last hour (${sat.alreadyInReview}/${sat.total}) were ` +
            `blocked by the "already-in-review" guard — exceeds the ${Math.round(ALREADY_IN_REVIEW_SATURATION_THRESHOLD * 100)}% threshold.\n\n` +
            `Top agents:\n${sat.perAgent.slice(0, 5).map((a) => `• ${a.agent_name}: ${Math.round(a.ratio * 100)}% (${a.alreadyInReview}/${a.total})`).join("\n")}\n\n` +
            `Check dispatch dedup logic or PR throughput — run \`orch review-saturation\` for details.`,
            "warning",
            "already-in-review-saturation",
          );
          this.store.incrementStat("already_in_review_saturation_alerts");
        }
      } catch (err) {
        this.log.warn("Already-in-review saturation check failed", { error: err instanceof Error ? err.message : String(err) });
      }

      // Dispatch waste-rate alert (issue #991): fires when the open_pr_exists
      // guard is blocking ≥15% of dispatch attempts in the last 1-hour window.
      // Complements the 30%-saturation check above with an earlier warning that
      // lets operators investigate before efficiency falls to critical levels.
      try {
        const wasteMetrics = this.store.getDispatchWasteMetrics24h();
        // Check the most recent hour only (last element in the hourly array)
        const recentHour = wasteMetrics.hourly.at(-1);
        if (
          recentHour &&
          recentHour.dispatches_total >= 3 &&
          recentHour.waste_rate_pct !== null &&
          recentHour.waste_rate_pct > DISPATCH_WASTE_RATE_THRESHOLD * 100
        ) {
          const pct = recentHour.waste_rate_pct.toFixed(1);
          this.log.warn("Dispatch waste rate threshold breached", {
            hour: recentHour.hour,
            waste_rate_pct: recentHour.waste_rate_pct,
            stale_prevented: recentHour.stale_prevented,
            dispatches_total: recentHour.dispatches_total,
          });
          await notifyOperator(
            "⚠️ Dispatch Waste Rate Elevated",
            `${pct}% of dispatch attempts in the last hour were blocked by the ` +
            `already-in-review guard (${recentHour.stale_prevented} blocked / ${recentHour.dispatches_total} total).\n\n` +
            `This exceeds the ${Math.round(DISPATCH_WASTE_RATE_THRESHOLD * 100)}% threshold. ` +
            `The orchestrator is re-triggering issues that already have open PRs.\n\n` +
            `Run \`orch dispatch-efficiency\` for a 24h/7d breakdown or check the dispatch dedup logic.`,
            "warning",
            "dispatch-waste-rate-threshold",
          );
          this.store.incrementStat("dispatch_waste_rate_alerts");
        }
      } catch (err) {
        this.log.warn("Dispatch waste rate check failed", { error: err instanceof Error ? err.message : String(err) });
      }

      // Dispatch block rate check (issue #976): alert when the 7-day rolling
      // block rate exceeds the configurable threshold (default 10%).
      // This complements the already-in-review saturation check (above, 1h window)
      // with a longer trend signal that is more resistant to transient spikes.
      try {
        const blockMetrics = this.store.getDispatchBlockMetrics(7);
        const blockRatePct = blockMetrics.avg_block_rate_pct;
        const threshold = DISPATCH_BLOCK_RATE_THRESHOLD * 100;
        if (
          blockRatePct !== null &&
          blockMetrics.total_dispatches >= 5 &&
          blockRatePct > threshold
        ) {
          const trendLabel = blockMetrics.trend === "worsening"
            ? " (trend: ↑ worsening)" : blockMetrics.trend === "improving"
            ? " (trend: ↓ improving)" : "";
          this.log.warn("High dispatch block rate", {
            block_rate_pct: blockRatePct,
            total_blocked: blockMetrics.total_blocked,
            total_dispatches: blockMetrics.total_dispatches,
            trend: blockMetrics.trend,
          });
          console.warn(
            `[${time}] ⚠  Dispatch block rate: ${blockRatePct.toFixed(1)}% over 7 days ` +
            `(${blockMetrics.total_blocked} blocked / ${blockMetrics.total_dispatches} total)${trendLabel}`,
          );
          await notifyOperator(
            "⚠️ High Dispatch Block Rate",
            `${blockRatePct.toFixed(1)}% of dispatches in the last 7 days were blocked by the ` +
            `already-in-review guard (${blockMetrics.total_blocked}/${blockMetrics.total_dispatches}) — ` +
            `exceeds the ${threshold.toFixed(0)}% threshold${trendLabel}.\n\n` +
            `This suggests the orchestrator is over-dispatching — re-triggering issues that already ` +
            `have open PRs. Consider reviewing dispatch frequency or de-duplicating triggers.\n\n` +
            `Run \`orch dispatch-efficiency\` for a day-by-day breakdown.`,
            "warning",
            "dispatch-block-rate-threshold",
          );
          this.store.incrementStat("dispatch_block_rate_alerts");
        }
      } catch (err) {
        this.log.warn("Dispatch block rate check failed", { error: err instanceof Error ? err.message : String(err) });
      }

      // Verification outcome poller — runs every cycle; resolves pending
      // verification_outcome_logs entries once their PRs reach terminal state.
      // Drives the calibration feedback loop (findings/verification-calibration.md).
      batch4.push(
        pollVerificationOutcomes(this.store)
          .then((resolved) => { if (resolved > 0) this.log.info("Verification outcomes resolved", { resolved }); })
          .catch((err) => { this.log.warn("Verification outcome poller failed", { error: err instanceof Error ? err.message : String(err) }); }),
      );

      // Stale-task sweep (issue #1646): once per day (~288 cycles at 5min interval).
      if (this.cycleCount % STALE_TASK_SWEEP_EVERY_N_CYCLES === 0) {
        batch4.push(this.sweepStaleTasks(time));
      }

      if (batch4.length > 0) await this.runBatch("periodic", batch4);

      // ── Cleanup (sync, fast) ──────────────────────────────────────────
      try {
        const pruned = this.store.pruneExpiredSignals();
        if (pruned > 0) {
          this.log.info("Pruned expired stigmergy signals", { count: pruned });
        }
      } catch (err) {
        this.log.warn("Signal prune failed", { error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.store.recordCycleEnd(cycleId, cycleStartedAt);
      const durationMs = Date.now() - cycleStartedAt.getTime();
      // Surface issue state cache metrics every cycle (issue #458)
      logCacheMetrics();
      this.log.info("Cycle complete", { cycle: this.cycleCount, durationMs });
      console.log(`[${time}] Cycle #${this.cycleCount} complete (${durationMs}ms)`);
    }

  }

  /**
   * Checks if the local repo is behind origin/main. If so, pulls the latest
   * changes, rebuilds the TypeScript, and re-execs the daemon process so the
   * new code takes effect without operator intervention.
   */
  /**
   * Checks whether dist/ is stale relative to the latest git commit and, if so,
   * rebuilds immediately.  This catches the case where source was updated (git pull
   * or a PR merge) but `npm run build` was never run — meaning the daemon would
   * silently execute old compiled code even though HEAD is current.
   *
   * Staleness is determined by comparing the mtime of dist/service/daemon-entry.js
   * against the author timestamp of the HEAD commit.  A rebuild is triggered when:
   *   - dist/service/daemon-entry.js is missing, OR
   *   - its mtime is older than the HEAD commit timestamp
   *
   * Returns true if a rebuild was performed, false otherwise.
   */
  private rebuildIfDistStale(repoDir: string): boolean {
    try {
      const distFile = resolve(repoDir, "dist/service/daemon-entry.js");

      // If dist doesn't exist at all, we must rebuild.
      if (!existsSync(distFile)) {
        this.log.warn("Stale dist: dist/service/daemon-entry.js missing — rebuilding");
        execSync("npm run build", { cwd: repoDir, stdio: "pipe", timeout: 300_000 });
        this.log.info("Stale dist: rebuild complete (was missing)");
        return true;
      }

      const distMtimeMs = statSync(distFile).mtimeMs;

      // git log -1 --format=%ct prints the commit timestamp as Unix seconds.
      const headCommitSec = execSync("git log -1 --format=%ct HEAD", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 10_000,
      })
        .toString()
        .trim();
      const headCommitMs = parseInt(headCommitSec, 10) * 1000;

      if (distMtimeMs >= headCommitMs) return false; // dist is fresh

      const staleSec = Math.round((headCommitMs - distMtimeMs) / 1000);
      this.log.warn("Stale dist detected — rebuilding", {
        distMtime: new Date(distMtimeMs).toISOString(),
        headCommit: new Date(headCommitMs).toISOString(),
        staleBySeconds: staleSec,
      });
      execSync("npm run build", { cwd: repoDir, stdio: "pipe", timeout: 300_000 });
      this.log.info("Stale dist: rebuild complete", { staleBySeconds: staleSec });
      return true;
    } catch (err) {
      this.log.warn("Stale dist check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async selfUpdate(): Promise<void> {
    // Reap prior-cycle orphan compose processes at the top of every
    // selfUpdate. Previous selfUpdate cycles can leave a hung
    // `docker compose up --build` from the proxy-side rebuild that triggered
    // when this daemon last redeployed an agent. Issue #1558.
    const time = new Date().toISOString().slice(11, 19);
    this.reapOrphanComposeProcesses(time, "selfUpdate");

    // See note in the startup-rebuild block above: this module compiles to
    // dist/service/daemon.js, so two segments up reaches the repo root.
    const repoDir = resolve(new URL("../..", import.meta.url).pathname);
    try {
      const beforeHash = getCurrentCommitHash();
      // Timeout guard: git fetch can hang indefinitely on network stall.
      // Without a timeout, execSync blocks the event loop and the watchdog
      // setTimeout callbacks cannot fire — the daemon silently hangs. Issue #1594.
      execSync("git fetch origin main --quiet", { cwd: repoDir, stdio: "pipe", timeout: 30_000 });
      const behind = execSync("git rev-list HEAD..origin/main --count", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 10_000,
      })
        .toString()
        .trim();
      if (behind === "0") {
        // Git is current but dist might still be stale (e.g. git pull without build,
        // or a manual file edit).  Rebuild silently if needed; no re-exec required
        // because this is an in-place fix that takes effect on the next cycle.
        this.log.info("Self-update: up to date", { commit: beforeHash });
        this.rebuildIfDistStale(repoDir);
        return;
      }

      const commits = execSync("git log HEAD..origin/main --oneline", {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 10_000,
      })
        .toString()
        .trim();
      this.log.info("Self-update: new commits detected, pulling and rebuilding", {
        behindBy: Number(behind),
        commits,
      });

      // Issue #1540: operator-side working-tree edits (e.g. agents.yaml linear
      // teams overrides, or the daemon's own .orchestrator-deploy-sha mutation)
      // would otherwise abort `git pull --ff-only` with "local changes would be
      // overwritten by merge", silently freezing the daemon at an old commit.
      // Stash pre-pull, pop post-pull, surface conflicts to operator.
      const hadStash = stashWorkingTree(repoDir);

      try {
        execSync("git pull --ff-only origin main", { cwd: repoDir, stdio: "pipe", timeout: 30_000 });
      } catch (pullErr) {
        // Issue #1492: detect branch divergence from main (typically caused by
        // a squash-merge that left the daemon's checkout pointing at a feature
        // branch whose original commits are no longer reachable from origin/main).
        // Without this branch, the outer catch logs a generic warning and the
        // daemon continues on stale code, never picking up shipped fixes.
        let ahead = "0";
        try {
          ahead = execSync("git rev-list origin/main..HEAD --count", {
            cwd: repoDir,
            stdio: "pipe",
            timeout: 10_000,
          })
            .toString()
            .trim();
        } catch {
          // If even rev-list fails, fall through to the original error path
          // — there's nothing actionable we can say.
        }
        if (Number(ahead) > 0) {
          this.log.warn(
            "Self-update: ff-only pull refused — branch is divergent from origin/main (likely squash-merge)",
            {
              ahead: Number(ahead),
              behindBy: Number(behind),
              repoDir,
              remediation:
                "Run `git fetch origin && git reset --hard origin/main && npm run build` then restart the daemon",
              gitError: pullErr instanceof Error ? pullErr.message : String(pullErr),
            },
          );
          await notifyOperator(
            "Daemon selfUpdate: branch divergent from main",
            `Daemon checkout has ${ahead} commit(s) ahead of origin/main and ${behind} behind; ff-only pull refused. ` +
              `Likely cause: the daemon's branch was squash-merged into main, so local HEAD is no longer reachable from main. ` +
              `Manual recovery (in ${repoDir}): \`git fetch origin && git reset --hard origin/main && npm run build\` ` +
              `then restart the daemon.`,
            "warning",
          );
          // Restore stashed working-tree before bailing so the next cycle
          // doesn't see an "extra" stash entry from this aborted attempt.
          if (hadStash) {
            const popResult = popStash(repoDir);
            if (popResult.error || popResult.conflicted.length > 0) {
              this.log.warn("Self-update: stash restore failed after divergent-branch abort", popResult);
            }
          }
          // Don't proceed to rebuild on stale tree; let the next cycle try again
          // after the operator resolves the divergence.
          return;
        }
        // Non-divergent failure (e.g. network error mid-pull). Restore the
        // stash before re-throwing so the outer catch sees a clean tree.
        if (hadStash) {
          const popResult = popStash(repoDir);
          if (popResult.error || popResult.conflicted.length > 0) {
            this.log.warn("Self-update: stash restore failed after pull error", popResult);
          }
        }
        throw pullErr;
      }

      // Pull succeeded. Restore stashed working-tree edits. If the upstream
      // changes touched the same files, surface the conflict to the operator —
      // the daemon keeps running on the new code, but the working tree retains
      // conflict markers until the operator resolves them.
      if (hadStash) {
        const popResult = popStash(repoDir);
        if (popResult.conflicted.length > 0) {
          this.log.warn(
            "Self-update: stash pop produced conflicts — local edits and upstream changes both touched the same files",
            { conflicted: popResult.conflicted },
          );
          await notifyOperator(
            "Daemon selfUpdate: stash-pop conflict — operator review needed",
            `Self-update pulled origin/main successfully but conflicts arose when restoring stashed working-tree edits. ` +
              `Conflicted file(s): ${popResult.conflicted.join(", ")}. ` +
              `The daemon will continue running on the new code; conflict markers remain in the working tree at ${repoDir} until you resolve them.`,
            "warning",
          );
        } else if (popResult.error) {
          this.log.warn("Self-update: stash pop failed without surfaced conflicts", {
            error: popResult.error,
          });
        }
      }

      execSync("npm run build", { cwd: repoDir, stdio: "pipe", timeout: 300_000 });

      const afterHash = getCurrentCommitHash();
      this.log.info("Self-update: rebuild complete, re-execing daemon", {
        from: beforeHash,
        to: afterHash,
      });

      // Record self-update event in the audit trail (issue #1337).
      const durationMs = this.startedAt > 0 ? Date.now() - this.startedAt : undefined;
      try {
        this.store.recordDaemonLifecycleEvent({
          event: "self-update",
          pid: process.pid,
          reason: `updated ${beforeHash} → ${afterHash} (${behind} commit${Number(behind) === 1 ? "" : "s"}): ${commits.split("\n").slice(0, 5).join("; ")}`,
          duration_ms: durationMs,
          commit_hash: afterHash,
        });
      } catch (auditErr) {
        this.log.warn("Failed to record self-update lifecycle event", { error: String(auditErr) });
      }

      await notifyOperator(
        `Daemon self-updated (${behind} commit${Number(behind) === 1 ? "" : "s"})`,
        `${beforeHash} → ${afterHash}\n${commits}`,
        "info",
      );

      // Guard: only the canonical daemon (the one whose PID is in daemon.pid)
      // should spawn a replacement. If another instance already owns the PID
      // file, just exit — don't pile on another child.
      const currentPid = readPid();
      if (currentPid !== null && currentPid !== process.pid) {
        this.log.warn("Self-update: another daemon owns the PID file, exiting without spawning", {
          ownerPid: currentPid,
          myPid: process.pid,
        });
        process.exit(0);
      }

      // Spawn fresh daemon with new build, hand off PID ownership, then exit.
      // Spawn BEFORE removing the old PID so there is no window where
      // daemon.pid is missing — we immediately overwrite it with the child PID.
      // process.argv = ["node", "dist/service/daemon-entry.js", ...flags]
      const { spawn } = await import("node:child_process");
      const nodeArgs = process.argv.slice(1); // everything after "node"
      const child = spawn(process.execPath, nodeArgs, {
        detached: true,
        stdio: "ignore",
        env: process.env,
        cwd: repoDir,
      });
      child.unref();

      // Transfer PID ownership to the child before we exit so monitoring
      // sessions never see a missing daemon.pid.
      writePid(child.pid!);
      process.exit(0);
    } catch (err) {
      this.log.warn("Self-update failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async syncAgents(options?: { forceTokenRefresh?: boolean }): Promise<void> {
    try {
      const management = new ManagementClient(this.config.proxy);
      const proxyAgents = await management.listAgents();
      const actions = planSync(this.config, proxyAgents, options);
      const needsWork = actions.filter((a) => a.type !== "skip");
      if (needsWork.length === 0) {
        this.log.info("Agent sync: all agents registered");
        return;
      }
      this.log.info("Agent sync: registering missing agents", {
        actions: needsWork.map((a) => `${a.type} ${a.agentName}`),
      });
      const result = await executeSync(this.config, management, actions, { removeUnknown: true });
      if (result.errors.length > 0) {
        this.log.error("Agent sync errors", { errors: result.errors });
      }
    } catch (err) {
      this.log.error("Agent sync failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Check that running agent containers have GH_TOKEN configured.
   * Logs a warning for each agent missing it — without GH_TOKEN, `gh pr create`
   * and other GitHub CLI calls will fail inside the container.
   *
   * Also quarantines agents that are missing GH_TOKEN (issue #418) so the
   * dispatcher blocks non-research tasks until auth is restored.
   */
  private async checkAgentGhAuth(): Promise<void> {
    try {
      // If the orchestrator has a GH_TOKEN configured (secrets file, env, or .env),
      // it will be pushed to all agents via syncAgents. Skip the management API
      // check which returns stale data (proxy doesn't persist ghToken in responses).
      if (this.config.proxy.gh_token) {
        this.log.info("Agent GH auth check: skipped — orchestrator has GH_TOKEN configured, will push to agents via sync");
        return;
      }

      const management = new ManagementClient(this.config.proxy);
      const reachable = await management.isReachable();
      if (!reachable) return;

      const proxyAgents = await management.listAgents();
      const missing: string[] = [];

      for (const agent of proxyAgents) {
        if (agent.status === "running" && !agent.ghToken) {
          missing.push(agent.name);
          // Quarantine the agent so it only receives research tasks
          this.store.setAgentAuthDegraded(agent.name, "GH_TOKEN missing from container environment");
        }
      }

      if (missing.length > 0) {
        const msg = `${missing.length} running agent(s) missing GH_TOKEN — quarantined as auth-degraded: ${missing.join(", ")}`;
        this.log.warn("Agent GH auth check — agents quarantined", { missing });
        console.log(`⚠  ${msg}`);
        notifyOperator(
          "Agents quarantined: missing GH_TOKEN",
          `${missing.length} agent(s) quarantined on startup: ${missing.join(", ")}. ` +
          `These agents will only receive research tasks until GH_TOKEN is restored.`,
          "critical",
          "startup-auth-check",
        );
      } else if (proxyAgents.filter((a) => a.status === "running").length > 0) {
        this.log.info("Agent GH auth check: all running agents have GH_TOKEN");
      }
    } catch (err) {
      this.log.error("Agent GH auth check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Periodic auth recovery check (issue #418).
   *
   * Re-validates agents currently in auth-degraded state.  If the orchestrator's
   * own GH_TOKEN has recovered (validateGhAuth() returns ok) AND the agent's
   * container now has a GH_TOKEN configured, clear the quarantine so it can
   * receive implementation tasks again.
   *
   * Runs at the same cadence as agent sync (~5 min) to balance responsiveness
   * against management API load.
   */
  private async checkAuthRecovery(): Promise<void> {
    const degraded = this.store.getAuthDegradedAgents();
    if (degraded.length === 0) return;

    // First check if the orchestrator's own auth has recovered
    const authStatus = validateGhAuth();
    if (!authStatus.ok) {
      this.log.info("Auth recovery check: orchestrator GH_TOKEN still invalid, skipping", {
        degradedCount: degraded.length,
      });
      return;
    }

    // Check each degraded agent's container for GH_TOKEN
    let management: ManagementClient | null = null;
    let proxyAgentMap: Map<string, boolean> | null = null;
    try {
      management = new ManagementClient(this.config.proxy);
      const reachable = await management.isReachable();
      if (reachable) {
        const proxyAgents = await management.listAgents();
        proxyAgentMap = new Map(proxyAgents.map((a) => [a.name, !!a.ghToken]));
      }
    } catch {
      // If proxy is unreachable, we can still clear agents whose quarantine was
      // caused by the orchestrator's own auth failure (not container-level).
    }

    const recovered: string[] = [];
    for (const agent of degraded) {
      // If we can check the container, require it to have GH_TOKEN too
      if (proxyAgentMap !== null) {
        const containerHasToken = proxyAgentMap.get(agent.agent_name);
        if (containerHasToken === false) {
          // Container still missing token — keep quarantined
          continue;
        }
      }

      // Auth has recovered — clear quarantine
      this.store.clearAgentAuthDegraded(agent.agent_name);
      recovered.push(agent.agent_name);
    }

    if (recovered.length > 0) {
      this.log.info("Auth recovery: agents un-quarantined", { recovered });
      console.log(`✅ Auth recovered for ${recovered.length} agent(s): ${recovered.join(", ")}`);

      // Auth recovery also means PR creation retries that failed due to
      // "gh-auth-failed" should be re-attempted.  Reset them back to pending
      // so the retry queue picks them up next cycle (issue #427).
      const resetCount = this.prRetryQueue.resetAuthFailures();
      if (resetCount > 0) {
        console.log(`✅ Reset ${resetCount} auth-failed PR creation(s) for retry`);
      }

      notifyOperator(
        "Agents recovered from auth-degraded",
        `${recovered.length} agent(s) restored to full operation: ${recovered.join(", ")}. ` +
        `GH_TOKEN is now valid — implementation tasks will be dispatched normally.` +
        (resetCount > 0 ? ` Also reset ${resetCount} failed PR creation(s) for retry.` : ""),
        "info",
        "auth-recovery",
      );
    }
  }

  private checkStaleTasks(time: string): void {
    const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    const dispatched = this.store.listTasks({ status: "dispatched", limit: 20 });
    const now = Date.now();

    for (const task of dispatched) {
      const agentConfig = task.agent_name ? this.config.agents[task.agent_name] : undefined;
      const staleThresholdMs = agentConfig?.stale_timeout_ms ?? DEFAULT_STALE_THRESHOLD_MS;
      const age = now - new Date(task.updated_at).getTime();
      if (age > staleThresholdMs) {
        const { retry_count: newRetryCount, next_retry_at: nextRetryAt } =
          computeTimeoutRetry(task.retry_count ?? 0, now);
        const willRetry = nextRetryAt !== null;

        console.log(
          `[${time}] Stale task ${task.id.slice(0, 8)} (${task.agent_name}): dispatched ${Math.round(age / 60000)}min ago — ${
            willRetry
              ? `retry ${newRetryCount}/${TIMEOUT_RETRY_MAX} in 2min`
              : "permanently failed (retries exhausted)"
          }`,
        );
        this.log.warn("Stale task detected (exit 143)", {
          taskId: task.id,
          agentName: task.agent_name,
          ageMinutes: Math.round(age / 60000),
          staleThresholdMs,
          willRetry,
          retryCount: newRetryCount,
        });
        this.store.updateTask(task.id, {
          status: "failed",
          result: `Timed out: dispatched ${Math.round(age / 60000)} minutes ago with no response (exit 143)`,
          retry_count: newRetryCount,
          next_retry_at: nextRetryAt,
        });
      }
    }
  }

  /**
   * Detect 'done' tasks that completed without writing any result back to
   * state.db.  This is a silent failure mode: the source issue is neither
   * retried (no failure record) nor closed (no success record), so it
   * disappears from every detection loop.
   *
   * A task qualifies when it has been 'done' for ≥30 minutes with no result,
   * no quality_score, and no verification_status — meaning the agent exited
   * without recording output.
   *
   * For each qualifying task this method:
   *   1. Flags the task as 'result_missing' in state.db.
   *   2. Sends a Telegram alert with the task ID and source issue reference
   *      so the operator can investigate within the same daemon cycle.
   *   3. Schedules the task for immediate re-dispatch (next_retry_at = now)
   *      so it is picked up by processRetries on the next poll.
   */
  private async checkResultMissingTasks(time: string): Promise<void> {
    try {
      const candidates = this.store.getResultMissingCandidates(RESULT_MISSING_THRESHOLD_MS);
      if (candidates.length === 0) return;

      console.log(`[${time}] Result-missing check: ${candidates.length} task(s) done with no recorded result`);
      this.log.warn("Result-missing tasks detected", { count: candidates.length });

      for (const task of candidates) {
        const ageMin = Math.round((Date.now() - new Date(task.created_at).getTime()) / 60_000);
        const issueRef = task.source_ref ?? "unknown";

        console.log(
          `[${time}] Result missing: task ${task.id.slice(0, 8)} (${task.agent_name}) for ${issueRef} — done ${ageMin}min ago with no result`,
        );
        this.log.warn("Task flagged as result_missing", {
          taskId: task.id,
          agentName: task.agent_name,
          sourceRef: issueRef,
          ageMinutes: ageMin,
        });

        // Flag the task and schedule for immediate re-dispatch
        this.store.updateTask(task.id, {
          status: "result_missing",
          result: `Result missing: task completed ${ageMin} minutes ago but wrote no output. Scheduled for re-dispatch.`,
          next_retry_at: new Date().toISOString(),
        });

        // Notify the operator — rate-limited per task to avoid spam on repeated cycles
        await notifyOperator(
          "Result missing — task re-queued",
          `Task \`${task.id.slice(0, 8)}\` (agent: ${task.agent_name ?? "unknown"}) for issue \`${issueRef}\` completed ${ageMin} min ago but wrote no result back to state.db.\n\nFlagged as result_missing and re-queued for dispatch.`,
          "warning",
          `result-missing:${task.id}`,
        );
      }
    } catch (err) {
      console.error(`[${time}] Result-missing check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Cancel in-flight tasks whose source GitHub issue has been closed externally
   * (issue #431). When an issue is resolved by another agent, manually closed,
   * or auto-closed by a merged PR, any dispatched/in-progress task targeting
   * that issue is wasted work. This sweep detects that situation and cancels
   * the task with a "resolved externally" log entry.
   *
   * Only checks GitHub-sourced tasks with a valid source_ref (repo#number format).
   * Runs periodically (CLOSED_ISSUE_CHECK_EVERY_N_CYCLES) to limit GitHub API calls.
   */
  private cancelClosedIssueTasks(time: string): void {
    try {
      const activeTasks = [
        ...this.store.listTasks({ status: "dispatched", limit: 50 }),
        ...this.store.listTasks({ status: "in_progress", limit: 50 }),
      ];

      const githubTasks = activeTasks.filter(
        (t) => t.source === "github" && t.source_ref,
      );

      if (githubTasks.length === 0) return;

      let cancelled = 0;
      for (const task of githubTasks) {
        const repo = extractRepoFromSourceRef(task.source_ref);
        const issueMatch = task.source_ref?.match(/#(\d+)$/);
        if (!repo || !issueMatch) continue;

        const issueNumber = parseInt(issueMatch[1], 10);

        if (!cachedIsIssueOpen(repo, issueNumber)) {
          this.log.info("Cancelling in-flight task: source issue closed externally", {
            taskId: task.id,
            agentName: task.agent_name,
            sourceRef: task.source_ref,
            issueNumber,
            previousStatus: task.status,
          });
          this.store.addLog({
            task_id: task.id,
            direction: "system",
            content: `Resolved externally: source issue ${task.source_ref} was closed while task was ${task.status}. Task cancelled.`,
          });
          this.store.updateTask(task.id, {
            status: "failed",
            result: `Resolved externally: source issue ${task.source_ref} was closed while task was in-flight.`,
            next_retry_at: null,
          });
          // Mark processed so this issue is not re-dispatched. Pass the real
          // task.id (not a synthetic prefix) — task.id is a valid row in the
          // tasks table (just updated above), so the processed_triggers FK is
          // satisfied. The "closed-externally" reason is captured in the task's
          // own result field above.
          this.store.markProcessed("github", task.source_ref!, task.id);
          cancelled++;
        }
      }

      if (cancelled > 0) {
        console.log(`[${time}] Closed-issue guard: cancelled ${cancelled} in-flight task(s) for closed issues`);
      }
    } catch (err) {
      this.log.error("Closed-issue task cancellation failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Proxy health check ──────────────────────────────────────────────────
  /** Track consecutive proxy failures for escalation. */
  private proxyFailureCount = 0;
  /** Rolling window of failure timestamps for flapping detection. */
  private proxyFailureTimestamps: number[] = [];
  /** Whether we're in a declared outage (prevents alert spam). */
  private proxyOutageDeclared = false;
  /** Consecutive successes needed before declaring recovery (debounce). */
  private proxyRecoveryStreak = 0;
  /** Number of Docker/OrbStack restart attempts during current outage. */
  private dockerRestartAttempts = 0;

  /** Max Docker restart attempts per outage before giving up. */
  private static readonly MAX_DOCKER_RESTART_ATTEMPTS = 2;

  /** Failures in this window trigger a flapping alert. */
  private static readonly PROXY_FLAP_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  /** This many failures in the window = flapping alert. */
  private static readonly PROXY_FLAP_THRESHOLD = 3;
  /** Consecutive successes before declaring recovery. */
  private static readonly PROXY_RECOVERY_DEBOUNCE = 3;

  /**
   * Ping the proxy server (not the management API) to confirm it can route
   * LLM requests.  When the proxy is down, every dispatch/verify/review call
   * silently fails with "Connection error" or "Request was aborted", burning
   * retry budget and deadlocking the cycle.
   *
   * Handles flapping (intermittent failures that reset the consecutive counter)
   * by tracking failures in a rolling window. Requires multiple consecutive
   * successes before declaring recovery to avoid false "recovered" alerts.
   */
  private async checkProxyHealth(time: string): Promise<void> {
    const proxyUrl = this.config.proxy.url;
    let healthy = false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${proxyUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      healthy = res.ok;
    } catch {
      healthy = false;
    }

    // Also check Docker socket — proxy can respond OK while Docker is down,
    // making all container-based agents unreachable.
    if (healthy) {
      try {
        execSync("curl --unix-socket /var/run/docker.sock --max-time 5 http://localhost/ping", {
          encoding: "utf-8", timeout: 8_000,
        });
      } catch {
        this.log.warn("Docker socket unresponsive — proxy is up but containers are unreachable");
        healthy = false;
      }
    }

    if (healthy) {
      this.proxyRecoveryStreak++;
      this.proxyFailureCount = 0;

      // Require multiple consecutive successes before declaring recovery
      if (this.proxyOutageDeclared && this.proxyRecoveryStreak >= Daemon.PROXY_RECOVERY_DEBOUNCE) {
        this.proxyOutageDeclared = false;
        this.proxyFailureTimestamps = [];
        this.dockerRestartAttempts = 0;
        this.log.info("Proxy recovered (confirmed)", { consecutiveSuccesses: this.proxyRecoveryStreak });
        this.clearInfrastructureFailures(time);
        await notifyOperator(
          "Proxy recovered",
          `Proxy server at ${proxyUrl} is confirmed back online (${this.proxyRecoveryStreak} consecutive successes). Infrastructure failure history cleared.`,
          "info",
        );
      }
      return;
    }

    // Failure path
    this.proxyRecoveryStreak = 0;
    this.proxyFailureCount++;

    // Track in rolling window
    const now = Date.now();
    this.proxyFailureTimestamps.push(now);
    this.proxyFailureTimestamps = this.proxyFailureTimestamps.filter(
      (ts) => now - ts < Daemon.PROXY_FLAP_WINDOW_MS,
    );

    this.log.warn("Proxy health check failed", {
      url: proxyUrl,
      consecutiveFailures: this.proxyFailureCount,
      failuresInWindow: this.proxyFailureTimestamps.length,
    });

    // Alert on either: 2 consecutive failures OR N failures in the rolling window (flapping)
    if (!this.proxyOutageDeclared) {
      const shouldAlert =
        this.proxyFailureCount >= 2 ||
        this.proxyFailureTimestamps.length >= Daemon.PROXY_FLAP_THRESHOLD;

      if (shouldAlert) {
        this.proxyOutageDeclared = true;
        const reason = this.proxyFailureCount >= 2
          ? `${this.proxyFailureCount} consecutive failures`
          : `${this.proxyFailureTimestamps.length} failures in the last hour (flapping)`;

        // Auto-recovery: restart Docker/OrbStack before alerting operator
        const recovered = await this.attemptDockerRestart(time);
        if (recovered) return; // Recovery succeeded — skip the alert

        await notifyOperator(
          "Proxy server unreachable — auto-restart failed",
          `Proxy at ${proxyUrl} is down: ${reason}. Auto-restart of Docker/OrbStack was attempted but did not restore connectivity.\n\nManual check needed: \`docker context show\` → \`curl --unix-socket /var/run/docker.sock http://localhost/ping\``,
          "critical",
        );
      }
    }
  }

  /**
   * Attempt to restart the Docker runtime (OrbStack or Docker Desktop) and
   * re-sync agents. Returns true if the proxy is reachable after restart.
   */
  private async attemptDockerRestart(time: string): Promise<boolean> {
    if (this.dockerRestartAttempts >= Daemon.MAX_DOCKER_RESTART_ATTEMPTS) {
      this.log.warn("Docker restart: max attempts reached, skipping", {
        attempts: this.dockerRestartAttempts,
      });
      return false;
    }
    this.dockerRestartAttempts++;

    try {
      // Detect runtime
      const runtime = execSync("docker context show", { encoding: "utf-8", timeout: 10_000 }).trim();
      this.log.info("Docker restart: detected runtime", { runtime, attempt: this.dockerRestartAttempts });

      if (runtime === "orbstack") {
        execSync("killall OrbStack 2>/dev/null; true", { encoding: "utf-8", timeout: 10_000 });
        await new Promise((r) => setTimeout(r, 5_000));
        execSync("open -a OrbStack", { encoding: "utf-8", timeout: 10_000 });
      } else {
        execSync("killall Docker 2>/dev/null; true", { encoding: "utf-8", timeout: 10_000 });
        await new Promise((r) => setTimeout(r, 5_000));
        execSync("open -a Docker", { encoding: "utf-8", timeout: 10_000 });
      }

      // Wait for Docker to come up
      this.log.info("Docker restart: waiting for socket", { runtime });
      await new Promise((r) => setTimeout(r, 60_000));

      // Verify socket
      try {
        execSync("curl --unix-socket /var/run/docker.sock --max-time 10 http://localhost/ping", {
          encoding: "utf-8", timeout: 15_000,
        });
      } catch {
        this.log.warn("Docker restart: socket still unresponsive after restart", { runtime });
        return false;
      }

      // Re-sync agents
      this.log.info("Docker restart: socket responsive, syncing agents");
      await this.syncAgents();

      // Verify proxy
      try {
        const res = await fetch(`${this.config.proxy.url}/health`, {
          method: "GET",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.proxyOutageDeclared = false;
          this.proxyFailureTimestamps = [];
          this.proxyFailureCount = 0;
          this.proxyRecoveryStreak = Daemon.PROXY_RECOVERY_DEBOUNCE;
          this.clearInfrastructureFailures(time);
          console.log(`[${time}] Docker auto-restart succeeded — proxy recovered`);
          await notifyOperator(
            "Auto-recovery: Docker restarted, proxy restored",
            `Docker runtime (${runtime}) was restarted automatically. Proxy is back online. Infrastructure failure history cleared.`,
            "info",
          );
          return true;
        }
      } catch { /* fall through */ }

      this.log.warn("Docker restart: proxy still unreachable after restart", { runtime });
      return false;
    } catch (err) {
      this.log.error("Docker restart failed", {
        attempt: this.dockerRestartAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ── Closed-issue failure cleanup ───────────────────────────────────────

  /**
   * Sweep failed tasks whose source issue has been closed and clear their
   * failure history.  Without this, closed issues accumulate failed records
   * that permanently count toward retry_limit_exceeded, even though the
   * source_ref will never be re-dispatched.  Clearing the history also
   * unblocks the source_ref if the issue is ever reopened.
   */
  private cleanupFailedTasksForClosedIssues(time: string): void {
    try {
      const failedTasks = this.store.listTasks({ status: "failed", limit: 200 });
      const githubTasks = failedTasks.filter(
        (t) => t.source === "github" && t.source_ref,
      );

      if (githubTasks.length === 0) return;

      // Deduplicate source_refs so we only clear once per issue
      const closedRefs = new Set<string>();
      for (const task of githubTasks) {
        if (!task.source_ref || closedRefs.has(task.source_ref)) continue;
        const repo = extractRepoFromSourceRef(task.source_ref);
        const issueMatch = task.source_ref.match(/#(\d+)$/);
        if (!repo || !issueMatch) continue;

        const issueNumber = parseInt(issueMatch[1], 10);
        const issueState = cachedGetIssueState(repo, issueNumber);
        if (issueState.state === "closed") {
          closedRefs.add(task.source_ref);
        }
      }

      for (const ref of closedRefs) {
        this.store.clearFailureHistoryForSourceRef("github", ref);
      }

      if (closedRefs.size > 0) {
        this.log.info("Closed-issue failure cleanup", { cleared: closedRefs.size });
        console.log(`[${time}] Closed-issue failure cleanup: cleared failure history for ${closedRefs.size} closed issue(s)`);
      }
    } catch (err) {
      this.log.warn("Closed-issue failure cleanup failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Infrastructure failure history clear ───────────────────────────────

  /**
   * After proxy recovery, clear failure history for source_refs whose only
   * recent failures are infrastructure errors (connection error, timeout,
   * aborted).  This allows those issues to be re-dispatched immediately
   * rather than waiting for the 24h recency window to expire.
   */
  private clearInfrastructureFailures(time: string): void {
    try {
      const infraRefs = this.store.getInfrastructureFailedSourceRefs(48);

      let cleared = 0;
      for (const ref of infraRefs) {
        this.store.clearFailureHistoryForSourceRef("github", ref);
        cleared++;
      }

      if (cleared > 0) {
        this.log.info("Infrastructure failure history cleared", { cleared });
        console.log(`[${time}] Proxy recovery: cleared failure history for ${cleared} source ref(s)`);
      }
    } catch (err) {
      this.log.warn("Infrastructure failure clear failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Fire off retry attempts for all failed tasks whose backoff delay has elapsed.
   * Skips agents that are already busy to avoid queuing work on top of in-flight tasks.
   * Each retry is fire-and-forget so we don't block the daemon cycle on agent I/O.
   */
  private async processRetries(time: string): Promise<void> {
    try {
      const retryable = this.store.getRetryableTasks(MAX_RETRIES);
      if (retryable.length === 0) return;

      console.log(`[${time}] Retries: ${retryable.length} task(s) ready for retry`);
      this.log.info("Processing retryable tasks", { count: retryable.length });

      for (const task of retryable) {
        if (task.agent_name && this.store.hasActiveTask(task.agent_name)) {
          this.log.info("Retry deferred: agent busy", {
            taskId: task.id,
            agentName: task.agent_name,
            retryCount: task.retry_count,
          });
          console.log(
            `[${time}] Retry deferred ${task.id.slice(0, 8)} (${task.agent_name}): agent busy, will try next cycle`,
          );
          continue;
        }

        // Fire-and-forget: retryTask manages its own state transitions and
        // schedules further retries or marks permanently failed on exhaustion.
        this.dispatcher.retryTask(task).then(() => {
          this.log.info("Retry task completed", { taskId: task.id, agentName: task.agent_name });
        }).catch((err) => {
          // retryTask doesn't throw on agent errors — only on unexpected internal failures
          this.log.error("Unexpected error in retryTask", {
            taskId: task.id,
            agentName: task.agent_name,
            error: String(err),
          });
        });
      }
    } catch (err) {
      console.error(`[${time}] Retry processing step failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async dispatchTriggers(time: string, registeredAgents: Set<string>): Promise<void> {
    try {
      const results = await Promise.allSettled([
        dispatchGitHubIssues(
          this.config,
          this.store,
          this.dispatcher,
          1,
          registeredAgents,
          // Post-dispatch orphan hook: triggered immediately when each agent
          // finishes its task (asynchronously via fire-and-forget). This detects
          // branches pushed by the agent right after completion rather than
          // waiting up to one full poll interval for the scheduled createOrphanPRs
          // sweep to run. Satisfies the acceptance criterion for issue #305:
          // "orphan branches are resolved within one daemon cycle."
          (agentName) => this.postDispatchOrphanCheck(agentName),
        ),
        dispatchLinearChecks(this.config, this.store, this.dispatcher, registeredAgents),
        dispatchSlackChecks(this.config, this.store, this.dispatcher, registeredAgents),
        dispatchRevenueExecutor(this.config, this.store, this.dispatcher, registeredAgents),
        dispatchRevenueWatcher(this.store),
      ]);

      const totals: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };
      for (const r of results) {
        if (r.status === "fulfilled") {
          totals.dispatched += r.value.dispatched;
          totals.skipped += r.value.skipped;
          totals.errors.push(...r.value.errors);
        } else {
          totals.errors.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
      }

      if (totals.dispatched > 0 || totals.errors.length > 0) {
        console.log(
          `[${time}] Triggers: ${totals.dispatched} dispatched, ${totals.skipped} skipped, ${totals.errors.length} errors`,
        );
        for (const err of totals.errors) {
          console.error(`  Error: ${err}`);
        }
      } else if (totals.skipped > 0) {
        console.log(`[${time}] Triggers: no new items (${totals.skipped} already processed)`);
      }
    } catch (err) {
      console.error(`[${time}] Trigger dispatch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Post-completion idle pickup: dispatch the highest-priority open GitHub issue
   * to any agent that is currently idle (no active task). Called immediately after
   * verifyCompleted so that agents which just finished their work receive their next
   * assignment within the same poll cycle rather than waiting up to one full poll
   * interval.
   *
   * Uses the dedicated `dispatchIdleAgentBacklog` function which explicitly checks
   * idle status and sorts issues by priority (oldest issue first) rather than the
   * general `dispatchGitHubIssues` used in the regular trigger step.
   *
   * Agents that remain idle for more than IDLE_RECLAIM_THRESHOLD_CYCLES consecutive
   * cycles are escalated to force-reclaim mode: the duplicate-guard recency window
   * is bypassed so previously-attempted open issues can be re-dispatched.  This
   * eliminates the supervisor "agent is idle" workaround and makes backlog pickup
   * fully deterministic.
   */
  private async pickupIdleAgents(time: string, registeredAgents: Set<string>): Promise<void> {
    try {
      // Identify agents that are currently idle (registered + github + no active task)
      const idleAgents = new Set<string>();
      for (const [agentName, agent] of Object.entries(this.config.agents)) {
        if (!agent.github) continue;
        if (!registeredAgents.has(agentName)) continue;
        if (!this.store.hasActiveTask(agentName)) {
          idleAgents.add(agentName);
        }
      }

      // Agents idle for > threshold consecutive cycles get force-reclaim
      const forceReclaimAgents = new Set<string>();
      for (const agentName of idleAgents) {
        const idleCycles = this.idleCyclesSinceDispatch.get(agentName) ?? 0;
        if (idleCycles >= IDLE_RECLAIM_THRESHOLD_CYCLES) {
          forceReclaimAgents.add(agentName);
          this.log.info("Idle reclaim: agent eligible for force-reclaim", {
            agentName,
            idleCycles,
            threshold: IDLE_RECLAIM_THRESHOLD_CYCLES,
          });
        }
      }

      const result = await dispatchIdleAgentBacklog(
        this.config,
        this.store,
        this.dispatcher,
        registeredAgents,
        forceReclaimAgents,
      );

      // Update idle cycle counters based on dispatch results
      const dispatchedSet = new Set(result.dispatchedAgents ?? []);
      for (const agentName of idleAgents) {
        if (dispatchedSet.has(agentName)) {
          // Agent received work — reset idle counter
          this.idleCyclesSinceDispatch.set(agentName, 0);
        } else {
          // Agent is still idle with no dispatch — increment counter
          const current = this.idleCyclesSinceDispatch.get(agentName) ?? 0;
          this.idleCyclesSinceDispatch.set(agentName, current + 1);
        }
      }
      // Clear counters for agents that are now busy (picked up work in dispatchTriggers)
      for (const [agentName] of Object.entries(this.config.agents)) {
        if (!idleAgents.has(agentName)) {
          // Agent was busy or not eligible — don't accumulate idle cycles
          this.idleCyclesSinceDispatch.set(agentName, 0);
        }
      }

      if (result.dispatched > 0) {
        const reclaimCount = result.dispatchedAgents?.filter((a) => forceReclaimAgents.has(a)).length ?? 0;
        this.log.info("Idle agent pickup: dispatched highest-priority issue to idle agent(s)", {
          dispatched: result.dispatched,
          forceReclaim: reclaimCount,
        });
        if (reclaimCount > 0) {
          console.log(`[${time}] Idle pickup: ${result.dispatched} dispatched (${reclaimCount} force-reclaim)`);
        } else {
          console.log(`[${time}] Idle pickup: ${result.dispatched} dispatched for idle agent(s)`);
        }
        this.store.incrementStat("idle_fill_dispatches", result.dispatched);
        if (reclaimCount > 0) {
          this.store.incrementStat("idle_reclaim_dispatches", reclaimCount);
        }
      }
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.error(`[${time}] Idle pickup error: ${err}`);
        }
      }
    } catch (err) {
      console.error(
        `[${time}] Idle agent pickup failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async verifyCompleted(time: string): Promise<void> {
    if (!this.config.verification?.enabled) return;

    try {
      const verifyPerCycle = this.config.verification.verify_per_cycle ?? 10;
      const unverified = this.store.getUnverified(verifyPerCycle);
      if (unverified.length === 0) return;

      // `sources` is an explicit opt-in allowlist. When absent, all sources are eligible.
      // "manual" tasks (supervisor dispatches, PR feedback) are always included so the
      // quality feedback loop covers the full task population, not just trigger-sourced work.
      const sourcesFilter = this.config.verification.sources;
      const maxRevisions = this.config.verification.max_revisions ?? 1;

      let verified = 0;
      let deferred = 0;
      let skipped = 0;

      for (const task of unverified) {
        if (!shouldVerifyTask(task.source, sourcesFilter)) {
          skipped++;
          continue;
        }

        try {
          const result = await verifyAndReviseTask(
            this.config,
            this.store,
            this.reviewerClient,
            task.id,
            maxRevisions,
          );
          if (result.notes === "Deferred: agent busy") {
            deferred++;
            console.log(
              `[${time}] Deferred ${task.id.slice(0, 8)} (${task.agent_name}): agent busy, will retry next cycle`,
            );
          } else {
            verified++;
            const status = result.approved ? "approved" : "rejected";
            console.log(
              `[${time}] Verified ${task.id.slice(0, 8)} (${task.agent_name}): ${status} (${result.score.toFixed(1)})`,
            );

            if (!result.approved && result.revision) {
              console.log(`  Needs revision: ${result.revision.slice(0, 100)}`);
            }

            // Approval queue (issue #937): when a task is finally rejected after
            // all revision attempts, check if the score is in the borderline range
            // where a human should decide.  If so, enqueue it with rich context
            // (title, dimensions, PR link, risk summary) and notify the operator
            // via Telegram.  Best-effort — failures are logged but not fatal.
            if (!result.approved) {
              queueForApproval(this.store, this.reviewerClient, task, result).catch((qErr) => {
                this.log.warn("Approval queue notification failed", {
                  taskId: task.id,
                  error: qErr instanceof Error ? qErr.message : String(qErr),
                });
              });
            }

            // Meta-review guard (issue #545): a reviewer-pool task that is
            // approved but scores below the calibration threshold indicates
            // shallow review work.  Alert the operator immediately and dispatch
            // a supervisor follow-up within the same cycle so it never passes
            // silently.
            if (result.approved) {
              const threshold =
                this.config.verification?.reviewer_low_score_threshold ??
                DEFAULT_REVIEWER_LOW_SCORE_THRESHOLD;
              const agentConf = task.agent_name
                ? this.config.agents[task.agent_name]
                : undefined;
              // Exclude [meta-review] tasks (follow-ups dispatched by this
              // guard) to prevent an infinite escalation loop.
              const isMetaReview = task.title.startsWith("[meta-review]");
              if (
                !isMetaReview &&
                threshold > 0 &&
                result.score < threshold &&
                agentConf?.pool === "reviewer"
              ) {
                await this.flagLowScoreReviewerApproval(time, task, result.score, threshold);
              }
            }

            // Standup quality history (issue #591): record per-agent quality
            // scores for standup tasks so operators can track trends over time
            // via `GET /standup-quality` or the `/standup-quality` Telegram cmd.
            const isStandupTask =
              /standup/i.test(task.title) || /\u{1F4CB}/u.test(task.title);
            if (isStandupTask && task.agent_name) {
              // Extract YYYY-MM-DD from title (e.g. "Standup Apr 25" → today's date)
              const dateMatch = task.title.match(/(\d{4}-\d{2}-\d{2})/);
              const standupDate =
                dateMatch?.[1] ??
                new Date(task.created_at ?? Date.now()).toISOString().split("T")[0]!;
              // Extract action-item count from title (e.g. "— 12 action items")
              const actionMatch = task.title.match(/(\d+)\s+action\s+item/i);
              const actionItemCount = actionMatch ? parseInt(actionMatch[1]!, 10) : 0;
              this.store.recordStandupQualityEvent({
                agentName: task.agent_name,
                standupDate,
                qualityScore: result.score,
                actionItemCount,
                taskId: task.id,
              });
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Log connection errors distinctly so they don't silently drop tasks
          const isConnectionError = /ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(message);
          if (isConnectionError) {
            console.warn(`[${time}] Verify skipped ${task.id.slice(0, 8)} (connection error, will retry): ${message}`);
            this.log.warn("Verify connection error — task left unverified for retry", { taskId: task.id, error: message });
          } else {
            console.error(`[${time}] Verify failed for ${task.id.slice(0, 8)}: ${message}`);
            this.log.error("Verify failed", { taskId: task.id, error: message });
          }
        }
      }

      if (verified + deferred + skipped > 0) {
        this.log.info("Verification cycle complete", { verified, deferred, skipped, total: unverified.length });
      }
    } catch (err) {
      console.error(`[${time}] Verification step failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Meta-review guard for reviewer-pool approvals that fall below the
   * calibration threshold (default 0.80, issue #545).
   *
   * When a reviewer-pool agent's own completed task is approved but its
   * quality_score is below the threshold, the review may have been shallow —
   * weak reviewer output undermines the entire oversight chain.  This method:
   *
   *   1. Logs a prominent warning to the daemon console and structured log.
   *   2. Fires a Telegram alert (rate-limited per task) with the task ID,
   *      agent, score, and source reference so an operator can investigate.
   *   3. Dispatches a "manual" supervisor follow-up task to the reviewer pool
   *      asking it to second-pass the low-scoring work within the same cycle.
   *
   * The follow-up task title is prefixed with "[meta-review]" so that if it is
   * itself verified it will not re-trigger this guard (we skip the pool check
   * for tasks already tagged as meta-reviews).
   */
  /**
   * Extract the GitHub repo slug (owner/repo) from a task's source_ref.
   * source_refs for GitHub issues follow the pattern "owner/repo#123".
   * Returns null when the repo cannot be determined.
   */
  private extractRepoFromTask(task: import("../state/store.js").Task): string | null {
    if (!task.source_ref) return null;
    const match = task.source_ref.match(/^([^#]+)#\d+$/);
    return match ? match[1] : null;
  }

  private async flagLowScoreReviewerApproval(
    time: string,
    task: import("../state/store.js").Task,
    score: number,
    threshold: number,
  ): Promise<void> {
    const agentLabel = task.agent_name ?? "unknown";
    const ref = task.source_ref ?? task.title;
    const scoreStr = (score * 100).toFixed(0);
    const thresholdStr = (threshold * 100).toFixed(0);

    console.warn(
      `[${time}] Low-score reviewer approval: task ${task.id.slice(0, 8)} ` +
      `(${agentLabel}) scored ${scoreStr}% — below ${thresholdStr}% threshold. Dispatching supervisor follow-up.`,
    );
    this.log.warn("Reviewer-pool task approved below calibration threshold", {
      taskId: task.id,
      agentName: agentLabel,
      score,
      threshold,
      sourceRef: ref,
    });

    // 1. Telegram alert — rate-limited per task so repeated daemon cycles
    //    don't spam the operator if the follow-up task stays unverified.
    await notifyOperator(
      "Reviewer calibration alert — shallow approval",
      `Reviewer task \`${task.id.slice(0, 8)}\` (agent: ${agentLabel}) was approved with a score of ${scoreStr}% — below the ${thresholdStr}% threshold.\n\n` +
      `Source: \`${ref}\`\n` +
      `Title: ${task.title}\n\n` +
      "The review quality may be shallow. A supervisor follow-up has been dispatched for a second pass.",
      "warning",
      `reviewer-low-score:${task.id}`,
    );

    // 2. Supervisor follow-up dispatch — send to the reviewer pool so a
    //    second agent (or the same one when it next picks up work) re-examines
    //    the output.  Fire-and-forget; failures are logged but not fatal.
    const followUpMessage =
      `## Supervisor Follow-up: Low-Score Reviewer Approval\n\n` +
      `Reviewer task \`${task.id.slice(0, 8)}\` by **${agentLabel}** was approved with ` +
      `a quality score of **${scoreStr}%** — below the calibration threshold of **${thresholdStr}%**.\n\n` +
      `**Source:** \`${ref}\`\n` +
      `**Task title:** ${task.title}\n\n` +
      `Please perform a second-pass review of this work. Specifically:\n` +
      `- Assess whether the review output was substantive or superficial\n` +
      `- If the review missed real issues, post a follow-up comment on the relevant PR(s)\n` +
      `- If the output was acceptable despite the low score, document why in a brief note\n\n` +
      `This follow-up was auto-dispatched by the quality calibration guard.`;

    this.dispatcher.dispatch(followUpMessage, {
      source: "manual",
      sourceRef: task.source_ref ?? undefined,
      title: `[meta-review] Low-score reviewer approval: ${task.id.slice(0, 8)} (${scoreStr}%)`,
    }).then((r) => {
      this.log.info("Supervisor follow-up dispatched for low-score reviewer approval", {
        originalTaskId: task.id,
        followUpTaskId: r.taskId,
        score,
      });
      console.log(
        `[${time}] Meta-review follow-up dispatched: task ${r.taskId.slice(0, 8)} for low-score approval ${task.id.slice(0, 8)}`,
      );
    }).catch((err) => {
      this.log.error("Failed to dispatch supervisor follow-up for low-score reviewer approval", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * Scan every agent's rolling quality average and fire a Telegram alert when
   * it drops below its configured SLA threshold (issue #669).
   *
   * Algorithm:
   *   1. Collect all agent names that appear in the task table with at least
   *      one scored task.
   *   2. For each agent compute the rolling average of their most recent
   *      `quality_sla_window_tasks` scored tasks (default 5) using the
   *      existing `getAgentScoreTrend` helper.
   *   3. Compare the rolling average against the per-agent threshold
   *      (`per_agent_quality_thresholds[agentName]`) or the global `min_score`
   *      fallback (default 0.70).
   *   4. When a breach is detected, call `notifyOperator` with a rate-limit
   *      key scoped to `quality-sla:{agentName}:{windowDate}` so at most one
   *      alert fires per agent per 15-minute window even if the daemon check
   *      runs frequently.
   */
  private async checkQualitySlaBreaches(time: string): Promise<void> {
    const verification = this.config.verification;
    if (!verification?.enabled) return;

    const globalThreshold  = verification.min_score ?? 0.70;
    const perAgentThresholds = verification.per_agent_quality_thresholds ?? {};
    const calibrationThresholds = this.store.getAppliedVerificationCalibrationThresholds();
    const windowTasks = verification.quality_sla_window_tasks ?? DEFAULT_QUALITY_SLA_WINDOW_TASKS;

    // Gather agent names that have at least one scored task AND still exist
    // in the current config. Without this filter, removed agents (e.g. Codex)
    // trigger SLA breach alerts indefinitely from their historical data.
    const configAgents = new Set(Object.keys(this.config.agents));
    const agentNames: string[] = this.store
      .getAgentStats()
      .filter((a) => a.avg_score !== null && configAgents.has(a.agent_name))
      .map((a) => a.agent_name);

    if (agentNames.length === 0) return;

    const windowDate = new Date().toISOString().slice(0, 10);

    for (const agentName of agentNames) {
      const threshold =
        calibrationThresholds[agentName] ??
        (agentName in perAgentThresholds
          ? perAgentThresholds[agentName]
          : globalThreshold);

      // A threshold of 0 means the operator explicitly silenced alerts.
      if (threshold <= 0) continue;

      const trend = this.store.getAgentScoreTrend(agentName, windowTasks);

      // Skip if insufficient data (fewer than windowTasks scored tasks).
      if (trend.direction === "insufficient_data" || trend.recent_avg === null) continue;

      const rollingAvg = trend.recent_avg;
      if (rollingAvg >= threshold) continue;

      // Breach detected — log and notify.
      const avgPct = (rollingAvg * 100).toFixed(0);
      const thrPct = (threshold * 100).toFixed(0);
      console.warn(
        `[${time}] Quality SLA breach: ${agentName} rolling avg ${avgPct}% ` +
        `(last ${windowTasks} tasks) is below threshold ${thrPct}%.`,
      );
      this.log.warn("Quality SLA breach detected", {
        agentName,
        rollingAvg,
        threshold,
        windowTasks,
        direction: trend.direction,
      });

      await notifyOperator(
        `Quality SLA breach — ${agentName}`,
        `Agent \`${agentName}\` rolling quality average is *${avgPct}%* over the last ${windowTasks} scored tasks — below the SLA threshold of *${thrPct}%*.\n\n` +
        `Trend direction: ${trend.direction}. Operator review and possible routing adjustment recommended.`,
        "warning",
        `quality-sla:${agentName}:${windowDate}`,
      );
    }
  }

  private async detectImprovements(time: string): Promise<void> {
    try {
      const minScore = this.config.verification?.min_score ?? 0.7;
      const recent = this.store.getRecentVerified(20, minScore);
      if (recent.length < 5) return; // need enough data

      const improvements = await detectImprovements(this.reviewerClient, recent);
      if (improvements.length === 0) return;

      console.log(`[${time}] Detected ${improvements.length} improvement(s)`);
      for (const imp of improvements) {
        const result = this.issueCreator.createAcrossReposWithCap(imp);
        for (const issue of result.created) {
          console.log(`  Created: ${issue.url}`);
        }
        if (result.capReached && result.deferred.length > 0) {
          const sourcePR = this.findSourcePRFromTasks(imp.evidence.map((e) => e.taskId), recent);
          this.issueCreator.postDeferredFollowUps(
            sourcePR?.repo ?? null,
            sourcePR?.prNumber ?? null,
            result.deferred,
          );
          console.log(`  [improvements] Deferred ${result.deferred.length} follow-up(s) (cap reached)`);
        }
      }

      // Schema registry auto-sync: detect and notify consumer repos of schema changes
      try {
        const syncDetector = new SchemaRegistrySyncDetector(
          this.config,
          this.store,
          this.issueCreator,
        );
        const schemaIssues = await syncDetector.detectSchemaRegistryChanges();
        if (schemaIssues.length > 0) {
          console.log(`[${time}] Created ${schemaIssues.length} schema registry change notification(s)`);
          for (const issue of schemaIssues) {
            console.log(`  Created: ${issue.url}`);
          }
        }
      } catch (err) {
        this.log.error("Schema registry sync detection failed", {
          error: err instanceof Error ? err.message : err,
        });
        // Continue — non-critical improvement detection
      }
    } catch (err) {
      console.error(`[${time}] Improvement detection failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Attempt to identify the source PR for a set of evidence task IDs by looking
   * up each task in the provided collection and parsing its source_ref.
   *
   * source_ref format: "owner/repo#<number>"
   *
   * Returns the first match found, or null if none of the tasks have a PR source_ref.
   */
  private findSourcePRFromTasks(
    taskIds: string[],
    tasks: { id: string; source_ref: string | null }[],
  ): { repo: string; prNumber: number } | null {
    for (const taskId of taskIds) {
      const task = tasks.find((t) => t.id === taskId);
      if (!task?.source_ref) continue;
      const m = task.source_ref.match(/^([^#]+)#(\d+)$/);
      if (m) {
        return { repo: m[1], prNumber: parseInt(m[2], 10) };
      }
    }
    return null;
  }

  /**
   * Check for pending meeting_request signals and dispatch them to the
   * meeting facilitator agent. The facilitator evaluates the request,
   * picks a format, selects participants, and runs the meeting.
   */
  private async checkMeetingRequests(time: string): Promise<void> {
    try {
      const signals = this.store.readSignals({ signal_type: "meeting_request", limit: 5 });
      if (signals.length === 0) return;

      // Find the facilitator agent
      const facilitatorName = Object.keys(this.config.agents).find(
        (name) => name.includes("facilitator") || this.config.agents[name].capabilities?.includes("facilitation"),
      );

      if (!facilitatorName) {
        this.log.info("Meeting request found but no facilitator agent configured", { count: signals.length });
        return;
      }

      // Check weekly cap: max 1 ad-hoc meeting per 7 days
      const recentMeetings = this.store.getMeetings(10);
      const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const adHocThisWeek = recentMeetings.filter(
        (m) => m.type !== "standup" && m.type !== "bluesky" && m.created_at >= oneWeekAgo,
      );
      if (adHocThisWeek.length >= 1) {
        this.log.info("Meeting request deferred: weekly ad-hoc cap reached", {
          pending: signals.length,
          adHocThisWeek: adHocThisWeek.length,
        });
        return;
      }

      // Dispatch the highest-confidence request to the facilitator
      const request = signals[0];
      let payload: Record<string, unknown> = {};
      try {
        payload = request.value ? JSON.parse(request.value) : {};
      } catch {
        payload = { topic: request.key };
      }

      // Delete the signal so it's not re-dispatched on the next cycle.
      // If dispatch fails, the operator can re-request via Telegram.
      try {
        this.store.deleteSignal(request.id);
      } catch {
        // Non-critical — duplicate dispatch is better than no dispatch
      }

      console.log(`[${time}] Dispatching meeting request to facilitator: "${payload.topic ?? request.key}"`);

      // Record the intake in the facilitator's state.db via the HTTP endpoint.
      // Fire-and-forget: a facilitator outage must not block signal dispatch.
      const facilitatorBaseUrl = getAgentBaseUrl(this.config, facilitatorName) ?? "";
      const intakeClient = new MeetingIntakeClient(facilitatorBaseUrl);
      void intakeClient
        .create({
          title: String(payload.topic ?? request.key),
          participants: Array.isArray(payload.suggestedParticipants)
            ? (payload.suggestedParticipants as string[])
            : [],
          agenda_items: [],
        })
        .then((meetingId) => {
          if (meetingId) {
            this.log.info("Meeting intake record created", { meeting_id: meetingId });
          }
        });

      // Build signal JSON matching the meeting_request schema the facilitator reads.
      const signalJson = JSON.stringify({
        topic: payload.topic ?? request.key,
        suggestedFormat: payload.suggestedFormat ?? undefined,
        urgency: payload.urgency ?? "normal",
        suggestedParticipants: Array.isArray(payload.suggestedParticipants)
          ? payload.suggestedParticipants
          : undefined,
        context: payload.context ?? undefined,
        key: request.key,
        agent: request.agent,
      });

      this.dispatcher.dispatch(
        `Process meeting request: ${signalJson}`,
        {
          agentName: facilitatorName,
          source: "manual",
          sourceRef: `meeting-request:${request.key}`,
          title: `[meeting] ${payload.topic ?? request.key}`,
          taskType: "facilitation",
        },
      ).then(() => {
        this.log.info("Meeting request dispatched to facilitator", {
          facilitator: facilitatorName,
          topic: payload.topic ?? request.key,
        });
      }).catch((err) => {
        this.log.warn("Failed to dispatch meeting request", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      this.log.warn("Meeting request check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Auto-dispatch the highest-priority issue identified in a meeting outcome.
   *
   * Reads `meeting_priority_outcome` signals (written by `extractPriorityOutcomes()`
   * in team-meeting.ts after every meeting that produced a priority ranking).
   * For the first actionable signal, resolves the top-ranked issue ref to a
   * full `owner/repo#N` source ref, routes to the owning agent, and dispatches
   * a single implementation task — replacing the round-trip through LLM
   * supervisor reasoning with a deterministic fast-path.
   *
   * Guards (all must pass before dispatch):
   *  1. Signal has at least one issue ref in `priorityRanking`
   *  2. Issue ref resolves to a known agent repo in agents.yaml
   *  3. Issue is NOT already processed (`store.isProcessed("github", sourceRef)`)
   *  4. Target agent has no tasks in `dispatched` status (agent must be free)
   *  5. No cascade depth exceeded (issues from meeting signals start at depth 0)
   *
   * Consumes one signal per cycle (deletes before dispatch, fire-and-forget).
   * Remaining signals are processed in subsequent cycles.
   */
  private async checkPriorityOutcomeSignals(time: string): Promise<void> {
    try {
      const signals = this.store.readSignals({ signal_type: "meeting_priority_outcome", limit: 5 });
      if (signals.length === 0) return;

      for (const signal of signals) {
        let outcome: Record<string, unknown> = {};
        try {
          outcome = signal.value ? JSON.parse(signal.value as string) : {};
        } catch {
          continue;
        }

        const priorityRanking = Array.isArray(outcome.priorityRanking)
          ? (outcome.priorityRanking as string[])
          : [];
        if (priorityRanking.length === 0) {
          // Signal has no actionable ranking — clean it up
          try { this.store.deleteSignal(signal.id); } catch { /* non-critical */ }
          continue;
        }

        // Try each ranked ref until we find one we can dispatch
        let dispatched = false;
        for (const rawRef of priorityRanking) {
          const resolved = this.resolvePriorityIssueRef(rawRef);
          if (!resolved) {
            this.log.debug("Priority outcome ref could not be resolved — skipping", { rawRef });
            continue;
          }

          const { sourceRef, repo, issueNumber, agentName } = resolved;

          // Guard 3: skip if already dispatched/processed
          if (this.store.isProcessed("github", sourceRef)) {
            this.log.debug("Priority outcome ref already processed — skipping", { sourceRef });
            continue;
          }

          // Guard 4: skip if target agent already has in-flight tasks
          const activeTasks = this.store.listTasks({ status: "dispatched", agent_name: agentName, limit: 1 });
          if (activeTasks.length > 0) {
            this.log.info("Priority outcome dispatch deferred: target agent busy", {
              agentName,
              sourceRef,
              activeTaskId: activeTasks[0].id,
            });
            continue;
          }

          // All guards passed — consume the signal and dispatch
          try {
            this.store.deleteSignal(signal.id);
          } catch {
            // Non-critical — duplicate dispatch is preferable to a missed dispatch
          }

          const followUp = outcome.followUpMeetingRecommended
            ? "\n\nNote: The meeting recommended a follow-up coordination session before implementation begins. Proceed if the scope is clear, otherwise request clarification."
            : "";

          const rationale = typeof outcome.rationale === "string"
            ? `\n\nMeeting rationale: ${outcome.rationale.slice(0, 400)}`
            : "";

          const sequencing = Array.isArray(outcome.sequencingConstraints) && outcome.sequencingConstraints.length > 0
            ? `\n\nSequencing constraints: ${(outcome.sequencingConstraints as string[]).join("; ")}`
            : "";

          const message =
            `Implement ${repo}#${issueNumber} — this was identified as the highest-priority item in a recent team meeting.\n` +
            `Priority ranking from meeting: ${priorityRanking.join(" → ")}` +
            sequencing +
            rationale +
            followUp;

          console.log(`[${time}] Auto-dispatching priority outcome: ${sourceRef} → ${agentName}`);

          this.dispatcher.dispatch(message, {
            agentName,
            source: "github",
            sourceRef,
            title: `[priority] Implement ${repo}#${issueNumber} (meeting outcome)`,
            taskType: "implementation",
          }).then(() => {
            this.log.info("Priority outcome dispatched", {
              agentName,
              sourceRef,
              meetingDate: outcome.meetingDate,
              topic: outcome.topic,
            });
          }).catch((err) => {
            this.log.warn("Priority outcome dispatch failed", {
              error: err instanceof Error ? err.message : String(err),
              sourceRef,
            });
          });

          dispatched = true;
          break; // One dispatch per cycle per signal
        }

        if (dispatched) break; // One signal processed per cycle
      }
    } catch (err) {
      this.log.warn("Priority outcome signal check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve a raw priority issue ref (e.g. "agent-orchestrator#1113",
   * "rapartlu/agent-reviewer#391", "#427") to a full dispatch-ready record.
   *
   * Resolution strategy:
   *  1. Full `owner/repo#N` — used verbatim
   *  2. `repo-name#N` — look up owner from agents config by matching `github` field
   *  3. `#N` alone — cannot be resolved without repo context; returns null
   *
   * Returns null if the ref cannot be resolved to a known agent.
   */
  private resolvePriorityIssueRef(rawRef: string): {
    sourceRef: string;
    repo: string;
    issueNumber: number;
    agentName: string;
  } | null {
    // Pattern 1: full "owner/repo#N"
    const fullMatch = rawRef.match(/^([\w-]+\/[\w-]+)#(\d+)$/);
    if (fullMatch) {
      const repo = fullMatch[1];
      const issueNumber = parseInt(fullMatch[2], 10);
      const agentName = this.findAgentForRepo(repo);
      if (!agentName) return null;
      return { sourceRef: `${repo}#${issueNumber}`, repo, issueNumber, agentName };
    }

    // Pattern 2: "repo-name#N" — match against known agent repos
    const shortMatch = rawRef.match(/^([\w-]+)#(\d+)$/);
    if (shortMatch) {
      const repoName = shortMatch[1];
      const issueNumber = parseInt(shortMatch[2], 10);
      // Find agent whose github field ends with the repo name
      const entry = Object.entries(this.config.agents).find(
        ([, a]) => a.github && (a.github === repoName || a.github.endsWith(`/${repoName}`)),
      );
      if (!entry) return null;
      const [agentName, agentConf] = entry;
      const repo = agentConf.github!;
      return { sourceRef: `${repo}#${issueNumber}`, repo, issueNumber, agentName };
    }

    return null; // Bare "#N" or unrecognised format
  }

  /**
   * Find the agent name whose configured GitHub repo matches `repo`.
   * Returns the first matching agent or undefined if none found.
   */
  private findAgentForRepo(repo: string): string | undefined {
    return Object.entries(this.config.agents).find(
      ([, a]) => a.github === repo,
    )?.[0];
  }

  /**
   * Check per-agent PR iteration cost and file improvement issues when the
   * rolling average exceeds the threshold.  Runs at the same cadence as
   * the LLM-based improvement detector but requires no LLM call — reads
   * only from state.db (issue #748).
   */
  private detectIterationCostImprovements(time: string): void {
    try {
      const improvements = detectHighIterationAgents(this.store, this.config);
      if (improvements.length === 0) return;

      console.log(`[${time}] Iteration-cost detector: ${improvements.length} agent(s) above threshold`);
      const iterationDeferred: DeferredFollowUp[] = [];
      for (const imp of improvements) {
        const result = this.issueCreator.createAcrossReposWithCap(imp, ["iteration-cost-triggered"]);
        for (const issue of result.created) {
          console.log(`  [iteration-cost] Created: ${issue.url}`);
        }
        if (result.deferred.length > 0) {
          iterationDeferred.push(...result.deferred);
        }
      }
      if (iterationDeferred.length > 0) {
        // No source PR available for iteration-cost improvements; log only
        this.issueCreator.postDeferredFollowUps(null, null, iterationDeferred);
        console.log(`  [iteration-cost] Deferred ${iterationDeferred.length} follow-up(s)`);
      }
    } catch (err) {
      console.error(
        `[${time}] Iteration-cost improvement detection failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Check recent health incident tasks (escalated research tasks from failed
   * health checks) and extract root cause patterns. Files improvement issues
   * for critical or recurring root causes.
   *
   * Patterns detected: OOM, port-conflict, secret-missing, dependency,
   * crash, startup-timeout, unknown.
   */
  private detectHealthIncidentIssues(time: string): void {
    try {
      const improvements = detectHealthIncidentIssues(this.store, this.config);
      if (improvements.length === 0) return;

      console.log(`[${time}] Health incident detector: ${improvements.length} issue(s) detected`);
      const healthDeferred: DeferredFollowUp[] = [];
      for (const imp of improvements) {
        const result = this.issueCreator.createAcrossReposWithCap(imp, ["health-incident-triggered"]);
        for (const issue of result.created) {
          console.log(`  [health-incident] Created: ${issue.url}`);
        }
        if (result.deferred.length > 0) {
          healthDeferred.push(...result.deferred);
        }
      }
      if (healthDeferred.length > 0) {
        // No source PR available for health-incident improvements; log only
        this.issueCreator.postDeferredFollowUps(null, null, healthDeferred);
        console.log(`  [health-incident] Deferred ${healthDeferred.length} follow-up(s)`);
      }
    } catch (err) {
      console.error(
        `[${time}] Health incident detection failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * Fire Telegram alerts for any GitHub issue whose cumulative revision count
   * has exceeded the configured ceiling (default: 3 revisions).
   *
   * Rate-limited by notifyOperator() so repeated cycles do not spam.
   */
  private async checkIterationBudgetAlerts(time: string): Promise<void> {
    try {
      const cfg = this.config as unknown as Record<string, unknown>;
      const iterBudget = cfg["iteration_budget"] as { ceiling?: number } | undefined;
      await runIterationBudgetAlerts(this.store, { ceiling: iterBudget?.ceiling });
    } catch (err) {
      console.error(
        `[${time}] Iteration budget alert check failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async runMeeting(time: string, type: "standup" | "bluesky"): Promise<void> {
    const label = type === "bluesky" ? "blue sky session" : "standup";
    try {
      console.log(`[${time}] Starting ${label}...`);
      const summary = await runTeamMeeting(this.config, this.store, { type });
      const responded = summary.rounds[0]?.entries.filter((e) => e.response).length ?? 0;
      console.log(`[${time}] ${label} complete: ${summary.rounds.length} rounds, ${summary.actionItems.length} action items, ${responded} agents`);

      // Post standup action items to the dashboard (issue #801)
      if (type === "standup" && summary.actionItems.length > 0) {
        await this.postStandupActionItems(time, summary.date, summary.actionItems).catch(
          (err) =>
            console.warn(
              `[${time}] Failed to post standup action items to dashboard: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
        );
      }
    } catch (err) {
      console.error(`[${time}] ${label} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Post standup action items to the dashboard after standup synthesis.
   * Converts synthesized action items to dashboard API format and POSTs
   * them to the standup-items tracking endpoint (issue #801).
   */
  private async postStandupActionItems(
    time: string,
    standupDate: string,
    actionItems: Array<{ description: string; owner: string; priority: string }>,
  ): Promise<void> {
    const dashboardUrl = "http://localhost:3473";
    const client = new StandupActionClient(dashboardUrl);

    // Convert orchestrator ActionItem format to dashboard StandupActionItemInput format
    const items = actionItems.map((item) => ({
      standup_date: standupDate,
      action_item: item.description,
      status: "deferred" as const,
      reason: `Synthesized by orchestrator (${item.priority} priority, owner: ${item.owner})`,
      agent_name: undefined,
      task_id: undefined,
      source_ref: undefined,
    }));

    const ids = await client.recordBatch(items);
    if (ids) {
      console.log(`[${time}] Posted ${ids.length} standup action items to dashboard`);
    }
  }

  private async linkResearchToImplementation(time: string): Promise<void> {
    try {
      const minScore = this.config.verification?.min_score ?? 0.7;
      const recent = this.store.getRecentVerified(20, minScore);
      // Filter to research tasks only — the linker does further filtering
      const researchTasks = recent.filter((t) => t.task_type === "research");
      if (researchTasks.length === 0) return;

      const created = await this.researchLinker.linkResearchToImplementation(researchTasks);
      if (created.length > 0) {
        console.log(`[${time}] Research→implementation: filed ${created.length} issue(s)`);
        for (const issue of created) {
          console.log(`  ${issue.url}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Research linking failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Called when an agent passes a health check after previously failing one.
   * Fires a recovery Telegram notification with the incident duration, clears
   * the rate-limit key so the message is never suppressed, and auto-resolves
   * any open dashboard escalation task that was created for this agent's
   * health-check failure.
   */
  private onHealthCheckRecovered(agentName: string): void {
    const failureStartedAt = this.healthFailureStartTimes.get(agentName);
    const durationMs = failureStartedAt !== undefined ? Date.now() - failureStartedAt : 0;
    const duration = formatHealthDuration(durationMs);

    this.healthFailingAgents.delete(agentName);
    this.healthFailureStartTimes.delete(agentName);
    this.healthRecoveryConfirmCycles.delete(agentName);
    this.healthEscalatedAgents.delete(agentName);
    // Clear rate-limit so the recovery notification fires immediately even if a
    // failure alert was sent recently.
    clearNotifyRateLimit(`health-fail:${agentName}`);
    clearNotifyRateLimit(`health-recovery:${agentName}`);
    this.log.info("Agent recovered from health-check failure", { agentName });
    console.log(`  ${agentName}: ✅ health-check recovered after ${duration}`);
    notifyOperator(
      `Agent ${agentName} recovered`,
      `✅ ${agentName} recovered after ${duration}. Health checks are passing again.`,
      "info",
      `health-recovery:${agentName}`,
    ).catch(() => {});
    // Auto-resolve any open dashboard escalation task for this health failure.
    const sourceRef = `health-check-fail:${agentName}`;
    const escalated = this.store.findEscalatedTask(sourceRef);
    if (escalated) {
      const port = this.config.agents[agentName]?.docker?.port;
      this.store.updateTask(escalated.id, {
        status: "done",
        result: `Agent ${agentName} recovered after ${duration}. Health check passing on port ${port ?? "unknown"}. Auto-resolved by daemon.`,
      });
      this.log.info("Auto-resolved health-check escalation on recovery", { agentName, port, taskId: escalated.id });
    }
  }

  /**
   * Called when an agent recovers from a health-check failure that was still
   * within the grace period — i.e. no escalation task was ever created and no
   * Telegram alert was sent.  Silently clears all tracking state and logs the
   * event for observability.  No operator notification is needed because the
   * operator was never notified of the failure in the first place.
   */
  private onHealthCheckSilentRecovery(agentName: string): void {
    const failureStartedAt = this.healthFailureStartTimes.get(agentName);
    const durationMs = failureStartedAt !== undefined ? Date.now() - failureStartedAt : 0;
    const duration = formatHealthDuration(durationMs);

    this.healthFailingAgents.delete(agentName);
    this.healthFailureStartTimes.delete(agentName);
    this.healthRecoveryConfirmCycles.delete(agentName);
    clearNotifyRateLimit(`health-fail:${agentName}`);
    clearNotifyRateLimit(`health-recovery:${agentName}`);
    this.log.info(
      "Agent self-recovered within grace period — no incident task dispatched",
      { agentName, durationMs, duration },
    );
    console.log(
      `  ${agentName}: ✅ self-recovered in ${duration} (within ${formatHealthDuration(HEALTH_GRACE_PERIOD_MS)} grace period — no incident created)`,
    );
    // Record the suppression so the /health-checks panel can prove the grace
    // period fix (#730) is reducing unnecessary dispatches (issue #743).
    this.store.recordHealthCheckEvent({
      kind: "grace_period_suppressed",
      agent_name: agentName,
      detail: `self-recovered in ${duration}`,
    });
  }

  /**
   * Execute the auto-recovery playbook for a failing agent.
   *
   * Called by `redeployStale` and `preventiveRestart` when a health check
   * fails, BEFORE escalating to a human operator.  Performs up to
   * HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS restart cycles, each preceded by a
   * secrets-health probe:
   *
   *   1. GET /secrets/health — identify missing credentials early.
   *   2. Graceful restart (stop + start) with a shortened health-check window.
   *   3. If the restart succeeds → silent recovery, no operator notification.
   *
   * If all attempts are exhausted the recovery history is stored in
   * `healthAutoRecoveryHistory` and `onHealthCheckFailed` is called to
   * escalate the incident with a full report of what was tried.
   *
   * Guards against concurrent playbook runs for the same agent: if the agent
   * is already being tracked (i.e. a previous attempt is still in flight or
   * has already escalated), the call is a no-op.
   */
  private async runAutoRecoveryPlaybook(agentName: string, originalDetail: string): Promise<void> {
    // Guard: don't start a new playbook if one is already tracking this agent.
    if (this.healthFailingAgents.has(agentName)) {
      this.log.info("Auto-recovery skipped — agent already being tracked", { agentName });
      return;
    }

    // Start tracking so checkHealthRecoveries can confirm recovery between attempts.
    this.healthFailingAgents.add(agentName);
    if (!this.healthFailureStartTimes.has(agentName)) {
      this.healthFailureStartTimes.set(agentName, Date.now());
    }
    this.healthRecoveryConfirmCycles.set(agentName, 0);
    clearNotifyRateLimit(`health-recovery:${agentName}`);

    this.log.info("Starting auto-recovery playbook", { agentName, originalDetail, maxAttempts: HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS });
    console.log(`  ${agentName}: 🔄 auto-recovery playbook started (${originalDetail})`);

    const steps: string[] = [];

    for (let attempt = 1; attempt <= HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS; attempt++) {
      const attemptPrefix = `**Attempt ${attempt}/${HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS}**`;

      // ── Step 1: Secrets health probe ────────────────────────────────────────
      try {
        const secretsResult = await this.deployer.checkSecretsHealth(agentName);
        if (!secretsResult.reachable) {
          steps.push(`${attemptPrefix} — Secrets check: agent unreachable (${secretsResult.error ?? "connection failed"})`);
        } else if (!secretsResult.healthy) {
          const names = secretsResult.unhealthySecrets.length > 0
            ? secretsResult.unhealthySecrets.join(", ")
            : "unknown";

          // Persist the three-state mount details so the pre-dispatch validator
          // can distinguish 'not-mounted' (hard block) from 'mounted-but-empty'
          // (soft warning) without issuing its own HTTP call.
          const mountDetails = secretsResult.mountDetails ?? [];
          if (mountDetails.length > 0) {
            this.store.upsertSecretMountStatus(agentName, mountDetails);
          }

          // Send a targeted Telegram warning for 'mounted-but-empty' secrets so
          // the operator knows the host-side mount is misconfigured even before a
          // task is dispatched and fails.
          const emptySecrets = mountDetails.filter((d) => d.status === "mounted-but-empty");
          if (emptySecrets.length > 0) {
            const emptyNames = emptySecrets.map((d) => d.name).join(", ");
            notifyOperator(
              `Secret misconfiguration: ${agentName}`,
              `Agent \`${agentName}\` has secret(s) mounted but empty: **${emptyNames}**.\n` +
                "The file path exists but contains no content — check the host-side bind mount or secrets injector.\n" +
                "Dispatch will be allowed but tasks that need these credentials will fail.",
              "warning",
              `secret-empty:${agentName}`,
            ).catch(() => {});
          }

          steps.push(`${attemptPrefix} — Secrets check FAILED: unhealthy secrets: ${names}`);
          this.log.warn("Auto-recovery: secrets unhealthy", { agentName, attempt, unhealthySecrets: secretsResult.unhealthySecrets });
        } else {
          // All healthy — persist to clear any previous not-mounted/empty states.
          const healthyMountDetails = secretsResult.mountDetails ?? [];
          if (healthyMountDetails.length > 0) {
            this.store.upsertSecretMountStatus(agentName, healthyMountDetails);
          }
          steps.push(`${attemptPrefix} — Secrets check: all required secrets healthy ✓`);
        }
      } catch (err) {
        steps.push(`${attemptPrefix} — Secrets check error: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ── Step 2: Graceful restart ─────────────────────────────────────────────
      this.log.info("Auto-recovery: attempting graceful restart", { agentName, attempt });
      let restartResult: Awaited<ReturnType<typeof this.deployer.restartAgent>>;
      try {
        restartResult = await this.deployer.restartAgent(agentName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        steps.push(`${attemptPrefix} — Graceful restart threw: ${msg}`);
        this.log.error("Auto-recovery restart threw", { agentName, attempt, error: msg });
        continue; // Move on to next attempt
      }

      // ── Step 3: Evaluate restart result ─────────────────────────────────────
      if (restartResult.action === "redeployed") {
        steps.push(`${attemptPrefix} — Graceful restart succeeded, health check passing ✓`);
        this.log.info("Auto-recovery succeeded", { agentName, attempt });
        console.log(`  ${agentName}: ✅ auto-recovery succeeded on attempt ${attempt}/${HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS}`);

        // Clear all tracking — operator was never notified, so no recovery alert needed.
        this.healthFailingAgents.delete(agentName);
        this.healthFailureStartTimes.delete(agentName);
        this.healthRecoveryConfirmCycles.delete(agentName);
        this.healthAutoRecoveryHistory.delete(agentName);
        clearNotifyRateLimit(`health-fail:${agentName}`);
        clearNotifyRateLimit(`health-recovery:${agentName}`);
        return;
      }

      // Restart failed (health check still failing after restart).
      const restartDetail = restartResult.detail ?? "agent did not respond after restart";
      steps.push(`${attemptPrefix} — Graceful restart completed but agent still unhealthy: ${restartDetail}`);
      this.log.warn("Auto-recovery attempt failed", { agentName, attempt, restartAction: restartResult.action, detail: restartDetail });
      console.log(`  ${agentName}: ⚠ auto-recovery attempt ${attempt}/${HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS} failed`);
    }

    // All recovery attempts exhausted — hand off to escalation.
    this.log.warn("Auto-recovery exhausted — escalating to operator", {
      agentName,
      attempts: HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS,
    });
    this.healthAutoRecoveryHistory.set(agentName, steps);
    this.onHealthCheckFailed(agentName, originalDetail);
  }

  /**
   * Called when an agent fails a health check after all auto-recovery attempts
   * have been exhausted.  Immediately escalates via Telegram and creates a
   * dashboard task with a structured incident response playbook that includes
   * the auto-recovery steps already tried.
   *
   * Guards against duplicate escalations: if an escalation task has already
   * been created for this agent the call is a no-op.
   */
  private onHealthCheckFailed(agentName: string, detail: string): void {
    // Ensure tracking state is initialised (handles direct calls in tests).
    if (!this.healthFailingAgents.has(agentName)) {
      this.healthFailingAgents.add(agentName);
      this.healthFailureStartTimes.set(agentName, Date.now());
    }
    this.healthRecoveryConfirmCycles.set(agentName, 0);
    clearNotifyRateLimit(`health-recovery:${agentName}`);

    // Guard against re-escalating on every subsequent cycle.
    // Record this as a dedup-gate suppression so the /health-checks panel
    // can prove the one-active-incident gate (#731) is working (issue #743).
    if (this.healthEscalatedAgents.has(agentName)) {
      this.store.recordHealthCheckEvent({
        kind: "dedup_gate_suppressed",
        agent_name: agentName,
        detail,
      });
      return;
    }
    this.healthEscalatedAgents.add(agentName);

    const startedAt = this.healthFailureStartTimes.get(agentName) ?? Date.now();
    const elapsedMs = Date.now() - startedAt;

    this.log.warn("Health check failure — escalating to operator", { agentName, detail, elapsedMs });

    notifyOperator(
      `Health check failed: ${agentName}`,
      `Agent ${agentName} has been unhealthy for ${formatHealthDuration(elapsedMs)} — ${HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS} auto-recovery attempt(s) exhausted. Detail: ${detail}`,
      "critical",
      `health-fail:${agentName}`,
    ).catch(() => {});

    // Create an escalated task so the dashboard surfaces the failure.
    // Use a stable source_ref so we can find and resolve it on recovery.
    const sourceRef = `health-check-fail:${agentName}`;
    const existing = this.store.findActiveIncidentTask(sourceRef);
    if (!existing) {
      const port = this.config.agents[agentName]?.docker?.port;
      const portInfo = port ? `port ${port}` : "unknown port";
      const containerName = agentName;

      // Build post-mortem: capture docker logs and infer root cause at the
      // moment of escalation so operators know WHY the agent failed (issue #771).
      const postmortem = buildHealthPostmortem(
        containerName,
        detail,
        startedAt,
        elapsedMs,
      );
      const postmortemSection = renderPostmortemBlock(postmortem);
      this.log.info("Health post-mortem collected", {
        agentName,
        rootCause: postmortem.rootCause,
        rootCauseLabel: postmortem.rootCauseLabel,
        durationLabel: postmortem.durationLabel,
      });

      // Include auto-recovery history so the operator sees what was already tried.
      const recoverySteps = this.healthAutoRecoveryHistory.get(agentName) ?? [];
      const recoverySection = recoverySteps.length > 0
        ? `\n### Auto-Recovery Attempts (exhausted before escalation)\n\n${recoverySteps.map((s) => `- ${s}`).join("\n")}\n`
        : `\n### Auto-Recovery Attempts\n\nNo automated recovery was attempted before escalation.\n`;

      const incidentPlaybook = `${postmortemSection}## Health Check Incident: ${agentName}

**Trigger:** ${detail}
**Container:** ${containerName} (${portInfo})
**Time:** ${new Date().toISOString()}
**Auto-recovery:** ${HEALTH_AUTO_RECOVERY_MAX_ATTEMPTS} attempt(s) exhausted — manual intervention required.
${recoverySection}
---

You are responding to a health check failure that survived automated recovery. A bare
"agent recovered" claim is a quality failure. You MUST run every diagnostic step below
and include the actual command output in your response.

### Step 1 — Container state and recent logs
\`\`\`
docker logs ${containerName} --tail 50 2>&1
docker inspect ${containerName} --format '{{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}}' 2>&1
\`\`\`

### Step 2 — Port binding
\`\`\`
ss -tlnp | grep ${port ?? "<port>"} || netstat -tlnp 2>/dev/null | grep ${port ?? "<port>"}
curl -sv --max-time 5 http://localhost:${port ?? "<port>"}/ 2>&1; echo "curl exit: $?"
\`\`\`

### Step 3 — Secrets health
\`\`\`
curl -s http://localhost:${port ?? "<port>"}/secrets/health | jq .
\`\`\`
Include the full JSON response. If \`healthy\` is false, identify which secret is missing
and where to mount it.

### Step 4 — Docker healthcheck configuration
\`\`\`
grep -A 10 "healthcheck\\|start_period" docker-compose.generated.yml 2>/dev/null || echo "ABSENT"
docker inspect ${containerName} --format '{{json .Config.Healthcheck}}' 2>&1
\`\`\`

### Step 5 — Recovery status and root cause
- State whether the health check is now passing or still failing (with evidence).
- Identify the root cause from the docker logs output.
- If \`start_period\` is absent, note this as a systemic risk and file a GitHub issue.

**DO NOT** close this task with a one-sentence claim. All five steps are required.`;

      const task = this.store.createTask({
        title: `Health check incident: ${agentName} (${portInfo})`,
        description: incidentPlaybook,
        source: "manual",
        source_ref: sourceRef,
        agent_name: agentName,
        task_type: "research",
      });
      this.store.updateTask(task.id, {
        status: "escalated",
        result: `Health check failed: ${detail}`,
      });
      this.log.info("Created health-check escalation task with diagnostic playbook", { agentName, port, taskId: task.id });
      // Record the dispatch so the /health-checks panel can track the current
      // dispatch rate vs. the pre-fix baseline of 45% (issue #743).
      this.store.recordHealthCheckEvent({
        kind: "dispatched",
        agent_name: agentName,
        detail,
      });
      // Recovery history consumed — clear it to avoid stale data on next incident.
      this.healthAutoRecoveryHistory.delete(agentName);
    }
  }

  /**
   * Confirm recovery for agents currently tracked as failing health checks.
   * Each passing health check increments a debounce counter; any failure resets
   * the counter.  Once the agent passes `HEALTH_RECOVERY_CONFIRM_CYCLES`
   * consecutive checks the incident is considered closed.
   *
   * Two distinct paths:
   *  - Recovered within grace period (no escalation was fired): call
   *    `onHealthCheckSilentRecovery` — no operator notification needed.
   *  - Recovered after escalation: call `onHealthCheckRecovered` — sends
   *    Telegram recovery alert and auto-resolves the dashboard task.
   */
  private async checkHealthRecoveries(): Promise<void> {
    if (this.healthFailingAgents.size === 0) return;

    for (const agentName of [...this.healthFailingAgents]) {
      const healthy = await this.deployer.healthCheck(agentName, { maxRetries: 1, delaysMs: [0] });
      if (!healthy) {
        this.healthRecoveryConfirmCycles.set(agentName, 0);
        continue;
      }

      const passes = (this.healthRecoveryConfirmCycles.get(agentName) ?? 0) + 1;
      this.healthRecoveryConfirmCycles.set(agentName, passes);
      if (passes >= HEALTH_RECOVERY_CONFIRM_CYCLES) {
        if (this.healthEscalatedAgents.has(agentName)) {
          // Escalation was created — send recovery notification and auto-resolve task.
          this.onHealthCheckRecovered(agentName);
        } else {
          // Still within grace period — self-healed with no incident created.
          this.onHealthCheckSilentRecovery(agentName);
        }
      }
    }
  }

  /**
   * Scan the host process table for orphaned `docker compose` subprocesses
   * older than 15 minutes and SIGKILL them. Safe to call before any code path
   * that may itself spawn `docker compose up --build` (selfUpdate / proxy
   * deploy triggers) so prior-cycle orphans are cleaned up before the next
   * cycle adds to the pile.
   *
   * The orphans observed in #1517/#1558 are the compose CLI process itself,
   * not the running container — by the time we're past the 15-min ceiling
   * the container is either up (and the CLI is doing nothing useful) or
   * never coming up (build cache hung, daemon socket race, registry stall).
   * Either way SIGKILLing the CLI process is safe.
   *
   * Counts and PIDs are logged whenever the reaper kills anything; a no-op
   * cycle stays silent to avoid log noise.
   */
  private reapOrphanComposeProcesses(time: string, callsite: string): void {
    try {
      const result = reapStaleComposeProcesses();
      if (result.killed > 0) {
        this.composeOrphansReaped += result.killed;
        // Issue #1558 acceptance: "compose-reap: killed N orphans" log line.
        this.log.warn("compose-reap: killed orphan docker compose processes", {
          callsite,
          killed: result.killed,
          killedPids: result.killedPids,
          scanned: result.scanned,
          cumulative: this.composeOrphansReaped,
        });
        console.log(
          `[${time}] compose-reap: killed ${result.killed} orphan(s) at ${callsite} ` +
            `(pids: ${result.killedPids.join(", ")}; cumulative since startup: ${this.composeOrphansReaped})`,
        );
      }
      if (result.errors.length > 0) {
        this.log.warn("compose-reap: per-PID kill errors", {
          callsite,
          errors: result.errors,
        });
      }
    } catch (err) {
      // Defensive: the reaper itself catches ps-read errors, so reaching
      // here means an unexpected throw. Don't let it abort the cycle.
      this.log.warn("compose-reap: unexpected error", {
        callsite,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async redeployStale(time: string, registeredAgents?: Set<string>): Promise<void> {
    // Reap any prior-cycle orphan compose processes before triggering new
    // deploys. This is the "verify any prior-cycle compose process is dead
    // before spawning a new one" half of the #1558 acceptance criteria —
    // even when the inFlightDeploys mutex did its job, a previous cycle's
    // proxy-spawned compose CLI may still be hung on a build/pull stall.
    this.reapOrphanComposeProcesses(time, "redeployStale");

    try {
      const staleLocal = this.deployer.getStaleAgents(registeredAgents);
      const staleRepo = this.deployer.getStaleRepoAgents(registeredAgents);
      const totalStale = staleLocal.length + staleRepo.length;
      if (totalStale === 0) return;

      // Don't redeploy agents that are busy — wait until they finish
      const allStale = [...staleLocal, ...staleRepo];
      const idle = allStale.filter((name) => !this.store.hasActiveTask(name));
      const busy = allStale.filter((name) => this.store.hasActiveTask(name));
      if (busy.length > 0) {
        this.log.info("Deferring redeploy for busy agents", { busy, idle });
      }
      if (idle.length === 0) return;

      // Guard against overlapping deploy calls caused by a timed-out cycle.
      // When the 20-min watchdog abandons a cycle that was mid-deploy, the next
      // cycle must not re-trigger `docker compose up --build` for the same agent.
      // Duplicate triggers produce orphan compose processes that hold the
      // working-tree open and block concurrent git operations (issue #1517).
      const inFlight = idle.filter((name) => this.inFlightDeploys.has(name));
      const deployable = idle.filter((name) => !this.inFlightDeploys.has(name));

      if (inFlight.length > 0) {
        this.deploySkippedCount += inFlight.length;
        this.log.warn("redeployStale: skipping in-flight agents to prevent orphan compose processes", {
          inFlight,
          skippedTotal: this.deploySkippedCount,
        });
      }

      if (deployable.length === 0) return;

      // Mark as in-flight *before* calling the deployer so any concurrent cycle
      // that starts during the await sees the lock immediately.
      for (const name of deployable) this.inFlightDeploys.add(name);

      console.log(`[${time}] Redeploying ${deployable.length} agent(s): ${deployable.join(", ")}${busy.length > 0 ? ` (deferred: ${busy.join(", ")})` : ""}${inFlight.length > 0 ? ` (in-flight, skipped: ${inFlight.join(", ")})` : ""}`);

      let results: Awaited<ReturnType<typeof this.deployer.redeployStale>>;
      try {
        results = await this.deployer.redeployStale(new Set(deployable));
      } finally {
        // Always release the lock, even if redeployStale throws or is abandoned
        // by a cycle hard-timeout, so a future cycle can retry.
        for (const name of deployable) this.inFlightDeploys.delete(name);
      }

      for (const r of results) {
        if (r.action === "redeployed") {
          console.log(`  ${r.agentName}: redeployed`);
          // If this agent was previously failing health checks, recover it.
          // Use silent recovery if the grace period hadn't expired (no escalation created).
          if (this.healthFailingAgents.has(r.agentName)) {
            if (this.healthEscalatedAgents.has(r.agentName)) {
              this.onHealthCheckRecovered(r.agentName);
            } else {
              this.onHealthCheckSilentRecovery(r.agentName);
            }
          }
        } else if (r.action === "health-check-failed") {
          console.error(`  ${r.agentName}: ⚠ deployed but health check failed — starting auto-recovery playbook. ${r.detail}`);
          this.log.warn("Agent health check failed after deploy — running auto-recovery", { agentName: r.agentName, detail: r.detail });
          // Fire-and-forget: auto-recovery is async (restarts + health checks) and
          // runs within the daemon cycle watchdog window (~70s for 2 attempts).
          this.runAutoRecoveryPlaybook(
            r.agentName,
            r.detail ?? "Container rebuild triggered but agent did not respond to health check",
          ).catch((err) => {
            this.log.error("Auto-recovery playbook threw", { agentName: r.agentName, error: err instanceof Error ? err.message : String(err) });
          });
        } else if (r.action === "error") {
          console.error(`  ${r.agentName}: ${r.detail}`);
        }
      }
      // Re-sync after deploy: deployer Docker calls can corrupt proxy's
      // in-memory registry. Re-register all agents to ensure the proxy
      // knows about the full fleet, not just the ones that were restarted.
      if (results.length > 0) {
        this.log.info("Post-deploy re-sync: ensuring proxy has full agent registry");
        await this.syncAgents();
      }
    } catch (err) {
      console.error(`[${time}] Deploy check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async preventiveRestart(time: string, registeredAgents?: Set<string>): Promise<void> {
    const agents = registeredAgents
      ? [...registeredAgents]
      : Object.keys(this.config.agents);

    // Only restart agents that don't have active tasks
    const idleAgents = agents.filter((name) => !this.store.hasActiveTask(name));
    if (idleAgents.length === 0) {
      this.log.info("Preventive restart skipped: all agents busy");
      return;
    }

    this.log.info("Preventive container restart", { agents: idleAgents, cycle: this.cycleCount });
    for (const name of idleAgents) {
      try {
        const result = await this.deployer.restartAgent(name);
        if (result.action === "health-check-failed") {
          this.log.warn("Agent unhealthy after preventive restart — running auto-recovery", { agentName: name });
          // Fire-and-forget: auto-recovery is async but bounded (~70s for 2 attempts).
          this.runAutoRecoveryPlaybook(
            name,
            result.detail ?? "Container restarted but agent did not respond to health check",
          ).catch((err) => {
            this.log.error("Auto-recovery playbook threw", { agentName: name, error: err instanceof Error ? err.message : String(err) });
          });
        } else if (result.action === "redeployed") {
          // If the agent was previously failing health checks, recover it.
          // Use silent recovery if the grace period hadn't expired (no escalation created).
          if (this.healthFailingAgents.has(name)) {
            if (this.healthEscalatedAgents.has(name)) {
              this.onHealthCheckRecovered(name);
            } else {
              this.onHealthCheckSilentRecovery(name);
            }
          }
        }
      } catch (err) {
        this.log.error("Preventive restart failed", { agentName: name, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /**
   * Post-dispatch orphan hook: called immediately from the fire-and-forget
   * completion callback when an agent finishes its task. Scans only the
   * specific agent's repo for branches without PRs and creates them inline —
   * no waiting for the next scheduled createOrphanPRs sweep.
   *
   * This is the "hook into the branch-push detection path" from issue #305:
   * because dispatch is fire-and-forget the branch push happens asynchronously,
   * potentially between daemon cycles. Without this hook, the orphan branch
   * could sit undetected for up to one full poll interval (5 min at default
   * settings). With the hook, PR creation is attempted within seconds of the
   * agent completing its work.
   */
  private async postDispatchOrphanCheck(agentName: string): Promise<void> {
    const agent = this.config.agents[agentName];
    if (!agent?.github) return;

    const time = new Date().toLocaleTimeString();
    this.log.info("Post-dispatch orphan check triggered", { agentName, repo: agent.github });

    try {
      // Auth pre-flight — same guard as the general sweep
      const authStatus = validateGhAuth();
      if (!authStatus.ok) {
        this.log.warn("Post-dispatch orphan check: gh auth failed, skipping", {
          agentName,
          reason: authStatus.reason,
        });
        return;
      }

      // Targeted scan — only the agent that just completed
      const orphans = findOrphanBranches(this.config, agentName);
      for (const orphan of orphans) {
        console.log(`[${time}] Post-dispatch orphan: ${orphan.repo}/${orphan.branch} — creating PR immediately`);
        const url = await createPRForBranch(orphan, this.config, this.store);
        if (url === null) {
          this.prRetryQueue.enqueue(
            orphan.repo,
            orphan.branch,
            "post-dispatch orphan PR creation returned null",
          );
        } else {
          this.log.info("Post-dispatch orphan PR created", { agentName, repo: orphan.repo, branch: orphan.branch, url });
        }
      }
    } catch (err) {
      this.log.warn("Post-dispatch orphan check failed", {
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async createOrphanPRs(time: string): Promise<void> {
    try {
      // 1. Process any pending retries from prior failed attempts first.
      const retried = await this.prRetryQueue.processPendingRetries(
        async (repo, branch) => {
          const agentName = Object.entries(this.config.agents)
            .find(([, a]) => a.github === repo)?.[0] ?? "unknown";
          const url = await createPRForBranch({ repo, branch, agentName }, this.config, this.store);
          return url !== null;
        },
      );
      if (retried > 0) {
        console.log(`[${time}] PR creation retry queue: processed ${retried} pending retries`);
      }

      // 2. Periodically emit telemetry summary.
      if (this.cycleCount % PR_TELEMETRY_LOG_EVERY_N_CYCLES === 0) {
        const telemetry = this.prRetryQueue.getFailureTelemetry();
        if (telemetry.total_branches > 0) {
          this.log.info("PR creation retry telemetry", {
            total_branches: telemetry.total_branches,
            pending: telemetry.pending,
            succeeded: telemetry.succeeded,
            failed: telemetry.failed,
            total_attempts: telemetry.total_attempts,
            success_rate: telemetry.success_rate !== null
              ? `${(telemetry.success_rate * 100).toFixed(1)}%`
              : "n/a",
            top_errors: telemetry.top_errors.slice(0, 3),
          });
        }
      }

      // 3. Purge stale branches before scanning for new orphans.
      // Any branch >STALE_BRANCH_BEHIND_THRESHOLD commits behind main with no
      // open PR is deleted automatically — this avoids running expensive
      // validation (tsc + vitest) on branches that would conflict anyway.
      const deleted = deleteStaleOrphanBranches(this.config);
      if (deleted > 0) {
        console.log(`[${time}] Deleted ${deleted} stale orphan branch(es) (>${STALE_BRANCH_BEHIND_THRESHOLD} commits behind main)`);
        this.log.info("Stale orphan branches deleted", { count: deleted });
      }

      // 4. Detect new orphan branches and attempt PR creation.
      const orphans = findOrphanBranches(this.config);

      // Pre-flight: verify gh is authenticated before attempting any PR creation.
      // If auth is down for the orchestrator, all `gh pr create` calls will fail
      // and we'd just accumulate noisy retry entries.  Enqueue with a clear
      // "gh-auth-failed" error so the retry queue surfaces the root cause, then
      // skip this cycle.  Auth recovery will be detected on the next cycle and
      // normal processing resumes automatically.
      if (orphans.length > 0) {
        const authStatus = validateGhAuth();
        if (!authStatus.ok) {
          const reason = authStatus.reason ?? "gh CLI is not authenticated";
          this.log.error(
            "gh auth pre-flight failed — skipping orphan PR creation; branches queued for retry",
            { reason, orphanCount: orphans.length },
          );
          for (const orphan of orphans) {
            this.prRetryQueue.enqueue(
              orphan.repo,
              orphan.branch,
              `gh-auth-failed: ${reason}`,
            );
          }
          return;
        }
      }

      for (const orphan of orphans) {
        console.log(`[${time}] Orphan branch: ${orphan.repo}/${orphan.branch} — creating PR`);
        // Pass config (for issue resolution + local path detection) and store (for task_logs)
        const url = await createPRForBranch(orphan, this.config, this.store);
        if (url === null) {
          // PR creation returned null (validation failed or gh CLI error).
          // Enqueue for retry so the daemon will re-attempt with backoff.
          this.prRetryQueue.enqueue(
            orphan.repo,
            orphan.branch,
            "PR creation returned null (pre-submit validation failed or gh CLI error)",
          );
        }
      }
    } catch (err) {
      console.error(`[${time}] Orphan branch check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Periodic proactive rebase scan.
   *
   * Finds all PR-associated branches across agent repos that are behind
   * origin/main and rebases those within the safe threshold.  This runs
   * every PROACTIVE_REBASE_EVERY_N_CYCLES (~15 min) to prevent stale-branch
   * lag from accumulating into merge conflicts.
   */
  private async runProactiveRebases(time: string): Promise<void> {
    try {
      const results = await runScheduledRebases(this.config, this.store);
      const rebased = results.filter((r) => r.outcome === "rebased");
      const conflicts = results.filter((r) => r.outcome === "conflict");
      const errors = results.filter((r) => r.outcome === "error");

      if (rebased.length > 0) {
        console.log(`[${time}] Proactive rebase: rebased ${rebased.length} branch(es) onto main`);
        this.log.info("Proactive rebase scan complete", {
          rebased: rebased.length,
          conflicts: conflicts.length,
          errors: errors.length,
          branches: rebased.map((r) => `${r.repo}/${r.branch}`),
        });
      }

      if (conflicts.length > 0) {
        this.log.warn("Proactive rebase scan: branches with unresolvable conflicts", {
          count: conflicts.length,
          branches: conflicts.map((r) => `${r.repo}/${r.branch} (${r.commitsBehind} behind)`),
        });
      }
    } catch (err) {
      this.log.warn("Proactive rebase scan failed (non-fatal)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async reviewPRs(time: string): Promise<void> {
    const agentsByRepo = new Map<string, string>();
    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (agent.github) agentsByRepo.set(agent.github, name);
    }

    if (agentsByRepo.size === 0) return;

    // ── Priority review fast-lane (issue #871) ────────────────────────────
    // Review dispatch-blocking PRs before the general open-PR sweep so they
    // can unblock pending dispatches within the same daemon cycle.
    const priorityQueue = this.store.getPriorityReviewQueue();
    // Track which (repo, prNumber) pairs were handled in the priority phase
    // so the general sweep below doesn't double-review them.
    const priorityReviewed = new Set<string>();

    if (priorityQueue.length > 0) {
      console.log(`[${time}] Priority review fast-lane: ${priorityQueue.length} dispatch-blocking PR(s) queued`);
      this.log.info("Priority review fast-lane: reviewing dispatch-blocking PRs first", {
        count: priorityQueue.length,
        entries: priorityQueue.map((e) => `${e.repo}#${e.pr_number}`),
      });
    }

    for (const entry of priorityQueue) {
      const { repo, pr_number: prNumber, blocked_issue_ref: blockedIssueRef } = entry;
      try {
        const result = await this.prReviewer.reviewPR(repo, prNumber);
        const approved = result.decision === "approve";
        this.store.completePriorityReview(repo, prNumber, approved);
        priorityReviewed.add(`${repo}#${prNumber}`);

        console.log(
          `[${time}] Priority review: ${repo}#${prNumber} → ${result.decision} ` +
          `(blocked: ${blockedIssueRef}, unblocked: ${approved})`,
        );
        this.log.info("Priority review completed", {
          repo,
          prNumber,
          blockedIssueRef,
          decision: result.decision,
          unblockedDispatch: approved,
        });
      } catch (err) {
        this.log.warn("Priority review failed for dispatch-blocking PR", {
          repo,
          prNumber,
          blockedIssueRef,
          error: err instanceof Error ? err.message : String(err),
        });
        // Remove from queue so it falls through to the general sweep rather than
        // stalling the priority lane on a consistently failing PR.
        this.store.removeFromPriorityReviewQueue(repo, prNumber);
      }
    }

    // Rotate the general sweep across repos so a single cycle never reviews
    // more than MAX_REPOS_PER_REVIEW_SWEEP. See the constant for the rationale.
    // Repos with priority-review entries are excluded from this rotation
    // budget — they already got fast-laned above.
    const allRepos = Array.from(agentsByRepo.keys());
    const startIdx = allRepos.length > 0 ? this.cycleCount % allRepos.length : 0;
    const sweepRepos: string[] = [];
    for (let i = 0; i < Math.min(MAX_REPOS_PER_REVIEW_SWEEP, allRepos.length); i++) {
      sweepRepos.push(allRepos[(startIdx + i) % allRepos.length]);
    }
    if (allRepos.length > sweepRepos.length) {
      this.log.debug("PR review general sweep: rotated subset", {
        cycle: this.cycleCount,
        repoCount: allRepos.length,
        sweepingThisCycle: sweepRepos,
        deferredToNextCycle: allRepos.filter((r) => !sweepRepos.includes(r)),
      });
    }

    try {
      for (const repo of sweepRepos) {
        const agentName = agentsByRepo.get(repo)!;
        const results = await this.prReviewer.reviewOpenPRs(repo);
        for (const { prNumber, result, prBody, prBranch, prDiff } of results) {
          // Skip PRs already handled in the priority fast-lane to avoid double-reviewing
          if (priorityReviewed.has(`${repo}#${prNumber}`)) {
            this.log.debug("General sweep: skipping PR already handled in priority fast-lane", { repo, prNumber });
            continue;
          }
          console.log(`[${time}] PR review: ${repo}#${prNumber} → ${result.decision} (${result.reason})`);

          // Auto-close persistently conflicting PRs and re-dispatch the linked issue.
          // After conflict_close_threshold consecutive conflict escalations the PR is
          // beyond automated recovery — close it and start fresh from main.
          if (result.conflictEscalation) {
            const threshold = this.config.pr_review?.conflict_close_threshold ?? 2;
            const conflictCount = this.prReviewer.getConflictEscalationCount(repo, prNumber);
            if (threshold > 0 && conflictCount >= threshold) {
              this.log.warn("Conflict escalation threshold reached — auto-closing PR and re-dispatching issue", {
                repo,
                prNumber,
                prBranch,
                agentName,
                conflictCount,
                threshold,
              });
              console.log(`[${time}] PR #${prNumber} on ${repo}: conflict threshold (${conflictCount}/${threshold}) — auto-closing and re-dispatching`);

              const closed = this.prReviewer.autoCloseConflictingPR(repo, prNumber, prBranch, conflictCount);
              this.prReviewer.resetConflictEscalation(repo, prNumber);

              if (closed) {
                // Re-dispatch the original issue so the agent starts fresh from main.
                // Inject conflict context (issue #810): original issue spec + diff hunks
                // + structured resolution guide so the agent understands what conflicted
                // and how to approach the fresh implementation.
                const issueNumbers = extractClosedIssueNumbers(prBody);
                if (issueNumbers.length > 0 && !this.store.hasActiveTask(agentName)) {
                  const issueNum = issueNumbers[0];
                  this.log.info("Re-dispatching linked issue after auto-close of conflicting PR", { repo, prNumber, issueNum, agentName });
                  const redispatchMessage = buildConflictRedispatchMessage({
                    repo,
                    prNumber,
                    prBranch,
                    issueNum,
                    prDiff,
                  });
                  this.dispatcher.dispatch(redispatchMessage, {
                      agentName,
                      source: "github",
                      sourceRef: `${repo}#${issueNum}`,
                      title: `[re-dispatch] ${repo}#${issueNum} (conflict recovery)`,
                    },
                  ).catch((err) => {
                    this.log.error("Failed to re-dispatch issue after conflict auto-close", { repo, prNumber, issueNum, error: String(err) });
                  });
                } else if (issueNumbers.length === 0) {
                  this.log.warn("Auto-closed conflicting PR but could not find linked issue to re-dispatch", { repo, prNumber, prBranch });
                } else {
                  this.log.info("Auto-closed conflicting PR but agent is busy — issue re-dispatch skipped", { agentName, repo, prNumber });
                }
              }
              // Skip other decision handling for this PR — it's already closed
              continue;
            }
          }

          // Dispatch feedback to agent when changes are requested (skip if agent busy or duplicate)
          if (result.decision === "request-changes") {
            // Guard: the PR may have been merged between the open-PR fetch and now (race condition).
            // Check state before dispatching to avoid wasted cycles on already-merged PRs.
            if (!this.prReviewer.isPROpen(repo, prNumber)) {
              this.log.info("Skipped PR feedback dispatch: PR no longer open (no-op)", { agentName, repo, prNumber });
            } else if (prBodyHasIssueRef(prBody) && /missing.*issue reference|missing.*Closes #N|issue.*reference.*missing|Closes #N/i.test(result.reason)) {
              // The review flagged a missing Closes #N, but the PR body already has one —
              // agent must have updated it between review cycles. No dispatch needed.
              // Note: intentionally does NOT match "stale_issues" or JSON schema field names
              // that happen to contain "issue" — those are caught by the housekeeping schema
              // validator and dispatched as pr-feedback via the else branch below.
              this.log.info("Skipping PR feedback dispatch: PR body already has issue ref", { agentName, repo, prNumber });
            } else if (this.store.hasActiveTask(agentName)) {
              this.log.info("Skipping PR feedback dispatch: agent busy", { agentName, repo, prNumber });
            } else if (this.store.hasActivePrFeedbackTask(repo, prNumber)) {
              this.log.info("Skipping PR feedback dispatch: feedback already in-flight", { agentName, repo, prNumber });
            } else if (isPRAlreadyMerged(repo, prNumber)) {
              this.log.info("Skipping feedback dispatch: PR already merged", { repo, prNumber });
            } else {
              // Ceiling check: if we've already dispatched enough rounds of feedback
              // for this PR with no approval, escalate to human instead of looping.
              // This is the reliable backstop — stored in our own state DB, independent of
              // the GitHub API comment-counting the reviewer uses.
              // The ceiling is configurable via agents.yaml: pr_review.feedback_ceiling (default: 3).
              const configuredCeiling = this.config.pr_review?.feedback_ceiling ?? PR_FEEDBACK_CEILING;
              const feedbackRounds = this.store.countPrFeedbackRounds(repo, prNumber);
              if (feedbackRounds >= configuredCeiling) {
                this.log.warn("PR feedback ceiling reached, escalating to human", {
                  repo,
                  prNumber,
                  agentName,
                  feedbackRounds,
                  ceiling: configuredCeiling,
                });
                console.log(`[${time}] PR #${prNumber} on ${repo}: feedback ceiling (${feedbackRounds}/${configuredCeiling}) — escalating to human`);
                // Mark in-flight pr-feedback tasks as 'escalated' so `orch status` shows a clear signal
                const markedCount = this.store.markPrFeedbackTasksEscalated(repo, prNumber);
                this.log.info("Marked pr-feedback tasks as escalated", { repo, prNumber, markedCount });
                this.prReviewer.escalatePR(
                  repo,
                  prNumber,
                  `This PR has gone through ${feedbackRounds} revision rounds without merging — escalating to human review.\n\n**Last reviewer feedback:** ${result.comment}`,
                ).catch((err) => {
                  this.log.error("Failed to escalate PR at feedback ceiling", { repo, prNumber, error: String(err) });
                });
              } else {
                // Consolidate all prior completed feedback rounds into a single
                // dispatch message so the agent can address everything in one push,
                // reducing sequential revision cycles (issue #267).
                const sourceRef = `${repo}#${prNumber}`;
                const priorTasks = this.store.getPrFeedbackHistory(sourceRef)
                  .filter((t) => t.status === "done" || t.status === "failed");
                const priorDescriptions = priorTasks.map((t) => t.description ?? null);
                const feedbackMessage = buildConsolidatedFeedbackMessage(
                  repo, prNumber, result.comment, priorDescriptions, { prDiff },
                );
                // Try to resume the original task's CLI session so the agent
                // retains context about what it built, rather than starting blank.
                const originalConversationId = resolveConversationIdForPR(this.store, repo, prBody);
                this.log.info("Dispatching PR feedback to agent", {
                  repo, prNumber, agentName, feedbackRounds, priorRoundsIncluded: priorDescriptions.length,
                  resumingSession: Boolean(originalConversationId),
                });
                this.dispatcher.dispatch(
                  feedbackMessage,
                  {
                    agentName,
                    source: "pr-feedback",
                    sourceRef,
                    title: `[PR feedback] ${repo}#${prNumber}`,
                    conversationId: originalConversationId,
                  },
                ).catch((err) => {
                  this.log.error("Failed to dispatch PR feedback", { repo, prNumber, error: String(err) });
                });
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${time}] PR review failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async sweepAndMergeApprovedPRs(time: string): Promise<void> {
    try {
      const swept = await this.prReviewer.sweepApprovedPRsIntoQueue();
      if (swept > 0) {
        console.log(`[${time}] Auto-merge sweep: added ${swept} previously-approved PR(s) to merge queue`);
        this.log.info("Auto-merge sweep completed", { swept });
      }
    } catch (err) {
      console.error(`[${time}] Auto-merge sweep failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Sweep CLEAN/MERGEABLE PRs that bypassed the reviewer and merge them.
   *
   * Catches PRs that are CI-green and mergeable but have not been touched
   * by the reviewer (typically because the self-approval block prevents
   * the reviewer from approving fleet-authored PRs in shared-identity
   * setups). Without this, those PRs sit indefinitely.
   *
   * Safety guards:
   *  - Author allowlist (default: ["rapartlu"]) — external-contributor PRs are skipped.
   *  - Daily cap (default: 25 successful merges per 24h) — caps blast radius.
   *  - Kill switch (`triggers.auto_merge_sweep_enabled = false`) — operator can disable
   *    via agents.yaml without redeploy.
   *
   * Each merge attempt (success or failure) is recorded in `auto_merge_log`
   * for audit + Auditor agent (#1570) consumption. See issue #1587 for the
   * full design.
   */
  private async sweepStaleCleanPRs(time: string): Promise<void> {
    const enabled = this.config.triggers?.auto_merge_sweep_enabled !== false;
    if (!enabled) return;

    try {
      const repos = Array.from(
        new Set(
          Object.values(this.config.agents)
            .map((a) => a.github)
            .filter((r): r is string => typeof r === "string" && r.length > 0),
        ),
      );

      if (repos.length === 0) return;

      const stale = await scanFleetMergeStalls(repos);
      const allowlist = new Set(
        this.config.triggers?.auto_merge_author_allowlist ?? ["rapartlu"],
      );
      const dailyCap = this.config.triggers?.auto_merge_daily_cap ?? 25;
      const merged24h = this.store.countAutoMergesIn(24 * 60 * 60 * 1000);

      const decision = selectMergeCandidates(
        stale,
        { enabled: true, authorAllowlist: allowlist, dailyCap },
        merged24h,
      );

      if (decision.skipped) {
        if (decision.reason === "daily-cap") {
          this.log.warn("Auto-merge sweep daily cap reached", {
            merged24h,
            dailyCap,
            deferred: decision.deferred,
          });
        }
        return;
      }

      console.log(
        `[${time}] Auto-merge sweep: merging ${decision.toMerge.length} stale CLEAN PR(s)` +
          (decision.deferred > 0 ? ` (${decision.deferred} deferred by daily cap)` : ""),
      );

      const results = await autoMergeFleetPRs(decision.toMerge);
      for (const r of results) {
        this.store.recordAutoMerge({
          repo: r.pr.repo,
          prNumber: r.pr.number,
          title: r.pr.title,
          success: r.success,
          error: r.error,
        });
      }

      const succeeded = results.filter((r) => r.success).length;
      const failed = results.length - succeeded;
      if (failed > 0) {
        this.log.warn("Auto-merge sweep had failures", { succeeded, failed });
      } else {
        this.log.info("Auto-merge sweep completed", { merged: succeeded });
      }
    } catch (err) {
      this.log.warn("sweepStaleCleanPRs failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Periodic sweep of stale pending/paused tasks (issue #1646).
   * Cancels or supersedes tasks that have been stuck in pending/paused status
   * for more than `triggers.stale_task_threshold_days` (default: 7) days without dispatch.
   *
   * Marks timed-out tasks as `superseded` (when source issue is closed or task is >30d stale)
   * or `cancelled` (open issue, 7–30d stale). Writes an audit entry to `task_logs`.
   *
   * Runs once per day (~288 cycles at 5-min interval).
   */
  private async sweepStaleTasks(time: string): Promise<void> {
    const thresholdDays = this.config.triggers?.stale_task_threshold_days ?? 7;
    try {
      const result = await sweepStalePendingTasks({
        store: this.store,
        thresholdDays,
        dryRun: false,
      });
      const total = result.superseded + result.cancelled;
      if (total > 0) {
        console.log(
          `[${time}] Stale-task sweep: ${result.superseded} superseded, ${result.cancelled} cancelled (threshold: ${thresholdDays}d)`,
        );
        this.log.info("Stale-task sweep completed", {
          superseded: result.superseded,
          cancelled: result.cancelled,
          threshold_days: thresholdDays,
        });
      }
    } catch (err) {
      this.log.warn("sweepStaleTasks failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Dispatch child tasks for coordination groups still in "pending" status.
   *
   * createCoordinationGroup() writes task records to the DB in "pending" status
   * but never sends them to agents (issue #1000 root cause).  This method
   * detects those undispatched groups and fires each child task via
   * dispatcher.dispatchCoordinationChild(), which reuses the existing task
   * record rather than creating a duplicate.
   *
   * Runs in the dispatch batch every cycle.  Each child dispatch is
   * fire-and-forget so the daemon cycle is not blocked on agent I/O.
   * Groups are advanced to "in_progress" immediately so subsequent cycles
   * don't re-dispatch already-running children.
   */
  /**
   * Continuous-cadence dispatch for the producer/critic fleet-actions loop.
   *
   * Fires every FLEET_ACTIONS_DISPATCH_EVERY_N_CYCLES (~5 min at 60s poll).
   * Dispatches one bounded task to each of hustle-agent (the producer) and
   * auditor-agent (the critic), telling them to run one cycle of their
   * respective fleet-actions logic against docs/active-fleet-actions.yaml.
   *
   * Why this cadence: at the previous 5h housekeeping cadence, the producer/
   * critic loop produced one decision every 5 hours. To make the loop feel
   * continuous (operator sees activity within minutes), this drops to ~5 min.
   * Token cost is bounded per task — each agent does at most 1 propose + 1
   * execute per dispatch.
   *
   * Idempotency: each cycle just kicks the agent. The agent's runner is
   * itself bounded (max 1 propose / max 1 execute) so back-to-back dispatches
   * don't multiply per-cycle work — they just keep the loop fresh.
   */
  private async dispatchFleetActionsCycle(
    time: string,
    registeredAgents: Set<string>,
  ): Promise<void> {
    const hustleMessage =
      "Run one fleet-actions cycle:\n\n" +
      "1. Scan ONE target repo (rotating across configured list) for stale issues, " +
      "rank by impact score, propose ≤1 new action to the ledger " +
      "(docs/active-fleet-actions.yaml in rapartlu/agent-orchestrator).\n\n" +
      "2. Read approved actions from the ledger; execute ≤1 by posting an offer " +
      "comment on the target issue with the fleet wallet address. Update the " +
      "ledger with the outcome.\n\n" +
      "Bounded: max 1 propose + 1 execute per dispatch. Use the runner code in " +
      "src/hustle-runner.ts (runHustle()). Network failures are recoverable.\n\n" +
      "IMPORTANT — no journal PR. The ledger is the per-cycle artefact. Do NOT " +
      "open a PR against rapartlu/agent-orchestrator for a cycle journal file, " +
      "and do NOT write to docs/hustle/. Only the daily-housekeeping dispatch " +
      "(separate cadence, title prefix `[hustle-agent] daily`) opens the daily " +
      "summary PR. Empty passes return a structured summary with " +
      "summary_pr_url=null and nothing else.";

    const auditorMessage =
      "Run one fleet-actions review cycle:\n\n" +
      "1. Read docs/active-fleet-actions.yaml from rapartlu/agent-orchestrator " +
      "via gh api.\n\n" +
      "2. Pick the OLDEST action in proposed or under_review status.\n\n" +
      "3. Build FleetStateContext (live treasury probe via " +
      "src/inputs/treasury-probe.ts, in-flight actions from the ledger).\n\n" +
      "4. Run the review-pending-fleet-actions classifier — apply the 5 priority " +
      "rules (Charter III, capital discipline, OKR alignment, duplicate target, " +
      "low value). Default decision: approve.\n\n" +
      "5. Write the decision back to the ledger via gh api PUT.\n\n" +
      "Bounded: max 1 action reviewed per dispatch. Use src/audit-runner.ts " +
      "(runAudit({ skipFleetActionsReview: false })). Failures are recoverable.";

    const dispatches: Array<Promise<unknown>> = [];

    if (registeredAgents.has("hustle-agent")) {
      dispatches.push(
        this.dispatcher
          .dispatch(hustleMessage, {
            agentName: "hustle-agent",
            source: "manual",
            sourceRef: `fleet-actions-cycle:hustle:${Date.now()}`,
            title: `[fleet-actions] hustle pass — propose + execute`,
          })
          .then((r) => {
            this.log.info("Fleet-actions hustle dispatch", { taskId: r.taskId });
          })
          .catch((err) => {
            this.log.warn("Fleet-actions hustle dispatch failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    }

    if (registeredAgents.has("auditor-agent")) {
      dispatches.push(
        this.dispatcher
          .dispatch(auditorMessage, {
            agentName: "auditor-agent",
            source: "manual",
            sourceRef: `fleet-actions-cycle:auditor:${Date.now()}`,
            title: `[fleet-actions] auditor pass — review pending`,
          })
          .then((r) => {
            this.log.info("Fleet-actions auditor dispatch", { taskId: r.taskId });
          })
          .catch((err) => {
            this.log.warn("Fleet-actions auditor dispatch failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }),
      );
    }

    if (dispatches.length === 0) {
      // Neither agent registered; no-op
      return;
    }

    try {
      await Promise.allSettled(dispatches);
      console.log(
        `[${time}] Fleet-actions cycle dispatched (${dispatches.length} agent${dispatches.length === 1 ? "" : "s"})`,
      );
    } catch (err) {
      this.log.warn("dispatchFleetActionsCycle batch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatchPendingCoordinationGroups(time: string): Promise<void> {
    let groups: Array<{
      id: string;
      parentSourceRef: string | null;
      childTaskIds: Record<string, string>;
    }>;
    try {
      groups = this.store.getCoordinationGroupsByStatus("pending");
    } catch {
      // Table may not exist on older deployments — fail silently.
      return;
    }

    if (groups.length === 0) return;

    console.log(
      `[${time}] Coordination: ${groups.length} pending group(s) — dispatching child tasks`,
    );

    for (const group of groups) {
      // ── Guard 1: cancel the entire group if the source issue is closed ──────
      // A coordinated change originating from a closed issue has no actionable
      // work remaining. Cancel all pending child tasks immediately rather than
      // dispatching agents into ghost work (issue #1691).
      if (group.parentSourceRef) {
        const sourceMatch = /^([^#]+)#(\d+)$/.exec(group.parentSourceRef);
        if (sourceMatch) {
          const sourceRepo = sourceMatch[1]!;
          const issueNumber = parseInt(sourceMatch[2]!, 10);
          const isOpen = cachedIsIssueOpen(sourceRepo, issueNumber);
          if (!isOpen) {
            this.log.warn(
              "Coordination group source issue is closed — cancelling group without dispatch",
              {
                groupId: group.id,
                parentSourceRef: group.parentSourceRef,
              },
            );
            // Mark all pending child tasks as failed so the group can be cleanly closed.
            for (const [, childTaskId] of Object.entries(group.childTaskIds)) {
              const childTask = this.store.getTask(childTaskId);
              if (childTask?.status === "pending") {
                this.store.updateTask(childTaskId, {
                  status: "failed",
                  result: `Coordination group cancelled: source issue ${group.parentSourceRef} is closed — no dispatch needed.`,
                });
              }
            }
            this.store.updateCoordinationGroup(group.id, { status: "failed" });
            console.log(
              `[${time}] Coordination group ${group.id.slice(0, 8)} → failed` +
                ` (source issue closed: ${group.parentSourceRef})`,
            );
            continue;
          }
        }
      }

      const childEntries = Object.entries(group.childTaskIds);
      let anyDispatched = false;

      for (const [repo, childTaskId] of childEntries) {
        const childTask = this.store.getTask(childTaskId);

        if (!childTask) {
          this.log.warn("Coordination child task not found in store", {
            groupId: group.id,
            repo,
            childTaskId,
          });
          continue;
        }

        if (childTask.status !== "pending") {
          // Already dispatched or completed in a prior cycle — skip.
          continue;
        }

        // ── Guard 2: skip dispatch when no actionable implementation was extracted ──
        // When validateChangeSetDescription() could not extract a meaningful
        // per-repo description from the parent issue it substitutes
        // NO_CODE_CHANGES_FALLBACK. Dispatching such a task wastes an agent
        // cycle and creates noise. Mark it done immediately (issue #1691).
        if (childTask.description?.includes(NO_CODE_CHANGES_FALLBACK)) {
          this.log.info(
            "Coordination child skipped: no actionable implementation section in description",
            {
              groupId: group.id,
              repo,
              childTaskId,
            },
          );
          this.store.updateTask(childTaskId, {
            status: "done",
            result: `Skipped: no code changes required for \`${repo}\`. The parent issue had no actionable implementation section for this repo.`,
          });
          // Still need to advance coordination state in case this was the last
          // pending child — checkAndAdvanceCoordination is idempotent and safe
          // to call with a task that is already "done".
          checkAndAdvanceCoordination(childTaskId, this.store, this.config).catch((err) => {
            this.log.error("checkAndAdvanceCoordination failed after skip (non-fatal)", {
              childTaskId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          anyDispatched = true; // treat as dispatched so the group advances past "pending"
          continue;
        }

        if (childTask.agent_name && this.store.hasActiveTask(childTask.agent_name)) {
          this.log.info("Coordination child dispatch deferred: agent busy", {
            groupId: group.id,
            childTaskId,
            agentName: childTask.agent_name,
          });
          continue;
        }

        // Fire-and-forget: dispatchCoordinationChild manages state transitions
        // (dispatched → done | failed) and schedules retries on failure.
        // We must NOT await here — the agent call can take several minutes and
        // blocking would stall the entire daemon cycle.
        this.dispatcher.dispatchCoordinationChild(childTask).then(() => {
          this.log.info("Coordination child dispatch promise resolved", {
            groupId: group.id,
            childTaskId,
            repo,
          });
        }).catch((err) => {
          this.log.error("dispatchCoordinationChild threw unexpectedly", {
            groupId: group.id,
            childTaskId,
            repo,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        anyDispatched = true;
        this.log.info("Coordination child task dispatched", {
          groupId: group.id,
          childTaskId,
          repo,
          agentName: childTask.agent_name,
        });
      }

      // Advance the group so we don't re-dispatch on the next cycle.
      // If all agents were busy (anyDispatched = false) leave it pending
      // so it is retried in the next daemon cycle.
      if (anyDispatched) {
        this.store.updateCoordinationGroup(group.id, { status: "in_progress" });
        console.log(
          `[${time}] Coordination group ${group.id.slice(0, 8)} → in_progress` +
          ` (${childEntries.length} child task(s) dispatched)`,
        );
      }
    }
  }

  /**
   * Advance all running DAG executions by one cycle.
   *
   * Checks which DAG nodes have completed (by inspecting their backing task
   * status), dispatches newly-unblocked nodes in parallel (fire-and-forget),
   * and marks the parent task done when all nodes complete.
   *
   * Runs in Batch 2 every poll cycle alongside dispatchTriggers.
   */
  private async advancePendingDags(time: string): Promise<void> {
    try {
      const dags = this.store.getPendingDagExecutions();
      if (dags.length === 0) return;
      console.log(`[${time}] DAG runtime: advancing ${dags.length} running DAG(s)`);
      await this.dagRuntime.advanceAll();
    } catch (err) {
      // Table may not exist on fresh deployments — fail silently.
      this.log.debug("advancePendingDags: skipped (table may not exist)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Drive coordinated merges for multi-repo coordination groups that have
   * reached "ready_to_merge" status (i.e. all sibling PRs are open and
   * cross-referenced).  Merges in dependency order (providers first) and
   * rolls back already-merged PRs if a later one fails review.
   *
   * Called every time `reviewAndMerge` runs so groups are processed promptly
   * after all child tasks complete.
   */
  private async driveCoordinatedMerges(time: string): Promise<void> {
    let groups: Array<{ id: string; parentSourceRef: string | null }>;
    try {
      groups = this.store.getCoordinationGroupsByStatus("ready_to_merge");
    } catch (err) {
      // Table may not exist on older deployments — fail silently
      this.log.debug("getCoordinationGroupsByStatus skipped (table may not exist)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (groups.length === 0) return;

    console.log(`[${time}] Coordinated merges: ${groups.length} group(s) ready to merge`);

    for (const group of groups) {
      try {
        const result = await executeCoordinatedMerge(group.id, this.store, this.config);
        if (result.success) {
          console.log(
            `[${time}] Coordinated merge complete: group ${group.id} — merged ${result.mergedRepos.join(", ")}`,
          );
          this.log.info("Coordinated merge succeeded", {
            groupId: group.id,
            mergedRepos: result.mergedRepos,
            parentSourceRef: group.parentSourceRef,
          });
        } else {
          console.error(
            `[${time}] Coordinated merge failed: group ${group.id} — failed at ${result.failedRepo ?? "unknown"}, ` +
            `merged so far: ${result.mergedRepos.join(", ") || "none"}`,
          );
          this.log.warn("Coordinated merge failed; group rolled back or failed", {
            groupId: group.id,
            failedRepo: result.failedRepo,
            mergedRepos: result.mergedRepos,
          });
        }
      } catch (err) {
        this.log.error("driveCoordinatedMerges: unexpected error for group", {
          groupId: group.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Combined review + merge step for parallel batch 3. Keeps the review→merge
   *  dependency while allowing the combined step to run parallel to supervisor and deploy. */
  private async reviewAndMerge(time: string): Promise<void> {
    await this.reviewPRs(time);
    await this.sweepAndMergeApprovedPRs(time);
    await this.processMergeQueue(time);
    await this.driveCoordinatedMerges(time);
  }

  private async processMergeQueue(time: string): Promise<void> {
    try {
      const queue = this.prReviewer.getMergeQueue();
      if (queue.length === 0) return;
      console.log(`[${time}] Merge queue: ${queue.length} PR(s) pending — processing...`);

      // Track what was in queue before processing
      const prsBefore = queue.map((q) => ({ repo: q.repo, prNumber: q.pr_number }));

      await this.prReviewer.processMergeQueue();

      // Post-merge validation: for each PR that was just merged, run tests
      const queueAfter = this.prReviewer.getMergeQueue();
      const afterNumbers = new Set(queueAfter.map((q) => `${q.repo}#${q.pr_number}`));
      const justMerged = prsBefore.filter((p) => !afterNumbers.has(`${p.repo}#${p.prNumber}`));

      for (const pr of justMerged) {
        // Skip validation if the agent for this repo is currently failing health checks —
        // the container is broken and validation would just timeout with a connection error.
        const agentForRepo = Object.entries(this.config.agents).find(
          ([, a]) => a.github === pr.repo && a.docker?.port,
        );
        if (agentForRepo && this.healthFailingAgents.has(agentForRepo[0])) {
          this.log.info("Post-merge validation skipped: agent health check failing", {
            repo: pr.repo,
            prNumber: pr.prNumber,
            agentName: agentForRepo[0],
          });
          continue;
        }

        try {
          const sha = execSync(
            `gh api repos/${pr.repo}/commits/main --jq .sha`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          const result = await validateMergedPR(this.config, this.store, pr.repo, pr.prNumber, sha);
          if (!result.passed) {
            console.log(`[${time}] ⚠ Post-merge validation FAILED for ${pr.repo}#${pr.prNumber}`);
          }
        } catch (err) {
          this.log.warn("Post-merge validation skipped", {
            repo: pr.repo,
            prNumber: pr.prNumber,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      console.error(`[${time}] Merge queue processing failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Build a structured dispatch rationale for a supervisor decision.
   *
   * Collects system-level metadata (issue state, PR check, agent idle time)
   * and combines it with the LLM-generated reasoning and confidence score
   * to produce a JSON rationale string stored in the decisions table.
   */
  private buildDispatchRationale(
    d: SupervisorDecision,
    validation?: {
      outcome: "passed" | "blocked";
      failureCheck: string | null;
      failureCode: string | null;
      failureReason: string | null;
    } | null,
  ): string {
    const agentName = d.agentName ?? "";
    const agentConfig = this.config.agents[agentName];
    const repo = agentConfig?.github;

    // Collect issue state + PR check from cache (no extra API call — uses data
    // already fetched during the hard-gate phase of this same supervisor cycle)
    let issueState: string | null = null;
    let prCheckResult: string | null = null;

    if (repo) {
      const issueRefs = extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`);
      if (issueRefs.length > 0) {
        const ref = issueRefs[0]; // primary issue
        try {
          const cached = cachedGetIssueState(repo, ref);
          issueState = cached.state;
          prCheckResult = cached.hasMergedPR
            ? "merged PR"
            : cached.hasOpenPR
              ? "open PR"
              : "none";
        } catch {
          // Cache miss or GitHub API error — leave as null
        }
      }
    }

    // Agent idle duration
    const idleMs = this.store.getAgentIdleSinceMs(agentName);

    const rationale: DispatchRationale = {
      llm_reasoning: d.rationale ?? null,
      issue_state_at_dispatch: issueState,
      existing_pr_check_result: prCheckResult,
      agent_idle_duration_ms: idleMs,
      confidence_score: d.confidence ?? null,
      pre_dispatch_validation: validation
        ? {
            outcome: validation.outcome,
            failure_check: validation.failureCheck,
            failure_code: validation.failureCode,
            failure_reason: validation.failureReason,
          }
        : null,
    };

    return JSON.stringify(rationale);
  }

  private extractDecisionIssueRefs(d: SupervisorDecision): string[] {
    const refs = extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`);
    if (refs.length === 0) return [];

    const repo = d.agentName ? this.config.agents[d.agentName]?.github : undefined;
    return [...new Set(refs.map((num) => (repo ? `${repo}#${num}` : `#${num}`)))];
  }

  private async runSupervisor(time: string): Promise<void> {
    try {
      const decisions = await reviewSupervisorState(this.config, this.store, this.reviewerClient);
      if (decisions.length === 0) return;

      console.log(`[${time}] Supervisor: ${decisions.length} decision(s)`);

      // Hard gate (issue #507): block dispatch to already-resolved issues.
      // Uses live (cache-bypassing) GitHub checks at the supervisor decision
      // layer — the authoritative point before any dispatch is committed.
      // This replaces the previous two-layer cached check (issues #444, #446,
      // #458) which could serve stale data within the 60s TTL window.
      const gateResult: GateResult = gateResolvedIssues(this.config, this.store, decisions);

      // Record blocked decisions as "skipped — already resolved"
      let cycleSkipped = 0;
      for (const { decision: bd, skipReason } of gateResult.blocked) {
        const issueRefs = this.extractDecisionIssueRefs(bd);
        this.log.info("Supervisor hard gate: dispatch blocked", {
          agentName: bd.agentName,
          reason: bd.reason,
          skipReason,
        });
        console.log(`  ${bd.action} → ${bd.agentName} SKIPPED (already resolved: ${skipReason}): ${bd.reason}`);
        this.store.addSupervisorDecision({
          action: bd.action,
          agent_name: bd.agentName,
          reason: bd.reason,
          message: bd.message,
          rationale: bd.rationale,
          issue_refs: issueRefs,
          hard_gates: [skipReason],
          outcome: "skipped",
        });
        this.store.incrementStat("supervisor_hard_gate_blocks");
        cycleSkipped++;
      }

      for (const d of gateResult.passed) {
        const issueRefs = this.extractDecisionIssueRefs(d);

        if (d.action === "none") {
          this.store.addSupervisorDecision({
            action: d.action,
            agent_name: d.agentName,
            reason: d.reason,
            message: d.message,
            rationale: d.rationale,
            issue_refs: issueRefs,
            outcome: "none",
          });
          continue;
        }

        if ((d.action === "dispatch" || d.action === "follow-up") && d.agentName && d.message) {
          const agentRepo = this.config.agents[d.agentName]?.github ?? null;
          const issueRefs = agentRepo ? extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`).map(String) : [];
          const derivedSourceRef = agentRepo && issueRefs.length > 0
            ? `${agentRepo}#${issueRefs[0]}`
            : undefined;

          // Build structured rationale (combines LLM reasoning + system metadata)
          const structuredRationale = this.buildDispatchRationale(d, null);

          if (this.store.hasActiveTask(d.agentName)) {
            this.log.info("Skipping supervisor dispatch: agent busy", { agentName: d.agentName, reason: d.reason });
            console.log(`  ${d.action} → ${d.agentName} SKIPPED (agent busy): ${d.reason}`);
            this.store.addSupervisorDecision({
              action: d.action,
              agent_name: d.agentName,
              reason: d.reason,
              message: d.message,
              rationale: structuredRationale,
              issue_refs: issueRefs,
              hard_gates: ["agent busy"],
              outcome: "skipped",
            });
          } else {
            try {
              // Build dispatch message, prepending rationale block when available
              const dispatchMessage = d.rationale
                ? `## Supervisor Rationale\n${d.rationale}\n\n${d.message}`
                : d.message;
              if (d.rationale) {
                this.log.info("Supervisor dispatch with rationale", {
                  agentName: d.agentName,
                  rationale: d.rationale.slice(0, 200),
                });
                console.log(`  rationale: ${d.rationale.slice(0, 120)}`);
              }
              // Fire-and-forget: don't block the daemon cycle waiting for agent response
              this.dispatcher.dispatch(dispatchMessage, {
                agentName: d.agentName,
                source: derivedSourceRef ? "github" : "manual",
                sourceRef: derivedSourceRef,
                title: `[supervisor] ${d.reason.slice(0, 80)}`,
              }).then((result) => {
                const rationaleWithValidation = this.buildDispatchRationale(d, result.validation ?? null);
                if (!result.taskId) {
                  console.log(`  ${d.action} → ${d.agentName} SKIPPED (${result.validation?.failureCode ?? "validation"}): ${d.reason}`);
                  this.store.addSupervisorDecision({
                    action: d.action,
                    agent_name: d.agentName,
                    reason: d.reason,
                    message: d.message,
                    rationale: rationaleWithValidation,
                    outcome: "skipped",
                  });
                  return;
                }
                console.log(`  ${d.action} → ${d.agentName} (task ${result.taskId.slice(0, 8)}): ${d.reason}`);
                this.store.addSupervisorDecision({
                  action: d.action,
                  agent_name: d.agentName,
                  reason: d.reason,
                  message: d.message,
                  rationale: rationaleWithValidation,
                  issue_refs: issueRefs,
                  outcome: "dispatched",
                  task_id: result.taskId,
                });
              }).catch((err) => {
                this.log.error("Supervisor dispatch failed", { agentName: d.agentName, error: String(err) });
                this.store.addSupervisorDecision({
                  action: d.action,
                  agent_name: d.agentName,
                  reason: d.reason,
                  message: d.message,
                  rationale: structuredRationale,
                  issue_refs: issueRefs,
                  outcome: "failed",
                });
              });
            } catch (err) {
              console.error(`  Failed ${d.action} → ${d.agentName}: ${err instanceof Error ? err.message : err}`);
              this.store.addSupervisorDecision({
                action: d.action,
                agent_name: d.agentName,
                reason: d.reason,
                message: d.message,
                rationale: structuredRationale,
                issue_refs: issueRefs,
                outcome: "failed",
              });
            }
          }
        } else {
          // This covers: verify/redeploy/create-issue actions (not yet executed by the daemon),
          // and malformed dispatch/follow-up missing agentName or message.
          // These were never dispatched — record them as "unhandled" so the supervisor's
          // memory accurately reflects that no action was taken.
          this.log.warn("Supervisor decision unhandled", { action: d.action, agentName: d.agentName, reason: d.reason });
          console.log(`  [unhandled] ${d.action}${d.agentName ? ` → ${d.agentName}` : ""}: ${d.reason}`);
          this.store.addSupervisorDecision({
            action: d.action,
            agent_name: d.agentName,
            reason: d.reason,
            message: d.message,
            rationale: d.rationale,
            issue_refs: issueRefs,
            outcome: "unhandled",
          });
        }
      }
      if (cycleSkipped > 0) {
        this.log.info("Supervisor hard gate: blocked resolved-issue dispatches", { cycleSkipped });
        console.log(`[${time}] Supervisor: ${cycleSkipped} decision(s) blocked by hard gate — already resolved`);
      }
    } catch (err) {
      console.error(`[${time}] Supervisor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async triageBacklogs(time: string): Promise<void> {
    const allAgents = Object.entries(this.config.agents).filter(([, a]) => a.github);
    if (allAgents.length === 0) return;

    // Filter to only agents whose housekeeping offset is due this cycle.
    // Each agent fires when: cycleCount % BACKLOG_TRIAGE_EVERY_N_CYCLES === housekeeping_offset_cycles
    // This staggers dispatches across the window so agents don't all fire simultaneously.
    const agents = allAgents.filter(([, agent]) => {
      const offset = (agent.housekeeping_offset_cycles ?? 0) % BACKLOG_TRIAGE_EVERY_N_CYCLES;
      return this.cycleCount % BACKLOG_TRIAGE_EVERY_N_CYCLES === offset;
    });

    if (agents.length === 0) return;

    console.log(`[${time}] Backlog triage: dispatching housekeeping to ${agents.length} of ${allAgents.length} agent(s) (cycle ${this.cycleCount})`);
    this.log.info("Starting backlog triage cycle", { agentCount: agents.length, totalAgents: allAgents.length, cycle: this.cycleCount });

    for (const [agentName, agent] of agents) {
      try {
        if (this.store.hasActiveTask(agentName)) {
          this.log.info("Skipping backlog triage: agent busy", { agentName });
          console.log(`  ${agentName}: skipped (agent busy)`);
          continue;
        }

        const githubRepo = agent.github!;

        // --- Empty-backlog fast-path ---
        // Query open issue and PR counts before dispatching. If both are zero,
        // skip the full housekeeping cycle — there's nothing actionable to do.
        // Fail open: if either count returns null (GitHub unavailable), proceed
        // with dispatch so we don't silently drop work.
        const needsBootstrap = needsRoadmapBootstrap(githubRepo);
        if (!needsBootstrap) {
          const openIssues = countOpenIssues(githubRepo);
          const openPRs = countOpenPRs(githubRepo);
          if (openIssues !== null && openPRs !== null && openIssues === 0 && openPRs === 0) {
            this.log.info("Skipping backlog triage: empty backlog (0 issues, 0 PRs)", { agentName, githubRepo });
            console.log(`  ${agentName}: skipped (empty backlog — 0 open issues, 0 open PRs)`);
            this.store.addSupervisorDecision({
              action: "dispatch",
              agent_name: agentName,
              reason: `[housekeeping] Periodic backlog triage for ${agentName}`,
              rationale: `Skipped housekeeping dispatch: ${githubRepo} has 0 open issues and 0 open PRs. No actionable work found.`,
              hard_gates: ["skipped-empty-backlog"],
              outcome: "skipped",
            });
            continue;
          }
        }
        // --- End empty-backlog fast-path ---

        const message = needsBootstrap
          ? buildRoadmapBootstrapMessage(agentName, githubRepo)
          : buildHousekeepingMessage(agentName, githubRepo);
        const title = needsBootstrap
          ? `[housekeeping] Bootstrap ROADMAP.md for ${agentName}`
          : `[housekeeping] Periodic backlog triage for ${agentName}`;

        if (needsBootstrap) {
          this.log.info("Dispatching ROADMAP.md bootstrap (file not found in repo)", { agentName, githubRepo });
          console.log(`  ${agentName}: ROADMAP.md not found — dispatching bootstrap task`);
        }

        // Fire-and-forget: don't block the daemon waiting for each agent
        this.dispatcher.dispatch(message, {
          agentName,
          source: "manual",
          title,
        }).then((result) => {
          console.log(`  ${agentName}: housekeeping dispatched (task ${result.taskId.slice(0, 8)})`);
          this.log.info("Housekeeping task dispatched", { agentName, taskId: result.taskId });
        }).catch((err) => {
          console.error(`  ${agentName}: housekeeping dispatch failed — ${err instanceof Error ? err.message : err}`);
          this.log.error("Housekeeping dispatch failed", { agentName, error: String(err) });
        });
      } catch (err) {
        console.error(`[${time}] Backlog triage failed for ${agentName}: ${err instanceof Error ? err.message : err}`);
        this.log.error("Backlog triage error", { agentName, error: String(err) });
      }
    }
  }

  private cleanup(event: DaemonLifecycleEvent = "stop"): void {
    stopTelegramPolling();
    if (this.configWatcher) {
      this.configWatcher.stop();
      this.configWatcher = null;
    }
    // Close the metrics HTTP server (issue #976)
    if (this.metricsServer) {
      this.metricsServer.close();
      this.metricsServer = null;
    }
    removePid();

    // Record the stop/crash event before closing the store.
    const durationMs = this.startedAt > 0 ? Date.now() - this.startedAt : undefined;
    try {
      this.store.recordDaemonLifecycleEvent({
        event,
        pid: process.pid,
        reason: event === "stop" ? (this.stopReason ?? "graceful shutdown") : undefined,
        duration_ms: durationMs,
      });
    } catch (err) {
      // Don't let audit recording block shutdown.
      this.log.warn("Failed to record daemon lifecycle event", { event, error: String(err) });
    }

    this.store.close();
    console.log("Daemon stopped.");
  }

  /**
   * Start watching agents.yaml for changes.  On change, validates the new
   * config and applies it to all subsystems that hold a config reference.
   */
  private startConfigWatcher(): void {
    // Resolve the actual path that loadConfig used
    const resolvedPath = this.resolveConfigPath();
    if (!resolvedPath) {
      this.log.warn("Config watcher: could not resolve agents.yaml path — file watching disabled");
      return;
    }

    this.configWatcher = new ConfigWatcher(resolvedPath, this.config, (newConfig, changes) => {
      this.applyConfigChanges(newConfig, changes);
      // Persist the successful file-watcher reload to the audit trail
      this.store.recordConfigReload({
        timestamp: new Date().toISOString(),
        success: true,
        changes: changes.map((c) => c.path),
        errors: [],
        triggeredBy: "file-watcher",
      });
    });
    this.configWatcher.start();
  }

  /**
   * Resolve the config file path (same search order as loadConfig).
   */
  private resolveConfigPath(): string | null {
    if (this.configPath) return this.configPath;

    // Replicate findConfig search order
    const cwd = resolve(process.cwd(), "agents.yaml");
    if (existsSync(cwd)) return cwd;

    const home = resolve(process.env.HOME ?? "~", ".claude-orchestrator", "agents.yaml");
    if (existsSync(home)) return home;

    return null;
  }

  /**
   * Apply a validated config to all subsystems.  Called by the ConfigWatcher
   * when agents.yaml changes, or by SIGUSR1 handler.
   */
  private applyConfigChanges(newConfig: OrchestratorConfig, changes: ConfigChange[]): void {
    const changedPaths = changes.map((c) => c.path);
    this.log.info("Applying config changes", { paths: changedPaths });

    // Update the master config reference
    this.config = newConfig;

    // Rebuild subsystems that hold their own config reference
    this.dispatcher = new Dispatcher(this.config, this.store);
    this.reviewerClient = new ReviewerClient(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.researchLinker = new ResearchLinker(this.config, this.store, this.issueCreator);
    this.deployer = new Deployer(this.config);
    this.prReviewer = new PRReviewer(this.config, this.store, this.reviewerClient);

    // Log each change for operator visibility
    for (const change of changes) {
      const oldStr = change.oldValue === undefined ? "(unset)" : JSON.stringify(change.oldValue);
      const newStr = change.newValue === undefined ? "(removed)" : JSON.stringify(change.newValue);
      this.log.info(`Config changed: ${change.path}`, { old: oldStr, new: newStr });
      console.log(`[config] ${change.path}: ${oldStr} → ${newStr}`);
    }

    // Notify operator via Telegram about the reload
    notifyOperator(
      `Config reloaded: ${changes.length} change(s) applied`,
      `Changed: ${changedPaths.join(", ")}`,
    ).catch(() => { /* best-effort */ });
  }

  /**
   * Persist a reload result to the config_reloads audit table.
   * Centralises the mapping from ReloadResult → store params.
   */
  private recordConfigReload(
    result: { success: boolean; changes: ConfigChange[]; errors: Array<{ path: string; message: string }>; timestamp: string },
    triggeredBy: ConfigReloadTrigger,
  ): void {
    try {
      this.store.recordConfigReload({
        timestamp: result.timestamp,
        success: result.success,
        changes: result.changes.map((c) => c.path),
        errors: result.errors.map((e) => `${e.path}: ${e.message}`),
        triggeredBy,
      });
    } catch (err) {
      this.log.warn("Failed to persist config reload to audit trail", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Startup drift detection: checks whether agents.yaml has been modified
   * since the last recorded config reload.  If so, warns the operator that
   * the running config may not reflect the file on disk.
   *
   * Called once during daemon startup, after the config watcher is initialised.
   */
  private checkConfigDrift(): void {
    const resolvedPath = this.resolveConfigPath();
    if (!resolvedPath) return;

    let fileMtimeMs: number;
    try {
      fileMtimeMs = statSync(resolvedPath).mtimeMs;
    } catch {
      // File not found or unreadable — skip drift check
      return;
    }

    const lastReload = this.store.getLastSuccessfulConfigReload();
    if (!lastReload) return; // No prior reload recorded — nothing to compare against

    const lastReloadMs = new Date(lastReload.timestamp).getTime();
    if (fileMtimeMs <= lastReloadMs) return; // File unchanged since last reload — no drift

    const driftSeconds = Math.round((fileMtimeMs - lastReloadMs) / 1000);
    const msg =
      `agents.yaml was modified ${driftSeconds}s after the last config reload ` +
      `(${lastReload.triggered_by} at ${lastReload.timestamp}). ` +
      `The running config may not reflect the current file. Run \`orch config reload\` to apply.`;

    this.log.warn("Config drift detected at startup", { driftSeconds, lastReloadAt: lastReload.timestamp });
    console.warn(`[config] ⚠️  ${msg}`);

    notifyOperator("Config drift detected", msg, "warning", "config-drift").catch(() => {});
  }

  private async pauseDisciplineDriftTasks(time: string): Promise<void> {
    const orchestratorDir = this.config.orchestrator_dir;
    if (!orchestratorDir) return;

    const snapshot = captureDisciplineContext(orchestratorDir);
    const activeStatuses = ["pending", "planning", "dispatched", "in_progress"] as const;

    for (const status of activeStatuses) {
      const tasks = this.store.getTasksByStatus(status);
      for (const task of tasks) {
        if (task.parent_task_id) continue;
        const priorSnapshot = readTaskDisciplineSnapshot(this.store, task.id);
        if (!priorSnapshot) continue;
        const alignment = assessTaskDisciplineAlignment(task, snapshot, priorSnapshot);
        if (alignment.aligned || !alignment.requires_rescope) continue;

        this.store.pauseTask(task.id);
        this.store.addLog({
          task_id: task.id,
          direction: "system",
          content:
            `Discipline drift detected at ${time}: ${alignment.reason ?? "task conflicts with current discipline"}; task paused for redispatch.`,
        });
        this.log.warn("Paused task due to discipline drift", {
          taskId: task.id,
          status: task.status,
          staleSnapshot: alignment.stale_snapshot,
          matchedPatterns: alignment.matched_patterns,
        });
      }
    }
  }

  private cleanupStaleIssues(time: string): void {
    // Collect all merged PR bodies across repos for cross-repo closure
    const allMergedPRBodies: Array<{ prRepo: string; prNumber: number; body: string }> = [];

    for (const [_agentName, agent] of Object.entries(this.config.agents)) {
      if (!agent.github) continue;

      try {
        // Get open issues
        const issuesRaw = execSync(
          `gh issue list --repo ${agent.github} --state open --json number,title -L 50`,
          { encoding: "utf-8", timeout: 15000 },
        ).trim();
        if (!issuesRaw) continue;
        const issues = JSON.parse(issuesRaw) as Array<{ number: number; title: string }>;
        if (issues.length === 0) continue;

        // Get recently merged PRs with bodies for Closes #N scanning
        const prsRaw = execSync(
          `gh pr list --repo ${agent.github} --state merged --json number,title,body -L 30`,
          { encoding: "utf-8", timeout: 15000 },
        ).trim();
        const mergedPRs = prsRaw
          ? (JSON.parse(prsRaw) as Array<{ number: number; title: string; body: string }>)
          : [];

        // Collect PR bodies for cross-repo scanning later
        for (const pr of mergedPRs) {
          if (pr.body) {
            allMergedPRBodies.push({ prRepo: agent.github, prNumber: pr.number, body: pr.body });
          }
        }

        // Phase 1: Body scan — extract issue numbers referenced in merged PR bodies
        const closedByBody = new Set<number>();
        for (const pr of mergedPRs) {
          for (const num of extractClosedIssueNumbers(pr.body ?? "")) {
            closedByBody.add(num);
          }
        }

        const closedIssues = new Set<number>();

        for (const issue of issues) {
          // Phase 1: close if referenced in a merged PR body
          if (closedByBody.has(issue.number)) {
            if (this.closeIssue(agent.github, issue, time, "Auto-closed: referenced in merged PR.")) {
              closedIssues.add(issue.number);
            }
            continue;
          }

          // Phase 2: fallback title matching
          const issueWords = issue.title.toLowerCase().replace(/\[.*?\]/g, "").trim();
          const mergedTitles = mergedPRs.map((pr) => pr.title.toLowerCase());
          const matched = mergedTitles.some((prTitle) => {
            const prWords = prTitle.replace(/\[.*?\]/g, "").trim();
            return prWords.includes(issueWords.slice(0, 30)) || issueWords.includes(prWords.slice(0, 30));
          });

          if (matched) {
            this.closeIssue(agent.github, issue, time, "Auto-closed: matching PR title found.");
          }
        }
      } catch {
        // Skip repos we can't access
      }
    }

    // Cross-repo closure: scan all merged PR bodies for references to issues in other repos
    // e.g., a claude-proxy PR containing "Closes rapartlu/agent-orchestrator#424"
    this.closeCrossRepoIssues(time, allMergedPRBodies);
  }

  /**
   * Scan merged PR bodies for cross-repo issue references (e.g. "Closes owner/repo#123")
   * and explicitly close those issues via the GitHub API.
   *
   * GitHub only auto-closes issues in the same repo as the PR. When agents open PRs
   * in one repo that reference issues in another (common in our multi-repo architecture),
   * those issues remain open. This method bridges that gap.
   */
  private closeCrossRepoIssues(
    time: string,
    mergedPRBodies: Array<{ prRepo: string; prNumber: number; body: string }>,
  ): void {
    for (const { prRepo, prNumber, body } of mergedPRBodies) {
      const crossRefs = extractCrossRepoIssueRefs(body);
      for (const ref of crossRefs) {
        const targetRepo = `${ref.owner}/${ref.repo}`;
        // Skip same-repo refs — GitHub handles those natively
        if (targetRepo === prRepo) continue;

        try {
          // Check if the issue is still open before trying to close it
          const stateRaw = execSync(
            `gh issue view ${ref.number} --repo ${targetRepo} --json state -q .state`,
            { encoding: "utf-8", timeout: 10000 },
          ).trim();
          if (stateRaw !== "OPEN") continue;

          const comment = `Auto-closed by orchestrator: referenced in merged PR ${prRepo}#${prNumber}.`;
          execSync(
            `gh issue close ${ref.number} --repo ${targetRepo} --comment "${comment}"`,
            { encoding: "utf-8", timeout: 10000 },
          );
          console.log(`[${time}] Cross-repo close: ${targetRepo}#${ref.number} (from ${prRepo}#${prNumber})`);
          this.log.info("Cross-repo issue closed", {
            targetRepo,
            issueNumber: ref.number,
            sourcePR: `${prRepo}#${prNumber}`,
          });
        } catch {
          // Best effort — target repo may not be accessible
        }
      }
    }
  }

  private reapStaleOrchestratorIssues(time: string): void {
    const cutoff = Date.now() - STALE_ISSUE_AGE_DAYS * 24 * 60 * 60 * 1000;

    for (const [_agentName, agent] of Object.entries(this.config.agents)) {
      if (!agent.github) continue;

      try {
        // Get open issues with orchestrator label
        const issuesRaw = execSync(
          `gh issue list --repo ${agent.github} --state open --label orchestrator --json number,title,createdAt -L 50`,
          { encoding: "utf-8", timeout: 15000 },
        ).trim();
        if (!issuesRaw) continue;
        const issues = JSON.parse(issuesRaw) as Array<{ number: number; title: string; createdAt: string }>;

        const staleIssues = issues.filter((i) => new Date(i.createdAt).getTime() < cutoff);
        if (staleIssues.length === 0) continue;

        // Get open PRs to check for linked work
        const prsRaw = execSync(
          `gh pr list --repo ${agent.github} --state open --json number,body,headRefName -L 50`,
          { encoding: "utf-8", timeout: 15000 },
        ).trim();
        const openPRs = prsRaw
          ? (JSON.parse(prsRaw) as Array<{ number: number; body: string; headRefName: string }>)
          : [];

        for (const issue of staleIssues) {
          const hasLinkedPR = openPRs.some((pr) => {
            const bodyRefs = extractClosedIssueNumbers(pr.body ?? "");
            const branchHasIssue = pr.headRefName.includes(`${issue.number}`);
            return bodyRefs.includes(issue.number) || branchHasIssue;
          });

          if (!hasLinkedPR) {
            this.closeIssue(agent.github, issue, time, "Auto-closed: open >7 days with no linked PR.");
          }
        }
      } catch {
        // Skip repos we can't access
      }
    }
  }

  private closeIssue(repo: string, issue: { number: number; title: string }, time: string, comment: string): boolean {
    try {
      execSync(
        `gh issue close ${issue.number} --repo ${repo} --comment "${comment}"`,
        { encoding: "utf-8", timeout: 10000 },
      );
      console.log(`[${time}] Closed stale issue ${repo}#${issue.number}: ${issue.title.slice(0, 60)}`);
      this.log.info("Closed stale issue", { repo, issue: issue.number, title: issue.title, reason: comment });
      return true;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (!this.running) {
          clearTimeout(timer);
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }
}

/**
 * Compute the retry state update for a task that timed out (exit code 143 / SIGTERM).
 *
 * Encapsulates the timeout-specific retry policy so both `checkStaleTasks` and
 * unit tests can share the same logic without re-implementing it.
 *
 * @param currentRetryCount - the task's current `retry_count` before this failure
 * @param nowMs - current timestamp in ms (defaults to `Date.now()`, injectable for tests)
 * @returns update fields to apply to the task record
 */
export function computeTimeoutRetry(
  currentRetryCount: number,
  nowMs: number = Date.now(),
): { retry_count: number; next_retry_at: string | null } {
  const newRetryCount = currentRetryCount + 1;
  const willRetry = currentRetryCount < TIMEOUT_RETRY_MAX;
  return {
    retry_count: newRetryCount,
    next_retry_at: willRetry
      ? new Date(nowMs + TIMEOUT_RETRY_BACKOFF_MS).toISOString()
      : null,
  };
}

/**
 * Decide whether a task with the given source should be verified in this cycle.
 *
 * Rules (in order):
 * 1. No filter configured (absent or empty) → verify everything.
 * 2. Source is "manual" → always verify; supervisor/PR-feedback dispatches must
 *    never be silently excluded or the quality loop breaks.
 * 3. Source is in the allowlist → verify.
 * 4. Otherwise → skip.
 */
export function shouldVerifyTask(taskSource: string, sourcesFilter?: string[]): boolean {
  if (!sourcesFilter || sourcesFilter.length === 0) return true;
  // "manual" and "pr-feedback" tasks are always verified so the quality loop
  // never silently excludes supervisor dispatches or PR change-request feedback.
  if (taskSource === "manual" || taskSource === "pr-feedback") return true;
  return sourcesFilter.includes(taskSource);
}

/**
 * Build the housekeeping message dispatched to an agent during periodic backlog triage.
 *
 * Exported for unit testing. Agents receive this every ~5 hours to keep their
 * repos clean: closing duplicates, triaging stale issues, and maintaining ROADMAP.md.
 */
export function buildHousekeepingMessage(agentName: string, githubRepo: string): string {
  return `Time for your periodic backlog triage. Please do the following for your repo (${githubRepo}):

1. **Close duplicate issues** — scan open issues for duplicates. Keep the newer/more detailed one, close the other with a comment like "Duplicate of #N — closing in favour of the more detailed issue."

2. **Close stale issues** — close any issues open >14 days with no linked PR and no recent comments. Add a comment explaining why (e.g. "Closing as stale — no activity in 14+ days. Reopen if this is still relevant.").

3. **Maintain ROADMAP.md** — update (or create) ROADMAP.md in your repo root with your top 5 priorities sorted by user impact. Reflect any work completed since the last update.

4. **Check for orphan PRs** — ensure every open PR has an issue linked via "Closes #N". If a PR is missing one, either create the issue or add the reference to the PR body.

5. **Update documentation** — review CLAUDE.md and ensure it accurately reflects the current state of your repo. Update architecture, commands, APIs, and scope sections. If anything is outdated, fix it and include the changes in your triage PR.

Be concise and systematic. Use \`gh issue list --repo ${githubRepo} --state open -L 50\` to get a full picture before acting. After completing the triage, briefly summarise what you closed or updated.`;
}

/**
 * Check whether ROADMAP.md exists in the root of the given GitHub repo.
 *
 * Uses the GitHub API via `gh api` — returns false on any error (network,
 * auth, repo not found) so the caller can safely fall back to the normal
 * housekeeping path rather than bootstrapping unnecessarily.
 *
 * The optional `execFn` parameter allows unit tests to inject a fake executor
 * without patching ESM module globals (which Vitest does not support).
 */
export function needsRoadmapBootstrap(
  githubRepo: string,
  execFn: (cmd: string, opts: object) => unknown = execSync,
): boolean {
  try {
    execFn(`gh api repos/${githubRepo}/contents/ROADMAP.md --silent`, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // Exit 0 → file exists → no bootstrap needed
    return false;
  } catch {
    // Non-zero exit (404) → file absent → bootstrap needed
    return true;
  }
}

/**
 * Build the one-time bootstrap message dispatched to an agent that does not
 * yet have a ROADMAP.md in their repo.
 *
 * Unlike the periodic triage message, this asks the agent to perform a
 * deep analysis of their issue backlog and recent work before writing an
 * initial roadmap file, then commit and PR it.
 *
 * Exported for unit testing.
 */
export function buildRoadmapBootstrapMessage(agentName: string, githubRepo: string): string {
  return `Your repo (${githubRepo}) does not yet have a ROADMAP.md file. Please create one now by following these steps:

1. **Survey your open issues** — run \`gh issue list --repo ${githubRepo} --state open -L 50\` to get a full picture of outstanding work.

2. **Review recent closed work** — run \`gh pr list --repo ${githubRepo} --state merged -L 20\` to understand what has already shipped.

3. **Identify top 5 priorities** — based on what you found, select the 5 highest-impact items that are not yet done. Sort them by user impact (most impactful first).

4. **Write ROADMAP.md** — create a ROADMAP.md in the repo root with:
   - A short intro sentence describing the project
   - A numbered list of the top 5 priorities, each with: title, 1-2 sentence description, and the linked issue number(s) if applicable
   - A "Recently shipped" section listing up to 3 things that just landed

5. **Commit and open a PR** — commit the file on a new branch (e.g. \`bootstrap-roadmap\`) and open a PR. Include "Closes #" only if there is an open issue tracking this work; otherwise omit it.

Be concise — the roadmap should fit on one screen. After you open the PR, briefly summarise what you added.`;
}

/**
 * Check whether a PR has already been merged or closed so we don't dispatch
 * feedback for work that no longer needs to be done.
 *
 * Fails open (returns `false`) on any exec error so that valid in-flight PRs
 * are never silently dropped.
 *
 * @param execFn - optional override for unit tests (avoids ESM module patching)
 */
export function isPRAlreadyMerged(
  repo: string,
  prNumber: number,
  execFn: (cmd: string) => string = (cmd) => execSync(cmd, { encoding: "utf8" }),
): boolean {
  try {
    const raw = execFn(`gh pr view ${prNumber} --repo ${repo} --json state`);
    const parsed = JSON.parse(raw) as { state?: string };
    const state = (parsed.state ?? "").trim().toUpperCase();
    return state === "MERGED" || state === "CLOSED";
  } catch {
    // Fail open: if we can't determine state, allow the dispatch
    return false;
  }
}

/** Returns true when a PR body already contains a Closes/Fixes/Resolves #N reference. */
export function prBodyHasIssueRef(prBody: string): boolean {
  return /(?:closes|fixes|resolves)\s+#\d+/i.test(prBody);
}

/** Extract issue numbers from PR body patterns like "Closes #42", "Fixes #7", "Resolves #100" */
export function extractClosedIssueNumbers(prBody: string): number[] {
  const pattern = /(?:closes|fixes|resolves)\s+#(\d+)/gi;
  const numbers = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prBody)) !== null) {
    numbers.add(parseInt(match[1], 10));
  }
  return [...numbers];
}

/**
 * Extract cross-repo issue references from a PR body.
 *
 * Matches patterns like:
 *   - "Closes rapartlu/agent-orchestrator#424"
 *   - "Fixes owner/repo#123"
 *   - "Resolves owner/repo#42"
 *
 * Returns an array of { owner, repo, number } objects (deduplicated).
 */
export function extractCrossRepoIssueRefs(prBody: string): Array<{ owner: string; repo: string; number: number }> {
  const pattern = /(?:closes|fixes|resolves)\s+([\w.-]+)\/([\w.-]+)#(\d+)/gi;
  const seen = new Set<string>();
  const refs: Array<{ owner: string; repo: string; number: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prBody)) !== null) {
    const owner = match[1];
    const repo = match[2];
    const num = parseInt(match[3], 10);
    const key = `${owner}/${repo}#${num}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push({ owner, repo, number: num });
    }
  }
  return refs;
}

/**
 * Extract the checklist text from a PR feedback dispatch description.
 *
 * Handles two formats:
 *   1. Simple (first round): "...before pushing:\n\n{CHECKLIST}\n\nCheck off each item..."
 *   2. Consolidated (multi-round): "...**Latest review (round N):**\n{CHECKLIST}\n\n**Prior..."
 *
 * Returns null when the description is absent or extraction fails.
 * Exported for unit testing.
 */
export function extractChecklistText(description: string | null | undefined): string | null {
  if (!description) return null;

  // Simple single-round format
  const simpleMatch = description.match(/before pushing:\s*\n\n([\s\S]+?)\n\nCheck off each item/);
  if (simpleMatch) return simpleMatch[1].trim();

  // Consolidated multi-round format — grab the "Latest review" section
  const consolidatedMatch = description.match(/\*\*Latest review.*?\*\*\n([\s\S]+?)\n\n\*\*Prior feedback/);
  if (consolidatedMatch) return consolidatedMatch[1].trim();

  // Fallback: return the first 600 chars so the agent has some context
  return description.slice(0, 600).trim();
}

/**
 * Parse file paths mentioned in a PR reviewer checklist.
 *
 * Looks for common source file patterns (e.g. `src/foo.ts`, `lib/bar.js`)
 * in the checklist text. Used to narrow down which diff hunks to include
 * in the structured feedback context sent to the agent.
 *
 * Exported for unit testing.
 */
export function extractFlaggedFilesFromChecklist(comment: string): string[] {
  // Match file paths: either starting with a known directory prefix or ending with
  // a recognized source extension.  Anchored to word boundaries so we don't match
  // partial words (e.g. "namespace" isn't a path).
  const filePattern =
    /(?:^|[\s("`'])(((?:src|lib|test|tests|spec|dist|config|scripts|\.github)\/[\w./\-]+\.\w+|[\w./\-]+\.(?:ts|js|tsx|jsx|py|go|rs|java|rb|md|yaml|yml|json|sh|toml|env)))/gm;
  const files = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(comment)) !== null) {
    files.add(match[1]);
  }
  return [...files];
}

/**
 * Extract relevant diff hunks for flagged files from a full PR diff.
 *
 * Splits the diff into per-file sections and keeps only sections that touch
 * one of the flagged file paths.  The result is truncated to `maxLength`
 * characters to avoid overwhelming the agent context window.
 *
 * Returns an empty string when no flagged files are found in the diff or
 * when the diff itself is empty.
 *
 * Exported for unit testing.
 */
export function buildDiffContextForFeedback(
  diff: string,
  flaggedFiles: string[],
  maxLength = 3000,
): string {
  if (!diff || flaggedFiles.length === 0) return "";

  // Diff sections start with "diff --git a/... b/..."
  const sections = diff.split(/(?=^diff --git )/m);
  const relevantSections: string[] = [];

  for (const section of sections) {
    if (flaggedFiles.some((f) => section.includes(f))) {
      relevantSections.push(section.trimEnd());
    }
  }

  if (relevantSections.length === 0) return "";

  const combined = relevantSections.join("\n");
  if (combined.length <= maxLength) return combined;
  return combined.slice(0, maxLength) + "\n... (diff truncated — see full PR diff for remaining context)";
}

/**
 * Convert numbered or bullet checklist items into an explicit `- [ ]` audit checklist.
 *
 * Handles both numbered markdown lists (`1. item`, `2) item`) and bullet lists
 * (`- item`, `* item`).  Existing unchecked task-list boxes (`- [ ] item`) are
 * preserved as-is.  Items are rewritten as unchecked GitHub task-list boxes so
 * the agent has a machine-readable form to confirm before pushing.
 *
 * Returns an empty string when no list items are detected.
 *
 * Exported for unit testing.
 */
export function buildAuditChecklist(feedbackComment: string): string {
  // Match numbered items (1. or 1)), bullet items (- or *), and existing task boxes (- [ ])
  const itemPattern = /^(?:(\d+[\.\)])|(-\s*\[[ x]\])|([*\-]))\s+(.+)/gm;
  const items: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(feedbackComment)) !== null) {
    const [, numbered, taskBox, bullet, text] = match;
    if (taskBox) {
      // Already a task-list box — normalise to unchecked
      items.push(`- [ ] ${text.trim()}`);
    } else if (numbered || bullet) {
      items.push(`- [ ] ${text.trim()}`);
    }
  }
  return items.join("\n");
}

/**
 * Build the mandatory pre-declaration review checklist appended to every
 * PR feedback dispatch message.  This ensures agents perform a substantive
 * code review (read the diff, check logic, verify tests) rather than
 * running a build and declaring the PR clean.
 *
 * Exported for unit testing.
 */
export function buildFeedbackPreDeclarationChecklist(prNumber: number): string {
  return (
    `\n**Mandatory pre-push checklist — complete ALL items before pushing or declaring done:**\n` +
    `- [ ] 1. **Read the full diff** — run \`gh pr diff ${prNumber}\` and review every changed file ` +
    `line by line. A passing build alone is NOT sufficient.\n` +
    `- [ ] 2. **Check for logic bugs** — look for off-by-one errors, incorrect boundary conditions ` +
    `(e.g. Math.min vs Math.max), null/undefined edge cases, and wrong operator usage.\n` +
    `- [ ] 3. **Verify test coverage** — confirm tests exist for new/changed code paths. Add tests ` +
    `if missing.\n` +
    `- [ ] 4. **Confirm the PR body** includes a \`Closes #<issue>\` reference.\n` +
    `- [ ] 5. **Summarise your review** — write what you checked and why the code is correct. ` +
    `A response that only says "looks good" or "build passes" will be rejected.\n` +
    `⚠️ Skipping any item will cause your task to fail verification.`
  );
}

/**
 * Build a consolidated feedback dispatch message for a PR.
 *
 * When `priorFeedbackDescriptions` is empty (first feedback round) the
 * returned message uses the original single-round format so existing
 * behaviour is unchanged.
 *
 * When prior rounds exist, all outstanding feedback is merged into one
 * message so the agent can address everything in a single push, reducing
 * sequential revision cycles.
 *
 * When `options.prDiff` is provided the message also includes:
 *   1. A structured diff excerpt for the files flagged in the reviewer comment
 *   2. An explicit `- [ ]` audit checklist derived from the numbered items so
 *      the agent can confirm each point before pushing
 *
 * Every message (single-round and multi-round) now includes the mandatory
 * pre-push review checklist so agents cannot skip substantive code review.
 *
 * Exported for unit testing.
 */
export function buildConsolidatedFeedbackMessage(
  repo: string,
  prNumber: number,
  currentFeedback: string,
  priorFeedbackDescriptions: Array<string | null>,
  options?: { prDiff?: string },
): string {
  const prDiff = options?.prDiff ?? "";

  // Build structured diff context for flagged files (may be empty)
  const flaggedFiles = extractFlaggedFilesFromChecklist(currentFeedback);
  const diffContext = prDiff ? buildDiffContextForFeedback(prDiff, flaggedFiles) : "";

  // Build explicit audit checklist (may be empty when no numbered items)
  const auditChecklist = buildAuditChecklist(currentFeedback);

  // Mandatory pre-declaration checklist — always appended
  const preDeclaration = buildFeedbackPreDeclarationChecklist(prNumber);

  if (priorFeedbackDescriptions.length === 0) {
    // First round — structured feedback context is appended after the checklist
    const parts: string[] = [
      `Your PR #${prNumber} on ${repo} was reviewed and needs changes. ` +
        `Work through every item in the checklist below before pushing:\n\n` +
        `${currentFeedback}`,
    ];

    if (diffContext) {
      parts.push(
        `\n**Relevant diff sections for flagged items:**\n\`\`\`diff\n${diffContext}\n\`\`\``,
      );
    }

    if (auditChecklist) {
      parts.push(`\n**Before pushing, confirm each item is addressed:**\n${auditChecklist}`);
    }

    parts.push(preDeclaration);

    parts.push(
      `\nCheck off each item, commit, and push to the same branch. ` +
        `Do not push until all checklist items are addressed.`,
    );

    return parts.join("\n");
  }

  // Multi-round consolidated format
  const roundNum = priorFeedbackDescriptions.length + 1;

  const priorSections = priorFeedbackDescriptions
    .map((desc, idx) => {
      const checklist = extractChecklistText(desc);
      const fallback = "(checklist unavailable — check the PR comments for details)";
      return `**Round ${idx + 1} feedback (verify these items are fixed):**\n${checklist ?? fallback}`;
    })
    .join("\n\n");

  const parts: string[] = [
    `Your PR #${prNumber} on ${repo} has received ${roundNum} rounds of review feedback.`,
    `Address ALL outstanding items below in a single push — do not push until everything is fixed.\n`,
    `**Latest review (round ${roundNum}):**`,
    currentFeedback,
  ];

  if (diffContext) {
    parts.push(
      `\n**Relevant diff sections for flagged items:**\n\`\`\`diff\n${diffContext}\n\`\`\``,
    );
  }

  if (auditChecklist) {
    parts.push(`\n**Before pushing, confirm each item is addressed:**\n${auditChecklist}`);
  }

  parts.push(
    `\n**Prior feedback rounds — confirm these are also resolved:**`,
    priorSections,
    preDeclaration,
    `\nFix every unchecked item above, commit, and push to the same branch.`,
  );

  return parts.join("\n");
}

/**
 * Given a PR body and repo slug, look up the conversation_id of the original
 * task that produced the PR (via the `Closes #N` linked issue reference).
 *
 * Returns `undefined` when:
 * - The PR body contains no issue references
 * - No matching task was found in the store
 * - The matched task has no conversation_id
 *
 * Exported for unit testing.
 */
export function resolveConversationIdForPR(
  store: StateStore,
  repo: string,
  prBody: string,
): string | undefined {
  const linkedIssueNumbers = extractClosedIssueNumbers(prBody);
  if (linkedIssueNumbers.length === 0) return undefined;
  const originalTask = store.findTaskBySourceRef("github", `${repo}#${linkedIssueNumbers[0]}`);
  return originalTask?.conversation_id ?? undefined;
}
