/**
 * Verifier — quality-checks completed tasks and dispatches revisions.
 *
 * LLM calls are delegated to the ReviewerClient (reviewer agent pool).
 * This module handles orchestration: state store updates, capacity guards,
 * and revision dispatch.
 */
import { ReviewerClient } from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { AgentHealth, StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";
import { notifyOperator } from "../service/notify.js";

export type { VerificationResult } from "../client/reviewer-client.js";
import type { VerificationResult } from "../client/reviewer-client.js";

/** Revision count at which Telegram escalation is triggered. */
const REVISION_ESCALATION_THRESHOLD = 3;

export class Verifier {
  private log = createLogger("verifier");
  private reviewerClient: ReviewerClient;

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
    reviewerClient?: ReviewerClient,
  ) {
    this.reviewerClient = reviewerClient ?? new ReviewerClient(config);
  }

  async verify(taskId: string): Promise<VerificationResult> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "done") {
      throw new Error(`Task ${taskId} is not done (status: ${task.status})`);
    }

    this.store.updateTask(taskId, { verification_status: "pending" });

    try {
      const result = await this.reviewerClient.verifyTask(task);

      this.log.info("Verification complete", {
        taskId, approved: result.approved, score: result.score, agent: task.agent_name,
      });

      this.store.updateTask(taskId, {
        verification_status: result.approved ? "approved" : "rejected",
        quality_score: result.score,
        verification_notes: result.notes,
      });

      return result;
    } catch (err) {
      this.log.error("Verification failed", { taskId, error: err instanceof Error ? err.message : String(err) });
      this.store.updateTask(taskId, { verification_status: null });
      throw new Error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async verifyAndRevise(taskId: string, maxRetries = 1): Promise<VerificationResult> {
    // Verification uses ReviewerClient → reviewer pool. It doesn't dispatch to
    // the agent, so there's no need to check agent capacity for the LLM call.
    const result = await this.verify(taskId);

    if (result.approved || maxRetries <= 0 || !result.revision) {
      return result;
    }

    // Re-dispatch with revision feedback
    const task = this.store.getTask(taskId)!;

    // Compute the new revision count for this source_ref
    const newRevisionCount = (task.revision_count ?? 0) + 1;

    // Update the current task's revision_count so the history is tracked
    this.store.updateTask(taskId, { revision_count: newRevisionCount });

    // Telegram escalation at threshold
    if (newRevisionCount >= REVISION_ESCALATION_THRESHOLD) {
      const sourceLabel = task.source_ref ?? task.title;
      this.log.warn("Revision loop detected — escalating to operator", {
        taskId,
        sourceRef: task.source_ref,
        revisionCount: newRevisionCount,
      });
      await notifyOperator(
        "Stuck Issue — Revision Loop",
        `Issue ${sourceLabel} has reached ${newRevisionCount} revision(s).\n` +
        `Agent: ${task.agent_name ?? "unknown"}\n` +
        `Quality score: ${task.quality_score?.toFixed(1) ?? "n/a"}\n` +
        `Task: ${task.title}\n\n` +
        `This issue may need manual intervention.`,
        "warning",
        `stuck-issue:${task.source_ref ?? taskId}`,
      );
    }

    const autoReroute = this.getAutoRerouteTarget(task);

    // Capacity guard: if the current agent is already busy, defer the revision
    // by resetting verification_status to null so the daemon re-picks the task
    // on the next cycle. Skip this guard when auto-rerouting to a substitute.
    if (!autoReroute && task.agent_name && this.store.hasActiveTask(task.agent_name)) {
      this.log.info("Revision deferred: agent busy, will retry next cycle", {
        taskId,
        agentName: task.agent_name,
      });
      this.store.updateTask(taskId, { verification_status: null });
      return result;
    }

    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(this.config, this.store);

    const rerouteHeader = autoReroute
      ? `## Auto-Reroute Context
This issue has been reassigned from ${task.agent_name} to ${autoReroute.agentName} after ${autoReroute.consecutiveRejections} consecutive verifier rejection(s) for ${task.source_ref ?? task.title}. Please take a fresh pass and avoid repeating the prior failed approach.

`
      : "";
    const revisionMessage = `${rerouteHeader}Your previous response to this task was reviewed and needs revision.\n\n## Original Task\n${task.description ?? task.title}\n\n## Reviewer Feedback\n${result.revision}\n\nPlease address the feedback and provide an improved response.`;

    try {
      const revisionResult = await dispatcher.dispatch(revisionMessage, {
        agentName: autoReroute?.agentName ?? task.agent_name ?? undefined,
        source: task.source,
        sourceRef: task.source_ref ?? undefined,
        title: `${autoReroute ? "[auto-reroute]" : "[revision]"} ${task.title}`,
        // Resume the original session so the agent remembers its first attempt
        // instead of re-reading the entire codebase from scratch.
        conversationId: autoReroute ? undefined : task.conversation_id ?? undefined,
      });

      // Propagate revision_count to the new task so the history is visible
      this.store.updateTask(revisionResult.taskId, { revision_count: newRevisionCount });

      if (autoReroute) {
        const rationale =
          `Substituted ${task.agent_name} with ${autoReroute.agentName} after ` +
          `${autoReroute.consecutiveRejections} consecutive rejected attempt(s) ` +
          `on ${task.source_ref ?? task.title} (threshold ${autoReroute.threshold}).`;
        this.store.addSupervisorDecision({
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

      // Verify the revision
      return this.verify(revisionResult.taskId);
    } catch (err) {
      if (autoReroute) {
        this.store.addSupervisorDecision({
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
      // Dispatch failed (e.g. transient connection error): reset to null so the
      // daemon retries on the next cycle rather than silently dropping the revision.
      this.log.warn("Revision dispatch failed, resetting for retry", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      this.store.updateTask(taskId, { verification_status: null });
      return result;
    }
  }

  private getAutoRerouteTarget(task: Task): { agentName: string; threshold: number; consecutiveRejections: number } | null {
    if (!task.agent_name || !task.source_ref) return null;
    const threshold = this.config.agents[task.agent_name]?.auto_reroute_rejection_threshold ?? 0;
    if (threshold <= 0) return null;

    const consecutiveRejections = this.store.countConsecutiveRejectionsForSourceRef(task.source_ref, task.agent_name);
    if (consecutiveRejections < threshold) return null;

    const substitute = this.selectSubstituteAgent(task);
    if (!substitute) {
      this.log.warn("Auto-reroute threshold reached, but no substitute agent is available", {
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

  private selectSubstituteAgent(task: Task): string | null {
    const currentName = task.agent_name;
    if (!currentName) return null;
    const currentAgent = this.config.agents[currentName];
    if (!currentAgent) return null;

    const candidateEntries = Object.entries(this.config.agents)
      .filter(([name]) => name !== currentName)
      .filter(([name]) => !this.store.hasActiveTask(name))
      .filter(([name]) => task.task_type === "research" || !this.store.isAgentAuthDegraded(name));

    const samePool = currentAgent.pool
      ? candidateEntries.filter(([, agent]) => agent.pool === currentAgent.pool)
      : [];
    if (samePool.length > 0) {
      return this.pickHealthiestCandidate(samePool.map(([name]) => name));
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
    return this.pickHealthiestCandidate(ranked.filter((candidate) => candidate.score === bestScore).map((c) => c.name));
  }

  private pickHealthiestCandidate(agentNames: string[]): string | null {
    if (agentNames.length === 0) return null;
    if (agentNames.length === 1) return agentNames[0];

    const healthMap = new Map(
      this.store.getAgentHealthBatch(agentNames).map((health) => [health.agent_name, health]),
    );

    return [...agentNames].sort((a, b) => this.compareHealth(
      healthMap.get(a) ?? this.defaultHealth(a),
      healthMap.get(b) ?? this.defaultHealth(b),
    ))[0] ?? null;
  }

  private compareHealth(a: AgentHealth, b: AgentHealth): number {
    if (a.is_healthy !== b.is_healthy) return a.is_healthy ? -1 : 1;
    if (a.consecutive_failures !== b.consecutive_failures) {
      return a.consecutive_failures - b.consecutive_failures;
    }
    return (a.last_error_at ?? "").localeCompare(b.last_error_at ?? "");
  }

  private defaultHealth(agentName: string): AgentHealth {
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
}
