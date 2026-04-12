import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface ProviderLimits {
  hourly?: number;
  daily?: number;
  weekly?: number;
}

export interface ProviderConfig {
  model: string;
  api_key_env?: string;
  daily_token_limit?: number;  // deprecated — use limits.daily
  limits?: ProviderLimits;
}

export interface AgentDockerConfig {
  port?: number;
  permissions?: string;
  session?: "fresh" | "continue" | "resume";
  session_id?: string;
  packages?: string[];
  allowed_tools?: string;
  api_key?: string;
  /**
   * Per-agent override for health check retry delays (ms).
   * Each entry is the wait time before that attempt (attempt 0, 1, 2, ...).
   * Useful for slow-starting containers (e.g. Codex/OpenAI providers that
   * need extra time for git pull + CLI WebSocket warmup).
   * Overrides deploy.health_check_delays_ms when set.
   */
  health_check_delays_ms?: number[];
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

/**
 * Declarative policy controlling when an agent is allowed to "borrow" work
 * from a GitHub repo it does not own (i.e. the task's source_ref repo differs
 * from the agent's own `github` field).
 *
 * Without a borrow config an agent can still be cross-dispatched — the policy
 * only ADDS enforcement when explicitly configured.  This preserves backward
 * compatibility with existing ad-hoc supervisor cross-dispatches.
 *
 * Example (in agents.yaml):
 *   claude-proxy:
 *     borrow:
 *       enabled: true
 *       can_work_on:
 *         - rapartlu/agent-orchestrator
 *       min_idle_minutes: 5
 *       max_concurrent_borrowed: 1
 */
export interface BorrowConfig {
  /**
   * Set to true to opt this agent into the borrow policy.
   * When false (or absent) the agent may still be cross-dispatched but the
   * additional guards below are not applied.
   */
  enabled?: boolean;

  /**
   * Explicit allowlist of GitHub repos this agent may borrow from.
   * When omitted (but enabled=true) the agent can borrow from any repo.
   * Example: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"]
   */
  can_work_on?: string[];

  /**
   * Minimum number of minutes this agent must have been idle (no active task
   * on its own repo) before it becomes eligible to borrow external work.
   * Defaults to 0 (no minimum) when omitted.
   */
  min_idle_minutes?: number;

  /**
   * Maximum number of borrowed (cross-repo) tasks this agent may hold
   * simultaneously.  Defaults to 1 when omitted.
   */
  max_concurrent_borrowed?: number;
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
  /**
   * Maximum number of open PRs allowed for this agent's repo before new
   * dispatches are paused.  Overrides dispatch.max_open_prs.
   */
  max_open_prs?: number;
  stale_timeout_ms?: number;
  docker?: AgentDockerConfig;
  /** Per-agent token budget alerts and pause-on-exceeded control. */
  token_budget?: TokenBudgetConfig;
  /**
   * Automatically reroute a source_ref to a substitute agent after this many
   * consecutive verifier rejections for the same issue by this agent.
   * Set to 0 or omit to disable.
   */
  auto_reroute_rejection_threshold?: number;
  /**
   * Declarative borrow policy: controls when this agent may be dispatched to
   * issues in repos it doesn't own.  Omit to allow ad-hoc cross-dispatching
   * (legacy behaviour).  Set `enabled: true` to enforce the guards below.
   */
  borrow?: BorrowConfig;
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

  /**
   * Quality score floor for reviewer-pool agent approvals.  When a task
   * completed by a reviewer-pool agent is approved but its quality_score
   * falls below this value, the daemon immediately fires a Telegram alert
   * and dispatches a supervisor follow-up task within the same cycle.
   *
   * This prevents weak reviews from silently entering the approval record:
   * a reviewer task that barely passes still gets flagged for a second look.
   *
   * Set to 0 to disable the check entirely.
   * Defaults to 0.80 when omitted.
   */
  reviewer_low_score_threshold?: number;

  /**
   * Per-agent rolling-average SLA thresholds.  When an agent's rolling
   * quality score (calculated over `quality_sla_window_tasks` recent tasks)
   * drops below its threshold, the daemon fires a Telegram alert and logs a
   * structured warning — prompting the supervisor to consider routing changes.
   *
   * Falls back to `min_score` (default 0.70) when an agent has no entry here.
   * Set an agent's value to 0 to silence alerts for that agent entirely.
   *
   * Example:
   *   per_agent_quality_thresholds:
   *     claude-orchestrator-reviewer: 0.75
   *     claude-research-agent: 0.72
   */
  per_agent_quality_thresholds?: Record<string, number>;

