/**
 * Reviewer pool integration — pool membership declaration and utilities.
 *
 * The reviewer pool is a set of agents that share the `claude-orchestrator-reviewer`
 * codebase but run with different LLM providers/models. Each pool member provides
 * an independent review voice, enabling cognitive diversity per CHARTER.md Article VI.
 *
 * Pool members (from agents.yaml):
 *   claude-orchestrator-reviewer  — primary (Anthropic claude-sonnet-4-6)
 *   deepseek-reasoning            — reasoning voice (Deepseek R1 / deepseek-reasoner)
 *
 * Environment variables consumed by this module:
 *   POOL_MEMBER_ID  — agent name as registered in agents.yaml (e.g. "deepseek-reasoning")
 *   REVIEWER_PROVIDER — "anthropic" | "deepseek" | "grok"
 *   REVIEWER_MODEL    — model name override
 *
 * Issue: rapartlu/agent-orchestrator#1211 (multi-provider expansion).
 */

import { getReviewerProvider, getReviewerModel, type ReviewerProvider } from "../client/multi-provider-client.js";

// ── Constants ──────────────────────────────────────────────────────────────

/** The pool name shared across all reviewer-pool members. */
export const REVIEWER_POOL_NAME = "reviewer" as const;

/** Well-known pool member IDs, matching agents.yaml agent keys. */
export const KNOWN_POOL_MEMBERS = [
  "claude-orchestrator-reviewer",
  "deepseek-reasoning",
] as const;

export type KnownPoolMemberId = (typeof KNOWN_POOL_MEMBERS)[number];

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReviewerPoolMember {
  /** Agent name (e.g. "deepseek-reasoning"), from POOL_MEMBER_ID env or default. */
  member_id: string;
  /** The pool this member belongs to (always "reviewer"). */
  pool: typeof REVIEWER_POOL_NAME;
  /** LLM provider. */
  provider: ReviewerProvider;
  /** Active model name. */
  model: string;
  /**
   * Whether this member uses a reasoning/chain-of-thought model.
   * Reasoning models (deepseek-reasoner, o1, etc.) typically perform better
   * on complex architectural reviews and security analysis but are slower.
   */
  is_reasoning_model: boolean;
  /** Capabilities this member is suited for within the pool. */
  capabilities: string[];
}

/**
 * Metadata returned when two pool members have both reviewed the same PR.
 * The orchestrator uses this to surface multi-voice consensus or divergence.
 */
export interface PoolConsensusResult {
  primary: { member_id: string; verdict: string };
  reasoning: { member_id: string; verdict: string };
  consensus: "agree" | "disagree" | "partial";
}

// ── Capability profiles ───────────────────────────────────────────────────

const CAPABILITY_PROFILES: Record<string, string[]> = {
  anthropic: ["pr-review", "verification", "supervision", "improvement-detection", "synthesis"],
  deepseek: ["pr-review", "verification", "reasoning", "security-analysis", "architecture-review"],
  grok: ["pr-review", "synthesis", "standup"],
};

/** True for models that use chain-of-thought / extended reasoning tokens. */
function isReasoningModel(model: string): boolean {
  return (
    model.startsWith("deepseek-reasoner") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.includes("-reason")
  );
}

// ── Pool membership ───────────────────────────────────────────────────────

/**
 * Returns the pool membership descriptor for the current running instance.
 *
 * Returns `null` when:
 *   - `POOL_MEMBER_ID` is not set AND provider is "anthropic" (primary default,
 *     not explicitly a pool member — compatible with legacy single-reviewer setup).
 *
 * Returns a `ReviewerPoolMember` when:
 *   - `POOL_MEMBER_ID` is set, OR
 *   - `REVIEWER_PROVIDER` is not "anthropic" (secondary pool member).
 */
export function getPoolMembership(): ReviewerPoolMember | null {
  const memberId = process.env.POOL_MEMBER_ID;
  const provider = getReviewerProvider();
  const model = getReviewerModel(provider);

  // Primary default (no explicit pool config) → not a pool member record.
  if (!memberId && provider === "anthropic") return null;

  return {
    member_id: memberId ?? `reviewer-${provider}`,
    pool: REVIEWER_POOL_NAME,
    provider,
    model,
    is_reasoning_model: isReasoningModel(model),
    capabilities: CAPABILITY_PROFILES[provider] ?? ["pr-review", "verification"],
  };
}

/**
 * Returns whether the current instance is a secondary (non-primary) pool member.
 * Use this to conditionally adjust behaviour — e.g. secondary members skip
 * auto-merge so the primary retains merge authority.
 */
export function isSecondaryPoolMember(): boolean {
  const membership = getPoolMembership();
  if (!membership) return false;
  return membership.member_id !== "claude-orchestrator-reviewer";
}

// ── Telegram / display helpers ────────────────────────────────────────────

/**
 * Returns a short badge string for Telegram messages, e.g.:
 *   "🤖 deepseek-reasoning (deepseek-reasoner, reasoning)"
 *   "🤖 claude-orchestrator-reviewer (claude-sonnet-4-6)"
 */
export function formatPoolMemberBadge(member: ReviewerPoolMember): string {
  const reasoningTag = member.is_reasoning_model ? ", reasoning" : "";
  return `🤖 ${member.member_id} (${member.model}${reasoningTag})`;
}

/**
 * Builds a concise Telegram summary of pool consensus between two member results.
 */
export function formatPoolConsensus(result: PoolConsensusResult): string {
  const icon =
    result.consensus === "agree"
      ? "✅"
      : result.consensus === "disagree"
        ? "⚠️"
        : "🔶";
  return (
    `${icon} Pool consensus: ${result.consensus}\n` +
    `  Primary (${result.primary.member_id}): ${result.primary.verdict}\n` +
    `  Reasoning (${result.reasoning.member_id}): ${result.reasoning.verdict}`
  );
}

// ── Consensus evaluation ─────────────────────────────────────────────────

/**
 * Given two verdicts from different pool members, computes the consensus.
 *
 * Rules:
 *   - Both approve → "agree"
 *   - Both request-changes → "agree"
 *   - One approves, one escalates → "partial" (defer to operator)
 *   - One approves, one requests-changes → "disagree" (conservative: block merge)
 */
export function evaluatePoolConsensus(
  primaryVerdict: string,
  reasoningVerdict: string,
  primaryMemberId: string,
  reasoningMemberId: string,
): PoolConsensusResult {
  const normalise = (v: string) =>
    v.toLowerCase().replace(/[^a-z-]/g, "").trim();

  const p = normalise(primaryVerdict);
  const r = normalise(reasoningVerdict);

  let consensus: PoolConsensusResult["consensus"];
  if (p === r) {
    consensus = "agree";
  } else if (p === "approve" && r === "request-changes") {
    consensus = "disagree";
  } else if (p === "request-changes" && r === "approve") {
    consensus = "disagree";
  } else {
    consensus = "partial";
  }

  return {
    primary: { member_id: primaryMemberId, verdict: primaryVerdict },
    reasoning: { member_id: reasoningMemberId, verdict: reasoningVerdict },
    consensus,
  };
}
