import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task } from "../../state/store.js";

const KNOWN_PREFIXES = new Set(["github", "linear", "slack", "pr-feedback", "manual"]);

export class DeescalationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeescalationError";
  }
}

/**
 * Normalise a source_ref provided by the operator.
 *
 * Accepts shorthand like `rapartlu/agent-proxy#145` and strips known source
 * prefixes such as `github:` or `pr-feedback:`.  Unknown colon-prefixed refs
 * are left untouched so non-GitHub escalations like
 * `health-check-fail:agent-a` keep their canonical source_ref intact.
 */
export function normaliseSourceRef(raw: string): string {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx);
    if (KNOWN_PREFIXES.has(prefix)) {
      return trimmed.slice(colonIdx + 1);
    }
  }
  return trimmed;
}

function clearEscalationState(store: StateStore, task: Task, sourceRef: string, reason: string): void {
  store.updateTask(task.id, {
    status: "failed",
    retry_count: 0,
    next_retry_at: null,
  });

  const source = task.source ?? "github";
  if (task.source_ref) {
    store.removeProcessedTrigger(source, sourceRef);
  }

  store.addLog({
    task_id: task.id,
    direction: "system",
    content: `De-escalated by operator: ${reason}`,
  });
}

export function deescalateEscalatedTask(store: StateStore, rawRef: string, reason = "manual de-escalation"): Task {
  const sourceRef = normaliseSourceRef(rawRef);
  const task = store.findEscalatedTask(sourceRef);
  if (!task) {
    const allTasks = store.findAllTasksBySourceRef(sourceRef);
    if (allTasks.length === 0) {
      throw new DeescalationError(`No tasks found for source_ref "${sourceRef}".`);
    }

    const statuses = [...new Set(allTasks.map((t) => t.status))];
    throw new DeescalationError(
      `No escalated task found for "${sourceRef}". Current statuses: ${statuses.join(", ")}`,
    );
  }

  clearEscalationState(store, task, sourceRef, reason);
  return task;
}

export function deescalateAllEscalatedTasks(store: StateStore, reason = "bulk de-escalation"): number {
  const escalated = store.getTasksByStatus("escalated");
  if (escalated.length === 0) {
    throw new DeescalationError("No escalated tasks found.");
  }

  for (const task of escalated) {
    if (task.source_ref) {
      clearEscalationState(store, task, task.source_ref, reason);
      continue;
    }

    store.updateTask(task.id, {
      status: "failed",
      retry_count: 0,
      next_retry_at: null,
    });
    store.addLog({
      task_id: task.id,
      direction: "system",
      content: `De-escalated by operator (bulk): ${reason}`,
    });
  }

  return escalated.length;
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

      try {
        if (opts.all) {
          const reason = opts.reason ?? "bulk de-escalation";
          const count = deescalateAllEscalatedTasks(store, reason);
          console.log(chalk.green(`✓ De-escalated ${count} task(s)\n`));
          console.log(chalk.dim("The daemon will re-dispatch eligible source_refs on its next poll cycle."));
          return;
        }

        if (!rawRef) {
          throw new DeescalationError("Provide a source_ref or use --all to de-escalate all tasks.");
        }

        const reason = opts.reason ?? "manual de-escalation";
        const task = deescalateEscalatedTask(store, rawRef, reason);
        const sourceRef = normaliseSourceRef(rawRef);

        console.log(chalk.green("✓ De-escalated successfully\n"));
        console.log(`  ${chalk.dim("Task:")}       ${task.id.slice(0, 8)} → ${chalk.yellow("failed")} (was ${chalk.red("escalated")})`);
        console.log(`  ${chalk.dim("Source ref:")} ${chalk.cyan(sourceRef)}`);
        console.log(`  ${chalk.dim("Agent:")}      ${task.agent_name ?? "unassigned"}`);
        console.log(`  ${chalk.dim("Reason:")}     ${reason}`);
        console.log(`\n${chalk.dim("The daemon will re-dispatch this source_ref on its next poll cycle.")}`);
      } catch (err) {
        const message = err instanceof DeescalationError ? err.message : err instanceof Error ? err.message : String(err);
        console.error(chalk.red(message));
        process.exit(1);
      } finally {
        store.close();
      }
    });
}
