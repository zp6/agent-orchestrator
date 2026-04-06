import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface ProviderConfig {
  model: string;
  api_key_env?: string;
  daily_token_limit?: number;
}

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

/** Per-agent token budget configuration. */
export interface TokenBudgetConfig {
  /**
   * Daily token budget (resets at midnight UTC).
   * When set, takes precedence over the provider-level daily_token_limit.
   */
  daily?: number;
  /**
   * Weekly token budget (rolling 7-day window).
   */
  weekly?: number;
  /**
   * Utilization percentage at which a dashboard warning is shown (default: 80).
   * Range: 1–100.
   */
  warning_pct?: number;
  /**
   * Utilization percentage at which a Telegram alert fires (default: 100).
   * Range: 1–200 (allows alerting before OR after the limit).
   */
  critical_pct?: number;
  /**
   * If true, pause new dispatches to this agent once critical_pct is reached.
   * The pause lifts automatically when the budget window resets.
   * Defaults to false.
   */
  pause_on_exceeded?: boolean;
}

export interface AgentConfig {
  dir: string;
  repo?: string;
  /** Agents with the same pool share a capability and work is distributed across them. */
  pool?: string;
  /** LLM model to use for this agent. Defaults to "claude-opus-4-6". */
  model?: string;
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
  /** Provider to use for this agent. Must match a key in the top-level `providers` map. Defaults to "claude". */
  provider?: string;
  owns_topics: string[];
  system_prompt?: string;
  max_concurrent?: number;
  stale_timeout_ms?: number;
  docker?: AgentDockerConfig;
  /** Per-agent token budget alerts and pause-on-exceeded control. */
  token_budget?: TokenBudgetConfig;
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

export interface RetryConfig {
  /**
   * Backoff delays in milliseconds for each connection-error retry attempt.
   * Index 0 is the delay before the 1st retry, index 1 before the 2nd, etc.
   * Defaults to [30000, 60000, 120000] (30s → 60s → 120s).
   */
  connection_error_delays_ms?: number[];

  /**
   * Maximum number of automatic retry attempts for connection errors
   * (ECONNREFUSED, ETIMEDOUT, HTTP 5xx, etc.) before the task is permanently
   * failed with reason "connection-error-exhausted".
   * Defaults to 3.
   */
  max_connection_retries?: number;
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

/** Global dashboard-level budget alert thresholds (applied when per-agent overrides are absent). */
export interface GlobalBudgetConfig {
  /**
   * Default warning utilization percentage across all agents (default: 80).
   * Can be overridden per-agent via agent.token_budget.warning_pct.
   */
  warning_pct?: number;
  /**
   * Default critical utilization percentage across all agents (default: 100).
   * Can be overridden per-agent via agent.token_budget.critical_pct.
   */
  critical_pct?: number;
}

export interface DashboardConfig {
  digest?: DigestConfig;
  budget?: GlobalBudgetConfig;
}

export interface OrchestratorConfig {
  proxy: ProxyConfig;
  base_dir: string;
  orchestrator_dir: string;
  providers?: Record<string, ProviderConfig>;
  verification?: VerificationConfig;
  pr_review?: PRReviewConfig;
  escalation?: EscalationConfig;
  retry?: RetryConfig;
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

  // Resolve GH_TOKEN: agents.yaml → env var → ~/.claude-orchestrator/.env → `gh auth token` CLI
  if (!parsed.proxy.gh_token && process.env.GH_TOKEN) {
    parsed.proxy.gh_token = process.env.GH_TOKEN;
  }
  if (!parsed.proxy.gh_token) {
    // Read from persistent .env file (set during setup)
    const envPath = resolve(process.env.HOME ?? "", ".claude-orchestrator", ".env");
    try {
      const envContent = readFileSync(envPath, "utf-8");
      const match = envContent.match(/^GH_TOKEN=(.+)$/m);
      if (match?.[1]) {
        parsed.proxy.gh_token = match[1].trim();
      }
    } catch {
      // .env file doesn't exist
    }
  }
  if (!parsed.proxy.gh_token) {
    // Last resort: ask gh CLI
    try {
      const token = execSync("gh auth token", { encoding: "utf-8", timeout: 5000 }).trim();
      if (token) {
        parsed.proxy.gh_token = token;
      }
    } catch {
      // gh CLI not available or not logged in
    }
  }

  return parsed;
}

export function getAgentDir(config: OrchestratorConfig, agentName: string): string {
  const agent = config.agents[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}`);
  }
  // Agents with repo: get their code cloned inside the container at
  // /home/claude/workspace/<repo-name>. The x-working-dir header must
  // use this container path, not the host path.
  // Agents without repo: use bind-mounted host directories.
  if (agent.repo) {
    const repoName = agent.repo.replace(/.*\//, "").replace(/\.git$/, "");
    return `/home/claude/workspace/${repoName}`;
  }
  return resolve(config.base_dir, agent.dir);
}

export function getAgentModel(config: OrchestratorConfig, agentName: string): string {
  return config.agents[agentName]?.model ?? "claude-opus-4-6";
}

export function getManagerUrl(config: OrchestratorConfig): string {
  return config.proxy.manager_url ?? "http://localhost:3400";
}

/**
 * Get all agent names in a pool. If the agent has no pool, returns just that agent.
 * Useful for distributing work across multiple instances of the same capability.
 */
export function getPoolMembers(config: OrchestratorConfig, agentName: string): string[] {
  const agent = config.agents[agentName];
  if (!agent?.pool) return [agentName];

  return Object.entries(config.agents)
    .filter(([, a]) => a.pool === agent.pool)
    .map(([name]) => name);
}

/**
 * Resolve a pool name or agent name to the pool's member list.
 * If poolOrAgent matches a pool name, returns all members.
 * If it matches an agent name, returns that agent's pool members (or just itself).
 */
export function resolvePool(config: OrchestratorConfig, poolOrAgent: string): string[] {
  // Direct agent name match
  if (config.agents[poolOrAgent]) {
    return getPoolMembers(config, poolOrAgent);
  }
  // Pool name match
  const members = Object.entries(config.agents)
    .filter(([, a]) => a.pool === poolOrAgent)
    .map(([name]) => name);
  return members.length > 0 ? members : [poolOrAgent];
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
