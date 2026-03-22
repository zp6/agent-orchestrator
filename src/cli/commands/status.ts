import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task } from "../../state/store.js";

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: chalk.yellow,
  dispatched: chalk.blue,
  in_progress: chalk.cyan,
  done: chalk.green,
  failed: chalk.red,
};

function formatTask(task: Task, verbose = false): string {
  const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
  const status = colorFn(task.status.padEnd(12));
  const agent = task.agent_name ? chalk.cyan(task.agent_name) : chalk.dim("unassigned");
  const time = chalk.dim(new Date(task.created_at).toLocaleString());

  let output = `${chalk.dim(task.id.slice(0, 8))} ${status} ${agent.padEnd(30)} ${task.title}`;

  if (verbose) {
    output += `\n  ${chalk.dim("Created:")} ${time}`;
    output += `\n  ${chalk.dim("Source:")}  ${task.source}${task.source_ref ? ` (${task.source_ref})` : ""}`;
    if (task.result) {
      const preview = task.result.length > 200 ? task.result.slice(0, 200) + "..." : task.result;
      output += `\n  ${chalk.dim("Result:")}  ${preview}`;
    }
  }

  return output;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show task status")
    .argument("[task-id]", "Specific task ID (prefix match supported)")
    .option("-a, --agent <name>", "Filter by agent")
    .option("-s, --state <status>", "Filter by status")
    .option("-n, --limit <n>", "Number of tasks to show", "20")
    .action((taskId?: string, opts?: { agent?: string; state?: string; limit?: string }) => {
      const store = new StateStore();

      if (taskId) {
        const allTasks = store.listTasks({ limit: 100 });
        const match = allTasks.find((t) => t.id.startsWith(taskId));
        if (!match) {
          console.error(chalk.red(`No task found matching: ${taskId}`));
          store.close();
          process.exit(1);
        }
        console.log(formatTask(match, true));

        const logs = store.getLogs(match.id);
        if (logs.length > 0) {
          console.log(chalk.bold("\nLogs:"));
          for (const log of logs) {
            const dir = log.direction === "to_agent" ? chalk.blue("->") : log.direction === "from_agent" ? chalk.green("<-") : chalk.dim("**");
            const agent = log.agent_name ? chalk.cyan(log.agent_name) : "";
            const time = chalk.dim(new Date(log.created_at).toLocaleTimeString());
            const preview = log.content.length > 150 ? log.content.slice(0, 150) + "..." : log.content;
            console.log(`  ${time} ${dir} ${agent} ${preview}`);
          }
        }
      } else {
        const tasks = store.listTasks({
          status: opts?.state as Task["status"] | undefined,
          agent_name: opts?.agent,
          limit: parseInt(opts?.limit ?? "20"),
        });

        if (tasks.length === 0) {
          console.log(chalk.dim("No tasks found"));
        } else {
          console.log(chalk.bold("Tasks\n"));
          for (const task of tasks) {
            console.log(formatTask(task));
          }
          console.log(chalk.dim(`\n${tasks.length} task(s)`));
        }
      }

      store.close();
    });
}
