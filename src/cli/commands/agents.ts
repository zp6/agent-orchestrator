import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";

export function registerAgentsCommand(program: Command): void {
  program
    .command("agents")
    .description("List configured agents or show detail for one")
    .argument("[name]", "Agent name for detailed view")
    .action((name?: string) => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);

      if (name) {
        const agent = config.agents[name];
        if (!agent) {
          console.error(chalk.red(`Unknown agent: ${name}`));
          console.error(`Available: ${Object.keys(config.agents).join(", ")}`);
          process.exit(1);
        }
        console.log(chalk.bold(name));
        console.log(`  ${chalk.dim("Directory:")}   ${config.base_dir}/${agent.dir}`);
        console.log(`  ${chalk.dim("Description:")} ${agent.description}`);
        console.log(`  ${chalk.dim("Capabilities:")} ${agent.capabilities.join(", ")}`);
        console.log(`  ${chalk.dim("Topics:")}      ${agent.owns_topics.join(", ")}`);
        if (agent.github) {
          console.log(`  ${chalk.dim("GitHub:")}      ${agent.github}`);
        }
      } else {
        console.log(chalk.bold("Configured Agents\n"));
        const maxLen = Math.max(...Object.keys(config.agents).map((n) => n.length));
        for (const [agentName, agent] of Object.entries(config.agents)) {
          console.log(
            `  ${chalk.cyan(agentName.padEnd(maxLen + 2))} ${agent.description}`,
          );
        }
        console.log(`\n${chalk.dim(`${Object.keys(config.agents).length} agents configured`)}`);
      }
    });
}
