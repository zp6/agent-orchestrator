import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task, type SystemMetrics } from "../../state/store.js";

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: chalk.yellow,
  planning: chalk.magenta,
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
    if (task.verification_status) {
      const vColor = task.verification_status === "approved" ? chalk.green : task.verification_status === "rejected" ? chalk.red : chalk.yellow;
      const score = task.quality_score !== null ? ` (${task.quality_score.toFixed(1)})` : "";
      output += `\n  ${chalk.dim("Verified:")} ${vColor(task.verification_status)}${score}`;
      if (task.verification_notes) {
        output += `\n  ${chalk.dim("Notes:")}    ${task.verification_notes.slice(0, 150)}`;
      }
    }
  }

  return output;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return chalk.dim("—");
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatPercent(rate: number | null): string {
  if (rate === null) return chalk.dim("—");
  const pct = Math.round(rate * 100);
  const color = pct >= 80 ? chalk.green : pct >= 50 ? chalk.yellow : chalk.red;
  return color(`${pct}%`);
}

function printMetrics(metrics: SystemMetrics): void {
  console.log(chalk.bold("System Metrics\n"));

  // --- Task summary ---
  console.log(chalk.bold("Tasks"));
  console.log(`  Total:        ${metrics.total_tasks}`);
  console.log(`  Done:         ${chalk.green(String(metrics.done_tasks))}`);
  console.log(`  Failed:       ${chalk.red(String(metrics.failed_tasks))}`);
  console.log(`  Avg duration: ${formatDuration(metrics.avg_task_duration_ms)}`);
  console.log(`  Pass rate:    ${formatPercent(metrics.verification_pass_rate)}`);
  console.log(`  Avg score:    ${metrics.avg_quality_score !== null ? metrics.avg_quality_score.toFixed(2) : chalk.dim("—")}`);

  // --- Cycle summary ---
  console.log(chalk.bold("\nDaemon Cycles"));
  console.log(`  Total:        ${metrics.cycles.total_cycles}`);
  console.log(`  Avg duration: ${formatDuration(metrics.cycles.avg_duration_ms)}`);
  const lastCycle = metrics.cycles.last_cycle_at
    ? chalk.dim(new Date(metrics.cycles.last_cycle_at).toLocaleString())
    : chalk.dim("—");
  console.log(`  Last cycle:   ${lastCycle}`);

  // --- Per-agent table ---
  if (metrics.per_agent.length > 0) {
    console.log(chalk.bold("\nPer-Agent Metrics"));
    const header = `  ${"Agent".padEnd(28)} ${"Total".padStart(6)} ${"Done".padStart(6)} ${"Failed".padStart(7)} ${"Avg Time".padStart(10)} ${"Pass%".padStart(7)} ${"Score".padStart(6)}`;
    console.log(chalk.dim(header));
    console.log(chalk.dim("  " + "─".repeat(75)));
    for (const a of metrics.per_agent) {
      const agent = chalk.cyan(a.agent_name.slice(0, 26).padEnd(28));
      const total = String(a.total).padStart(6);
      const done = chalk.green(String(a.done).padStart(6));
      const failed = (a.failed > 0 ? chalk.red(String(a.failed)) : chalk.dim("0")).padStart(7);
      const dur = formatDuration(a.avg_duration_ms).padStart(10);
      const pass = formatPercent(a.verification_pass_rate).padStart(7);
      const score = (a.avg_quality_score !== null ? a.avg_quality_score.toFixed(2) : chalk.dim("—")).padStart(6);
      console.log(`  ${agent} ${total} ${done} ${failed} ${dur} ${pass} ${score}`);
    }
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show task status")
    .argument("[task-id]", "Specific task ID (prefix match supported)")
    .option("-a, --agent <name>", "Filter by agent")
    .option("-s, --state <status>", "Filter by status")
    .option("-n, --limit <n>", "Number of tasks to show", "20")
    .option("-m, --metrics", "Show aggregated system metrics")
    .action((taskId?: string, opts?: { agent?: string; state?: string; limit?: string; metrics?: boolean }) => {
      const store = new StateStore();

      if (opts?.metrics) {
        printMetrics(store.getMetrics());
        store.close();
        return;
      }

      if (taskId) {
        const allTasks = store.listTasks({ limit: 100 });
        const match = allTasks.find((t) => t.id.startsWith(taskId));
        if (!match) {
          console.error(chalk.red(`No task found matching: ${taskId}`));
          store.close();
          process.exit(1);
        }
        console.log(formatTask(match, true));

        // Show sub-tasks if this is a parent task
        const subTasks = store.getSubTasks(match.id);
        if (subTasks.length > 0) {
          console.log(chalk.bold("\nSub-tasks:"));
          for (const sub of subTasks) {
            const colorFn = STATUS_COLORS[sub.status] ?? chalk.white;
            const stepLabel = sub.step_id ? chalk.dim(`[${sub.step_id}]`) : "";
            const agent = sub.agent_name ? chalk.cyan(sub.agent_name) : "";
            console.log(`  ${stepLabel} ${colorFn(sub.status.padEnd(10))} ${agent} ${sub.title}`);
          }
        }

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
