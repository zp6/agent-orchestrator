import { Daemon } from "./daemon.js";

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
