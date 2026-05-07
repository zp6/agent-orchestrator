/**
 * Operator Config Catalog — discoverable list of every tunable system parameter.
 *
 * Each entry describes one configuration knob: where it lives, its type, default
 * value, and a human-readable description.  The `orch config list` CLI command
 * renders this catalog so operators can discover settings without reading source.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ConfigSource = "agents.yaml" | "hardcoded";

export interface ConfigEntry {
  /** Dot-path key (e.g. "proxy.timeout_ms" or "daemon.poll_interval_ms"). */
  key: string;
  /** Where the value comes from. */
  source: ConfigSource;
  /** TypeScript type description. */
  type: string;
  /** Human-readable default value (string representation). */
  default: string;
  /** One-line description. */
  description: string;
  /** Functional category for grouping in output. */
  category: ConfigCategory;
}

export type ConfigCategory =
  | "proxy"
  | "daemon"
  | "dispatch"
  | "verification"
  | "pr_review"
  | "retry"
  | "escalation"
  | "llm"
  | "budget"
  | "agent"
  | "triggers"
  | "deploy"
  | "notifications"
  | "dashboard"
  | "health"
  | "research";

// ── Catalog ──────────────────────────────────────────────────────────────────

export const CONFIG_CATALOG: readonly ConfigEntry[] = [
  // ── Proxy ──────────────────────────────────────────────────────────────────
  {
    key: "proxy.url",
    source: "agents.yaml",
    type: "string",
    default: "(required)",
    description: "Base URL for the agent proxy server.",
    category: "proxy",
  },
  {
    key: "proxy.manager_url",
    source: "agents.yaml",
    type: "string",
    default: "http://localhost:3400",
    description: "Management API URL for agent lifecycle operations.",
    category: "proxy",
  },
  {
    key: "proxy.timeout_ms",
    source: "agents.yaml",
    type: "number",
    default: "(required)",
    description: "HTTP request timeout for proxy calls (ms).",
    category: "proxy",
  },
  {
    key: "proxy.ssh_key",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: "Path to SSH key for git operations inside containers.",
    category: "proxy",
  },
  {
    key: "proxy.gh_token",
    source: "agents.yaml",
    type: "string",
    default: "(auto-resolved)",
    description: "GitHub token. Resolved from: config > secrets > GH_TOKEN env > .env > gh CLI.",
    category: "proxy",
  },
  {
    key: "proxy.linear_api_key",
    source: "agents.yaml",
    type: "string",
    default: "(auto-resolved, optional)",
    description: "Linear API key pushed to agent containers via proxy sync. Resolved from: config > secrets > LINEAR_API_KEY env > .env. Optional — agents work without it but cannot query Linear.",
    category: "proxy",
  },

  // ── Daemon ─────────────────────────────────────────────────────────────────
  {
    key: "daemon.poll_interval_ms",
    source: "hardcoded",
    type: "number",
    default: "300000 (5min)",
    description: "Main daemon poll cycle interval.",
    category: "daemon",
  },
  {
    key: "daemon.improvement_check_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "6 (~30min)",
    description: "Cycles between improvement detection runs.",
    category: "daemon",
  },
  {
    key: "daemon.auto_merge_sweep_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "3 (~15min)",
    description: "Cycles between PR auto-merge sweeps.",
    category: "daemon",
  },
  {
    key: "daemon.supervisor_check_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "3 (~15min)",
    description: "Cycles between supervisor dispatch checks.",
    category: "daemon",
  },
  {
    key: "daemon.research_link_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "6 (~30min)",
    description: "Cycles between research finding → issue linking runs.",
    category: "daemon",
  },
  {
    key: "daemon.backlog_triage_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "60 (~5h)",
    description: "Cycles between backlog triage dispatches to agents.",
    category: "daemon",
  },
  {
    key: "daemon.container_restart_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "100 (~50min)",
    description: "Cycles between preventive container restart checks.",
    category: "daemon",
  },
  {
    key: "daemon.agent_sync_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "10 (~5min)",
    description: "Cycles between agent sync to recover from proxy restarts.",
    category: "daemon",
  },
  {
    key: "daemon.closed_issue_check_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "3 (~15min)",
    description: "Cycles between checks for closed issues to cancel in-flight tasks.",
    category: "daemon",
  },
  {
    key: "daemon.orphan_pr_check_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "1 (every cycle)",
    description: "Cycles between orphan-branch → PR creation checks.",
    category: "daemon",
  },
  {
    key: "daemon.pr_telemetry_log_every_n_cycles",
    source: "hardcoded",
    type: "number",
    default: "10 (~50min)",
    description: "Cycles between PR creation failure telemetry logging.",
    category: "daemon",
  },
  {
    key: "daemon.idle_reclaim_threshold_cycles",
    source: "hardcoded",
    type: "number",
    default: "2",
    description: "Idle cycles before force-reclaim bypasses the duplicate-guard recency window.",
    category: "daemon",
  },
  {
    key: "daemon.stale_issue_age_days",
    source: "hardcoded",
    type: "number",
    default: "7",
    description: "Days before an issue is considered stale.",
    category: "daemon",
  },
  {
    key: "daemon.result_missing_threshold_ms",
    source: "hardcoded",
    type: "number",
    default: "1800000 (30min)",
    description: "Time after which a done task with no result is flagged as a silent failure.",
    category: "daemon",
  },
  {
    key: "daemon.default_stale_threshold_ms",
    source: "hardcoded",
    type: "number",
    default: "600000 (10min)",
    description: "Default per-agent timeout for stale task detection (overridable per agent).",
    category: "daemon",
  },

  // ── Dispatch & Retry ───────────────────────────────────────────────────────
  {
    key: "dispatch.max_retries",
    source: "hardcoded",
    type: "number",
    default: "3",
    description: "Maximum general retry attempts for failed tasks.",
    category: "dispatch",
  },
  {
    key: "dispatch.failure_reroute_threshold",
    source: "hardcoded",
    type: "number",
    default: "3",
    description: "Consecutive failures before task is rerouted to a different agent.",
    category: "dispatch",
  },
  {
    key: "dispatch.retry_delays_ms",
    source: "hardcoded",
    type: "number[]",
    default: "[30000, 120000, 600000]",
    description: "Backoff delays per retry attempt (30s → 2min → 10min).",
    category: "dispatch",
  },
  {
    key: "dispatch.max_open_prs",
    source: "agents.yaml",
    type: "number",
    default: "3",
    description: "Maximum open PRs allowed per repo before dispatching more work.",
    category: "dispatch",
  },
  {
    key: "dispatch.failure_genome_risk_threshold",
    source: "agents.yaml",
    type: "number",
    default: "0.75",
    description: "Genome risk score above which the dispatcher reroutes away from the candidate route.",
    category: "dispatch",
  },
  {
    key: "dispatch.timeout_retry_max",
    source: "hardcoded",
    type: "number",
    default: "2",
    description: "Max retries specifically for timeout failures (SIGTERM).",
    category: "dispatch",
  },
  {
    key: "dispatch.timeout_retry_backoff_ms",
    source: "hardcoded",
    type: "number",
    default: "120000 (2min)",
    description: "Fixed backoff between timeout-retry attempts.",
    category: "dispatch",
  },

  // ── Retry (configurable) ──────────────────────────────────────────────────
  {
    key: "retry.max_connection_retries",
    source: "agents.yaml",
    type: "number",
    default: "3",
    description: "Max automatic retries for connection errors (ECONNREFUSED, HTTP 5xx, etc.).",
    category: "retry",
  },
  {
    key: "retry.connection_error_delays_ms",
    source: "agents.yaml",
    type: "number[]",
    default: "[30000, 60000, 120000]",
    description: "Backoff delays per connection-error retry (30s → 60s → 120s).",
    category: "retry",
  },

  // ── Verification ───────────────────────────────────────────────────────────
  {
    key: "verification.enabled",
    source: "agents.yaml",
    type: "boolean",
    default: "(required)",
    description: "Master switch for task quality verification.",
    category: "verification",
  },
  {
    key: "verification.sources",
    source: "agents.yaml",
    type: "string[]",
    default: "(all sources)",
    description: "Allowlist of trigger sources to verify. Empty = verify everything.",
    category: "verification",
  },
  {
    key: "verification.min_score",
    source: "agents.yaml",
    type: "number",
    default: "0.7",
    description: "Quality score threshold for task approval (0–1).",
    category: "verification",
  },
  {
    key: "verification.max_revisions",
    source: "agents.yaml",
    type: "number",
    default: "1",
    description: "Max revision cycles for rejected tasks. 0 = verify-only mode.",
    category: "verification",
  },
  {
    key: "verification.verify_per_cycle",
    source: "agents.yaml",
    type: "number",
    default: "10",
    description: "Unverified tasks to process per daemon cycle.",
    category: "verification",
  },
  {
    key: "verification.reviewer_low_score_threshold",
    source: "agents.yaml",
    type: "number",
    default: "0.80",
    description: "Quality floor for reviewer-pool approvals. Below this triggers alert + supervisor follow-up.",
    category: "verification",
  },
  {
    key: "verification.revision_escalation_threshold",
    source: "hardcoded",
    type: "number",
    default: "3",
    description: "Revision count before task is escalated instead of revised again.",
    category: "verification",
  },

  // ── PR Review ──────────────────────────────────────────────────────────────
  {
    key: "pr_review.feedback_ceiling",
    source: "agents.yaml",
    type: "number",
    default: "3",
    description: "Max PR feedback rounds before escalation to human reviewer.",
    category: "pr_review",
  },
  {
    key: "pr_review.conflict_close_threshold",
    source: "agents.yaml",
    type: "number",
    default: "2",
    description: "Consecutive conflict escalations before PR is auto-closed and re-dispatched. 0 = disable.",
    category: "pr_review",
  },
  {
    key: "pr_review.diff_warn_threshold",
    source: "hardcoded",
    type: "number",
    default: "80000 (80KB)",
    description: "Diff size (bytes) at which the LLM is warned of truncation.",
    category: "pr_review",
  },
  {
    key: "pr_review.diff_escalate_threshold",
    source: "hardcoded",
    type: "number",
    default: "200000 (200KB)",
    description: "Diff size (bytes) at which PR is auto-escalated (too large to review).",
    category: "pr_review",
  },
  {
    key: "pr_review.pr_create_max_retries",
    source: "hardcoded",
    type: "number",
    default: "2",
    description: "Max gh pr create retry attempts.",
    category: "pr_review",
  },
  {
    key: "pr_review.pr_create_retry_delay_ms",
    source: "hardcoded",
    type: "number",
    default: "2000 (2s)",
    description: "Delay between gh pr create retries.",
    category: "pr_review",
  },
  {
    key: "pr_review.stale_branch_behind_threshold",
    source: "hardcoded",
    type: "number",
    default: "10",
    description: "Commits behind main before an orphan branch is deleted instead of PR-created.",
    category: "pr_review",
  },
  {
    key: "pr_review.pr_creation_max_retries",
    source: "hardcoded",
    type: "number",
    default: "5",
    description: "Max retries in the PR creation retry queue (with exponential backoff).",
    category: "pr_review",
  },
  {
    key: "pr_review.pr_creation_backoff_ms",
    source: "hardcoded",
    type: "number[]",
    default: "[60000, 120000, 240000, 480000, 960000]",
    description: "Exponential backoff delays for the PR creation retry queue (1min → 16min).",
    category: "pr_review",
  },

  // ── Escalation ─────────────────────────────────────────────────────────────
  {
    key: "escalation.retry_limit",
    source: "agents.yaml",
    type: "number",
    default: "3",
    description: "Cumulative retries before automatic escalation. 0 = disable.",
    category: "escalation",
  },
  {
    key: "escalation.notify_channel",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: "Slack channel or webhook URL for escalation notifications.",
    category: "escalation",
  },

  // ── LLM ────────────────────────────────────────────────────────────────────
  {
    key: "llm.provider",
    source: "agents.yaml",
    type: '"auto" | "claude" | "codex"',
    default: "auto",
    description: "Preferred provider for orchestrator-side LLM calls.",
    category: "llm",
  },
  {
    key: "llm.preferred_agent",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: "Explicit agent name to target for orchestrator LLM work.",
    category: "llm",
  },
  {
    key: "llm.default_model",
    source: "agents.yaml",
    type: "string",
    default: "claude-sonnet-4-6",
    description: "Fallback model for orchestrator LLM calls when no task-specific override is set.",
    category: "llm",
  },
  {
    key: "llm.models.<task>",
    source: "agents.yaml",
    type: "string",
    default: "claude-sonnet-4-6",
    description: "Per-task model override. Tasks: default, router, planner, reviewer, verifier, supervisor, improvement, issue_matcher.",
    category: "llm",
  },
  {
    key: "llm.task_providers.<task>",
    source: "agents.yaml",
    type: '"claude" | "codex" | "auto"',
    default: "(inherits llm.provider)",
    description: "Per-task provider override. High-frequency tasks default to Claude for prompt caching.",
    category: "llm",
  },
  {
    key: "llm.default_timeout_ms",
    source: "hardcoded",
    type: "number",
    default: "300000 (5min)",
    description: "Default timeout for orchestrator-side LLM calls.",
    category: "llm",
  },
  {
    key: "llm.pr_review_timeout_ms",
    source: "hardcoded",
    type: "number",
    default: "600000 (10min)",
    description: "Timeout for PR review LLM calls (longer due to large diffs).",
    category: "llm",
  },
  {
    key: "llm.fallback_threshold",
    source: "hardcoded",
    type: "number",
    default: "0.3",
    description: "Router confidence threshold below which LLM fallback is triggered.",
    category: "llm",
  },

  // ── Triggers ───────────────────────────────────────────────────────────────
  {
    key: "triggers.issue_claim_ttl_ms",
    source: "hardcoded",
    type: "number",
    default: "7200000 (2h)",
    description: "How long an agent can hold an issue claim before it expires.",
    category: "triggers",
  },
  {
    key: "triggers.recency_window_hours",
    source: "hardcoded",
    type: "number",
    default: "24",
    description: "Hours window for duplicate dispatch detection.",
    category: "triggers",
  },
  {
    key: "triggers.issue_state_cache_ttl_ms",
    source: "hardcoded",
    type: "number",
    default: "60000 (1min)",
    description: "TTL for cached GitHub issue state lookups.",
    category: "triggers",
  },
  {
    key: "triggers.issue_state_cache_max_size",
    source: "hardcoded",
    type: "number",
    default: "500",
    description: "Maximum entries in the issue state cache.",
    category: "triggers",
  },
  {
    key: "triggers.max_open_orchestrator_issues",
    source: "hardcoded",
    type: "number",
    default: "10",
    description: "Max open issues the orchestrator can auto-create per repo.",
    category: "triggers",
  },
  {
    key: "triggers.dedup_similarity_threshold",
    source: "hardcoded",
    type: "number",
    default: "0.4",
    description: "Cosine similarity threshold for issue deduplication (0–1).",
    category: "triggers",
  },

  // ── Deploy ─────────────────────────────────────────────────────────────────
  {
    key: "deploy.health_check_delays_ms",
    source: "hardcoded",
    type: "number[]",
    default: "[1000, 3000, 10000]",
    description: "Retry delays for post-deploy health checks (1s → 3s → 10s).",
    category: "deploy",
  },
  {
    key: "deploy.post_restart_warmup_ms",
    source: "hardcoded",
    type: "number",
    default: "5000 (5s)",
    description: "Warmup time after container restart before health check.",
    category: "deploy",
  },

  // ── Notifications ──────────────────────────────────────────────────────────
  {
    key: "notifications.telegram_rate_limit_ms",
    source: "hardcoded",
    type: "number",
    default: "900000 (15min)",
    description: "Minimum interval between repeated Telegram notifications.",
    category: "notifications",
  },

  // ── Research ───────────────────────────────────────────────────────────────
  {
    key: "research.link_min_score",
    source: "hardcoded",
    type: "number",
    default: "0.8",
    description: "Minimum relevance score to auto-link a research finding to an issue.",
    category: "research",
  },

  // ── Budget ─────────────────────────────────────────────────────────────────
  {
    key: "dashboard.budget.warning_pct",
    source: "agents.yaml",
    type: "number",
    default: "80",
    description: "Global default warning threshold for token budget utilization (%).",
    category: "budget",
  },
  {
    key: "dashboard.budget.critical_pct",
    source: "agents.yaml",
    type: "number",
    default: "100",
    description: "Global default critical threshold for token budget utilization (%).",
    category: "budget",
  },
  {
    key: "dashboard.digest.slack_webhook",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: "Slack webhook URL for daily digest. Required to enable digest.",
    category: "dashboard",
  },
  {
    key: "dashboard.digest.schedule",
    source: "agents.yaml",
    type: "string",
    default: "09:00",
    description: "Wall-clock time (HH:MM, 24h local) to post the daily digest.",
    category: "dashboard",
  },

  // ── Agent (per-agent settings) ─────────────────────────────────────────────
  {
    key: "agents.<name>.model",
    source: "agents.yaml",
    type: "string",
    default: "claude-opus-4-6",
    description: "LLM model for this agent.",
    category: "agent",
  },
  {
    key: "agents.<name>.provider",
    source: "agents.yaml",
    type: "string",
    default: "claude",
    description: "LLM provider for this agent. Must match a key in top-level providers map.",
    category: "agent",
  },
  {
    key: "agents.<name>.pool",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: "Pool name for load-balanced work distribution across instances.",
    category: "agent",
  },
  {
    key: "agents.<name>.max_concurrent",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Maximum parallel tasks for this agent.",
    category: "agent",
  },
  {
    key: "agents.<name>.max_open_prs",
    source: "agents.yaml",
    type: "number",
    default: "3 (inherits dispatch.max_open_prs)",
    description: "Maximum open PRs allowed for this agent's repo before dispatching more work.",
    category: "agent",
  },
  {
    key: "agents.<name>.stale_timeout_ms",
    source: "agents.yaml",
    type: "number",
    default: "600000 (10min)",
    description: "Per-agent stale task timeout override.",
    category: "agent",
  },
  {
    key: "agents.<name>.deploy_branch",
    source: "agents.yaml",
    type: "string",
    default: "main",
    description: "Branch to watch for auto-redeploy when repo is set.",
    category: "agent",
  },
  {
    key: "agents.<name>.auto_reroute_rejection_threshold",
    source: "agents.yaml",
    type: "number",
    default: "0 (disabled)",
    description: "Consecutive verifier rejections before auto-rerouting to a different agent.",
    category: "agent",
  },
  {
    key: "agents.<name>.token_budget.daily",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Daily token budget (resets at midnight UTC).",
    category: "agent",
  },
  {
    key: "agents.<name>.token_budget.weekly",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Weekly token budget (rolling 7-day window).",
    category: "agent",
  },
  {
    key: "agents.<name>.token_budget.warning_pct",
    source: "agents.yaml",
    type: "number",
    default: "80",
    description: "Per-agent warning threshold (%). Overrides dashboard.budget.warning_pct.",
    category: "agent",
  },
  {
    key: "agents.<name>.token_budget.critical_pct",
    source: "agents.yaml",
    type: "number",
    default: "100",
    description: "Per-agent critical threshold (%). Overrides dashboard.budget.critical_pct.",
    category: "agent",
  },
  {
    key: "agents.<name>.token_budget.pause_on_exceeded",
    source: "agents.yaml",
    type: "boolean",
    default: "false",
    description: "Pause new dispatches when critical_pct is reached.",
    category: "agent",
  },
  {
    key: "agents.<name>.docker.port",
    source: "agents.yaml",
    type: "number",
    default: "(required for docker agents)",
    description: "Host port for the agent's Docker container.",
    category: "agent",
  },
  {
    key: "agents.<name>.docker.permissions",
    source: "agents.yaml",
    type: "string",
    default: "(none)",
    description: 'Permission mode for the container (e.g. "bypassPermissions").',
    category: "agent",
  },
  {
    key: "agents.<name>.docker.session",
    source: "agents.yaml",
    type: '"fresh" | "continue" | "resume"',
    default: "fresh",
    description: "Session mode: fresh (new each time), continue (append), resume (restore).",
    category: "agent",
  },
  {
    key: "agents.<name>.docker.allowed_tools",
    source: "agents.yaml",
    type: "string",
    default: "(all tools)",
    description: "Comma-separated list of allowed CLI tools for this agent.",
    category: "agent",
  },

  // ── Health (CLI display thresholds) ────────────────────────────────────────
  {
    key: "health.timeout_rate_warn_pct",
    source: "hardcoded",
    type: "number",
    default: "10",
    description: "Timeout rate (%) at which health check shows a warning.",
    category: "health",
  },
  {
    key: "health.timeout_rate_critical_pct",
    source: "hardcoded",
    type: "number",
    default: "25",
    description: "Timeout rate (%) at which health check shows critical alert.",
    category: "health",
  },
  {
    key: "health.retry_budget_alert_threshold",
    source: "hardcoded",
    type: "number",
    default: "3",
    description: "Exhausted retry budgets before health alert fires.",
    category: "health",
  },
  {
    key: "health.unverified_warn_threshold",
    source: "hardcoded",
    type: "number",
    default: "10",
    description: "Unverified task count at which status dashboard shows a warning.",
    category: "health",
  },
  {
    key: "health.dispatch_warn_pct",
    source: "hardcoded",
    type: "number",
    default: "15",
    description: "Dispatch failure rate (%) at which efficiency report shows warning.",
    category: "health",
  },
  {
    key: "health.dispatch_crit_pct",
    source: "hardcoded",
    type: "number",
    default: "30",
    description: "Dispatch failure rate (%) at which efficiency report shows critical alert.",
    category: "health",
  },

  // ── Provider Limits ────────────────────────────────────────────────────────
  {
    key: "providers.<name>.model",
    source: "agents.yaml",
    type: "string",
    default: "(required)",
    description: "Model identifier for this provider (e.g. claude-opus-4-6).",
    category: "llm",
  },
  {
    key: "providers.<name>.limits.hourly",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Hourly token limit for this provider.",
    category: "budget",
  },
  {
    key: "providers.<name>.limits.daily",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Daily token limit for this provider.",
    category: "budget",
  },
  {
    key: "providers.<name>.limits.weekly",
    source: "agents.yaml",
    type: "number",
    default: "(unlimited)",
    description: "Weekly token limit for this provider.",
    category: "budget",
  },
] as const;

