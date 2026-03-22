import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { Bootstrapper } from "../../orchestrator/bootstrapper.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

function findConfigPath(program: Command): string {
  const configPath = program.opts().config;
  if (configPath) return resolve(configPath);
  const cwd = resolve(process.cwd(), "agents.yaml");
  if (existsSync(cwd)) return cwd;
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, "..", "..", "..", "agents.yaml");
}

export function registerCreateCommand(program: Command): void {
  // Register as a subcommand of agents
  // Since agents is already registered, we add create via the program directly
  program
    .command("create")
    .description("Bootstrap a new agent with best-practice scaffolding")
    .argument("<name>", "Agent name (used as directory name and identifier)")
    .option("-d, --description <desc>", "Agent description")
    .option("--capabilities <caps>", "Comma-separated capabilities")
    .option("--remote <url>", "Git remote URL")
    .option("--no-interactive", "Skip interactive prompts (requires --description and --capabilities)")
    .action(async (name: string, opts: { description?: string; capabilities?: string; remote?: string; interactive?: boolean }) => {
      const configPath = findConfigPath(program);
      const config = loadConfig(configPath);

      // Check if agent already exists
      if (config.agents[name]) {
        console.error(chalk.red(`Agent "${name}" already exists in agents.yaml`));
        process.exit(1);
      }

      let description = opts.description ?? "";
      let capabilities: string[] = opts.capabilities?.split(",").map((c) => c.trim()) ?? [];
      let remote = opts.remote ?? "";

      // Interactive mode
      if (opts.interactive !== false && (!description || capabilities.length === 0)) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });

        if (!description) {
          description = await ask(rl, chalk.cyan("Description: "));
        }
        if (capabilities.length === 0) {
          const caps = await ask(rl, chalk.cyan("Capabilities (comma-separated): "));
          capabilities = caps.split(",").map((c) => c.trim()).filter(Boolean);
        }
        if (!remote) {
          remote = await ask(rl, chalk.cyan("GitHub remote (leave blank to skip): "));
        }

        rl.close();
      }

      if (!description) {
        console.error(chalk.red("Description is required"));
        process.exit(1);
      }
      if (capabilities.length === 0) {
        console.error(chalk.red("At least one capability is required"));
        process.exit(1);
      }

      console.log(chalk.dim(`\nCreating agent "${name}"...\n`));

      const bootstrapper = new Bootstrapper(config);
      try {
        const result = bootstrapper.create(
          { name, description, capabilities, remote: remote || undefined },
          configPath,
        );

        console.log(chalk.green(`  Created directory: ${result.path}`));
        console.log(chalk.green("  Initialized git repo"));
        console.log(chalk.green("  Generated CLAUDE.md"));
        console.log(chalk.green("  Generated README.md"));
        console.log(chalk.green("  Added .gitignore"));
        console.log(chalk.green("  Created initial commit"));
        if (result.remoteSet) {
          console.log(chalk.green(`  Set remote: ${remote}`));
        }
        console.log(chalk.green("  Registered in agents.yaml"));

        console.log(chalk.bold(`\nAgent "${name}" created.`));
        console.log(chalk.dim(`Deploy with: orch agents sync`));
      } catch (err) {
        console.error(chalk.red(`Failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      }
    });
}
