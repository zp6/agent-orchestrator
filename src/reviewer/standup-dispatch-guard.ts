/**
 * Standup dispatch guard — issue #98
 *
 * Pre-dispatch filter that prevents zero-action standup tasks from consuming
 * agent slots. When the orchestrator is about to dispatch a standup task, it
 * calls `shouldSkipStandupDispatch()` which:
 *
 *   1. Fetches the GitHub issue
 *   2. Checks if it's a standup with 0 action items
 *   3. If yes: posts acknowledgment, applies label, records health event,
 *      and returns { skip: true } — no agent dispatch needed
 *   4. If no: returns { skip: false } — proceed with normal dispatch
 *
 * Acceptance criteria (issue #98):
 *   ✓ Standups with 0 action items are closed in <30s with no agent dispatch
 *   ✓ Agent slots are reserved for standups that actually require work
 *   ✓ Synthesis failures trigger fallback recovery (existing behavior preserved)
 */

import { execSync } from "child_process";
import { createLogger } from "../service/logger.js";
import {
  isStandupIssue,
  extractActionItemCount,
  handleZeroActionStandup,
  isSynthesisFailed,
  type GitHubIssue,
} from "./standup-handler.js";
import type { IStandupHealthStore } from "../state/types.js";
import type { Notifier } from "../notify.js";

const log = createLogger("standup-dispatch-guard");

// ── Types ────────────────────────────────────────────────────────────────

export interface StandupDispatchDecision {
  /** If true, the orchestrator should NOT dispatch this task to an agent. */
  skip: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Action item count extracted from the standup issue (-1 if unknown). */
  actionItemCount: number;
  /** Whether synthesis failure was detected (triggers fallback recovery). */
  synthesisFailed: boolean;
}

export interface StandupDispatchGuardOptions {
  /** Repos to query for fallback action items when synthesis fails. */
  fallbackRepos?: string[];
  /** Whether to auto-close zero-action standup issues (default: true). */
  autoClose?: boolean;
  /** State store for recording synthesis health events. */
  store?: IStandupHealthStore;
  /** Telegram notifier for fallback escalation alerts. */
  notifier?: Notifier;
}

// ── Guard ────────────────────────────────────────────────────────────────

/**
 * Determine whether a standup task should be dispatched to an agent.
 *
 * Call this BEFORE dispatching any task whose source_ref or title suggests
 * it's a standup response. If the standup has 0 action items, this function
 * handles everything (acknowledgment, labeling, closing) and returns
 * `{ skip: true }` so the orchestrator can mark the task as done without
 * consuming an agent slot.
 *
 * @param repo - Repository in owner/repo format
 * @param issueNumber - GitHub issue number for the standup
 * @param opts - Optional configuration for fallback repos, auto-close, etc.
 * @returns Decision indicating whether to skip dispatch
 */
