import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { Dispatcher } from "../orchestrator/dispatcher.js";
import {
  dispatchGitHubIssues,
  dispatchLinearChecks,
  dispatchSlackChecks,
  type TriggerResult,
} from "../triggers/trigger-dispatcher.js";
import { Deployer } from "../orchestrator/deployer.js";
import { writePid, removePid } from "./pid.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes

export class Daemon {
  private running = false;
  private config: OrchestratorConfig;
  private store: StateStore;
  private dispatcher: Dispatcher;
  private deployer: Deployer;
  private pollInterval: number;

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.config = loadConfig(configPath);
    this.store = new StateStore();
    this.dispatcher = new Dispatcher(this.config, this.store);
    this.deployer = new Deployer(this.config);
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
          `[${time}] Dispatched: ${totals.dispatched}, Skipped: ${totals.skipped}, Errors: ${totals.errors.length}`,
        );
        for (const err of totals.errors) {
          console.error(`  Error: ${err}`);
        }
      } else {
        console.log(`[${time}] No new items (${totals.skipped} already processed)`);
      }
    } catch (err) {
      console.error(`[${time}] Poll cycle failed: ${err instanceof Error ? err.message : err}`);
    }

    // Check for agents with new code that need redeployment
    try {
      const stale = this.deployer.getStaleAgents();
      if (stale.length > 0) {
        console.log(`[${time}] Redeploying ${stale.length} agent(s) with new code: ${stale.join(", ")}`);
        const results = await this.deployer.redeployStale();
        for (const r of results) {
          if (r.action === "redeployed") {
            console.log(`  ${r.agentName}: redeployed`);
          } else if (r.action === "error") {
            console.error(`  ${r.agentName}: ${r.detail}`);
          }
        }
      }
    } catch (err) {
      console.error(`[${time}] Deploy check failed: ${err instanceof Error ? err.message : err}`);
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
