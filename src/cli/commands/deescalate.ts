import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

/**
 * Normalise a source_ref provided by the operator.  Accepts shorthand like
 * `rapartlu/agent-proxy#145` and converts to the canonical form used in the
 * database.  If the ref already contains a source prefix (e.g.
 * `github:rapartlu/agent-proxy#145`), the prefix is stripped — the source
 * column is inferred separately.
 */
export function normaliseSourceRef(raw: string): string {
  // Strip explicit source prefix if present (e.g. "github:owner/repo#42")
  const colonIdx = raw.indexOf(":");
  if (colonIdx !== -1 && !raw.includes("/", 0) || (colonIdx !== -1 && colonIdx < raw.indexOf("/"))) {
    return raw.slice(colonIdx + 1);
  }
  return raw;
}

export function registerDeescalateCommand(program: Command): void {
  program
    .command("deescalate")
    .description("Unblock an escalated source_ref so the daemon can re-dispatch it")
    .argument("[source_ref]", "The source ref to de-escalate (e.g. rapartlu/agent-proxy#145)")
    .option("--reason <reason>", "Reason for de-escalation (logged for audit)")
    .option("--all", "De-escalate ALL escalated tasks at once")
    .action((rawRef: string | undefined, opts: { reason?: string; all?: boolean }) => {
      const store = new StateStore();

      if (opts.all) {
        try {
          const reason = opts.reason ?? "bulk de-escalation";
          const escalated = store.getTasksByStatus("escalated");
          if (escalated.length === 0) {
            console.log(chalk.yellow("No escalated tasks found."));
            return;
          }

          let count = 0;
          for (const task of escalated) {
            store.updateTask(task.id, {
              status: "failed",
              retry_count: 0,
              next_retry_at: null,
            });
            if (task.source_ref) {
              store.removeProcessedTrigger(task.source ?? "github", task.source_ref);
            }
            store.addLog({
              task_id: task.id,
              direction: "system",
              content: `De-escalated by operator (bulk): ${reason}`,
            });
            count++;
          }

          console.log(chalk.green(`✓ De-escalated ${count} task(s)\n`));
          console.log(chalk.dim("The daemon will re-dispatch eligible source_refs on its next poll cycle."));
          return;
        } finally {
          store.close();
        }
      }

      if (!rawRef) {
        console.error(chalk.red("Provide a source_ref or use --all to de-escalate all tasks."));
        process.exit(1);
      }

      try {
        const sourceRef = normaliseSourceRef(rawRef);
        const task = store.findEscalatedTask(sourceRef);

        if (!task) {
          // Check if the source_ref exists at all but isn't escalated
          const allTasks = store.findAllTasksBySourceRef(sourceRef);
          if (allTasks.length === 0) {
            console.error(chalk.red(`No tasks found for source_ref "${sourceRef}".`));
            process.exit(1);
          }

          const statuses = [...new Set(allTasks.map((t) => t.status))];
          console.error(
            chalk.yellow(`No escalated task found for "${sourceRef}".`) +
            chalk.dim(` Current statuses: ${statuses.join(", ")}`),
          );
          process.exit(1);
        }

        // 1. Reset escalated task → failed with cleared retry state
        store.updateTask(task.id, {
          status: "failed",
          retry_count: 0,
          next_retry_at: null,
        });

        // 2. Remove the processed_triggers record so the daemon re-dispatches
        const source = task.source ?? "github";
        store.removeProcessedTrigger(source, sourceRef);

        // 3. Log the de-escalation for audit trail
        const reason = opts.reason ?? "manual de-escalation";
        store.addLog({
          task_id: task.id,
          direction: "system",
          content: `De-escalated by operator: ${reason}`,
        });

        // 4. Output confirmation
        console.log(chalk.green("✓ De-escalated successfully\n"));
        console.log(`  ${chalk.dim("Task:")}       ${task.id.slice(0, 8)} → ${chalk.yellow("failed")} (was ${chalk.red("escalated")})`);
        console.log(`  ${chalk.dim("Source ref:")} ${chalk.cyan(sourceRef)}`);
        console.log(`  ${chalk.dim("Agent:")}      ${task.agent_name ?? "unassigned"}`);
        console.log(`  ${chalk.dim("Reason:")}     ${reason}`);
        console.log(`\n${chalk.dim("The daemon will re-dispatch this source_ref on its next poll cycle.")}`);
      } finally {
        store.close();
      }
    });
}
