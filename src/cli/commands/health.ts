import { execSync } from "node:child_process";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { isRunning, readPid } from "../../service/pid.js";
import { StateStore, type RetryMetrics } from "../../state/store.js";
import { ManagementClient } from "../../client/management-client.js";
import { pingAllAgents } from "./agents.js";
import { TIMEOUT_MAX_RETRIES } from "../../service/daemon.js";
import { validateGhAuth } from "../../triggers/github.js";

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

/**
 * Count branches on a repo that have no open PR (orphan branches).
 * Excludes the default branches (main/master).
 */
function countOrphanBranches(repo: string): number {
  try {
    // List all remote branches (excluding main/master)
    const branchOutput = execSync(
      `gh api repos/${repo}/branches --jq '[.[].name] | map(select(. != "main" and . != "master")) | .[]'`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const remoteBranches = branchOutput
      .split("\n")
      .map((b) => b.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);

    if (remoteBranches.length === 0) return 0;

    // List all open PR branches on the same repo
    const prOutput = execSync(
      `gh pr list --repo ${repo} --state open --json headRefName --jq '.[].headRefName'`,
      { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const prBranches = new Set(
      prOutput
        .split("\n")
        .map((b) => b.trim().replace(/^"|"$/g, ""))
        .filter(Boolean),
    );

    return remoteBranches.filter((b) => !prBranches.has(b)).length;
  } catch {
    return 0;
  }
}

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description(
      "Unified system health snapshot: daemon, GitHub auth, agents, tasks (24h), timeout rates, open PRs, orphan branches, and alerts",
    )
    .action(async () => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);

      // Track whether any critical subsystem is degraded (for non-zero exit).
      let hasCriticalFailure = false;

      // ── 1. Daemon status ──────────────────────────────────────────────────
      console.log(chalk.bold("\n● Daemon"));
      const pid = readPid();
      const running = isRunning();
      if (running && pid) {
        console.log(`  ${chalk.green("✓ running")}  PID ${pid}`);
      } else if (pid && !running) {
        console.log(`  ${chalk.yellow("⚠ stale PID")}  (process ${pid} not found)`);
        hasCriticalFailure = true;
      } else {
        console.log(`  ${chalk.red("✗ not running")}`);
        hasCriticalFailure = true;
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

      // ── 2. GitHub auth status ─────────────────────────────────────────────
      console.log(chalk.bold("\n● GitHub Auth"));
      const ghAuth = validateGhAuth();
      if (ghAuth.ok) {
        console.log(`  ${chalk.green("✓ authenticated")}`);
      } else {
        hasCriticalFailure = true;
        console.log(`  ${chalk.red("✗ not authenticated")}`);
        if (ghAuth.reason) {
          console.log(`  ${chalk.dim(ghAuth.reason)}`);
        }
      }

      // ── 3. Agent container + liveness status ─────────────────────────────
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

      // ── 4. Task counts (last 24h) ─────────────────────────────────────────
      console.log(chalk.bold("\n● Tasks (last 24h)"));
      let agentFailures: Array<{ agent_name: string; failed: number }> = [];
      let unverified = 0;
      let retryMetrics: RetryMetrics | null = null;
      // Number of exhausted-budget occurrences per agent that triggers an alert.
      const RETRY_BUDGET_ALERT_THRESHOLD = 3;
      // Timeout rate percentage thresholds for colour coding.
      const TIMEOUT_RATE_WARN_PCT = 10;
      const TIMEOUT_RATE_CRITICAL_PCT = 25;

      let counts: Record<string, number> = {};
      // Agent timeout rate map (agent_name → 24h/7d rates). Populated inside the try block
      // so it's available in the alerts section.
      type TimeoutEntry = {
        rate24h: number | null;
        rate7d: number | null;
        timedOut24h: number;
        timedOut7d: number;
        total24h: number;
        total7d: number;
      };
      const agentTimeoutMap = new Map<string, TimeoutEntry>();

      try {
        const store = new StateStore();
        counts = store.getTaskStatusCountsLastHours(24);
        agentFailures = store.getAgentsWithRecentFailures(24, 1);
        unverified = store.countUnverified();
        retryMetrics = store.getRetryMetrics(24);

        // Timeout rates (reuse same store instance)
        const timeoutRates24h = store.getTimeoutRates(24);
        const timeoutRates7d = store.getTimeoutRates(168); // 7 * 24
        store.close();

        for (const r of timeoutRates24h) {
          agentTimeoutMap.set(r.agent_name, {
            rate24h: r.timeout_rate_pct,
            timedOut24h: r.timed_out_tasks,
            total24h: r.total_tasks,
            rate7d: null,
            timedOut7d: 0,
            total7d: 0,
          });
        }
        for (const r of timeoutRates7d) {
          const existing = agentTimeoutMap.get(r.agent_name);
          if (existing) {
            existing.rate7d = r.timeout_rate_pct;
            existing.timedOut7d = r.timed_out_tasks;
            existing.total7d = r.total_tasks;
          } else {
            agentTimeoutMap.set(r.agent_name, {
              rate24h: null,
              timedOut24h: 0,
              total24h: 0,
              rate7d: r.timeout_rate_pct,
              timedOut7d: r.timed_out_tasks,
              total7d: r.total_tasks,
            });
          }
        }

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

        // ── 5. Timeout rates per agent (24h and 7d) ───────────────────────────
        console.log(chalk.bold("\n● Timeout Rates (exit-code-143 / SIGTERM)"));

        const agentsWithTimeouts = [...agentTimeoutMap.entries()].filter(
          ([, v]) => v.timedOut24h > 0 || v.timedOut7d > 0,
        );

        if (agentsWithTimeouts.length === 0) {
          console.log(`  ${chalk.green("✓ No timeouts in the last 7 days")}`);
        } else {
          console.log(
            `\n  ${"Agent".padEnd(32)} ${"24h rate".padStart(8)} ${"24h n/t".padStart(8)} ${"7d rate".padStart(8)} ${"7d n/t".padStart(8)}`,
          );
          console.log(`  ${"─".repeat(68)}`);

          const formatRate = (pct: number | null): string => {
            if (pct === null) return chalk.dim("      — ");
            const s = `${pct.toFixed(1)}%`.padStart(7);
            if (pct >= TIMEOUT_RATE_CRITICAL_PCT) return chalk.red(s) + " ";
            if (pct >= TIMEOUT_RATE_WARN_PCT) return chalk.yellow(s) + " ";
            return chalk.green(s) + " ";
          };

          const formatNt = (n: number, t: number): string => {
            if (t === 0) return chalk.dim("   —/— ");
            return chalk.dim(`${n}/${t}`.padStart(6)) + " ";
          };

          for (const [agentName, v] of [...agentTimeoutMap.entries()].sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            if (v.timedOut24h === 0 && v.timedOut7d === 0) continue;
            console.log(
              `  ${chalk.cyan(agentName.padEnd(32))}` +
                ` ${formatRate(v.rate24h)}` +
                ` ${formatNt(v.timedOut24h, v.total24h)}` +
                ` ${formatRate(v.rate7d)}` +
                ` ${formatNt(v.timedOut7d, v.total7d)}`,
            );
          }
        }

        // ── 6. Retry budget (last 24h) ────────────────────────────────────────
        console.log(chalk.bold("\n● Retries (last 24h)"));
        console.log(
          `  Max retries per task: ${chalk.dim(String(TIMEOUT_MAX_RETRIES))}   ` +
            `Budget alert threshold: ${chalk.dim(`${RETRY_BUDGET_ALERT_THRESHOLD}+ exhausted tasks`)}`,
        );

        if (retryMetrics.per_agent.length === 0 && retryMetrics.total_waiting === 0) {
          console.log(`  ${chalk.green("✓ No retries in the last 24h")}`);
        } else {
          // Header
          console.log(
            `\n  ${"Agent".padEnd(32)} ${"Retried".padStart(7)} ${"Attempts".padStart(8)} ${"Waiting".padStart(7)} ${"Exhausted".padStart(9)}`,
          );
          console.log(`  ${"─".repeat(67)}`);

          for (const a of retryMetrics.per_agent) {
            const exhaustedColor = a.exhausted_budget >= RETRY_BUDGET_ALERT_THRESHOLD ? chalk.red : chalk.yellow;
            const waitingColor = a.waiting_retry > 0 ? chalk.cyan : chalk.dim;
            console.log(
              `  ${chalk.cyan(a.agent_name.padEnd(32))}` +
                ` ${chalk.yellow(String(a.retried_tasks).padStart(7))}` +
                ` ${chalk.yellow(String(a.total_retries).padStart(8))}` +
                ` ${waitingColor(String(a.waiting_retry).padStart(7))}` +
                ` ${a.exhausted_budget > 0 ? exhaustedColor(String(a.exhausted_budget).padStart(9)) : chalk.dim("        0")}`,
            );
          }

          // If there are waiting tasks but no per-agent breakdown (e.g. old tasks)
          if (retryMetrics.total_waiting > 0 && retryMetrics.per_agent.every((a) => a.waiting_retry === 0)) {
            console.log(
              `\n  ${chalk.cyan(String(retryMetrics.total_waiting))} task(s) in backoff from before the 24h window`,
            );
          }

          console.log(`\n  ${"─".repeat(20)}`);
          console.log(
            `  ${"Waiting for retry:".padEnd(22)} ${retryMetrics.total_waiting > 0 ? chalk.cyan(String(retryMetrics.total_waiting)) : chalk.dim("0")}`,
          );
          console.log(
            `  ${"Budget exhausted:".padEnd(22)} ${retryMetrics.total_exhausted > 0 ? chalk.red(String(retryMetrics.total_exhausted)) : chalk.dim("0")}`,
          );
        }

        // ── 7. Alerts ───────────────────────────────────────────────────────
        const alerts: string[] = [];

        if (!running) {
          alerts.push(chalk.red("Daemon is not running — autonomous loop is stopped"));
        }

        if (!ghAuth.ok) {
          alerts.push(
            chalk.red(
              `GitHub auth degraded — dispatch will be blocked: ${ghAuth.reason ?? "unknown reason"}`,
            ),
          );
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

        // Retry budget alerts
        for (const a of retryMetrics.per_agent) {
          if (a.exhausted_budget >= RETRY_BUDGET_ALERT_THRESHOLD) {
            alerts.push(
              chalk.red(
                `${a.agent_name} exhausted retry budget on ${a.exhausted_budget} tasks in 24h — ` +
                  `possibly overloaded or network-flaky (max ${TIMEOUT_MAX_RETRIES} retries/task)`,
              ),
            );
          }
        }

        if (retryMetrics.total_waiting > 0) {
          alerts.push(
            chalk.yellow(
              `${retryMetrics.total_waiting} task(s) currently waiting in retry backoff — ` +
                `daemon will re-dispatch when backoff elapses`,
            ),
          );
        }

        // Timeout rate alerts (per agent, 24h window)
        for (const [agentName, v] of agentTimeoutMap.entries()) {
          if (v.rate24h !== null && v.rate24h >= TIMEOUT_RATE_CRITICAL_PCT) {
            alerts.push(
              chalk.red(
                `${agentName} timeout rate is ${v.rate24h.toFixed(1)}% in 24h (${v.timedOut24h}/${v.total24h} tasks) — ` +
                  `consider increasing timeout or splitting tasks`,
              ),
            );
          } else if (v.rate24h !== null && v.rate24h >= TIMEOUT_RATE_WARN_PCT) {
            alerts.push(
              chalk.yellow(
                `${agentName} timeout rate is ${v.rate24h.toFixed(1)}% in 24h (${v.timedOut24h}/${v.total24h} tasks)`,
              ),
            );
          }
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

        // Still show alerts for daemon + auth status
        console.log(chalk.bold("\n● Alerts"));
        const fallbackAlerts: string[] = [];
        if (!running) {
          fallbackAlerts.push(chalk.red("Daemon is not running — autonomous loop is stopped"));
        }
        if (!ghAuth.ok) {
          fallbackAlerts.push(
            chalk.red(
              `GitHub auth degraded — dispatch will be blocked: ${ghAuth.reason ?? "unknown reason"}`,
            ),
          );
        }
        if (fallbackAlerts.length > 0) {
          for (const alert of fallbackAlerts) {
            console.log(`  ⚠  ${alert}`);
          }
        } else {
          console.log(`  ${chalk.green("✓ No alerts")}`);
        }
      }

      // ── 8. Open PRs ───────────────────────────────────────────────────────
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

      // ── 9. Orphan branches (no open PR) ──────────────────────────────────
      console.log(chalk.bold("\n● Orphan branches (no open PR)"));
      if (uniqueRepos.length === 0) {
        console.log(chalk.dim("  No agent repos configured."));
      } else {
        let totalOrphans = 0;
        for (const repo of uniqueRepos) {
          const orphanCount = countOrphanBranches(repo);
          totalOrphans += orphanCount;
          if (orphanCount > 0) {
            console.log(
              `  ${chalk.dim(repo)}  ${chalk.yellow(`${orphanCount} orphan branch${orphanCount === 1 ? "" : "es"}`)}  ` +
                chalk.dim("(run `orch review` to create PRs)"),
            );
          }
        }
        if (totalOrphans === 0) {
          console.log(`  ${chalk.green("✓ No orphan branches")}`);
        }
      }

      console.log(); // trailing newline

      // Exit non-zero if any critical subsystem is degraded.
      if (hasCriticalFailure) {
        process.exit(1);
      }
    });
}
