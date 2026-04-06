import { fetchOpenIssues, findApprovedPRForIssue, findBranchForIssue, findExistingPRsForIssue, validateGhAuth, type GitHubIssue } from "./github.js";
import { reportResult } from "./reporters.js";
import { checkDuplicate } from "./duplicate-guard.js";
import { cachedIsIssueOpen, cachedGetIssueState, logCacheMetrics } from "./issue-state-bridge.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("trigger-dispatcher");

// In-memory set of source refs currently being dispatched (prevents duplicates
// while dispatch is in-flight, without violating DB foreign key constraints)
const inFlightDispatches = new Set<string>();

function sortIssuesForDispatch(store: StateStore, issues: GitHubIssue[]): GitHubIssue[] {
  return [...issues].sort((a, b) => {
    const aBoosted = store.isSourceRefPriorityBoosted("github", `${a.repo}#${a.number}`);
    const bBoosted = store.isSourceRefPriorityBoosted("github", `${b.repo}#${b.number}`);
    if (aBoosted !== bBoosted) {
      return aBoosted ? -1 : 1;
    }
    return a.number - b.number;
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
  },
  onAgentCompleted?: (agentName: string) => Promise<void>,
): void {
  dispatcher.dispatch(message, options).then(async (result) => {
    inFlightDispatches.delete(options.sourceRef);
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

      // inFlightDispatches catches same-cycle duplicates before the task
      // record is written to the DB.  checkDuplicate queries the tasks table
      // directly so active or recently-completed tasks are detected even after
      // a daemon restart (when inFlightDispatches is empty).
      const dupCheck = checkDuplicate(store, "github", sourceRef);
      if (inFlightDispatches.has(sourceRef) || dupCheck.isDuplicate) {
        if (dupCheck.isDuplicate) {
          log.info("Skipping duplicate GitHub issue", { sourceRef, reason: dupCheck.reason });
        }
        result.skipped++;
        continue;
      }

      // Pre-dispatch issue state validation via cache (issue #458): re-validates
      // issue state within 60s TTL, preventing dispatch to closed issues or
      // issues already resolved by a merged/open PR.
      const cachedState = cachedGetIssueState(agent.github, issue.number);

      if (cachedState.state === "closed") {
        log.info("Skipping dispatch: issue already closed (cached)", { sourceRef });
        store.markProcessed("github", sourceRef, `closed-issue-${issue.number}`);
        result.skipped++;
        continue;
      }

      // Still need to call findExistingPRsForIssue for the full PR objects
      // (the cache only tracks hasOpenPR/hasMergedPR booleans, not PR details).
      // But skip the API call entirely when the cache says no PRs exist.
      let existingPRs: ReturnType<typeof findExistingPRsForIssue> = [];
      if (cachedState.hasOpenPR || cachedState.hasMergedPR) {
        existingPRs = findExistingPRsForIssue(agent.github, issue.number);
      }
      const mergedPR = existingPRs.find((pr) => pr.state === "merged");
      const openPR = existingPRs.find((pr) => pr.state === "open");

      if (mergedPR) {
        log.info("Skipping dispatch: issue already addressed by merged PR", {
          sourceRef,
          prNumber: mergedPR.number,
          prUrl: mergedPR.url,
        });
        // Mark processed so this issue isn't re-checked on every daemon cycle
        store.markProcessed("github", sourceRef, `merged-pr-${mergedPR.number}`);
        result.skipped++;
        continue;
      }

      // Skip dispatch if there is already an approved, conflict-free PR waiting
      // to merge. Re-dispatching in this state just wastes cycles (see issue #28:
      // three dispatches, third only confirmed the already-approved PR was fine).
      const approvedPR = findApprovedPRForIssue(agent.github, issue.number);
      if (approvedPR) {
        log.info("Skipping dispatch: issue has approved PR awaiting merge", {
          sourceRef,
          prNumber: approvedPR.number,
          branch: approvedPR.headRefName,
        });
        result.skipped++;
        continue;
      }

      // Open-PR dispatch guard (issue #445): skip dispatch when a non-draft open
      // PR already exists for this issue. Re-dispatching in this state causes
      // duplicate agent work (#413). The PRReviewer flow (daemon.reviewPRs) picks
      // up the open PR in its own cycle — no additional dispatch is needed here.
      if (openPR && !openPR.isDraft) {
        log.info("Skipping dispatch: redirected to review — open PR already exists for issue", {
          sourceRef,
          prNumber: openPR.number,
          prUrl: openPR.url,
          reason: `redirected to review: PR #${openPR.number} already open for issue #${issue.number}`,
        });
        result.skipped++;
        continue;
      }

      let message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

      if (openPR) {
        // Draft PR: inject context so the agent can continue on the existing branch
        log.info("Draft open PR found for issue — injecting PR context", {
          sourceRef,
          prNumber: openPR.number,
          prUrl: openPR.url,
        });
        message += `\n\n⚠️ This issue already has an open draft PR: #${openPR.number} (${openPR.url}). Do NOT create a new branch or open another PR. Instead, review the existing PR, make any needed fixes, and push to its branch.`;
        message += buildExistingPRReviewChecklist(openPR.number, openPR.url);
        message += `\n\n---\nWhen done: commit your changes and push to the existing PR branch. Do NOT run \`gh pr create\`.`;
      } else {
        // Check for an in-flight branch without a PR (e.g. agent pushed but
        // was interrupted before opening the PR).  Inject branch context so
        // the agent continues from the existing branch rather than starting
        // fresh and creating a duplicate.
        const existingBranch = findBranchForIssue(agent.github, issue.number);
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

      // Mark processed immediately to prevent duplicate dispatches
      inFlightDispatches.add(sourceRef);

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
      }, onAgentCompleted);
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
        // Still block on genuinely active tasks (pending/dispatched/in_progress)
        const dupCheck = checkDuplicate(store, "github", sourceRef);
        if (dupCheck.isDuplicate && dupCheck.existingTask &&
            ["pending", "planning", "dispatched", "in_progress"].includes(dupCheck.existingTask.status)) {
          log.info("Idle reclaim: skipping issue with active task", { sourceRef, agentName });
          result.skipped++;
          continue;
        }
        if (dupCheck.isDuplicate) {
          log.info("Idle reclaim: bypassing recency window for idle agent", {
            sourceRef,
            agentName,
            reason: dupCheck.reason,
          });
        }
      } else {
        const dupCheck = checkDuplicate(store, "github", sourceRef);
        if (inFlightDispatches.has(sourceRef) || dupCheck.isDuplicate) {
          if (dupCheck.isDuplicate) {
            log.info("Idle pickup: skipping duplicate issue", { sourceRef, reason: dupCheck.reason });
          }
          result.skipped++;
          continue;
        }
      }

      // Pre-dispatch issue state validation via cache (issue #458)
      const cachedState2 = cachedGetIssueState(agent.github, issue.number);

      if (cachedState2.state === "closed") {
        log.info("Idle pickup: skipping closed issue (cached)", { sourceRef });
        store.markProcessed("github", sourceRef, `closed-issue-${issue.number}`);
        result.skipped++;
        continue;
      }

      // Fetch full PR objects only when cache indicates PRs exist
      let existingPRs2: ReturnType<typeof findExistingPRsForIssue> = [];
      if (cachedState2.hasOpenPR || cachedState2.hasMergedPR) {
        existingPRs2 = findExistingPRsForIssue(agent.github, issue.number);
      }
      const mergedPR = existingPRs2.find((pr) => pr.state === "merged");
      const openPR = existingPRs2.find((pr) => pr.state === "open");

      if (mergedPR) {
        log.info("Idle pickup: skipping issue with merged PR", {
          sourceRef,
          prNumber: mergedPR.number,
        });
        store.markProcessed("github", sourceRef, `merged-pr-${mergedPR.number}`);
        result.skipped++;
        continue;
      }

      // Skip dispatch if there is already an approved, conflict-free PR waiting
      // to merge. Re-dispatching in this state wastes cycles.
      const approvedPR = findApprovedPRForIssue(agent.github, issue.number);
      if (approvedPR) {
        log.info("Idle pickup: skipping dispatch — issue has approved PR awaiting merge", {
          sourceRef,
          prNumber: approvedPR.number,
          branch: approvedPR.headRefName,
        });
        result.skipped++;
        continue;
      }

      // Open-PR dispatch guard (issue #445): skip dispatch when a non-draft open
      // PR already exists for this issue — same guard as dispatchGitHubIssues.
      if (openPR && !openPR.isDraft) {
        log.info("Idle pickup: skipping dispatch — redirected to review, open PR already exists for issue", {
          sourceRef,
          prNumber: openPR.number,
          prUrl: openPR.url,
          reason: `redirected to review: PR #${openPR.number} already open for issue #${issue.number}`,
        });
        result.skipped++;
        continue;
      }

      let message = `GitHub Issue #${issue.number}: ${issue.title}${issue.labels.length > 0 ? `\nLabels: ${issue.labels.join(", ")}` : ""}\n\n${issue.body}\n\nURL: ${issue.url}`;

      if (openPR) {
        // Draft PR: inject context so the agent can continue on the existing branch
        log.info("Idle pickup: draft open PR found — injecting PR context", {
          sourceRef,
          prNumber: openPR.number,
          prUrl: openPR.url,
        });
        message += `\n\n⚠️ This issue already has an open draft PR: #${openPR.number} (${openPR.url}). Do NOT create a new branch or open another PR. Instead, review the existing PR, make any needed fixes, and push to its branch.`;
        message += buildExistingPRReviewChecklist(openPR.number, openPR.url);
        message += `\n\n---\nWhen done: commit your changes and push to the existing PR branch. Do NOT run \`gh pr create\`.`;
      } else {
        // Check for an in-flight branch without a PR
        const existingBranch = findBranchForIssue(agent.github, issue.number);
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

      inFlightDispatches.add(sourceRef);

      // Pass sourceRepo instead of agentName so the router can detect cross-repo
      // destinations (same rationale as dispatchGitHubIssues above).
      fireAndForget(dispatcher, store, config, message, {
        sourceRepo: agent.github,
        source: "github",
        sourceRef,
        title: `[${issue.repo}#${issue.number}] ${issue.title}`,
      });
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

    inFlightDispatches.add(sourceRef);

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "linear",
      sourceRef,
      title: `[linear] Check issues for ${agentName}`,
    });

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

    inFlightDispatches.add(sourceRef);

    fireAndForget(dispatcher, store, config, message, {
      agentName,
      source: "slack",
      sourceRef,
      title: `[slack] Check messages for ${agentName}`,
    });

    result.dispatched++;
  }

  return result;
}
