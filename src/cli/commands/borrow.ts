/**
 * `orch borrow` — show active cross-domain (borrowed) task assignments
 * and per-agent borrow eligibility.
 *
 * A "borrow" occurs when an agent is dispatched to work on an issue in a
 * GitHub repo it does not own (agent.github ≠ source_ref repo).  This command
 * surfaces:
 *   1. All currently in-flight borrowed tasks.
 *   2. Per-agent borrow eligibility (config, idle time, capacity).
 *
 * Issue #448: formalise agent-borrow policy with explicit rules and dashboard
 * visibility.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { loadConfig, type OrchestratorConfig } from "../../config/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function formatIdleTime(ms: number | null): string {
  if (ms === null) return chalk.dim("never active");
  if (ms < 60_000) return chalk.green("< 1m");
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

/** Short repo name: "rapartlu/agent-proxy" → "agent-proxy" */
function shortRepo(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

// ---------------------------------------------------------------------------
// Core display
// ---------------------------------------------------------------------------

function printBorrowStatus(config: OrchestratorConfig, store: StateStore): void {
  // Build a map from agent_name → agent's github repo for O(1) lookup
  const agentRepoMap = new Map<string, string>();
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.github) agentRepoMap.set(name, agent.github);
  }

  // 1. Active borrowed tasks
  const borrowed = store.getActiveBorrowedTasks(agentRepoMap);

  console.log(chalk.bold("\n● Active Agent Borrows\n"));

  if (borrowed.length === 0) {
    console.log(chalk.dim("  No active borrowed tasks. All agents are working within their own repos.\n"));
  } else {
    console.log(
      chalk.dim(
        `  ${"Agent".padEnd(36)} ${"Borrowed From".padEnd(28)} ${"Task".padEnd(10)} ${"Status".padEnd(14)} Age`,
      ),
    );
    console.log(chalk.dim("  " + "─".repeat(100)));

    for (const task of borrowed) {
      const agentRepo = task.agent_name ? agentRepoMap.get(task.agent_name) : undefined;
      const taskRepo = task.source_ref!.split("#")[0];
      const issueNum = task.source_ref!.split("#")[1] ?? "?";
      const borrowedFrom = `${shortRepo(taskRepo)}#${issueNum}`;
      const agent = chalk.cyan((task.agent_name ?? "unknown").padEnd(36));
      const from = chalk.yellow(borrowedFrom.padEnd(28));

      const statusColors: Record<string, (s: string) => string> = {
        pending: chalk.yellow,
        planning: chalk.magenta,
        dispatched: chalk.blue,
        in_progress: chalk.cyan,
      };
      const colorFn = statusColors[task.status] ?? chalk.white;
      const status = colorFn(task.status.padEnd(14));

      const agentOwnRepo = agentRepo ? shortRepo(agentRepo) : "?";
      const taskId = chalk.dim(task.id.slice(0, 10));
      const age = formatAge(task.created_at);

      console.log(`  ${agent} ${from} ${taskId} ${status} ${chalk.dim(age)}`);
      console.log(
        `  ${" ".repeat(36)} ${chalk.dim(`(agent owns ${agentOwnRepo})`)}`,
      );
    }
    console.log();
  }

  // 2. Borrow eligibility per agent
  console.log(chalk.bold("  Borrow Eligibility\n"));
  console.log(
    chalk.dim(
      `  ${"Agent".padEnd(36)} ${"Policy".padEnd(24)} ${"Idle".padEnd(10)} ${"Active Borrows".padEnd(16)} Repos`,
    ),
  );
  console.log(chalk.dim("  " + "─".repeat(120)));

  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue; // skip pool codex mirrors with no own repo

    const borrow = agent.borrow;
    const idleMs = store.getAgentIdleSinceMs(name);
    const agentRepo = agent.github;
    const activeBorrowed = store.countActiveBorrowedTasks(name, agentRepo);
    const maxConcurrent = borrow?.max_concurrent_borrowed ?? 1;

    let policyLabel: string;
    let eligible = true;
    let eligibleReason = "";

    if (!borrow?.enabled) {
      policyLabel = chalk.dim("not configured");
      eligible = true; // legacy: ad-hoc borrows allowed
      eligibleReason = "ad-hoc (no policy)";
    } else {
      const allowList = borrow.can_work_on;
      const reposLabel = allowList ? allowList.map(shortRepo).join(", ") : "any";
      policyLabel = chalk.green("enabled");

      // Check eligibility
      const minIdleMs = (borrow.min_idle_minutes ?? 0) * 60_000;
      if (minIdleMs > 0 && (idleMs === null || idleMs < minIdleMs)) {
        eligible = false;
        const actualMin = idleMs !== null ? Math.floor(idleMs / 60_000) : 0;
        eligibleReason = `not idle long enough (${actualMin}m / ${borrow.min_idle_minutes}m required)`;
      } else if (activeBorrowed >= maxConcurrent) {
        eligible = false;
        eligibleReason = `at borrow limit (${activeBorrowed}/${maxConcurrent})`;
      } else {
        eligibleReason = `eligible (${reposLabel})`;
      }
    }

    const borrowCountLabel = borrow?.enabled
      ? (activeBorrowed >= maxConcurrent
          ? chalk.red(`${activeBorrowed}/${maxConcurrent} (FULL)`)
          : chalk.green(`${activeBorrowed}/${maxConcurrent}`))
      : chalk.dim("—");

    const eligibilityLabel = borrow?.enabled
      ? (eligible ? chalk.green("✓ " + eligibleReason) : chalk.yellow("✗ " + eligibleReason))
      : chalk.dim(eligibleReason);

    const allowedRepos = borrow?.can_work_on?.map(shortRepo).join(", ") ?? (borrow?.enabled ? "any" : "—");

    console.log(
      `  ${chalk.cyan(name.padEnd(36))} ${policyLabel.padEnd(24)} ${formatIdleTime(idleMs).padEnd(10)} ${borrowCountLabel.padEnd(16)} ${allowedRepos}`,
    );
    if (borrow?.enabled) {
      console.log(`  ${" ".repeat(36)} ${eligibilityLabel}`);
    }
  }

  console.log();
}

