import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

export interface AgentDockerConfig {
  port?: number;
  permissions?: string;
  session?: "fresh" | "continue" | "resume";
  session_id?: string;
  packages?: string[];
  allowed_tools?: string;
  api_key?: string;
}

export interface AgentConfig {
  dir: string;
  description: string;
  capabilities: string[];
  github?: string;
  owns_topics: string[];
  system_prompt?: string;
  max_concurrent?: number;
  docker?: AgentDockerConfig;
}

export interface ProxyConfig {
  url: string;
  timeout_ms: number;
}

export interface OrchestratorConfig {
  proxy: ProxyConfig;
  base_dir: string;
  orchestrator_dir: string;
  agents: Record<string, AgentConfig>;
}

function findConfig(): string {
  // 1. Current working directory
  const cwd = resolve(process.cwd(), "agents.yaml");
  if (existsSync(cwd)) return cwd;

  // 2. Relative to this source file (package install location)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(__dirname, "..", "..", "agents.yaml");
  if (existsSync(pkgRoot)) return pkgRoot;

  // 3. Well-known location
  const home = resolve(process.env.HOME ?? "~", ".claude-orchestrator", "agents.yaml");
  if (existsSync(home)) return home;

  throw new Error(
    "Cannot find agents.yaml. Provide --config or run from the orchestrator directory.",
  );
}

export function loadConfig(configPath?: string): OrchestratorConfig {
  const path = configPath ?? findConfig();
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw) as OrchestratorConfig;

  if (!parsed.proxy?.url) {
    throw new Error("Config missing proxy.url");
  }
  if (!parsed.base_dir) {
    throw new Error("Config missing base_dir");
  }
  if (!parsed.agents || Object.keys(parsed.agents).length === 0) {
    throw new Error("Config missing agents");
  }

  // Default orchestrator_dir to the directory containing agents.yaml
  if (!parsed.orchestrator_dir) {
    parsed.orchestrator_dir = dirname(path);
  }

  return parsed;
}

export function getAgentDir(config: OrchestratorConfig, agentName: string): string {
  const agent = config.agents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}`);
  }
  return resolve(config.base_dir, agent.dir);
}