/**
 * Category labels and ordering for display.
 */
export const CATEGORY_LABELS: Record<ConfigCategory, string> = {
  proxy: "Proxy & Connectivity",
  daemon: "Daemon Poll Cycle",
  dispatch: "Dispatch & Retries",
  retry: "Connection Retry (configurable)",
  verification: "Verification & Quality",
  pr_review: "PR Review & Creation",
  escalation: "Escalation",
  llm: "LLM Models & Providers",
  budget: "Token Budgets",
  agent: "Per-Agent Settings",
  triggers: "Triggers & Dedup",
  deploy: "Deployment & Health Checks",
  notifications: "Notifications",
  dashboard: "Dashboard & Digest",
  research: "Research Linker",
  health: "Health & Monitoring Thresholds",
};

/**
 * Display ordering for categories.
 */
export const CATEGORY_ORDER: readonly ConfigCategory[] = [
  "proxy",
  "daemon",
  "dispatch",
  "retry",
  "verification",
  "pr_review",
  "escalation",
  "llm",
  "budget",
  "agent",
  "triggers",
  "deploy",
  "notifications",
  "dashboard",
  "research",
  "health",
];

/**
 * Get catalog entries grouped by category in display order.
 */
export function getCatalogByCategory(): Map<ConfigCategory, ConfigEntry[]> {
  const grouped = new Map<ConfigCategory, ConfigEntry[]>();
  for (const cat of CATEGORY_ORDER) {
    const entries = CONFIG_CATALOG.filter((e) => e.category === cat);
    if (entries.length > 0) {
      grouped.set(cat, entries);
    }
  }
  return grouped;
}

/**
 * Search the catalog by keyword (matches key or description, case-insensitive).
 */
export function searchCatalog(query: string): ConfigEntry[] {
  const q = query.toLowerCase();
  return CONFIG_CATALOG.filter(
    (e) =>
      e.key.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q),
  );
}
