import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import type { SupervisorDecisionRecord } from "../../state/store.js";

/** Colour an outcome badge for terminal display. */
function outcomeColour(outcome: string): string {
  switch (outcome) {
    case "dispatched":
      return chalk.green(outcome);
    case "skipped":
      return chalk.yellow(outcome);
    case "failed":
      return chalk.red(outcome);
    case "none":
      return chalk.dim(outcome);
    case "unhandled":
      return chalk.magenta(outcome);
    default:
      return outcome;
  }
}

/** Format a single decision row for the table. */
function formatRow(d: SupervisorDecisionRecord): string {
  const ts = d.created_at.slice(0, 16).replace("T", " ");
  const agent = d.agent_name ?? chalk.dim("—");
  const task = d.task_id ? chalk.dim(d.task_id.slice(0, 8)) : chalk.dim("—");
  const outcome = outcomeColour(d.outcome);
  const reason =
    d.reason.length > 80 ? d.reason.slice(0, 77) + "..." : d.reason;

  return `  ${chalk.dim(ts)}  ${chalk.bold(d.action.padEnd(13))} ${String(agent).padEnd(32)} ${outcome.padEnd(20)} ${task}  ${reason}`;
}

export function registerDecisionsCommand(program: Command): void {
  program
    .command("decisions")
    .description("View the supervisor decision log")
    .option("-n, --limit <n>", "Number of decisions to show", "20")
    .option("--action <type>", "Filter by action type (dispatch, verify, redeploy, create-issue, follow-up, none)")
    .option("--agent <name>", "Filter by agent name")
    .option("--outcome <type>", "Filter by outcome (dispatched, skipped, failed, none, unhandled)")
    .option("--json", "Output raw JSON")
    .action(
      (opts: {
        limit: string;
        action?: string;
        agent?: string;
        outcome?: string;
        json?: boolean;
      }) => {
        const limit = parseInt(opts.limit, 10);
        if (isNaN(limit) || limit <= 0) {
          console.error(chalk.red("Error: --limit must be a positive integer."));
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

        let decisions: SupervisorDecisionRecord[];
        try {
          // Fetch more than needed so we can filter client-side and still
          // return up to `limit` results after filtering.
          const fetchLimit =
            opts.action || opts.agent || opts.outcome ? limit * 5 : limit;
          decisions = store.getRecentSupervisorDecisions(fetchLimit);
        } finally {
          store.close();
        }

        // Apply optional filters
        if (opts.action) {
          decisions = decisions.filter((d) => d.action === opts.action);
        }
        if (opts.agent) {
          decisions = decisions.filter((d) => d.agent_name === opts.agent);
        }
        if (opts.outcome) {
          decisions = decisions.filter((d) => d.outcome === opts.outcome);
        }

        // Trim to requested limit after filtering
        decisions = decisions.slice(0, limit);

        if (opts.json) {
          console.log(JSON.stringify(decisions, null, 2));
          return;
        }

        console.log(chalk.bold("\n● Supervisor Decision Log\n"));

        if (decisions.length === 0) {
          console.log(
            chalk.dim("  No decisions found. The supervisor records decisions each daemon cycle."),
          );
          console.log();
          return;
        }

        // Header
        console.log(
          chalk.dim(
            `  ${"Timestamp".padEnd(18)} ${"Action".padEnd(13)} ${"Agent".padEnd(32)} ${"Outcome".padEnd(12)} ${"Task".padEnd(10)} Reason`,
          ),
        );
        console.log(chalk.dim("  " + "─".repeat(120)));

        for (const d of decisions) {
          console.log(formatRow(d));
        }

        console.log();
        console.log(
          chalk.dim(
            `  Showing ${decisions.length} decision${decisions.length === 1 ? "" : "s"}${opts.action || opts.agent || opts.outcome ? " (filtered)" : ""}.`,
          ),
        );
        console.log();
      },
    );
}
