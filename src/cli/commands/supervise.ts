import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";
import { Supervisor } from "../../orchestrator/supervisor.js";
import { Dispatcher } from "../../orchestrator/dispatcher.js";

const ACTION_COLORS: Record<string, (s: string) => string> = {
  dispatch: chalk.blue,
  verify: chalk.yellow,
  redeploy: chalk.cyan,
  "create-issue": chalk.green,
  "follow-up": chalk.magenta,
  none: chalk.dim,
};

export function registerSuperviseCommand(program: Command): void {
  program
    .command("supervise")
    .description("Run the orchestrator supervisor to review state and take action")
    .option("--dry-run", "Show decisions without executing them")
    .action(async (opts: { dryRun?: boolean }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const supervisor = new Supervisor(config, store);

      console.log(chalk.dim("Supervisor reviewing current state...\n"));

      const decisions = await supervisor.review();

      if (decisions.length === 0) {
        console.log(chalk.green("Everything looks good. No actions needed."));
        store.close();
        return;
      }

      console.log(chalk.bold(`${decisions.length} decision(s):\n`));

      for (const d of decisions) {
        const colorFn = ACTION_COLORS[d.action] ?? chalk.white;
        const agent = d.agentName ? chalk.cyan(d.agentName) : "";
        console.log(`  ${colorFn(d.action.padEnd(14))} ${agent}`);
        console.log(`    ${chalk.dim("Reason:")} ${d.reason}`);
        if (d.message) {
          console.log(`    ${chalk.dim("Message:")} ${d.message.slice(0, 120)}`);
        }
        console.log();
      }

      if (opts.dryRun) {
        console.log(chalk.dim("Dry run — no actions executed."));
        store.close();
        return;
      }

      // Execute decisions
      const dispatcher = new Dispatcher(config, store);
      let executed = 0;

      for (const d of decisions) {
        if (d.action === "none") continue;

        if ((d.action === "dispatch" || d.action === "follow-up") && d.agentName && d.message) {
          try {
            const result = await dispatcher.dispatch(d.message, {
              agentName: d.agentName,
              title: `[supervisor] ${d.reason.slice(0, 80)}`,
            });
            console.log(chalk.green(`  Executed ${d.action} → ${d.agentName} (task ${result.taskId.slice(0, 8)})`));
            executed++;
          } catch (err) {
            console.error(chalk.red(`  Failed ${d.action} → ${d.agentName}: ${err instanceof Error ? err.message : err}`));
          }
        }
      }

      console.log(chalk.bold(`\n${executed} action(s) executed.`));
      store.close();
    });
}