function printBorrowStatusJson(config: OrchestratorConfig, store: StateStore): void {
  const agentRepoMap = new Map<string, string>();
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.github) agentRepoMap.set(name, agent.github);
  }

  const borrowed = store.getActiveBorrowedTasks(agentRepoMap);

  const eligibility = Object.entries(config.agents)
    .filter(([, a]) => a.github)
    .map(([name, agent]) => {
      const borrow = agent.borrow;
      const idleMs = store.getAgentIdleSinceMs(name);
      const activeBorrowed = store.countActiveBorrowedTasks(name, agent.github!);
      const maxConcurrent = borrow?.max_concurrent_borrowed ?? 1;
      const minIdleMs = (borrow?.min_idle_minutes ?? 0) * 60_000;
      const eligible = borrow?.enabled
        ? (idleMs !== null && idleMs >= minIdleMs) && activeBorrowed < maxConcurrent
        : true;

      return {
        agentName: name,
        agentRepo: agent.github,
        borrowEnabled: borrow?.enabled ?? false,
        canWorkOn: borrow?.can_work_on ?? null,
        minIdleMinutes: borrow?.min_idle_minutes ?? 0,
        maxConcurrentBorrowed: maxConcurrent,
        idleMs,
        activeBorrowedCount: activeBorrowed,
        eligible,
      };
    });

  console.log(
    JSON.stringify(
      {
        activeBorrows: borrowed.map((t) => ({
          taskId: t.id,
          agentName: t.agent_name,
          agentRepo: t.agent_name ? agentRepoMap.get(t.agent_name) : null,
          taskRepo: t.source_ref?.split("#")[0],
          sourceRef: t.source_ref,
          status: t.status,
          title: t.title,
          createdAt: t.created_at,
        })),
        eligibility,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBorrowCommand(program: Command): void {
  program
    .command("borrow")
    .description(
      "Show active cross-domain (borrowed) task assignments and per-agent borrow eligibility",
    )
    .option("--json", "Output raw JSON")
    .action((opts: { json?: boolean }) => {
      let config: OrchestratorConfig;
      try {
        config = loadConfig(program.opts().config);
      } catch (err) {
        console.error(
          chalk.red("Could not load config:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      const store = new StateStore();
      try {
        if (opts.json) {
          printBorrowStatusJson(config, store);
        } else {
          printBorrowStatus(config, store);
        }
      } finally {
        store.close();
      }
    });
}
