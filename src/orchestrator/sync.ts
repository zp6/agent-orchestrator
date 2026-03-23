import { ManagementClient, type ProxyAgentStatus, type ProxyAgentConfig } from "../client/management-client.js";
import type { OrchestratorConfig, AgentConfig } from "../config/schema.js";
import { resolve } from "node:path";

export interface SyncAction {
  type: "create" | "start" | "update" | "remove" | "skip";
  agentName: string;
  reason: string;
}

export interface SyncResult {
  actions: SyncAction[];
  errors: Array<{ agentName: string; error: string }>;
}

export function planSync(
  config: OrchestratorConfig,
  proxyAgents: ProxyAgentStatus[],
): SyncAction[] {
  const actions: SyncAction[] = [];
  const proxyMap = new Map(proxyAgents.map((a) => [a.name, a]));

  // For each desired agent, determine what action is needed
  for (const [name, agent] of Object.entries(config.agents)) {
    const existing = proxyMap.get(name);

    if (!existing) {
      // Agent doesn't exist on proxy — create it
      actions.push({
        type: "create",
        agentName: name,
        reason: "Not registered with proxy",
      });
    } else if (existing.status === "exited" || existing.status === "stopped") {
      // Agent exists but is stopped — start it
      actions.push({
        type: "start",
        agentName: name,
        reason: `Container is ${existing.status}`,
      });
    } else if (hasConfigDrift(config, name, agent, existing)) {
      // Agent exists but config has drifted — update
      actions.push({
        type: "update",
        agentName: name,
        reason: "Config differs from desired state",
      });
    } else {
      actions.push({
        type: "skip",
        agentName: name,
        reason: `Running (${existing.status})`,
      });
    }
  }

  // Agents on proxy that aren't in our config — flag for removal
  for (const proxyAgent of proxyAgents) {
    if (!config.agents[proxyAgent.name]) {
      actions.push({
        type: "remove",
        agentName: proxyAgent.name,
        reason: "Not in agents.yaml",
      });
    }
  }

  return actions;
}

function hasConfigDrift(
  config: OrchestratorConfig,
  _name: string,
  agent: AgentConfig,
  proxy: ProxyAgentStatus,
): boolean {
  const desiredProject = resolve(config.base_dir, agent.dir);
  if (proxy.project !== desiredProject) return true;
  if (agent.docker?.port && proxy.port !== agent.docker.port) return true;
  if (agent.docker?.permissions && proxy.permissions !== agent.docker.permissions) return true;
  return false;
}

function toProxyConfig(
  config: OrchestratorConfig,
  name: string,
  agent: AgentConfig,
): ProxyAgentConfig {
  return {
    name,
    project: resolve(config.base_dir, agent.dir),
    port: agent.docker?.port ?? 3460,
    permissions: agent.docker?.permissions ?? "auto",
    session: agent.docker?.session ?? "fresh",
    sessionId: agent.docker?.session_id ?? "",
    sshKey: config.proxy.ssh_key,
    ghToken: config.proxy.gh_token,
    packages: agent.docker?.packages,
    apiKey: agent.docker?.api_key ?? "",
    allowedTools: agent.docker?.allowed_tools,
  };
}

export async function executeSync(
  config: OrchestratorConfig,
  management: ManagementClient,
  actions: SyncAction[],
  options?: { dryRun?: boolean; removeUnknown?: boolean },
): Promise<SyncResult> {
  const result: SyncResult = { actions, errors: [] };

  for (const action of actions) {
    if (options?.dryRun) continue;

    try {
      switch (action.type) {
        case "create": {
          const agent = config.agents[action.agentName];
          if (!agent) break;
          const proxyConfig = toProxyConfig(config, action.agentName, agent);
          await management.createAgent(proxyConfig);
          break;
        }
        case "start":
          await management.startAgent(action.agentName);
          break;
        case "update": {
          const agent = config.agents[action.agentName];
          if (!agent) break;
          const proxyConfig = toProxyConfig(config, action.agentName, agent);
          await management.updateAgent(action.agentName, proxyConfig);
          break;
        }
        case "remove":
          if (options?.removeUnknown) {
            await management.deleteAgent(action.agentName);
          }
          break;
        case "skip":
          break;
      }
    } catch (err) {
      result.errors.push({
        agentName: action.agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
