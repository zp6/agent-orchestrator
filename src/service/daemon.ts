import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { Dispatcher } from "../orchestrator/dispatcher.js";
import { Verifier } from "../orchestrator/verifier.js";
import { ImprovementDetector } from "../orchestrator/improvement-detector.js";
import { IssueCreator } from "../orchestrator/issue-creator.js";
import { Deployer } from "../orchestrator/deployer.js";
import { Supervisor } from "../orchestrator/supervisor.js";
import { PRReviewer } from "../orchestrator/pr-reviewer.js";
import { findOrphanBranches, createPRForBranch } from "../orchestrator/pr-creator.js";
import {
  dispatchGitHubIssues,
  dispatchLinearChecks,
  dispatchSlackChecks,
  type TriggerResult,
} from "../triggers/trigger-dispatcher.js";
import { writePid, removePid } from "./pid.js";
import { createLogger } from "./logger.js";
import { execSync } from "node:child_process";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const IMPROVEMENT_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const SUPERVISOR_CHECK_EVERY_N_CYCLES = 3; // ~15min at default interval
const BACKLOG_TRIAGE_EVERY_N_CYCLES = 60; // ~5h at default interval
const STALE_ISSUE_AGE_DAYS = 7;

export class Daemon {
  private running = false;
  private config: OrchestratorConfig;
  private store: StateStore;
  private dispatcher: Dispatcher;
  private verifier: Verifier;
  private detector: ImprovementDetector;
  private issueCreator: IssueCreator;
  private deployer: Deployer;
  private supervisor: Supervisor;
  private prReviewer: PRReviewer;
  private pollInterval: number;
  private cycleCount = 0;
  private log = createLogger("daemon");

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.config = loadConfig(configPath);
    this.store = new StateStore();
    this.dispatcher = new Dispatcher(this.config, this.store);
    this.verifier = new Verifier(this.config, this.store);
    this.detector = new ImprovementDetector(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.deployer = new Deployer(this.config);
    this.supervisor = new Supervisor(this.config, this.store);
    this.prReviewer = new PRReviewer(this.config);
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

      // 1. Check for stale dispatched tasks (stuck or crashed agents)
      this.checkStaleTasks(time);

      // 2. Dispatch new work from all trigger sources
      await this.dispatchTriggers(time, registeredAgents);

      // 2. Verify recently completed tasks
      await this.verifyCompleted(time);

      // 3. Periodically detect improvements and create issues
      if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
        await this.detectImprovements(time);
      }

      // 4. Create PRs for orphan branches + review open PRs
      if (this.cycleCount % SUPERVISOR_CHECK_EVERY_N_CYCLES === 0) {
        await this.createOrphanPRs(time);
        await this.reviewPRs(time);
      }

