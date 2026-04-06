import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import type { SupervisorDecisionRecord } from "../../state/store.js";

/**
 * Parse a duration string (e.g. "1h", "30m", "2d", "1h30m") into milliseconds.
 * Returns null if the string cannot be parsed.
 *
 * Supported units: d (days), h (hours), m (minutes), s (seconds).
 * Multiple components may be combined (e.g. "1h30m").
 */
export function parseDuration(s: string): number | null {
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = s.trim().match(pattern);
  if (!match || s.trim() === "") return null;

  const [, days, hours, minutes, seconds] = match;
  const ms =
    (parseInt(days ?? "0", 10) * 86_400_000) +
    (parseInt(hours ?? "0", 10) * 3_600_000) +
    (parseInt(minutes ?? "0", 10) * 60_000) +
    (parseInt(seconds ?? "0", 10) * 1_000);

  return ms > 0 ? ms : null;
}

/** Return a cutoff Date given a --since string, or null if unparseable. */
export function sinceToDate(since: string): Date | null {
  const ms = parseDuration(since);
  if (ms === null) return null;
  return new Date(Date.now() - ms);
}

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
    .option(
      "--since <duration>",
      "Only show decisions newer than this duration (e.g. 1h, 30m, 2d, 1h30m)",
    )
    .option("--action <type>", "Filter by action type (dispatch, verify, redeploy, create-issue, follow-up, none)")
    .option("--agent <name>", "Filter by agent name")
    .option("--outcome <type>", "Filter by outcome (dispatched, skipped, failed, none, unhandled)")
    .option("--json", "Output newline-delimited JSON (one record per line, suitable for grep/jq)")
    .action(
      (opts: {
        limit: string;
        since?: string;
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

        // Parse --since early so we can report errors before opening the DB
        let sinceDate: Date | null = null;
        if (opts.since) {
          sinceDate = sinceToDate(opts.since);
          if (!sinceDate) {
            console.error(
              chalk.red(
                `Error: --since '${opts.since}' is not a valid duration. Use formats like 1h, 30m, 2d, 1h30m.`,
              ),
            );
            process.exit(1);
          }
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
          // Fetch a larger window when filters are active so we can return up
          // to `limit` results after client-side filtering.
          const hasFilters = !!(opts.action || opts.agent || opts.outcome || sinceDate);
          const fetchLimit = hasFilters ? Math.max(limit * 10, 500) : limit;
          decisions = store.getRecentSupervisorDecisions(fetchLimit);
        } finally {
          store.close();
        }

        // Apply optional filters
        if (sinceDate) {
          const cutoff = sinceDate.toISOString();
          decisions = decisions.filter((d) => d.created_at >= cutoff);
        }
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
          // Emit newline-delimited JSON (NDJSON) — one record per line,
          // suitable for streaming into grep/jq/awk pipelines.
          for (const d of decisions) {
            console.log(JSON.stringify(d));
          }
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
        const filterDesc = [
          opts.since   && `since ${opts.since}`,
          opts.action  && `action=${opts.action}`,
          opts.agent   && `agent=${opts.agent}`,
          opts.outcome && `outcome=${opts.outcome}`,
        ].filter(Boolean).join(", ");
        console.log(
          chalk.dim(
            `  Showing ${decisions.length} decision${decisions.length === 1 ? "" : "s"}${filterDesc ? ` (filtered: ${filterDesc})` : ""}.`,
          ),
        );
        console.log();
      },
    );
}
