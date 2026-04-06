import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { Dispatcher, MAX_RETRIES, TIMEOUT_RETRY_MAX, TIMEOUT_RETRY_BACKOFF_MS, extractRepoFromSourceRef } from "../orchestrator/dispatcher.js";
import { Verifier } from "../orchestrator/verifier.js";
import { ImprovementDetector } from "../orchestrator/improvement-detector.js";
import { ResearchLinker } from "../orchestrator/research-linker.js";
import { IssueCreator } from "../orchestrator/issue-creator.js";
import { Deployer } from "../orchestrator/deployer.js";
import { Supervisor, isDecisionAlreadyResolved } from "../orchestrator/supervisor.js";
import { PRReviewer } from "../orchestrator/pr-reviewer.js";
import { findOrphanBranches, createPRForBranch, deleteStaleOrphanBranches, STALE_BRANCH_BEHIND_THRESHOLD } from "../orchestrator/pr-creator.js";
import { PRCreationRetryQueue } from "../orchestrator/pr-creation-retry-queue.js";
import { validateGhAuth, isIssueOpen } from "../triggers/github.js";
import {
  dispatchGitHubIssues,
  dispatchIdleAgentBacklog,
  dispatchLinearChecks,
  dispatchSlackChecks,
  type TriggerResult,
} from "../triggers/trigger-dispatcher.js";
import { writePid, removePid } from "./pid.js";
import { createLogger } from "./logger.js";
import { execSync } from "node:child_process";
import { ManagementClient } from "../client/management-client.js";
import { planSync, executeSync } from "../orchestrator/sync.js";
import { notifyOperator } from "./notify.js";
import { startTelegramPolling, stopTelegramPolling, pollTelegram } from "./telegram.js";
import { maybePostDailyDigest, type DigestSchedulerState } from "./slack-digest.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const IMPROVEMENT_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const AUTO_MERGE_SWEEP_EVERY_N_CYCLES = 3;  // ~15min — same cadence as PR review
const SUPERVISOR_CHECK_EVERY_N_CYCLES = 3; // ~15min at default interval
const RESEARCH_LINK_EVERY_N_CYCLES = 6; // ~30min — same cadence as improvement detection
const BACKLOG_TRIAGE_EVERY_N_CYCLES = 60; // ~5h at default interval
const CONTAINER_RESTART_EVERY_N_CYCLES = 100; // ~50min at 30s interval — prevents Docker stalls
const AGENT_SYNC_EVERY_N_CYCLES = 10; // ~5min at default interval — recover from proxy restarts
const CLOSED_ISSUE_CHECK_EVERY_N_CYCLES = 3; // ~15min at default — cancel in-flight tasks for closed issues
const STALE_ISSUE_AGE_DAYS = 7;

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

export class Daemon {
  private running = false;
  private config: OrchestratorConfig;
  private store: StateStore;
  private dispatcher: Dispatcher;
  private verifier: Verifier;
  private detector: ImprovementDetector;
  private researchLinker: ResearchLinker;
  private issueCreator: IssueCreator;
  private deployer: Deployer;
  private supervisor: Supervisor;
  private prReviewer: PRReviewer;
  private prRetryQueue: PRCreationRetryQueue;
  private pollInterval: number;
  private cycleCount = 0;
  private log = createLogger("daemon");

  /**
   * Tracks how many consecutive poll cycles each agent has been idle
   * (no active task AND no dispatch occurred).  Reset to 0 when a dispatch
   * succeeds.  Used to trigger force-reclaim when the duplicate-guard recency
   * window is blocking all available issues.
   */
  private idleCyclesSinceDispatch = new Map<string, number>();

