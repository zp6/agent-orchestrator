import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import type { OperatorControl } from "../../state/store.js";

function statusIcon(status: string): string {
  switch (status) {
    case "applied": return chalk.green("✅");
    case "failed":  return chalk.red("❌");
    default:        return chalk.yellow("⏳");
  }
}

function formatControl(c: OperatorControl): string {
  const shortId = c.task_id.slice(0, 12);
  const typeLabel = c.control_type === "redirect" && c.value
    ? `redirect→${c.value}`
    : c.control_type === "inject"
    ? `inject("${(c.value ?? "").slice(0, 30)}${(c.value ?? "").length > 30 ? "…" : ""}")`
    : c.control_type === "merge"
    ? `merge→${c.value ?? "?"}`
    : c.control_type;

  const ts = (c.applied_at ?? c.created_at).slice(0, 16).replace("T", " ");
  const failNote = c.failure_reason ? chalk.dim(` — ${c.failure_reason.slice(0, 50)}`) : "";
  const opNote = c.operator ? chalk.dim(` [${c.operator}]`) : "";

  return `  ${statusIcon(c.status)} ${chalk.bold(shortId)}  ${typeLabel.padEnd(28)}  ${c.status.padEnd(8)}  ${ts}${failNote}${opNote}`;
}

export function registerControlsCommand(program: Command): void {
  const cmd = program
    .command("controls")
    .description("Operator control plane — pause, redirect, inject directives into in-flight tasks");

  // orch controls list [--limit N] [--json]
  cmd
    .command("list")
    .description("List recent operator controls")
    .option("-n, --limit <n>", "Number of controls to show", "20")
    .option("--json", "Output raw JSON")
    .action((opts: { limit: string; json?: boolean }) => {
      const limit = parseInt(opts.limit, 10);
      const store = new StateStore();
      const controls = store.getOperatorControls(isNaN(limit) ? 20 : limit);
      if (opts.json) {
        for (const c of controls) console.log(JSON.stringify(c));
        return;
      }
      if (controls.length === 0) {
        console.log(chalk.dim("No operator controls recorded yet."));
        return;
      }
      console.log(chalk.bold(`\n🎛  Operator Controls (${controls.length})\n`));
      for (const c of controls) console.log(formatControl(c));
      console.log();
    });

  // orch controls pause <task-id>
  cmd
    .command("pause <task-id>")
    .description("Pause an in-flight task (prevents next-cycle dispatch)")
    .action((taskId: string) => {
      const store = new StateStore();
      const task = store.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task ${taskId} not found.`));
        process.exit(1);
      }
      store.addOperatorControl({ task_id: taskId, control_type: "pause", operator: "cli" });
      console.log(chalk.green(`✅ Pause control queued for task ${taskId}`));
      console.log(chalk.dim("Will be applied at the start of the next daemon cycle."));
    });

  // orch controls resume <task-id>
  cmd
    .command("resume <task-id>")
    .description("Resume a paused task")
    .action((taskId: string) => {
      const store = new StateStore();
      const task = store.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task ${taskId} not found.`));
        process.exit(1);
      }
      store.addOperatorControl({ task_id: taskId, control_type: "resume", operator: "cli" });
      console.log(chalk.green(`✅ Resume control queued for task ${taskId}`));
    });

  // orch controls redirect <task-id> <agent>
  cmd
    .command("redirect <task-id> <agent>")
    .description("Redirect task to a different agent")
    .action((taskId: string, agent: string) => {
      const store = new StateStore();
      const task = store.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task ${taskId} not found.`));
        process.exit(1);
      }
      store.addOperatorControl({ task_id: taskId, control_type: "redirect", value: agent, operator: "cli" });
      console.log(chalk.green(`✅ Redirect control queued: ${taskId} → ${agent}`));
    });

  // orch controls inject <task-id> <directive...>
  cmd
    .command("inject <task-id> <directive...>")
    .description("Inject additional context/directive into a task's description")
    .action((taskId: string, directiveParts: string[]) => {
      const directive = directiveParts.join(" ");
      const store = new StateStore();
      const task = store.getTask(taskId);
      if (!task) {
        console.error(chalk.red(`Task ${taskId} not found.`));
        process.exit(1);
      }
      store.addOperatorControl({ task_id: taskId, control_type: "inject", value: directive, operator: "cli" });
      console.log(chalk.green(`✅ Inject control queued for task ${taskId}`));
      console.log(chalk.dim(`Directive: ${directive.slice(0, 80)}${directive.length > 80 ? "…" : ""}`));
    });
}