      // 5. Redeploy agents with new code (only registered ones)
      await this.redeployStale(time, registeredAgents);

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
    } finally {
      this.store.recordCycleEnd(cycleId, cycleStartedAt);
      const durationMs = Date.now() - cycleStartedAt.getTime();
      this.log.info("Cycle complete", { cycle: this.cycleCount, durationMs });
      console.log(`[${time}] Cycle #${this.cycleCount} complete (${durationMs}ms)`);
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
        console.log(`[${time}] Stale task ${task.id.slice(0, 8)} (${task.agent_name}): dispatched ${Math.round(age / 60000)}min ago — marking failed`);
        this.log.warn("Stale task detected", { taskId: task.id, agentName: task.agent_name, ageMinutes: Math.round(age / 60000), staleThresholdMs });
        this.store.updateTask(task.id, {
          status: "failed",
          result: `Timed out: dispatched ${Math.round(age / 60000)} minutes ago with no response`,
        });
      }
    }
  }

  private async dispatchTriggers(time: string, registeredAgents: Set<string>): Promise<void> {
    try {
      const results = await Promise.allSettled([
        dispatchGitHubIssues(this.config, this.store, this.dispatcher, 1, registeredAgents),
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

  private async redeployStale(time: string, registeredAgents?: Set<string>): Promise<void> {
    try {
      const staleLocal = this.deployer.getStaleAgents(registeredAgents);
      const staleRepo = this.deployer.getStaleRepoAgents(registeredAgents);
      const totalStale = staleLocal.length + staleRepo.length;
      if (totalStale === 0) return;

      const allStale = [...staleLocal, ...staleRepo];
      console.log(`[${time}] Redeploying ${totalStale} agent(s): ${allStale.join(", ")}`);
      const results = await this.deployer.redeployStale(registeredAgents);
      for (const r of results) {
        if (r.action === "redeployed") {
          console.log(`  ${r.agentName}: redeployed`);
        } else if (r.action === "health-check-failed") {
          console.error(`  ${r.agentName}: ⚠ deployed but health check failed — agent may be broken. ${r.detail}`);
          this.log.warn("Agent health check failed after deploy", { agentName: r.agentName, detail: r.detail });
        } else if (r.action === "error") {
          console.error(`  ${r.agentName}: ${r.detail}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Deploy check failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async createOrphanPRs(time: string): Promise<void> {
    try {
      const orphans = findOrphanBranches(this.config);
      for (const orphan of orphans) {
        console.log(`[${time}] Orphan branch: ${orphan.repo}/${orphan.branch} — creating PR`);
        // Pass config so issue resolution can use fuzzy matching + LLM disambiguation
        await createPRForBranch(orphan, this.config);
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
        for (const { prNumber, result } of results) {
          console.log(`[${time}] PR review: ${repo}#${prNumber} → ${result.decision} (${result.reason})`);

          // Dispatch feedback to agent when changes are requested (skip if agent busy or duplicate)
          if (result.decision === "request-changes") {
            if (this.store.hasActiveTask(agentName)) {
              this.log.info("Skipping PR feedback dispatch: agent busy", { agentName, repo, prNumber });
            } else if (this.store.hasActivePrFeedbackTask(repo, prNumber)) {
              this.log.info("Skipping PR feedback dispatch: feedback already in-flight", { agentName, repo, prNumber });
            } else if (isPRAlreadyMerged(repo, prNumber)) {
              this.log.info("Skipping feedback dispatch: PR already merged", { repo, prNumber });
            } else {
              this.log.info("Dispatching PR feedback to agent", { repo, prNumber, agentName });
              this.dispatcher.dispatch(
                `Your PR #${prNumber} on ${repo} was reviewed and needs changes:\n\n${result.comment}\n\nPlease fix the issues, commit, and push to the same branch.`,
                { agentName, source: "pr-feedback", sourceRef: `${repo}#${prNumber}`, title: `[PR feedback] ${repo}#${prNumber}` },
              ).catch((err) => {
                this.log.error("Failed to dispatch PR feedback", { repo, prNumber, error: String(err) });
              });
            }
          }
        }
      }
    } catch (err) {
      console.error(`[${time}] PR review failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async runSupervisor(time: string): Promise<void> {
    try {
      const decisions = await this.supervisor.review();
      if (decisions.length === 0) return;

      console.log(`[${time}] Supervisor: ${decisions.length} decision(s)`);
      for (const d of decisions) {
        if (d.action === "none") continue;

        if ((d.action === "dispatch" || d.action === "follow-up") && d.agentName && d.message) {
          if (this.store.hasActiveTask(d.agentName)) {
            this.log.info("Skipping supervisor dispatch: agent busy", { agentName: d.agentName, reason: d.reason });
            console.log(`  ${d.action} → ${d.agentName} SKIPPED (agent busy): ${d.reason}`);
          } else {
            try {
              // Fire-and-forget: don't block the daemon cycle waiting for agent response
              this.dispatcher.dispatch(d.message, {
                agentName: d.agentName,
                title: `[supervisor] ${d.reason.slice(0, 80)}`,
              }).then((result) => {
                console.log(`  ${d.action} → ${d.agentName} (task ${result.taskId.slice(0, 8)}): ${d.reason}`);
              }).catch((err) => {
                this.log.error("Supervisor dispatch failed", { agentName: d.agentName, error: String(err) });
              });
            } catch (err) {
              console.error(`  Failed ${d.action} → ${d.agentName}: ${err instanceof Error ? err.message : err}`);
            }
          }
        } else {
          console.log(`  ${d.action}${d.agentName ? ` → ${d.agentName}` : ""}: ${d.reason}`);
        }
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
