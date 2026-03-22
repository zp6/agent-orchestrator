import { loadConfig, type OrchestratorConfig } from "../config/schema.js";
import { StateStore } from "../state/store.js";
import { Dispatcher } from "../orchestrator/dispatcher.js";
import { dispatchGitHubIssues } from "../triggers/trigger-dispatcher.js";
import { writePid, removePid } from "./pid.js";

const DEFAULT_POLL_INTERVAL_MS = 300_000; // 5 minutes

export class Daemon {
  private running = false;
  private config: OrchestratorConfig;
  private store: StateStore;
  private dispatcher: Dispatcher;
  private pollInterval: number;

  constructor(configPath?: string, pollIntervalMs?: number) {
    this.config = loadConfig(configPath);
    this.store = new StateStore();
    this.dispatcher = new Dispatcher(this.config, this.store);
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

    const repos = Object.entries(this.config.agents)
      .filter(([, a]) => a.github)
      .map(([name, a]) => `${name} (${a.github})`);

    console.log(`Daemon started (PID ${process.pid})`);
    console.log(`Poll interval: ${this.pollInterval / 1000}s`);
    console.log(`Watching ${repos.length} repo(s): ${repos.join(", ")}`);
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
      const result = await dispatchGitHubIssues(this.config, this.store, this.dispatcher);
      if (result.dispatched > 0 || result.errors.length > 0) {
        console.log(
          `[${time}] Dispatched: ${result.dispatched}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`,
        );
        for (const err of result.errors) {
          console.error(`  Error: ${err}`);
        }
      } else {
        console.log(`[${time}] No new issues (${result.skipped} already processed)`);
      }
    } catch (err) {
      console.error(`[${time}] Poll cycle failed: ${err instanceof Error ? err.message : err}`);
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
      // Check running flag periodically to allow fast shutdown
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
