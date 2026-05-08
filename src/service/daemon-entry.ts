import "@anthropic-ai/sdk/shims/web";
import { writePid } from "./pid.js";
import { Daemon } from "./daemon.js";

// Write PID immediately — before constructing the Daemon — so that monitoring
// sessions can verify the process is alive as early as possible and self-update
// can hand off ownership without a gap where daemon.pid is missing.
writePid();

// Parse args passed from the service CLI
const args = process.argv.slice(2);
let configPath: string | undefined;
let pollInterval: number | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) {
    configPath = args[++i];
  } else if (args[i] === "--poll-interval" && args[i + 1]) {
    pollInterval = parseInt(args[++i], 10);
  }
}

const daemon = new Daemon(configPath, pollInterval);
daemon.start();
