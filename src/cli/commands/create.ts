import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { Bootstrapper } from "../../orchestrator/bootstrapper.js";
import { StateStore } from "../../state/store.js";

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
  program
    .command("create")
    .description("Bootstrap a new agent with template, scope, and optional Codex variant")
    .argument("<name>", "Agent name (used as directory name and identifier)")
    .option("-d, --description <desc>", "Agent description")
    .option("--capabilities <caps>", "Comma-separated capabilities")
    .option("--remote <url>", "Git remote URL")
    .option("--similar <agent>", "Seed from existing agent (copies permissions, learned rules)")
    .option("--scope-owns <topics>", "Comma-separated topics this agent owns")
    .option("--scope-excludes <topics>", "Comma-separated topics this agent does NOT own")
    .option("--pool <name>", "Pool name (defaults to agent name)")
    .option("--no-codex", "Skip creating Codex pool variant")
    .option("--no-interactive", "Skip interactive prompts")
    .action(async (name: string, opts: {
      description?: string;
      capabilities?: string;
      remote?: string;
      similar?: string;
      scopeOwns?: string;
      scopeExcludes?: string;
      pool?: string;
      codex?: boolean;
      interactive?: boolean;
    }) => {
      const configPath = findConfigPath(program);
      const config = loadConfig(configPath);

      if (config.agents[name]) {
        console.error(chalk.red(`Agent "${name}" already exists in agents.yaml`));
        process.exit(1);
      }

      let description = opts.description ?? "";
      let capabilities: string[] = opts.capabilities?.split(",").map((c) => c.trim()) ?? [];
      let remote = opts.remote ?? "";
      let similar = opts.similar ?? "";

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
        if (!similar) {
          const agents = Object.keys(config.agents).filter((n) => config.agents[n].github);
          console.log(chalk.dim(`  Available agents: ${agents.join(", ")}`));
          similar = await ask(rl, chalk.cyan("Seed from similar agent (leave blank to skip): "));
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

      const store = new StateStore();
      const bootstrapper = new Bootstrapper(config, store);

      try {
        const result = bootstrapper.create(
          {
            name,
            description,
            capabilities,
            remote: remote || undefined,
            similarAgent: similar || undefined,
            scopeOwns: opts.scopeOwns?.split(",").map((t) => t.trim()),
            scopeExcludes: opts.scopeExcludes?.split(",").map((t) => t.trim()),
            pool: opts.pool,
            createCodexVariant: opts.codex,
          },
          configPath,
        );

        console.log(chalk.green(`  ✓ Created directory: ${result.path}`));
        console.log(chalk.green("  ✓ Initialized git repo"));
        console.log(chalk.green("  ✓ Generated from template (CLAUDE.md, docs/, .claude/)"));
        if (similar) {
          console.log(chalk.green(`  ✓ Seeded from ${similar} (permissions, learned rules)`));
        }
        console.log(chalk.green("  ✓ Registered in agents.yaml"));
        if (result.codexVariantCreated) {
          console.log(chalk.green("  ✓ Created Codex pool variant"));
        }
        if (result.remoteSet) {
          console.log(chalk.green(`  ✓ Set remote: ${remote}`));
        }

        console.log(chalk.bold(`\nAgent "${name}" created.`));
        console.log(chalk.dim("Deploy with: orch agents sync"));
        console.log(chalk.dim("The agent will automatically appear in team meetings, routing, and the dashboard."));
      } catch (err) {
        console.error(chalk.red(`Failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
      } finally {
        store.close();
      }
    });
}
