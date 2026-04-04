import { createLLMClient } from "../client/llm-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore, Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

export interface VerificationResult {
  approved: boolean;
  score: number;
  notes: string;
  revision?: string;
}

const SYSTEM_PROMPT = `You are a quality reviewer for an AI agent orchestrator. Given a task description and the agent's response, assess the quality of the work.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of quality, completeness, correctness",
  "revision": "If not approved, specific guidance for improvement (omit if approved)"
}

Scoring guide:
- 0.9-1.0: Excellent — thorough, correct, well-structured
- 0.7-0.89: Good — meets requirements with minor gaps
- 0.5-0.69: Acceptable — partially addresses the task
- Below 0.5: Needs revision — incomplete or incorrect`;

const RESEARCH_SYSTEM_PROMPT = `You are a quality reviewer for research and feasibility analysis produced by an AI agent. Given a research question and the agent's analysis, assess the quality of the research.

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "approved": true/false,
  "score": 0.0-1.0,
  "notes": "Brief assessment of research quality",
  "revision": "If not approved, specific guidance for improvement (omit if approved)"
}

Evaluate research quality on:
- **Thoroughness**: Did the agent investigate the question fully, or leave obvious gaps?
- **Evidence**: Are claims backed by concrete examples, code references, or data?
- **Alternatives**: Were multiple approaches considered and compared?
- **Honesty**: Does the analysis acknowledge uncertainty, risks, and limitations?
- **Structure**: Is the response well-organized and easy to act on?
- **Actionability**: Could a decision-maker use this analysis to make an informed choice?

Scoring guide:
- 0.9-1.0: Excellent — comprehensive analysis with evidence, alternatives, and clear recommendation
- 0.7-0.89: Good — solid analysis with minor gaps in coverage or evidence
- 0.5-0.69: Acceptable — addresses the question but lacks depth or alternatives
- Below 0.5: Needs revision — superficial, missing key considerations, or not actionable`;

export class Verifier {
  private log = createLogger("verifier");

  constructor(
    private config: OrchestratorConfig,
    private store: StateStore,
  ) {}

  async verify(taskId: string): Promise<VerificationResult> {
    const task = this.store.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.status !== "done") {
      throw new Error(`Task ${taskId} is not done (status: ${task.status})`);
    }

    this.store.updateTask(taskId, { verification_status: "pending" });

    const client = createLLMClient(this.config
    );

    const isResearch = task.task_type === "research";
    const prompt = isResearch
      ? `## Research Question\n${task.description ?? task.title}\n\n## Agent Analysis (${task.agent_name})\n${task.result ?? "(no result)"}`
      : `## Task\n${task.description ?? task.title}\n\n## Agent Response (${task.agent_name})\n${task.result ?? "(no result)"}`;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: isResearch ? RESEARCH_SYSTEM_PROMPT : SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      const result = this.parseResponse(text);

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
    // Check agent capacity BEFORE verifying — if the agent is already busy with active work,
    // skip verification entirely and leave verification_status = NULL so the daemon retries
    // next cycle. This prevents tasks from getting permanently stuck in "rejected" when the
    // agent is busy at the moment of the capacity check.
    const taskForCapacityCheck = this.store.getTask(taskId);
    if (taskForCapacityCheck?.agent_name && this.store.hasActiveTask(taskForCapacityCheck.agent_name)) {
      this.log.info("Deferring verification: agent busy, will retry next cycle", {
        taskId,
        agentName: taskForCapacityCheck.agent_name,
      });
      // Return a synthetic "deferred" result — caller treats it as not approved but won't
      // permanently mark the task rejected (verification_status stays NULL).
      return { approved: false, score: 0, notes: "Deferred: agent busy" };
    }

    const result = await this.verify(taskId);

    if (result.approved || maxRetries <= 0 || !result.revision) {
      return result;
    }

    // Re-dispatch with revision feedback
    const task = this.store.getTask(taskId)!;

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
      });

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

  private parseResponse(text: string): VerificationResult {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      return {
        approved: Boolean(parsed.approved),
        score: Math.min(Math.max(Number(parsed.score) || 0, 0), 1),
        notes: String(parsed.notes ?? ""),
        revision: parsed.revision ? String(parsed.revision) : undefined,
      };
    } catch {
      return { approved: false, score: 0, notes: "Failed to parse verification response" };
    }
  }
}
