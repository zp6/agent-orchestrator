/**
 * Pre-dispatch capability enforcer for the reviewer agent (issue #330).
 *
 * The orchestrator detected that tasks 01KPHX1B, 01KPHWS8, 01KPHWEJ, and
 * 01KPHW9R showed the reviewer agent creating PRs and writing implementation
 * code — directly contradicting its purpose as a lightweight review/verify
 * layer.
 *
 * This module adds a **pre-dispatch gate** that fires before a task is sent
 * to `claude-orchestrator-reviewer`. If the task contains authorship keywords
 * (implement, create PR, write, build) and targets a foreign repo, it is
 * blocked and auto-rerouted to the appropriate home agent. A Telegram alert
 * is sent with the original vs. corrected routing so operators can track
 * boundary violations.
 *
 * ## Integration
 *
 * Call `enforcer.check()` in the orchestrator's dispatcher, just before
 * sending the task to an agent:
 *
 *   const enforcement = await enforcer.check({
 *     task_title: task.title,
 *     task_type: task.task_type,
 *     source_ref: task.source_ref,
 *     target_agent: resolvedAgent,
 *   });
 *
 *   if (!enforcement.allowed) {
 *     const corrected = enforcement.reroute_to ?? fallbackAgent;
 *     // dispatch to corrected agent instead
 *   }
 *
 * @see https://github.com/rapartlu/agent-reviewer/issues/330
 */

import { createLogger } from "../service/logger.js";
import type { ReviewerConfig } from "../config.js";
import type { Notifier } from "../notify.js";
import { REVIEWER_REPO } from "./capability-check.js";

const log = createLogger("pre-dispatch-capability-enforcer");

// ── Constants ────────────────────────────────────────────────────────────

/** The reviewer agent name — only this agent is subject to enforcement. */
export const REVIEWER_AGENT_NAME = "claude-orchestrator-reviewer";

/**
 * Keywords that signal code-authorship intent.  When ANY of these appear in
 * the task title (case-insensitive), the task is treated as an implementation
 * task and blocked from landing on the reviewer.
 */
export const AUTHORSHIP_KEYWORDS: ReadonlyArray<string> = [
  "implement",
  "create pr",
  "write",
  "build",
];

// ── Types ────────────────────────────────────────────────────────────────

export interface PreDispatchCheckRequest {
  /** Human-readable task title. */
  task_title: string;
  /** Task type (e.g. "implementation", "review"). */
  task_type: string;
  /** Source reference e.g. "rapartlu/agent-orchestrator#965". */
  source_ref?: string | null;
  /** The agent the dispatcher intends to send this task to. */
  target_agent: string;
}

export interface PreDispatchCheckResult {
  /** Whether the dispatch to the target agent is allowed. */
  allowed: boolean;
  /**
   * Suggested reroute target when `allowed` is false.
   * The orchestrator should dispatch to this agent instead.
   * Undefined when no config match is found for the target repo.
   */
  reroute_to?: string;
  /** Human-readable reason for the enforcement decision. */
  reason?: string;
  /** Whether a Telegram alert was sent for this enforcement. */
  alert_sent: boolean;
  /** Which authorship keyword triggered the block (for observability). */
  matched_keyword?: string;
}

// ── Pure functions ───────────────────────────────────────────────────────

/**
 * Extract the GitHub repo slug (owner/repo) from a source_ref like
 * "owner/repo#123". Returns null if the format doesn't match.
 */
export function extractRepoFromRef(sourceRef: string | null | undefined): string | null {
  if (!sourceRef) return null;
  const hashIdx = sourceRef.lastIndexOf("#");
  if (hashIdx <= 0) return null;
  return sourceRef.slice(0, hashIdx);
}

/**
 * Check whether the task title contains any authorship keyword.
 * Returns the first matched keyword, or null if none matched.
 */
export function findAuthorshipKeyword(title: string): string | null {
  const lower = title.toLowerCase();
  for (const kw of AUTHORSHIP_KEYWORDS) {
    if (lower.includes(kw)) {
      return kw;
    }
  }
  return null;
}

/**
 * Determine whether a task should be blocked from reaching the reviewer.
 *
 * Blocking conditions (ALL must be true):
 *   1. The target agent is `claude-orchestrator-reviewer`.
 *   2. The task title contains an authorship keyword OR task_type is
 *      "implementation".
 *   3. The task is NOT targeting the reviewer's own repo (`rapartlu/agent-reviewer`).
 *
 * @returns `{ block: true, keyword }` when enforcement should fire,
 *          `{ block: false }` otherwise.
 */