  /**
   * Number of most-recent scored tasks used to compute each agent's rolling
   * average for SLA threshold checks.  Larger windows smooth out noise;
   * smaller windows react faster to degradation.
   * Defaults to 5 when omitted.
   */
  quality_sla_window_tasks?: number;
}

export interface ProxyConfig {
  url: string;
  manager_url?: string;
  timeout_ms: number;
  ssh_key?: string;
  gh_token?: string;
}

/**
 * Identifies the kind of orchestrator-side LLM work being performed.
 * Used for per-task model and provider overrides.
 */
export type LLMTaskKind =
  | "default"
  | "router"
  | "planner"
  | "reviewer"
  | "verifier"
  | "supervisor"
  | "improvement"
  | "issue_matcher";

export interface LLMModelConfig {
  default?: string;
  router?: string;
  planner?: string;
  reviewer?: string;
  verifier?: string;
  supervisor?: string;
  improvement?: string;
  issue_matcher?: string;
}

export interface LLMConfig {
  /**
   * Preferred provider family for orchestrator-side LLM calls.
   * Used to choose which reviewer-style agent container to target first.
   * Model IDs still come from `models` overrides or built-in defaults.
   */
  provider?: "auto" | "claude" | "codex";
  /**
   * Explicit agent name to target for orchestrator-side LLM work.
   * Example: "codex-orchestrator-reviewer" or "claude-orchestrator-reviewer".
   */
  preferred_agent?: string;
  /**
   * Fallback model for orchestrator-side LLM calls when a task-specific model
   * override is not configured.
   */
  default_model?: string;
  /**
   * Per-task model overrides for orchestrator-side LLM calls.
   */
  models?: LLMModelConfig;
  /**
   * Per-task provider preference overrides.
   * When set, overrides the global `provider` setting for specific task kinds.
   *
   * Claude benefits from automatic prompt caching on repeated system-prompt
   * prefixes; Codex (via CLI) does not.  Routing high-frequency tasks such as
   * "verifier", "supervisor", and "router" to Claude therefore saves significant
   * input tokens compared to a pure round-robin across both providers.
   *
   * Default behaviour when `provider` is "auto" and no per-task override is set:
   * all high-frequency LLM tasks ("router", "planner", "verifier", "supervisor",
   * "improvement", "issue_matcher") implicitly prefer Claude.  Set a task entry
   * to "codex" or "auto" to opt out of that default.
   *
   * Example:
   *   task_providers:
   *     verifier: claude
   *     supervisor: claude
   *     reviewer: auto   # let global provider setting decide
   */
  task_providers?: Partial<Record<LLMTaskKind, "claude" | "codex" | "auto">>;
}

/**
 * Configuration for the pre-dispatch conflict-risk scoring check.
 *
 * Before a task is dispatched, the orchestrator computes an overlap score
 * between the issue's likely touched files and all open PRs' changed files.
 * If the score exceeds `block_threshold`, dispatch is blocked (queued for
 * a later cycle when the lane is clear).  If it exceeds `warn_threshold`
 * only, the check passes with an informational annotation.
 */
export interface ConflictRiskConfig {
  /**
   * Set to false to disable the check entirely.
   * Defaults to true.
   */
  enabled?: boolean;

  /**
   * Score above which dispatch is blocked (a "conflict-risk-high" gate failure).
   * Value is a 0–1 fraction of the issue's fingerprint tokens that overlap with
   * in-flight PR files.  Defaults to 0.5 (50 % overlap).
   */
  block_threshold?: number;

  /**
   * Score above which a warning annotation is added to the pre-dispatch
   * checklist but dispatch still proceeds.  Defaults to 0.25.
   */
  warn_threshold?: number;
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

export interface DaemonConfig {
  /**
   * Main daemon poll cycle interval in milliseconds.
   * Defaults to 300000 (5 minutes) when omitted.
   */
  poll_interval_ms?: number;
}

export interface TriggersConfig {
  /**
   * Hours after a task completes before the same source_ref can be dispatched
   * again.  Prevents double-dispatch when an issue isn't closed before the next
   * poll cycle picks it up.
   * Defaults to 24 when omitted.
   */
  recency_window_hours?: number;

