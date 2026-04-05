import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { AgentClient } from "../../client/agent-client.js";

export function registerAskCommand(program: Command): void {
  program
    .command("ask")
    .description("Ask an agent a question (streaming response)")
    .argument("<question>", "Question to ask")
    .requiredOption("-a, --agent <name>", "Target agent")
    .option("-m, --model <model>", "Model to use", "claude-opus-4-6")
    .action(async (question: string, opts: { agent: string; model: string }) => {
      const config = loadConfig(program.opts().config);
      const client = new AgentClient(config);

      if (!config.agents[opts.agent]) {
        console.error(chalk.red(`Unknown agent: ${opts.agent}`));
        console.error(`Available: ${Object.keys(config.agents).join(", ")}`);
        process.exit(1);
      }

      console.log(chalk.dim(`Asking ${chalk.cyan(opts.agent)}...\n`));

      try {
        const gen = client.stream(opts.agent, question, {
          model: opts.model,
        });
        for await (const chunk of gen) {
          process.stdout.write(chunk);
        }
        console.log();
      } catch (err) {
        // Fall back to non-streaming if streaming fails
        try {
          const response = await client.send(opts.agent, question, {
            model: opts.model,
          });
          console.log(response.content);
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          console.error(chalk.red(`Ask failed: ${msg}`));
          process.exit(1);
        }
      }
    });
}
