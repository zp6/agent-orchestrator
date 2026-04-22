import { fetchOpenIssues, countOpenPRs, validateGhAuth, type GitHubIssue } from "./github.js";
import { reportResult } from "./reporters.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";
import { scoreIssuePriority } from "../orchestrator/priority-scorer.js";
import { sendTelegramAlert } from "../service/telegram.js";

/**
 * Default TTL for issue claims: 2 hours (matches agents.yaml stale_timeout_ms conventions).
 * Configurable via `triggers.issue_claim_ttl_ms` in agents.yaml.
 */
export const ISSUE_CLAIM_TTL_MS = 7_200_000;

/**
 * Dispatch flood gate cooldown window (issue #1060).
 * Once an "already-in-review" guard fires for a source_ref, subsequent guard
 * hits within this window are silently dropped — no task created, no block
 * event recorded, no Telegram notification sent.
 * Default: 60 minutes (matches the PR guard cooldown period).
 */
export const GUARD_FLOOD_GATE_WINDOW_MS = 3_600_000;

import { runGitHubPreDispatchValidation } from "../orchestrator/pre-dispatch-validator.js";
import { looksLikeStandupTask, extractStandupIssueNumber, shouldSkipStandupDispatch } from "./standup-dispatch-guard.js";

/**
 * Dashboard URL for the dispatch-skip-log HTTP API.
 * Used to record structured skip events for the skipped dispatches view.
 */
const DASHBOARD_URL = "http://localhost:3473";

/**
 * Fire-and-forget POST to the dashboard's dispatch-skip-log API.
 * Never throws — dashboard outages must not block the daemon loop.
 */
