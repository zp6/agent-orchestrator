import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import type { SupervisorDecisionRecord, DispatchRationale } from "../../state/store.js";

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

/**
 * Try to parse a rationale field as a structured DispatchRationale JSON.
 * Returns null if the rationale is not structured JSON.
 */
function parseStructuredRationale(rationale: string | null): DispatchRationale | null {
  if (!rationale) return null;
  try {
    const parsed = JSON.parse(rationale);
    if (typeof parsed === "object" && parsed !== null && "llm_reasoning" in parsed) {
      return parsed as DispatchRationale;
    }
  } catch {
    // Not structured JSON — plain-text rationale from before this feature
  }
  return null;
}

/**
 * Build a one-line human-readable summary from a structured rationale.
 * Example: "issue=open pr=none idle=12m conf=0.85"
 */
function formatRationaleSummary(r: DispatchRationale): string {
  const parts: string[] = [];
  if (r.issue_state_at_dispatch) parts.push(`issue=${r.issue_state_at_dispatch}`);
  if (r.existing_pr_check_result) parts.push(`pr=${r.existing_pr_check_result}`);
  if (r.agent_idle_duration_ms !== null) {
    const mins = Math.floor(r.agent_idle_duration_ms / 60_000);
    parts.push(`idle=${mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`}`);
  }
  if (r.confidence_score !== null) parts.push(`conf=${r.confidence_score.toFixed(2)}`);
  return parts.join(" ");
}

function formatRationaleText(d: SupervisorDecisionRecord): string | null {
  const structured = parseStructuredRationale(d.rationale);
  const text = structured?.llm_reasoning ?? d.rationale;
  if (!text) return null;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/** Format a single decision row for the table. */
function formatRow(d: SupervisorDecisionRecord): string {
  const ts = d.created_at.slice(0, 16).replace("T", " ");
  const agent = d.agent_name ?? chalk.dim("—");
  const task = d.task_id ? chalk.dim(d.task_id.slice(0, 8)) : chalk.dim("—");
  const outcome = outcomeColour(d.outcome);
  const reason =
    d.reason.length > 80 ? d.reason.slice(0, 77) + "..." : d.reason;

  let line = `  ${chalk.dim(ts)}  ${chalk.bold(d.action.padEnd(13))} ${String(agent).padEnd(32)} ${outcome.padEnd(20)} ${task}  ${reason}`;

  // Append structured rationale summary for dispatch/follow-up decisions
  const structured = parseStructuredRationale(d.rationale);
  if (structured) {
    const summary = formatRationaleSummary(structured);
    if (summary) {
      line += `\n  ${" ".repeat(18)}${chalk.dim(summary)}`;
    }
  }

  if (d.issue_refs.length > 0) {
    line += `\n  ${" ".repeat(18)}${chalk.cyan(`issues: ${d.issue_refs.join(", ")}`)}`;
  }

  const rationaleText = formatRationaleText(d);
  if (rationaleText) {
    line += `\n  ${" ".repeat(18)}${chalk.dim(`why: ${rationaleText}`)}`;
  }

  if (d.hard_gates.length > 0) {
    line += `\n  ${" ".repeat(18)}${chalk.yellow(`gates: ${d.hard_gates.join("; ")}`)}`;
  }

  return line;
}

/**
 * Test whether a decision record mentions a given issue number.
 *
 * Matches `#N` (with word boundary) in the reason, message, and rationale
 * fields.  Also matches `sourceRef` patterns like `owner/repo#N`.
 *
 * Exported for unit testing.
 */
export function decisionMatchesIssue(d: SupervisorDecisionRecord, issueNumber: number): boolean {
  // Match #N at word boundary (e.g. "#457", "repo#457") but not "#4570"
  const pattern = new RegExp(`#${issueNumber}\\b`);
  return (
    d.issue_refs.some((ref) => pattern.test(ref)) ||
    pattern.test(d.reason) ||
    pattern.test(d.message ?? "") ||
    pattern.test(d.rationale ?? "")
  );
}

/**
 * Test whether a decision record matches a free-text search query.
 *
 * Case-insensitive substring match across reason, message, rationale,
 * action, agent_name, and outcome fields.
 *
 * Exported for unit testing.
 */
export function decisionMatchesSearch(d: SupervisorDecisionRecord, query: string): boolean {
  const q = query.toLowerCase();
  return (
    d.issue_refs.some((ref) => ref.toLowerCase().includes(q)) ||
    d.hard_gates.some((gate) => gate.toLowerCase().includes(q)) ||
    d.reason.toLowerCase().includes(q) ||
    (d.message ?? "").toLowerCase().includes(q) ||
    (d.rationale ?? "").toLowerCase().includes(q) ||
    d.action.toLowerCase().includes(q) ||
    (d.agent_name ?? "").toLowerCase().includes(q) ||
    d.outcome.toLowerCase().includes(q)
  );
}

export function registerDecisionsCommand(program: Command): void {
  program
    .command("decisions")
    .description("View the supervisor decision feed")
    .option("-n, --limit <n>", "Number of decisions to show", "20")
    .option(
      "--since <duration>",
      "Only show decisions newer than this duration (e.g. 1h, 30m, 2d, 1h30m)",
    )
    .option("--action <type>", "Filter by action type (dispatch, verify, redeploy, create-issue, follow-up, none)")
    .option("--agent <name>", "Filter by agent name")
    .option("--outcome <type>", "Filter by outcome (dispatched, skipped, failed, none, unhandled)")
    .option("--issue <number>", "Trace all decisions about a specific issue number (e.g. --issue 457)")
    .option("--search <text>", "Free-text search across reason, message, rationale, and other fields")
    .option("--json", "Output newline-delimited JSON (one record per line, suitable for grep/jq)")
    .action(
      (opts: {
        limit: string;
        since?: string;
        action?: string;
        agent?: string;
        outcome?: string;
        issue?: string;
        search?: string;
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

        // Parse --issue early so we can report errors before opening the DB
        let issueNumber: number | null = null;
        if (opts.issue) {
          issueNumber = parseInt(opts.issue, 10);
          if (isNaN(issueNumber) || issueNumber <= 0) {
            console.error(
              chalk.red(
                `Error: --issue '${opts.issue}' is not a valid issue number. Use a positive integer (e.g. --issue 457).`,
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
          const hasFilters = !!(opts.action || opts.agent || opts.outcome || opts.issue || opts.search || sinceDate);
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
        if (issueNumber !== null) {
          decisions = decisions.filter((d) => decisionMatchesIssue(d, issueNumber));
        }
        if (opts.search) {
          decisions = decisions.filter((d) => decisionMatchesSearch(d, opts.search!));
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
          opts.issue   && `issue=#${opts.issue}`,
          opts.search  && `search="${opts.search}"`,
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
