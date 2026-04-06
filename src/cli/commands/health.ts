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
import { notifyOperator } from "../../service/notify.js";
import {
  buildBudgetStatuses,
  renderBar,
  formatTokens,
  type AgentBudgetStatus,
} from "./budget.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentSnapshot {
  containerStatus: string;
  healthStatus: "alive" | "unreachable" | "no-port";
  latencyMs: number | null;
  ghAuthOk: boolean | null; // null = unable to determine (container not running)
}

interface TimeoutEntry {
  rate24h: number | null;
  timedOut24h: number;
  total24h: number;
  rate7d: number | null;
  timedOut7d: number;
  total7d: number;
}

export interface HealthSnapshot {
  timestamp: Date;
  daemonRunning: boolean;
  daemonPid: number | null;
  lastCycleAt: string | null;
  lastCycleAgeMs: number | null;
  ghAuthOk: boolean;
  ghAuthReason: string | null;
  /** Number of running agent containers missing GH_TOKEN / gh auth. */
  agentGhAuthFailures: number;
  agents: Map<string, AgentSnapshot>;
  taskCounts: Record<string, number>;
  unverified: number;
  agentTimeoutMap: Map<string, TimeoutEntry>;
  retryMetrics: RetryMetrics | null;
  openPRs: Array<{ repo: string; number: number; title: string }>;
  orphansByRepo: Map<string, number>;
  alerts: string[]; // plain text, no chalk for diffing
  hasCriticalFailure: boolean;
  dbUnavailable: boolean;
  /** Per-agent budget utilization (24h window). Empty when DB unavailable. */
  budgetStatuses: Map<string, AgentBudgetStatus>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    const branchOutput = execSync(
      `gh api repos/${repo}/branches --jq '[.[].name] | map(select(. != "main" and . != "master")) | .[]'`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const remoteBranches = branchOutput
      .split("\n")
      .map((b) => b.trim().replace(/^"|"$/g, ""))
      .filter(Boolean);

    if (remoteBranches.length === 0) return 0;

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

/** Parse an interval string like "30s", "2m", "90" (bare number = seconds). */
export function parseIntervalMs(val: string): number {
  const match = val.match(/^(\d+)(s|m)?$/);
  if (!match) {
    throw new Error(`Invalid interval "${val}". Use formats like "30s", "2m", or "60" (seconds).`);
  }
  const n = parseInt(match[1], 10);
  const unit = match[2] ?? "s";
  if (unit === "m") return n * 60 * 1000;
  return n * 1000;
}

// ── Snapshot gathering ────────────────────────────────────────────────────────

async function gatherHealthSnapshot(
  config: ReturnType<typeof loadConfig>,
  agentNames: string[],
  uniqueRepos: string[],
): Promise<HealthSnapshot> {
  const TIMEOUT_RATE_WARN_PCT = 10;
  const TIMEOUT_RATE_CRITICAL_PCT = 25;
  const RETRY_BUDGET_ALERT_THRESHOLD = 3;

  // 1. Daemon
  const pid = readPid();
  const running = isRunning();
  let lastCycleAt: string | null = null;
  let lastCycleAgeMs: number | null = null;

  // 2. GitHub auth
  const ghAuth = validateGhAuth();

  // 3. Agents
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

  const agents = new Map<string, AgentSnapshot>();
  let agentGhAuthFailures = 0;
  for (const name of agentNames) {
    const live = liveStatus?.get(name);
    const containerStatus = live?.status ?? (liveStatus === null ? "proxy-offline" : "not-created");
    const health = healthMap.get(name);
    let healthStatus: "alive" | "unreachable" | "no-port" = "no-port";
    let latencyMs: number | null = null;
    if (health) {
      if (health.status === "alive") {
        healthStatus = "alive";
        latencyMs = health.latencyMs ?? null;
      } else {
        healthStatus = "unreachable";
      }
    }

    // Check if the agent container has GH_TOKEN configured via the proxy.
    // A running container without ghToken will fail `gh pr create` etc.
    let ghAuthOk: boolean | null = null;
    if (live && containerStatus === "running") {
      ghAuthOk = !!(live as { ghToken?: string }).ghToken;
      if (!ghAuthOk) agentGhAuthFailures++;
    }

    agents.set(name, { containerStatus, healthStatus, latencyMs, ghAuthOk });
  }

  // 4 & 5. Tasks + timeouts + retries + token budgets from DB
  let taskCounts: Record<string, number> = {};
  let unverified = 0;
  let agentTimeoutMap = new Map<string, TimeoutEntry>();
  let retryMetrics: RetryMetrics | null = null;
  let agentFailures: Array<{ agent_name: string; failed: number }> = [];
  let dbUnavailable = false;
  let budgetStatuses = new Map<string, AgentBudgetStatus>();

  try {
    const store = new StateStore();
    const metrics = store.getMetrics();
    lastCycleAt = metrics.cycles.last_cycle_at ?? null;
    if (lastCycleAt) {
      lastCycleAgeMs = Date.now() - new Date(lastCycleAt).getTime();
    }

    taskCounts = store.getTaskStatusCountsLastHours(24);
    agentFailures = store.getAgentsWithRecentFailures(24, 1);
    unverified = store.countUnverified();
    retryMetrics = store.getRetryMetrics(24);

    // Token budget utilization (24h window)
    const tokenUsage = store.getAgentTokenUsage(24);
    const budgetList = buildBudgetStatuses(config, tokenUsage, "daily");
    for (const s of budgetList) {
      budgetStatuses.set(s.agent_name, s);
    }

    const timeoutRates24h = store.getTimeoutRates(24);
    const timeoutRates7d = store.getTimeoutRates(168);
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
  } catch {
    dbUnavailable = true;
  }

  // 6. Open PRs + orphan branches
  const openPRs = listOpenPRs(uniqueRepos);
  const orphansByRepo = new Map<string, number>();
  for (const repo of uniqueRepos) {
    const count = countOrphanBranches(repo);
    if (count > 0) orphansByRepo.set(repo, count);
  }

  // 7. Build alerts (plain text, no chalk — chalk applied at display time)
  const alerts: string[] = [];
  let hasCriticalFailure = false;

  if (!running) {
    hasCriticalFailure = true;
    alerts.push("CRITICAL: Daemon is not running — autonomous loop is stopped");
  }
  if (!ghAuth.ok) {
    hasCriticalFailure = true;
    alerts.push(
      `CRITICAL: GitHub auth degraded — dispatch will be blocked: ${ghAuth.reason ?? "unknown reason"}`,
    );
  }

  // Alert for agent containers missing GH_TOKEN
  if (agentGhAuthFailures > 0) {
    const failedAgents = [...agents.entries()]
      .filter(([, a]) => a.ghAuthOk === false)
      .map(([name]) => name);
    const severity = agentGhAuthFailures >= 3 ? "CRITICAL" : "WARN";
    if (severity === "CRITICAL") hasCriticalFailure = true;
    alerts.push(
      `${severity}: ${agentGhAuthFailures} agent container(s) missing GH_TOKEN — ` +
        `gh pr create will fail: ${failedAgents.join(", ")}`,
    );
  }
  if (pid && !running) {
    hasCriticalFailure = true;
    alerts.push(`CRITICAL: Stale PID file — process ${pid} not found`);
  }

  for (const { agent_name, failed } of agentFailures) {
    alerts.push(`${agent_name} has ${failed} failed tasks in the last 24h`);
  }

  if (unverified >= 10) {
    alerts.push(`High verification lag: ${unverified} unverified tasks — run \`orch improve verify\``);
  }

  if ((taskCounts.dispatched ?? 0) >= 3) {
    alerts.push(`${taskCounts.dispatched} tasks stuck in "dispatched" — possible agent stall`);
  }

  if (retryMetrics) {
    for (const a of retryMetrics.per_agent) {
      if (a.exhausted_budget >= RETRY_BUDGET_ALERT_THRESHOLD) {
        alerts.push(
          `${a.agent_name} exhausted retry budget on ${a.exhausted_budget} tasks in 24h ` +
            `(max ${TIMEOUT_MAX_RETRIES} retries/task)`,
        );
      }
    }
    if (retryMetrics.total_waiting > 0) {
      alerts.push(
        `${retryMetrics.total_waiting} task(s) currently waiting in retry backoff`,
      );
    }
  }

  for (const [agentName, v] of agentTimeoutMap.entries()) {
    if (v.rate24h !== null && v.rate24h >= TIMEOUT_RATE_CRITICAL_PCT) {
      alerts.push(
        `CRITICAL: ${agentName} timeout rate is ${v.rate24h.toFixed(1)}% in 24h (${v.timedOut24h}/${v.total24h} tasks)`,
      );
    } else if (v.rate24h !== null && v.rate24h >= TIMEOUT_RATE_WARN_PCT) {
      alerts.push(
        `WARN: ${agentName} timeout rate is ${v.rate24h.toFixed(1)}% in 24h (${v.timedOut24h}/${v.total24h} tasks)`,
      );
    }
  }

  // Budget alerts — fire Telegram notifications for exceeded agents
  const telegramPromises: Array<Promise<void>> = [];
  for (const [agentName, bs] of budgetStatuses.entries()) {
    if (bs.is_exceeded) {
      const usedStr = formatTokens(bs.used_tokens);
      const budgetStr = bs.budget_tokens !== null ? formatTokens(bs.budget_tokens) : "?";
      const pauseNote = bs.pause_on_exceeded ? " — new dispatches paused" : "";
      alerts.push(
        `CRITICAL: ${agentName} exceeded daily token budget (${usedStr} / ${budgetStr} tokens)${pauseNote}`,
      );
      hasCriticalFailure = true;
      telegramPromises.push(
        notifyOperator(
          `Token budget exceeded: ${agentName}`,
          `Agent "${agentName}" has used ${usedStr} of its ${budgetStr} daily token budget ` +
            `(${Math.round((bs.utilization ?? 1) * 100)}%)${pauseNote}.`,
          "critical",
          `budget-exceeded:${agentName}:daily`,
        ),
      );
    } else if (bs.is_warning) {
      const usedStr = formatTokens(bs.used_tokens);
      const budgetStr = bs.budget_tokens !== null ? formatTokens(bs.budget_tokens) : "?";
      alerts.push(
        `WARN: ${agentName} is at ${Math.round((bs.utilization ?? 0) * 100)}% of daily token budget (${usedStr} / ${budgetStr} tokens)`,
      );
    }
  }

  // Fire Telegram alerts asynchronously (don't block snapshot return)
  if (telegramPromises.length > 0) {
    Promise.all(telegramPromises).catch(() => { /* best-effort */ });
  }

  return {
    timestamp: new Date(),
    daemonRunning: running,
    daemonPid: pid ?? null,
    lastCycleAt,
    lastCycleAgeMs,
    ghAuthOk: ghAuth.ok,
    ghAuthReason: ghAuth.reason ?? null,
    agentGhAuthFailures,
    agents,
    taskCounts,
    unverified,
    agentTimeoutMap,
    retryMetrics,
    openPRs,
    orphansByRepo,
    alerts,
    hasCriticalFailure,
    dbUnavailable,
    budgetStatuses,
  };
}

// ── Full snapshot display ─────────────────────────────────────────────────────

function printHealthSnapshot(snap: HealthSnapshot): void {
  const TIMEOUT_MAX_RETRIES_LOCAL = TIMEOUT_MAX_RETRIES;
  const RETRY_BUDGET_ALERT_THRESHOLD = 3;
  const TIMEOUT_RATE_WARN_PCT = 10;
  const TIMEOUT_RATE_CRITICAL_PCT = 25;

  // 1. Daemon
  console.log(chalk.bold("\n● Daemon"));
  const { daemonRunning: running, daemonPid: pid } = snap;
  if (running && pid) {
    console.log(`  ${chalk.green("✓ running")}  PID ${pid}`);
  } else if (pid && !running) {
    console.log(`  ${chalk.yellow("⚠ stale PID")}  (process ${pid} not found)`);
  } else {
    console.log(`  ${chalk.red("✗ not running")}`);
  }

  if (snap.lastCycleAt && snap.lastCycleAgeMs !== null) {
    const ageMs = snap.lastCycleAgeMs;
    const ageMins = Math.floor(ageMs / 60000);
    const ageStr =
      ageMins < 1 ? "< 1 min ago" : ageMins < 60 ? `${ageMins}m ago` : `${Math.floor(ageMins / 60)}h ago`;
    const cycleColor = ageMs < 5 * 60 * 1000 ? chalk.green : ageMs < 15 * 60 * 1000 ? chalk.yellow : chalk.red;
    console.log(
      `  Last cycle: ${cycleColor(ageStr)}  (${new Date(snap.lastCycleAt).toLocaleTimeString()})`,
    );
  } else if (!snap.dbUnavailable) {
    console.log(`  Last cycle: ${chalk.dim("never")}`);
  }

  // 2. GitHub auth
  console.log(chalk.bold("\n● GitHub Auth"));
  if (snap.ghAuthOk) {
    console.log(`  ${chalk.green("✓ authenticated")}`);
  } else {
    console.log(`  ${chalk.red("✗ not authenticated")}`);
    if (snap.ghAuthReason) {
      console.log(`  ${chalk.dim(snap.ghAuthReason)}`);
    }
  }

  // 3. Agents
  console.log(chalk.bold("\n● Agents"));
  const containerColors: Record<string, (s: string) => string> = {
    running: chalk.green,
    starting: chalk.yellow,
    stopped: chalk.red,
    exited: chalk.red,
    unknown: chalk.dim,
    offline: chalk.dim,
  };

  for (const [name, agent] of snap.agents) {
    const colorFn = containerColors[agent.containerStatus] ?? chalk.dim;
    const containerStr = colorFn(agent.containerStatus.padEnd(14));

    let healthStr: string;
    if (agent.healthStatus === "alive") {
      const latency = agent.latencyMs !== null ? chalk.green(`${agent.latencyMs}ms`) : "";
      healthStr = `${chalk.green("✓ alive")}  ${latency}`;
    } else if (agent.healthStatus === "unreachable") {
      healthStr = chalk.red("✗ unreachable");
    } else {
      healthStr = chalk.dim("— (no port)");
    }

    let ghAuthStr = "";
    if (agent.ghAuthOk === true) {
      ghAuthStr = chalk.green("  gh ✓");
    } else if (agent.ghAuthOk === false) {
      ghAuthStr = chalk.red("  gh ✗ (no GH_TOKEN)");
    }

    console.log(`  ${chalk.cyan(name.padEnd(32))} ${containerStr} ${healthStr}${ghAuthStr}`);

    // Budget utilization bar (shown beneath the agent line when a budget is configured)
    const bs = snap.budgetStatuses.get(name);
    if (bs && bs.budget_tokens !== null) {
      const bar = renderBar(bs.utilization, bs.warning_pct, bs.critical_pct, 16);
      const pct = bs.utilization !== null ? `${Math.round(bs.utilization * 100)}%` : "—";
      const pctColored =
        bs.is_exceeded ? chalk.red(pct.padStart(4)) : bs.is_warning ? chalk.yellow(pct.padStart(4)) : chalk.green(pct.padStart(4));
      const usedStr = formatTokens(bs.used_tokens);
      const budgetStr = formatTokens(bs.budget_tokens);
      const pauseNote = bs.pause_on_exceeded && bs.is_exceeded ? chalk.red(" [PAUSED]") : "";
      console.log(
        `  ${chalk.dim("  └ budget (24h):")} ${bar} ${pctColored}  ${chalk.dim(usedStr + " / " + budgetStr)}${pauseNote}`,
      );
    }
  }

  if (snap.dbUnavailable) {
    console.log(chalk.bold("\n● Tasks (last 24h)"));
    console.log(chalk.dim("  (state DB unavailable)"));
  } else {
    // 4. Task counts
    console.log(chalk.bold("\n● Tasks (last 24h)"));
    const counts = snap.taskCounts;
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
      `  unverified:    ${snap.unverified > 0 ? chalk.yellow(String(snap.unverified).padStart(4)) : chalk.dim("   0")}`,
    );

    // 5. Timeout rates
    console.log(chalk.bold("\n● Timeout Rates (exit-code-143 / SIGTERM)"));
    const agentsWithTimeouts = [...snap.agentTimeoutMap.entries()].filter(
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

      for (const [agentName, v] of [...snap.agentTimeoutMap.entries()].sort(([a], [b]) =>
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

    // 6. Retry budget
    const rm = snap.retryMetrics;
    console.log(chalk.bold("\n● Retries (last 24h)"));
    console.log(
      `  Max retries per task: ${chalk.dim(String(TIMEOUT_MAX_RETRIES_LOCAL))}   ` +
        `Budget alert threshold: ${chalk.dim(`${RETRY_BUDGET_ALERT_THRESHOLD}+ exhausted tasks`)}`,
    );

    if (!rm || (rm.per_agent.length === 0 && rm.total_waiting === 0)) {
      console.log(`  ${chalk.green("✓ No retries in the last 24h")}`);
    } else {
      console.log(
        `\n  ${"Agent".padEnd(32)} ${"Retried".padStart(7)} ${"Attempts".padStart(8)} ${"Waiting".padStart(7)} ${"Exhausted".padStart(9)}`,
      );
      console.log(`  ${"─".repeat(67)}`);

      for (const a of rm.per_agent) {
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

      if (rm.total_waiting > 0 && rm.per_agent.every((a) => a.waiting_retry === 0)) {
        console.log(
          `\n  ${chalk.cyan(String(rm.total_waiting))} task(s) in backoff from before the 24h window`,
        );
      }

      console.log(`\n  ${"─".repeat(20)}`);
      console.log(
        `  ${"Waiting for retry:".padEnd(22)} ${rm.total_waiting > 0 ? chalk.cyan(String(rm.total_waiting)) : chalk.dim("0")}`,
      );
      console.log(
        `  ${"Budget exhausted:".padEnd(22)} ${rm.total_exhausted > 0 ? chalk.red(String(rm.total_exhausted)) : chalk.dim("0")}`,
      );
    }

    // 7. Alerts
    console.log(chalk.bold("\n● Alerts"));
    if (snap.alerts.length > 0) {
      for (const alert of snap.alerts) {
        const colorFn = alert.startsWith("CRITICAL:") ? chalk.red : chalk.yellow;
        console.log(`  ⚠  ${colorFn(alert)}`);
      }
    } else {
      console.log(`  ${chalk.green("✓ No alerts")}`);
    }
  }

  // 8. Open PRs
  console.log(chalk.bold("\n● Open PRs awaiting review"));
  if (snap.openPRs.length === 0) {
    console.log(`  ${chalk.green("✓ No open PRs")}`);
  } else {
    for (const pr of snap.openPRs) {
      console.log(`  ${chalk.dim(pr.repo)}  ${chalk.cyan(`#${pr.number}`)}  ${pr.title}`);
    }
  }

  // 9. Orphan branches
  console.log(chalk.bold("\n● Orphan branches (no open PR)"));
  const totalOrphans = [...snap.orphansByRepo.values()].reduce((a, b) => a + b, 0);
  if (totalOrphans === 0) {
    console.log(`  ${chalk.green("✓ No orphan branches")}`);
  } else {
    for (const [repo, count] of snap.orphansByRepo) {
      console.log(
        `  ${chalk.dim(repo)}  ${chalk.yellow(`${count} orphan branch${count === 1 ? "" : "es"}`)}  ` +
          chalk.dim("(run `orch review` to create PRs)"),
      );
    }
  }

  console.log(); // trailing newline
}

// ── Diff computation ──────────────────────────────────────────────────────────

export interface DiffLine {
  severity: "info" | "warn" | "critical";
  message: string;
}

export function computeDiff(prev: HealthSnapshot, curr: HealthSnapshot): DiffLine[] {
  const changes: DiffLine[] = [];

  // Daemon status
  if (prev.daemonRunning !== curr.daemonRunning) {
    if (curr.daemonRunning) {
      changes.push({ severity: "info", message: "daemon: stopped → running" });
    } else {
      changes.push({ severity: "critical", message: "daemon: running → STOPPED" });
    }
  }

  // GitHub auth
  if (prev.ghAuthOk !== curr.ghAuthOk) {
    if (curr.ghAuthOk) {
      changes.push({ severity: "info", message: "GitHub auth: degraded → OK" });
    } else {
      changes.push({
        severity: "critical",
        message: `GitHub auth: OK → DEGRADED (${curr.ghAuthReason ?? "unknown"})`,
      });
    }
  }

  // Agent container/health/auth status
  for (const [name, curr_agent] of curr.agents) {
    const prev_agent = prev.agents.get(name);
    if (!prev_agent) continue;
    if (prev_agent.containerStatus !== curr_agent.containerStatus) {
      const isBad = ["stopped", "exited", "not-created"].includes(curr_agent.containerStatus);
      changes.push({
        severity: isBad ? "warn" : "info",
        message: `agent ${name}: container ${prev_agent.containerStatus} → ${curr_agent.containerStatus}`,
      });
    }
    if (prev_agent.healthStatus !== curr_agent.healthStatus) {
      const isBad = curr_agent.healthStatus === "unreachable";
      changes.push({
        severity: isBad ? "warn" : "info",
        message: `agent ${name}: liveness ${prev_agent.healthStatus} → ${curr_agent.healthStatus}`,
      });
    }
    if (prev_agent.ghAuthOk !== curr_agent.ghAuthOk) {
      if (curr_agent.ghAuthOk === false) {
        changes.push({
          severity: "warn",
          message: `agent ${name}: GH_TOKEN lost — gh pr create will fail`,
        });
      } else if (curr_agent.ghAuthOk === true && prev_agent.ghAuthOk === false) {
        changes.push({
          severity: "info",
          message: `agent ${name}: GH_TOKEN restored`,
        });
      }
    }
  }

  // Task counts — report changes in done/failed/dispatched
  const taskKeys = ["done", "failed", "in_progress", "dispatched", "pending"] as const;
  for (const key of taskKeys) {
    const pv = prev.taskCounts[key] ?? 0;
    const cv = curr.taskCounts[key] ?? 0;
    if (pv !== cv) {
      const delta = cv - pv;
      const sign = delta > 0 ? "+" : "";
      const isBad = key === "failed" && delta > 0;
      changes.push({
        severity: isBad ? "warn" : "info",
        message: `tasks.${key}: ${pv} → ${cv} (${sign}${delta})`,
      });
    }
  }

  // Unverified
  if (prev.unverified !== curr.unverified) {
    const delta = curr.unverified - prev.unverified;
    const sign = delta > 0 ? "+" : "";
    changes.push({
      severity: curr.unverified >= 10 ? "warn" : "info",
      message: `unverified tasks: ${prev.unverified} → ${curr.unverified} (${sign}${delta})`,
    });
  }

  // Timeout rates (24h, per agent)
  const allAgents = new Set([...prev.agentTimeoutMap.keys(), ...curr.agentTimeoutMap.keys()]);
  for (const agent of allAgents) {
    const pv = prev.agentTimeoutMap.get(agent)?.rate24h ?? 0;
    const cv = curr.agentTimeoutMap.get(agent)?.rate24h ?? 0;
    if (Math.abs(pv - cv) >= 1) {
      // Only report changes >= 1 percentage point to avoid noise
      const isBad = cv > pv;
      const sign = cv > pv ? "↑" : "↓";
      changes.push({
        severity: cv >= 25 ? "critical" : cv >= 10 ? "warn" : "info",
        message: `${agent} timeout rate 24h: ${pv.toFixed(1)}% ${sign} ${cv.toFixed(1)}%`,
      });
    }
  }

  // Open PRs — new or closed
  const prevPRKeys = new Set(prev.openPRs.map((p) => `${p.repo}#${p.number}`));
  const currPRKeys = new Set(curr.openPRs.map((p) => `${p.repo}#${p.number}`));

  for (const pr of curr.openPRs) {
    const key = `${pr.repo}#${pr.number}`;
    if (!prevPRKeys.has(key)) {
      changes.push({ severity: "info", message: `new open PR: ${pr.repo} #${pr.number} "${pr.title}"` });
    }
  }
  for (const pr of prev.openPRs) {
    const key = `${pr.repo}#${pr.number}`;
    if (!currPRKeys.has(key)) {
      changes.push({ severity: "info", message: `PR closed/merged: ${pr.repo} #${pr.number} "${pr.title}"` });
    }
  }

  // Orphan branches
  const allRepos = new Set([...prev.orphansByRepo.keys(), ...curr.orphansByRepo.keys()]);
  for (const repo of allRepos) {
    const pv = prev.orphansByRepo.get(repo) ?? 0;
    const cv = curr.orphansByRepo.get(repo) ?? 0;
    if (pv !== cv) {
      const delta = cv - pv;
      const sign = delta > 0 ? "+" : "";
      changes.push({
        severity: delta > 0 ? "warn" : "info",
        message: `orphan branches ${repo}: ${pv} → ${cv} (${sign}${delta})`,
      });
    }
  }

  // Alerts — new alerts since last check
  const prevAlerts = new Set(prev.alerts);
  for (const alert of curr.alerts) {
    if (!prevAlerts.has(alert)) {
      const isCritical = alert.startsWith("CRITICAL:");
      changes.push({ severity: isCritical ? "critical" : "warn", message: `new alert: ${alert}` });
    }
  }
  // Resolved alerts
  const currAlerts = new Set(curr.alerts);
  for (const alert of prev.alerts) {
    if (!currAlerts.has(alert)) {
      changes.push({ severity: "info", message: `alert resolved: ${alert}` });
    }
  }

  return changes;
}

function printDiff(diff: DiffLine[], timestamp: Date): void {
  const ts = chalk.dim(`[${timestamp.toLocaleTimeString()}]`);

  if (diff.length === 0) {
    console.log(`${ts} ${chalk.dim("No changes since last check")}`);
    return;
  }

  const noun = diff.length === 1 ? "change" : "changes";
  console.log(`${ts} ${chalk.bold(`${diff.length} ${noun} detected`)}`);
  for (const line of diff) {
    let prefix: string;
    let colorFn: (s: string) => string;
    if (line.severity === "critical") {
      prefix = chalk.red("  ✗");
      colorFn = chalk.red;
    } else if (line.severity === "warn") {
      prefix = chalk.yellow("  ⚠");
      colorFn = chalk.yellow;
    } else {
      prefix = chalk.cyan("  →");
      colorFn = chalk.white;
    }
    console.log(`${prefix} ${colorFn(line.message)}`);
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerHealthCommand(program: Command): void {
  program
    .command("health")
    .description(
      "Unified system health snapshot: daemon, GitHub auth, agents, tasks (24h), timeout rates, open PRs, orphan branches, and alerts",
    )
    .option(
      "--watch [interval]",
      "Re-run health checks on an interval (default: 60s). Supports formats: 30s, 2m, 90. Prints a diff of what changed.",
    )
    .action(async (opts: { watch?: string | boolean }) => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);

      const agentNames = Object.keys(config.agents);
      const repos = Object.values(config.agents)
        .filter((a) => a.github)
        .map((a) => a.github!);
      const uniqueRepos = [...new Set(repos)];

      // Single-run mode (no --watch)
      if (opts.watch === undefined || opts.watch === false) {
        const snap = await gatherHealthSnapshot(config, agentNames, uniqueRepos);
        printHealthSnapshot(snap);
        if (snap.hasCriticalFailure) process.exit(1);
        return;
      }

      // Watch mode
      const intervalStr = typeof opts.watch === "string" ? opts.watch : "60s";
      let intervalMs: number;
      try {
        intervalMs = parseIntervalMs(intervalStr);
      } catch (err) {
        console.error(chalk.red(`Error: ${(err as Error).message}`));
        process.exit(1);
      }

      const intervalSecs = Math.round(intervalMs / 1000);
      console.log(
        chalk.bold(`\n⟳  orch health --watch`) +
          chalk.dim(` (interval: ${intervalSecs}s — press Ctrl+C to exit)\n`),
      );

      // Run first full snapshot + display
      let prevSnap = await gatherHealthSnapshot(config, agentNames, uniqueRepos);
      printHealthSnapshot(prevSnap);

      // Set up clean Ctrl+C handler
      let running = true;
      process.on("SIGINT", () => {
        running = false;
        console.log(chalk.dim("\n\nExiting watch mode.\n"));
        process.exit(0);
      });

      // Watch loop
      while (running) {
        await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
        if (!running) break;

        const currSnap = await gatherHealthSnapshot(config, agentNames, uniqueRepos);
        const diff = computeDiff(prevSnap, currSnap);
        printDiff(diff, currSnap.timestamp);
        prevSnap = currSnap;
      }
    });
}
