/**
 * CLI command: orch cli-health (issue #1520)
 *
 * Shows all agents currently in cli-missing state — i.e., agents whose
 * Claude CLI binary is absent or whose .claude.json config is corrupt
 * inside their containers.
 *
 * Also summarises recent cli-spawn-failure incidents from the incidents table
 * so operators can see the history of CLI failures across the fleet.
 *
 * Usage:
 *   orch cli-health [--json]
 */

import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

export function registerCliHealthCommand(program: Command): void {
  program
    .command("cli-health")
    .description(
      "Show agents in cli-missing state and recent CLI spawn failure history (issue #1520)",
    )
    .option("--json", "Output raw JSON instead of formatted table")
    .option("--days <n>", "Look-back window for incident history (days)", "7")
    .action((opts: { json?: boolean; days: string }) => {
      const days = Math.max(1, parseInt(opts.days, 10) || 7);

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

      try {
        const cliMissing = store.getCliMissingAgents();

        // Pull recent cli-spawn-failure incidents
        const incidents = store.getIncidents(days, 50)
          .filter((i) => i.incident_type === "cli-spawn-failure");

        // Summarise by agent
        const incidentsByAgent = new Map<string, number>();
        for (const inc of incidents) {
          const ag = inc.agent_name ?? "(unknown)";
          incidentsByAgent.set(ag, (incidentsByAgent.get(ag) ?? 0) + 1);
        }

        if (opts.json) {
          console.log(JSON.stringify({ cliMissing, incidents, incidentsByAgent: Object.fromEntries(incidentsByAgent) }, null, 2));
          return;
        }

        // ── Formatted output ──────────────────────────────────────────────
        console.log(chalk.bold(`\n🔧  CLI Health — agent CLI install status\n`));
        console.log(
          chalk.dim(
            "  Tracks agents whose Claude CLI binary is missing or whose .claude.json\n" +
            "  config is corrupt.  cli-missing agents have all dispatches blocked until\n" +
            "  the daemon restarts their container and the health check passes. (issue #1520)\n",
          ),
        );

        // ── Currently cli-missing agents ──────────────────────────────────
        if (cliMissing.length === 0) {
          console.log(chalk.green("  ✓  No agents in cli-missing state.\n"));
        } else {
          console.log(chalk.red(`  ✗  ${cliMissing.length} agent(s) in cli-missing state:\n`));
          console.log(
            chalk.dim(
              `  ${"Agent".padEnd(40)} ${"Since".padEnd(26)} ${"Last error".slice(0, 50)}`,
            ),
          );
          console.log(chalk.dim("  " + "─".repeat(100)));
          for (const ag of cliMissing) {
            const since = ag.cli_missing_at
              ? new Date(ag.cli_missing_at).toLocaleString()
              : "(unknown)";
            const lastErr = (ag.last_error_message ?? "").slice(0, 50);
            console.log(
              `  ${chalk.red(ag.agent_name.padEnd(40))} ${since.padEnd(26)} ${chalk.dim(lastErr)}`,
            );
          }
          console.log();
          console.log(
            chalk.yellow(
              "  Daemon recovery loop will restart each container at the next agent-sync\n" +
              "  cycle (~5 min).  To force immediate recovery: orch service restart\n",
            ),
          );
        }

        // ── Recent incident history ───────────────────────────────────────
        console.log(chalk.bold(`  CLI spawn failure incidents — last ${days} day(s)\n`));
        if (incidents.length === 0) {
          console.log(chalk.green("  ✓  No cli-spawn-failure incidents recorded.\n"));
        } else {
          console.log(
            chalk.dim(
              `  ${"Agent".padEnd(40)} ${"Count".padStart(6)}`,
            ),
          );
          console.log(chalk.dim("  " + "─".repeat(50)));
          const sortedAgents = Array.from(incidentsByAgent.entries())
            .sort((a, b) => b[1] - a[1]);
          for (const [ag, count] of sortedAgents) {
            console.log(
              `  ${ag.padEnd(40)} ${chalk.red(String(count).padStart(6))}`,
            );
          }
          console.log();
          console.log(
            chalk.dim(
              `  Total: ${chalk.red(String(incidents.length))} cli-spawn-failure incidents in ${days}d\n` +
              "  See: orch connection-errors --days " + days + " for the full connection-error breakdown.\n",
            ),
          );
        }
      } finally {
        store.close();
      }
    });
}