export function shouldBlock(req: PreDispatchCheckRequest): {
  block: false;
} | {
  block: true;
  keyword: string | null;
} {
  // 1. Only enforce for the reviewer agent.
  if (req.target_agent !== REVIEWER_AGENT_NAME) {
    return { block: false };
  }

  // 2. Detect implementation intent.
  const keyword = findAuthorshipKeyword(req.task_title);
  const isImplementationType = req.task_type === "implementation";

  if (!keyword && !isImplementationType) {
    // No authorship keyword and not typed as "implementation" — allow.
    return { block: false };
  }

  // 3. Own-repo work is always allowed — the reviewer can implement features
  //    in its own codebase (rapartlu/agent-reviewer).
  const targetRepo = extractRepoFromRef(req.source_ref);
  if (targetRepo === REVIEWER_REPO) {
    return { block: false };
  }

  return { block: true, keyword };
}

// ── Class ────────────────────────────────────────────────────────────────

/**
 * Pre-dispatch capability enforcer.
 *
 * Wraps the pure `shouldBlock()` logic with config-driven reroute resolution
 * and optional Telegram alerting.  Designed to be instantiated once and
 * called for every dispatch to `claude-orchestrator-reviewer`.
 */
export class PreDispatchCapabilityEnforcer {
  constructor(
    private readonly config: ReviewerConfig,
    private readonly notifier?: Notifier,
  ) {}

  /**
   * Check whether the described task may be dispatched to its target agent.
   *
   * @returns `PreDispatchCheckResult` with `allowed: true` when dispatch is
   *          permitted, or `allowed: false` with `reroute_to` and an alert
   *          when the task is an implementation task that should not reach
   *          the reviewer.
   */
  async check(req: PreDispatchCheckRequest): Promise<PreDispatchCheckResult> {
    const decision = shouldBlock(req);

    if (!decision.block) {
      return { allowed: true, alert_sent: false };
    }

    // Resolve the correct agent for the target repo.
    const targetRepo = extractRepoFromRef(req.source_ref);
    const reroute_to = this.resolveHomeAgent(targetRepo);

    const reason =
      `Task dispatched to ${REVIEWER_AGENT_NAME} but contains authorship intent ` +
      (decision.keyword ? `(keyword: "${decision.keyword}")` : `(task_type: ${req.task_type})`) +
      `. Reviewer is implementation-ineligible for foreign repos. ` +
      `Rerouted to: ${reroute_to ?? "home agent for " + (targetRepo ?? "unknown repo")}.`;

    log.warn("Pre-dispatch capability enforcement triggered", {
      task_title: req.task_title.slice(0, 80),
      task_type: req.task_type,
      source_ref: req.source_ref,
      target_agent: req.target_agent,
      matched_keyword: decision.keyword ?? undefined,
      reroute_to,
    });

    // Fire Telegram alert.
    let alert_sent = false;
    if (this.notifier?.isConfigured()) {
      try {
        await this.sendRerouteAlert(req, reroute_to, decision.keyword ?? undefined);
        alert_sent = true;
      } catch (err) {
        log.error("Failed to send pre-dispatch enforcement alert", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      allowed: false,
      reroute_to,
      reason,
      alert_sent,
      matched_keyword: decision.keyword ?? undefined,
    };
  }

  /**
   * Find the agent whose `github` field matches the given repo slug.
   * Returns undefined when no match is found in config.
   */
  private resolveHomeAgent(targetRepo: string | null): string | undefined {
    if (!targetRepo) return undefined;
    for (const [agentName, agentConf] of Object.entries(this.config.agents)) {
      if (agentConf.github === targetRepo) {
        return agentName;
      }
    }
    return undefined;
  }

  /**
   * Send a Telegram alert describing the original routing and the corrected
   * reroute target.
   */
  private async sendRerouteAlert(
    req: PreDispatchCheckRequest,
    reroute_to: string | undefined,
    keyword: string | undefined,
  ): Promise<void> {
    if (!this.notifier) return;

    const shortTitle = req.task_title.slice(0, 80);
    const targetRepo = extractRepoFromRef(req.source_ref) ?? "unknown repo";
    const kwLabel = keyword ? `keyword \`${keyword}\`` : `task_type \`${req.task_type}\``;

    const lines: string[] = [
      `🚫 *Reviewer routing boundary enforced*`,
      ``,
      `A task was intercepted before reaching \`${REVIEWER_AGENT_NAME}\`.`,
      `It contains authorship intent (${kwLabel}) and targets a foreign repo.`,
      ``,
      `📋 *Task:* ${shortTitle}`,
      `🏷️ *Type:* \`${req.task_type}\``,
      `📎 *Ref:* \`${req.source_ref ?? "none"}\` → repo \`${targetRepo}\``,
      ``,
      `❌ *Original routing:* \`${req.target_agent}\` (reviewer — blocked)`,
      `✅ *Corrected routing:* \`${reroute_to ?? "home agent for " + targetRepo}\``,
      ``,
      `_Routing boundary is enforced pre-dispatch. No task was queued on the reviewer._`,
    ];

    await this.notifier.notifyOperator(
      "Reviewer routing boundary enforced",
      lines.join("\n"),
      "high",
    );
  }
}