export async function shouldSkipStandupDispatch(
  repo: string,
  issueNumber: number,
  opts: StandupDispatchGuardOptions = {},
): Promise<StandupDispatchDecision> {
  const startTime = Date.now();

  try {
    // 1. Fetch the GitHub issue
    const issue = fetchGitHubIssue(repo, issueNumber);
    if (!issue) {
      return {
        skip: false,
        reason: `Could not fetch issue #${issueNumber} from ${repo} — proceeding with dispatch`,
        actionItemCount: -1,
        synthesisFailed: false,
      };
    }

    // 2. Verify it's actually a standup issue
    if (!isStandupIssue(issue)) {
      return {
        skip: false,
        reason: `Issue #${issueNumber} is not a standup issue — proceeding with dispatch`,
        actionItemCount: -1,
        synthesisFailed: false,
      };
    }

    // 3. Extract action item count
    const actionItemCount = extractActionItemCount(issue);
    const synthesisFailed = isSynthesisFailed(issue);

    // 4. If there ARE action items, dispatch normally
    if (actionItemCount > 0) {
      return {
        skip: false,
        reason: `Standup #${issueNumber} has ${actionItemCount} action items — dispatching to agent`,
        actionItemCount,
        synthesisFailed,
      };
    }

    // 5. If action item count is unknown (-1), dispatch to be safe
    if (actionItemCount === -1) {
      return {
        skip: false,
        reason: `Could not determine action item count for standup #${issueNumber} — dispatching to be safe`,
        actionItemCount,
        synthesisFailed,
      };
    }

    // 6. Zero action items → handle locally and skip dispatch
    log.info("Zero-action standup detected at dispatch time — handling without agent", {
      repo,
      issueNumber,
      synthesisFailed,
    });

    await handleZeroActionStandup(
      repo,
      issueNumber,
      issue,
      opts.autoClose ?? true,
      opts.fallbackRepos,
      opts.store,
      opts.notifier,
    );

    const elapsed = Date.now() - startTime;
    log.info("Zero-action standup handled without dispatch", {
      repo,
      issueNumber,
      elapsedMs: elapsed,
      synthesisFailed,
    });

    return {
      skip: true,
      reason: `Standup #${issueNumber} has 0 action items — acknowledged and ${synthesisFailed ? "fallback attempted" : "closed"} without agent dispatch (${elapsed}ms)`,
      actionItemCount: 0,
      synthesisFailed,
    };
  } catch (err) {
    log.error("Standup dispatch guard failed — falling back to dispatch", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });

    // Fail-open: if the guard throws, dispatch normally
    return {
      skip: false,
      reason: `Guard error: ${err instanceof Error ? err.message : String(err)} — proceeding with dispatch`,
      actionItemCount: -1,
      synthesisFailed: false,
    };
  }
}

/**
 * Quick check: does this task title or source_ref look like a standup task?
 *
 * Use this as a fast pre-filter before calling `shouldSkipStandupDispatch()`,
 * which makes a GitHub API call. This function is pure string matching with
 * no I/O.
 *
 * @param title - Task title
 * @param sourceRef - Task source_ref (e.g., "standup:703", "github-issue:owner/repo#N")
 * @returns true if this looks like it might be a standup task
 */
export function looksLikeStandupTask(title: string, sourceRef?: string | null): boolean {
  // Check title patterns
  if (/standup/i.test(title)) return true;
  if (/\[📋 Standup\]/i.test(title)) return true;
  if (/\[🚀 Blue Sky\]/i.test(title)) return true;

  // Check source_ref patterns
  if (sourceRef?.startsWith("standup:")) return true;

  return false;
}

/**
 * Extract a GitHub issue number from a standup task's source_ref.
 *
 * Supported formats:
 *   - "standup:703" → 703
 *   - "github-issue:owner/repo#703" → 703
 *   - "#703" → 703
 *
 * @returns Issue number or null if not extractable
 */
export function extractStandupIssueNumber(sourceRef: string | null | undefined): number | null {
  if (!sourceRef) return null;

  // "standup:703"
  const standupMatch = sourceRef.match(/^standup:(\d+)$/);
  if (standupMatch) return parseInt(standupMatch[1], 10);

  // "github-issue:owner/repo#703"
  const ghIssueMatch = sourceRef.match(/github-issue:[^#]+#(\d+)$/);
  if (ghIssueMatch) return parseInt(ghIssueMatch[1], 10);

  // Bare "#703"
  const bareMatch = sourceRef.match(/^#(\d+)$/);
  if (bareMatch) return parseInt(bareMatch[1], 10);

  return null;
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Fetch a GitHub issue via gh CLI.
 * Returns null on any error (fail-open).
 */
function fetchGitHubIssue(repo: string, issueNumber: number): GitHubIssue | null {
  try {
    const output = execSync(
      `gh issue view ${issueNumber} --repo ${shellEscape(repo)} --json number,title,body,labels,state`,
      { encoding: "utf-8", timeout: 15000 },
    );

    const raw = JSON.parse(output.trim());

    return {
      number: raw.number,
      title: raw.title ?? "",
      body: raw.body ?? "",
      labels: (raw.labels ?? []).map((l: { name: string }) => l.name),
      state: (raw.state ?? "OPEN").toLowerCase() === "closed" ? "closed" : "open",
    };
  } catch (err) {
    log.warn("Failed to fetch GitHub issue for standup guard", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function shellEscape(s: string): string {
  if (!s) return "''";
  if (/[^a-zA-Z0-9._/-]/.test(s)) {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  return s;
}
