import type { Command } from "commander";
import chalk from "chalk";
import { StateStore, type Task } from "../../state/store.js";

/** Status badge for display. */
function statusBadge(status: string): string {
  switch (status) {
    case "done":
      return chalk.green("✓ done");
    case "failed":
      return chalk.red("✗ failed");
    case "escalated":
      return chalk.red("⚠ escalated");
    case "in_progress":
      return chalk.yellow("● in_progress");
    case "dispatched":
      return chalk.cyan("→ dispatched");
    case "pending":
      return chalk.gray("○ pending");
    default:
      return chalk.gray(status);
  }
}

/** Format a task row for the lineage tree view. */
function formatTaskRow(task: Task, isRoot: boolean): string {
  const prefix = isRoot ? chalk.bold("◆") : "  ├─";
  const id = chalk.dim(task.id.slice(0, 10));
  const agent = task.agent_name ? chalk.blue(task.agent_name) : chalk.dim("unassigned");
  const status = statusBadge(task.status);
  const repo = task.source_ref
    ? chalk.magenta(task.source_ref.split("#")[0] ?? "")
    : chalk.dim("no-repo");
  const title = task.title.length > 70 ? task.title.slice(0, 67) + "…" : task.title;
  return `${prefix} ${id} ${status}  ${repo}  ${agent}  ${title}`;
}

export function registerLineageCommand(program: Command): void {
  const lineage = program
    .command("lineage")
    .description("Trace cross-repo task lineage: see which tasks belong to the same logical unit of work");

  // ── show <task-id> ─────────────────────────────────────────────────────────
  lineage
    .command("show <taskId>")
    .description("Show the full lineage group for a given task")
    .option("--json", "Output raw JSON")
    .action((taskId: string, opts: { json?: boolean }) => {
      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(chalk.red("Could not open state database:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const task = store.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task not found: ${taskId}`));
        process.exit(1);
      }

      const lineageGroupId = task.lineage_group_id ?? task.id;
      const group = store.getLineageGroup(lineageGroupId);

      if (opts.json) {
        console.log(JSON.stringify({ lineage_group_id: lineageGroupId, tasks: group }, null, 2));
        return;
      }

      const rootTask = group.find((t) => t.id === lineageGroupId);
      const repos = [...new Set(group.map((t) => t.source_ref?.split("#")[0]).filter(Boolean))];

      console.log();
      console.log(chalk.bold.underline(`Lineage Group: ${lineageGroupId.slice(0, 10)}`));
      console.log(chalk.dim(`  Tasks: ${group.length}  |  Repos: ${repos.join(", ") || "none"}  |  Root: ${rootTask?.title ?? "unknown"}`));
      console.log();

      for (const t of group) {
        const isRoot = t.id === lineageGroupId;
        console.log(formatTaskRow(t, isRoot));
      }

      console.log();
    });

  // ── list ───────────────────────────────────────────────────────────────────
  lineage
    .command("list")
    .description("List lineage groups that span multiple tasks (cross-repo coordination)")
    .option("-n, --limit <n>", "Maximum groups to show", "20")
    .option("--json", "Output raw JSON")
    .action((opts: { limit?: string; json?: boolean }) => {
      let store: StateStore;
      try {
        store = new StateStore();
      } catch (err) {
        console.error(chalk.red("Could not open state database:"), err instanceof Error ? err.message : String(err));
        process.exit(1);
      }

      const limit = parseInt(opts.limit ?? "20", 10);
      const groups = store.getMultiTaskLineageGroups(limit);

      if (opts.json) {
        console.log(JSON.stringify(groups, null, 2));
        return;
      }

      if (groups.length === 0) {
        console.log(chalk.dim("No multi-task lineage groups found yet."));
        return;
      }

      console.log();
      console.log(chalk.bold.underline(`Cross-Repo Lineage Groups (${groups.length})`));
      console.log();

      for (const g of groups) {
        const groupId = chalk.dim(g.lineage_group_id.slice(0, 10));
        const count = chalk.yellow(`${g.task_count} tasks`);
        const repos = g.repos
          ? chalk.magenta(g.repos.split(",").map((r: string) => r.trim()).join(", "))
          : chalk.dim("—");
        const title = g.root_title
          ? (g.root_title.length > 60 ? g.root_title.slice(0, 57) + "…" : g.root_title)
          : chalk.dim("unknown");
        const timeRange = chalk.dim(
          `${g.earliest.slice(0, 10)} → ${g.latest.slice(0, 10)}`,
        );

        console.log(`  ${groupId}  ${count}  ${repos}  ${timeRange}`);
        console.log(`           ${title}`);
        console.log();
      }
    });
}
