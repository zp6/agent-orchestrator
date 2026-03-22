import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../../config/schema.js";
import { ManagementClient, type ProxyAgentStatus } from "../../client/management-client.js";
import { planSync, executeSync } from "../../orchestrator/sync.js";

const STATUS_COLORS: Record<string, (s: string) => string> = {
  running: chalk.green,
  starting: chalk.yellow,
  stopped: chalk.red,
  exited: chalk.red,
  unknown: chalk.dim,
  offline: chalk.dim,
};

function colorStatus(status: string): string {
  const fn = STATUS_COLORS[status] ?? chalk.dim;
  return fn(status);
}

async function fetchLiveStatus(
  management: ManagementClient,
): Promise<Map<string, ProxyAgentStatus> | null> {
  const reachable = await management.isReachable();
  if (!reachable) return null;
  try {
    const agents = await management.listAgents();
    return new Map(agents.map((a) => [a.name, a]));
  } catch {
    return null;
  }
}

export function registerAgentsCommand(program: Command): void {
  const agentsCmd = program
    .command("agents")
    .description("List configured agents, show detail, or sync with proxy");

  // Default action: list or detail
  agentsCmd
    .argument("[name]", "Agent name for detailed view")
    .action(async (name?: string) => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);
      const management = new ManagementClient(config.proxy);
      const liveStatus = await fetchLiveStatus(management);

      if (name) {
        // Detail view
        if (name === "sync") return; // handled by subcommand
        const agent = config.agents[name];
        if (!agent) {
          console.error(chalk.red(`Unknown agent: ${name}`));
          console.error(`Available: ${Object.keys(config.agents).join(", ")}`);
          process.exit(1);
        }
        const live = liveStatus?.get(name);
        const status = live?.status ?? "offline";

        console.log(chalk.bold(name) + "  " + colorStatus(status));
        console.log(`  ${chalk.dim("Directory:")}    ${config.base_dir}/${agent.dir}`);
        console.log(`  ${chalk.dim("Description:")}  ${agent.description}`);
        console.log(`  ${chalk.dim("Capabilities:")} ${agent.capabilities.join(", ")}`);
        console.log(`  ${chalk.dim("Topics:")}       ${agent.owns_topics.join(", ")}`);
        if (agent.github) {
          console.log(`  ${chalk.dim("GitHub:")}       ${agent.github}`);
        }
        if (agent.docker?.port) {
          console.log(`  ${chalk.dim("Port:")}         ${agent.docker.port}`);
        }
        if (agent.docker?.permissions) {
          console.log(`  ${chalk.dim("Permissions:")}  ${agent.docker.permissions}`);
        }
        if (agent.docker?.session) {
          console.log(`  ${chalk.dim("Session:")}      ${agent.docker.session}`);
        }
      } else {
        // List view
        const proxyOnline = liveStatus !== null;
        console.log(
          chalk.bold("Configured Agents") +
            (proxyOnline ? chalk.green("  proxy online") : chalk.dim("  proxy offline")),
        );
        console.log();

        const maxLen = Math.max(...Object.keys(config.agents).map((n) => n.length));
        for (const [agentName, agent] of Object.entries(config.agents)) {
          const live = liveStatus?.get(agentName);
          const status = live ? colorStatus(live.status) : chalk.dim("--");
          console.log(
            `  ${chalk.cyan(agentName.padEnd(maxLen + 2))} ${status.padEnd(20)} ${agent.description}`,
          );
        }
        console.log(
          `\n${chalk.dim(`${Object.keys(config.agents).length} agents configured`)}`,
        );
      }
    });

  // Subcommand: sync
  agentsCmd
    .command("sync")
    .description("Reconcile agents.yaml with proxy (create missing, start stopped)")
    .option("--dry-run", "Show what would happen without making changes")
    .option("--remove-unknown", "Remove agents on proxy not in agents.yaml")
    .action(async (opts: { dryRun?: boolean; removeUnknown?: boolean }) => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);
      const management = new ManagementClient(config.proxy);

      const reachable = await management.isReachable();
      if (!reachable) {
        console.error(chalk.red("Proxy is not reachable at " + config.proxy.url));
        process.exit(1);
      }

      const proxyAgents = await management.listAgents();
      const actions = planSync(config, proxyAgents);

      if (opts.dryRun) {
        console.log(chalk.bold("Dry run — no changes will be made\n"));
      }

      const actionable = actions.filter((a) => a.type !== "skip");
      const skipped = actions.filter((a) => a.type === "skip");

      if (actionable.length === 0) {
        console.log(chalk.green("All agents are in sync."));
        if (skipped.length > 0) {
          console.log(chalk.dim(`${skipped.length} agent(s) already running.`));
        }
        return;
      }

      // Show planned actions
      for (const action of actions) {
        const icon =
          action.type === "create" ? chalk.green("+") :
          action.type === "start" ? chalk.yellow("~") :
          action.type === "update" ? chalk.blue("~") :
          action.type === "remove" ? chalk.red("-") :
          chalk.dim("=");

        const label =
          action.type === "skip"
            ? chalk.dim(`${action.agentName}: ${action.reason}`)
            : `${action.agentName}: ${action.type} — ${action.reason}`;

        console.log(`  ${icon} ${label}`);
      }
      console.log();

      if (opts.dryRun) return;

      const result = await executeSync(config, management, actions, {
        removeUnknown: opts.removeUnknown,
      });

      if (result.errors.length > 0) {
        console.log(chalk.red(`\n${result.errors.length} error(s):`));
        for (const err of result.errors) {
          console.log(chalk.red(`  ${err.agentName}: ${err.error}`));
        }
      } else {
        console.log(chalk.green("Sync complete."));
      }
    });
}