  /**
   * How long (ms) an agent can hold an issue claim before it expires and the
   * issue becomes available for dispatch to another agent.
   * Defaults to 7200000 (2 hours) when omitted.
   */
  issue_claim_ttl_ms?: number;

  /**
   * Maximum number of issues the orchestrator can auto-create per repo.
   * Prevents flooding a repo with orchestrator-generated issues.
   * Defaults to 10 when omitted.
   */
  max_open_orchestrator_issues?: number;
}

export interface NotificationsConfig {
  /**
   * Minimum interval (ms) between repeated Telegram notifications for the
   * same notification key.  Rate-limits noisy alerts.
   * Defaults to 900000 (15 minutes) when omitted.
   */
  telegram_rate_limit_ms?: number;
}

export interface DeployConfig {
  /**
   * Warmup time (ms) after a container restart before dispatching work.
   * Gives the entrypoint time to finish git pull, CLI init, and temp-file setup.
   * Defaults to 5000 (5 seconds) when omitted.
   */
  post_restart_warmup_ms?: number;
  /**
   * Health check retry delay schedule (ms).
   * Each entry is the wait time before that attempt (attempt 0, 1, 2, ...).
   * The number of entries also determines the max retry count.
   * Defaults to [2000, 5000, 15000, 30000] (4 attempts, ~52s total window).
   * Can be overridden per-agent via docker.health_check_delays_ms.
   */
  health_check_delays_ms?: number[];
}

export interface DispatchConfig {
  /**
   * Backoff delays in milliseconds for each general retry attempt.
   * Index 0 is the delay before the 1st retry, index 1 before the 2nd, etc.
   * Defaults to [30000, 120000, 600000] (30s → 2min → 10min) when omitted.
   */
  retry_delays_ms?: number[];
  /**
   * Maximum number of open PRs allowed per repo before dispatching more work.
   * Can be overridden per-agent via agent.max_open_prs.
   * Defaults to 3 when omitted.
   */
  max_open_prs?: number;
}

export interface OrchestratorConfig {
  proxy: ProxyConfig;
  llm?: LLMConfig;
  base_dir: string;
  orchestrator_dir: string;
  providers?: Record<string, ProviderConfig>;
  verification?: VerificationConfig;
  pr_review?: PRReviewConfig;
  conflict_risk?: ConflictRiskConfig;
  escalation?: EscalationConfig;
  retry?: RetryConfig;
  daemon?: DaemonConfig;
  triggers?: TriggersConfig;
  notifications?: NotificationsConfig;
  deploy?: DeployConfig;
  dispatch?: DispatchConfig;
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

/**
 * Read a secret from Docker/OrbStack secrets paths.
 * Checks (in order):
 *   1. /run/secrets/<name>  — standard Docker secrets mount
 *   2. ~/.claude-orchestrator/secrets/<name>  — local dev secrets
 * Returns the trimmed file contents, or undefined if not found.
 */
function readSecret(name: string): string | undefined {
  const paths = [
    `/run/secrets/${name}`,
    resolve(process.env.HOME ?? "", ".claude-orchestrator", "secrets", name),
  ];
  for (const p of paths) {
    try {
      const value = readFileSync(p, "utf-8").trim();
      if (value) return value;
    } catch {
      // File doesn't exist — try next path
    }
  }
  return undefined;
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

  // Validate github: field format for each agent that specifies one
  for (const [name, agent] of Object.entries(parsed.agents)) {
    if (agent.github && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(agent.github)) {
      throw new Error(
        `Agent "${name}" has invalid github field: "${agent.github}". ` +
          `Expected "owner/repo" format (e.g. "rapartlu/agent-orchestrator").`,
      );
    }
  }

  // Default orchestrator_dir to the directory containing agents.yaml
  if (!parsed.orchestrator_dir) {
    parsed.orchestrator_dir = dirname(path);
  }

  // Resolve GH_TOKEN:
  //   1. agents.yaml proxy.gh_token (already in parsed)
  //   2. Docker/OrbStack secrets (/run/secrets/ or ~/.claude-orchestrator/secrets/)
  //   3. GH_TOKEN env var
  //   4. ~/.claude-orchestrator/.env file
  //   5. `gh auth token` CLI (last resort)
  if (!parsed.proxy.gh_token) {
    parsed.proxy.gh_token = readSecret("gh_token");
  }
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

  // Keep downstream gh CLI checks aligned with config-loaded auth.
  if (parsed.proxy.gh_token) {
    process.env.GH_TOKEN = parsed.proxy.gh_token;
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
