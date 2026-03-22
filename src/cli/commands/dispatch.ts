import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { Dispatcher } from "../../orchestrator/dispatcher.js";
import { StateStore } from "../../state/store.js";

export function registerDispatchCommand(program: Command): void {
  program
    .command("dispatch")
    .description("Dispatch a task to an agent")
    .argument("<message>", "Task description to send to the agent")
    .option("-a, --agent <name>", "Target agent (auto-routed if omitted)")
    .option("-t, --title <title>", "Task title (defaults to first 100 chars of message)")
    .action(async (message: string, opts: { agent?: string; title?: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const dispatcher = new Dispatcher(config, store);

      try {
        if (!opts.agent) {
          const { Router } = await import("../../orchestrator/router.js");
          const router = new Router(config);
          const matches = router.route(message);
          if (matches.length > 0) {
            console.log(
              chalk.dim(
                `Routing to ${chalk.cyan(matches[0].agentName)} (${matches[0].reason})`,
              ),
            );
          }
        }

        console.log(chalk.dim("Dispatching...\n"));

        const result = await dispatcher.dispatch(message, {
          agentName: opts.agent,
          title: opts.title,
        });

        console.log(chalk.green(`Task ${result.taskId} completed`));
        console.log(chalk.dim(`Agent: ${result.agentName}`));
        console.log(
          chalk.dim(
            `Tokens: ${result.response.usage.input_tokens} in / ${result.response.usage.output_tokens} out`,
          ),
        );
        console.log(`\n${result.response.content}`);

        store.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Dispatch failed: ${msg}`));
        store.close();
        process.exit(1);
      }
    });
}
