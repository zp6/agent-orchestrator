/**
 * CLI command: orch coroner (issue #1725)
 *
 * Surfaces postmortem data from the proxy's coroner webhook subscriber
 * (proxy PR #603). The coroner records cause-of-death analyses for every
 * task.failed event, powered by local Ollama.
 *
 * Usage:
 *   orch coroner log [--limit N] [--offset N] [--agent NAME] [--json]
 *   orch coroner stats [--json]
 *   orch coroner health [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import {
  makeCoronerClient,
  CoronerClientError,
  type CoronerPostmortem,
  type CoronerStats,
  type CoronerHealth,
} from "../../services/coroner-client.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatAge(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  } catch {
    return iso;
  }
}

function renderLog(items: CoronerPostmortem[]): void {
  if (items.length === 0) {
    console.log(chalk.dim("No postmortem records found."));
    return;
  }

  for (const pm of items) {
    const age = formatAge(pm.publishedAt);
    console.log(
      chalk.bold(chalk.red("✗")) +
        " " +
        chalk.bold(pm.agentName) +
        chalk.dim("  " + age),
    );
    console.log(
      "  " + chalk.dim("task:") + " " + chalk.cyan(pm.taskId),
    );
    console.log(
      "  " + chalk.dim("reason:") + " " + pm.failureReason,
    );
    if (pm.causeOfDeath) {
      console.log(
        "  " + chalk.dim("cause:") + " " + chalk.yellow(pm.causeOfDeath),
      );
    }
    console.log();
  }
}

function renderStats(stats: CoronerStats): void {
  console.log(chalk.bold("Failure postmortem stats\n"));
  console.log("  " + chalk.dim("total:") + "   " + chalk.cyan(stats.total));
  console.log("  " + chalk.dim("last 24h:") + " " + chalk.cyan(stats.last24hCount));

  const agents = Object.entries(stats.byAgent).sort((a, b) => b[1] - a[1]);
  if (agents.length > 0) {
    console.log("\n  " + chalk.bold("By agent:"));
    for (const [agent, count] of agents) {
      const bar = "█".repeat(Math.min(count, 20));
      console.log(
        `    ${chalk.cyan(bar.padEnd(20, "░"))} ${count.toString().padStart(4)} ${agent}`,
      );
    }
  }
  console.log();
}

function renderHealth(h: CoronerHealth): void {
  const icon = h.ok ? chalk.green("✓") : chalk.red("✗");
  console.log(icon + " Coroner webhook: " + (h.ok ? chalk.green("healthy") : chalk.red("unhealthy")));
  console.log("  Ollama reachable: " + (h.ollamaReachable ? chalk.green("yes") : chalk.red("no")));
  if (h.model) {
    console.log(
      "  Model: " +
        chalk.cyan(h.model) +
        (h.modelAvailable ? chalk.green("  available") : chalk.red("  not available")),
    );
  }
  if (h.error) {
    console.log("  " + chalk.red("Error: " + h.error));
  }
  console.log();
}

function handleError(err: unknown): never {
  if (err instanceof CoronerClientError) {
    if (err.status === 404) {
      console.error(
        chalk.red("Coroner API not found — is proxy PR #603 deployed?"),
      );
    } else if (err.status) {
      console.error(chalk.red(`Coroner API error ${err.status}: ${err.message}`));
    } else {
      console.error(chalk.red("Coroner unreachable: " + err.message));
      console.error(chalk.dim("Is the proxy running? (default: http://localhost:3471)"));
    }
  } else {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  }
  process.exit(1);
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerCoronerCommand(program: Command): void {
  const coroner = program
    .command("coroner")
    .description("Postmortem viewer — failure cause-of-death records from the coroner webhook");

  // ── log ────────────────────────────────────────────────────────────────────
  coroner
    .command("log")
    .description("Show paginated postmortem log")
    .option("-n, --limit <n>", "Max records to return", "20")
    .option("--offset <n>", "Skip first N records", "0")
    .option("--agent <name>", "Filter by agent name")
    .option("--json", "Output raw JSON")
    .action(async (opts: { limit: string; offset: string; agent?: string; json?: boolean }) => {
      const config = loadConfig();
      const client = makeCoronerClient(config.proxy.url);
      try {
        const page = await client.log({
          limit: parseInt(opts.limit, 10),
          offset: parseInt(opts.offset, 10),
          agent: opts.agent,
        });
        if (opts.json) {
          console.log(JSON.stringify(page, null, 2));
          return;
        }
        const showing = page.offset + page.items.length;
        console.log(
          chalk.bold("Postmortem log") +
            chalk.dim(`  ${showing}/${page.total}${opts.agent ? " for " + opts.agent : ""}\n`),
        );
        renderLog(page.items);
        if (showing < page.total) {
          console.log(
            chalk.dim(
              `  ${page.total - showing} more — use --offset ${showing} to continue`,
            ),
          );
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── stats ──────────────────────────────────────────────────────────────────
  coroner
    .command("stats")
    .description("Show failure stats (total, by agent, last 24h)")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const client = makeCoronerClient(config.proxy.url);
      try {
        const stats: CoronerStats = await client.stats();
        if (opts.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }
        renderStats(stats);
      } catch (err) {
        handleError(err);
      }
    });

  // ── health ─────────────────────────────────────────────────────────────────
  coroner
    .command("health")
    .description("Check coroner webhook and Ollama model availability")
    .option("--json", "Output raw JSON")
    .action(async (opts: { json?: boolean }) => {
      const config = loadConfig();
      const client = makeCoronerClient(config.proxy.url);
      try {
        const h: CoronerHealth = await client.health();
        if (opts.json) {
          console.log(JSON.stringify(h, null, 2));
          return;
        }
        renderHealth(h);
        if (!h.ok) process.exit(1);
      } catch (err) {
        handleError(err);
      }
    });
}