function reportDashboardSkip(params: {
  issue_id: string;
  agent_name?: string;
  skip_reason: string;
  condition_value?: string;
  context?: string;
}): void {
  fetch(`${DASHBOARD_URL}/api/dispatch-skip-log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {
    // Intentionally swallowed — dashboard skip reporting is best-effort
  });
}

/**
 * Create an "already-in-review" task record when a dispatch is blocked because
 * an open PR already exists for the issue. This provides a visible audit trail
 * in task history showing that the orchestrator detected the PR and skipped
 * re-implementation, instead of silently incrementing a skip counter.
 *
 * The task is created as "done" with verification_status "approved" so it
 * appears as a completed task that required zero agent-hours.
 */
function recordAlreadyInReviewTask(
  store: StateStore,
  params: {
    sourceRef: string;
    agentName: string;
    issueNumber: number;
    blockingPRNumber: number;
    failureCode: string;
    repo: string;
  },
): void {
  const { sourceRef, agentName, issueNumber, blockingPRNumber, failureCode, repo } = params;
  const resolution = failureCode === "approved_pr_waiting"
    ? `Approved PR #${blockingPRNumber} is awaiting merge`
    : `Open PR #${blockingPRNumber} is already in review`;

  try {
    const task = store.createTask({
      title: `[${repo}#${issueNumber}] Already in review — PR #${blockingPRNumber}`,
      description: `Pre-dispatch check detected that issue #${issueNumber} already has an ` +
        `open PR (#${blockingPRNumber}) with a matching "Closes #${issueNumber}" reference. ` +
        `Dispatch skipped to avoid re-implementation waste. ${resolution}.`,
      source: "github",
      source_ref: sourceRef,
      agent_name: agentName,
    });

    store.updateTask(task.id, {
      status: "done",
      result: `already-in-review: ${resolution}. ` +
        `See https://github.com/${repo}/pull/${blockingPRNumber}`,
      verification_status: "approved",
      quality_score: 1.0,
      verification_notes: "Auto-approved: dispatch skipped because open PR already exists for this issue.",
    });

    // Use the real task.id so the processed_triggers.task_id FK constraint
    // (REFERENCES tasks.id) is satisfied.  Passing a synthetic string like
    // "already-in-review-pr-N" caused "FOREIGN KEY constraint failed" because
    // that string has no matching row in the tasks table.
    store.markProcessed("github", sourceRef, task.id);

    log.info("Recorded already-in-review task for issue with existing PR", {
      taskId: task.id,
      sourceRef,
      blockingPRNumber,
      failureCode,
    });
  } catch (err) {
    log.warn("Failed to record already-in-review task", {
      sourceRef,
      blockingPRNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const log = createLogger("trigger-dispatcher");

/**
 * Route a dispatch-blocking PR to the appropriate queue.
 *
 * When a pre-dispatch validation blocks an issue dispatch because an open or
 * approved PR already exists, this function determines where to route the
 * blocking PR:
 *
 * - `"already-in-merge-queue"` — the PR is already queued for merge; no action needed.
 * - `"already-in-priority-queue"` — the PR is already in the priority review queue; no-op.
 * - `"pending-review"` — the PR is open but not yet approved; added to the
 *   priority_review_queue so the next reviewPRs cycle picks it up before the
 *   general open-PR sweep. The caller should log this and report a dashboard skip.
 *
 * For `approved_pr_waiting` failures the PR has already been approved, so the
 * orchestrator's orphan-PR sweep and merge queue handle it autonomously. This
 * function focuses on the `open_pr_exists` case where a review is still needed.
 *
 * @returns routing outcome for logging and metrics.
 */
export function routeBlockingPRToQueue(
  store: StateStore,
  params: {
    repo: string;
    prNumber: number;
    failureCode: string;
    blockedIssueRef: string;
  },
): "pending-review" | "already-in-merge-queue" | "already-in-priority-queue" | "skipped" {
  const { repo, prNumber, failureCode, blockedIssueRef } = params;

  // Already in the merge queue (approved PR) — the merge sweep will handle it
  if (store.isPRInMergeQueue(repo, prNumber)) {
    return "already-in-merge-queue";
  }

  // Approved PRs are handled by the orphan-PR sweep + merge queue; no priority
  // review needed since the review is already done.
  if (failureCode === "approved_pr_waiting") {
    return "skipped";
  }

  // PR is open but not yet approved — enqueue for priority review so it is
  // reviewed in the same daemon cycle rather than waiting for the next general sweep.
  if (store.isPRInPriorityReviewQueue(repo, prNumber)) {
    return "already-in-priority-queue";
  }

  store.addToPriorityReviewQueue(repo, prNumber, blockedIssueRef);
  log.info("routeBlockingPRToQueue: added dispatch-blocking PR to priority review queue", {
    repo,
    prNumber,
    blockedIssueRef,
    failureCode,
  });
  return "pending-review";
}

// In-memory registry of source refs currently being dispatched.
// Keyed by sourceRef → AbortController so the claim-lock supersession logic
// can both detect duplicates (has() check) and send a cancellation signal to
// the running HTTP call (abort()) when a newer dispatch claims the same issue.
const inFlightDispatches = new Map<string, AbortController>();

function sortIssuesForDispatch(store: StateStore, issues: GitHubIssue[]): GitHubIssue[] {
  // Priority scoring: rank by labels, age, stuck status, keywords
  // Manual boosts (from deescalation) still get highest priority
  return [...issues].sort((a, b) => {
    const aBoosted = store.isSourceRefPriorityBoosted("github", `${a.repo}#${a.number}`);
    const bBoosted = store.isSourceRefPriorityBoosted("github", `${b.repo}#${b.number}`);
    if (aBoosted !== bBoosted) return aBoosted ? -1 : 1;

    const aScore = scoreIssuePriority(
      { number: a.number, title: a.title, labels: a.labels ?? [], createdAt: a.created_at, repo: a.repo },
      store,
    ).score;
    const bScore = scoreIssuePriority(
      { number: b.number, title: b.title, labels: b.labels ?? [], createdAt: b.created_at, repo: b.repo },
      store,
    ).score;
    return bScore - aScore; // highest priority first
  });
}

/**
 * Build the mandatory pre-declaration review checklist injected into every
 * fix-existing-PR task message.  Agents must work through all five steps
 * before they are allowed to declare "no changes needed".
 *
 * Running `tsc` or a build command alone does NOT satisfy this checklist —
 * agents must read the actual code diff and reason about correctness.
 *
 * Exported for unit testing.
 */
export function buildExistingPRReviewChecklist(prNumber: number, prUrl: string): string {
  return (
    `\n\n**Mandatory pre-declaration checklist — you MUST complete ALL steps before ` +
    `declaring the PR clean or pushing:**\n` +
    `- [ ] 1. **Read the full diff** — run \`gh pr diff ${prNumber}\` (or visit ${prUrl}/files) ` +
    `and read every changed file. Running \`tsc\` or a build alone is NOT sufficient; ` +
    `you must read the actual code changes line by line.\n` +
    `- [ ] 2. **Check for logic bugs** — look for off-by-one errors, incorrect boundary ` +
    `conditions (e.g. Math.min vs Math.max), null/undefined edge cases, and wrong ` +
    `operator usage in every changed function.\n` +
    `- [ ] 3. **Verify test coverage** — confirm that tests exist for the new/changed ` +
    `code paths. If new logic was added without tests, add them.\n` +
    `- [ ] 4. **Confirm the PR body** includes the required \`Closes #<issue>\` reference.\n` +
    `- [ ] 5. **Summarise your findings** — before declaring "no changes needed", write ` +
    `a brief summary of what you reviewed and why the code is correct. A review that ` +
    `only says "looks good" or "build passes" will be rejected.\n\n` +
    `⚠️ Only after completing all five items above may you declare "no changes needed". ` +
    `If you skip any item or only run a build check, your review will be scored as ` +
    `incomplete and will not pass verification.`
  );
}

export interface TriggerResult {
  dispatched: number;
  skipped: number;
  errors: string[];
  /** Names of agents that received a dispatch in this call. */
  dispatchedAgents?: string[];
}

/** @deprecated Use store.hasActiveTask() directly */
function hasInFlightTask(store: StateStore, agentName: string): boolean {
  return store.hasActiveTask(agentName);
}

/**
 * Fire-and-forget dispatch: starts the dispatch without blocking.
 * The daemon continues its cycle while the agent works.
 *
 * @param onAgentCompleted - Optional callback invoked immediately after the
 *   agent's response is received (i.e., right when the agent finishes its
 *   work and may have pushed a branch). Used by the daemon to hook orphan-PR
 *   detection directly into the task-completion path rather than waiting for
 *   the next scheduled createOrphanPRs sweep.
 */
function fireAndForget(
  dispatcher: Dispatcher,
  store: StateStore,
  config: OrchestratorConfig,
  message: string,
  options: {
    agentName?: string;
    /**
     * The GitHub repo that triggered this task (e.g. "rapartlu/agent-proxy").
     * When provided (and `agentName` is omitted), the router uses this to
     * activate cross-repo destination detection so tasks explicitly naming a
     * different agent are routed to the correct destination rather than always
     * staying with the source repo's agent.
     */
    sourceRepo?: string;
    source: "github" | "linear" | "slack";
    sourceRef: string;
    title: string;
    prevalidated?: boolean;
  },
  /**
   * The agent name that acquired the issue claim for this dispatch.
   * When provided, the claim is released after the dispatch settles.
   */
  claimOwner: string | undefined,
  onAgentCompleted?: (agentName: string) => Promise<void>,
  /**
   * AbortController for this dispatch.  The caller registers it in
   * `inFlightDispatches` so that if a newer claim supersedes this task, the
   * signal is aborted to interrupt the long-running HTTP call immediately.
   */
  controller?: AbortController,
): void {
  dispatcher.dispatch(message, { ...options, signal: controller?.signal }).then(async (result) => {
    inFlightDispatches.delete(options.sourceRef);
    // Release the issue claim now that the dispatch has settled
    if (claimOwner) {
      store.releaseIssueClaim(options.source, options.sourceRef, claimOwner);
      log.debug("Issue claim released after dispatch settled", {
        sourceRef: options.sourceRef,
        agentName: claimOwner,
      });
    }
    // Release the in-flight reservation now that the agent's work is done.
    // The reservation covered the window between claim acquisition and task
    // completion (PR open). Removing it here allows future re-dispatches for
    // the same issue if the PR is closed or reverted without merging.
    store.removeInFlightReservation(options.source, options.sourceRef);
    log.debug("In-flight reservation released after dispatch settled", {
      sourceRef: options.sourceRef,
    });
    if (!result.taskId) {
      log.info("Fire-and-forget dispatch skipped by dispatcher", {
        agentName: result.agentName,
        sourceRef: options.sourceRef,
        failureCheck: result.validation?.failureCheck,
        failureCode: result.validation?.failureCode,
        failureReason: result.validation?.failureReason,
      });
      return;
    }
    // Attach the task ID to both the claim record and the in-flight reservation
    // while the task is in-flight so the dashboard can correlate them.
    // Both writes are best-effort and intentionally non-transactional.
    store.updateClaimTaskId(options.source, options.sourceRef, result.taskId);
    store.markProcessed(options.source, options.sourceRef, result.taskId);
    log.info("Fire-and-forget dispatch completed", { taskId: result.taskId, agentName: result.agentName });

    // Report result back to source
    const task = store.getTask(result.taskId);
    if (task) {
      reportResult(config, task, store).catch(() => {});
    }

    // Post-completion hook: called immediately after agent response so the
    // daemon can detect and create PRs for branches pushed by this agent
    // without waiting for the next scheduled orphan-PR sweep (which could be
    // up to one full poll interval later).
    if (onAgentCompleted) {
      try {
        await onAgentCompleted(result.agentName);
      } catch (err) {
        log.warn("Post-completion hook failed", {
          agentName: result.agentName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }).catch((err) => {
    inFlightDispatches.delete(options.sourceRef);
    // Release the claim even on error so the issue can be picked up next cycle
    if (claimOwner) {
      store.releaseIssueClaim(options.source, options.sourceRef, claimOwner);
      log.debug("Issue claim released after dispatch error", {
        sourceRef: options.sourceRef,
        agentName: claimOwner,
      });
    }
    // Release the in-flight reservation on error so the issue is not
    // permanently blocked. The TTL is a safety net, but explicit cleanup
    // gives the fastest possible recovery on dispatch failures.
    store.removeInFlightReservation(options.source, options.sourceRef);
    log.error("Fire-and-forget dispatch failed", { agentName: options.agentName ?? options.sourceRef, sourceRef: options.sourceRef, error: err instanceof Error ? err.message : String(err) });
  });
}

/**
 * GitHub: fetch issues centrally via gh CLI, dispatch each to the owning agent.
 *
 * @param onAgentCompleted - Optional callback invoked immediately after each
 *   agent's task completes (fire-and-forget completion). The daemon uses this
 *   to trigger an immediate orphan-branch → PR creation check for the specific
 *   agent that just finished, rather than waiting for the next scheduled
 *   createOrphanPRs sweep (up to one full poll interval later).
 */
export async function dispatchGitHubIssues(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  maxPerAgent = 1,
  registeredAgents?: Set<string>,
  onAgentCompleted?: (agentName: string) => Promise<void>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  // Pre-flight: verify gh is authenticated before attempting any API calls.
  // Surfaces a clear error rather than silently dispatching work that will fail
  // mid-task when the agent tries to create a PR (tasks 01KNEEEN, 01KNDFMP, 01KNDCBP).
  const authStatus = validateGhAuth();
  if (!authStatus.ok) {
    const reason = authStatus.reason ?? "gh CLI is not authenticated";
    log.error("GitHub dispatch aborted: gh auth pre-flight failed", { reason });
    result.errors.push(`gh auth pre-flight failed: ${reason}`);
    return result;
  }

  // Cache PR counts per repo for this cycle — avoids duplicate gh api calls
  // when multiple pool members share the same repo (e.g. claude + codex variants).
  const prCountCache = new Map<string, number | null>();
  function getCachedPRCount(repo: string): number | null {
    if (prCountCache.has(repo)) return prCountCache.get(repo)!;
    const count = countOpenPRs(repo);
    prCountCache.set(repo, count);
    return count;
  }

  // Evict expired claims, dispatch locks, and in-flight reservations at the
  // start of each cycle so stale entries from crashed agents never permanently
  // block an issue.
  const expiredClaims = store.cleanExpiredClaims();
  if (expiredClaims > 0) {
    log.info("Cleaned expired issue claims", { count: expiredClaims });
  }
  const expiredLocks = store.cleanExpiredDispatchLocks();
  if (expiredLocks > 0) {
    log.info("Cleaned expired dispatch locks", { count: expiredLocks });
  }
  const expiredReservations = store.cleanExpiredInFlightReservations();
  if (expiredReservations > 0) {
    log.info("Cleaned expired in-flight reservations", { count: expiredReservations });
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) {
      log.info("Skipping agent with in-flight task", { agentName });
      continue;
    }

    // Pre-dispatch auth hold (issue #430): skip auth-degraded agents entirely.
    // Their issues stay in the unprocessed pool and will be dispatched once auth
    // recovers (checkAuthRecovery un-quarantines them). This avoids wasting
    // GitHub API calls fetching issues for agents that can't create PRs.
    if (store.isAgentAuthDegraded(agentName)) {
      log.warn("Holding issues for auth-degraded agent", {
        agentName,
        repo: agent.github,
        reason: "GH_TOKEN missing or invalid — issues held until auth recovers",
      });
      result.skipped++;
      continue;
    }

    // Early exit: skip entire repo if at PR capacity (saves all per-issue validation calls).
    // Agent busy check already handled by hasInFlightTask above.
    const repoPrCap = config.agents[agentName]?.max_open_prs ?? config.dispatch?.max_open_prs ?? 3;
    if (repoPrCap > 0) {
      const openPrs = getCachedPRCount(agent.github);
      if (openPrs !== null && openPrs >= repoPrCap) {
        log.info("Skipping repo: at PR capacity", { repo: agent.github, openPrs, cap: repoPrCap });
        continue;
      }
    }

    let issues: GitHubIssue[];
    try {
      issues = fetchOpenIssues(agent.github);
    } catch (err) {
      result.errors.push(`${agent.github}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    let dispatchedForAgent = 0;
    for (const issue of sortIssuesForDispatch(store, issues)) {
      if (dispatchedForAgent >= maxPerAgent) break;

      const sourceRef = `${issue.repo}#${issue.number}`;

      if (inFlightDispatches.has(sourceRef)) {
        log.info("Skipping duplicate GitHub issue already in-flight", { sourceRef });
        result.skipped++;
        continue;
      }

      // In-flight dispatch reservation (issue #927): block dispatch when an
      // agent is actively building this issue right now.
      // The reservation is written the moment a claim is acquired — before the
      // agent even starts — with a 20-minute TTL. This covers the race window
      // between claim acquisition and PR creation that the 10-minute
      // dispatch_lock TTL does not fully cover (an agent typically takes
      // 5–25 minutes to open a PR). If the daemon restarts and loses the
      // in-memory inFlightDispatches map, the DB-backed reservation ensures
      // a second daemon instance cannot trigger a duplicate implementation.
      const existingReservation = store.getInFlightReservation("github", sourceRef);
      if (existingReservation) {
        log.info("Skipping dispatch: in-flight reservation active", {
          sourceRef,
          reservedBy: existingReservation.agent_name,
          reservedAt: existingReservation.reserved_at,
          expiresAt: existingReservation.expires_at,
          taskId: existingReservation.task_id,
        });
        result.skipped++;
        continue;
      }

      // Per-issue dispatch lock (issue #916): block rapid re-dispatch storms.
      // Once an issue is dispatched, a lock entry is written to state.db with a
      // configurable TTL (default 10 min). Any subsequent dispatch attempt for
      // the same sourceRef within the TTL is skipped here. The lock is released
      // early when the linked PR is merged or the issue is closed.
      const dispatchLock = store.getDispatchLock("github", sourceRef);
      if (dispatchLock) {
        log.info("Skipping dispatch: per-issue dispatch lock active", {
          sourceRef,
          lockedBy: dispatchLock.agent_name,
          lockedAt: dispatchLock.locked_at,
          expiresAt: dispatchLock.expires_at,
        });
        result.skipped++;
        continue;
      }

      const validation = runGitHubPreDispatchValidation({
        config,
        store,
        source: "github",
        agentName,
        issue: { repo: issue.repo, number: issue.number },
      });
      if (validation.outcome === "blocked") {
        log.info("Skipping dispatch: pre-dispatch validation blocked issue", {
          sourceRef,
          failureCheck: validation.failureCheck,
          failureCode: validation.failureCode,
          failureReason: validation.failureReason,
        });
        if (validation.failureCode === "issue_closed") {
          store.markProcessed("github", sourceRef, `closed-issue-${issue.number}`);
          // Release dispatch lock: issue is closed, no need to hold the lock
          store.releaseDispatchLock("github", sourceRef);
        }
        if (validation.failureCode === "merged_pr_exists") {
          store.markProcessed("github", sourceRef, `merged-pr-${validation.blockingPRNumber ?? issue.number}`);
          // Release dispatch lock: PR merged, issue will be closed shortly
          store.releaseDispatchLock("github", sourceRef);
        }
        // Pre-dispatch open-PR deduplication (issue #859): when an open or
        // approved PR already exists for this issue, create an "already-in-review"
        // task record and report a dashboard skip event. This eliminates
        // re-implementation waste by providing a visible audit trail instead of
        // silently skipping.
        //
        // Dispatch flood gate (issue #1060): if this guard already fired for the
        // same source_ref within the last 60 minutes, silently drop the event —
        // no task, no block record, no Telegram notification.  Only the *first*
        // fire within the window creates a task and sends an alert.
        if (
          (validation.failureCode === "open_pr_exists" || validation.failureCode === "approved_pr_waiting") &&
          validation.blockingPRNumber
        ) {
          const isFloodGateActive = store.hasRecentGuardBlock(sourceRef, GUARD_FLOOD_GATE_WINDOW_MS);
          if (isFloodGateActive) {
            log.info("Dispatch flood gate: suppressing duplicate guard fire within cooldown window", {
              sourceRef,
              blockingPRNumber: validation.blockingPRNumber,
              failureCode: validation.failureCode,
              windowMs: GUARD_FLOOD_GATE_WINDOW_MS,
            });
            result.skipped++;
            continue;
          }

          // First guard fire within the window — record the task, persist the
          // block event, and send a single Telegram alert.
          recordAlreadyInReviewTask(store, {
            sourceRef,
            agentName,
            issueNumber: issue.number,
            blockingPRNumber: validation.blockingPRNumber,
            failureCode: validation.failureCode,
            repo: issue.repo,
          });

          // Dispatch efficiency tracking (issue #976): persist a block event
          // so operators can measure how many dispatches are wasted on issues
          // that already have open PRs.
          try {
            const resolution = validation.failureCode === "approved_pr_waiting"
              ? `Approved PR #${validation.blockingPRNumber} is awaiting merge`
              : `Open PR #${validation.blockingPRNumber} is already in review`;
            store.recordDispatchBlock({
              sourceRef,
              agentName,
              reason: `Pre-dispatch guard blocked: ${resolution}`,
              blockCode: validation.failureCode,
              blockingPRNumber: validation.blockingPRNumber,
            });

            // Telegram alert: one notification per source_ref per cooldown window.
            const prUrl = `https://github.com/${issue.repo}/pull/${validation.blockingPRNumber}`;
            sendTelegramAlert(
              `🚦 *Dispatch guard fired* for \`${sourceRef}\`\n` +
              `PR [#${validation.blockingPRNumber}](${prUrl}) is already in review — dispatch suppressed for 60 min.`,
            );
          } catch (blockErr) {
            log.warn("Failed to record dispatch block event", {
              sourceRef,
              error: blockErr instanceof Error ? blockErr.message : String(blockErr),
            });
          }

          // Priority review fast-lane (issue #871): route open PRs blocking dispatch
          // to the priority review queue so they get reviewed in the current cycle
          // rather than waiting for the next general open-PR sweep.
          const routeOutcome = routeBlockingPRToQueue(store, {
            repo: issue.repo,
            prNumber: validation.blockingPRNumber,
            failureCode: validation.failureCode,
            blockedIssueRef: sourceRef,
          });
          log.info("Dispatch-blocked PR routed", {
            sourceRef,
            blockingPRNumber: validation.blockingPRNumber,
            routeOutcome,
          });
          reportDashboardSkip({
            issue_id: sourceRef,
            agent_name: agentName,
            skip_reason: "has_open_pr",
            condition_value: `hasOpenPR=true,pr=#${validation.blockingPRNumber},repo=${issue.repo},routeOutcome=${routeOutcome}`,
            context: `Pre-dispatch check: ${validation.failureReason}`,
          });
        }
        result.skipped++;
        continue;
      }

      // Standup dispatch guard: skip zero-action standups without burning an agent slot
      if (looksLikeStandupTask(issue.title, sourceRef)) {
        const issueNumber = extractStandupIssueNumber(sourceRef) ?? issue.number;
        const standupDecision = await shouldSkipStandupDispatch(issue.repo, issueNumber);
        if (standupDecision.skip) {
          log.info("Standup dispatch guard: skipping zero-action standup", {
            sourceRef,
            reason: standupDecision.reason,
            actionItemCount: standupDecision.actionItemCount,
          });
          store.markProcessed("github", sourceRef, `standup-skip-${issue.number}`);
          result.skipped++;
          continue;
        }
      }

      let message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

      if (validation.draftPR) {
        // Draft PR: inject context so the agent can continue on the existing branch
        log.info("Draft open PR found for issue — injecting PR context", {
          sourceRef,
          prNumber: validation.draftPR.number,
          prUrl: validation.draftPR.url,
        });
        message += `\n\n⚠️ This issue already has an open draft PR: #${validation.draftPR.number} (${validation.draftPR.url}). Do NOT create a new branch or open another PR. Instead, review the existing PR, make any needed fixes, and push to its branch.`;
        message += buildExistingPRReviewChecklist(validation.draftPR.number, validation.draftPR.url);
        message += `\n\n---\nWhen done: commit your changes and push to the existing PR branch. Do NOT run \`gh pr create\`.`;
      } else {
        const existingBranch = validation.existingBranch;
        if (existingBranch) {
          log.info("In-flight branch found for issue — injecting branch context", {
            sourceRef,
            branch: existingBranch,
          });
          message += `\n\n⚠️ A branch for this issue already exists: \`${existingBranch}\`. Do NOT create a new branch. Check out this branch, continue the work, and open a PR when ready.`;
          message += `\n\n---\nWhen done: push to branch \`${existingBranch}\` and open a PR with \`gh pr create --head ${existingBranch} --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`.`;
        } else {
          message += `\n\n---\nWhen done: create a branch, commit, push, and open a PR with \`gh pr create --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`. The "Closes #${issue.number}" is required so the issue auto-closes on merge.`;
        }
      }

      // Atomically acquire a claim for this issue before dispatching.
      // If another daemon instance or poll cycle already claimed the issue,
      // skip it — two agents can never hold an active claim simultaneously.
      const claimTtl = config.triggers?.issue_claim_ttl_ms ?? ISSUE_CLAIM_TTL_MS;
      const claimAcquired = store.tryClaimIssue("github", sourceRef, agentName, claimTtl);
      if (!claimAcquired) {
        const existingClaim = store.getActiveClaim("github", sourceRef);
        log.info("Skipping dispatch: issue already claimed by another agent", {
          sourceRef,
          claimedBy: existingClaim?.agent_name,
          expiresAt: existingClaim?.expires_at,
        });
        result.skipped++;
        continue;
      }

      // Cancel any older in-flight tasks for the same issue (issue #557).
      // When the claim lock is newly acquired, any task started before this
      // dispatch (by a different agent) is now duplicate work — mark it
      // superseded immediately so it cannot be verified or retried.
      const supersededCount = store.cancelSupersededTasks("github", sourceRef, agentName);
      if (supersededCount > 0) {
        // Also abort the HTTP call for the superseded in-flight dispatch so the
        // old agent's long-running Anthropic API call is interrupted immediately.
        // This is a best-effort signal: if the old dispatch has already completed
        // or its entry was already cleaned up, the abort is a no-op.
        const supersededController = inFlightDispatches.get(sourceRef);
        if (supersededController) {
          supersededController.abort();
          log.info("Sent abort signal to superseded in-flight dispatch", {
            sourceRef,
            agentName,
          });
        }
        log.info("Cancelled duplicate in-flight tasks for newly claimed issue", {
          sourceRef,
          agentName,
          supersededCount,
        });
      }

      // Create a fresh AbortController for this new dispatch and register it.
      // The controller is stored in inFlightDispatches so future supersession
      // can abort this call if another claim is acquired before it completes.
      const controller = new AbortController();
      inFlightDispatches.set(sourceRef, controller);

      // Acquire per-issue dispatch lock (issue #916) before firing the task.
      // This prevents subsequent daemon cycles from re-dispatching the same
      // issue while the agent is working (or while the PR is still open).
      // The lock TTL defaults to 10 minutes; it is released early if the PR
      // is merged or the issue is closed.
      const dispatchLockTtl = config.triggers?.dispatch_lock_ttl_ms ?? StateStore.DISPATCH_LOCK_TTL_MS;
      store.acquireDispatchLock("github", sourceRef, agentName, dispatchLockTtl);

      // Write the in-flight reservation (issue #927) immediately after acquiring
      // the claim and before calling fireAndForget. This write-ahead record
      // survives daemon restarts and covers the 5–25 minute window between now
      // and when the agent opens a PR — a window the 10-minute dispatch_lock
      // alone does not fully cover. The reservation is removed when the task
      // reaches a terminal state (done / failed / superseded).
      const reservationTtl =
        config.triggers?.in_flight_reservation_ttl_ms ??
        StateStore.IN_FLIGHT_RESERVATION_TTL_MS;
      store.addInFlightReservation("github", sourceRef, agentName, reservationTtl);
      log.info("In-flight reservation written", {
        sourceRef,
        agentName,
        expiresInMs: reservationTtl,
      });

      // Fire and forget — don't block the daemon cycle.
      // Pass sourceRepo (not agentName) so the router can detect cross-repo
      // destinations. For issues that target the owning agent the router still
      // returns that agent (sourceRepo score = 1.0); for issues that explicitly
      // name a different agent/repo the router overrides to the destination agent.
      // Pass the post-completion hook so the daemon is notified immediately
      // when this agent finishes and may have pushed a branch.
      fireAndForget(dispatcher, store, config, message, {
        sourceRepo: agent.github,
        source: "github",
        sourceRef,
        title: `[${issue.repo}#${issue.number}] ${issue.title}`,
        prevalidated: true,
      }, agentName, onAgentCompleted, controller);
      store.clearSourceRefPriority("github", sourceRef);

      result.dispatched++;
      dispatchedForAgent++;
    }
  }

  return result;
}

/**
 * Idle-agent backlog dispatch: immediately dispatch the highest-priority open
 * GitHub issue to any agent that currently has no active task.
 *
 * This is called after `verifyCompleted` each cycle so agents that just
 * finished their work receive their next assignment within the same poll
 * cycle, rather than waiting up to one full poll interval for the regular
 * trigger dispatch to run again.
 *
 * Priority order: issues are sorted ascending by issue number (lowest number =
 * oldest = highest priority). Only issues not already in `processed_triggers`
 * or `inFlightDispatches` are considered.
 *
 * Agents without a `github` field, or with an active task, are skipped.
 * Already-processed issues are skipped via the same duplicate-guard used
 * by `dispatchGitHubIssues`.
 *
 * @param forceReclaimAgents - When an agent name is in this set, the
 *   duplicate-guard recency window is bypassed. This is used for agents
 *   that have been idle for multiple poll cycles despite having open issues
 *   — a sign that all their issues are within the recency window (recently
 *   attempted but not yet resolved). Force-reclaim re-dispatches the oldest
 *   open issue so the agent can make another attempt.
 */
export async function dispatchIdleAgentBacklog(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  registeredAgents?: Set<string>,
  forceReclaimAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [], dispatchedAgents: [] };

  // Pre-flight: verify gh is authenticated before attempting any API calls.
  const authStatus = validateGhAuth();
  if (!authStatus.ok) {
    const reason = authStatus.reason ?? "gh CLI is not authenticated";
    log.error("Idle agent backlog dispatch aborted: gh auth pre-flight failed", { reason });
    result.errors.push(`gh auth pre-flight failed: ${reason}`);
    return result;
  }

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;

    // Only dispatch to genuinely idle agents — skip anyone with an active task
    if (store.hasActiveTask(agentName)) {
      log.info("Idle pickup: skipping busy agent", { agentName });
      continue;
    }

    // Pre-dispatch auth hold (issue #430): skip auth-degraded agents.
    if (store.isAgentAuthDegraded(agentName)) {
      log.warn("Idle pickup: holding issues for auth-degraded agent", {
        agentName,
        repo: agent.github,
      });
      result.skipped++;
      continue;
    }

    const forceReclaim = forceReclaimAgents?.has(agentName) ?? false;

    // Early exit: skip repo if at PR capacity (saves per-issue API calls)
    const idleRepoPrCap = config.agents[agentName]?.max_open_prs ?? config.dispatch?.max_open_prs ?? 3;
    if (idleRepoPrCap > 0) {
      const openPrs = countOpenPRs(agent.github);
      if (openPrs !== null && openPrs >= idleRepoPrCap) {
        log.info("Idle pickup: skipping repo at PR capacity", { repo: agent.github, openPrs, cap: idleRepoPrCap });
        continue;
      }
    }

    let issues: GitHubIssue[];
    try {
      issues = fetchOpenIssues(agent.github);
    } catch (err) {
      result.errors.push(`${agent.github}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const sorted = sortIssuesForDispatch(store, issues);

    let dispatched = false;
    for (const issue of sorted) {
      if (dispatched) break;

      const sourceRef = `${issue.repo}#${issue.number}`;

      // In force-reclaim mode, bypass the duplicate-guard recency window — only
      // block on truly in-flight dispatches to prevent same-cycle duplication.
      if (forceReclaim) {
        if (inFlightDispatches.has(sourceRef)) {
          result.skipped++;
          continue;
        }
      } else {
        if (inFlightDispatches.has(sourceRef)) {
          log.info("Idle pickup: skipping duplicate issue already in-flight", { sourceRef });
          result.skipped++;
          continue;
        }
      }

      // In-flight reservation check (issue #927) — idle pickup path.
      // Checked before the dispatch lock so a longer-TTL reservation prevents
      // duplicate implementation even if the 10-minute dispatch_lock has expired.
      const idleExistingReservation = store.getInFlightReservation("github", sourceRef);
      if (idleExistingReservation) {
        log.info("Idle pickup: skipping dispatch — in-flight reservation active", {
          sourceRef,
          reservedBy: idleExistingReservation.agent_name,
          reservedAt: idleExistingReservation.reserved_at,
          expiresAt: idleExistingReservation.expires_at,
          taskId: idleExistingReservation.task_id,
        });
        result.skipped++;
        continue;
      }

      // Per-issue dispatch lock (issue #916) — idle pickup path.
      // Respect the same lock that the primary dispatchGitHubIssues path writes.
      // force-reclaim does NOT bypass this lock: even when an agent is long-idle,
      // rapid re-dispatch of the same locked issue would not help if the agent
      // is already working on it (or a PR is already open).
      const idleDispatchLock = store.getDispatchLock("github", sourceRef);
      if (idleDispatchLock) {
        log.info("Idle pickup: skipping dispatch — per-issue dispatch lock active", {
          sourceRef,
          lockedBy: idleDispatchLock.agent_name,
          lockedAt: idleDispatchLock.locked_at,
          expiresAt: idleDispatchLock.expires_at,
        });
        result.skipped++;
        continue;
      }

      const validation = runGitHubPreDispatchValidation({
        config,
        store,
        source: "github",
        agentName,
        issue: { repo: issue.repo, number: issue.number },
        allowDuplicateRecencyBypass: forceReclaim,
      });
      if (validation.outcome === "blocked") {
        log.info("Idle pickup: pre-dispatch validation blocked issue", {
          sourceRef,
          failureCheck: validation.failureCheck,
          failureCode: validation.failureCode,
          failureReason: validation.failureReason,
        });
        if (validation.failureCode === "issue_closed") {
          store.markProcessed("github", sourceRef, `closed-issue-${issue.number}`);
          store.releaseDispatchLock("github", sourceRef);
        }
        if (validation.failureCode === "merged_pr_exists") {
          store.markProcessed("github", sourceRef, `merged-pr-${validation.blockingPRNumber ?? issue.number}`);
          store.releaseDispatchLock("github", sourceRef);
        }
        // Pre-dispatch open-PR deduplication (issue #859) — idle pickup path
        if (
          (validation.failureCode === "open_pr_exists" || validation.failureCode === "approved_pr_waiting") &&
          validation.blockingPRNumber
        ) {
          recordAlreadyInReviewTask(store, {
            sourceRef,
            agentName,
            issueNumber: issue.number,
            blockingPRNumber: validation.blockingPRNumber,
            failureCode: validation.failureCode,
            repo: issue.repo,
          });
          // Priority review fast-lane (issue #871) — idle pickup path: same as
          // the primary dispatch path, route blocking PRs into the priority queue.
          const routeOutcome = routeBlockingPRToQueue(store, {
            repo: issue.repo,
            prNumber: validation.blockingPRNumber,
            failureCode: validation.failureCode,
            blockedIssueRef: sourceRef,
          });
          log.info("Idle pickup: dispatch-blocked PR routed", {
            sourceRef,
            blockingPRNumber: validation.blockingPRNumber,
            routeOutcome,
          });
          reportDashboardSkip({
            issue_id: sourceRef,
            agent_name: agentName,
            skip_reason: "has_open_pr",
            condition_value: `hasOpenPR=true,pr=#${validation.blockingPRNumber},repo=${issue.repo},routeOutcome=${routeOutcome}`,
            context: `Idle pickup: ${validation.failureReason}`,
          });
        }
        result.skipped++;
        continue;
      }

      // Standup dispatch guard (idle pickup path)
      if (looksLikeStandupTask(issue.title, sourceRef)) {
        const issueNumber = extractStandupIssueNumber(sourceRef) ?? issue.number;
        const standupDecision = await shouldSkipStandupDispatch(issue.repo, issueNumber);
        if (standupDecision.skip) {
          log.info("Idle pickup: standup dispatch guard skipped zero-action standup", {
            sourceRef,
            reason: standupDecision.reason,
          });
          store.markProcessed("github", sourceRef, `standup-skip-${issue.number}`);
          result.skipped++;
          continue;
        }
      }

      let message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

      if (validation.draftPR) {
        // Draft PR: inject context so the agent can continue on the existing branch
        log.info("Idle pickup: draft open PR found — injecting PR context", {
          sourceRef,
          prNumber: validation.draftPR.number,
          prUrl: validation.draftPR.url,
        });
        message += `\n\n⚠️ This issue already has an open draft PR: #${validation.draftPR.number} (${validation.draftPR.url}). Do NOT create a new branch or open another PR. Instead, review the existing PR, make any needed fixes, and push to its branch.`;
        message += buildExistingPRReviewChecklist(validation.draftPR.number, validation.draftPR.url);
        message += `\n\n---\nWhen done: commit your changes and push to the existing PR branch. Do NOT run \`gh pr create\`.`;
      } else {
        const existingBranch = validation.existingBranch;
        if (existingBranch) {
          log.info("Idle pickup: in-flight branch found for issue — injecting branch context", {
            sourceRef,
            branch: existingBranch,
          });
          message += `\n\n⚠️ A branch for this issue already exists: \`${existingBranch}\`. Do NOT create a new branch. Check out this branch, continue the work, and open a PR when ready.`;
          message += `\n\n---\nWhen done: push to branch \`${existingBranch}\` and open a PR with \`gh pr create --head ${existingBranch} --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`.`;
        } else {
          message += `\n\n---\nWhen done: create a branch, commit, push, and open a PR with \`gh pr create --title "[${agentName}] <title>" --body "Closes #${issue.number}"\`. The "Closes #${issue.number}" is required so the issue auto-closes on merge.`;
        }
      }

      // Atomically acquire a claim before dispatching (same guard as dispatchGitHubIssues).
      const idleClaimTtl = config.triggers?.issue_claim_ttl_ms ?? ISSUE_CLAIM_TTL_MS;
      const claimAcquired = store.tryClaimIssue("github", sourceRef, agentName, idleClaimTtl);
      if (!claimAcquired) {
        const existingClaim = store.getActiveClaim("github", sourceRef);
        log.info("Idle pickup: skipping dispatch — issue already claimed by another agent", {
          sourceRef,
          claimedBy: existingClaim?.agent_name,
          expiresAt: existingClaim?.expires_at,
        });
        result.skipped++;
        continue;
      }

      // Cancel any older in-flight tasks for the same issue (issue #557).
      const supersededCount = store.cancelSupersededTasks("github", sourceRef, agentName);
      if (supersededCount > 0) {
        const supersededController = inFlightDispatches.get(sourceRef);
        if (supersededController) {
          supersededController.abort();
          log.info("Idle pickup: sent abort signal to superseded in-flight dispatch", {
            sourceRef,
            agentName,
          });
        }
        log.info("Idle pickup: cancelled duplicate in-flight tasks for newly claimed issue", {
          sourceRef,
          agentName,
          supersededCount,
        });
      }

      const controller = new AbortController();
      inFlightDispatches.set(sourceRef, controller);

      // Acquire per-issue dispatch lock (issue #916) — idle pickup path.
      const idleDispatchLockTtl = config.triggers?.dispatch_lock_ttl_ms ?? StateStore.DISPATCH_LOCK_TTL_MS;
      store.acquireDispatchLock("github", sourceRef, agentName, idleDispatchLockTtl);

      // Write in-flight reservation (issue #927) — idle pickup path.
      const idleReservationTtl =
        config.triggers?.in_flight_reservation_ttl_ms ??
        StateStore.IN_FLIGHT_RESERVATION_TTL_MS;
      store.addInFlightReservation("github", sourceRef, agentName, idleReservationTtl);
      log.info("Idle pickup: in-flight reservation written", {
        sourceRef,
        agentName,
        expiresInMs: idleReservationTtl,
      });

      // Pass sourceRepo instead of agentName so the router can detect cross-repo
      // destinations (same rationale as dispatchGitHubIssues above).
      fireAndForget(dispatcher, store, config, message, {
        sourceRepo: agent.github,
        source: "github",
        sourceRef,
        title: `[${issue.repo}#${issue.number}] ${issue.title}`,
        prevalidated: true,
      }, agentName, undefined, controller);
      store.clearSourceRefPriority("github", sourceRef);

      log.info(forceReclaim ? "Idle reclaim: dispatched issue to long-idle agent" : "Idle pickup: dispatched highest-priority issue to idle agent", {
        agentName,
        sourceRef,
        issueNumber: issue.number,
        issueTitle: issue.title,
        forceReclaim,
      });

      result.dispatched++;
      result.dispatchedAgents!.push(agentName);
      dispatched = true;
    }
  }

  return result;
}

/**
 * Linear: ask each agent to check its own Linear issues and work on them.
 */
export async function dispatchLinearChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  registeredAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.linear) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) continue;

    const sourceRef = `linear-check:${agentName}:${new Date().toISOString().slice(0, 13)}`;

    if (store.isProcessed("linear", sourceRef) || inFlightDispatches.has(sourceRef)) {
      result.skipped++;
      continue;
    }

    const filters: string[] = [];
    if (agent.linear.teams?.length) {
      filters.push(`in teams: ${agent.linear.teams.join(", ")}`);
    }
    if (agent.linear.projects?.length) {
      filters.push(`in projects: ${agent.linear.projects.join(", ")}`);
    }

    const message = `Check Linear for open issues assigned to you${filters.length ? " " + filters.join(" and ") : ""}. For each issue you find:
1. Review the issue description
2. If you can address it, do the work
3. Comment on the Linear issue with your progress or result
4. If you can't address it, note why

Report back what you found and what you did.`;

    const linearController = new AbortController();
    inFlightDispatches.set(sourceRef, linearController);

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "linear",
      sourceRef,
      title: `[linear] Check issues for ${agentName}`,
    }, undefined, undefined, linearController);

    result.dispatched++;
  }

  return result;
}

/**
 * Slack: ask each agent to check its Slack channels and respond to mentions.
 */
export async function dispatchSlackChecks(
  config: OrchestratorConfig,
  store: StateStore,
  dispatcher: Dispatcher,
  registeredAgents?: Set<string>,
): Promise<TriggerResult> {
  const result: TriggerResult = { dispatched: 0, skipped: 0, errors: [] };

  for (const [agentName, agent] of Object.entries(config.agents)) {
    if (!agent.slack) continue;
    if (registeredAgents && !registeredAgents.has(agentName)) continue;
    if (hasInFlightTask(store, agentName)) continue;

    const sourceRef = `slack-check:${agentName}:${new Date().toISOString().slice(0, 13)}`;

    if (store.isProcessed("slack", sourceRef) || inFlightDispatches.has(sourceRef)) {
      result.skipped++;
      continue;
    }

    const pattern = agent.slack.mention_pattern ?? "@orchestrator";
    const channelFilter = agent.slack.channels?.length
      ? ` in channels: ${agent.slack.channels.join(", ")}`
      : "";

    const message = `Check Slack for recent messages mentioning "${pattern}"${channelFilter}. For each relevant message:
1. Read the message and any thread context
2. If it's a task or question you can handle, do the work
3. Reply in the Slack thread with your response
4. If it's not for you, skip it

Report back what you found and what you did.`;

    const slackController = new AbortController();
    inFlightDispatches.set(sourceRef, slackController);

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "slack",
      sourceRef,
      title: `[slack] Check messages for ${agentName}`,
    }, undefined, undefined, slackController);

    result.dispatched++;
  }

  return result;
}
