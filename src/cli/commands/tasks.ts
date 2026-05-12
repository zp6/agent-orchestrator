import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import {
  sweepStalePendingTasks,
  type SweepCandidate,
  type SweepTransition,
} from "../../triggers/stale-task-sweeper.js";

// ── Formatting helpers ────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function printCandidatesTable(candidates: SweepCandidate[]): void {
  if (candidates.length === 0) {
    console.log(chalk.green("✓ No stale pending/paused tasks found."));
    return;
  }

  const COL = {
    id: 12,
    agent: 30,
    status: 9,
    age: 5,
    source: 28,
    title: 52,
  };

  const header = [
    "ID".padEnd(COL.id),
    "AGENT".padEnd(COL.agent),
    "STATUS".padEnd(COL.status),
    "AGE".padStart(COL.age),
    "SOURCE_REF".padEnd(COL.source),
    "TITLE",
  ].join("  ");

  const separator = "─".repeat(header.length + 2);
  console.log(chalk.dim("  " + header));
  console.log(chalk.dim("  " + separator));

  for (const c of candidates) {
    const idStr = chalk.dim(c.id.slice(0, COL.id).padEnd(COL.id));
    const agentStr = chalk.cyan(
      truncate(c.agent_name ?? "—", COL.agent).padEnd(COL.agent),
    );
    const statusStr = chalk.yellow(c.status.padEnd(COL.status));
    const ageStr = String(c.stale_days).padStart(COL.age) + "d";
    const sourceStr = truncate(c.source_ref ?? "—", COL.source).padEnd(COL.source);
    const titleStr = chalk.dim(truncate(c.title, COL.title));

    console.log(`  ${idStr}  ${agentStr}  ${statusStr}  ${ageStr}  ${sourceStr}  ${titleStr}`);
  }

  console.log();
}

function printTransitionsTable(transitions: SweepTransition[]): void {
  if (transitions.length === 0) {
    console.log(chalk.green("✓ No stale tasks to sweep."));
    return;
  }

  for (const t of transitions) {
    const icon = "✓";
    const color = t.new_status === "superseded" ? chalk.red : chalk.yellow;
    const idStr = chalk.dim(t.task_id.slice(0, 10));
    const statusStr = color(`${t.old_status} → ${t.new_status}`);
    const title = truncate(t.title, 55);
    console.log(`  ${icon} ${idStr}  ${statusStr}  ${title}`);
    console.log(`    ${chalk.dim(t.reason)}`);
    console.log();
  }
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerTasksCommand(program: Command): void {
  const tasks = program
    .command("tasks")
    .description("Task management commands");

  tasks
    .command("sweep-stale")
    .description(
      "Sweep tasks stuck in pending/paused status without dispatch. " +
        "Dry-run by default — use --execute to apply changes.",
    )
    .option(
      "--dry-run",
      "List stale candidates without making any changes (default when --execute is absent)",
    )
    .option(
      "--execute",
      "Actually update task statuses in state.db (requires explicit flag)",
    )
    .option(
      "--threshold <n>",
      "Stale threshold in days (default: 7)",
      "7",
    )
    .option("--json", "Output JSON instead of formatted table")
    .action(
      async (opts: {
        dryRun?: boolean;
        execute?: boolean;
        threshold: string;
        json?: boolean;
      }) => {
        const thresholdDays = parseInt(opts.threshold, 10);
        if (isNaN(thresholdDays) || thresholdDays < 1) {
          console.error(
            chalk.red("Error: --threshold must be a positive integer"),
          );
          process.exit(1);
        }

        // Default to dry-run unless --execute is explicitly passed
        const dryRun = !opts.execute;

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

        let result: Awaited<ReturnType<typeof sweepStalePendingTasks>>;
        try {
          result = await sweepStalePendingTasks({
            store,
            thresholdDays,
            dryRun,
          });
        } finally {
          store.close();
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        const modeLabel = dryRun
          ? chalk.dim("dry-run")
          : chalk.red("EXECUTE");
        console.log(
          chalk.bold(
            `\n● Stale-task sweep — threshold: ${thresholdDays}d, mode: `,
          ) +
            modeLabel +
            "\n",
        );

        if (dryRun) {
          if (result.candidates.length > 0) {
            console.log(
              chalk.dim(
                `  Found ${result.candidates.length} stale task(s) eligible for sweep:\n`,
              ),
            );
          }
          printCandidatesTable(result.candidates);

          // Summary
          const pending = result.candidates.filter(
            (c) => c.status === "pending",
          ).length;
          const paused = result.candidates.filter(
            (c) => c.status === "paused",
          ).length;
          console.log(
            chalk.dim(
              `  Total: ${result.candidates.length} candidate(s) (${pending} pending, ${paused} paused)`,
            ),
          );
          if (result.candidates.length > 0) {
            console.log();
            console.log(
              chalk.dim(
                `  Run with --execute to apply transitions. Would supersede ${result.transitions.filter((t) => t.new_status === "superseded").length}, cancel ${result.transitions.filter((t) => t.new_status === "cancelled").length}.`,
              ),
            );
          }
        } else {
          if (result.transitions.length > 0) {
            console.log(
              chalk.dim(`  Applied ${result.transitions.length} transition(s):\n`),
            );
          }
          printTransitionsTable(result.transitions);

          const total = result.superseded + result.cancelled;
          const summaryParts: string[] = [];
          if (result.superseded > 0)
            summaryParts.push(`${result.superseded} superseded`);
          if (result.cancelled > 0)
            summaryParts.push(`${result.cancelled} cancelled`);
          const summaryStr =
            summaryParts.length > 0
              ? summaryParts.join(", ")
              : "0 transitions";
          console.log(
            chalk.bold(`  Summary: `) +
              `${summaryStr}, ${total} total (executed)`,
          );
        }

        console.log();
      },
    );
}
