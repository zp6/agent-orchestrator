import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { Dispatcher } from "../orchestrator/dispatcher.js";
import { Verifier } from "../orchestrator/verifier.js";
import { ImprovementDetector } from "../orchestrator/improvement-detector.js";
import { IssueCreator } from "../orchestrator/issue-creator.js";
import { Deployer } from "../orchestrator/deployer.js";
import { Supervisor } from "../orchestrator/supervisor.js";
import {
  dispatchGitHubIssues,
  dispatchLinearChecks,
  dispatchSlackChecks,
  type TriggerResult,
} from "../triggers/trigger-dispatcher.js";
import { writePid, removePid } from "./pid.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes
const IMPROVEMENT_CHECK_EVERY_N_CYCLES = 6; // ~30min at default interval
const SUPERVISOR_CHECK_EVERY_N_CYCLES = 3; // ~15min at default interval

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
  private pollInterval: number;
  private cycleCount = 0;

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.config = loadConfig(configPath);
    this.store = new StateStore();
    this.dispatcher = new Dispatcher(this.config, this.store);
    this.verifier = new Verifier(this.config, this.store);
    this.detector = new ImprovementDetector(this.config);
    this.issueCreator = new IssueCreator(this.config);
    this.deployer = new Deployer(this.config);
    this.supervisor = new Supervisor(this.config, this.store);
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
    const time = new Date().toLocaleTimeString();
    this.cycleCount++;

    // 1. Dispatch new work from all trigger sources
    await this.dispatchTriggers(time);

    // 2. Verify recently completed tasks
    await this.verifyCompleted(time);

    // 3. Periodically detect improvements and create issues
    if (this.cycleCount % IMPROVEMENT_CHECK_EVERY_N_CYCLES === 0) {
      await this.detectImprovements(time);
    }

    // 4. Redeploy agents with new code
    await this.redeployStale(time);

    // 5. Supervisor review — strategic reasoning about what needs attention
    if (this.cycleCount % SUPERVISOR_CHECK_EVERY_N_CYCLES === 0) {
      await this.runSupervisor(time);
    }
  }

  private async dispatchTriggers(time: string): Promise<void> {
    try {
      const results = await Promise.allSettled([
        dispatchGitHubIssues(this.config, this.store, this.dispatcher),
        dispatchLinearChecks(this.config, this.store, this.dispatcher),
        dispatchSlackChecks(this.config, this.store, this.dispatcher),
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
      const unverified = this.store.getUnverified(3); // verify up to 3 per cycle
      if (unverified.length === 0) return;

      const minScore = this.config.verification.min_score ?? 0.7;
      const sources = this.config.verification.sources;

      for (const task of unverified) {
        // Only verify tasks from configured sources
        if (sources && !sources.includes(task.source)) continue;

        try {
          const result = await this.verifier.verify(task.id);
          const status = result.approved ? "approved" : "rejected";
          console.log(
            `[${time}] Verified ${task.id.slice(0, 8)} (${task.agent_name}): ${status} (${result.score.toFixed(1)})`,
          );

          if (!result.approved && result.score < minScore && result.revision) {
            console.log(`  Needs revision: ${result.revision.slice(0, 100)}`);
          }
        } catch (err) {
          console.error(`[${time}] Verify failed for ${task.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Verification step failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async detectImprovements(time: string): Promise<void> {
    try {
      const recent = this.store.getRecentCompleted(20);
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

  private async redeployStale(time: string): Promise<void> {
    try {
      const stale = this.deployer.getStaleAgents();
      if (stale.length === 0) return;

      console.log(`[${time}] Redeploying ${stale.length} agent(s): ${stale.join(", ")}`);
      const results = await this.deployer.redeployStale();
      for (const r of results) {
        if (r.action === "redeployed") {
          console.log(`  ${r.agentName}: redeployed`);
        } else if (r.action === "error") {
          console.error(`  ${r.agentName}: ${r.detail}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Deploy check failed: ${err instanceof Error ? err.message : err}`);
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
          try {
            const result = await this.dispatcher.dispatch(d.message, {
              agentName: d.agentName,
              title: `[supervisor] ${d.reason.slice(0, 80)}`,
            });
            console.log(`  ${d.action} → ${d.agentName} (task ${result.taskId.slice(0, 8)}): ${d.reason}`);
          } catch (err) {
            console.error(`  Failed ${d.action} → ${d.agentName}: ${err instanceof Error ? err.message : err}`);
          }
        } else {
          console.log(`  ${d.action}${d.agentName ? ` → ${d.agentName}` : ""}: ${d.reason}`);
        }
      }
    } catch (err) {
      console.error(`[${time}] Supervisor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  private cleanup(): void {
    removePid();
    this.store.close();
    console.log("Daemon stopped.");
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
