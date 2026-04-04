import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task, type SystemMetrics, type ScoreDistribution } from "../../state/store.js";
import { loadConfig } from "../../config/schema.js";

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

  const typeTag = task.task_type === "research" ? chalk.magenta("[research] ") : "";
  let output = `${chalk.dim(task.id.slice(0, 8))} ${status} ${agent.padEnd(30)} ${typeTag}${task.title}`;

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

const BAR_WIDTH = 20;

function scoreBar(count: number, total: number, color: (s: string) => string): string {
  if (total === 0) return chalk.dim("—");
  const filled = Math.round((count / total) * BAR_WIDTH);
  const bar = "█".repeat(filled) + chalk.dim("░".repeat(BAR_WIDTH - filled));
  const pct = `${Math.round((count / total) * 100)}%`.padStart(4);
  return `${color(bar)} ${chalk.dim(pct)} ${String(count).padStart(4)}`;
}

function printScoreDistribution(dist: ScoreDistribution): void {
  if (dist.total === 0) {
    console.log(chalk.dim("  No verified tasks yet"));
    return;
  }
  const { excellent, good, fair, poor, unscored, total } = dist;
  console.log(`  ${"Excellent".padEnd(14)} ${chalk.dim("≥0.90")}  ${scoreBar(excellent, total, chalk.green)}`);
  console.log(`  ${"Good".padEnd(14)} ${chalk.dim("0.70–0.89")}  ${scoreBar(good, total, chalk.cyan)}`);
  console.log(`  ${"Fair".padEnd(14)} ${chalk.dim("0.50–0.69")}  ${scoreBar(fair, total, chalk.yellow)}`);
  console.log(`  ${"Poor".padEnd(14)} ${chalk.dim("<0.50")}  ${scoreBar(poor, total, chalk.red)}`);
  if (unscored > 0) {
    console.log(`  ${"Unscored".padEnd(14)} ${chalk.dim("  n/a")}  ${scoreBar(unscored, total, chalk.dim)}`);
  }
  console.log(chalk.dim(`  ${"─".repeat(48)}`));
  console.log(`  ${"Total verified".padEnd(20)} ${total}`);
}

interface ImprovementStats {
  minScore: number;
  qualifyingCount: number;
}

function printMetrics(metrics: SystemMetrics, improvement?: ImprovementStats): void {
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

  // --- Score distribution ---
  console.log(chalk.bold("\nQuality Score Distribution"));
  printScoreDistribution(metrics.score_distribution);

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

  // --- Per-agent score distribution ---
  const distEntries = Object.entries(metrics.per_agent_score_distribution);
  if (distEntries.length > 0) {
    console.log(chalk.bold("\nPer-Agent Score Distribution"));
    const COL = { agent: 24, exc: 5, good: 5, fair: 5, poor: 5, unscored: 8 };
    const hdr = [
      "  " + "Agent".padEnd(COL.agent),
      chalk.green("Exc".padStart(COL.exc)),
      chalk.cyan("Good".padStart(COL.good)),
      chalk.yellow("Fair".padStart(COL.fair)),
      chalk.red("Poor".padStart(COL.poor)),
      chalk.dim("Unscrd".padStart(COL.unscored)),
    ].join("  ");
    console.log(chalk.dim(hdr));
    console.log(chalk.dim("  " + "─".repeat(COL.agent + (COL.exc + COL.good + COL.fair + COL.poor + COL.unscored) + 10)));
    for (const [agentName, dist] of distEntries) {
      const name = chalk.cyan(agentName.slice(0, COL.agent).padEnd(COL.agent));
      const exc = (dist.excellent > 0 ? chalk.green(String(dist.excellent)) : chalk.dim("0")).padStart(COL.exc + 2);
      const good = (dist.good > 0 ? chalk.cyan(String(dist.good)) : chalk.dim("0")).padStart(COL.good + 2);
      const fair = (dist.fair > 0 ? chalk.yellow(String(dist.fair)) : chalk.dim("0")).padStart(COL.fair + 2);
      const poor = (dist.poor > 0 ? chalk.red(String(dist.poor)) : chalk.dim("0")).padStart(COL.poor + 2);
      const unscored = (dist.unscored > 0 ? chalk.dim(String(dist.unscored)) : chalk.dim("0")).padStart(COL.unscored + 2);
      console.log(`  ${name}  ${exc}  ${good}  ${fair}  ${poor}  ${unscored}`);
    }
  }

  // --- Improvement detection ---
  if (improvement !== undefined) {
    const { minScore, qualifyingCount } = improvement;
    const countColor = qualifyingCount >= 5 ? chalk.green : qualifyingCount > 0 ? chalk.yellow : chalk.red;

    console.log(chalk.bold("\nImprovement Detection"));
    console.log(`  Quality threshold: score ≥ ${chalk.cyan(minScore.toFixed(2))}`);
    console.log(`  Qualifying tasks:  ${countColor(String(qualifyingCount))} (of last 20 verified)`);

    if (qualifyingCount < 5) {
      console.log(
        chalk.yellow(`  ⚠ Improvement detection inactive`) +
          chalk.dim(` — need ≥5 qualifying tasks, have ${qualifyingCount}`),
      );
    } else {
      console.log(chalk.dim(`  ✓ Improvement detection active`));
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
    .option("-T, --type <type>", "Filter by task type (implementation, research)")
    .option("-n, --limit <n>", "Number of tasks to show", "20")
    .option("-m, --metrics", "Show aggregated system metrics")
    .action((taskId?: string, opts?: { agent?: string; state?: string; type?: string; limit?: string; metrics?: boolean }) => {
      const store = new StateStore();

      if (opts?.metrics) {
        const metrics = store.getMetrics();

        // Compute improvement detection stats from config + store
        let improvementStats: ImprovementStats | undefined;
        try {
          const configPath = program.opts().config as string | undefined;
          const config = loadConfig(configPath);
          const minScore = config.verification?.min_score ?? 0.7;
          const qualified = store.getRecentVerified(20, minScore);
          improvementStats = { minScore, qualifyingCount: qualified.length };
        } catch {
          // Config unavailable — skip the section
        }

        printMetrics(metrics, improvementStats);
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
          task_type: opts?.type as Task["task_type"] | undefined,
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
