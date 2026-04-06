/**
 * Verifier — quality-checks completed tasks and dispatches revisions.
 *
 * LLM calls are delegated to the ReviewerClient (reviewer agent pool).
 * This module handles orchestration: state store updates, capacity guards,
 * and revision dispatch.
 */
import { ReviewerClient } from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
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

    // Capacity guard: if the agent is already busy, defer the revision by resetting
    // verification_status to null so the daemon re-picks the task on the next cycle.
    if (task.agent_name && this.store.hasActiveTask(task.agent_name)) {
      this.log.info("Revision deferred: agent busy, will retry next cycle", {
        taskId,
        agentName: task.agent_name,
      });
      this.store.updateTask(taskId, { verification_status: null });
      return result;
    }

    const { Dispatcher } = await import("./dispatcher.js");
    const dispatcher = new Dispatcher(this.config, this.store);

    const revisionMessage = `Your previous response to this task was reviewed and needs revision.\n\n## Original Task\n${task.description ?? task.title}\n\n## Reviewer Feedback\n${result.revision}\n\nPlease address the feedback and provide an improved response.`;

    try {
      const revisionResult = await dispatcher.dispatch(revisionMessage, {
        agentName: task.agent_name ?? undefined,
        source: task.source,
        sourceRef: task.source_ref ?? undefined,
        title: `[revision] ${task.title}`,
        // Resume the original session so the agent remembers its first attempt
        // instead of re-reading the entire codebase from scratch.
        conversationId: task.conversation_id ?? undefined,
      });

      // Propagate revision_count to the new task so the history is visible
      this.store.updateTask(revisionResult.taskId, { revision_count: newRevisionCount });

      // Verify the revision
      return this.verify(revisionResult.taskId);
    } catch (err) {
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
}
