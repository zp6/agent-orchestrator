/**
 * Configuration for the claude-orchestrator-reviewer.
 *
 * This is a subset of OrchestratorConfig — the reviewer only needs what it
 * uses for LLM calls, agent lookups, and GitHub/Telegram operations.
 *
 * The orchestrator daemon passes a compatible config object when constructing
 * reviewer classes, so this interface is intentionally kept narrow.
 */

export interface AgentConfig {
  description: string;
  /** GitHub repo slug (owner/repo) */
  github?: string;
  /** Local directory path relative to base_dir */
  dir: string;
  /** Whether the agent has a local git repo to rebase into */
  repo?: string;
}

/**
 * Pool member configuration for secondary reviewer instances.
 * Set when this reviewer runs as a non-primary pool member (e.g. deepseek-reasoning).
 * Read from POOL_MEMBER_ID / REVIEWER_PROVIDER / REVIEWER_MODEL env vars at runtime;
 * this config field allows the orchestrator to pass values programmatically too.
 */
export interface ReviewerPoolMemberConfig {
  /** Agent name as in agents.yaml (e.g. "deepseek-reasoning") */
  member_id: string;
  /** LLM provider ("anthropic" | "deepseek" | "grok") */
  provider: string;
  /** Model name (e.g. "deepseek-reasoner") */
  model: string;
}

export interface ReviewerConfig {
  /** Base directory where all agent repos live */
  base_dir: string;
  /** Directory of the reviewer/orchestrator itself (used for git ops) */
  orchestrator_dir: string;
  /** PR review tuning */
  pr_review?: {
    /** How many change-request rounds before auto-escalating (default: 3) */
    feedback_ceiling?: number;
    /** Hours behind main before a branch is flagged as stale (default: 48) */
    stale_branch_threshold_hours?: number;
    /**
     * Allowed base branches for rebase/staleness checks.
     * Defaults to ["main"] but can include release branches such as
     * ["main", "release/1.0"] when a repo lands work on a long-lived base.
     */
    allowed_base_branches?: string[];
  };
  /** Map of agent names to their config */
  agents: Record<string, AgentConfig>;
  /** Optional Telegram notification config */
  telegram?: {
    bot_token: string;
    chat_id: string;
  };
  /** Optional SSH key path for git push operations */
  ssh_key?: string;
  /**
   * Optional pool member config for secondary reviewer instances.
   * When set, this reviewer participates in the multi-model reviewer pool
   * and adjusts its behaviour accordingly (e.g. skips auto-merge).
   * If not set, the instance runs as the primary reviewer.
   */
  pool_member?: ReviewerPoolMemberConfig;
  /**
   * Optional base URL for the agent dashboard.
   * When set, the calibration drift Telegram alert includes a clickable link
   * to the dashboard calibration view (e.g. "https://dashboard.example.com").
   * The calibration path `/calibration` is appended automatically.
   */
  dashboard_url?: string;
  /**
   * Fleet-level wallet and revenue-URL configuration.
   *
   * All fields are optional and fall back to their corresponding env vars
   * (set in agents.yaml `providers.global`, per orchestrator#1331):
   *   - FLEET_WALLET_ADDRESS
   *   - FLEET_WALLET_NETWORK
   *   - FLEET_GITHUB_SPONSORS_URL
   *   - FLEET_POLAR_URL
   *   - FLEET_ALGORA_URL
   *   - FLEET_GITCOIN_URL
   *
   * Passing them here allows the orchestrator daemon to inject values
   * programmatically without relying on the process environment, which
   * is useful in tests or multi-tenant deployments.
   */
  fleet?: {
    /**
     * EVM-compatible wallet address (e.g. "0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef").
     * Used by the metrics endpoint and survival-plan revenue tracking.
     */
    wallet_address?: string;
    /**
     * Network name where the wallet lives (e.g. "Base", "Ethereum").
     * Surfaced in `GET /api/fleet-config` and Telegram status messages.
     */
    wallet_network?: string;
    /** GitHub Sponsors profile URL. */
    github_sponsors_url?: string;
    /** Polar.sh page URL. */
    polar_url?: string;
    /** Algora bounty profile URL. */
    algora_url?: string;
    /** Gitcoin grants page URL. */
    gitcoin_url?: string;
  };
}
