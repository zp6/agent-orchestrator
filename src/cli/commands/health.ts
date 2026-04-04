import { execSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { isRunning, readPid } from "../../service/pid.js";
import { StateStore } from "../../state/store.js";
import { ManagementClient } from "../../client/management-client.js";
import { pingAllAgents } from "./agents.js";

function listOpenPRs(repos: string[]): Array<{ repo: string; number: number; title: string }> {
  const result: Array<{ repo: string; number: number; title: string }> = [];
  for (const repo of repos) {
    try {
      const prs = JSON.parse(
        execSync(`gh pr list --repo ${repo} --state open --json number,title`, {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
        }),
      ) as Array<{ number: number; title: string }>;
      for (const pr of prs) {
        result.push({ repo, number: pr.number, title: pr.title });
      }
    } catch {
      // skip inaccessible repos
    }
  }
  return result;
}

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description("Unified system health snapshot: daemon, agents, tasks (24h), open PRs, and alerts")
    .action(async () => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);

      // ── 1. Daemon status ──────────────────────────────────────────────────
      console.log(chalk.bold("\n● Daemon"));
      const pid = readPid();
      const running = isRunning();
      if (running && pid) {
        console.log(`  ${chalk.green("✓ running")}  PID ${pid}`);
      } else if (pid && !running) {
        console.log(`  ${chalk.yellow("⚠ stale PID")}  (process ${pid} not found)`);
      } else {
        console.log(`  ${chalk.red("✗ not running")}`);
      }

      // Last cycle age
      try {
        const store = new StateStore();
        const metrics = store.getMetrics();
        store.close();
        const lastCycleAt = metrics.cycles.last_cycle_at;
        if (lastCycleAt) {
          const ageMs = Date.now() - new Date(lastCycleAt).getTime();
          const ageMins = Math.floor(ageMs / 60000);
          const ageStr =
            ageMins < 1 ? "< 1 min ago" : ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ago`;
          const cycleColor = ageMs < 5 * 60 * 1000 ? chalk.green : ageMs < 15 * 60 * 1000 ? chalk.yellow : chalk.red;
          console.log(`  Last cycle: ${cycleColor(ageStr)}  (${new Date(lastCycleAt).toLocaleTimeString()})`);
        } else {
          console.log(`  Last cycle: ${chalk.dim("never")}`);
        }
      } catch {
        // DB not available on first run
      }

      // ── 2. Agent container + liveness status ─────────────────────────────
      console.log(chalk.bold("\n● Agents"));
      const agentNames = Object.keys(config.agents);
      const management = new ManagementClient(config.proxy);

      let liveStatus: Map<string, { status: string }> | null = null;
      try {
        const reachable = await management.isReachable();
        if (reachable) {
          const agents = await management.listAgents();
          liveStatus = new Map(agents.map((a) => [a.name, a]));
        }
      } catch {
        // management API offline
      }

      const healthMap = await pingAllAgents(config, agentNames, 3000);

      const containerColors: Record<string, (s: string) => string> = {
        running: chalk.green,
        starting: chalk.yellow,
        stopped: chalk.red,
        exited: chalk.red,
        unknown: chalk.dim,
        offline: chalk.dim,
      };

      for (const name of agentNames) {
        const live = liveStatus?.get(name);
        const containerStatus = live?.status ?? (liveStatus === null ? "proxy-offline" : "not-created");
        const colorFn = containerColors[containerStatus] ?? chalk.dim;
        const containerStr = colorFn(containerStatus.padEnd(14));

        const health = healthMap.get(name);
        let healthStr = chalk.dim("— (no port)");
        if (health) {
          if (health.status === "alive") {
            const latency = health.latencyMs !== null ? chalk.green(`${health.latencyMs}ms`) : "";
            healthStr = `${chalk.green("✓ alive")}  ${latency}`;
          } else if (health.status === "unreachable") {
            healthStr = chalk.red("✗ unreachable");
          }
        }

        console.log(`  ${chalk.cyan(name.padEnd(32))} ${containerStr} ${healthStr}`);
      }

      // ── 3. Task counts (last 24h) ─────────────────────────────────────────
      console.log(chalk.bold("\n● Tasks (last 24h)"));
      let agentFailures: Array<{ agent_name: string; failed: number }> = [];
      let unverified = 0;
      try {
        const store = new StateStore();
        const counts = store.getTaskStatusCountsLastHours(24);
        agentFailures = store.getAgentsWithRecentFailures(24, 1);
        unverified = store.countUnverified();
        store.close();

        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        const row = (label: string, value: number, colorFn: (s: string) => string) =>
          `  ${label.padEnd(14)} ${colorFn(String(value).padStart(4))}`;

        console.log(row("done", counts.done ?? 0, chalk.green));
        console.log(
          row("in_progress", counts.in_progress ?? 0, (counts.in_progress ?? 0) > 0 ? chalk.cyan : chalk.dim),
        );
        console.log(
          row("dispatched", counts.dispatched ?? 0, (counts.dispatched ?? 0) > 0 ? chalk.blue : chalk.dim),
        );
        console.log(row("pending", counts.pending ?? 0, (counts.pending ?? 0) > 0 ? chalk.yellow : chalk.dim));
        console.log(row("planning", counts.planning ?? 0, (counts.planning ?? 0) > 0 ? chalk.magenta : chalk.dim));
        console.log(row("failed", counts.failed ?? 0, (counts.failed ?? 0) > 0 ? chalk.red : chalk.dim));
        console.log(`  ${"─".repeat(20)}`);
        console.log(row("total", total, chalk.white));
        console.log(
          `  unverified:    ${unverified > 0 ? chalk.yellow(String(unverified).padStart(4)) : chalk.dim("   0")}`,
        );

        // ── 4. Alerts ───────────────────────────────────────────────────────
        const alerts: string[] = [];

        if (!running) {
          alerts.push(chalk.red("Daemon is not running — autonomous loop is stopped"));
        }

        for (const { agent_name, failed } of agentFailures) {
          alerts.push(chalk.red(`${agent_name} has ${failed} failed tasks in the last 24h`));
        }

        if (unverified >= 10) {
          alerts.push(
            chalk.yellow(`High verification lag: ${unverified} unverified tasks — run \`orch improve verify\``),
          );
        }

        if ((counts.dispatched ?? 0) >= 3) {
          alerts.push(chalk.yellow(`${counts.dispatched} tasks stuck in "dispatched" — possible agent stall`));
        }

        console.log(chalk.bold("\n● Alerts"));
        if (alerts.length > 0) {
          for (const alert of alerts) {
            console.log(`  ⚠  ${alert}`);
          }
        } else {
          console.log(`  ${chalk.green("✓ No alerts")}`);
        }
      } catch {
        console.log(chalk.dim("  (state DB unavailable)"));

        // Still show alerts for daemon status
        console.log(chalk.bold("\n● Alerts"));
        if (!running) {
          console.log(`  ⚠  ${chalk.red("Daemon is not running — autonomous loop is stopped")}`);
        } else {
          console.log(`  ${chalk.green("✓ No alerts")}`);
        }
      }

      // ── 5. Open PRs ───────────────────────────────────────────────────────
      console.log(chalk.bold("\n● Open PRs awaiting review"));
      const repos = Object.values(config.agents)
        .filter((a) => a.github)
        .map((a) => a.github!);
      const uniqueRepos = [...new Set(repos)];

      if (uniqueRepos.length === 0) {
        console.log(chalk.dim("  No agent repos configured."));
      } else {
        const openPRs = listOpenPRs(uniqueRepos);
        if (openPRs.length === 0) {
          console.log(`  ${chalk.green("✓ No open PRs")}`);
        } else {
          for (const pr of openPRs) {
            console.log(`  ${chalk.dim(pr.repo)}  ${chalk.cyan(`#${pr.number}`)}  ${pr.title}`);
          }
        }
      }

      console.log(); // trailing newline
    });
}
