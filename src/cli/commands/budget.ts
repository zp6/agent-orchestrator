import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type AgentTokenUsage } from "../../state/store.js";
import { loadConfig, type OrchestratorConfig, type TokenBudgetConfig } from "../../config/schema.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_WARNING_PCT = 80;
export const DEFAULT_CRITICAL_PCT = 100;
export const BAR_WIDTH = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type BudgetPeriod = "daily" | "weekly";

export interface AgentBudgetStatus {
  agent_name: string;
  period: BudgetPeriod;
  /** Total tokens consumed in the window */
  used_tokens: number;
  /** Input tokens in the window */
  input_tokens: number;
  /** Output tokens in the window */
  output_tokens: number;
  /** Configured budget for the period, or null if none set */
  budget_tokens: number | null;
  /** Utilization 0–∞ as a fraction (1.0 = 100%). null when no budget set. */
  utilization: number | null;
  /** Warning threshold % (0–100) */
  warning_pct: number;
  /** Critical threshold % (0–100+) */
  critical_pct: number;
  /** true when utilization >= critical_pct / 100 */
  is_exceeded: boolean;
  /** true when utilization >= warning_pct / 100 (but below critical) */
  is_warning: boolean;
  /** true if dispatch should be paused when exceeded */
  pause_on_exceeded: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a large token count compactly: 1_234_567 → "1.23M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Render a utilization bar of `width` chars, color-coded by severity. */
export function renderBar(
  utilization: number | null,
  warnPct: number,
  critPct: number,
  width = BAR_WIDTH,
): string {
  if (utilization === null) return chalk.dim("─".repeat(width));

  const filled = Math.min(Math.round(utilization * width), width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const pct = utilization * 100;

  if (pct >= critPct) return chalk.red(bar);
  if (pct >= warnPct) return chalk.yellow(bar);
  return chalk.green(bar);
}

/** Status badge: ✓ OK / ⚠ WARNING / 🚨 EXCEEDED */
export function badge(status: AgentBudgetStatus): string {
  if (status.is_exceeded) return chalk.red("🚨 EXCEEDED");
  if (status.is_warning) return chalk.yellow("⚠  WARNING");
  if (status.budget_tokens !== null) return chalk.green("✓  OK");
  return chalk.dim("no budget");
}

/** Resolve the effective budget & thresholds for an agent from config. */
export function resolveAgentBudget(
  config: OrchestratorConfig,
  agentName: string,
  period: BudgetPeriod,
): { budget: number | null; warnPct: number; critPct: number; pauseOnExceeded: boolean } {
  const agentCfg = config.agents[agentName];
  const tb: TokenBudgetConfig | undefined = agentCfg?.token_budget;
  const globalBudget = config.dashboard?.budget;

  // Budget: per-agent override → provider-level daily_token_limit (daily only)
  let budget: number | null = null;
  if (period === "daily") {
    budget = tb?.daily ?? null;
    if (budget === null) {
      const providerName = agentCfg?.provider ?? "claude";
      budget = config.providers?.[providerName]?.daily_token_limit ?? null;
    }
  } else {
    budget = tb?.weekly ?? null;
  }

  const warnPct = tb?.warning_pct ?? globalBudget?.warning_pct ?? DEFAULT_WARNING_PCT;
  const critPct = tb?.critical_pct ?? globalBudget?.critical_pct ?? DEFAULT_CRITICAL_PCT;
  const pauseOnExceeded = tb?.pause_on_exceeded ?? false;

  return { budget, warnPct, critPct, pauseOnExceeded };
}

/** Build AgentBudgetStatus rows for all agents with usage or a configured budget. */
export function buildBudgetStatuses(
  config: OrchestratorConfig,
  usageRows: AgentTokenUsage[],
  period: BudgetPeriod,
): AgentBudgetStatus[] {
  const usageByAgent = new Map(usageRows.map((r) => [r.agent_name, r]));

  // Include every configured agent (even those with zero usage)
  const agentNames = new Set([
    ...Object.keys(config.agents),
    ...usageRows.map((r) => r.agent_name),
  ]);

  const statuses: AgentBudgetStatus[] = [];

  for (const name of agentNames) {
    const usage = usageByAgent.get(name);
    const usedTokens = usage?.total_tokens ?? 0;
    const { budget, warnPct, critPct, pauseOnExceeded } = resolveAgentBudget(config, name, period);
    const utilization = budget !== null ? usedTokens / budget : null;

    statuses.push({
      agent_name: name,
      period,
      used_tokens: usedTokens,
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
      budget_tokens: budget,
      utilization,
      warning_pct: warnPct,
      critical_pct: critPct,
      is_exceeded: utilization !== null && utilization * 100 >= critPct,
      is_warning: utilization !== null && utilization * 100 >= warnPct && utilization * 100 < critPct,
      pause_on_exceeded: pauseOnExceeded,
    });
  }

  // Sort: exceeded first, then warning, then by tokens used desc
  statuses.sort((a, b) => {
    if (a.is_exceeded && !b.is_exceeded) return -1;
    if (!a.is_exceeded && b.is_exceeded) return 1;
    if (a.is_warning && !b.is_warning) return -1;
    if (!a.is_warning && b.is_warning) return 1;
    return b.used_tokens - a.used_tokens;
  });

  return statuses;
}

// ── Command ───────────────────────────────────────────────────────────────────

export function registerBudgetCommand(program: Command): void {
  program
    .command("budget")
    .description("Per-agent token budget utilization and alerts")
    .option("-d, --days <n>", "1 = daily (24h), 7 = weekly (168h)", "1")
    .option("--json", "Output raw JSON (includes budget vs actual columns for export)")
    .action((opts: { days: string; json?: boolean }) => {
      const days = parseInt(opts.days, 10);
      if (isNaN(days) || days < 1) {
        console.error(chalk.red("Error: --days must be a positive integer"));
        process.exit(1);
      }
      const period: BudgetPeriod = days === 1 ? "daily" : "weekly";
      const windowHours = days * 24;

      const configPath = (program.parent?.opts?.() as { config?: string })?.config;
      let config: OrchestratorConfig;
      try {
        config = loadConfig(configPath);
      } catch (err) {
        console.error(
          chalk.red("Could not load config:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(
          chalk.red("Could not open state database:"),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }

      let usageRows: AgentTokenUsage[];
      try {
        usageRows = store.getAgentTokenUsage(windowHours);
      } finally {
        store.close();
      }

      const statuses = buildBudgetStatuses(config, usageRows, period);

      if (opts.json) {
        // Machine-readable export with budget vs actual columns
        const output = statuses.map((s) => ({
          agent_name: s.agent_name,
          period: s.period,
          window_hours: windowHours,
          used_tokens: s.used_tokens,
          input_tokens: s.input_tokens,
          output_tokens: s.output_tokens,
          budget_tokens: s.budget_tokens,
          utilization_pct: s.utilization !== null ? Math.round(s.utilization * 1000) / 10 : null,
          warning_pct: s.warning_pct,
          critical_pct: s.critical_pct,
          status: s.is_exceeded ? "exceeded" : s.is_warning ? "warning" : s.budget_tokens !== null ? "ok" : "no-budget",
        }));
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      // ── Human-readable table ──────────────────────────────────────────────

      const label = period === "daily" ? "Daily (last 24h)" : `Weekly (last ${days}d)`;
      console.log(chalk.bold(`\nToken Budget Utilization — ${label}\n`));

      const headerAgent = "Agent".padEnd(32);
      const headerUsed = "Used".padStart(8);
      const headerBudget = "Budget".padStart(8);
      const headerBar = " Bar".padEnd(BAR_WIDTH + 2);
      const headerPct = "  Pct".padStart(6);
      const headerStatus = "  Status";
      console.log(
        chalk.dim(`  ${headerAgent} ${headerUsed} ${headerBudget} ${headerBar}${headerPct}${headerStatus}`),
      );
      console.log(chalk.dim("  " + "─".repeat(84)));

      let warnCount = 0;
      let exceededCount = 0;
      for (const s of statuses) {
        const nameStr = chalk.cyan(s.agent_name.padEnd(32));
        const usedStr = chalk.white(formatTokens(s.used_tokens).padStart(8));
        const budgetStr =
          s.budget_tokens !== null ? chalk.dim(formatTokens(s.budget_tokens).padStart(8)) : chalk.dim("       —");
        const bar = renderBar(s.utilization, s.warning_pct, s.critical_pct);
        const pctStr =
          s.utilization !== null
            ? `${(s.utilization * 100).toFixed(0)}%`.padStart(5)
            : chalk.dim("    —");
        const pctColored =
          s.is_exceeded
            ? chalk.red(pctStr)
            : s.is_warning
              ? chalk.yellow(pctStr)
              : chalk.green(pctStr);
        const badgeStr = badge(s);
        const pauseNote = s.pause_on_exceeded && s.is_exceeded ? chalk.red(" [PAUSED]") : "";

        console.log(`  ${nameStr} ${usedStr} ${budgetStr}  ${bar}  ${pctColored}  ${badgeStr}${pauseNote}`);

        if (s.is_exceeded) exceededCount++;
        else if (s.is_warning) warnCount++;
      }

      console.log(chalk.dim("  " + "─".repeat(84)));

      // Summary
      if (exceededCount > 0 || warnCount > 0) {
        console.log();
        if (exceededCount > 0) {
          console.log(
            chalk.red(`  🚨 ${exceededCount} agent(s) have exceeded their budget ceiling`),
          );
        }
        if (warnCount > 0) {
          console.log(chalk.yellow(`  ⚠  ${warnCount} agent(s) are approaching their budget limit`));
        }
        console.log(
          chalk.dim(`\n  Run \`orch budget --days 7\` for the weekly view or \`orch budget --json\` for export.`),
        );
      } else {
        console.log(`\n  ${chalk.green("✓ All agents within budget limits")}`);
      }

      console.log();
    });
}
