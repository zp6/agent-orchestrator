import { fork } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { isRunning, readPid, removePid } from "../../service/pid.js";
import { StateStore } from "../../state/store.js";

export function registerServiceCommand(program: Command): void {
  const serviceCmd = program
    .command("service")
    .description("Manage the background daemon");

  serviceCmd
    .command("start")
    .description("Start the background daemon")
    .option("--poll-interval <ms>", "Poll interval in milliseconds", "300000")
    .option("--foreground", "Run in foreground (attached to terminal)")
    .action((opts: { pollInterval: string; foreground?: boolean }) => {
      if (isRunning()) {
        const pid = readPid();
        console.error(chalk.red(`Daemon is already running (PID ${pid})`));
        process.exit(1);
      }

      const configPath = program.opts().config;
      const pollInterval = parseInt(opts.pollInterval, 10);

      if (opts.foreground) {
        // Run in foreground — import and start directly
        import("../../service/daemon.js").then(({ Daemon }) => {
          const daemon = new Daemon(configPath, pollInterval);
          daemon.start();
        });
        return;
      }

      // Fork a detached child process
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const daemonEntry = resolve(__dirname, "..", "..", "service", "daemon-entry.js");

      const args: string[] = [];
      if (configPath) args.push("--config", configPath);
      args.push("--poll-interval", String(pollInterval));

      const child = fork(daemonEntry, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      console.log(chalk.green(`Daemon started in background (PID ${child.pid})`));
      console.log(chalk.dim(`Poll interval: ${pollInterval / 1000}s`));
      console.log(chalk.dim("Use 'orch service status' to check, 'orch service stop' to stop."));
    });

  serviceCmd
    .command("stop")
    .description("Stop the background daemon")
    .action(() => {
      const pid = readPid();

      if (!pid || !isRunning()) {
        console.log(chalk.dim("Daemon is not running."));
        removePid();
        return;
      }

      try {
        process.kill(pid, "SIGTERM");
        console.log(chalk.green(`Sent SIGTERM to daemon (PID ${pid})`));

        // Wait up to 5s for graceful shutdown
        let waited = 0;
        const check = setInterval(() => {
          waited += 500;
          if (!isRunning() || waited >= 5000) {
            clearInterval(check);
            if (isRunning()) {
              process.kill(pid, "SIGKILL");
              removePid();
              console.log(chalk.yellow("Force-killed daemon."));
            } else {
              console.log(chalk.green("Daemon stopped."));
            }
          }
        }, 500);
      } catch {
        removePid();
        console.log(chalk.dim("Daemon was not running (stale PID removed)."));
      }
    });

  serviceCmd
    .command("status")
    .description("Check daemon status")
    .action(() => {
      const pid = readPid();
      const running = isRunning();
      const configPath = program.opts().config;

      if (running && pid) {
        console.log(chalk.green(`Daemon is running (PID ${pid})`));
      } else if (pid && !running) {
        console.log(chalk.yellow("Daemon is not running (stale PID file removed)"));
        removePid();
      } else {
        console.log(chalk.dim("Daemon is not running."));
      }

      // Show watched sources
      try {
        const config = loadConfig(configPath);
        const github = Object.entries(config.agents)
          .filter(([, a]) => a.github)
          .map(([name, a]) => `  ${chalk.cyan(name)}: ${a.github}`);
        const linear = Object.entries(config.agents)
          .filter(([, a]) => a.linear)
          .map(([name, a]) => `  ${chalk.cyan(name)}: teams=${a.linear?.teams?.join(",") ?? "all"}`);
        const slack = Object.entries(config.agents)
          .filter(([, a]) => a.slack)
          .map(([name, a]) => `  ${chalk.cyan(name)}: ${a.slack?.channels?.join(", ") ?? "all channels"}`);

        if (github.length) {
          console.log(chalk.bold(`\nGitHub (${github.length}):`));
          for (const r of github) console.log(r);
        }
        if (linear.length) {
          console.log(chalk.bold(`\nLinear (${linear.length}):`));
          for (const r of linear) console.log(r);
        }
        if (slack.length) {
          console.log(chalk.bold(`\nSlack (${slack.length}):`));
          for (const r of slack) console.log(r);
        }
        if (!github.length && !linear.length && !slack.length) {
          console.log(chalk.dim("\nNo trigger sources configured."));
        }

        // --- Improvement detection stats ---
        const minScore = config.verification?.min_score ?? 0.7;
        try {
          const store = new StateStore();
          const qualified = store.getRecentVerified(20, minScore);
          store.close();

          const count = qualified.length;
          const threshold = minScore.toFixed(2);
          const countColor = count >= 5 ? chalk.green : count > 0 ? chalk.yellow : chalk.red;

          console.log(chalk.bold("\nImprovement Detection"));
          console.log(`  Quality threshold: score ≥ ${chalk.cyan(threshold)}`);
          console.log(`  Qualifying tasks:  ${countColor(String(count))} (of last 20 verified)`);

          if (count < 5) {
            console.log(
              chalk.yellow(`  ⚠ Improvement detection inactive`) +
                chalk.dim(` — need ≥5 qualifying tasks, have ${count}`),
            );
          } else {
            console.log(chalk.dim(`  ✓ Improvement detection active`));
          }
        } catch {
          // State DB not available (first run, etc.)
        }
      } catch {
        // Config not available
      }
    });
}
