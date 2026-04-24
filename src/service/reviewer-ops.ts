import { execSync } from "node:child_process";
import { ReviewerClient } from "../client/reviewer-client.js";
import type {
  DetectedImprovement,
  SupervisorDecision,
  VerificationResult,
} from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { Dispatcher } from "../orchestrator/dispatcher.js";
import type { AgentHealth, StateStore, SupervisorDecisionRecord, Task } from "../state/store.js";
import { createLogger } from "./logger.js";
import { notifyOperator } from "./notify.js";
import { cachedGetIssueState, liveValidateForDispatch } from "../triggers/issue-state-bridge.js";
import { loadGoals, measureGoalProgress, buildGoalsContext } from "../orchestrator/goals.js";
import { detectCoverageGaps } from "../orchestrator/coverage-gap-detector.js";
import { scoreIssuePriority } from "../orchestrator/priority-scorer.js";
import { extractAndStoreRules } from "../orchestrator/learned-rules.js";
import { extractRepoFromSourceRef } from "../orchestrator/dispatcher.js";

const verifierLog = createLogger("verifier");
const supervisorLog = createLogger("supervisor");

const REVISION_ESCALATION_THRESHOLD = 3;
const ISSUE_REF_RE = /#\d+/;

/** Timeout in milliseconds for each artifact existence `gh` call. */
const ARTIFACT_CHECK_TIMEOUT_MS = 2000;
const ARTIFACT_KEYWORDS = [
  "create file",
  "open a pr",
  "open pr",
  "push branch",
  "push your branch",
  "push the branch",
  "push to ",
  "write ",
  "implement ",
  "add ",
  "fix ",
  "update ",
  "run command",
  "produce ",
  "generate ",
];

export interface GateResult {
  passed: SupervisorDecision[];
  blocked: Array<{ decision: SupervisorDecision; skipReason: string }>;
}

