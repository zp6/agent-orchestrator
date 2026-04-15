import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { validateConfig } from "../config/validator.js";
import { ConfigWatcher, type ConfigChange } from "../config/watcher.js";
import { StateStore, type DispatchRationale, type ConfigReloadTrigger, type DaemonLifecycleEvent } from "../state/store.js";
import { setLLMUsageRecorder } from "../client/llm-client.js";
import { ReviewerClient, type SupervisorDecision } from "../client/reviewer-client.js";
import { Dispatcher, MAX_RETRIES, TIMEOUT_RETRY_MAX, TIMEOUT_RETRY_BACKOFF_MS, extractRepoFromSourceRef } from "../orchestrator/dispatcher.js";
import { ResearchLinker } from "../orchestrator/research-linker.js";
import { IssueCreator } from "../orchestrator/issue-creator.js";
import { Deployer } from "../orchestrator/deployer.js";
import { PRReviewer } from "../orchestrator/pr-reviewer.js";
import { findOrphanBranches, createPRForBranch, deleteStaleOrphanBranches, STALE_BRANCH_BEHIND_THRESHOLD } from "../orchestrator/pr-creator.js";
import { PRCreationRetryQueue } from "../orchestrator/pr-creation-retry-queue.js";
import { validateGhAuth } from "../triggers/github.js";
import { cachedIsIssueOpen, cachedGetIssueState, logCacheMetrics, initIssueCachePersistence } from "../triggers/issue-state-bridge.js";
import {
  dispatchGitHubIssues,
  dispatchIdleAgentBacklog,
  dispatchLinearChecks,
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
import { startTelegramPolling, stopTelegramPolling, pollTelegram } from "./telegram.js";
import { maybePostDailyDigest, type DigestSchedulerState } from "./slack-digest.js";
import { maybeRunDailySecurityScan, type SecurityScanState } from "../orchestrator/security-scanner.js";
import { runTeamMeeting } from "../orchestrator/team-meeting.js";
import { StandupActionClient } from "../orchestrator/standup-action-client.js";
import { seedFromClaudeMd } from "../orchestrator/learned-rules.js";
import { checkAgedIssues } from "../orchestrator/issue-age-monitor.js";
import { runProactiveScan } from "../orchestrator/proactive-scanner.js";
import { validateMergedPR } from "../orchestrator/staging-validator.js";
import { proposeAndFileRoadmapItems } from "../orchestrator/roadmap-proposer.js";
import { detectHighIterationAgents } from "../orchestrator/iteration-cost-detector.js";
import { detectHealthIncidentIssues } from "../orchestrator/health-incident-detector.js";
import { runIterationBudgetAlerts } from "../orchestrator/iteration-budget-alert.js";
import { runSkipPatternCheck } from "../orchestrator/skip-pattern-aggregator.js";
import { learnPatterns } from "../orchestrator/pattern-learner.js";
import { buildConflictRedispatchMessage } from "../orchestrator/conflict-redispatch.js";
import {
  type GateResult,
  detectImprovements,
  extractIssueRefs,
  gateResolvedIssues,
  reviewSupervisorState,
  verifyAndReviseTask,
} from "./reviewer-ops.js";
import { executeCoordinatedMerge } from "../orchestrator/multi-repo-coordinator.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const QUALITY_SLA_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const IMPROVEMENT_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const AUTO_MERGE_SWEEP_EVERY_N_CYCLES = 3;  // ~15min — same cadence as PR review
const SUPERVISOR_CHECK_EVERY_N_CYCLES = 3; // ~15min at default interval
const RESEARCH_LINK_EVERY_N_CYCLES = 6; // ~30min — same cadence as improvement detection
const BACKLOG_TRIAGE_EVERY_N_CYCLES = 60; // ~5h at default interval
const CONTAINER_RESTART_EVERY_N_CYCLES = 100; // ~50min at 30s interval — prevents Docker stalls
const AGENT_SYNC_EVERY_N_CYCLES = 10; // ~5min at default interval — recover from proxy restarts
const SELF_UPDATE_EVERY_N_CYCLES = 10; // ~5min — pull + rebuild if behind origin/main, then re-exec
const CLOSED_ISSUE_CHECK_EVERY_N_CYCLES = 3; // ~15min at default — cancel in-flight tasks for closed issues
const STALE_ISSUE_AGE_DAYS = 7;
const STANDUP_MEETING_EVERY_N_CYCLES = 288;  // ~24h at 5min interval
const BLUESKY_MEETING_EVERY_N_CYCLES = 2016; // ~7 days at 5min interval
const ROADMAP_PROPOSAL_EVERY_N_CYCLES = 288; // ~24h at 5min interval
const SKIP_PATTERN_CHECK_EVERY_N_CYCLES = 288; // ~24h at 5min interval
const PROXY_HEALTH_CHECK_EVERY_N_CYCLES = 3;   // ~15min — check proxy server is reachable
const CLOSED_ISSUE_FAILURE_CLEANUP_EVERY_N_CYCLES = 60; // ~5h — clear stale failures for closed issues

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
  private securityScanState: SecurityScanState = { lastScanDate: null };

  /** Resolved path to agents.yaml — stored for hot-reload. */
  private configPath: string | undefined;
  /** Watches agents.yaml for changes and triggers hot-reload. */
  private configWatcher: ConfigWatcher | null = null;

  /** Wall-clock timestamp (ms) when the daemon was last started — used to compute uptime. */
  private startedAt = 0;

  /** Reason the daemon is stopping — populated before cleanup() so crash handlers can read it. */
  private stopReason: string | undefined = undefined;

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

    // Wire up SQLite persistence for the issue-state cache (issue #590).
    // This ensures every fresh GitHub fetch is also written to the
    // issue_state_cache table so the dashboard can filter closed issues
    // out of the stuck-issues panel.
    initIssueCachePersistence(this.store);

    // Apply config overrides to modules that use module-level state
    setRecencyWindowHours(this.config.triggers?.recency_window_hours);
    setTelegramRateLimitMs(this.config.notifications?.telegram_rate_limit_ms);
    this.dispatcher = new Dispatcher(this.config, this.store);

    this.reviewerClient = new ReviewerClient(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.researchLinker = new ResearchLinker(this.config, this.store, this.issueCreator);
    this.deployer = new Deployer(this.config);
    this.prReviewer = new PRReviewer(this.config, this.store, this.reviewerClient);
    this.prRetryQueue = new PRCreationRetryQueue(this.store);
    this.pollInterval = pollIntervalMs ?? this.config.daemon?.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    this.startedAt = Date.now();
    writePid();

    // Record daemon start in the lifecycle audit trail.
    try {
      this.store.recordDaemonLifecycleEvent({ event: "start", pid: process.pid });
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

    // Seed learned rules from CLAUDE.md files (idempotent — skips existing rules)
    try {
      const { seeded, repos } = await seedFromClaudeMd(this.config, this.store);
      if (seeded > 0) console.log(`Seeded ${seeded} learned rules from ${repos.length} repo(s)`);
    } catch (err) {
      this.log.warn("Failed to seed learned rules from CLAUDE.md", { error: err instanceof Error ? err.message : String(err) });
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

    const cycleId = this.store.recordCycleStart();
    let registeredAgents: Set<string> = new Set();

    try {
      // ── Sequential: must be first ──────────────────────────────────────
      registeredAgents = await this.deployer.getRegisteredAgents();

      // Self-update: pull + rebuild if behind origin/main, then re-exec.
      if (this.cycleCount % SELF_UPDATE_EVERY_N_CYCLES === 0) {
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
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        batch4.push(this.detectImprovements(time));
        this.detectIterationCostImprovements(time);
        this.detectHealthIncidentIssues(time);
        batch4.push(this.checkIterationBudgetAlerts(time));
        batch4.push(this.checkMeetingRequests(time));
        batch4.push(
          learnPatterns(this.config, this.store)
            .then((learned) => { if (learned > 0) console.log(`[${time}] Pattern learner: discovered ${learned} new pattern(s)`); })
            .catch((err) => { this.log.warn("Pattern learner failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );
      }
      if (this.cycleCount % STANDUP_MEETING_EVERY_N_CYCLES === 0) {
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
      if (this.cycleCount % BLUESKY_MEETING_EVERY_N_CYCLES === 0) {
        batch4.push(this.runMeeting(time, "bluesky"));
      }
      if (this.cycleCount % ROADMAP_PROPOSAL_EVERY_N_CYCLES === 0) {
        batch4.push(
          proposeAndFileRoadmapItems(this.config, this.store)
            .then((filed) => { if (filed > 0) console.log(`[${time}] Roadmap proposer: filed ${filed} proposal(s)`); })
            .catch((err) => { this.log.warn("Roadmap proposal failed", { error: err instanceof Error ? err.message : String(err) }); }),
        );
      }
      if (this.cycleCount % RESEARCH_LINK_EVERY_N_CYCLES === 0) {
        batch4.push(this.linkResearchToImplementation(time));
      }
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        this.cleanupStaleIssues(time);
        this.reapStaleOrchestratorIssues(time);
      }
      if (this.cycleCount % BACKLOG_TRIAGE_EVERY_N_CYCLES === 0) {
        batch4.push(this.triageBacklogs(time));
        try {
          const filed = runProactiveScan(this.config, this.store);
          if (filed > 0) console.log(`[${time}] Proactive scan: filed ${filed} issue(s)`);
        } catch (err) {
          this.log.warn("Proactive scan failed", { error: err instanceof Error ? err.message : String(err) });
        }
      }
      batch4.push(maybePostDailyDigest(this.digestState, this.store, this.config));
      batch4.push(maybeRunDailySecurityScan(this.securityScanState, this.config));
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
  private async selfUpdate(): Promise<void> {
    const repoDir = resolve(new URL("../../..", import.meta.url).pathname);
    try {
      execSync("git fetch origin main --quiet", { cwd: repoDir, stdio: "pipe" });
      const behind = execSync("git rev-list HEAD..origin/main --count", { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim();
      if (behind === "0") return;

      const commits = execSync("git log HEAD..origin/main --oneline", { cwd: repoDir, stdio: "pipe" })
        .toString()
        .trim();
      this.log.info("Self-update: new commits detected, pulling and rebuilding", {
        behindBy: Number(behind),
        commits,
      });

      execSync("git pull --ff-only origin main", { cwd: repoDir, stdio: "pipe" });
      execSync("npm run build", { cwd: repoDir, stdio: "pipe" });

      this.log.info("Self-update: rebuild complete, re-execing daemon");
      await notifyOperator(
        `Daemon self-updated (${behind} commit${Number(behind) === 1 ? "" : "s"})`,
        commits,
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
      const result = await executeSync(this.config, management, actions);
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
          // Mark processed so this issue is not re-dispatched
          this.store.markProcessed("github", task.source_ref!, `closed-externally-${task.id}`);
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

  /**
   * Ping the proxy server (not the management API) to confirm it can route
   * LLM requests.  When the proxy is down, every dispatch/verify/review call
   * silently fails with "Connection error" or "Request was aborted", burning
   * retry budget and deadlocking the cycle.  This check detects that early.
   */
  private async checkProxyHealth(time: string): Promise<void> {
    const proxyUrl = this.config.proxy.url;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${proxyUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);

      if (res.ok) {
        if (this.proxyFailureCount > 0) {
          this.log.info("Proxy recovered", { previousFailures: this.proxyFailureCount });
          // Clear infrastructure-error failure history so affected issues can be
          // re-dispatched now that the proxy is back.
          this.clearInfrastructureFailures(time);
          await notifyOperator(
            `Proxy recovered`,
            `Proxy server at ${proxyUrl} is back online after ${this.proxyFailureCount} failed check(s). Infrastructure failure history cleared.`,
            "info",
          );
        }
        this.proxyFailureCount = 0;
        return;
      }
      this.proxyFailureCount++;
    } catch {
      this.proxyFailureCount++;
    }

    this.log.warn("Proxy health check failed", {
      url: proxyUrl,
      consecutiveFailures: this.proxyFailureCount,
    });

    if (this.proxyFailureCount === 2) {
      // Alert exactly once at threshold — not every check while proxy is down.
      await notifyOperator(
        "Proxy server unreachable",
        `Proxy at ${proxyUrl} has failed ${this.proxyFailureCount} consecutive health checks. All LLM routing is down — dispatches will fail with connection errors.`,
        "critical",
      );
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

            // Stigmergy: write a pattern_risk signal on verification failure
            // so other agents can read it before touching the same repo (issue #689).
            if (!result.approved && task.agent_name) {
              try {
                const repo = this.extractRepoFromTask(task);
                this.store.writeSignal({
                  agent: "claude-agent-orchestrator",
                  signal_type: "pattern_risk",
                  key: task.source_ref ?? task.id,
                  value: {
                    task_id: task.id,
                    task_title: task.title,
                    agent: task.agent_name,
                    score: result.score,
                    notes: result.notes ?? null,
                    revision_hint: result.revision ? result.revision.slice(0, 300) : null,
                  },
                  repo: repo ?? undefined,
                  confidence: Math.max(0, 1 - result.score),
                  ttl_hours: 168,
                });
              } catch (sigErr) {
                this.log.warn("Failed to write pattern_risk signal", {
                  taskId: task.id,
                  error: sigErr instanceof Error ? sigErr.message : String(sigErr),
                });
              }
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
    const windowTasks = verification.quality_sla_window_tasks ?? DEFAULT_QUALITY_SLA_WINDOW_TASKS;

    // Gather agent names that have at least one scored task.
    const agentNames: string[] = this.store
      .getAgentStats()
      .filter((a) => a.avg_score !== null)
      .map((a) => a.agent_name);

    if (agentNames.length === 0) return;

    const windowDate = new Date().toISOString().slice(0, 10);

    for (const agentName of agentNames) {
      const threshold =
        agentName in perAgentThresholds
          ? perAgentThresholds[agentName]
          : globalThreshold;

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
        const created = this.issueCreator.createAcrossRepos(imp);
        for (const issue of created) {
          console.log(`  Created: ${issue.url}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Improvement detection failed: ${err instanceof Error ? err.message : err}`);
    }
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

      this.dispatcher.dispatch(
        `Meeting request: ${payload.topic ?? request.key}\n\nFormat suggestion: ${payload.suggestedFormat ?? "auto"}\nRequested by: ${request.agent}\nContext: ${payload.context ?? "none"}\nUrgency: ${payload.urgency ?? "normal"}`,
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
      for (const imp of improvements) {
        const created = this.issueCreator.createAcrossRepos(imp, ["iteration-cost-triggered"]);
        for (const issue of created) {
          console.log(`  [iteration-cost] Created: ${issue.url}`);
        }
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
      for (const imp of improvements) {
        const created = this.issueCreator.createAcrossRepos(imp, ["health-incident-triggered"]);
        for (const issue of created) {
          console.log(`  [health-incident] Created: ${issue.url}`);
        }
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

  private async redeployStale(time: string, registeredAgents?: Set<string>): Promise<void> {
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

      console.log(`[${time}] Redeploying ${idle.length} agent(s): ${idle.join(", ")}${busy.length > 0 ? ` (deferred: ${busy.join(", ")})` : ""}`);
      const results = await this.deployer.redeployStale(new Set(idle));
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

    try {
      for (const [repo, agentName] of agentsByRepo) {
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
            } else if (prBodyHasIssueRef(prBody) && /missing.*issue|issue.*reference|Closes #N/i.test(result.reason)) {
              // The review flagged a missing Closes #N, but the PR body already has one —
              // agent must have updated it between review cycles. No dispatch needed.
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
    const agents = Object.entries(this.config.agents).filter(([, a]) => a.github);
    if (agents.length === 0) return;

    console.log(`[${time}] Backlog triage: dispatching housekeeping to ${agents.length} agent(s)`);
    this.log.info("Starting backlog triage cycle", { agentCount: agents.length });

    for (const [agentName, agent] of agents) {
      try {
        if (this.store.hasActiveTask(agentName)) {
          this.log.info("Skipping backlog triage: agent busy", { agentName });
          console.log(`  ${agentName}: skipped (agent busy)`);
          continue;
        }

        const githubRepo = agent.github!;
        const needsBootstrap = needsRoadmapBootstrap(githubRepo);
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