  /** Tracks when the daily Slack digest was last sent (re-arms on new calendar day). */
  private digestState: DigestSchedulerState = { lastDigestDate: null };

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.config = loadConfig(configPath);
    this.store = new StateStore();
    this.dispatcher = new Dispatcher(this.config, this.store);
    this.verifier = new Verifier(this.config, this.store);
    this.detector = new ImprovementDetector(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.researchLinker = new ResearchLinker(this.config, this.store, this.issueCreator);
    this.deployer = new Deployer(this.config);
    this.supervisor = new Supervisor(this.config, this.store);
    this.prReviewer = new PRReviewer(this.config, this.store);
    this.prRetryQueue = new PRCreationRetryQueue(this.store);
    this.pollInterval = pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    this.running = true;
    writePid();

    const handleSignal = () => {
      console.log("\nShutting down...");
      this.stop();
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

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

    // Start independent Telegram polling (3s interval, doesn't block cycles)
    startTelegramPolling({ config: this.config, store: this.store, dispatcher: this.dispatcher });

    while (this.running) {
      await this.pollCycle();
      if (!this.running) break;
      await this.sleep(this.pollInterval);
    }

    this.cleanup();
  }

  stop(): void {
    this.running = false;
  }

  private async pollCycle(): Promise<void> {
    const cycleStartedAt = new Date();
    const time = cycleStartedAt.toLocaleTimeString();
    this.cycleCount++;

    const cycleId = this.store.recordCycleStart();
    let registeredAgents: Set<string> = new Set();

    try {
      // Fetch which agents are actually deployed on the proxy
      registeredAgents = await this.deployer.getRegisteredAgents();

      // 0a. Sync agents every 10 cycles (~5 min) to recover from proxy restarts.
      //     The management API loses agent state when the proxy restarts, so periodic
      //     sync ensures agents are re-registered without requiring a daemon restart.
      //     Also check for auth recovery on quarantined agents (issue #418).
      if (this.cycleCount % AGENT_SYNC_EVERY_N_CYCLES === 0) {
        await this.syncAgents();
        // Re-fetch registered agents after sync in case new ones were created
        registeredAgents = await this.deployer.getRegisteredAgents();
        // Check if quarantined agents have recovered their GH_TOKEN
        await this.checkAuthRecovery();
      }

      // 0b. Poll Telegram for operator commands (lightweight — single HTTP call)
      await pollTelegram({ config: this.config, store: this.store, dispatcher: this.dispatcher });

      // 1. Check for stale dispatched tasks (stuck or crashed agents).
      //    Timeout failures are scheduled for retry (up to TIMEOUT_RETRY_MAX times)
      //    rather than being permanently failed immediately.
      this.checkStaleTasks(time);

      // 1b. Cancel in-flight tasks whose source issue has been closed externally
      //     (issue #431). Runs periodically to avoid excessive GitHub API calls.
      if (this.cycleCount % CLOSED_ISSUE_CHECK_EVERY_N_CYCLES === 0) {
        this.cancelClosedIssueTasks(time);
      }

      // 1c. Process tasks whose retry backoff has elapsed.
      await this.processRetries(time);

      // 2. Dispatch new work from all trigger sources
      await this.dispatchTriggers(time, registeredAgents);

      // 2. Verify recently completed tasks
      await this.verifyCompleted(time);

      // 2b. Idle-agent pickup: immediately dispatch the next GitHub issue to agents
      //     that just became idle (completed their task this cycle). Without this,
      //     agents sit idle until the next full poll cycle — previously the supervisor
      //     filled this gap with manual "agent is idle" dispatches.
      await this.pickupIdleAgents(time, registeredAgents);

      // 3. Create PRs for any branches pushed since the last cycle.
      //    Runs every cycle (ORPHAN_PR_CHECK_EVERY_N_CYCLES = 1) so that a
      //    pushed branch is picked up within a single poll interval.  This
      //    prevents the supervisor-intervention failure mode seen in tasks
      //    01KNDFMP, 01KNDAVJ, and 01KNDB9C where branches sat without PRs
      //    for multiple cycles.
      if (this.cycleCount % ORPHAN_PR_CHECK_EVERY_N_CYCLES === 0) {
        await this.createOrphanPRs(time);
      }

      // 3b. Periodically detect improvements and create issues
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        await this.detectImprovements(time);
      }

      // 3c. Link approved research findings to implementation issues
      if (this.cycleCount % RESEARCH_LINK_EVERY_N_CYCLES === 0) {
        await this.linkResearchToImplementation(time);
      }

      // 4. Review open PRs (kept at a slower cadence — review is more expensive)
      if (this.cycleCount % SUPERVISOR_CHECK_EVERY_N_CYCLES === 0) {
        await this.reviewPRs(time);
      }

      // 4b. Sweep approved-but-unqueued PRs into the merge queue, then process it.
      //     The sweep runs at the same cadence as PR review (~15 min) so that
      //     PRs approved in the previous review cycle are picked up promptly.
      //     processMergeQueue runs every cycle so queued PRs land without delay.
      if (this.cycleCount % AUTO_MERGE_SWEEP_EVERY_N_CYCLES === 0) {
        await this.sweepAndMergeApprovedPRs(time);
      }
      await this.processMergeQueue(time);

      // 5. Redeploy agents with new code (only registered ones)
      await this.redeployStale(time, registeredAgents);

      // 5b. Preventive container restart — clear accumulated state before containers stall
      if (this.cycleCount % CONTAINER_RESTART_EVERY_N_CYCLES === 0) {
        await this.preventiveRestart(time, registeredAgents);
      }

      // 6. Supervisor review — strategic reasoning about what needs attention
      if (this.cycleCount % SUPERVISOR_CHECK_EVERY_N_CYCLES === 0) {
        await this.runSupervisor(time);
      }

      // 7. Clean up stale issues (issues with merged PRs that didn't auto-close)
      //    Also reap orchestrator-labeled issues open >7 days with no linked PR
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        this.cleanupStaleIssues(time);
        this.reapStaleOrchestratorIssues(time);
      }

      // 8. Periodic backlog triage — dispatch housekeeping task to each agent (~every 5h)
      if (this.cycleCount % BACKLOG_TRIAGE_EVERY_N_CYCLES === 0) {
        await this.triageBacklogs(time);
      }

      // 9. Daily Slack digest — posts once per day at the configured wall-clock time
      await maybePostDailyDigest(this.digestState, this.store, this.config);
    } finally {
      this.store.recordCycleEnd(cycleId, cycleStartedAt);
      const durationMs = Date.now() - cycleStartedAt.getTime();
      this.log.info("Cycle complete", { cycle: this.cycleCount, durationMs });
      console.log(`[${time}] Cycle #${this.cycleCount} complete (${durationMs}ms)`);
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
      notifyOperator(
        "Agents recovered from auth-degraded",
        `${recovered.length} agent(s) restored to full operation: ${recovered.join(", ")}. ` +
        `GH_TOKEN is now valid — implementation tasks will be dispatched normally.`,
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

        if (!isIssueOpen(repo, issueNumber)) {
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
          const result = await this.verifier.verifyAndRevise(task.id, maxRevisions);
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

  private async detectImprovements(time: string): Promise<void> {
    try {
      const minScore = this.config.verification?.min_score ?? 0.7;
      const recent = this.store.getRecentVerified(20, minScore);
      if (recent.length < 5) return; // need enough data

      const improvements = await this.detector.analyze(recent);
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
        } else if (r.action === "health-check-failed") {
          console.error(`  ${r.agentName}: ⚠ deployed but health check failed — agent may be broken. ${r.detail}`);
          this.log.warn("Agent health check failed after deploy", { agentName: r.agentName, detail: r.detail });
          notifyOperator(
            `Deploy health check failed: ${r.agentName}`,
            `Agent ${r.agentName} was redeployed but failed health check. May be broken.`,
            "critical",
            `health-fail:${r.agentName}`,
          ).catch(() => {});
        } else if (r.action === "error") {
          console.error(`  ${r.agentName}: ${r.detail}`);
        }
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
          this.log.warn("Agent unhealthy after preventive restart", { agentName: name });
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

    try {
      for (const [repo, agentName] of agentsByRepo) {
        const results = await this.prReviewer.reviewOpenPRs(repo);
        for (const { prNumber, result, prBody, prBranch, prDiff } of results) {
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
                const issueNumbers = extractClosedIssueNumbers(prBody);
                if (issueNumbers.length > 0 && !this.store.hasActiveTask(agentName)) {
                  const issueNum = issueNumbers[0];
                  this.log.info("Re-dispatching linked issue after auto-close of conflicting PR", { repo, prNumber, issueNum, agentName });
                  this.dispatcher.dispatch(
                    `Issue #${issueNum} on ${repo} needs to be re-implemented. The previous PR #${prNumber} was auto-closed because it had persistent merge conflicts that could not be resolved automatically. Please start fresh from the latest \`main\` branch, create a new feature branch, implement the issue, and open a new PR with "Closes #${issueNum}" in the body.`,
                    {
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

  private async processMergeQueue(time: string): Promise<void> {
    try {
      const queue = this.prReviewer.getMergeQueue();
      if (queue.length === 0) return;
      console.log(`[${time}] Merge queue: ${queue.length} PR(s) pending — processing...`);
      await this.prReviewer.processMergeQueue();
    } catch (err) {
      console.error(`[${time}] Merge queue processing failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async runSupervisor(time: string): Promise<void> {
    try {
      const decisions = await this.supervisor.review();
      if (decisions.length === 0) return;

      console.log(`[${time}] Supervisor: ${decisions.length} decision(s)`);
      let cycleSkipped = 0;
      for (const d of decisions) {
        if (d.action === "none") {
          this.store.addSupervisorDecision({
            action: d.action,
            agent_name: d.agentName,
            reason: d.reason,
            message: d.message,
            rationale: d.rationale,
            outcome: "none",
          });
          continue;
        }

        if ((d.action === "dispatch" || d.action === "follow-up") && d.agentName && d.message) {
          // Pre-dispatch resolution check: if the referenced issue/PR is already
          // closed or merged, skip this dispatch to avoid wasted round-trips.
          const agentGithub = this.config.agents[d.agentName]?.github;
          if (agentGithub && isDecisionAlreadyResolved(d.message, d.reason, agentGithub)) {
            this.log.info("Supervisor dispatch skipped — already resolved", {
              agentName: d.agentName,
              reason: d.reason,
              message: d.message.slice(0, 120),
            });
            console.log(`  ${d.action} → ${d.agentName} SKIPPED (already resolved): ${d.reason}`);
            this.store.addSupervisorDecision({
              action: d.action,
              agent_name: d.agentName,
              reason: d.reason,
              message: d.message,
              rationale: d.rationale,
              outcome: "skipped",
            });
            this.store.incrementStat("supervisor_pre_resolved_skips");
            cycleSkipped++;
            continue;
          }

          if (this.store.hasActiveTask(d.agentName)) {
            this.log.info("Skipping supervisor dispatch: agent busy", { agentName: d.agentName, reason: d.reason });
            console.log(`  ${d.action} → ${d.agentName} SKIPPED (agent busy): ${d.reason}`);
            this.store.addSupervisorDecision({
              action: d.action,
              agent_name: d.agentName,
              reason: d.reason,
              message: d.message,
              rationale: d.rationale,
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
                title: `[supervisor] ${d.reason.slice(0, 80)}`,
              }).then((result) => {
                console.log(`  ${d.action} → ${d.agentName} (task ${result.taskId.slice(0, 8)}): ${d.reason}`);
                this.store.addSupervisorDecision({
                  action: d.action,
                  agent_name: d.agentName,
                  reason: d.reason,
                  message: d.message,
                  rationale: d.rationale,
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
                  rationale: d.rationale,
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
                rationale: d.rationale,
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
            outcome: "unhandled",
          });
        }
      }
      if (cycleSkipped > 0) {
        this.log.info("Supervisor cycle: pre-resolved skips", { cycleSkipped });
        console.log(`[${time}] Supervisor: ${cycleSkipped} decision(s) skipped — already resolved`);
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

  private cleanup(): void {
    stopTelegramPolling();
    removePid();
    this.store.close();
    console.log("Daemon stopped.");
  }

  private cleanupStaleIssues(time: string): void {
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
