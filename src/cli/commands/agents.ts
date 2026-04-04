import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, type OrchestratorConfig } from "../../config/schema.js";
import { ManagementClient, type ProxyAgentStatus } from "../../client/management-client.js";
import { AgentClient } from "../../client/agent-client.js";
import { planSync, executeSync } from "../../orchestrator/sync.js";
import { Deployer } from "../../orchestrator/deployer.js";

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

export type HealthStatus = "alive" | "unreachable" | "no-port";

/**
 * Concurrently pings all agents and returns their liveness status.
 * Uses a short timeout (default 3s) so the command stays snappy even when agents are down.
 */
export async function pingAllAgents(
  config: OrchestratorConfig,
  agentNames: string[],
  timeoutMs = 3000,
): Promise<Map<string, HealthStatus>> {
  const client = new AgentClient(config);
  const results = await Promise.all(
    agentNames.map(async (name): Promise<[string, HealthStatus]> => {
      const hasPort = !!config.agents[name]?.docker?.port;
      if (!hasPort) return [name, "no-port"];
      const alive = await client.ping(name, timeoutMs);
      return [name, alive ? "alive" : "unreachable"];
    }),
  );
  return new Map(results);
}

function formatHealth(health: HealthStatus): string {
  switch (health) {
    case "alive":
      return chalk.green("✓ alive");
    case "unreachable":
      return chalk.red("✗ unreachable");
    case "no-port":
      return chalk.dim("— (no port)");
  }
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

      const agentNames = Object.keys(config.agents);
      // Ping all agents concurrently (3s timeout) so health is always fresh
      const healthMap = await pingAllAgents(config, agentNames, 3000);

      if (name) {
        // Detail view
        if (name === "sync") return; // handled by subcommand
        const agent = config.agents[name];
        if (!agent) {
          console.error(chalk.red(`Unknown agent: ${name}`));
          console.error(`Available: ${agentNames.join(", ")}`);
          process.exit(1);
        }
        const live = liveStatus?.get(name);
        const status = live?.status ?? "offline";
        const health = healthMap.get(name) ?? "no-port";

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
        console.log(`  ${chalk.dim("Health:")}       ${formatHealth(health)}`);
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

        const maxLen = Math.max(...agentNames.map((n) => n.length));
        for (const [agentName, agent] of Object.entries(config.agents)) {
          const live = liveStatus?.get(agentName);
          const status = live ? colorStatus(live.status) : chalk.dim("--");
          const health = healthMap.get(agentName) ?? "no-port";
          console.log(
            `  ${chalk.cyan(agentName.padEnd(maxLen + 2))} ${status.padEnd(20)} ${formatHealth(health).padEnd(24)} ${agent.description}`,
          );
        }
        console.log(
          `\n${chalk.dim(`${agentNames.length} agents configured`)}`,
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

  // Subcommand: redeploy
  agentsCmd
    .command("redeploy")
    .description("Rebuild agent containers with latest code")
    .argument("[name]", "Agent to redeploy (all stale agents if omitted)")
    .option("--dry-run", "Show which agents would be redeployed")
    .action(async (name?: string, opts?: { dryRun?: boolean }) => {
      const configPath = program.opts().config;
      const config = loadConfig(configPath);
      const deployer = new Deployer(config);

      if (name) {
        if (opts?.dryRun) {
          console.log(chalk.dim(`Would redeploy: ${chalk.cyan(name)}`));
          return;
        }
        console.log(chalk.dim(`Redeploying ${chalk.cyan(name)}...`));
        const result = await deployer.redeploy(name);
        if (result.action === "redeployed") {
          console.log(chalk.green(`${name}: ${result.detail}`));
        } else {
          console.error(chalk.red(`${name}: ${result.detail}`));
        }
      } else {
        // Redeploy all stale agents
        const stale = deployer.getStaleAgents();

        if (stale.length === 0) {
          console.log(chalk.green("All agents are up-to-date."));
          return;
        }

        console.log(chalk.bold(`${stale.length} agent(s) have new commits:\n`));
        for (const agentName of stale) {
          console.log(`  ${chalk.cyan(agentName)}`);
        }

        if (opts?.dryRun) {
          console.log(chalk.dim("\nDry run — no containers rebuilt."));
          return;
        }

        console.log();
        const results = await deployer.redeployStale();
        for (const result of results) {
          if (result.action === "redeployed") {
            console.log(chalk.green(`  ${result.agentName}: ${result.detail}`));
          } else {
            console.error(chalk.red(`  ${result.agentName}: ${result.detail}`));
          }
        }
      }
    });
}
