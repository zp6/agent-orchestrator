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

export interface AgentLinearConfig {
  teams?: string[];
  projects?: string[];
}

export interface AgentSlackConfig {
  channels?: string[];
  mention_pattern?: string;
}

export interface AgentConfig {
  dir: string;
  repo?: string;
  /**
   * Branch to watch for new commits when `repo` is set.
   * Used by the auto-redeploy check in `getStaleRepoAgents()`.
   * Defaults to `"main"` when omitted.
   */
  deploy_branch?: string;
  description: string;
  capabilities: string[];
  github?: string;
  linear?: AgentLinearConfig;
  slack?: AgentSlackConfig;
  owns_topics: string[];
  system_prompt?: string;
  max_concurrent?: number;
  stale_timeout_ms?: number;
  docker?: AgentDockerConfig;
}

export interface VerificationConfig {
  enabled: boolean;
  /**
   * Explicit allowlist of trigger sources to verify (e.g. ["github", "linear"]).
   * When absent or empty, ALL sources are verified — including "manual" tasks from
   * supervisor dispatches and PR feedback loops.
   * "manual" tasks are always included even when a sources list is configured,
   * so the quality feedback loop covers the full task population.
   */
  sources?: string[];
  min_score?: number;
  /**
   * Maximum number of revision cycles to attempt for rejected tasks.
   * Set to 0 to disable re-dispatch entirely (verify-only mode).
   * Defaults to 1 when omitted.
   */
  max_revisions?: number;
  /**
   * How many unverified tasks to process per daemon cycle.
   * Increase if task volume is high and many tasks remain unverified.
   * Defaults to 10.
   */
  verify_per_cycle?: number;
}

export interface ProxyConfig {
  url: string;
  manager_url?: string;
  timeout_ms: number;
  ssh_key?: string;
  gh_token?: string;
}

export interface PRReviewConfig {
  /**
   * Maximum number of pr-feedback dispatch rounds before the daemon stops
   * redispatching to the agent and automatically escalates the PR to a human
   * reviewer.  Applies both to the daemon's dispatch ceiling and to the
   * reviewer's GitHub-comment counting.  Defaults to 3 when omitted.
   */
  feedback_ceiling?: number;

  /**
   * Number of consecutive conflict escalations before the daemon auto-closes
   * a persistently conflicting PR and re-dispatches the linked issue to the
   * agent from a clean state.  Defaults to 2 when omitted.
   *
   * Set to 0 to disable auto-close entirely.
   */
  conflict_close_threshold?: number;
}

export interface EscalationConfig {
  /**
   * Maximum number of cumulative retry attempts for a given source_ref before
   * the task is automatically escalated.  When the retry_count on the current
   * task reaches this threshold the task is marked 'escalated', all further
   * retries are suppressed, and a GitHub issue comment is posted flagging the
   * escalation.
   *
   * Defaults to 3 when omitted.  Set to 0 to disable automatic escalation.
   */
  retry_limit?: number;

  /**
   * Optional Slack channel or webhook URL to notify on escalation
   * (e.g. "#oncall" or "https://hooks.slack.com/...").
   * When omitted, escalation is only written to the log and posted as a
   * GitHub issue comment (if the task's source is "github").
   */
  notify_channel?: string;
}

export interface DigestConfig {
  /**
   * Slack incoming webhook URL to POST the daily digest to.
   * When omitted, the scheduled digest is disabled even if `schedule` is set.
   * Example: "https://hooks.slack.com/services/T.../B.../..."
   */
  slack_webhook: string;

  /**
   * Wall-clock time to post the digest each day, in "HH:MM" 24-hour format
   * (local time on the host running the daemon).
   * Defaults to "09:00" when omitted.
   */
  schedule?: string;
}

export interface DashboardConfig {
  digest?: DigestConfig;
}

export interface OrchestratorConfig {
  proxy: ProxyConfig;
  base_dir: string;
  orchestrator_dir: string;
  verification?: VerificationConfig;
  pr_review?: PRReviewConfig;
  escalation?: EscalationConfig;
  dashboard?: DashboardConfig;
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

  // Fall back to GH_TOKEN env var for proxy.gh_token
  if (!parsed.proxy.gh_token && process.env.GH_TOKEN) {
    parsed.proxy.gh_token = process.env.GH_TOKEN;
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

export function getManagerUrl(config: OrchestratorConfig): string {
  return config.proxy.manager_url ?? "http://localhost:3400";
}

export function getAgentApiKey(config: OrchestratorConfig, agentName: string): string {
  const agent = config.agents[agentName];
  return agent?.docker?.api_key ?? "not-set";
}

export function getAgentBaseUrl(config: OrchestratorConfig, agentName: string): string | undefined {
  const agent = config.agents[agentName];
  if (!agent?.docker?.port) return undefined;
  const base = new URL(config.proxy.url);
  return `${base.protocol}//${base.hostname}:${agent.docker.port}`;
}
