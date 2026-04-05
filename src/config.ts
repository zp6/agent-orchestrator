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

export interface ReviewerConfig {
  /** Base directory where all agent repos live */
  base_dir: string;
  /** Directory of the reviewer/orchestrator itself (used for git ops) */
  orchestrator_dir: string;
  /** PR review tuning */
  pr_review?: {
    /** How many change-request rounds before auto-escalating (default: 3) */
    feedback_ceiling?: number;
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
}
