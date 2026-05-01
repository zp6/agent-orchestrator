import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { AgentClient } from "../../client/agent-client.js";
import { StateStore } from "../../state/store.js";

export function registerAskCommand(program: Command): void {
  program
    .command("ask")
    .description("Ask an agent a question (streaming response)")
    .argument("<question>", "Question to ask")
    .requiredOption("-a, --agent <name>", "Target agent")
    .option("-m, --model <model>", "Model to use", "claude-opus-4-6")
    .action(async (question: string, opts: { agent: string; model: string }) => {
      const config = loadConfig(program.opts().config);
      const store = new StateStore();
      const client = new AgentClient(config, store);

      if (!config.agents[opts.agent]) {
        console.error(chalk.red(`Unknown agent: ${opts.agent}`));
        console.error(`Available: ${Object.keys(config.agents).join(", ")}`);
        store.close();
        process.exit(1);
      }

      console.log(chalk.dim(`Asking ${chalk.cyan(opts.agent)}...\n`));

      try {
        client.emitMonologue(
          opts.agent,
          null,
          "plan",
          "I am answering a direct operator question and will return the result as soon as it is ready.",
        );
        const gen = client.stream(opts.agent, question, {
          model: opts.model,
        });
        for await (const chunk of gen) {
          process.stdout.write(chunk);
        }
        client.emitMonologue(
          opts.agent,
          null,
          "reflection",
          "The streamed answer is complete, and I am wrapping up the direct question.",
        );
        console.log();
      } catch (err) {
        // Fall back to non-streaming if streaming fails
        try {
          const response = await client.send(opts.agent, question, {
            model: opts.model,
          });
          client.emitMonologue(
            opts.agent,
            null,
            "reflection",
            "The direct question completed successfully, so I am returning the answer and closing out the interaction.",
          );
          console.log(response.content);
        } catch (fallbackErr) {
          const msg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          client.emitMonologue(
            opts.agent,
            null,
            "escalation",
            "The direct question failed, so I am logging the blocker and surfacing the error.",
          );
          console.error(chalk.red(`Ask failed: ${msg}`));
          process.exit(1);
        }
      } finally {
        store.close();
      }
    });
}