export async function verifyTask(
  store: StateStore,
  reviewerClient: ReviewerClient,
  taskId: string,
): Promise<VerificationResult> {
  const task = store.getTask(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  if (task.status !== "done") {
    throw new Error(`Task ${taskId} is not done (status: ${task.status})`);
  }

  store.updateTask(taskId, { verification_status: "pending" });

  try {
    const result = await reviewerClient.verifyTask(task);

    verifierLog.info("Verification complete", {
      taskId,
      approved: result.approved,
      score: result.score,
      agent: task.agent_name,
    });

    store.updateTask(taskId, {
      verification_status: result.approved ? "approved" : "rejected",
      quality_score: result.score,
      verification_notes: result.notes,
    });

    // Update routing outcome with quality score (issue #656).
    if (result.score != null) {
      store.updateRoutingOutcomeScore(taskId, result.score);
    }

    // Cross-task learning: extract rules from reviewer feedback
    const feedbackText = result.revision || result.notes;
    if (feedbackText && !result.approved) {
      const repo = extractRepoFromSourceRef(task.source_ref);
      if (repo) {
        const extractedRules = extractAndStoreRules(
          store,
          repo,
          feedbackText,
          `Task ${taskId} verification feedback`,
          taskId,
        );
        if (extractedRules.length > 0) {
          verifierLog.info("Extracted learned rules from verification feedback", {
            taskId,
            repo,
            ruleCount: extractedRules.length,
          });
        }
      }
    }

    // Cross-task learning: boost confidence of rules that were applied to successful tasks
    if (result.approved) {
      boostAppliedRules(store, taskId);
    } else {
      decayAppliedRules(store, taskId);
    }

    // Update failure interception outcome so the metrics panel can compute
    // prevention_rate (issue #1086).
    try {
      store.updateFailureInterceptionOutcome(taskId, result.approved ? "passed" : "failed");
    } catch {
      // Non-fatal — the interception table may not exist yet on old DBs.
    }

    return result;
  } catch (err) {
    verifierLog.error("Verification failed", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    store.updateTask(taskId, { verification_status: null });
    throw new Error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function verifyAndReviseTask(
  config: OrchestratorConfig,
  store: StateStore,
  reviewerClient: ReviewerClient,
  taskId: string,
  maxRetries = 1,
): Promise<VerificationResult> {
  const result = await verifyTask(store, reviewerClient, taskId);

  if (result.approved || maxRetries <= 0 || !result.revision) {
    return result;
  }

  const task = store.getTask(taskId)!;

  // Pre-flight state check (issue #769): before committing to a revision
  // dispatch, verify the triggering issue/PR is still open.  When a PR is
  // merged and the issue closed between the moment of rejection and the
  // moment we process the revision, dispatching would waste supervisor
  // capacity and risk conflicting actions on already-resolved work.
  if (task.source_ref && task.agent_name) {
    const repo = extractRepoFromSourceRef(task.source_ref);
    const issueMatch = task.source_ref.match(/#(\d+)$/);
    if (repo && issueMatch) {
      const issueNumber = parseInt(issueMatch[1], 10);
      try {
        const skipReason = liveValidateForDispatch(repo, issueNumber);
        if (skipReason) {
          verifierLog.info("Revision skipped: source already resolved", {
            taskId,
            sourceRef: task.source_ref,
            skipReason,
          });
          store.addSupervisorDecision({
            action: "none",
            agent_name: task.agent_name,
            reason: "no-op: already resolved",
            rationale: `Revision skipped for task ${taskId}: ${task.source_ref} is already resolved (${skipReason}). No revision dispatched.`,
            issue_refs: [task.source_ref],
            hard_gates: ["no-op: already resolved"],
            outcome: "skipped",
          });
          store.incrementStat("supervisor_preflight_noop");
          // Reset verification_status so the task isn't re-queued for revision
          store.updateTask(taskId, { verification_status: "approved" });
          return { ...result, approved: true, notes: "no-op: already resolved" };
        }
      } catch (preflightErr) {
        // GitHub check failed — allow revision to proceed rather than blocking on uncertainty
        verifierLog.warn("Pre-flight state check failed, proceeding with revision", {
          taskId,
          sourceRef: task.source_ref,
          error: preflightErr instanceof Error ? preflightErr.message : String(preflightErr),
        });
      }
    }
  }

  const newRevisionCount = (task.revision_count ?? 0) + 1;
  store.updateTask(taskId, { revision_count: newRevisionCount });

  if (newRevisionCount >= REVISION_ESCALATION_THRESHOLD) {
    const sourceLabel = task.source_ref ?? task.title;
    verifierLog.warn("Revision loop detected — escalating to operator", {
      taskId,
      sourceRef: task.source_ref,
      revisionCount: newRevisionCount,
    });
    // Rate limit key includes the date so stuck issues alert at most once per day,
    // not every 15 minutes (the previous behaviour generated 96+ alerts/day per issue).
    const alertDate = new Date().toISOString().slice(0, 10);
    await notifyOperator(
      "Stuck Issue — Revision Loop",
      `Issue ${sourceLabel} has reached ${newRevisionCount} revision(s).\n` +
      `Agent: ${task.agent_name ?? "unknown"}\n` +
      `Quality score: ${task.quality_score?.toFixed(1) ?? "n/a"}\n` +
      `Task: ${task.title}\n\n` +
      "This issue may need manual intervention.",
      "warning",
      `stuck-issue:${task.source_ref ?? taskId}:${alertDate}`,
    );
  }

  const autoReroute = getAutoRerouteTarget(config, store, task);

  if (!autoReroute && task.agent_name && store.hasActiveTask(task.agent_name)) {
    verifierLog.info("Revision deferred: agent busy, will retry next cycle", {
      taskId,
      agentName: task.agent_name,
    });
    store.updateTask(taskId, { verification_status: null });
    return result;
  }

  const dispatcher = new Dispatcher(config, store);
  const rerouteHeader = autoReroute
    ? `## Auto-Reroute Context
This issue has been reassigned from ${task.agent_name} to ${autoReroute.agentName} after ${autoReroute.consecutiveRejections} consecutive verifier rejection(s) for ${task.source_ref ?? task.title}. Please take a fresh pass and avoid repeating the prior failed approach.

`
    : "";

  // Build the revision message with original context and dimension feedback
  const revisionParts = [
    rerouteHeader ? rerouteHeader : "",
    "Your previous response to this task was reviewed and needs revision.",
    "",
    "## Original Task",
    task.description ?? task.title,
    "",
  ];

  // Include original result preview (truncated to 600 chars)
  if (task.result) {
    const preview = task.result.length > 600
      ? task.result.slice(0, 600) + "...[truncated]"
      : task.result;
    revisionParts.push("## Original Result");
    revisionParts.push(preview);
    revisionParts.push("");
  }

  // Include per-dimension score breakdown if available
  if (result.dimensions && Object.keys(result.dimensions).length > 0) {
    revisionParts.push("## Quality Assessment by Dimension");
    for (const [dimension, score] of Object.entries(result.dimensions)) {
      if (score !== undefined) {
        const scorePercent = (score * 100).toFixed(0);
        const indicator = score >= 0.7 ? "✓" : score >= 0.5 ? "~" : "✗";
        revisionParts.push(`- **${dimension}**: ${scorePercent}% ${indicator}`);
      }
    }
    revisionParts.push("");
  }

  // Include PR URL if available in source_ref
  if (task.source_ref) {
    const repo = extractRepoFromSourceRef(task.source_ref);
    if (repo && task.source_ref.includes("#")) {
      const issueMatch = task.source_ref.match(/#(\d+)$/);
      if (issueMatch) {
        const issueNum = issueMatch[1];
        revisionParts.push(`## Related GitHub Issue`);
        revisionParts.push(`${repo}#${issueNum}: ${task.title}`);
        revisionParts.push("");
      }
    }
  }

  // Include the reviewer feedback
  revisionParts.push("## Reviewer Feedback");
  revisionParts.push(result.revision ?? "No specific feedback provided");
  revisionParts.push("");
  revisionParts.push("Please address the feedback and provide an improved response.");

  const revisionMessage = revisionParts.join("\n");

  try {
    const revisionResult = await dispatcher.dispatch(revisionMessage, {
      agentName: autoReroute?.agentName ?? task.agent_name ?? undefined,
      source: task.source,
      sourceRef: task.source_ref ?? undefined,
      title: `${autoReroute ? "[auto-reroute]" : "[revision]"} ${task.title}`,
      conversationId: autoReroute ? undefined : task.conversation_id ?? undefined,
    });

    store.updateTask(revisionResult.taskId, { revision_count: newRevisionCount });

    if (autoReroute) {
      const rationale =
        `Substituted ${task.agent_name} with ${autoReroute.agentName} after ` +
        `${autoReroute.consecutiveRejections} consecutive rejected attempt(s) ` +
        `on ${task.source_ref ?? task.title} (threshold ${autoReroute.threshold}).`;
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: autoReroute.agentName,
        reason: "auto-reroute",
        message: revisionMessage,
        rationale,
        issue_refs: task.source_ref ? [task.source_ref] : [],
        outcome: revisionResult.taskId ? "dispatched" : "skipped",
        task_id: revisionResult.taskId || undefined,
      });
      if (revisionResult.taskId) {
        await notifyOperator(
          "Issue auto-rerouted",
          `Issue ${task.source_ref ?? task.title} was reassigned from ${task.agent_name} to ` +
          `${autoReroute.agentName} after ${autoReroute.consecutiveRejections} consecutive ` +
          `rejections (threshold ${autoReroute.threshold}).`,
          "warning",
          `auto-reroute:${task.source_ref ?? taskId}:${task.agent_name}:${autoReroute.agentName}`,
        );
      }
    }

    return verifyTask(store, reviewerClient, revisionResult.taskId);
  } catch (err) {
    if (autoReroute) {
      store.addSupervisorDecision({
        action: "dispatch",
        agent_name: autoReroute.agentName,
        reason: "auto-reroute",
        message: revisionMessage,
        rationale:
          `Attempted to substitute ${task.agent_name} with ${autoReroute.agentName} after ` +
          `${autoReroute.consecutiveRejections} consecutive rejected attempt(s) ` +
          `on ${task.source_ref ?? task.title}, but dispatch failed.`,
        issue_refs: task.source_ref ? [task.source_ref] : [],
        outcome: "failed",
      });
    }
    verifierLog.warn("Revision dispatch failed, resetting for retry", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    store.updateTask(taskId, { verification_status: null });
    return result;
  }
}

/** Result of a single GitHub artifact existence check. */
export interface ArtifactCheckResult {
  /** true if the artifact (issue or PR) was found in the repo. */
  exists: boolean;
  /** "issue" or "pr" when found; null when not found or on unknown errors. */
  type: "issue" | "pr" | null;
  /** The canonical ref that was checked, e.g. "owner/repo#123". */
  ref: string;
}

/**
 * Check whether a GitHub artifact (issue or PR) actually exists.
 *
 * Tries `gh issue view` first; if that fails with a "not found" error, tries
 * `gh pr view`.  Both calls use a short timeout so dispatch latency stays
 * well under 500 ms per artifact.  On ambiguous errors (network, auth) the
 * function fails open (returns `exists: true`) to avoid false-positive blocks.
 */
export function checkGitHubArtifactExists(
  repo: string,
  number: number,
): ArtifactCheckResult {
  const ref = `${repo}#${number}`;
  const execOpts = {
    encoding: "utf-8" as const,
    timeout: ARTIFACT_CHECK_TIMEOUT_MS,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };

  // Helper: is the error clearly "not found" rather than auth/network?
  function isNotFoundError(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return msg.includes("not found") || msg.includes("could not resolve");
  }

  // Try as an issue first.
  try {
    execSync(`gh issue view ${number} --repo ${repo} --json number --jq '.number'`, execOpts);
    return { exists: true, type: "issue", ref };
  } catch (err) {
    if (!isNotFoundError(err)) {
      // Unknown failure (auth, network, rate-limit) — fail open.
      return { exists: true, type: null, ref };
    }
  }

  // Try as a PR.
  try {
    execSync(`gh pr view ${number} --repo ${repo} --json number --jq '.number'`, execOpts);
    return { exists: true, type: "pr", ref };
  } catch (err) {
    if (!isNotFoundError(err)) {
      return { exists: true, type: null, ref };
    }
  }

  return { exists: false, type: null, ref };
}

/** Outcome of pre-dispatch artifact existence filtering. */
export interface PhantomArtifactFilterResult {
  passed: SupervisorDecision[];
  phantom: Array<{ decision: SupervisorDecision; missingRef: string }>;
}

/**
 * Filter supervisor dispatch/follow-up decisions by validating that every
 * GitHub artifact referenced in the message or reason actually exists in the
 * target agent's repo.
 *
 * Decisions that reference phantom artifacts are removed from the dispatch
 * queue and returned in the `phantom` array so the caller can escalate them.
 * Valid decisions and non-dispatch decisions are passed through unchanged.
 */
export function filterPhantomArtifactDispatches(
  config: OrchestratorConfig,
  decisions: SupervisorDecision[],
): PhantomArtifactFilterResult {
  const passed: SupervisorDecision[] = [];
  const phantom: PhantomArtifactFilterResult["phantom"] = [];

  for (const d of decisions) {
    // Only validate dispatch/follow-up decisions — other actions don't create
    // tasks and therefore can't produce phantom revision cycles.
    if (d.action !== "dispatch" && d.action !== "follow-up") {
      passed.push(d);
      continue;
    }

    // Need an agent name to determine which repo to check.
    if (!d.agentName) {
      passed.push(d);
      continue;
    }

    const agentRepo = config.agents[d.agentName]?.github;
    if (!agentRepo) {
      passed.push(d);
      continue;
    }

    const issueRefs = extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`);
    if (issueRefs.length === 0) {
      passed.push(d);
      continue;
    }

    let phantomRef: string | null = null;
    for (const num of issueRefs) {
      const result = checkGitHubArtifactExists(agentRepo, num);
      if (!result.exists) {
        phantomRef = result.ref;
        break;
      }
    }

    if (phantomRef) {
      phantom.push({ decision: d, missingRef: phantomRef });
    } else {
      passed.push(d);
    }
  }

  return { passed, phantom };
}

export async function reviewSupervisorState(
  config: OrchestratorConfig,
  store: StateStore,
  reviewerClient: ReviewerClient,
): Promise<SupervisorDecision[]> {
  const context = buildSupervisorContext(config, store);
  const decisions = await reviewerClient.supervisorReview(context);
  const validated = filterVagueDispatches(store, decisions);

  const dropped = decisions.length - validated.length;
  if (dropped > 0) {
    supervisorLog.warn("Supervisor: dropped vague idle-agent dispatches", { dropped });
  }

  // Pre-dispatch GitHub artifact existence validation (issue #786):
  // ensure every referenced issue/PR actually exists before dispatching.
  // Phantom artifact decisions are escalated to the operator instead of
  // reaching agent queues.
  const { passed: existenceValidated, phantom } = filterPhantomArtifactDispatches(config, validated);

  if (phantom.length > 0) {
    for (const { decision, missingRef } of phantom) {
      supervisorLog.warn("Supervisor: phantom artifact — dispatch blocked", {
        agentName: decision.agentName,
        missingRef,
        reason: decision.reason,
      });

      await notifyOperator(
        "Phantom Artifact — Dispatch Blocked",
        `Supervisor attempted to dispatch to ${decision.agentName ?? "unknown"} referencing ` +
          `${missingRef}, but that artifact does not exist in the target repo.\n\n` +
          `Original reason: ${decision.reason}\n\n` +
          `The dispatch was blocked. Verify the artifact reference is correct before retrying.`,
        "warning",
        `phantom-artifact:${missingRef}`,
      );

      store.addSupervisorDecision({
        action: "none",
        agent_name: decision.agentName,
        reason: "phantom-artifact",
        rationale:
          `Dispatch blocked: ${missingRef} does not exist in the target repo. ` +
          `Original reason: ${decision.reason}`,
        issue_refs: [],
        hard_gates: [`phantom-artifact:${missingRef}`],
        outcome: "skipped",
      });
    }

    supervisorLog.warn("Supervisor: blocked phantom artifact dispatch(es)", {
      blocked: phantom.length,
      refs: phantom.map((p) => p.missingRef),
    });
  }

  supervisorLog.info("Supervisor review complete", {
    decisions: existenceValidated.length,
    actions: existenceValidated.map((d) => d.action),
  });
  return existenceValidated;
}

export function gateResolvedIssues(
  config: OrchestratorConfig,
  store: StateStore,
  decisions: SupervisorDecision[],
): GateResult {
  const passed: SupervisorDecision[] = [];
  const blocked: GateResult["blocked"] = [];

  for (const d of decisions) {
    if (d.action !== "dispatch" && d.action !== "follow-up") {
      passed.push(d);
      continue;
    }

    const agentGithub = d.agentName
      ? config.agents[d.agentName]?.github
      : undefined;

    if (!agentGithub) {
      passed.push(d);
      continue;
    }

    const issueRefs = extractIssueRefs(`${d.message ?? ""} ${d.reason ?? ""}`);
    if (issueRefs.length === 0) {
      passed.push(d);
      continue;
    }

    let skipReason: string | null = null;

    for (const issueNum of issueRefs) {
      try {
        skipReason = liveValidateForDispatch(agentGithub, issueNum);
        if (skipReason) {
          supervisorLog.warn("Supervisor hard gate: dispatch blocked", {
            agentName: d.agentName,
            issueNum,
            skipReason,
            reason: d.reason,
          });
          break;
        }
      } catch (err) {
        supervisorLog.warn("Supervisor hard gate: GitHub check failed, allowing dispatch", {
          agentName: d.agentName,
          issueNum,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (skipReason) {
      blocked.push({ decision: d, skipReason });
    } else {
      passed.push(d);
    }
  }

  if (blocked.length > 0) {
    supervisorLog.info("Supervisor hard gate summary", {
      total: decisions.length,
      passed: passed.length,
      blocked: blocked.length,
      blockedReasons: blocked.map((b) => b.skipReason),
    });
  }

  return { passed, blocked };
}

export function buildSupervisorContext(config: OrchestratorConfig, store: StateStore): string {
  const sections: string[] = [];

  const priorDecisions = store.getRecentSupervisorDecisions(10);
  if (priorDecisions.length > 0) {
    const lines = priorDecisions
      .map((d: SupervisorDecisionRecord) => {
        const agentPart = d.agent_name ? ` → ${d.agent_name}` : "";
        const taskPart = d.task_id ? ` [task:${d.task_id.slice(0, 8)}]` : "";
        const issuePart = d.issue_refs.length > 0 ? ` [issues: ${d.issue_refs.join(", ")}]` : "";
        const gatePart = d.hard_gates.length > 0 ? ` [gates: ${d.hard_gates.join("; ")}]` : "";
        return `- [${d.created_at.slice(0, 16)}] ${d.action}${agentPart}: ${d.reason} (outcome: ${d.outcome}${taskPart})${issuePart}${gatePart}`;
      })
      .join("\n");
    sections.push(`## Recent Supervisor Decisions\n${lines}`);
  }

  const agents = Object.entries(config.agents)
    .map(([name, a]) => `- ${name}: ${a.description}${a.github ? ` (${a.github})` : ""}`)
    .join("\n");
  sections.push(`## Agents\n${agents}`);

  const openIssues = fetchOpenIssues(config, store);
  if (openIssues.length > 0) {
    sections.push(`## Open Issues\n${openIssues.join("\n")}`);
  }

  const recent = store.getRecentCompleted(10);
  if (recent.length > 0) {
    const taskLines = recent.map((t) => formatTask(t)).join("\n");
    sections.push(`## Recent Completed Tasks\n${taskLines}`);
  }

  const researchFindings = store.getApprovedResearchFindings(5);
  if (researchFindings.length > 0) {
    const lines = researchFindings.map((t) => {
      const linked = store.isResearchLinked(t.id) ? " → implementation issues filed" : " → not yet linked to implementation";
      const score = t.quality_score ? ` [score: ${t.quality_score.toFixed(1)}]` : "";
      const findings = t.result ? `\n  Findings: ${t.result.slice(0, 500)}` : "";
      return `- ${t.id.slice(0, 8)} (${t.agent_name})${score}: ${t.title}${linked}${findings}`;
    }).join("\n");
    sections.push(`## Recent Research Findings\n${lines}`);
  }

  const unverified = store.getUnverified(10);
  if (unverified.length > 0) {
    const lines = unverified.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}`).join("\n");
    sections.push(`## Unverified Tasks (${unverified.length})\n${lines}`);
  }

  const failed = store.listTasks({ status: "failed", limit: 5 });
  if (failed.length > 0) {
    const lines = failed.map((t) => `- ${t.id.slice(0, 8)} (${t.agent_name}): ${t.title}\n  Error: ${t.result?.slice(0, 100)}`).join("\n");
    sections.push(`## Recent Failures\n${lines}`);
  }

  const loadLines: string[] = [];
  for (const name of Object.keys(config.agents)) {
    const active = store.listTasks({ status: "dispatched", agent_name: name, limit: 10 });
    loadLines.push(`- ${name}: ${active.length} active task(s)`);
  }
  sections.push(`## Agent Load\n${loadLines.join("\n")}`);

  const stats = store.getAgentStats();
  if (stats.length > 0) {
    const lines = stats.map((s) => {
      const rate = s.total > 0 ? ((s.done / s.total) * 100).toFixed(0) : "N/A";
      return `- ${s.agent_name}: ${s.done}/${s.total} done (${rate}%), ${s.failed} failed`;
    }).join("\n");
    sections.push(`## Agent Performance\n${lines}`);
  }

  // Inject coverage gaps so the supervisor can propose new agents
  try {
    const gaps = detectCoverageGaps(config, store, 14);
    if (gaps.length > 0) {
      const gapLines = gaps.slice(0, 5).map((g) =>
        `- [${g.type}] "${g.topic}" — ${g.details}`,
      ).join("\n");
      sections.push(`## Coverage Gaps (last 14 days)\n${gapLines}`);
    }
  } catch { /* coverage gap detection is optional */ }

  // Inject monthly goals so the supervisor prioritizes goal-aligned work
  const goals = loadGoals(config.orchestrator_dir);
  if (goals.goals.length > 0) {
    const progress = measureGoalProgress(goals, store);
    sections.unshift(buildGoalsContext(progress));
  }

  // Surface positive efficiency metrics so the improvement detector can
  // recognise what's working well, not just what's failing (issue #595).
  const followUpsAvoided = store.getStat("follow_ups_avoided");
  if (followUpsAvoided > 0) {
    sections.push(
      `## Orchestrator Efficiency\n` +
      `- follow_ups_avoided: ${followUpsAvoided} cross-repo follow-up issue(s) skipped because an open PR already closes the parent issue`,
    );
  }

  // Meeting priority outcomes — inject the most recent structured outcome so the
  // supervisor can make goal-aligned routing decisions without re-running a meeting.
  // Signal type `meeting_priority_outcome` is written by `extractPriorityOutcomes()`
  // in team-meeting.ts after every meeting that produced a priority ranking.
  try {
    const prioritySignals = store.readSignals({
      signal_type: "meeting_priority_outcome",
      limit: 3,
    });
    if (prioritySignals.length > 0) {
      const lines: string[] = [];
      for (const sig of prioritySignals) {
        const outcome = sig.value ? JSON.parse(sig.value as string) : null;
        if (!outcome) continue;
        const rankLine = outcome.priorityRanking?.length > 0
          ? `Priority order: ${(outcome.priorityRanking as string[]).join(" → ")}`
          : "No explicit ranking.";
        const seqLine = outcome.sequencingConstraints?.length > 0
          ? `Sequencing: ${(outcome.sequencingConstraints as string[]).join("; ")}`
          : "";
        const followUp = outcome.followUpMeetingRecommended
          ? "Follow-up coordination meeting recommended before implementation."
          : "";
        const topicLine = outcome.topic ? `Topic: ${outcome.topic}` : "";
        const rationale = outcome.rationale
          ? `Rationale: ${(outcome.rationale as string).slice(0, 300)}`
          : "";
        lines.push(
          [
            `Meeting date: ${outcome.meetingDate ?? sig.created_at?.slice(0, 10)}`,
            topicLine,
            rankLine,
            seqLine,
            followUp,
            rationale,
          ]
            .filter(Boolean)
            .join("\n  "),
        );
      }
      if (lines.length > 0) {
        sections.push(
          `## Meeting Priority Outcomes (most recent first)\n` +
          `Use these to prioritise which issues to dispatch next.\n` +
          lines.join("\n\n"),
        );
      }
    }
  } catch { /* reading meeting priority signals is optional */ }

  // Routing accuracy feedback: per-agent quality breakdown by task type (issue #656).
  // Used to prefer higher-accuracy agents for similar task types.
  const routingStats = store.getRoutingAccuracyStats(30);
  if (routingStats.length > 0) {
    // Group by agent for readable display
    const byAgent = new Map<string, typeof routingStats>();
    for (const row of routingStats) {
      if (!byAgent.has(row.agent_name)) byAgent.set(row.agent_name, []);
      byAgent.get(row.agent_name)!.push(row);
    }
    const lines: string[] = [];
    for (const [agentName, rows] of byAgent) {
      const parts = rows
        .filter((r) => r.scored > 0)
        .map((r) => {
          const score = r.avg_quality_score != null ? r.avg_quality_score.toFixed(2) : "n/a";
          return `${r.task_type}: ${score} (n=${r.scored})`;
        });
      if (parts.length > 0) {
        lines.push(`- ${agentName}: ${parts.join(", ")}`);
      }
    }
    if (lines.length > 0) {
      sections.push(
        `## Routing Accuracy (last 30 days)\n` +
        `Avg quality score by agent × task type. Prefer agents with higher scores for similar tasks.\n` +
        lines.join("\n"),
      );
    }
  }

  return sections.join("\n\n");
}

export function extractIssueRefs(text: string): number[] {
  const refs = new Set<number>();
  for (const match of text.matchAll(/#(\d+)/g)) {
    refs.add(parseInt(match[1], 10));
  }
  return [...refs];
}

export function isDecisionAlreadyResolved(
  message: string,
  reason: string,
  agentGithub: string,
): boolean {
  const refs = extractIssueRefs(`${message} ${reason}`);
  if (refs.length === 0) return false;

  let checkedAny = false;

  for (const num of refs) {
    try {
      try {
        const cached = cachedGetIssueState(agentGithub, num);
        checkedAny = true;
        if (cached.state === "open" && !cached.hasMergedPR) {
          return false;
        }
        continue;
      } catch {
      }

      let state: string | null = null;

      try {
        state = execSync(
          `gh issue view ${num} --repo ${agentGithub} --json state --jq '.state'`,
          { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
        ).trim().toUpperCase();
      } catch {
        try {
          state = execSync(
            `gh pr view ${num} --repo ${agentGithub} --json state --jq '.state'`,
            { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
          ).trim().toUpperCase();
        } catch {
          continue;
        }
      }

      if (!state) continue;
      checkedAny = true;

      if (state === "OPEN") {
        return false;
      }
    } catch {
      return false;
    }
  }

  return checkedAny;
}

export function isConcreteDispatch(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  if (ISSUE_REF_RE.test(message)) return true;
  return ARTIFACT_KEYWORDS.some((kw) => lower.includes(kw));
}

function filterVagueDispatches(store: StateStore, decisions: SupervisorDecision[]): SupervisorDecision[] {
  return decisions.filter((d) => {
    if (d.action !== "dispatch" && d.action !== "follow-up") return true;
    if (!d.agentName || !d.message) return true;

    const isIdle = !store.hasActiveTask(d.agentName);
    if (!isIdle) return true;

    const concrete = isConcreteDispatch(d.message);
    if (!concrete) {
      supervisorLog.warn("Dropping vague idle-agent dispatch", {
        agentName: d.agentName,
        reason: d.reason,
        message: d.message.slice(0, 120),
      });
    }
    return concrete;
  });
}

function fetchOpenIssues(config: OrchestratorConfig, store?: StateStore): string[] {
  const items: Array<{ line: string; score: number }> = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    if (!agent.github) continue;
    try {
      const raw = execSync(
        `gh issue list --repo ${agent.github} --state open --json number,title,labels,createdAt -L 10`,
        { encoding: "utf-8", timeout: 10000 },
      ).trim();
      if (!raw) continue;
      const issues = JSON.parse(raw) as Array<{ number: number; title: string; labels?: Array<{ name: string }>; createdAt?: string }>;
      for (const issue of issues) {
        const labels = (issue.labels ?? []).map((l) => l.name);
        let priorityStr = "";
        let score = 0.4;
        if (store) {
          const priority = scoreIssuePriority(
            { number: issue.number, title: issue.title, labels, createdAt: issue.createdAt, repo: agent.github },
            store,
          );
          score = priority.score;
          priorityStr = ` [priority: ${priority.score.toFixed(2)}]`;
        }
        items.push({
          line: `- ${name} (${agent.github}): #${issue.number} ${issue.title}${priorityStr}`,
          score,
        });
      }
    } catch {
    }
  }
  // Sort by priority (highest first) so supervisor sees most important issues at top
  items.sort((a, b) => b.score - a.score);
  return items.map((i) => i.line);
}

function formatTask(t: Task): string {
  const typeTag = t.task_type === "research" ? " [research]" : "";
  const verified = t.verification_status ? ` [${t.verification_status}${t.quality_score ? ` ${t.quality_score.toFixed(1)}` : ""}]` : " [unverified]";
  const result = t.result ? `\n  Result: ${t.result.slice(0, 150)}` : "";
  return `- ${t.id.slice(0, 8)} (${t.agent_name}) ${t.status}${typeTag}${verified}: ${t.title}${result}`;
}

function getAutoRerouteTarget(
  config: OrchestratorConfig,
  store: StateStore,
  task: Task,
): { agentName: string; threshold: number; consecutiveRejections: number } | null {
  if (!task.agent_name || !task.source_ref) return null;
  const threshold = config.agents[task.agent_name]?.auto_reroute_rejection_threshold ?? 0;
  if (threshold <= 0) return null;

  const consecutiveRejections = store.countConsecutiveRejectionsForSourceRef(task.source_ref, task.agent_name);
  if (consecutiveRejections < threshold) return null;

  const substitute = selectSubstituteAgent(config, store, task);
  if (!substitute) {
    verifierLog.warn("Auto-reroute threshold reached, but no substitute agent is available", {
      taskId: task.id,
      sourceRef: task.source_ref,
      agentName: task.agent_name,
      threshold,
      consecutiveRejections,
    });
    return null;
  }

  return { agentName: substitute, threshold, consecutiveRejections };
}

function selectSubstituteAgent(config: OrchestratorConfig, store: StateStore, task: Task): string | null {
  const currentName = task.agent_name;
  if (!currentName) return null;
  const currentAgent = config.agents[currentName];
  if (!currentAgent) return null;

  const candidateEntries = Object.entries(config.agents)
    .filter(([name]) => name !== currentName)
    .filter(([name]) => !store.hasActiveTask(name))
    .filter(([name]) => task.task_type === "research" || !store.isAgentAuthDegraded(name));

  const samePool = currentAgent.pool
    ? candidateEntries.filter(([, agent]) => agent.pool === currentAgent.pool)
    : [];
  if (samePool.length > 0) {
    return pickHealthiestCandidate(store, samePool.map(([name]) => name));
  }

  const currentCapabilities = new Set(currentAgent.capabilities);
  const currentTopics = new Set(currentAgent.owns_topics);
  const ranked = candidateEntries
    .map(([name, agent]) => ({
      name,
      score:
        (agent.repo && currentAgent.repo && agent.repo === currentAgent.repo ? 100 : 0) +
        (agent.github && currentAgent.github && agent.github === currentAgent.github ? 100 : 0) +
        agent.capabilities.filter((cap) => currentCapabilities.has(cap)).length * 10 +
        agent.owns_topics.filter((topic) => currentTopics.has(topic)).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) return null;
  const bestScore = ranked[0].score;
  return pickHealthiestCandidate(store, ranked.filter((candidate) => candidate.score === bestScore).map((c) => c.name));
}

function pickHealthiestCandidate(store: StateStore, agentNames: string[]): string | null {
  if (agentNames.length === 0) return null;
  if (agentNames.length === 1) return agentNames[0];

  const healthMap = new Map(
    store.getAgentHealthBatch(agentNames).map((health) => [health.agent_name, health]),
  );

  return [...agentNames].sort((a, b) => compareHealth(
    healthMap.get(a) ?? defaultHealth(a),
    healthMap.get(b) ?? defaultHealth(b),
  ))[0] ?? null;
}

function compareHealth(a: AgentHealth, b: AgentHealth): number {
  if (a.is_healthy !== b.is_healthy) return a.is_healthy ? -1 : 1;
  if (a.consecutive_failures !== b.consecutive_failures) {
    return a.consecutive_failures - b.consecutive_failures;
  }
  return (a.last_error_at ?? "").localeCompare(b.last_error_at ?? "");
}

function defaultHealth(agentName: string): AgentHealth {
  return {
    agent_name: agentName,
    consecutive_failures: 0,
    last_error_at: null,
    last_error_message: null,
    last_success_at: null,
    is_healthy: true,
    auth_status: "ok",
    auth_degraded_at: null,
  };
}

export async function detectImprovements(
  reviewerClient: ReviewerClient,
  recentTasks: Task[],
): Promise<DetectedImprovement[]> {
  return reviewerClient.analyzeImprovements(recentTasks);
}

// ── Cross-task learning: rule confidence tracking ──────────────────────────

/**
 * Parse applied rule IDs from task logs and boost their confidence
 * (called when a task passes verification).
 */
function boostAppliedRules(store: StateStore, taskId: string): void {
  const ruleIds = getAppliedRuleIds(store, taskId);
  for (const id of ruleIds) {
    store.boostRuleConfidence(id);
  }
  if (ruleIds.length > 0) {
    verifierLog.info("Boosted confidence for rules on successful task", {
      taskId,
      ruleIds,
    });
  }
}

/**
 * Parse applied rule IDs from task logs and decay their confidence
 * (called when a task fails verification).
 */
function decayAppliedRules(store: StateStore, taskId: string): void {
  const ruleIds = getAppliedRuleIds(store, taskId);
  for (const id of ruleIds) {
    store.decayRuleConfidence(id);
  }
  if (ruleIds.length > 0) {
    verifierLog.info("Decayed confidence for rules on failed task", {
      taskId,
      ruleIds,
    });
  }
}

/**
 * Extract applied rule IDs from task logs (written by dispatcher).
 */
function getAppliedRuleIds(store: StateStore, taskId: string): number[] {
  const logs = store.getLogs(taskId);
  for (const log of logs) {
    const match = log.content.match(/\[learned-rules\] Applied rule IDs: ([\d,]+)/);
    if (match) {
      return match[1].split(",").map(Number).filter((n) => !isNaN(n) && n > 0);
    }
  }
  return [];
}
