import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task, type SystemMetrics, type ScoreDistribution, type ScoreTrend, type MetricsTrend } from "../../state/store.js";
import { loadConfig } from "../../config/schema.js";

const STATUS_COLORS: Record<string, (s: string) => string> = {
  pending: chalk.yellow,
  planning: chalk.magenta,
  dispatched: chalk.blue,
  in_progress: chalk.cyan,
  done: chalk.green,
  failed: chalk.red,
};

/**
 * Format the source label for a task.  PR-feedback tasks get a prominent
 * "PR feedback for owner/repo#N" label; other sources fall back to the raw
 * source string with optional source_ref.
 *
 * Exported for testing.
 */
export function formatSourceLabel(task: Task): string {
  if (task.source === "pr-feedback" && task.source_ref) {
    return `PR feedback for ${chalk.cyan(task.source_ref)}`;
  }
  return `${task.source}${task.source_ref ? ` (${task.source_ref})` : ""}`;
}

function formatTask(task: Task, verbose = false): string {
  const colorFn = STATUS_COLORS[task.status] ?? chalk.white;
  const status = colorFn(task.status.padEnd(12));
  const agent = task.agent_name ? chalk.cyan(task.agent_name) : chalk.dim("unassigned");
  const time = chalk.dim(new Date(task.created_at).toLocaleString());

  const typeTag = task.task_type === "research" ? chalk.magenta("[research] ") : "";

  // For pr-feedback tasks in the list view, show the PR ref instead of the raw title
  // so operators can immediately see which PR triggered the feedback cycle.
  const displayTitle =
    task.source === "pr-feedback" && task.source_ref
      ? `${chalk.magenta("[pr-feedback]")} ${chalk.cyan(task.source_ref)} — ${task.title}`
      : `${typeTag}${task.title}`;

  let output = `${chalk.dim(task.id.slice(0, 8))} ${status} ${agent.padEnd(30)} ${displayTitle}`;

  if (verbose) {
    output += `\n  ${chalk.dim("Created:")} ${time}`;
    output += `\n  ${chalk.dim("Source:")}  ${formatSourceLabel(task)}`;
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

/**
 * Print the full feedback-cycle history for a pr-feedback task.
 * Groups all pr-feedback tasks sharing the same source_ref, showing
 * cycle number, status, quality score, and verification outcome.
 */
function printPrFeedbackHistory(store: StateStore, sourceRef: string): void {
  const history = store.getPrFeedbackHistory(sourceRef);
  if (history.length === 0) return;

  console.log(chalk.bold(`\nPR Feedback History — ${chalk.cyan(sourceRef)}`));
  console.log(chalk.dim(`  ${history.length} feedback cycle(s) fired for this PR\n`));

  const header = `  ${"#".padEnd(3)} ${"Task ID".padEnd(10)} ${"Status".padEnd(12)} ${"Agent".padEnd(28)} ${"Score".padStart(6)} ${"Verified".padEnd(10)} ${"Date"}`;
  console.log(chalk.dim(header));
  console.log(chalk.dim("  " + "─".repeat(85)));

  for (let i = 0; i < history.length; i++) {
    const t = history[i];
    const cycle = chalk.dim(`#${String(i + 1).padEnd(2)}`);
    const id = chalk.dim(t.id.slice(0, 8).padEnd(10));
    const colorFn = STATUS_COLORS[t.status] ?? chalk.white;
    const status = colorFn(t.status.padEnd(12));
    const agent = (t.agent_name ?? "—").slice(0, 26).padEnd(28);
    const score = t.quality_score !== null
      ? (t.quality_score >= 0.7 ? chalk.green : chalk.red)(t.quality_score.toFixed(2).padStart(6))
      : chalk.dim("  —   ");
    const verified = t.verification_status
      ? (t.verification_status === "approved"
          ? chalk.green(t.verification_status.padEnd(10))
          : t.verification_status === "rejected"
            ? chalk.red(t.verification_status.padEnd(10))
            : chalk.yellow(t.verification_status.padEnd(10)))
      : chalk.dim("pending   ");
    const date = chalk.dim(new Date(t.created_at).toLocaleString());
    console.log(`  ${cycle} ${id} ${status} ${agent} ${score} ${verified} ${date}`);
  }

  // Summary line
  const scores = history.filter((t) => t.quality_score !== null).map((t) => t.quality_score as number);
  if (scores.length > 1) {
    const first = scores[0];
    const last = scores[scores.length - 1];
    const delta = last - first;
    const deltaStr = delta > 0
      ? chalk.green(`↑ +${delta.toFixed(2)}`)
      : delta < 0
        ? chalk.red(`↓ ${delta.toFixed(2)}`)
        : chalk.dim("→ no change");
    console.log(chalk.dim("\n  Score trend across cycles: ") + deltaStr);
  }
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

/**
 * Render a ScoreTrend as a compact colored string, e.g. "↑ +0.08" or "→ stable".
 */
function formatTrend(trend: ScoreTrend): string {
  switch (trend.direction) {
    case "improving":
      return chalk.green(`↑ +${trend.delta!.toFixed(2)}`);
    case "declining":
      return chalk.red(`↓ ${trend.delta!.toFixed(2)}`);
    case "stable":
      return chalk.dim("→ stable");
    case "insufficient_data":
      return chalk.dim(`— (${trend.scored_count}/${trend.window_size})`);
  }
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
    const COL = { agent: 24, exc: 5, good: 5, fair: 5, poor: 5, unscored: 8, trend: 14 };
    const hdr = [
      "  " + "Agent".padEnd(COL.agent),
      chalk.green("Exc".padStart(COL.exc)),
      chalk.cyan("Good".padStart(COL.good)),
      chalk.yellow("Fair".padStart(COL.fair)),
      chalk.red("Poor".padStart(COL.poor)),
      chalk.dim("Unscrd".padStart(COL.unscored)),
      "Trend".padStart(COL.trend),
    ].join("  ");
    console.log(chalk.dim(hdr));
    console.log(chalk.dim("  " + "─".repeat(COL.agent + (COL.exc + COL.good + COL.fair + COL.poor + COL.unscored + COL.trend) + 12)));
    for (const [agentName, dist] of distEntries) {
      const name = chalk.cyan(agentName.slice(0, COL.agent).padEnd(COL.agent));
      const exc = (dist.excellent > 0 ? chalk.green(String(dist.excellent)) : chalk.dim("0")).padStart(COL.exc + 2);
      const good = (dist.good > 0 ? chalk.cyan(String(dist.good)) : chalk.dim("0")).padStart(COL.good + 2);
      const fair = (dist.fair > 0 ? chalk.yellow(String(dist.fair)) : chalk.dim("0")).padStart(COL.fair + 2);
      const poor = (dist.poor > 0 ? chalk.red(String(dist.poor)) : chalk.dim("0")).padStart(COL.poor + 2);
      const unscored = (dist.unscored > 0 ? chalk.dim(String(dist.unscored)) : chalk.dim("0")).padStart(COL.unscored + 2);
      const trendData = metrics.per_agent_score_trends[agentName];
      const trend = trendData ? formatTrend(trendData) : chalk.dim("—");
      console.log(`  ${name}  ${exc}  ${good}  ${fair}  ${poor}  ${unscored}  ${trend}`);
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

// Unicode block characters for sparklines, lightest → darkest
const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/**
 * Build a Unicode sparkline from an array of nullable numbers.
 * Null / undefined values are rendered as a dim dash.
 */
function sparkline(values: Array<number | null>, width = 8): string {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return chalk.dim("─".repeat(width));

  const min = Math.min(...defined);
  const max = Math.max(...defined);
  const range = max - min || 1;

  return values
    .map((v) => {
      if (v === null) return chalk.dim("▁");
      const idx = Math.min(SPARK_CHARS.length - 1, Math.floor(((v - min) / range) * SPARK_CHARS.length));
      return SPARK_CHARS[idx];
    })
    .join("");
}

/** Format a Δ delta value with ↑/↓ arrow and color. */
function formatDelta(delta: number | null, unit = "", invert = false): string {
  if (delta === null) return chalk.dim("—");
  const positive = invert ? delta < 0 : delta > 0;
  const color = positive ? chalk.green : delta === 0 ? chalk.dim : chalk.red;
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  const sign = delta > 0 ? "+" : "";
  return color(`${arrow} ${sign}${delta.toFixed(2)}${unit}`);
}

function printTrend(trend: MetricsTrend): void {
  const { days, task_days, cycle_days } = trend;
  console.log(chalk.bold(`Metrics Trend — Last ${days} Days\n`));

  // ── Task throughput table ──────────────────────────────────────────────
  console.log(chalk.bold("Task Throughput"));
  const taskHeader = `  ${"Date".padEnd(12)} ${"Done".padStart(5)} ${"Failed".padStart(7)} ${"Avg Time".padStart(10)} ${"Pass%".padStart(7)} ${"Score".padStart(6)}  Throughput`;
  console.log(chalk.dim(taskHeader));
  console.log(chalk.dim("  " + "─".repeat(65)));

  const completedValues = task_days.map((d) => d.tasks_completed as number | null);
  const scoreValues = task_days.map((d) => d.avg_quality_score);
  const passValues = task_days.map((d) => d.verification_pass_rate);

  if (task_days.length === 0) {
    console.log(chalk.dim("  No task data in this window"));
  } else {
    for (const day of task_days) {
      const date = chalk.dim(day.date);
      const done = chalk.green(String(day.tasks_completed).padStart(5));
      const failed = (day.tasks_failed > 0 ? chalk.red(String(day.tasks_failed)) : chalk.dim("0")).padStart(7);
      const dur = formatDuration(day.avg_duration_ms).padStart(10);
      const pass = formatPercent(day.verification_pass_rate).padStart(7);
      const score = (day.avg_quality_score !== null ? day.avg_quality_score.toFixed(2) : chalk.dim("—")).padStart(6);
      // Mini bar: 1 char per task completed (max 8)
      const bar = "█".repeat(Math.min(day.tasks_completed, 8));
      console.log(`  ${date.padEnd(14)} ${done} ${failed} ${dur} ${pass} ${score}  ${chalk.cyan(bar)}`);
    }
  }

  // Throughput sparkline across the window
  console.log();
  console.log(`  Throughput sparkline: ${chalk.cyan(sparkline(completedValues, days))}`);
  console.log(`  Score sparkline:      ${chalk.cyan(sparkline(scoreValues, days))}`);
  console.log(`  Pass-rate sparkline:  ${chalk.cyan(sparkline(passValues, days))}`);

  // ── Daemon cycle table ─────────────────────────────────────────────────
  console.log(chalk.bold("\nDaemon Cycle Duration"));
  const cycleHeader = `  ${"Date".padEnd(12)} ${"Cycles".padStart(7)} ${"Avg Duration".padStart(14)}`;
  console.log(chalk.dim(cycleHeader));
  console.log(chalk.dim("  " + "─".repeat(38)));

  if (cycle_days.length === 0) {
    console.log(chalk.dim("  No cycle data in this window"));
  } else {
    for (const day of cycle_days) {
      const date = chalk.dim(day.date);
      const count = String(day.cycle_count).padStart(7);
      const dur = formatDuration(day.avg_duration_ms).padStart(14);
      console.log(`  ${date.padEnd(14)} ${count} ${dur}`);
    }
  }

  // Cycle duration sparkline
  const cycleDurValues = cycle_days.map((d) => d.avg_duration_ms);
  console.log();
  console.log(`  Cycle duration sparkline: ${chalk.cyan(sparkline(cycleDurValues, days))}`);

  // ── Delta summary vs prior period ──────────────────────────────────────
  console.log(chalk.bold(`\nΔ vs Prior ${days} Days`));
  console.log(
    `  Throughput:     ${formatDelta(trend.throughput_delta, " tasks/day")}`,
  );
  console.log(
    `  Pass rate:      ${formatDelta(trend.pass_rate_delta !== null ? trend.pass_rate_delta * 100 : null, "%")}`,
  );
  console.log(
    `  Quality score:  ${formatDelta(trend.score_delta)}`,
  );
  console.log(
    // invert=true: lower cycle duration is better
    `  Cycle duration: ${formatDelta(trend.cycle_duration_delta !== null ? trend.cycle_duration_delta / 1000 : null, "s", true)}`,
  );

  if (
    trend.throughput_delta === null &&
    trend.pass_rate_delta === null &&
    trend.score_delta === null &&
    trend.cycle_duration_delta === null
  ) {
    console.log(chalk.dim("  (Not enough data to compute deltas — need data in both windows)"));
  }
}

/** Warning threshold: surface a lag notice when this many done tasks are unverified. */
const UNVERIFIED_WARN_THRESHOLD = 10;

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
    .option("--trend [days]", "Show day-by-day metrics trend (default: 7 days)")
    .option("--unverified", "Show only done tasks that have not been verified yet")
    .action((taskId?: string, opts?: { agent?: string; state?: string; type?: string; limit?: string; metrics?: boolean; trend?: string | boolean; unverified?: boolean }) => {
      const store = new StateStore();

      if (opts?.trend !== undefined) {
        const days = typeof opts.trend === "string" ? parseInt(opts.trend, 10) || 7 : 7;
        const trend = store.getDailyTrend(days);
        printTrend(trend);
        store.close();
        return;
      }

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

        // For pr-feedback tasks, show the full feedback-cycle history for that PR
        if (match.source === "pr-feedback" && match.source_ref) {
          printPrFeedbackHistory(store, match.source_ref);
        }

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
        const limit = parseInt(opts?.limit ?? "20");

        // --unverified: show only done tasks that haven't been verified yet
        if (opts?.unverified) {
          const tasks = store.getUnverified(limit);
          if (tasks.length === 0) {
            console.log(chalk.green("✓ No unverified done tasks — all caught up!"));
          } else {
            console.log(chalk.bold(`Unverified Done Tasks (${tasks.length})\n`));
            for (const task of tasks) {
              console.log(formatTask(task));
            }
            console.log(chalk.dim(`\n${tasks.length} task(s) pending verification`));
            console.log(chalk.dim("Run `orch improve verify` to verify these tasks."));
          }
        } else {
          const tasks = store.listTasks({
            status: opts?.state as Task["status"] | undefined,
            agent_name: opts?.agent,
            task_type: opts?.type as Task["task_type"] | undefined,
            limit,
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

          // Show verification summary after the task list
          const unverifiedCount = store.countUnverified();
          const doneTasks = store.listTasks({ status: "done", limit: 9999 });
          const doneCount = doneTasks.length;
          const verifiedCount = doneCount - unverifiedCount;

          if (doneCount > 0) {
            console.log();
            const verifiedStr = verifiedCount > 0
              ? chalk.green(`${verifiedCount} verified`)
              : chalk.dim("0 verified");
            const pendingStr = unverifiedCount > 0
              ? chalk.yellow(`${unverifiedCount} pending verification`)
              : chalk.dim("0 pending verification");
            console.log(`Verification: ${chalk.green(String(doneCount))} done, ${verifiedStr}, ${pendingStr}`);

            if (unverifiedCount >= UNVERIFIED_WARN_THRESHOLD) {
              console.log(
                chalk.yellow(`⚠ ${unverifiedCount} done tasks have never been verified.`) +
                  chalk.dim(" Run `orch improve verify` to check quality."),
              );
            }
          }
        }
      }

      store.close();
    });
}
