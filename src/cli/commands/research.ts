import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { StateStore } from "../../state/store.js";
import { Dispatcher } from "../../orchestrator/dispatcher.js";

export function registerResearchCommand(program: Command): void {
  program
    .command("research")
    .description("Dispatch a research question to an agent (no code changes, analysis only)")
    .argument("<question>", "Research question or feasibility inquiry")
    .option("-a, --agent <name>", "Target agent (auto-routes if omitted)")
    .option("-t, --title <title>", "Custom title for the task")
    .action(async (question: string, opts: { agent?: string; title?: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const dispatcher = new Dispatcher(config, store);

      if (opts.agent && !config.agents[opts.agent]) {
        console.error(chalk.red(`Unknown agent: ${opts.agent}`));
        console.error(`Available: ${Object.keys(config.agents).join(", ")}`);
        store.close();
        process.exit(1);
      }

      console.log(chalk.dim(`Dispatching research to ${opts.agent ? chalk.cyan(opts.agent) : "auto-routed agent"}...\n`));

      try {
        const result = await dispatcher.dispatch(question, {
          agentName: opts.agent,
          taskType: "research",
          title: opts.title ?? `[research] ${question.slice(0, 80)}`,
        });

        console.log(chalk.bold.blue("\n📋 Research Results\n"));
        console.log(result.response.content);
        console.log(chalk.dim(`\nTask: ${result.taskId.slice(0, 8)} | Agent: ${result.agentName} | Tokens: ${result.response.usage.input_tokens}in/${result.response.usage.output_tokens}out`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Research failed: ${msg}`));
        process.exit(1);
      } finally {
        store.close();
      }
    });
}
